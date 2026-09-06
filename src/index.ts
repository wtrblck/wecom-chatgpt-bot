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

async function main(): Promise<void> {
  const config = loadConfig();
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

  const browser = new ChatGPTBrowser({
    profilePath: config.browserProfile,
    chatgptUrl: config.chatgptUrl,
    headless: config.browserHeadless,
    timeoutMs: config.chatgptTimeoutMs,
    debugDirectory: config.debugDirectory,
  }, logger);
  logger.info({ component: 'browser', event: 'launching' }, '正在启动 Chromium');
  await browser.start().catch((error) => {
    logger.error({ component: 'browser', event: 'initial_launch_failed', error }, 'Chromium 首次启动失败，企业微信仍会保持在线并在收到任务时重试');
  });
  if (browser.state === BrowserState.LOGIN_REQUIRED) {
    logger.warn({ component: 'chatgpt', event: 'login_required' }, 'ChatGPT 未登录，请在打开的浏览器中人工登录');
    void browser.waitForLogin().then(() => {
      if (browser.state === BrowserState.READY) {
        logger.info({ component: 'chatgpt', event: 'login_detected' }, '检测到 ChatGPT 登录');
      }
    });
  }

  const wecom = new WeComClient(config.wecomBotId, config.wecomBotSecret, logger);
  const queue = new GlobalTaskQueue();
  const conversations = new ConversationManager(repository);
  const wechat = config.wechatEnabled
    ? new WindowsPersonalWeChatAdapter({
        projectRoot: process.cwd(),
        bridgePath: config.wechatBridgePath,
        pollIntervalMs: config.wechatPollIntervalMs,
        sendIntervalMs: config.wechatSendIntervalMs,
        logDirectory: config.wechatLogDirectory,
        requirePrefix: config.wechatRequirePrefix,
        prefixes: [config.wechatPrefix, ...config.wechatPrefixAliases],
        canonicalNames: config.wechatCanonicalNames,
        readMode: config.wechatReadMode,
        dbPythonPath: config.wechatDbPythonPath,
        dbConversations: config.wechatConversations.filter((item) => item.enabled),
      }, repository, logger)
    : undefined;
  const router = new MessageRouter(browser, conversations, repository, queue, logger, {
    logMessageContent: config.logMessageContent,
    policies: {
      wechat: {
        allowlist: new Set(config.wechatAllowlist),
        requirePrefix: config.wechatRequirePrefix,
        prefix: config.wechatPrefix,
        prefixes: [config.wechatPrefix, ...config.wechatPrefixAliases],
      },
    },
    health: {
      wecom: async () => wecom.connected,
      wechat: async () => wechat?.healthCheck() ?? false,
    },
    systemPrompt: (message) => message.platform === 'wechat'
      ? resolveWechatSystemPrompt(config.wechatConversations, message.userId, message.displayName)
      : undefined,
  });
  const handlers = new MessageHandlers(
    wecom, router, logger, { streamIntervalMs: config.streamUpdateIntervalMs },
  );
  wecom.onText((frame) => handlers.onText(frame));
  wecom.onEnterChat((frame) => handlers.onEnterChat(frame));
  logger.info({ component: 'wecom', event: 'connecting' }, '正在连接企业微信');
  wecom.connect();
  if (wechat) {
    wechat.onMessage(async (message) => {
      const mentionName = message.userId.endsWith('@chatroom')
        ? message.senderDisplayName ?? message.senderId
        : undefined;
      await router.handle({ message, reply: new WeChatReplySession(wechat, message.userId, mentionName) });
    });
    await wechat.start().catch((error) => {
      logger.error({ component: 'wechat', event: 'startup_failed', error }, '普通微信渠道启动失败，企业微信渠道继续运行');
    });
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ component: 'app', event: 'shutdown', signal }, '正在安全退出');
    wecom.disconnect();
    await wechat?.stop().catch(() => undefined);
    await browser.close();
    db.close();
    await logger.flush();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error('Bot 启动失败：', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
