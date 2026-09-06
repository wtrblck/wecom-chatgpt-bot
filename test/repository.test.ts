import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/sqlite.js';
import { Repository } from '../src/conversation/repository.js';

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('Repository', () => {
  it('persists deduplication, conversations, and task state', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-bot-test-'));
    temporaryDirectories.push(directory);
    const db = openDatabase(path.join(directory, 'test.sqlite'));
    const repository = new Repository(db);
    expect(repository.claimMessage('m1')).toBe(true);
    expect(repository.claimMessage('m1')).toBe(false);
    expect(repository.claimIncoming('wechat', 'same-id')).toBe(true);
    expect(repository.hasIncoming('wechat', 'same-id')).toBe(true);
    expect(repository.claimIncoming('wechat', 'same-id')).toBe(false);
    expect(repository.claimIncoming('wecom', 'same-id')).toBe(true);
    expect(repository.hasIncoming('wechat', 'missing-id')).toBe(false);
    repository.saveConversation('u1', 'https://chatgpt.com/c/abc');
    expect(repository.getConversation('u1')).toBe('https://chatgpt.com/c/abc');
    const id = repository.createTask('m2', 'u1', 'hello');
    repository.updateTask(id, 'running');
    expect(repository.abortInterruptedTasks()).toBe(1);
    db.close();
  });
});
