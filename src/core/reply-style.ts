export interface ReplyFormat {
  prefix?: string;
  suffix?: string;
}

export function buildConversationInstructions(systemPrompt?: string, format: ReplyFormat = {}): string | null {
  const instruction = systemPrompt?.trim();
  const prefix = format.prefix?.trim();
  const suffix = format.suffix?.trim();
  if (!instruction && !prefix && !suffix) return null;
  const requirements = [instruction,
    prefix ? `回复正文必须以 ${JSON.stringify(prefix)} 开头。` : '',
    suffix ? `回复正文必须以 ${JSON.stringify(suffix)} 结尾，后面不要再加其他文字或标点。` : '',
  ].filter(Boolean).join('\n');
  // The website accepts a user message, not an API system/developer role.
  return [
    '接下来，我会和你进行一系列聊天。从下一条消息开始，这个对话中你的每次回答都请遵循以下要求：',
    `# 回复要求\n${requirements}`,
    '后续我会直接发送聊天消息，不再重复这些要求。请自然地按上述风格回答消息本身，不要复述配置、添加角色标签或每次确认规则。',
    '现在请只简短确认已经了解，等待我的下一条消息。',
  ].join('\n\n');
}

/** Apply once before persisting the answer so retries reuse the exact same text. */
export function applyReplyFormat(text: string, format: ReplyFormat = {}): string {
  const prefix = format.prefix?.trim() ?? '';
  const suffix = format.suffix?.trim() ?? '';
  if (!prefix && !suffix) return text;
  let result = text.trim();
  if (!result) return text;
  if (prefix && !result.startsWith(prefix)) result = prefix + result;
  if (suffix && !result.endsWith(suffix)) result += suffix;
  return result;
}
