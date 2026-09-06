import { describe, expect, it } from 'vitest';
import {
  hasAssistantResponseStarted,
  responseIsComplete,
} from '../src/chatgpt/response-watcher.js';

describe('ChatGPT response completion', () => {
  it('detects a response when ChatGPT reuses the existing placeholder node', () => {
    expect(hasAssistantResponseStarted({
      assistantCount: 5,
      previousAssistantCount: 5,
      text: '不知道，不知道。',
      baselineText: '',
    })).toBe(true);
  });

  it('does not mistake the previous assistant answer for a new response', () => {
    expect(hasAssistantResponseStarted({
      assistantCount: 5,
      previousAssistantCount: 5,
      text: '上一条回答',
      baselineText: '上一条回答',
    })).toBe(false);
  });

  it('finishes when stable text and the send control has returned', () => {
    expect(responseIsComplete({
      text: '完整回答', stopVisible: true, sendVisible: true, stableForMs: 1_500,
    })).toBe(true);
  });

  it('ignores short pauses while generation is still active', () => {
    expect(responseIsComplete({
      text: '部分回答', stopVisible: true, sendVisible: false, stableForMs: 3_000,
    })).toBe(false);
  });

  it('recovers from a stale stop control after text remains stable', () => {
    expect(responseIsComplete({
      text: '完整回答', stopVisible: true, sendVisible: false, stableForMs: 8_000,
    })).toBe(true);
  });
});
