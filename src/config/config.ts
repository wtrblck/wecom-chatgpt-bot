import 'dotenv/config';
import path from 'node:path';
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
  const wechatConversationsFile = path.resolve(
    cwd,
    process.env.WECHAT_CONVERSATIONS_FILE || './config/wechat-conversations.json',
  );
  const configuredConversations = loadWechatConversations(wechatConversationsFile);
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
  return {
    wecomBotId: required('WECOM_BOT_ID'),
    wecomBotSecret: required('WECOM_BOT_SECRET'),
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
    wechatEnabled: booleanValue('WECHAT_ENABLED', false),
    wechatAllowlist: (process.env.WECHAT_ALLOWLIST || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
    wechatRequirePrefix: booleanValue('WECHAT_REQUIRE_PREFIX', false),
    wechatPrefix: process.env.WECHAT_PREFIX?.trim() || '/gpt',
    wechatPrefixAliases: (process.env.WECHAT_PREFIX_ALIASES || '@ChatBOT')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
    wechatCanonicalNames: (process.env.WECHAT_CANONICAL_NAMES || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
    wechatReadMode: process.env.WECHAT_READ_MODE === 'db' ? 'db' : 'ocr',
    wechatDbPythonPath: path.resolve(cwd, process.env.WECHAT_DB_PYTHON_PATH || './.venv-wechatdb/Scripts/python.exe'),
    wechatDbConversations: enabledConversations.map((item) => item.name),
    wechatConversationsFile,
    wechatConversations,
    wechatPollIntervalMs: positiveInteger('WECHAT_POLL_INTERVAL_MS', 1_000),
    wechatSendIntervalMs: positiveInteger('WECHAT_SEND_INTERVAL_MS', 300),
    wechatBridgePath: process.env.WECHAT_BRIDGE_PATH?.trim()
      ? path.resolve(cwd, process.env.WECHAT_BRIDGE_PATH.trim())
      : undefined,
    wechatLogDirectory: path.resolve(cwd, './logs/wechat'),
  };
}
