import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestStop, startStopControl } from '../src/utils/stop-control.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); });

async function fixture() {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-control-test-'));
  cleanups.push(() => fs.rm(folder, { recursive: true, force: true }));
  const file = path.join(folder, 'bot.sqlite');
  const shutdown = vi.fn();
  const control = await startStopControl(file, shutdown);
  cleanups.push(() => control.close());
  return { file, shutdown, control };
}

describe('project local stop control', () => {
  it('authenticates a stop request and removes its metadata on close', async () => {
    const f = await fixture();
    expect(await requestStop(f.file)).toBe(process.pid);
    await vi.waitFor(() => expect(f.shutdown).toHaveBeenCalledOnce());
    await f.control.close();
    await f.control.close();
    await expect(fs.stat(`${f.file}.control.json`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a wrong token without stopping the instance', async () => {
    const f = await fixture();
    const original = await fs.readFile(`${f.file}.control.json`, 'utf8');
    const record = JSON.parse(original);
    record.token = '0'.repeat(64);
    await fs.writeFile(`${f.file}.control.json`, JSON.stringify(record));
    await expect(requestStop(f.file)).rejects.toThrow('拒绝');
    expect(f.shutdown).not.toHaveBeenCalled();
    await fs.writeFile(`${f.file}.control.json`, original);
  });

  it('rejects metadata pointing outside the project endpoint', async () => {
    const f = await fixture();
    const original = await fs.readFile(`${f.file}.control.json`, 'utf8');
    const record = JSON.parse(original);
    record.address = 'unrelated-endpoint';
    await fs.writeFile(`${f.file}.control.json`, JSON.stringify(record));
    await expect(requestStop(f.file)).rejects.toThrow('控制文件无效');
    expect(f.shutdown).not.toHaveBeenCalled();
    await fs.writeFile(`${f.file}.control.json`, original);
  });
});
