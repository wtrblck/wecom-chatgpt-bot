function hardCharacterCut(text: string, maxCharacters: number): number {
  let consumed = 0;
  let index = 0;
  for (const character of text) {
    if (consumed >= maxCharacters) break;
    consumed += 1;
    index += character.length;
  }
  return index;
}

function groupSenderEnvelope(userId: string, text: string): { senderId: string; body: string } | null {
  const trimmed = text.trim();
  if (!userId.endsWith('@chatroom')) return null;

  const lineBreak = trimmed.indexOf('\n');
  if (lineBreak < 0) return null;
  const senderEnvelope = trimmed.slice(0, lineBreak).replace(/\r$/u, '');
  // WeChat 4.x stores group text as "sender_username:\nmessage". Only
  // remove a compact identifier-like first line so normal message text is safe.
  if (!/^[^\s:\r\n]{1,128}:$/u.test(senderEnvelope)) return null;
  return {
    senderId: senderEnvelope.slice(0, -1),
    body: trimmed.slice(lineBreak + 1).trim(),
  };
}

export function extractWechatDatabaseSenderId(userId: string, text: string): string | undefined {
  return groupSenderEnvelope(userId, text)?.senderId;
}

export function normalizeWechatDatabaseText(userId: string, text: string): string {
  return groupSenderEnvelope(userId, text)?.body ?? text.trim();
}

export interface WeChatPromptContext {
  messageId: string;
  speaker: string;
  text: string;
}

export function selectIncrementalWechatContext<T extends { messageId: string }>(
  messagesNewestFirst: readonly T[],
  wasSubmitted: (messageId: string) => boolean,
  maximum = 10,
): T[] {
  const previousSubmission = messagesNewestFirst.findIndex((message) => wasSubmitted(message.messageId));
  const sincePreviousSubmission = previousSubmission >= 0
    ? messagesNewestFirst.slice(0, previousSubmission)
    : messagesNewestFirst;
  return sincePreviousSubmission.slice(0, maximum).reverse();
}

export function matchWechatPrefix(text: string, prefixes: readonly string[]): { prefix: string; body: string } | null {
  const trimmed = text.trim();
  const prefix = prefixes.find((item) => {
    const candidate = trimmed.slice(0, item.length);
    return candidate === item
      && (trimmed.length === item.length || /^\s/u.test(trimmed.slice(item.length)));
  });
  return prefix ? { prefix, body: trimmed.slice(prefix.length).trim() } : null;
}

export function addWechatGroupContext(
  originalText: string,
  prefixes: readonly string[],
  currentSpeaker: string,
  messages: readonly WeChatPromptContext[],
  preservePrefix: boolean,
): string {
  const match = matchWechatPrefix(originalText, prefixes);
  if (!match || messages.length === 0) return originalText;
  const history = messages.map((message, index) => `${index + 1}. ${message.speaker}：${message.text}`).join('\n');
  const prompt = [
    '【本次提问前的群聊上下文（按时间顺序）】',
    '接着前一次的消息',
    history,
    '【本次提问】',
    `${currentSpeaker}：${match.body}`,
  ].join('\n\n');
  return preservePrefix ? `${match.prefix}\n\n${prompt}` : prompt;
}

export function splitWechatText(text: string, maxCharacters = 1_800): string[] {
  const result: string[] = [];
  let rest = text.trim();
  while ([...rest].length > maxCharacters) {
    const hardCut = hardCharacterCut(rest, maxCharacters);
    const candidate = rest.slice(0, hardCut);
    const minimum = Math.floor(hardCut * 0.55);
    const paragraph = candidate.lastIndexOf('\n\n');
    const line = candidate.lastIndexOf('\n');
    const sentence = Math.max(candidate.lastIndexOf('。'), candidate.lastIndexOf('！'), candidate.lastIndexOf('？'));
    const cut = paragraph >= minimum
      ? paragraph + 2
      : line >= minimum
        ? line + 1
        : sentence >= minimum
          ? sentence + 1
          : hardCut;
    result.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) result.push(rest);
  return result;
}
