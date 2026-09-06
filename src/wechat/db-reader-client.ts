import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import type { Logger } from 'pino';
import type { WeChatConversationConfig } from '../config/wechat-conversations.js';
import type { BridgeIncomingMessage } from './bridge-client.js';

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: unknown) => void;
  timer: NodeJS.Timeout;
}

export interface WeChatDbHealth {
  ready: boolean;
  conversationCount: number;
}

export class WeChatDbReaderClient {
  private process: ChildProcessWithoutNullStreams | null = null;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;

  constructor(
    private readonly projectRoot: string,
    private readonly pythonPath: string,
    private readonly conversations: readonly WeChatConversationConfig[],
    private readonly logger: Logger,
  ) {}

  async start(): Promise<void> {
    if (this.process) return;
    const script = path.join(this.projectRoot, 'scripts', 'wechat-db-reader.py');
    this.process = spawn(this.pythonPath, [script], {
      cwd: this.projectRoot,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    });
    readline.createInterface({ input: this.process.stdout }).on('line', (line) => this.handleLine(line));
    this.process.stderr.on('data', (data) => {
      this.logger.debug({
        component: 'wechat_db', event: 'stderr', detail: String(data).trim().slice(0, 500),
      }, '微信数据库读取器输出');
    });
    this.process.once('exit', (code) => {
      const error = new Error(`微信数据库读取器已退出，code=${code ?? 'unknown'}`);
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(error);
      }
      this.pending.clear();
      this.process = null;
    });
    await this.request('start', { conversations: this.conversations }, 120_000);
  }

  async stop(): Promise<void> {
    if (!this.process) return;
    await this.request('stop', {}).catch(() => undefined);
    this.process.kill();
    this.process = null;
  }

  health(): Promise<WeChatDbHealth> {
    return this.request('health', {});
  }

  poll(): Promise<BridgeIncomingMessage[]> {
    return this.request('poll', {}, 60_000);
  }

  private request<T>(operation: string, payload: Record<string, unknown>, timeoutMs = 15_000): Promise<T> {
    if (!this.process) return Promise.reject(new Error('微信数据库读取器未启动'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`微信数据库读取操作超时: ${operation}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.process?.stdin.write(`${JSON.stringify({ id, operation, ...payload })}\n`);
    });
  }

  private handleLine(line: string): void {
    let response: { id?: number; ok?: boolean; result?: unknown; error?: string };
    try {
      response = JSON.parse(line) as typeof response;
    } catch {
      this.logger.debug({ component: 'wechat_db', event: 'non_json_output' }, '忽略数据库读取器非协议输出');
      return;
    }
    if (typeof response.id !== 'number') return;
    const request = this.pending.get(response.id);
    if (!request) return;
    clearTimeout(request.timer);
    this.pending.delete(response.id);
    if (response.ok) request.resolve(response.result);
    else request.reject(new Error(response.error || '微信数据库读取失败'));
  }
}
