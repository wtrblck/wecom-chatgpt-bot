import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { Repository } from '../src/conversation/repository.js';
import { openDatabase } from '../src/db/sqlite.js';
import type { IncomingMessage, TaskRecord } from '../src/types/index.js';

const testRoot = path.resolve('.cache/tests');
const directories: string[] = [];
const databases: Database.Database[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const directory of directories.splice(0)) {
    const resolved = path.resolve(directory);
    if (!resolved.startsWith(`${testRoot}${path.sep}`)) throw new Error('Refusing cleanup outside the project test directory');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

function open(file = ':memory:') {
  const db = openDatabase(file);
  databases.push(db);
  return { db, repository: new Repository(db) };
}

function message(messageId: string, text = 'question'): IncomingMessage {
  return { platform: 'wechat', messageId, userId: 'group-a@chatroom', senderId: 'member-a', type: 'text', text, timestamp: 1 };
}

describe('Repository inbox and outbox recovery', () => {
  it('deduplicates inbox batches and retains the original payload and handled state', () => {
    const { repository } = open();
    repository.saveInbox([message('a'), message('b'), message('a', 'duplicate changed text')]);
    expect(repository.pendingInbox()).toEqual([message('a'), message('b')]);
    repository.finishInbox('a');
    repository.saveInbox([message('a', 'replayed after ack'), message('c')]);
    expect(repository.pendingInbox()).toEqual([message('b'), message('c')]);
    expect(repository.pendingInbox(1)).toEqual([message('b')]);
  });

  it('does not confuse storing an inbox record with claiming it for processing', () => {
    const { repository } = open();
    repository.saveInbox([message('a')]);
    expect(repository.hasIncoming('wechat', 'a')).toBe(false);
    expect(repository.claimIncoming('wechat', 'a')).toBe(true);
    expect(repository.claimIncoming('wechat', 'a')).toBe(false);
    expect(repository.claimIncoming('wecom', 'a')).toBe(true);
    expect(repository.pendingInbox()).toEqual([message('a')]);
    repository.finishInbox('a');
    expect(repository.pendingInbox()).toEqual([]);
  });

  it('recovers in-flight parts as uncertain without altering sent, pending, or failed parts', () => {
    const { repository } = open();
    repository.prepareDelivery('task:1', 'group-a@chatroom', ['part 1', 'part 2', 'part 3', 'part 4']);
    repository.updateDelivery('task:1', 0, 'sent');
    repository.updateDelivery('task:1', 1, 'sending');
    repository.updateDelivery('task:1', 3, 'failed', 'editor unavailable before submission');

    expect(repository.recoverDeliveries()).toBe(1);
    const parts = repository.deliveryParts('task:1');
    expect(parts.map((part) => part.status)).toEqual(['sent', 'uncertain', 'pending', 'failed']);
    expect(parts[1]?.error).toBe('process restarted during send');
    expect(parts[3]?.error).toBe('editor unavailable before submission');
    expect(repository.recoverDeliveries()).toBe(0);
    expect(repository.prepareDelivery('task:1', 'group-a@chatroom', ['part 1', 'part 2', 'part 3', 'part 4'])).toEqual(parts);
  });

  it('rejects reuse of a delivery key for another recipient or modified chunks', () => {
    const { repository } = open();
    const original = repository.prepareDelivery('task:1', 'group-a@chatroom', ['one', 'two']);
    expect(() => repository.prepareDelivery('task:1', 'group-b@chatroom', ['one', 'two'])).toThrow('发送幂等键与已保存内容不一致');
    expect(() => repository.prepareDelivery('task:1', 'group-a@chatroom', ['one changed', 'two'])).toThrow();
    expect(() => repository.prepareDelivery('task:1', 'group-a@chatroom', ['one'])).toThrow();
    expect(repository.deliveryParts('task:1')).toEqual(original);
  });

  it('preserves recoverable WeChat queued tasks and aborts interrupted or unrestorable work', () => {
    const { db, repository } = open();
    repository.saveInbox([message('queued'), message('running')]);
    const queued = repository.createTask('wechat:queued', 'wechat:group-a@chatroom', 'queued prompt');
    const running = repository.createTask('wechat:running', 'wechat:group-a@chatroom', 'running prompt');
    repository.updateTask(running, 'running', { response: 'answer saved before crash' });
    const legacy = repository.createTask('wechat:legacy-no-inbox', 'wechat:group-b@chatroom', 'legacy prompt');
    const wecom = repository.createTask('wecom:pending', 'wecom:user-a', 'wecom prompt');

    expect(repository.abortInterruptedTasks()).toBe(3);
    expect(repository.queuedWechatTasks()).toEqual([{ task: expect.objectContaining({ id: queued, status: 'queued' }), message: message('queued') }]);
    for (const id of [running, legacy, wecom]) {
      expect(db.prepare('SELECT status FROM tasks WHERE id = ?').get(id)).toEqual({ status: 'aborted' });
    }
    expect(repository.lastTask('wechat:group-a@chatroom')).toMatchObject({ id: running, response: 'answer saved before crash' });
    expect(repository.lastPrompt('wechat:group-a@chatroom')).toBe('running prompt');
    expect(repository.abortInterruptedTasks()).toBe(0);
  });

  it('keeps queued payloads and partial delivery state across closing and reopening SQLite', () => {
    fs.mkdirSync(testRoot, { recursive: true });
    const directory = fs.mkdtempSync(path.join(testRoot, 'repository-recovery-'));
    directories.push(directory);
    const file = path.join(directory, 'state.sqlite');
    const before = open(file);
    const incoming = message('persistent');
    before.repository.saveInbox([incoming]);
    before.repository.claimIncoming('wechat', incoming.messageId);
    const id = before.repository.createTask('wechat:persistent', 'wechat:group-a@chatroom', incoming.text);
    before.repository.finishInbox(incoming.messageId);
    before.repository.prepareDelivery('task:older', incoming.userId, ['sent chunk', 'unknown chunk', 'pending chunk']);
    before.repository.updateDelivery('task:older', 0, 'sent');
    before.repository.updateDelivery('task:older', 1, 'sending');
    before.db.close();

    const after = open(file);
    expect(after.repository.hasIncoming('wechat', incoming.messageId)).toBe(true);
    expect(after.repository.pendingInbox()).toEqual([]);
    expect(after.repository.abortInterruptedTasks()).toBe(0);
    const restored = after.repository.queuedWechatTasks();
    expect(restored).toHaveLength(1);
    expect(restored[0]?.task).toMatchObject({ id, status: 'queued', prompt: incoming.text } satisfies Partial<TaskRecord>);
    expect(restored[0]?.message).toEqual(incoming);
    expect(after.repository.recoverDeliveries()).toBe(1);
    expect(after.repository.deliveryParts('task:older').map((part) => part.status)).toEqual(['sent', 'uncertain', 'pending']);
  });

  it('selects saved replies with no attempted or ambiguous parts and excludes sending or uncertain replies', () => {
    const { repository } = open();
    const candidates = ['no-outbox', 'pending', 'failed', 'sent', 'sending', 'uncertain'] as const;
    const ids = new Map<string, number>();
    for (const candidate of candidates) {
      const incoming = message(candidate);
      repository.saveInbox([incoming]);
      const id = repository.createTask(`wechat:${candidate}`, 'wechat:group-a@chatroom', incoming.text);
      ids.set(candidate, id);
      repository.updateTask(id, 'aborted', { response: `saved answer ${candidate}` });
      if (candidate !== 'no-outbox') {
        repository.prepareDelivery(`task:${id}`, incoming.userId, ['first chunk', 'remaining chunk']);
        repository.updateDelivery(`task:${id}`, 0, candidate);
      }
    }

    const eligible = repository.recoverableWechatReplies();
    expect(eligible.map(({ message: incoming }) => incoming.messageId)).toEqual(['no-outbox', 'pending', 'failed', 'sent']);
    expect(eligible.map(({ task }) => task.id)).toEqual(['no-outbox', 'pending', 'failed', 'sent'].map((key) => ids.get(key)));
    expect(repository.recoverDeliveries()).toBe(1);
    expect(repository.recoverableWechatReplies().map(({ task }) => task.id)).toEqual(eligible.map(({ task }) => task.id));

    const noAnswer = message('failed-before-answer');
    repository.saveInbox([noAnswer]);
    const noAnswerId = repository.createTask('wechat:failed-before-answer', 'wechat:group-a@chatroom', noAnswer.text);
    repository.updateTask(noAnswerId, 'failed', { error: 'generation failed' });
    repository.updateTask(ids.get('no-outbox')!, 'completed');
    expect(repository.recoverableWechatReplies().map(({ message: incoming }) => incoming.messageId)).toEqual(['pending', 'failed', 'sent']);
  });

  it('checks unfinished tasks only for the requested conversation and clears after completion', () => {
    const { repository } = open();
    const id = repository.createTask('wechat:unfinished', 'wechat:group-a@chatroom', 'question');
    expect(repository.hasUnfinishedTask('wechat:group-a@chatroom')).toBe(true);
    expect(repository.hasUnfinishedTask('wechat:group-b@chatroom')).toBe(false);
    repository.updateTask(id, 'running', { response: 'answer waiting for delivery' });
    expect(repository.hasUnfinishedTask('wechat:group-a@chatroom')).toBe(true);
    repository.updateTask(id, 'completed');
    expect(repository.hasUnfinishedTask('wechat:group-a@chatroom')).toBe(false);
  });
});
