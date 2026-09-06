import 'dotenv/config';
import path from 'node:path';
import { readDesktopSettings } from './desktop-settings.js';
import { loadWechatConversations, type WeChatConversationConfig } from './wechat-conversations.js';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少必填环境变量 ${name}，请检查 .env`);
  return value;
}

function booleanValue(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} 只能是 true 或 false`);
}

function positiveInteger(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} 必须是正整数`);
  return parsed;
}

export interface Config {
  systemPrompt?: string;
  replyPrefix?: string;
  replySuffix?: string;
  wechatSendAction?: 'enter' | 'ctrl-enter' | 'invoke';
  wecomEnabled: boolean;
  wecomBotId: string;
  wecomBotSecret: string;
  chatgptUrl: string;
  browserHeadless: boolean;
  browserProfile: string;
  databasePath: string;
  logLevel: string;
  logFile?: string;
  logMessageContent: boolean;
  chatgptTimeoutMs: number;
  streamUpdateIntervalMs: number;
  debugDirectory: string;
  wechatEnabled: boolean;
  wechatAllowlist: string[];
  wechatRequirePrefix: boolean;
  wechatPrefix: string;
  wechatPrefixAliases: string[];
  wechatCanonicalNames: string[];
  wechatReadMode: 'ocr' | 'db';
  wechatDbPythonPath: string;
  wechatDbConversations: string[];
  wechatConversationsFile: string;
  wechatConversations: WeChatConversationConfig[];
  wechatPollIntervalMs: number;
  wechatSendIntervalMs: number;
  wechatBridgePath?: string;
  wechatLogDirectory: string;
}

export function loadConfig(cwd = process.cwd()): Config {
  const desktop = readDesktopSettings(cwd);
  const wecomEnabled = booleanValue('WECOM_ENABLED', false);
  const wechatEnabled = booleanValue('WECHAT_ENABLED', true);
  if (!wecomEnabled && !wechatEnabled) throw new Error('至少启用一个渠道：WECHAT_ENABLED 或 WECOM_ENABLED');
  const readMode = process.env.WECHAT_READ_MODE || 'db';
  if (readMode !== 'db' && readMode !== 'ocr') throw new Error('WECHAT_READ_MODE 只能是 db 或 ocr');
  const sendMode = process.env.WECHAT_SEND_MODE || 'uia';
  if (sendMode !== 'uia' && sendMode !== 'legacy') throw new Error('WECHAT_SEND_MODE 只能是 uia 或 legacy');
  const sendAction = process.env.WECHAT_SEND_ACTION || 'enter';
  if (!['enter', 'ctrl-enter', 'invoke'].includes(sendAction)) throw new Error('WECHAT_SEND_ACTION 只能是 enter、ctrl-enter 或 invoke');
  const wechatConversationsFile = path.resolve(
    cwd,
    process.env.WECHAT_CONVERSATIONS_FILE || './config/wechat-conversations.json',
  );
  const configuredConversations = desktop?.conversations ?? loadWechatConversations(wechatConversationsFile);
  const legacyNames = (process.env.WECHAT_DB_CONVERSATIONS || process.env.WECHAT_CANONICAL_NAMES || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const wechatConversations = configuredConversations ?? legacyNames.map((name) => ({
    name,
    type: 'contact' as const,
    enabled: true,
  }));
  const enabledConversations = wechatConversations.filter((item) => item.enabled);
  if (wechatEnabled && enabledConversations.length === 0) {
    throw new Error('个人微信必须在 config/wechat-conversations.json 中明确配置至少一个监听会话');
  }
  return {
    systemPrompt: desktop?.systemPrompt,
    replyPrefix: desktop?.replyPrefix,
    replySuffix: desktop?.replySuffix,
    wechatSendAction: desktop?.sendAction ?? sendAction as 'enter' | 'ctrl-enter' | 'invoke',
    wecomEnabled,
    wecomBotId: wecomEnabled ? required('WECOM_BOT_ID') : '',
    wecomBotSecret: wecomEnabled ? required('WECOM_BOT_SECRET') : '',
    chatgptUrl: process.env.CHATGPT_URL?.trim() || 'https://chatgpt.com/',
    browserHeadless: booleanValue('BROWSER_HEADLESS', false),
    browserProfile: path.resolve(cwd, process.env.BROWSER_PROFILE || './data/browser-profile'),
    databasePath: path.resolve(cwd, process.env.DATABASE_PATH || './data/bot.sqlite'),
    logLevel: process.env.LOG_LEVEL?.trim() || 'info',
    logFile: (() => {
      const value = process.env.LOG_FILE;
      if (value === undefined) return path.resolve(cwd, './latest.log');
      const trimmed = value.trim();
      return trimmed ? path.resolve(cwd, trimmed) : undefined;
    })(),
    logMessageContent: booleanValue('LOG_MESSAGE_CONTENT', false),
    chatgptTimeoutMs: positiveInteger('CHATGPT_TIMEOUT_MS', 180_000),
    streamUpdateIntervalMs: positiveInteger('STREAM_UPDATE_INTERVAL_MS', 800),
    debugDirectory: path.resolve(cwd, './logs/debug'),
    wechatEnabled,
    wechatAllowlist: (process.env.WECHAT_ALLOWLIST || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
    wechatRequirePrefix: desktop?.requirePrefix ?? booleanValue('WECHAT_REQUIRE_PREFIX', true),
    wechatPrefix: desktop?.prefix ?? (process.env.WECHAT_PREFIX?.trim() || '/gpt'),
    wechatPrefixAliases: desktop?.prefixAliases ?? (process.env.WECHAT_PREFIX_ALIASES || '@ChatBOT,@chatbot')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
    wechatCanonicalNames: (process.env.WECHAT_CANONICAL_NAMES || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
    wechatReadMode: readMode,
    wechatDbPythonPath: path.resolve(cwd, process.env.WECHAT_DB_PYTHON_PATH || './.venv-wechatdb/Scripts/python.exe'),
    wechatDbConversations: enabledConversations.map((item) => item.name),
    wechatConversationsFile,
    wechatConversations,
    wechatPollIntervalMs: desktop?.pollIntervalMs ?? positiveInteger('WECHAT_POLL_INTERVAL_MS', 1_000),
    wechatSendIntervalMs: desktop?.sendIntervalMs ?? positiveInteger('WECHAT_SEND_INTERVAL_MS', 300),
    wechatBridgePath: process.env.WECHAT_BRIDGE_PATH?.trim()
      ? path.resolve(cwd, process.env.WECHAT_BRIDGE_PATH.trim())
      : undefined,
    wechatLogDirectory: path.resolve(cwd, './logs/wechat'),
  };
}
