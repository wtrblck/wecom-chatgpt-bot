import { describe, expect, it } from 'vitest';
import {
  parseWechatConversations,
  resolveWechatSystemPrompt,
} from '../src/config/wechat-conversations.js';
import { buildConversationInstructions } from '../src/core/reply-style.js';

describe('WeChat conversation configuration', () => {
  it('parses enabled listeners and their system prompts', () => {
    const conversations = parseWechatConversations({
      conversations: [
        { name: '项目群', type: 'group', id: 'room@chatroom', enabled: true, systemPrompt: '简洁回答' },
        { name: '张三', type: 'contact', enabled: false, systemPrompt: '友好回答' },
      ],
    });
    expect(conversations).toHaveLength(2);
    expect(conversations[0]?.systemPrompt).toBe('简洁回答');
    expect(conversations[1]?.enabled).toBe(false);
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
    expect(buildConversationInstructions('回答要简洁')).toContain('回答要简洁');
    expect(buildConversationInstructions('回答要简洁')).toContain('下一条消息');
    expect(buildConversationInstructions('')).toBeNull();
  });
});
