import { describe, expect, it } from 'vitest';
import { GlobalTaskQueue } from '../src/conversation/queue.js';

describe('GlobalTaskQueue', () => {
  it('runs jobs globally in FIFO order', async () => {
    const queue = new GlobalTaskQueue();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstDone = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let finished!: () => void;
    const allDone = new Promise<void>((resolve) => { finished = resolve; });
    expect(queue.enqueue({ key: '1', userid: 'a', run: async () => { events.push('a:start'); await firstDone; events.push('a:end'); } })).toBe(0);
    expect(queue.enqueue({ key: '2', userid: 'b', run: async () => { events.push('b'); finished(); } })).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events).toEqual(['a:start']);
    releaseFirst();
    await allDone;
    expect(events).toEqual(['a:start', 'a:end', 'b']);
  });
});
