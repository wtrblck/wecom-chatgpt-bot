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
