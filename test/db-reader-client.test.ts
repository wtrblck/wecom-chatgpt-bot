import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Logger } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WeChatDbReaderClient } from '../src/wechat/db-reader-client.js';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

type Request = { id: number; operation: string; batchId?: string };
const ready = { ready: true, conversationCount: 1, lastPollAt: null, lastError: null, pendingBatchId: null };
const message = { messageId: 'msg1', userId: 'room@chatroom', displayName: 'room', senderId: 'friend',
  text: 'hello', timestamp: 1_700_000_000_000, isSelf: false };

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly requests: Request[] = [];
  readonly stdin: Writable;
  killed = false;
  handler: (request: Request) => unknown = (request) => {
    if (request.operation === 'start' || request.operation === 'health') return ready;
    if (request.operation === 'poll') return { batchId: 'batch1', messages: [message] };
    if (request.operation === 'ack') return { acknowledged: true };
    return {};
  };
  readonly kill = vi.fn(() => { this.killed = true; return true; });

  constructor() {
    super();
    this.stdin = new Writable({ write: (chunk, _encoding, callback) => {
      const request = JSON.parse(String(chunk)) as Request;
      this.requests.push(request);
      callback();
      const result = this.handler(request);
      if (result !== undefined) queueMicrotask(() => this.respond(request.id, result));
    } });
  }

  respond(id: number, result: unknown): void {
    this.stdout.write(`${JSON.stringify({ id, ok: true, result })}\n`);
  }

  asProcess(): ChildProcessWithoutNullStreams {
    return this as unknown as ChildProcessWithoutNullStreams;
  }
}

describe('WeChat database reader subprocess protocol', () => {
  let child: FakeChild;
  let client: WeChatDbReaderClient;

  beforeEach(() => {
    spawnMock.mockReset();
    child = new FakeChild();
    spawnMock.mockReturnValue(child.asProcess());
    client = new WeChatDbReaderClient('project', 'python', [], { debug: vi.fn() } as unknown as Logger);
  });

  afterEach(async () => {
    await client.stop();
    vi.useRealTimers();
  });

  it('sends the disabled default and never requests media resolution', async () => {
    await client.start();
    expect(child.requests[0]).toMatchObject({ mediaEnabled: false });
    expect(await client.resolveMedia('room@chatroom', [])).toEqual([]);
    expect(child.requests).toHaveLength(1);
  });

  it('returns an unacknowledged batch and sends ack only when explicitly requested', async () => {
    const batch = await client.poll();
    expect(batch.messages).toEqual([message]);
    expect(child.requests.map((request) => request.operation)).toEqual(['start', 'poll']);
    await client.ack(batch.batchId!);
    expect(child.requests.at(-1)).toMatchObject({ operation: 'ack', batchId: 'batch1' });
  });

  it('waits for the same startup handshake when start is called concurrently', async () => {
    child.handler = () => undefined;
    const first = client.start();
    const second = client.start();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    child.respond(child.requests[0]!.id, ready);
    await Promise.all([first, second]);
    child.handler = () => ({});
  });

  it('rejects spawn failures without an unhandled child process error', async () => {
    child.handler = () => undefined;
    const starting = client.start();
    child.emit('error', new Error('spawn python ENOENT'));
    await expect(starting).rejects.toThrow('ENOENT');
    expect(child.kill).toHaveBeenCalled();
  });

  it('rejects pending work on exit and reconnects on the next poll', async () => {
    await client.start();
    child.handler = () => undefined;
    const polling = client.poll();
    await Promise.resolve();
    child.emit('exit', 1, null);
    await expect(polling).rejects.toThrow('已退出');
    const replacement = new FakeChild();
    spawnMock.mockReturnValue(replacement.asProcess());
    await expect(client.poll()).resolves.toMatchObject({ batchId: 'batch1' });
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('ignores an old process exit after a timeout and successful replacement', async () => {
    vi.useFakeTimers();
    await client.start();
    child.handler = () => undefined;
    const polling = client.poll();
    const failed = expect(polling).rejects.toThrow('超时');
    await vi.advanceTimersByTimeAsync(60_001);
    await failed;
    const replacement = new FakeChild();
    spawnMock.mockReturnValue(replacement.asProcess());
    await client.poll();
    child.emit('exit', 1, null);
    await expect(client.health()).resolves.toEqual(ready);
    expect(replacement.kill).not.toHaveBeenCalled();
  });

  it('handles stdin errors by rejecting outstanding requests', async () => {
    await client.start();
    child.handler = () => undefined;
    const polling = client.poll();
    await Promise.resolve();
    child.stdin.emit('error', new Error('EPIPE'));
    await expect(polling).rejects.toThrow('EPIPE');
  });

  it('ignores diagnostic and null output without breaking a protocol request', async () => {
    child.handler = (request) => {
      child.stdout.write('vendor diagnostic\nnull\n');
      return request.operation === 'start' ? ready : { batchId: null, messages: [] };
    };
    await expect(client.poll()).resolves.toEqual({ batchId: null, messages: [] });
  });

  it('rejects a batch with messages but no acknowledgement token', async () => {
    await client.start();
    child.handler = () => ({ batchId: null, messages: [message] });
    await expect(client.poll()).rejects.toThrow('无效批次');
  });

  it('rejects malformed messages instead of acknowledging a partially parsed batch', async () => {
    await client.start();
    child.handler = () => ({ batchId: 'batch1', messages: [message, { text: 'missing identity' }] });
    await expect(client.poll()).rejects.toThrow('无效批次');
    expect(child.requests.some((request) => request.operation === 'ack')).toBe(false);
  });

  it('requires an explicit persisted acknowledgement from the subprocess', async () => {
    await client.poll();
    child.handler = () => ({});
    await expect(client.ack('batch1')).rejects.toThrow('持久化');
  });
});
