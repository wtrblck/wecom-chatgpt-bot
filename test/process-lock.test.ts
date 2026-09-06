import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { acquireProcessLock } from '../src/utils/process-lock.js';

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => fs.rmSync(directory, { recursive: true, force: true })));
it('excludes another bot or resend process and releases idempotently', () => {
  const root = path.resolve('.cache/tests');
  fs.mkdirSync(root, { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, 'lock-'));
  directories.push(directory);
  const database = path.join(directory, 'bot.sqlite');
  const release = acquireProcessLock(database);
  expect(() => acquireProcessLock(database)).toThrow('已经运行');
  release();
  release();
  acquireProcessLock(database)();
  expect(fs.existsSync(`${database}.lock`)).toBe(false);
});
