const encoder = new TextEncoder();

export function utf8ByteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

function hardUtf8Cut(text: string, maxBytes: number): number {
  let bytes = 0;
  let index = 0;
  for (const character of text) {
    const size = utf8ByteLength(character);
    if (bytes + size > maxBytes) break;
    bytes += size;
    index += character.length;
  }
  return index;
}

export function takeUtf8Chunk(text: string, maxBytes: number): [string, string] {
  if (utf8ByteLength(text) <= maxBytes) return [text, ''];
  const hardCut = hardUtf8Cut(text, maxBytes);
  const candidate = text.slice(0, hardCut);
  const minimumUsefulCut = Math.floor(hardCut * 0.6);
  const separators = ['\n\n', '\n', '。', '！', '？', '. ', '! ', '? ', ' '];
  let preferredCut = -1;
  for (const separator of separators) {
    const found = candidate.lastIndexOf(separator);
    if (found >= minimumUsefulCut) {
      preferredCut = found + separator.length;
      break;
    }
  }
  const cut = preferredCut > 0 ? preferredCut : hardCut;
  return [text.slice(0, cut), text.slice(cut)];
}

export function splitUtf8(text: string, maxBytes: number): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest) {
    const [chunk, next] = takeUtf8Chunk(rest, maxBytes);
    if (!chunk) throw new Error('无法按 UTF-8 安全分段');
    chunks.push(chunk);
    rest = next;
  }
  return chunks;
}

export function conversationIdFromUrl(url: string | null): string {
  if (!url) return '-';
  const match = url.match(/\/c\/([^/?#]+)/);
  return match?.[1] ?? url;
}
