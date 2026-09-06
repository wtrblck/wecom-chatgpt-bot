import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import readline from 'node:readline';
import Database from 'better-sqlite3';
import pino from 'pino';
import { chromium } from 'playwright';
import { ChatGPTBrowser } from '../chatgpt/browser.js';
import { loadConfig } from '../config/config.js';
import { loadWechatConversations } from '../config/wechat-conversations.js';
import { readDesktopSettings, saveDesktopSettings, type DesktopSettings } from '../config/desktop-settings.js';
import { WeChatBridgeClient } from '../wechat/bridge-client.js';
import { acquireProcessLock } from '../utils/process-lock.js';
import { openDatabase } from '../db/sqlite.js';
import { Repository } from '../conversation/repository.js';

const execute = promisify(execFile);
const detail = (error: unknown) => error instanceof Error ? error.message : String(error);
type Activity = { time: string; level: string; message: string };
export type Check = { name: string; status: 'ok' | 'warning' | 'error'; detail: string };

export class DesktopService {
  private child: ChildProcess | null = null;
  private loginBrowser: ChatGPTBrowser | null = null;
  private releaseLogin: (() => void) | null = null;
  private phase = 'stopped';
  private browserState = 'CLOSED';
  private account = 'unknown';
  private queue = 0;
  private startedAt: number | null = null;
  private checks: Check[] = [];
  private checkedAt: string | null = null;
  private activities: Activity[] = [];
  private logger: pino.Logger;
  private busy = false;
  private statusAt = 0;
  private nextControlRequest = 0;
  private lastError: string | null = null;
  constructor(readonly root: string) {
    fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
    this.logger = pino({ level: 'info' }, pino.destination({ dest: path.join(root, 'logs', 'desktop.log'), sync: true }));
    this.add('info', '桌面工作台已就绪');
  }
  private add(level: string, message: string) {
    this.activities.push({ time: new Date().toISOString(), level, message: message.slice(0, 1200) });
    if (this.activities.length > 200) this.activities.shift();
  }
  settings(): DesktopSettings {
    return readDesktopSettings(this.root) ?? {
      systemPrompt: '', replyPrefix: '', replySuffix: '', requirePrefix: process.env.WECHAT_REQUIRE_PREFIX !== 'false', prefix: process.env.WECHAT_PREFIX || '/gpt',
      prefixAliases: [...new Set([...(process.env.WECHAT_PREFIX_ALIASES || '').split(',').map(a => a.trim()).filter(Boolean), '@ChatBOT', '@chatbot'])],
      pollIntervalMs: Number(process.env.WECHAT_POLL_INTERVAL_MS || 1000), sendIntervalMs: Number(process.env.WECHAT_SEND_INTERVAL_MS || 300),
      sendAction: (process.env.WECHAT_SEND_ACTION || 'enter') as DesktopSettings['sendAction'],
      conversations: loadWechatConversations(path.resolve(this.root, process.env.WECHAT_CONVERSATIONS_FILE || 'config/wechat-conversations.json'))
        ?? (process.env.WECHAT_DB_CONVERSATIONS || '').split(',').filter(Boolean).map(name => ({ name, type: 'group', enabled: true })),
    };
  }
  private databasePath() { return path.resolve(this.root, process.env.DATABASE_PATH || 'data/bot.sqlite'); }
  private externalPid(): number | null {
    try {
      const pid = Number(fs.readFileSync(`${this.databasePath()}.lock`, 'utf8'));
      if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid || pid === this.child?.pid) return null;
      process.kill(pid, 0); return pid;
    } catch { return null; }
  }
  private statistics() {
    const empty = { completed: 0, pending: 0, attention: 0, outbox: [] as unknown[], error: null as string | null };
    if (!fs.existsSync(this.databasePath())) return empty;
    let db: Database.Database | undefined;
    try {
      db = new Database(this.databasePath(), { readonly: true, fileMustExist: true, timeout: 500 });
      const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
      const row = db.prepare("SELECT count(*) AS n FROM tasks WHERE status='completed' AND finished_at >= ?").get(midnight.getTime()) as { n: number };
      const pending = db.prepare("SELECT count(*) AS n FROM tasks WHERE status IN ('queued','running')").get() as { n: number };
      const attention = db.prepare("SELECT count(*) AS n FROM wechat_outbox WHERE status IN ('failed','uncertain','sending')").get() as { n: number };
      const outbox = db.prepare("SELECT delivery_key, part, user_id, status, error, updated_at FROM wechat_outbox WHERE status IN ('failed','uncertain','sending') ORDER BY updated_at DESC LIMIT 50").all();
      return { completed: row.n, pending: pending.n, attention: attention.n, outbox, error: null };
    } catch (error) { return { ...empty, error: detail(error) }; }
    finally { db?.close(); }
  }
  async state() {
    if (this.child?.connected) this.child.send({ type: 'desktop-status' }, () => {});
    if (this.loginBrowser && !this.busy) {
      this.account = await this.loginBrowser.accountStatus();
      this.browserState = this.loginBrowser.state;
    }
    return {
      phase: this.phase, browser: this.browserState, account: this.child && Date.now() - this.statusAt > 10000 ? 'unknown' : this.account,
      queue: this.queue, startedAt: this.startedAt, externalPid: this.externalPid(), lastError: this.lastError,
      checks: this.checks, checkedAt: this.checkedAt, activities: this.activities, stats: this.statistics(),
      settings: this.settings(), root: this.root, busy: this.busy,
    };
  }
  async action(method: string, value?: unknown): Promise<unknown> {
    if (method === 'state') return this.state();
    if (this.busy) throw new Error('上一项操作仍在进行，请稍候');
    this.busy = true;
    try {
      switch (method) {
        case 'save': {
          if (this.child || this.loginBrowser || this.externalPid()) throw new Error('请先停止机器人并关闭登录窗口，再保存设置');
          const settings = saveDesktopSettings(this.root, value);
          this.add('info', '设置已保存，下次启动生效'); return settings;
        }
        case 'diagnose': return await this.diagnose();
        case 'newConversation': return await this.newConversation(value);
        case 'login': return await this.login();
        case 'closeLogin': await this.closeLogin(); return true;
        case 'start': return await this.start();
        case 'stop': await this.stop(); return true;
        case 'close': await this.stop(); await this.closeLogin(); return true;
        case 'export': {
          const file = path.join(this.root, 'logs', `diagnostics-${Date.now()}.json`);
          // A shareable report omits account/profile data, chat names, IDs, prompts and log contents.
          fs.writeFileSync(file, JSON.stringify({ version: '1.1.0', at: new Date().toISOString(), node: process.versions.node,
            phase: this.phase, browser: this.browserState, account: this.account,
            checks: this.checks.filter(c => c.name !== 'configuration'), checkedAt: this.checkedAt }, null, 2));
          this.add('info', '诊断报告已保存到 logs 文件夹'); return file;
        }
        default: throw new Error('不支持的桌面操作');
      }
    } catch (error) { this.lastError = detail(error); this.add('error', this.lastError); throw error; }
    finally { this.busy = false; }
  }
  private async newConversation(value: unknown) {
    const request = value as { index?: number; name?: string } | null;
    const chat = Number.isInteger(request?.index) ? this.settings().conversations[request!.index!] : undefined;
    if (!chat || chat.name !== request?.name) throw new Error('请重新选择已保存的监听会话');
    const child = this.child;
    if (child) {
      if (this.phase !== 'running' || !child.connected) throw new Error('请等待机器人启动完成或安全停止后再新建对话');
      const requestId = ++this.nextControlRequest;
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); child.removeListener('message', onMessage); child.removeListener('exit', onExit); };
        const onMessage = (message: any) => {
          if (message?.type !== 'desktop-new-conversation-result' || message.requestId !== requestId) return;
          cleanup(); if (message.ok) resolve(); else reject(new Error(message.error || '新建对话失败'));
        };
        const onExit = () => { cleanup(); reject(new Error('机器人已退出，请重试新建对话')); };
        const timer = setTimeout(() => { cleanup(); reject(new Error('新建对话请求超时，请确认运行状态后重试')); }, 10000);
        child.on('message', onMessage); child.once('exit', onExit);
        child.send({ type: 'desktop-new-conversation', requestId, index: request!.index, name: chat.name }, error => {
          if (error) { cleanup(); reject(error); }
        });
      });
    } else {
      if (this.externalPid()) throw new Error('命令行机器人正在运行，请先停止后再新建对话');
      await this.closeLogin();
      if (fs.existsSync(this.databasePath())) {
        const release = acquireProcessLock(this.databasePath());
        let db: Database.Database | undefined;
        try {
          db = openDatabase(this.databasePath());
          const repository = new Repository(db);
          const userId = repository.resolveWechatUserId(chat.name, chat.id);
          if (userId) {
            if (repository.hasUnfinishedTask(`wechat:${userId}`)) throw new Error('此会话还有未完成的问题，请处理后再新建对话');
            repository.clearConversation(`wechat:${userId}`);
          }
        } finally { db?.close(); release(); }
      }
    }
    this.add('info', '已切换到新 GPT 对话；下一条问题将先初始化回复风格');
    return { reset: true };
  }

  private async diagnose() {
    const checks: Check[] = [];
    const push = (name: string, ok: boolean, text: string) => checks.push({ name, status: ok ? 'ok' : 'error', detail: text });
    try { loadConfig(this.root); push('configuration', true, '监听对象和运行配置有效'); }
    catch (error) { push('configuration', false, detail(error)); }
    push('chromium', fs.existsSync(chromium.executablePath()), fs.existsSync(chromium.executablePath()) ? 'Chromium 已安装；登录状态单独检测' : '缺少浏览器，请重新解压完整程序包');
    try {
      const python = path.resolve(this.root, process.env.WECHAT_DB_PYTHON_PATH || '.venv-wechatdb/Scripts/python.exe');
      await execute(python, ['-c', 'import sqlite3, ctypes, cryptography, zstandard; from cryptography.hazmat.primitives.ciphers import Cipher; print("ready")'], { cwd: this.root, windowsHide: true, timeout: 15000 });
      push('reader', true, '数据库读取依赖齐全；启动后验证实际连接');
    } catch { push('reader', false, 'Python 读取依赖不可用，请重新解压完整程序包或运行项目 setup'); }
    const bridge = new WeChatBridgeClient(this.root, process.env.WECHAT_BRIDGE_PATH, this.logger);
    try {
      await bridge.start();
      const health = await bridge.health();
      push('wechat', health.loggedIn && !health.windowMinimized, !health.processRunning ? '未打开微信客户端' : !health.loggedIn ? '请在微信客户端完成登录' : health.windowMinimized ? '微信已登录，请还原主窗口' : '检测到已登录的微信主窗口');
      if (health.loggedIn && !health.windowMinimized) {
        const inspection = await bridge.inspect() as { accessibleElementCount?: number; sendCapabilities?: { readableComposer?: boolean; invokableSendButton?: boolean; composer?: { enabled?: boolean } } };
        const caps = inspection.sendCapabilities;
        const compatible = caps?.readableComposer === true && caps.composer?.enabled === true && (this.settings().sendAction !== 'invoke' || caps.invokableSendButton === true);
        checks.push({ name: 'controls', status: compatible ? 'ok' : 'warning', detail: compatible
          ? `当前聊天输入控件可读且可用（${inspection.accessibleElementCount ?? 0} 个可访问元素）；发送时再次核验目标`
          : '尚未验证兼容：请打开一个聊天窗口后重新检测；若仍无控件，请参阅兼容性说明' });
      } else checks.push({ name: 'controls', status: 'warning', detail: '需登录微信并打开聊天窗口后检测' });
    } catch (error) { push('wechat', false, detail(error)); checks.push({ name: 'controls', status: 'warning', detail: '桥接不可用，无法确认控件兼容性' }); }
    finally { await bridge.stop().catch(() => undefined); }
    this.checks = checks; this.checkedAt = new Date().toISOString();
    this.add(checks.every(c => c.status === 'ok') ? 'info' : 'warning', '环境检测完成，请查看各项状态');
    return checks;
  }
  private async login() {
    if (this.externalPid()) throw new Error('命令行机器人正在使用登录资料，请先通过 npm run stop 停止');
    if (this.child?.connected) { this.child.send({ type: 'desktop-show-browser' }); return true; }
    if (!this.loginBrowser) {
      this.releaseLogin = acquireProcessLock(this.databasePath());
      this.loginBrowser = new ChatGPTBrowser({ profilePath: path.resolve(this.root, process.env.BROWSER_PROFILE || 'data/browser-profile'),
        chatgptUrl: process.env.CHATGPT_URL || 'https://chatgpt.com/', headless: false, timeoutMs: 180000,
        debugDirectory: path.join(this.root, 'logs', 'debug') }, this.logger);
    }
    try { await this.loginBrowser.showWindow(); }
    catch (error) { await this.closeLogin(); throw error; }
    this.browserState = this.loginBrowser.state;
    this.account = await this.loginBrowser.accountStatus();
    this.add('info', '已打开专用 GPT 浏览器，请在浏览器中完成登录');
    return true;
  }
  private async closeLogin() {
    try { await this.loginBrowser?.close(); } finally {
      this.loginBrowser = null; this.releaseLogin?.(); this.releaseLogin = null;
      if (!this.child) { this.browserState = 'CLOSED'; this.account = 'unknown'; }
    }
  }
  private async start() {
    if (this.child) throw new Error('机器人已启动');
    if (this.externalPid()) throw new Error('发现命令行机器人，请先使用 npm run stop 停止');
    const config = loadConfig(this.root);
    await this.closeLogin();
    this.phase = 'starting'; this.lastError = null; this.browserState = 'STARTING';
    const child = spawn(process.execPath, [path.join(this.root, 'dist', 'src', 'index.js')], {
      cwd: this.root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, WECHAT_SEND_ACTION: config.wechatSendAction, BROWSER_HEADLESS: 'false' },
    });
    this.child = child; this.startedAt = Date.now();
    for (const stream of [child.stdout, child.stderr]) if (stream) {
      const lines = readline.createInterface({ input: stream });
      lines.on('line', line => {
        try { const log = JSON.parse(line) as { level?: number; msg?: string }; if (log.msg) this.add((log.level ?? 30) >= 50 ? 'error' : (log.level ?? 30) >= 40 ? 'warning' : 'info', log.msg); }
        catch { if (line.trim()) this.add('error', line); }
      });
    }
    child.on('message', (message: any) => {
      if (this.child !== child) return;
      if (message.type === 'desktop-ready' && this.phase === 'starting') { this.phase = 'running'; this.add('info', '机器人已启动，开始监听配置的会话'); }
      if (message.type === 'desktop-status') {
        this.browserState = message.browser; this.account = message.account; this.queue = message.queue; this.statusAt = Date.now();
        if (message.shuttingDown) this.phase = 'stopping';
      }
    });
    child.on('error', error => { this.lastError = detail(error); this.add('error', this.lastError); });
    child.once('exit', code => {
      if (this.child !== child) return;
      this.child = null; this.phase = code === 0 ? 'stopped' : 'error'; this.browserState = 'CLOSED'; this.account = 'unknown'; this.queue = 0; this.startedAt = null;
      if (code !== 0) this.lastError = `机器人异常退出（${code ?? '未知'}），请查看运行日志`;
      this.add(code === 0 ? 'info' : 'error', code === 0 ? '机器人已安全停止' : this.lastError!);
    });
    this.add('info', '正在启动机器人、GPT 浏览器和微信读取器');
    return true;
  }
  private async stop() {
    const child = this.child;
    if (!child) { await this.closeLogin(); return; }
    this.phase = 'stopping';
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { child.removeListener('exit', done); reject(new Error('机器人仍在安全清理，请稍后再次停止；没有强制终止')); }, 180000);
      const done = () => { clearTimeout(timer); resolve(); };
      child.once('exit', done);
      if (child.connected) child.send({ type: 'shutdown' }, error => { if (error) { clearTimeout(timer); child.removeListener('exit', done); reject(error); } });
      else { clearTimeout(timer); child.removeListener('exit', done); reject(new Error('控制通道断开，请使用 npm run stop')); }
    });
  }
}
