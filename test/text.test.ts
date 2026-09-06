import { describe, expect, it } from 'vitest';
import { splitUtf8, takeUtf8Chunk, utf8ByteLength } from '../src/utils/text.js';

describe('UTF-8 text helpers', () => {
  it('counts Chinese characters by bytes', () => expect(utf8ByteLength('中文a')).toBe(7));
  it('never cuts through a Unicode code point', () => {
    const [first, rest] = takeUtf8Chunk('你好🙂世界', 7);
    expect(first + rest).toBe('你好🙂世界');
    expect(utf8ByteLength(first)).toBeLessThanOrEqual(7);
  });
  it('splits every chunk under the byte limit', () => {
    const source = '第一段。\n\n第二段🙂。\n\n第三段。'.repeat(50);
    const chunks = splitUtf8(source, 100);
    expect(chunks.join('')).toBe(source);
    expect(chunks.every((chunk) => utf8ByteLength(chunk) <= 100)).toBe(true);
  });
});
