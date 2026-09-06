import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
    expect(replies).toHaveLength(1);
    await router.handle({ message: { platform: 'wechat', messageId: '4b', userId: 'allowed', type: 'text', text: '@ChatBOT /help', timestamp: 4 }, reply });
    expect(replies[1]).toContain('/status');
    await router.handle({ message: { platform: 'wechat', messageId: '5', userId: 'allowed', type: 'text', text: '@ChatBOTfoo', timestamp: 5 }, reply });
    expect(replies).toHaveLength(2);
    await router.handle({ message: { platform: 'wechat', messageId: '6', userId: 'allowed', type: 'text', text: '/help', timestamp: 6, triggerPrefixes: [''] }, reply });
    expect(replies[2]).toContain('/status');
    db.close();
  });

  it('forwards context image paths to the ChatGPT browser', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'router-media-test-'));
    directories.push(directory);
    const db = openDatabase(path.join(directory, 'test.sqlite'));
    const repository = new Repository(db);
    const generate = vi.fn(async (
      _prompt: string,
      _onUpdate: (text: string) => Promise<void>,
      _signal?: AbortSignal,
      _attachmentPaths: readonly string[] = [],
    ) => ({ text: '回答', conversationUrl: 'https://chatgpt.com/c/test' }));
    const browser = {
      state: 'READY',
      loadConversation: vi.fn(async () => {}),
      generate,
    };
    const queue = new GlobalTaskQueue();
    const router = new MessageRouter(
      browser as never,
      new ConversationManager(repository),
      repository,
      queue,
      createLogger('silent'),
      { logMessageContent: false },
    );
    await router.handle({
      message: {
        platform: 'wechat', messageId: 'media-1', userId: 'group@chatroom',
        type: 'text', text: '带图上下文', timestamp: 1,
        attachments: [{ path: 'E:\\context\\image.jpg', label: '甲发送的图片' }],
      },
      reply: { begin: async () => {}, update: async () => {}, finish: async () => {} },
    });
    for (let attempt = 0; attempt < 20 && queue.size > 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(generate).toHaveBeenCalledOnce();
    expect(generate.mock.calls[0]?.[3]).toEqual(['E:\\context\\image.jpg']);
    db.close();
  });
});
