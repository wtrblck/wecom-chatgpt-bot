export interface ReplyFormat {
  prefix?: string;
  suffix?: string;
}

export interface ConversationStyle {
  enabled?: boolean;
  persona?: string;
  /** @deprecated Kept for callers that still use the old field name. */
  role?: string;
  languageStyle?: string;
}

export function buildConversationInstructions(
  systemPrompt?: string,
  format: ReplyFormat = {},
  style: ConversationStyle = {},
  initialInstruction?: string,
): string | null {
  if (style.enabled === false) return null;
  const instruction = systemPrompt?.trim();
  const customInstruction = initialInstruction?.trim();
  if (customInstruction) {
    return instruction
      ? `${customInstruction}\n\n【会话补充要求】\n${instruction}`
      : customInstruction;
  }
  const persona = (style.persona ?? style.role)?.trim();
  const languageStyle = style.languageStyle?.trim();
  const prefix = format.prefix?.trim();
  const suffix = format.suffix?.trim();
  if (!instruction && !persona && !languageStyle && !prefix && !suffix) return null;
  const requirements = [
    persona ? `【人物设定】\n${persona}` : '',
    languageStyle ? `【语言风格】\n${languageStyle}` : '',
    prefix ? `【固定前缀】\n回复正文必须以 ${JSON.stringify(prefix)} 开头。` : '',
    suffix ? `【固定后缀】\n回复正文必须以 ${JSON.stringify(suffix)} 结尾，后面不要再加其他文字或标点。` : '',
    instruction ? `【补充要求】\n${instruction}` : '',
  ].filter(Boolean).join('\n\n');
  // The website accepts a user message, not an API system/developer role.
  return [
    '你是一个群聊机器人，群友会和你进行一系列聊天。接下来，我会给你发群聊内容，包括本次提问和本次提问前的上下文。从下一条消息开始，这个会话中你的每次回答都请遵循以下要求：',
    requirements,
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
