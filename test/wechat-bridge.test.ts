import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import { WeChatBridgeClient } from '../src/wechat/bridge-client.js';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), existsSync: vi.fn(() => true) }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('node:fs', () => ({ existsSync: mocks.existsSync }));

function fakeWorker(protocolVersion = 2) {
  const requests: { id: number; operation: string }[] = [];
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough; stderr: PassThrough; stdin: Writable; kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => true);
  const reply = (id: number, value: Record<string, unknown>) => child.stdout.write(`${JSON.stringify({ id, ...value })}\n`);
  child.stdin = new Writable({
    write(chunk, _encoding, done) {
      const request = JSON.parse(String(chunk)) as { id: number; operation: string };
      requests.push(request);
      if (request.operation === 'health') queueMicrotask(() => reply(request.id, {
        ok: true, result: { processRunning: true, windowFound: true, loggedIn: true, protocolVersion },
      }));
      done();
    },
  });
  return { child, requests, reply };
}

const logger = { debug: vi.fn() } as unknown as Logger;
const client = () => new WeChatBridgeClient(process.cwd(), 'fake-worker.exe', logger);

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe('WeChat bridge transport', () => {
  it('rejects old binaries before allowing sends', async () => {
    const worker = fakeWorker(1);
    mocks.spawn.mockReturnValue(worker.child);
    await expect(client().start()).rejects.toMatchObject({ code: 'WECHAT_BRIDGE_VERSION' });
    expect(worker.child.kill).toHaveBeenCalledOnce();
    expect(worker.requests.map((request) => request.operation)).toEqual(['health']);
  });

  it('kills a timed-out worker, marks active delivery unknown, and never writes queued sends', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const worker = fakeWorker();
    mocks.spawn.mockReturnValue(worker.child);
    const bridge = client();
    await bridge.start();
    const active = expect(bridge.send('群 A', 'one')).rejects.toMatchObject({
      code: 'WECHAT_DELIVERY_UNKNOWN', deliveryUnknown: true,
    });
    const queued = expect(bridge.send('群 B', 'two')).rejects.toMatchObject({
      code: 'WECHAT_SEND_REJECTED', deliveryUnknown: false,
    });
    await vi.advanceTimersByTimeAsync(15_001);
    await Promise.all([active, queued]);
    expect(worker.child.kill).toHaveBeenCalledOnce();
    expect(worker.requests.map((request) => request.operation)).toEqual(['health', 'send']);
  });

  it('does not let an old process exit invalidate a restarted worker', async () => {
    const oldWorker = fakeWorker();
    const replacement = fakeWorker();
    mocks.spawn.mockReturnValueOnce(oldWorker.child).mockReturnValueOnce(replacement.child);
    const bridge = client();
    await bridge.start();
    oldWorker.child.emit('error', new Error('worker failed'));
    await bridge.start();
    oldWorker.child.emit('exit', 1);
    await expect(bridge.health()).resolves.toMatchObject({ protocolVersion: 2 });
    expect(replacement.child.kill).not.toHaveBeenCalled();
  });

  it('preserves explicit rejection versus uncertain submission and requires a receipt', async () => {
    const worker = fakeWorker();
    mocks.spawn.mockReturnValue(worker.child);
    const bridge = client();
    await bridge.start();
    const rejected = expect(bridge.send('群', 'draft')).rejects.toMatchObject({ code: 'WECHAT_SEND_REJECTED' });
    await Promise.resolve();
    worker.reply(worker.requests.at(-1)!.id, { ok: false, code: 'WECHAT_SEND_REJECTED', error: 'draft exists' });
    await rejected;
    const invalid = expect(bridge.send('群', 'unknown')).rejects.toMatchObject({ code: 'WECHAT_DELIVERY_UNKNOWN' });
    await Promise.resolve();
    worker.reply(worker.requests.at(-1)!.id, { ok: true, result: { sent: true } });
    await invalid;
    const submitted = bridge.send('群', 'ok');
    await Promise.resolve();
    worker.reply(worker.requests.at(-1)!.id, { ok: true, result: {
      submitted: true, verified: true, transport: 'uia', confirmation: 'composer-cleared',
    } });
    await expect(submitted).resolves.toMatchObject({ verified: true, transport: 'uia' });
  });

  it('only opts into an existing verified draft when the caller explicitly requests it', async () => {
    const worker = fakeWorker();
    mocks.spawn.mockReturnValue(worker.child);
    const bridge = client();
    await bridge.start();
    const receipt = { submitted: true, verified: true, transport: 'uia', confirmation: 'composer-cleared' };
    const regular = bridge.send('群', 'same text');
    await Promise.resolve();
    expect(worker.requests.at(-1)).not.toHaveProperty('resumeVerifiedDraft');
    worker.reply(worker.requests.at(-1)!.id, { ok: true, result: receipt });
    await regular;
    const resumed = bridge.send('群', 'same text', { resumeVerifiedDraft: true });
    await Promise.resolve();
    expect(worker.requests.at(-1)).toMatchObject({ resumeVerifiedDraft: true });
    worker.reply(worker.requests.at(-1)!.id, { ok: true, result: receipt });
    await resumed;
  });
});
