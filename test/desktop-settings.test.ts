import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_INITIAL_INSTRUCTION,
  DEFAULT_INSTRUCTION_TEMPLATE,
  DEFAULT_PERSONA,
  parseDesktopSettings,
  readDesktopSettings,
  saveDesktopSettings,
} from '../src/config/desktop-settings.js';
import { loadConfig } from '../src/config/config.js';
import { resolveWechatSystemPrompt } from '../src/config/wechat-conversations.js';
import { DesktopService } from '../src/desktop/service.js';
import { openDatabase } from '../src/db/sqlite.js';
import { Repository } from '../src/conversation/repository.js';

const roots: string[] = [];
function root() {
  const base = path.resolve('.cache/tests');
  fs.mkdirSync(base, { recursive: true });
  const result = fs.mkdtempSync(path.join(base, 'desktop-')); roots.push(result); return result;
}
const valid = () => ({ systemPrompt: '简洁回答', prefix: '/gpt', prefixAliases: ['@ChatBOT', '@chatbot'], requirePrefix: true,
  pollIntervalMs: 1000, sendIntervalMs: 300, sendAction: 'enter',
  conversations: [{ name: '开发测试群', type: 'group', enabled: true, systemPrompt: '保留代码示例' }] });
afterEach(() => { vi.unstubAllEnvs(); for (const directory of roots.splice(0)) {
  if (!directory.startsWith(path.resolve('.cache/tests') + path.sep)) throw new Error('invalid test directory');
  fs.rmSync(directory, { recursive: true, force: true });
} });
describe('desktop configuration and integration', () => {
  it('resets only the selected saved conversation without erasing task history', async () => {
    const directory = root(); saveDesktopSettings(directory, valid());
    vi.stubEnv('DATABASE_PATH', path.join(directory, 'data/bot.sqlite'));
    const db = openDatabase(path.join(directory, 'data/bot.sqlite'));
    const repo = new Repository(db);
    repo.saveContact('wechat', 'a', '开发测试群');
    repo.saveConversation('wechat:a', 'https://chatgpt.com/c/a');
    repo.saveConversation('wechat:b', 'https://chatgpt.com/c/b');
    const task = repo.createTask('test-task', 'wechat:a', '历史问题'); repo.updateTask(task, 'completed', { response: '历史回答' });
    const service = new DesktopService(directory);
    try {
      await expect(service.action('newConversation', { index: 0, name: '错误名称' })).rejects.toThrow('选择');
      await expect(service.action('newConversation', { index: 0, name: '开发测试群' })).resolves.toEqual({ reset: true });
      expect(repo.getConversation('wechat:a')).toBeNull();
      expect(repo.getConversation('wechat:b')).toBe('https://chatgpt.com/c/b');
      expect(repo.lastTask('wechat:a')?.response).toBe('历史回答');
      repo.saveContact('wechat', 'same-name', '开发测试群');
      await expect(service.action('newConversation', { index: 0, name: '开发测试群' })).rejects.toThrow('同名');
    } finally { db.close(); await service.action('close'); }
  });
  it('migrates old settings with empty affixes and validates explicit reply formatting', () => {
    expect(parseDesktopSettings(valid())).toMatchObject({ replyPrefix: '', replySuffix: '' });
    const directory = root();
    saveDesktopSettings(directory, { ...valid(), replyPrefix: '主人', replySuffix: '喵' });
    vi.stubEnv('WECOM_ENABLED', 'false'); vi.stubEnv('WECHAT_ENABLED', 'true');
    expect(loadConfig(directory)).toMatchObject({ replyPrefix: '主人', replySuffix: '喵' });
    expect(() => parseDesktopSettings({ ...valid(), replyPrefix: 123 })).toThrow();
    expect(() => parseDesktopSettings({ ...valid(), replySuffix: 'a'.repeat(101) })).toThrow();
    expect(() => parseDesktopSettings({ ...valid(), replySuffix: 'a\nb' })).toThrow();
  });
  it('saves atomically and preserves previous settings after failed validation', () => {
    const directory = root(); saveDesktopSettings(directory, valid());
    expect(() => saveDesktopSettings(directory, { ...valid(), pollIntervalMs: 0 })).toThrow();
    expect(readDesktopSettings(directory)?.pollIntervalMs).toBe(1000);
    expect(fs.readdirSync(path.join(directory, 'data'))).toEqual(['desktop-settings.json']);
  });
  it('rejects invalid aliases, duplicate destinations and oversized prompts', () => {
    expect(() => parseDesktopSettings({ ...valid(), prefixAliases: [''] })).toThrow();
    expect(() => parseDesktopSettings({ ...valid(), conversations: [...valid().conversations, ...valid().conversations] })).toThrow();
    expect(() => parseDesktopSettings({ ...valid(), systemPrompt: 'a'.repeat(16001) })).toThrow();
    expect(parseDesktopSettings({ ...valid(), prefixAliases: [] }).prefixAliases).toEqual([]);
  });
  it('passes UI values to the actual bot and composes global and group instructions', () => {
    const directory = root();
    vi.stubEnv('WECOM_ENABLED', 'false'); vi.stubEnv('WECHAT_ENABLED', 'true');
    vi.stubEnv('WECHAT_CONVERSATIONS_FILE', path.join(directory, 'nonexistent.json'));
    vi.stubEnv('WECHAT_PREFIX_ALIASES', '@OldBot'); vi.stubEnv('WECHAT_REQUIRE_PREFIX', 'false');
    saveDesktopSettings(directory, valid());
    const config = loadConfig(directory);
    expect(config.wechatPrefixAliases).toEqual(['@ChatBOT', '@chatbot']);
    expect(config.wechatRequirePrefix).toBe(true);
    expect(config.wechatDbConversations).toEqual(['开发测试群']);
    expect(resolveWechatSystemPrompt(config.wechatConversations, 'group', '开发测试群', config.systemPrompt)).toBe('简洁回答\n\n保留代码示例');
  });
  it('supports first-run empty configuration and rejects starting without listeners', async () => {
    const directory = root(); vi.stubEnv('WECHAT_CONVERSATIONS_FILE', path.join(directory, 'missing.json')); vi.stubEnv('WECHAT_DB_CONVERSATIONS', '');
    vi.stubEnv('WECOM_ENABLED', 'false'); vi.stubEnv('WECHAT_ENABLED', 'true');
    const service = new DesktopService(directory);
    expect((await service.state()).phase).toBe('stopped');
    await service.action('save', { ...valid(), conversations: [] });
    await expect(service.action('start')).rejects.toThrow('监听会话');
    expect((await service.state()).phase).toBe('stopped');
    await service.action('close');
  });
  it('reads stats without creating a database and exports no chat configuration', async () => {
    const directory = root(); saveDesktopSettings(directory, valid());
    const service = new DesktopService(directory);
    expect((await service.state()).stats.completed).toBe(0);
    expect(fs.existsSync(path.join(directory, 'data/bot.sqlite'))).toBe(false);
    const report = await service.action('export') as string;
    const text = fs.readFileSync(report, 'utf8');
    expect(text).not.toContain('开发测试群'); expect(text).not.toContain('简洁回答');
    await expect(service.action('unsupported')).rejects.toThrow();
    await service.action('close');
  });
  it('starts an isolated worker, reports live status, blocks settings changes and stops through IPC', async () => {
    const directory = root();
    vi.stubEnv('WECOM_ENABLED', 'false'); vi.stubEnv('WECHAT_ENABLED', 'true');
    saveDesktopSettings(directory, valid());
    fs.mkdirSync(path.join(directory, 'dist/src'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'dist/src/index.js'), [
      'process.send({type:"desktop-ready"});',
      'process.on("message",m=>{',
      'if(m.type==="desktop-status")process.send({type:"desktop-status",browser:"READY",account:"authenticated",queue:2,shuttingDown:false});',
      'if(m.type==="desktop-new-conversation")process.send({type:"desktop-new-conversation-result",requestId:m.requestId,ok:true});',
      'if(m.type==="shutdown")process.exit(0);',
      '});',
    ].join('\n'));
    const service = new DesktopService(directory);
    try {
      await service.action('start');
      await vi.waitFor(async () => expect((await service.state()).phase).toBe('running'));
      await vi.waitFor(async () => expect((await service.state()).account).toBe('authenticated'));
      expect((await service.state()).queue).toBe(2);
      await expect(service.action('newConversation', { index: 0, name: '开发测试群' })).resolves.toEqual({ reset: true });
      await expect(service.action('save', valid())).rejects.toThrow('停止');
      await expect(service.action('start')).rejects.toThrow('已启动');
      await service.action('stop');
      expect((await service.state()).phase).toBe('stopped');
      expect((await service.state()).account).toBe('unknown');
    } finally { await service.action('close'); }
  });
});

