interface OutgoingJob {
  run: () => Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

/** One deterministic worker owns every write to the WeChat window. */
export class OutgoingQueue {
  private readonly jobs: OutgoingJob[] = [];
  private running = false;
  private closed = false;
  private nextRunAt = 0;

  constructor(private readonly intervalMs: number) {}

  enqueue(run: () => Promise<void>): Promise<void> {
    if (this.closed) return Promise.reject(new Error('微信发送队列已停止'));
    return new Promise<void>((resolve, reject) => {
      this.jobs.push({ run, resolve, reject });
      void this.drain();
    });
  }

  close(): void {
    this.closed = true;
    const error = new Error('微信发送队列已停止');
    for (const job of this.jobs.splice(0)) job.reject(error);
  }

  get size(): number {
    return this.jobs.length + (this.running ? 1 : 0);
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (!this.closed && this.jobs.length > 0) {
        const delay = this.nextRunAt - Date.now();
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
        if (this.closed) break;
        const job = this.jobs.shift();
        if (!job) continue;
        try {
          await job.run();
          job.resolve();
        } catch (error) {
          job.reject(error);
        } finally {
          this.nextRunAt = Date.now() + this.intervalMs;
        }
      }
    } finally {
      this.running = false;
    }
  }
}
