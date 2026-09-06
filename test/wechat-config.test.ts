import { describe, expect, it } from 'vitest';
import {
  parseWechatConversations,
  resolveWechatPrefixes,
  resolveWechatSystemPrompt,
} from '../src/config/wechat-conversations.js';
import { applySystemPrompt } from '../src/core/message-router.js';

describe('WeChat conversation configuration', () => {
  it('parses enabled listeners and their system prompts', () => {
    const conversations = parseWechatConversations({
      conversations: [
        { name: '项目群', type: 'group', id: 'room@chatroom', enabled: true, systemPrompt: '简洁回答', prefixes: ['@ProjectBot'] },
        { name: '张三', type: 'contact', enabled: false, systemPrompt: '友好回答' },
      ],
    });
    expect(conversations).toHaveLength(2);
    expect(conversations[0]?.systemPrompt).toBe('简洁回答');
    expect(conversations[0]?.prefixes).toEqual(['@ProjectBot']);
    expect(conversations[1]?.enabled).toBe(false);
  });

  it('resolves exact per-conversation prefixes with a legacy fallback', () => {
    const conversations = parseWechatConversations({
      conversations: [
        { name: '项目群', type: 'group', id: 'room@chatroom', prefixes: ['/ask', '@ProjectBot'] },
        { name: '张三', type: 'contact', prefixes: [''] },
      ],
    });
    expect(resolveWechatPrefixes(conversations, 'room@chatroom', undefined, ['/gpt'])).toEqual(['/ask', '@ProjectBot']);
    expect(resolveWechatPrefixes(conversations, 'unknown', '张三', ['/gpt'])).toEqual(['']);
  });

  it('resolves by stable id first and display name as fallback', () => {
    const conversations = parseWechatConversations({
      conversations: [
        { name: '项目群', type: 'group', id: 'room@chatroom', systemPrompt: '群提示' },
        { name: '张三', type: 'contact', systemPrompt: '私聊提示' },
      ],
    });
    expect(resolveWechatSystemPrompt(conversations, 'room@chatroom', '旧群名')).toBe('群提示');
    expect(resolveWechatSystemPrompt(conversations, 'unknown', '张三')).toBe('私聊提示');
  });

  it('wraps only the browser prompt and does not nest an empty prompt', () => {
    expect(applySystemPrompt('用户问题', '回答要简洁')).toContain('回答要简洁');
    expect(applySystemPrompt('用户问题', '回答要简洁')).toContain('用户问题');
    expect(applySystemPrompt('用户问题', '')).toBe('用户问题');
  });
});
