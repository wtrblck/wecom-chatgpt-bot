import fs from 'node:fs';

export type WeChatConversationType = 'group' | 'contact';

export interface WeChatConversationConfig {
  name: string;
  type: WeChatConversationType;
  id?: string;
  enabled: boolean;
  systemPrompt?: string;
}

interface ConversationFile {
  conversations?: unknown;
}

export function parseWechatConversations(value: unknown): WeChatConversationConfig[] {
  const root = value as ConversationFile | null;
  if (!root || !Array.isArray(root.conversations)) {
    throw new Error('微信监听配置必须包含 conversations 数组');
  }
  const seen = new Set<string>();
  const names = new Set<string>();
  return root.conversations.map((raw, index) => {
    if (!raw || typeof raw !== 'object') throw new Error(`conversations[${index}] 必须是对象`);
    const item = raw as Record<string, unknown>;
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    const type = item.type;
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    const systemPrompt = typeof item.systemPrompt === 'string' ? item.systemPrompt.trim() : '';
    if (!name) throw new Error(`conversations[${index}].name 不能为空`);
    if (type !== 'group' && type !== 'contact') {
      throw new Error(`conversations[${index}].type 只能是 group 或 contact`);
    }
    if (item.enabled !== undefined && typeof item.enabled !== 'boolean') {
      throw new Error(`conversations[${index}].enabled 必须是布尔值`);
    }
    const key = id || `${type}:${name}`;
    if (seen.has(key)) throw new Error(`微信监听配置存在重复会话: ${key}`);
    if (item.enabled !== false && names.has(name)) throw new Error(`控件发送不能区分同名会话，请使用唯一群名或备注: ${name}`);
    if (item.enabled !== false) names.add(name);
    seen.add(key);
    return {
      name,
      type,
      ...(id ? { id } : {}),
      enabled: item.enabled !== false,
      ...(systemPrompt ? { systemPrompt } : {}),
    };
  });
}

export function loadWechatConversations(filePath: string): WeChatConversationConfig[] | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return parseWechatConversations(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`无法读取微信监听配置 ${filePath}: ${detail}`);
  }
}

export function resolveWechatSystemPrompt(
  conversations: readonly WeChatConversationConfig[],
  userId: string,
  displayName?: string,
  globalPrompt?: string,
): string | undefined {
  const enabled = conversations.filter((item) => item.enabled);
  const matched = enabled.find((item) => item.id === userId)
    ?? enabled.find((item) => !item.id && item.name === displayName);
  return [globalPrompt?.trim(), matched?.systemPrompt].filter(Boolean).join('\n\n') || undefined;
}
