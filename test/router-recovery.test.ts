import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatGPTBrowser } from '../src/chatgpt/browser.js';
import { ConversationManager } from '../src/conversation/manager.js';
import { GlobalTaskQueue } from '../src/conversation/queue.js';
import { Repository } from '../src/conversation/repository.js';
import type { ReplySession } from '../src/core/contracts.js';
import { MessageRouter, type MessageRouterOptions } from '../src/core/message-router.js';
import { openDatabase } from '../src/db/sqlite.js';
import { BrowserState, type IncomingMessage, type TaskRecord } from '../src/types/index.js';
import { createLogger } from '../src/utils/logger.js';

const databases: Database.Database[] = [];
const queues: GlobalTaskQueue[] = [];
const routers: MessageRouter[] = [];

afterEach(async () => {
  for (const queue of queues.splice(0)) await queue.close();
  for (const router of routers.splice(0)) await router.waitForDeliveries();
  for (const db of databases.splice(0)) if (db.open) db.close();
});

function message(messageId = 'message-1', text = '请介绍项目', userId = 'group-a@chatroom'): IncomingMessage {
  return { platform: 'wechat', messageId, userId, displayName: '测试群', senderId: 'member-a', type: 'text', text, timestamp: 1 };
}

function session() {
  return {
    begin: vi.fn<ReplySession['begin']>().mockResolvedValue(undefined),
    update: vi.fn<ReplySession['update']>().mockResolvedValue(undefined),
    finish: vi.fn<ReplySession['finish']>().mockResolvedValue(undefined),
  };
}

function fixture(options: Partial<MessageRouterOptions> = {}) {
  // Real transactional SQLite, entirely in memory; browser and delivery are fakes.
  const db = openDatabase(':memory:');
  databases.push(db);
  const repository = new Repository(db);
  const queue = new GlobalTaskQueue();
  queues.push(queue);
  const browser = {
    state: BrowserState.READY,
    loadConversation: vi.fn().mockResolvedValue(undefined),
    generate: vi.fn().mockResolvedValue({ text: '已生成并保存的答案', conversationUrl: 'https://chatgpt.com/c/group-a' }),
    retryLast: vi.fn().mockResolvedValue({ text: '重新生成的答案', conversationUrl: 'https://chatgpt.com/c/group-a' }),
    stopGeneration: vi.fn().mockResolvedValue(true),
  };
  const router = new MessageRouter(
    browser as unknown as ChatGPTBrowser, new ConversationManager(repository), repository, queue,
    createLogger('silent'), { logMessageContent: false, ...options },
  );
  routers.push(router);
  return { db, repository, queue, browser, router };
}

async function waitForIdle(queue: GlobalTaskQueue): Promise<void> {
  await vi.waitFor(() => { expect(queue.size).toBe(0); }, { interval: 5, timeout: 2_000 });
}

