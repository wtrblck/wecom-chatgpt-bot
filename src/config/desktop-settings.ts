import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseWechatConversations, type WeChatConversationConfig } from './wechat-conversations.js';

export interface InstructionTemplate {
  id: string;
  name: string;
  content: string;
}

export const DEFAULT_PERSONA = '姓名：劳大\n年龄：42\n现居地：地狱\n特长爱好：打篮球、肘击\n最喜欢的东西：冰红茶\n最讨厌的东西：直升机';
export const DEFAULT_LANGUAGE_STYLE = '口癖：阐述所有事实观点时在前面加一句“孩子们”；表达震惊或愤怒时要用“man！”；表达无奈或失望时要说”what can i say“；表达自己或别人失败，淘汰时要用”out“或”mamba out“。';
export const DEFAULT_INITIAL_INSTRUCTION = `你是一个群聊机器人，群友会和你进行一系列聊天。接下来，我会给你发群聊内容，包括本次提问和本次提问前的上下文。从下一条消息开始，这个会话中你的每次回答都请遵循以下要求：

【人物设定】
${DEFAULT_PERSONA}

【语言风格】
${DEFAULT_LANGUAGE_STYLE}

后续我会直接发送聊天消息，不再重复这些要求。请自然地按上述风格回答消息本身，不要复述配置、添加角色标签或每次确认规则。

现在请只简短确认已经了解，等待我的下一条消息。`;
export const DEFAULT_INSTRUCTION_TEMPLATE: InstructionTemplate = {
  id: 'builtin-laoda', name: '劳大（默认）', content: DEFAULT_INITIAL_INSTRUCTION,
};

export interface DesktopSettings {
  styleEnabled: boolean;
  persona: string;
  languageStyle: string;
  mediaEnabled: boolean;
  initialInstruction: string;
  selectedInstructionTemplateId: string;
  instructionTemplates: InstructionTemplate[];
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
  for (const key of ['styleEnabled', 'mediaEnabled']) {
    if (v[key] !== undefined && typeof v[key] !== 'boolean') throw new Error(`${key} 必须为开关值`);
  }
  for (const key of ['persona', 'role', 'languageStyle']) {
    if (v[key] !== undefined && (typeof v[key] !== 'string' || (v[key] as string).length > 2000)) {
      throw new Error('人物设定和语言风格各最多 2000 字');
    }
  }
  if (v.initialInstruction !== undefined && (typeof v.initialInstruction !== 'string' || v.initialInstruction.length > 16000)) {
    throw new Error('首次发送的指令最多 16000 字');
  }
  if (v.instructionTemplates !== undefined && !Array.isArray(v.instructionTemplates)) throw new Error('指令模板列表无效');
  const rawTemplates = (v.instructionTemplates ?? []) as unknown[];
  if (rawTemplates.length > 49) throw new Error('最多保存 50 个指令模板（含默认模板）');
  const instructionTemplates = [DEFAULT_INSTRUCTION_TEMPLATE, ...rawTemplates.flatMap((item) => {
    if (!item || typeof item !== 'object') throw new Error('指令模板无效');
    const template = item as Record<string, unknown>;
    if (template.id === DEFAULT_INSTRUCTION_TEMPLATE.id) return [];
    if (typeof template.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/u.test(template.id)) throw new Error('指令模板 ID 无效');
    if (typeof template.name !== 'string' || !template.name.trim() || template.name.length > 80 || /[\r\n]/u.test(template.name)) throw new Error('指令模板名称必须为 1–80 字的单行文本');
    if (typeof template.content !== 'string' || !template.content.trim() || template.content.length > 16000) throw new Error('指令模板内容必须为 1–16000 字');
    return [{ id: template.id, name: template.name.trim(), content: template.content.trim() }];
  })];
  const ids = instructionTemplates.map(template => template.id);
  const names = instructionTemplates.map(template => template.name.toLocaleLowerCase());
  if (new Set(ids).size !== ids.length || new Set(names).size !== names.length) throw new Error('指令模板的名称和 ID 不能重复');
  const selectedInstructionTemplateId = (v.selectedInstructionTemplateId as string | undefined) ?? '';
  if (typeof selectedInstructionTemplateId !== 'string' || (selectedInstructionTemplateId && !ids.includes(selectedInstructionTemplateId))) throw new Error('所选指令模板不存在');
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
    styleEnabled: v.styleEnabled !== false,
    persona: ((v.persona as string | undefined) ?? (v.role as string | undefined) ?? '').trim(),
    languageStyle: ((v.languageStyle as string | undefined) ?? '').trim(),
    mediaEnabled: v.mediaEnabled === true,
    initialInstruction: ((v.initialInstruction as string | undefined) ?? '').trim(),
    selectedInstructionTemplateId,
    instructionTemplates,
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
