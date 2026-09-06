import { describe, expect, it } from 'vitest';
import { applyReplyFormat, buildConversationInstructions } from '../src/core/reply-style.js';

describe('web reply style and deterministic formatting', () => {
  it('passes unconfigured messages through unchanged', () => {
    expect(buildConversationInstructions()).toBeNull();
    expect(applyReplyFormat('  hello\n')).toBe('  hello\n');
  });
  it('builds a separate setup turn covering the whole conversation', () => {
    const prompt = buildConversationInstructions('温柔俏皮', { prefix: '主人', suffix: '喵' })!;
    expect(prompt).toContain('温柔俏皮');
    expect(prompt).toContain('"主人"');
    expect(prompt).toContain('"喵"');
    expect(prompt).toContain('一系列聊天');
    expect(prompt).toContain('不再重复');
    expect(prompt).toContain('等待我的下一条消息');
    expect(prompt).not.toContain('系统指令');
  });
  it('enforces configured affixes even when the model omits them', () => {
    expect(applyReplyFormat(' 我在这里。\n', { prefix: '主人', suffix: '喵' })).toBe('主人我在这里。喵');
    expect(buildConversationInstructions('', { suffix: '喵' })).toContain('"喵"');
  });
  it('does not repeat affixes already supplied by the model or on retry', () => {
    const format = { prefix: '主人', suffix: '喵' };
    const answer = '主人，我在呢，喵';
    expect(applyReplyFormat(answer, format)).toBe(answer);
    expect(applyReplyFormat(applyReplyFormat('我在呢', format), format)).toBe('主人我在呢喵');
  });
  it('handles independently disabled affixes and keeps empty answers empty', () => {
    expect(applyReplyFormat('回答', { suffix: '喵' })).toBe('回答喵');
    expect(applyReplyFormat('回答', { prefix: '主人' })).toBe('主人回答');
    expect(applyReplyFormat('', { prefix: '主人', suffix: '喵' })).toBe('');
  });
});

describe('modular style switches', () => {
  it('builds only configured blocks and skips whitespace-only or disabled styles', () => {
    expect(buildConversationInstructions('  ', { prefix: ' ' }, { role: ' ', languageStyle: '\n' })).toBeNull();
    expect(buildConversationInstructions('legacy', { suffix: '喵' }, { enabled: false, role: '猫娘' })).toBeNull();
    const instruction = buildConversationInstructions('', {}, { persona: '猫娘', languageStyle: '甜蜜' })!;
    expect(instruction).toContain('【人物设定】\n猫娘');
    expect(instruction).toContain('【语言风格】\n甜蜜');
    expect(instruction).not.toContain('【固定前缀】');
    expect(instruction).not.toContain('【补充要求】');
  });
  it('uses an editable initial instruction verbatim and appends only conversation-specific requirements', () => {
    expect(buildConversationInstructions(undefined, {}, {}, '  我的自定义指令  ')).toBe('我的自定义指令');
    expect(buildConversationInstructions('本群不要刷屏', {}, {}, '我的自定义指令')).toBe('我的自定义指令\n\n【会话补充要求】\n本群不要刷屏');
    expect(buildConversationInstructions('补充', {}, { enabled: false }, '自定义')).toBeNull();
  });
});
