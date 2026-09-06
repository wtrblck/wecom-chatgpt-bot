import { describe, expect, it, vi } from 'vitest';
import { OutgoingQueue } from '../src/wechat/outgoing-queue.js';
import { WeChatReplySession } from '../src/wechat/reply-session.js';
import {
  extractWechatDatabaseSenderId,
  normalizeWechatDatabaseText,
  splitWechatText,
} from '../src/wechat/text.js';
import type { PersonalWeChatAdapter } from '../src/wechat/types.js';

describe('personal WeChat helpers', () => {
  it('removes the WeChat database sender envelope from group text', () => {
    expect(normalizeWechatDatabaseText(
      'example@chatroom',
      'wxid_example:\n@ChatBOT\u2005111',
    )).toBe('@ChatBOT\u2005111');
    expect(extractWechatDatabaseSenderId(
      'example@chatroom',
      'wxid_example:\n@ChatBOT\u2005111',
    )).toBe('wxid_example');
    expect(normalizeWechatDatabaseText('wxid_friend', '/gpt hello')).toBe('/gpt hello');
  });

  it('mentions the group sender id in replies but leaves direct replies unchanged', async () => {
    const sent: string[] = [];
    const adapter = {
      sendText: async (_userId: string, text: string) => { sent.push(text); },
    } as PersonalWeChatAdapter;
    await new WeChatReplySession(adapter, 'group@chatroom', '能源城大天使').finish('回答');
    await new WeChatReplySession(adapter, 'wxid_friend').finish('私聊回答');
    expect(sent).toEqual(['@能源城大天使 回答', '私聊回答']);
  });

  it('splits long answers on natural paragraph boundaries', () => {
    const text = `${'甲'.repeat(900)}\n\n${'乙'.repeat(900)}\n\n${'🙂'.repeat(900)}`;
    const chunks = splitWechatText(text, 1_000);
    expect(chunks.join('')).toBe(text);
    expect(chunks.every((chunk) => [...chunk].length <= 1_000)).toBe(true);
    expect(chunks).toHaveLength(3);
  });

  it('uses exactly one FIFO sending worker', async () => {
    const queue = new OutgoingQueue(1);
    const events: string[] = [];
    let active = 0;
    let maxActive = 0;
    const work = (name: string) => queue.enqueue(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      events.push(`${name}:start`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      events.push(`${name}:end`);
      active -= 1;
    });
    await Promise.all([work('a'), work('b'), work('c')]);
    expect(maxActive).toBe(1);
    expect(events).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
  });

  it('preserves pacing when callers await each send and the queue temporarily empties', async () => {
    vi.useFakeTimers();
    try {
      const queue = new OutgoingQueue(1_000);
      const sentAt: number[] = [];
      await queue.enqueue(async () => { sentAt.push(Date.now()); });
      const next = queue.enqueue(async () => { sentAt.push(Date.now()); });
      await vi.advanceTimersByTimeAsync(999);
      expect(sentAt).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      await next;
      expect(sentAt[1]! - sentAt[0]!).toBeGreaterThanOrEqual(1_000);
    } finally { vi.useRealTimers(); }
  });

  it('does not start a waiting send after close during the pacing delay', async () => {
    vi.useFakeTimers();
    try {
      const queue = new OutgoingQueue(1_000);
      await queue.enqueue(async () => undefined);
      const run = vi.fn(async () => undefined);
      const waiting = expect(queue.enqueue(run)).rejects.toThrow('已停止');
      queue.close();
      await vi.advanceTimersByTimeAsync(1_000);
      await waiting;
      expect(run).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});
