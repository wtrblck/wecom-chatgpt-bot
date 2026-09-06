import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseWechatConversations, type WeChatConversationConfig } from './wechat-conversations.js';

export interface DesktopSettings {
  systemPrompt: string;
  replyPrefix: string;
  replySuffix: string;
  requirePrefix: boolean;
  prefix: string;
  prefixAliases: string[];
  pollIntervalMs: number;
  sendIntervalMs: number;
  sendAction: 'enter' | 'ctrl-enter' | 'invoke';
  conversations: WeChatConversationConfig[];
}

export function parseDesktopSettings(value: unknown): DesktopSettings {
  if (!value || typeof value !== 'object') throw new Error('桌面配置必须是对象');
  const v = value as Record<string, unknown>;
  if (typeof v.systemPrompt !== 'string' || v.systemPrompt.length > 16000) throw new Error('系统提示词最多 16000 字');
  for (const key of ['replyPrefix', 'replySuffix']) {
    if (v[key] !== undefined && (typeof v[key] !== 'string' || (v[key] as string).length > 100 || /[\r\n]/u.test(v[key] as string))) {
      throw new Error('回复固定前后缀必须是最多 100 字的单行文本');
    }
  }
  if (typeof v.requirePrefix !== 'boolean') throw new Error('触发开关无效');
  if (typeof v.prefix !== 'string' || !v.prefix.trim() || v.prefix.length > 40 || /[\r\n]/u.test(v.prefix)) throw new Error('触发词必须为 1–40 字的单行文本');
  const aliases = v.prefixAliases ?? ['@ChatBOT', '@chatbot'];
  if (!Array.isArray(aliases) || aliases.length > 20 || aliases.some(a => typeof a !== 'string' || !a.trim() || a.length > 40 || /[\r\n]/u.test(a))) throw new Error('最多设置 20 个别名，每个为 1–40 字的单行文本');
  for (const [key, min, max] of [['pollIntervalMs', 500, 60000], ['sendIntervalMs', 300, 60000]] as const) {
    if (!Number.isInteger(v[key]) || Number(v[key]) < min || Number(v[key]) > max) throw new Error(`${key} 必须在 ${min}–${max} 毫秒之间`);
  }
  if (!['enter', 'ctrl-enter', 'invoke'].includes(String(v.sendAction))) throw new Error('发送快捷键无效');
  const conversations = parseWechatConversations(v);
  if (conversations.some(c => (c.systemPrompt?.length ?? 0) > 16000)) throw new Error('会话提示词最多 16000 字');
  return {
    systemPrompt: v.systemPrompt.trim(), requirePrefix: v.requirePrefix, prefix: v.prefix.trim(),
    replyPrefix: ((v.replyPrefix as string | undefined) ?? '').trim(),
    replySuffix: ((v.replySuffix as string | undefined) ?? '').trim(),
    prefixAliases: [...new Set((aliases as string[]).map(a => a.trim()))],
    pollIntervalMs: Number(v.pollIntervalMs), sendIntervalMs: Number(v.sendIntervalMs),
    sendAction: v.sendAction as DesktopSettings['sendAction'], conversations,
  };
}

export function readDesktopSettings(root: string): DesktopSettings | undefined {
  const file = path.join(root, 'data', 'desktop-settings.json');
  if (!fs.existsSync(file)) return undefined;
  return parseDesktopSettings(JSON.parse(fs.readFileSync(file, 'utf8')));
}

export function saveDesktopSettings(root: string, value: unknown): DesktopSettings {
  const settings = parseDesktopSettings(value);
  const file = path.join(root, 'data', 'desktop-settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(settings, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  return settings;
}
