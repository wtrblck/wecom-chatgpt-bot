import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import type { Logger } from 'pino';
import type { WeChatConversationConfig } from '../config/wechat-conversations.js';
import type { BridgeIncomingMessage } from './bridge-client.js';

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: unknown) => void;
  timer: NodeJS.Timeout;
}

export interface WeChatDbHealth {
  ready: boolean;
  conversationCount: number;
  lastPollAt: number | null;
  lastError: string | null;
  pendingBatchId: string | null;
}

export interface WeChatDbBatch {
  batchId: string | null;
  messages: BridgeIncomingMessage[];
}

function isIncomingMessage(value: unknown): value is BridgeIncomingMessage {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return ['messageId', 'userId', 'displayName', 'text'].every((key) => (
    typeof item[key] === 'string' && (item[key] as string).trim().length > 0
  )) && typeof item.isSelf === 'boolean'
    && typeof item.timestamp === 'number' && Number.isFinite(item.timestamp) && item.timestamp > 0;
}

export interface WeChatContextMessage extends BridgeIncomingMessage {
  sortSeq: number;
}

export interface ResolvedWeChatMedia {
  messageId: string;
  senderDisplayName: string;
  attachmentPath?: string;
}

export class WeChatDbReaderClient {
  private process: ChildProcessWithoutNullStreams | null = null;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private starting: Promise<void> | null = null;

  constructor(
    private readonly projectRoot: string,
    private readonly pythonPath: string,
    private readonly conversations: readonly WeChatConversationConfig[],
    private readonly logger: Logger,
  ) {}

  async start(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.process) return;
    const starting = this.spawnReader();
    this.starting = starting;
    try {
      await starting;
    } finally {
      if (this.starting === starting) this.starting = null;
    }
  }

  private async spawnReader(): Promise<void> {
    const script = path.join(this.projectRoot, 'scripts', 'wechat-db-reader.py');
    const child = spawn(this.pythonPath, [script], {
      cwd: this.projectRoot,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' },
    });
    this.process = child;
    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      if (this.process === child) this.handleLine(line);
    });
    child.stderr.on('data', (data) => {
      this.logger.debug({
        component: 'wechat_db', event: 'stderr', detail: String(data).trim().slice(0, 500),
      }, '微信数据库读取器输出');
    });
    child.once('error', (error) => this.failProcess(child, error));
    child.stdin.on('error', (error) => this.failProcess(child, error));
    child.stdout.on('error', (error) => this.failProcess(child, error));
    child.stderr.on('error', (error) => this.failProcess(child, error));
    child.once('exit', (code, signal) => {
      lines.close();
      this.failProcess(child, new Error(`微信数据库读取器已退出，code=${code ?? 'unknown'}，signal=${signal ?? 'none'}`));
    });
    try {
      const health = await this.request<WeChatDbHealth>('start', { conversations: this.conversations }, 120_000);
      if (!health?.ready) throw new Error('微信数据库读取器启动后未就绪');
    } catch (error) {
      this.failProcess(child, error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    const child = this.process;
    if (!child) return;
    await this.request('stop', {}, 5_000).catch(() => undefined);
    this.failProcess(child, new Error('微信数据库读取器已停止'));
  }

  health(): Promise<WeChatDbHealth> {
    return this.request('health', {});
  }

  async poll(): Promise<WeChatDbBatch> {
    // A dead reader restarts at the last acknowledged cursor on the next poll.
    await this.start();
    const batch = await this.request<WeChatDbBatch>('poll', {}, 60_000);
    if (!batch || !Array.isArray(batch.messages)
        || (batch.batchId !== null && (typeof batch.batchId !== 'string' || !batch.batchId))
        || (batch.batchId === null && batch.messages.length > 0)
        || !batch.messages.every(isIncomingMessage)) {
      throw new Error('微信数据库读取器返回了无效批次');
    }
    return batch;
  }

  async ack(batchId: string): Promise<void> {
    if (!batchId) throw new Error('确认微信消息批次需要 batchId');
    const result = await this.request<{ acknowledged: boolean }>('ack', { batchId });
    if (result?.acknowledged !== true) throw new Error('微信数据库读取器没有确认批次已持久化');
  }

  private failProcess(child: ChildProcessWithoutNullStreams, error: unknown): void {
    // An older process may exit after its replacement has already started.
    if (this.process !== child) return;
    this.process = null;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    if (!child.killed) child.kill();
  }

  context(userId: string, beforeSortSeq: number, scanLimit = 100): Promise<WeChatContextMessage[]> {
    return this.request('context', { userId, beforeSortSeq, scanLimit }, 60_000);
  }

  resolveMedia(
    userId: string,
    messages: readonly Pick<WeChatContextMessage, 'messageId' | 'localId' | 'kind' | 'senderId'>[],
  ): Promise<ResolvedWeChatMedia[]> {
    return this.request('resolve_media', { userId, messages }, 60_000);
  }

  private request<T>(operation: string, payload: Record<string, unknown>, timeoutMs = 15_000): Promise<T> {
    const child = this.process;
    if (!child || child.stdin.destroyed) return Promise.reject(new Error('微信数据库读取器未启动'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.failProcess(child, new Error(`微信数据库读取操作超时: ${operation}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        child.stdin.write(`${JSON.stringify({ id, operation, ...payload })}\n`, (error) => {
          if (error) this.failProcess(child, error);
        });
      } catch (error) {
        this.failProcess(child, error);
      }
    });
  }

  private handleLine(line: string): void {
    let response: { id?: number; ok?: boolean; result?: unknown; error?: string };
    try {
      response = JSON.parse(line) as typeof response;
    } catch {
      this.logger.debug({ component: 'wechat_db', event: 'non_json_output' }, '忽略数据库读取器非协议输出');
      return;
    }
    if (!response || typeof response !== 'object' || typeof response.id !== 'number') return;
    const request = this.pending.get(response.id);
    if (!request) return;
    clearTimeout(request.timer);
    this.pending.delete(response.id);
    if (response.ok === true) request.resolve(response.result);
    else request.reject(new Error(response.error || '微信数据库读取失败'));
  }
}