describe('MessageRouter durable recovery', () => {
  it('initializes once, forwards only actual answers, and resumes with plain messages after restart', async () => {
    const f = fixture({ systemPrompt: () => '温柔俏皮' });
    f.browser.generate.mockResolvedValueOnce({ text: '已了解风格', conversationUrl: 'https://chatgpt.com/c/seeded' });
    const reply = session();
    await f.router.handle({ message: message('seed-first', '第一条消息'), reply });
    await waitForIdle(f.queue); await f.router.waitForDeliveries();
    expect(reply.finish).toHaveBeenCalledTimes(1);
    expect(reply.finish.mock.calls[0]?.[0]).toBe('已生成并保存的答案');
    expect(reply.update).not.toHaveBeenCalled();
    const restarted = new MessageRouter(f.browser as unknown as ChatGPTBrowser, new ConversationManager(f.repository),
      f.repository, f.queue, createLogger('silent'), { logMessageContent: false, systemPrompt: () => '温柔俏皮' });
    routers.push(restarted);
    await restarted.handle({ message: message('seed-second', '第二条消息'), reply: session() });
    await waitForIdle(f.queue); await restarted.waitForDeliveries();
    const sent = f.browser.generate.mock.calls.map((args: unknown[]) => args[0]);
    expect(sent).toHaveLength(3);
    expect(sent[0]).toContain('一系列聊天');
    expect(sent.slice(1)).toEqual(['第一条消息', '第二条消息']);
  });
  it('prefix plus /new resets only its conversation and initializes the next question again', async () => {
    const f = fixture({ systemPrompt: () => '简洁回答', policies: { wechat: { requirePrefix: true, prefixes: ['/gpt', '@ChatBOT'] } } });
    f.repository.saveConversation('wechat:other', 'https://chatgpt.com/c/other');
    await f.router.handle({ message: message('new-first', '/gpt 你好'), reply: session() });
    await waitForIdle(f.queue); await f.router.waitForDeliveries();
    await f.router.handle({ message: message('new-reset', '@ChatBOT /new'), reply: session() });
    expect(f.repository.getConversation('wechat:group-a@chatroom')).toBeNull();
    expect(f.repository.getConversation('wechat:other')).toBe('https://chatgpt.com/c/other');
    await f.router.handle({ message: message('new-next', '/gpt 新的问题'), reply: session() });
    await waitForIdle(f.queue); await f.router.waitForDeliveries();
    const sent = f.browser.generate.mock.calls.map((args: unknown[]) => args[0]);
    expect(sent).toHaveLength(4);
    expect(sent[2]).toContain('一系列聊天');
    expect(sent[3]).toBe('新的问题');
    f.router.newConversation('wechat', 'group-a@chatroom');
    expect(f.repository.getConversation('wechat:group-a@chatroom')).toBeNull();
  });
  it('does not submit the real question when setup fails or reset a pending conversation', async () => {
    const f = fixture({ systemPrompt: () => '简洁回答' });
    f.browser.generate.mockRejectedValueOnce(new Error('setup failed'));
    await f.router.handle({ message: message(), reply: session() });
    expect(() => f.router.newConversation('wechat', 'group-a@chatroom')).toThrow('正在排队');
    await waitForIdle(f.queue); await f.router.waitForDeliveries();
    expect(f.browser.generate).toHaveBeenCalledTimes(1);
    expect(f.repository.lastTask('wechat:group-a@chatroom')).toMatchObject({ status: 'failed', response: null });
    expect(f.repository.getConversation('wechat:group-a@chatroom')).toBeNull();
  });
  it('persists formatted answers before delivery and retries the same answer after settings change', async () => {
    const format = { prefix: '主人', suffix: '喵' };
    const f = fixture({ systemPrompt: () => '温柔俏皮', replyFormat: () => format });
    const first = session();
    first.finish.mockRejectedValue(new Error('send rejected'));
    await f.router.handle({ message: message(), reply: first });
    await waitForIdle(f.queue); await f.router.waitForDeliveries();
    const answer = '主人已生成并保存的答案喵';
    expect(f.repository.lastTask('wechat:group-a@chatroom')).toMatchObject({ response: answer, status: 'failed' });
    expect(first.finish).toHaveBeenCalledWith(answer, 'task:1');
    expect(f.browser.generate.mock.calls[0]?.[0]).toContain('温柔俏皮');
    format.prefix = '新的前缀'; format.suffix = '新的后缀';
    const retry = session();
    await f.router.handle({ message: message('retry-formatted', '/retry'), reply: retry });
    expect(retry.finish).toHaveBeenCalledWith(answer, 'task:1');
    expect(f.browser.generate).toHaveBeenCalledTimes(2);
    expect(f.browser.retryLast).not.toHaveBeenCalled();
    const help = session();
    await f.router.handle({ message: message('help-format', '/help'), reply: help });
    expect(help.finish.mock.calls[0]?.[0]).not.toContain('新的前缀');
  });
  it('starts the next ChatGPT question while WeChat sends are slow and waits for both deliveries on shutdown', async () => {
    const f = fixture();
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstSend = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const secondSend = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const firstReply = session();
    const secondReply = session();
    firstReply.finish.mockReturnValue(firstSend);
    secondReply.finish.mockReturnValue(secondSend);

    try {
      await f.router.handle({ message: message('slow-first', 'first question'), reply: firstReply });
      await f.router.handle({ message: message('slow-second', 'second question', 'group-b@chatroom'), reply: secondReply });
      await waitForIdle(f.queue);

      // Neither send has settled, but both questions have already been generated.
      expect(f.browser.generate.mock.calls.map((args: unknown[]) => args[0])).toEqual(['first question', 'second question']);
      expect(firstReply.finish).toHaveBeenCalledTimes(1);
      expect(secondReply.finish).toHaveBeenCalledTimes(1);
      expect(f.db.prepare('SELECT status FROM tasks ORDER BY id').all()).toEqual([{ status: 'running' }, { status: 'running' }]);

      await f.queue.close();
      let deliveriesFinished = false;
      const allDelivered = f.router.waitForDeliveries().then(() => { deliveriesFinished = true; });
      await Promise.resolve();
      expect(deliveriesFinished).toBe(false);

      // Completing either one alone must not release the shutdown barrier.
      releaseSecond();
      await vi.waitFor(() => {
        expect(f.repository.lastTask('wechat:group-b@chatroom')?.status).toBe('completed');
      }, { interval: 5, timeout: 2_000 });
      expect(deliveriesFinished).toBe(false);

      releaseFirst();
      await allDelivered;
      expect(deliveriesFinished).toBe(true);
      expect(f.db.prepare('SELECT status FROM tasks ORDER BY id').all()).toEqual([{ status: 'completed' }, { status: 'completed' }]);
    } finally {
      releaseFirst();
      releaseSecond();
      await f.router.waitForDeliveries();
    }
  });

  it('rolls back the incoming claim when task creation fails, allowing the same message to retry', async () => {
    const f = fixture();
    const incoming = message();
    const reply = session();
    f.db.exec(`CREATE TEMP TRIGGER reject_task BEFORE INSERT ON tasks
      BEGIN SELECT RAISE(ABORT, 'task insert rejected'); END;`);

    await expect(f.router.handle({ message: incoming, reply })).rejects.toThrow('task insert rejected');
    expect(f.repository.hasIncoming('wechat', incoming.messageId)).toBe(false);
    expect(f.db.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 0 });
    expect(f.queue.size).toBe(0);
    expect(f.browser.generate).not.toHaveBeenCalled();

    f.db.exec('DROP TRIGGER reject_task');
    await f.router.handle({ message: incoming, reply });
    await waitForIdle(f.queue);
    expect(f.repository.hasIncoming('wechat', incoming.messageId)).toBe(true);
    expect(f.repository.lastTask(`wechat:${incoming.userId}`)?.status).toBe('completed');
    expect(f.browser.generate).toHaveBeenCalledTimes(1);
  });

  it('saves the answer before delivery and does not send another error message after delivery fails', async () => {
    const f = fixture();
    const incoming = message();
    const reply = session();
    reply.finish.mockImplementation(async (content, key) => {
      const task = f.db.prepare('SELECT * FROM tasks WHERE msgid = ?').get('wechat:message-1') as TaskRecord;
      expect(task.response).toBe(content);
      expect(task.status).toBe('running');
      expect(key).toBe(`task:${task.id}`);
      throw new Error('send acknowledgement uncertain');
    });

    await f.router.handle({ message: incoming, reply });
    await waitForIdle(f.queue);
    const task = f.repository.lastTask(`wechat:${incoming.userId}`);
    expect(task).toMatchObject({ status: 'failed', response: '已生成并保存的答案', error: 'delivery failed: send acknowledgement uncertain' });
    expect(reply.finish).toHaveBeenCalledTimes(1);
    expect(f.browser.generate).toHaveBeenCalledTimes(1);
    expect(f.repository.getConversation(`wechat:${incoming.userId}`)).toBe('https://chatgpt.com/c/group-a');

    await f.router.handle({ message: incoming, reply });
    expect(reply.finish).toHaveBeenCalledTimes(1);
    expect(f.browser.generate).toHaveBeenCalledTimes(1);
  });

  it('rolls back a /retry claim if creating its new generation task fails', async () => {
    const f = fixture();
    const original = message();
    const originalTask = f.repository.createTask('wechat:message-1', `wechat:${original.userId}`, original.text);
    f.repository.updateTask(originalTask, 'failed', { error: 'generation never started' });
    const retry = message('retry-transaction', '/retry');
    f.db.exec(`CREATE TEMP TRIGGER reject_retry BEFORE INSERT ON tasks
      BEGIN SELECT RAISE(ABORT, 'retry insert rejected'); END;`);

    await expect(f.router.handle({ message: retry, reply: session() })).rejects.toThrow('retry insert rejected');
    expect(f.repository.hasIncoming('wechat', retry.messageId)).toBe(false);
    expect(f.db.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 1 });
    expect(f.browser.retryLast).not.toHaveBeenCalled();

    f.db.exec('DROP TRIGGER reject_retry');
    await f.router.handle({ message: retry, reply: session() });
    await waitForIdle(f.queue);
    expect(f.repository.hasIncoming('wechat', retry.messageId)).toBe(true);
    expect(f.browser.retryLast).toHaveBeenCalledTimes(1);
  });

  it('redelivers the stored answer on /retry using the original delivery key without invoking ChatGPT', async () => {
    const f = fixture();
    const original = message();
    const id = f.repository.createTask('wechat:message-1', `wechat:${original.userId}`, original.text);
    f.repository.updateTask(id, 'failed', { response: '重启前已保存的原答案', error: 'delivery failed' });
    const reply = session();

    await f.router.handle({ message: message('retry-1', '/retry'), reply });
    expect(reply.finish).toHaveBeenCalledExactlyOnceWith('重启前已保存的原答案', `task:${id}`);
    expect(f.browser.loadConversation).not.toHaveBeenCalled();
    expect(f.browser.generate).not.toHaveBeenCalled();
    expect(f.browser.retryLast).not.toHaveBeenCalled();
    expect(f.repository.lastTask(`wechat:${original.userId}`)).toMatchObject({ id, status: 'completed', response: '重启前已保存的原答案' });
    expect(f.db.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 1 });
  });

  it('keeps the original answer recoverable when /retry delivery is still uncertain', async () => {
    const f = fixture();
    const id = f.repository.createTask('wechat:message-1', 'wechat:group-a@chatroom', 'question');
    f.repository.updateTask(id, 'aborted', { response: '已保存的原答案' });
    const reply = session();
    reply.finish.mockRejectedValue(new Error('outbox remains uncertain'));

    await f.router.handle({ message: message('retry-1', '/retry'), reply });
    expect(reply.finish).toHaveBeenCalledExactlyOnceWith('已保存的原答案', `task:${id}`);
    expect(f.repository.lastTask('wechat:group-a@chatroom')).toMatchObject({ id, status: 'aborted', response: '已保存的原答案' });
    expect(f.browser.generate).not.toHaveBeenCalled();
    expect(f.browser.retryLast).not.toHaveBeenCalled();
  });

  it('restores durable queued messages in order even after their inbox records were acknowledged', async () => {
    const f = fixture({ policies: { wechat: { requirePrefix: true, prefix: '/gpt' } } });
    const incoming = [message('one', '/gpt 第一个问题'), message('two', '/gpt 第二个问题')];
    f.repository.saveInbox(incoming);
    const taskIds = incoming.map((item) => {
      f.repository.claimIncoming('wechat', item.messageId);
      const id = f.repository.createTask(`wechat:${item.messageId}`, `wechat:${item.userId}`, item.text.slice('/gpt '.length));
      f.repository.finishInbox(item.messageId);
      return id;
    });
    expect(f.repository.pendingInbox()).toEqual([]);
    expect(f.repository.abortInterruptedTasks()).toBe(0);
    const replies = [session(), session()];
    const replyFor = vi.fn((item: IncomingMessage) => replies[incoming.findIndex((entry) => entry.messageId === item.messageId)]!);

    await f.router.restoreQueued(replyFor);
    await waitForIdle(f.queue);
    expect(f.browser.generate.mock.calls.map((args: unknown[]) => args[0])).toEqual(['第一个问题', '第二个问题']);
    expect(replyFor).toHaveBeenCalledTimes(2);
    taskIds.forEach((id, index) => {
      expect(replies[index]!.finish).toHaveBeenCalledExactlyOnceWith('已生成并保存的答案', `task:${id}`);
    });
    expect(f.repository.queuedWechatTasks()).toEqual([]);
    expect(f.db.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 2 });
    await f.router.restoreQueued(replyFor);
    expect(f.browser.generate).toHaveBeenCalledTimes(2);
  });

  it('restores an answer saved before a crash without regenerating it and schedules it before queued questions', async () => {
    const f = fixture();
    const saved = message('saved-before-send', 'already generated question');
    const queued = message('queued-after-saved', 'next queued question');
    f.repository.saveInbox([saved, queued]);
    const savedId = f.repository.createTask(`wechat:${saved.messageId}`, `wechat:${saved.userId}`, saved.text);
    f.repository.updateTask(savedId, 'running', { response: 'answer saved before process stopped' });
    const queuedId = f.repository.createTask(`wechat:${queued.messageId}`, `wechat:${queued.userId}`, queued.text);
    expect(f.repository.abortInterruptedTasks()).toBe(1);
    const events: string[] = [];
    const savedReply = session();
    const queuedReply = session();
    savedReply.finish.mockImplementation(async () => { events.push('saved answer delivery'); });
    f.browser.generate.mockImplementation(async () => {
      events.push('next question generation');
      return { text: 'new answer', conversationUrl: 'https://chatgpt.com/c/group-a' };
    });

    await f.router.restoreQueued((item) => item.messageId === saved.messageId ? savedReply : queuedReply);
    await waitForIdle(f.queue);
    await f.router.waitForDeliveries();
    expect(savedReply.finish).toHaveBeenCalledExactlyOnceWith('answer saved before process stopped', `task:${savedId}`);
    expect(queuedReply.finish).toHaveBeenCalledExactlyOnceWith('new answer', `task:${queuedId}`);
    expect(events).toEqual(['saved answer delivery', 'next question generation']);
    expect(f.browser.generate).toHaveBeenCalledExactlyOnceWith(queued.text, expect.any(Function), expect.any(AbortSignal));
    expect(f.browser.retryLast).not.toHaveBeenCalled();
    expect(f.repository.recoverableWechatReplies()).toEqual([]);

    await f.router.restoreQueued(() => { throw new Error('completed replies must not be restored twice'); });
    expect(savedReply.finish).toHaveBeenCalledTimes(1);
  });

  it('automatically resumes safe pending delivery but leaves uncertain delivery untouched', async () => {
    const f = fixture();
    const safe = message('safe-pending');
    const uncertain = message('uncertain-delivery', 'question', 'group-b@chatroom');
    f.repository.saveInbox([safe, uncertain]);
    const safeId = f.repository.createTask(`wechat:${safe.messageId}`, `wechat:${safe.userId}`, safe.text);
    const uncertainId = f.repository.createTask(`wechat:${uncertain.messageId}`, `wechat:${uncertain.userId}`, uncertain.text);
    f.repository.updateTask(safeId, 'failed', { response: 'safe saved answer' });
    f.repository.updateTask(uncertainId, 'aborted', { response: 'possibly already sent answer' });
    f.repository.prepareDelivery(`task:${safeId}`, safe.userId, ['safe saved answer']);
    f.repository.prepareDelivery(`task:${uncertainId}`, uncertain.userId, ['possibly already sent answer']);
    f.repository.updateDelivery(`task:${uncertainId}`, 0, 'uncertain', 'process stopped after submission');
    const reply = session();
    const replyFor = vi.fn(() => reply);

    await f.router.restoreQueued(replyFor);
    await f.router.waitForDeliveries();
    expect(replyFor).toHaveBeenCalledExactlyOnceWith(safe);
    expect(reply.finish).toHaveBeenCalledExactlyOnceWith('safe saved answer', `task:${safeId}`);
    expect(f.browser.generate).not.toHaveBeenCalled();
    expect(f.browser.retryLast).not.toHaveBeenCalled();
    expect(f.repository.lastTask(`wechat:${uncertain.userId}`)).toMatchObject({ id: uncertainId, status: 'aborted', response: 'possibly already sent answer' });
    expect(f.repository.deliveryParts(`task:${uncertainId}`)[0]).toMatchObject({ status: 'uncertain', error: 'process stopped after submission' });
  });

  it.each(['queued', 'running'] as const)('does not retry an older question while a newer task is %s', async (status) => {
    const f = fixture();
    const oldId = f.repository.createTask('wechat:old', 'wechat:group-a@chatroom', 'old question');
    f.repository.updateTask(oldId, 'completed', { response: 'old answer' });
    const currentId = f.repository.createTask('wechat:current', 'wechat:group-a@chatroom', 'current question');
    if (status === 'running') f.repository.updateTask(currentId, 'running', { response: 'answer awaiting slow delivery' });
    const reply = session();

    await f.router.handle({ message: message(`retry-during-${status}`, '/retry'), reply });
    expect(reply.finish).toHaveBeenCalledExactlyOnceWith('当前会话还有问题正在排队、生成或发送，请等待完成后再重试。');
    expect(f.browser.generate).not.toHaveBeenCalled();
    expect(f.browser.retryLast).not.toHaveBeenCalled();
    expect(f.repository.hasIncoming('wechat', `retry-during-${status}`)).toBe(true);
    expect(f.db.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 2 });
  });

  it('cancels restored queued work if the group no longer passes the allowlist', async () => {
    const f = fixture({ policies: { wechat: { allowlist: new Set(['another-group@chatroom']) } } });
    const incoming = message();
    f.repository.saveInbox([incoming]);
    const id = f.repository.createTask(`wechat:${incoming.messageId}`, `wechat:${incoming.userId}`, incoming.text);
    const replyFor = vi.fn(() => session());

    await f.router.restoreQueued(replyFor);
    expect(f.repository.lastTask(`wechat:${incoming.userId}`)).toMatchObject({ id, status: 'cancelled', error: 'channel policy changed' });
    expect(replyFor).not.toHaveBeenCalled();
    expect(f.browser.generate).not.toHaveBeenCalled();
  });
});
