import { loadConfig } from './config/config.js';
import { resolveWechatSystemPrompt } from './config/wechat-conversations.js';
import { openDatabase } from './db/sqlite.js';
import { createLogger } from './utils/logger.js';
import { Repository } from './conversation/repository.js';
import { ConversationManager } from './conversation/manager.js';
import { GlobalTaskQueue } from './conversation/queue.js';
import { ChatGPTBrowser } from './chatgpt/browser.js';
import { WeComClient } from './wecom/client.js';
import { MessageHandlers } from './wecom/handlers.js';
import { BrowserState } from './types/index.js';
import { MessageRouter } from './core/message-router.js';
import { WindowsPersonalWeChatAdapter } from './wechat/personal-wechat-adapter.js';
import { WeChatReplySession } from './wechat/reply-session.js';
import { acquireProcessLock } from './utils/process-lock.js';
import { startStopControl } from './utils/stop-control.js';

async function main(): Promise<void> {
  const config = loadConfig();
  process.env.WECHAT_SEND_ACTION = config.wechatSendAction;
  const releaseLock = acquireProcessLock(config.databasePath);
  process.once('exit', releaseLock);
  const logger = createLogger(config.logLevel, { logFile: config.logFile });
  logger.debug({
    component: 'app', event: 'config_loaded',
    log_level: config.logLevel, log_file: config.logFile,
    chatgpt_url: config.chatgptUrl, browser_headless: config.browserHeadless,
    wechat_enabled: config.wechatEnabled, log_message_content: config.logMessageContent,
  }, '配置加载完成');
  const db = openDatabase(config.databasePath);
  const repository = new Repository(db);
  const aborted = repository.abortInterruptedTasks();
  if (aborted > 0) logger.warn({ component: 'tasks', event: 'startup_abort', count: aborted }, '已标记重启前中断的任务');
  const uncertain = repository.recoverDeliveries();
  if (uncertain > 0) logger.warn({ component: 'wechat', event: 'delivery_uncertain', count: uncertain }, '上次发送中断，需人工核对 outbox');

  const browser = new ChatGPTBrowser({
    profilePath: config.browserProfile,
    chatgptUrl: config.chatgptUrl,
    headless: config.browserHeadless,
    timeoutMs: config.chatgptTimeoutMs,
    debugDirectory: config.debugDirectory,
  }, logger);
  const wecom = config.wecomEnabled ? new WeComClient(config.wecomBotId, config.wecomBotSecret, logger) : undefined;
  const queue = new GlobalTaskQueue();
  const conversations = new ConversationManager(repository);
  const fallbackWechatPrefixes = [config.wechatPrefix, ...config.wechatPrefixAliases];
  const acceptedWechatPrefixes = [...new Set([
    ...fallbackWechatPrefixes,
    ...config.wechatConversations.flatMap((item) => item.prefixes ?? []),
  ])];
  const wechat = config.wechatEnabled
    ? new WindowsPersonalWeChatAdapter({
        projectRoot: process.cwd(),
        bridgePath: config.wechatBridgePath,
        pollIntervalMs: config.wechatPollIntervalMs,
        sendIntervalMs: config.wechatSendIntervalMs,
        logDirectory: config.wechatLogDirectory,
        requirePrefix: config.wechatRequirePrefix,
        prefixes: acceptedWechatPrefixes,
        fallbackPrefixes: fallbackWechatPrefixes,
        canonicalNames: config.wechatCanonicalNames,
        readMode: config.wechatReadMode,
        dbPythonPath: config.wechatDbPythonPath,
        dbConversations: config.wechatConversations.filter((item) => item.enabled),
        mediaEnabled: config.wechatMediaEnabled,
      }, repository, logger)
    : undefined;
  const router = new MessageRouter(browser, conversations, repository, queue, logger, {
    logMessageContent: config.logMessageContent,
    accepts: (message) => message.platform !== 'wechat' || config.wechatConversations.some((chat) => chat.enabled &&
      (chat.id ? chat.id === message.userId : chat.name === message.displayName)),
    policies: {
      wechat: {
        allowlist: new Set(config.wechatAllowlist),
        requirePrefix: config.wechatRequirePrefix,
        prefix: config.wechatPrefix,
        prefixes: fallbackWechatPrefixes,
      },
    },
    health: {
      wecom: async () => wecom?.connected ?? false,
      wechat: async () => wechat?.healthCheck() ?? false,
    },
    systemPrompt: (message) => message.platform === 'wechat'
      ? resolveWechatSystemPrompt(config.wechatConversations, message.userId, message.displayName,
        config.initialInstruction ? undefined : config.systemPrompt)
      : config.initialInstruction ? undefined : config.systemPrompt,
    initialInstruction: () => config.initialInstruction,
    replyFormat: () => ({ prefix: config.replyPrefix, suffix: config.replySuffix }),
    conversationStyle: () => ({ enabled: config.styleEnabled, persona: config.persona, languageStyle: config.languageStyle }),
    mediaEnabled: config.wechatMediaEnabled,
  });
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | undefined;
  let startup: Promise<void> | undefined;
  let stopControl: Awaited<ReturnType<typeof startStopControl>> | undefined;
  const shutdown = (signal: string, exitCode = 0): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true;
    shutdownPromise = (async () => {
      logger.info({ component: 'app', event: 'shutdown', signal }, '正在安全退出');
      // Startup observes shuttingDown after every phase. Wait before disposing
      // resources, so late-started readers cannot survive a shutdown request.
      await startup?.catch(() => undefined);
      const clean = async (name: string, action: () => unknown) => {
        try { await action(); } catch (error) {
          exitCode = 1;
          logger.error({ component: 'app', event: 'cleanup_failed', resource: name, error }, '退出清理失败');
        }
      };
      await clean('wecom', () => wecom?.disconnect());
      await clean('receiving', () => wechat?.stopReceiving());
      await clean('queue', () => queue.close());
      await clean('deliveries', () => router.waitForDeliveries());
      await clean('wechat', () => wechat?.stop());
      await clean('browser', () => browser.close());
      await clean('database', () => db.close());
      await clean('control', () => stopControl?.close());
      releaseLock();
      logger.info({ component: 'app', event: 'shutdown_complete', exit_code: exitCode }, '已完成退出清理');
      await new Promise<void>((resolve) => logger.flush(() => resolve()));
      process.exit(exitCode);
    })();
    return shutdownPromise;
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('disconnect', () => void shutdown('IPC-disconnected'));
  process.on('message', (message: unknown) => {
    if (message && typeof message === 'object' && (message as { type?: string }).type === 'desktop-new-conversation') {
      const request = message as { requestId?: number; index?: number; name?: string };
      try {
        if (shuttingDown) throw new Error('机器人正在停止，请稍后重试');
        const chat = Number.isInteger(request.index) ? config.wechatConversations[request.index!] : undefined;
        if (!chat || chat.name !== request.name) throw new Error('监听设置已变化，请重新选择会话');
        const userId = repository.resolveWechatUserId(chat.name, chat.id);
        if (userId) router.newConversation('wechat', userId);
        if (process.connected) process.send?.({ type: 'desktop-new-conversation-result', requestId: request.requestId, ok: true });
      } catch (error) {
        if (process.connected) process.send?.({ type: 'desktop-new-conversation-result', requestId: request.requestId,
          ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (message && typeof message === 'object' && (message as { type?: string }).type === 'shutdown') void shutdown('IPC');
    if (message && typeof message === 'object' && (message as { type?: string }).type === 'desktop-status') {
      void browser.accountStatus().then(account => {
        if (process.connected) process.send?.({ type: 'desktop-status', browser: browser.state, account, queue: queue.size, shuttingDown });
      }).catch(() => undefined);
    }
    if (!shuttingDown && message && typeof message === 'object' && (message as { type?: string }).type === 'desktop-show-browser') {
      void browser.showWindow().catch(error => logger.error({ error }, '打开 GPT 窗口失败'));
    }
  });

  startup = (async () => {
    stopControl = await startStopControl(config.databasePath, () => { void shutdown('local-control'); });
    if (shuttingDown) return;
    logger.info({ component: 'browser', event: 'launching' }, '正在启动 Chromium');
    await browser.start().catch((error) => {
      logger.error({ component: 'browser', event: 'initial_launch_failed', error }, 'Chromium 首次启动失败，收到任务时重试');
    });
    if (shuttingDown) return;
    if (browser.state === BrowserState.LOGIN_REQUIRED) {
      logger.warn({ component: 'chatgpt', event: 'login_required' }, 'ChatGPT 未登录，请在打开的浏览器中人工登录');
      void browser.waitForLogin().then(() => {
        if (!shuttingDown && browser.state === BrowserState.READY) {
          logger.info({ component: 'chatgpt', event: 'login_detected' }, '检测到 ChatGPT 登录');
        }
      }).catch((error) => logger.error({ component: 'chatgpt', event: 'login_wait_failed', error }, '登录检查失败'));
    }
    if (wecom) {
      const handlers = new MessageHandlers(wecom, router, logger, { streamIntervalMs: config.streamUpdateIntervalMs });
      wecom.onText((frame) => handlers.onText(frame));
      wecom.onEnterChat((frame) => handlers.onEnterChat(frame));
      logger.info({ component: 'wecom', event: 'connecting' }, '正在连接企业微信');
      wecom.connect();
    }
    if (wechat) {
      const replyFor = (message: import('./types/index.js').IncomingMessage) => {
        const mentionName = message.userId.endsWith('@chatroom')
          ? message.senderDisplayName ?? message.senderId
          : undefined;
        return new WeChatReplySession(wechat, message.userId, mentionName);
      };
      wechat.onMessage(async (message) => { await router.handle({ message, reply: replyFor(message) }); });
      try {
        await wechat.start();
        if (shuttingDown) return;
        await router.restoreQueued(replyFor);
      } catch (error) {
        logger.error({ component: 'wechat', event: 'startup_failed', error }, '普通微信渠道启动失败');
        throw error;
      }
    }

  })();
  try { await startup; if (!shuttingDown && process.connected) process.send?.({ type: 'desktop-ready' }); } catch (error) {
    logger.error({ component: 'app', event: 'startup_failed', error }, 'Bot 启动失败');
    await shutdown('startup-failed', 1);
  }
}

main().catch((error) => {
  console.error('Bot 启动失败：', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
