import { describe, expect, it } from 'vitest';
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
      '20663368641@chatroom',
      'wxid_u3yyhe3yrwh122:\n@ChatBOT\u2005111',
    )).toBe('@ChatBOT\u2005111');
    expect(extractWechatDatabaseSenderId(
      '20663368641@chatroom',
      'wxid_u3yyhe3yrwh122:\n@ChatBOT\u2005111',
    )).toBe('wxid_u3yyhe3yrwh122');
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
});
