export interface QueueJob {
  key: string;
  userid: string;
  run: (signal: AbortSignal) => Promise<void>;
  cancel?: () => Promise<void> | void;
}

interface PendingJob extends QueueJob {
  controller: AbortController;
}

export class GlobalTaskQueue {
  private readonly pending: PendingJob[] = [];
  private current: PendingJob | null = null;
  private draining = false;
  private closed = false;
  private idleWaiters: (() => void)[] = [];

  enqueue(job: QueueJob): number {
    if (this.closed) throw new Error('任务队列已停止');
    const ahead = this.pending.length + (this.current ? 1 : 0);
    this.pending.push({ ...job, controller: new AbortController() });
    void this.drain();
    return ahead;
  }

  get size(): number {
    return this.pending.length + (this.current ? 1 : 0);
  }

  get activeUser(): string | null {
    return this.current?.userid ?? null;
  }

  async close(): Promise<void> {
    this.closed = true;
    // Queued jobs stay durable for the next start. Never start another browser job.
    this.pending.splice(0);
    this.current?.controller.abort();
    if (this.draining) await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  async stopUser(userid: string): Promise<{ running: boolean; queued: number }> {
    let queued = 0;
    for (let index = this.pending.length - 1; index >= 0; index -= 1) {
      const job = this.pending[index];
      if (job?.userid !== userid) continue;
      this.pending.splice(index, 1);
      job.controller.abort();
      await job.cancel?.();
      queued += 1;
    }
    const running = this.current?.userid === userid;
    if (running) this.current?.controller.abort();
    return { running, queued };
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (!this.closed && this.pending.length > 0) {
        const job = this.pending.shift();
        if (!job) continue;
        this.current = job;
        try {
          await job.run(job.controller.signal);
        } catch {
          // The job owns persistence, logging, and user-facing error handling.
        } finally {
          this.current = null;
        }
      }
    } finally {
      this.draining = false;
      this.idleWaiters.splice(0).forEach((resolve) => resolve());
      if (this.pending.length > 0) void this.drain();
    }
  }
}
