import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MessageRouter } from '../src/core/message-router.js';
import { ConversationManager } from '../src/conversation/manager.js';
import { GlobalTaskQueue } from '../src/conversation/queue.js';
import { Repository } from '../src/conversation/repository.js';
import { openDatabase } from '../src/db/sqlite.js';
import { createLogger } from '../src/utils/logger.js';

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => fs.rmSync(directory, { recursive: true, force: true })));

describe('MessageRouter channel policy', () => {
  it('silently ignores non-allowlisted and unprefixed messages', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'router-test-'));
    directories.push(directory);
    const db = openDatabase(path.join(directory, 'test.sqlite'));
    const repository = new Repository(db);
    const router = new MessageRouter({ state: 'READY' } as never, new ConversationManager(repository), repository, new GlobalTaskQueue(), createLogger('silent'), {
      logMessageContent: false,
      policies: { wechat: { allowlist: new Set(['allowed']), requirePrefix: true, prefixes: ['/gpt', '@ChatBOT'] } },
      health: { wechat: async () => true },
    });
    const replies: string[] = [];
    const reply = { begin: async () => {}, update: async () => {}, finish: async (text: string) => { replies.push(text); } };
    await router.handle({ message: { platform: 'wechat', messageId: '1', userId: 'blocked', type: 'text', text: '/gpt /help', timestamp: 1 }, reply });
    await router.handle({ message: { platform: 'wechat', messageId: '2', userId: 'allowed', type: 'text', text: '/help', timestamp: 2 }, reply });
    expect(replies).toEqual([]);
    await router.handle({ message: { platform: 'wechat', messageId: '3', userId: 'allowed', type: 'text', text: '/gpt /help', timestamp: 3 }, reply });
    expect(replies[0]).toContain('/status');
    await router.handle({ message: { platform: 'wechat', messageId: '4', userId: 'allowed', type: 'text', text: '@chatbot /help', timestamp: 4 }, reply });
    expect(replies[1]).toContain('/status');
    await router.handle({ message: { platform: 'wechat', messageId: '5', userId: 'allowed', type: 'text', text: '@ChatBOTfoo', timestamp: 5 }, reply });
    expect(replies).toHaveLength(2);
    db.close();
  });
});