describe('style and media configuration migration', () => {
  it('keeps legacy instructions enabled while media is opt-in and validates new fields', () => {
    expect(parseDesktopSettings(valid())).toMatchObject({ styleEnabled: true, persona: '', languageStyle: '', mediaEnabled: false,
      initialInstruction: '', selectedInstructionTemplateId: '', instructionTemplates: [DEFAULT_INSTRUCTION_TEMPLATE] });
    for (const field of ['styleEnabled', 'mediaEnabled']) expect(() => parseDesktopSettings({ ...valid(), [field]: 'false' })).toThrow();
    expect(() => parseDesktopSettings({ ...valid(), role: 'x'.repeat(2001) })).toThrow();
    const directory = root();
    saveDesktopSettings(directory, { ...valid(), styleEnabled: false, role: '猫娘', languageStyle: '甜蜜', mediaEnabled: true });
    vi.stubEnv('WECOM_ENABLED', 'false'); vi.stubEnv('WECHAT_ENABLED', 'true');
    expect(loadConfig(directory)).toMatchObject({ styleEnabled: false, persona: '猫娘', languageStyle: '甜蜜', wechatMediaEnabled: true });
  });
  it('previews unsaved style without changing stored settings', async () => {
    const directory = root(); saveDesktopSettings(directory, valid());
    const service = new DesktopService(directory);
    try {
      const preview = await service.action('composeInstruction', { ...valid(), persona: '猫娘', languageStyle: '甜蜜' }) as { instructions: string };
      expect(preview.instructions).toContain('【人物设定】\n猫娘');
      expect(readDesktopSettings(directory)?.persona).toBe('');
      expect(await service.action('previewStyle', { ...valid(), initialInstruction: '可编辑的完整指令' })).toEqual({ instructions: '可编辑的完整指令' });
      expect(await service.action('previewStyle', { ...valid(), styleEnabled: false })).toEqual({ instructions: null });
    } finally { await service.action('close'); }
  });
  it('provides the requested default and persists reusable named instruction templates', async () => {
    const directory = root(); const service = new DesktopService(directory);
    try {
      expect(service.settings()).toMatchObject({ persona: DEFAULT_PERSONA, initialInstruction: DEFAULT_INITIAL_INSTRUCTION,
        selectedInstructionTemplateId: DEFAULT_INSTRUCTION_TEMPLATE.id, instructionTemplates: [DEFAULT_INSTRUCTION_TEMPLATE] });
      expect(DEFAULT_INITIAL_INSTRUCTION).toContain('你是一个群聊机器人');
      expect(DEFAULT_INITIAL_INSTRUCTION).toContain('【人物设定】\n姓名：劳大');
      expect(DEFAULT_INITIAL_INSTRUCTION).toContain('要说”what can i say“');
      const custom = { id: 'custom-one', name: '项目群', content: '你是项目群助手。' };
      const saved = saveDesktopSettings(directory, { ...valid(), persona: '劳大', initialInstruction: custom.content,
        selectedInstructionTemplateId: custom.id, instructionTemplates: [custom] });
      expect(saved.instructionTemplates).toEqual([DEFAULT_INSTRUCTION_TEMPLATE, custom]);
      expect(readDesktopSettings(directory)).toMatchObject({ initialInstruction: custom.content,
        selectedInstructionTemplateId: custom.id, instructionTemplates: [DEFAULT_INSTRUCTION_TEMPLATE, custom] });
      expect(() => parseDesktopSettings({ ...valid(), instructionTemplates: [{ ...custom, name: DEFAULT_INSTRUCTION_TEMPLATE.name }] })).toThrow('不能重复');
      expect(() => parseDesktopSettings({ ...valid(), initialInstruction: 'x'.repeat(16001) })).toThrow();
      expect(() => parseDesktopSettings({ ...valid(), selectedInstructionTemplateId: 'missing' })).toThrow('不存在');
    } finally { await service.action('close'); }
  });
});
