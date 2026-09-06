import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config/config.js';

const directories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  directories.splice(0).forEach((directory) => fs.rmSync(directory, { recursive: true, force: true }));
});

function configure(conversations: unknown[] = [{ name: '测试群', type: 'group', id: 'test@chatroom' }]) {
  const root = path.resolve('.cache/tests');
  fs.mkdirSync(root, { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, 'config-'));
  directories.push(directory);
  const file = path.join(directory, 'listeners.json');
  fs.writeFileSync(file, JSON.stringify({ conversations }));
  vi.stubEnv('WECHAT_CONVERSATIONS_FILE', file);
  vi.stubEnv('WECOM_ENABLED', 'false');
  vi.stubEnv('WECHAT_ENABLED', 'true');
  vi.stubEnv('WECHAT_READ_MODE', 'db');
  vi.stubEnv('WECHAT_SEND_MODE', 'uia');
  vi.stubEnv('WECOM_BOT_ID', '');
  vi.stubEnv('WECOM_BOT_SECRET', '');
  return directory;
}

describe('personal WeChat startup configuration', () => {
  it('runs without any WeCom credentials and keeps paths under project', () => {
    const root = configure();
    const config = loadConfig(root);
    expect(config.wecomEnabled).toBe(false);
    expect(config.wechatReadMode).toBe('db');
    expect(config.wechatDbConversations).toEqual(['测试群']);
    expect(config.databasePath).toBe(path.join(root, 'data/bot.sqlite'));
  });
  it('requires credentials only when WeCom is enabled', () => {
    const root = configure();
    vi.stubEnv('WECOM_ENABLED', 'true');
    expect(() => loadConfig(root)).toThrow('WECOM_BOT_ID');
  });
  it('rejects empty listeners and invalid modes instead of listening broadly', () => {
    const root = configure([]);
    expect(() => loadConfig(root)).toThrow('监听会话');
    vi.stubEnv('WECHAT_READ_MODE', 'typo');
    expect(() => loadConfig(root)).toThrow('WECHAT_READ_MODE');
  });
  it('rejects same-name destinations even when stable IDs differ', () => {
    const root = configure([{ name: '项目群', type: 'group', id: '1@chatroom' }, { name: '项目群', type: 'group', id: '2@chatroom' }]);
    expect(() => loadConfig(root)).toThrow('同名会话');
  });
});
