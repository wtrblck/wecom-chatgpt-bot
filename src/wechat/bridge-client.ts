import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { Logger } from 'pino';

export interface BridgeIncomingMessage {
  messageId: string;
  userId: string;
  displayName: string;
  senderId?: string;
  senderDisplayName?: string;
  text: string;
  timestamp: number;
  isSelf: boolean;
  sortSeq?: number;
  kind?: 'text' | 'image' | 'sticker' | 'link';
  localId?: number;
  attachmentPath?: string;
}

export interface BridgeState {
  processRunning: boolean;
  windowFound: boolean;
  loggedIn: boolean;
  windowTitle?: string;
  detail?: string;
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: unknown) => void;
  timer: NodeJS.Timeout;
}

export class WeChatBridgeClient {
  private process: ChildProcessWithoutNullStreams | null = null;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;

  constructor(
    private readonly projectRoot: string,
    private readonly executablePath: string | undefined,
    private readonly logger: Logger,
  ) {}

  async start(): Promise<void> {
    if (this.process) return;
    const candidates = ['publish-v24', 'publish-v23', 'publish-v22', 'publish-v21', 'publish-v20', 'publish-v19', 'publish-v18', 'publish-v17', 'publish-v16', 'publish-v15', 'publish-v14', 'publish-v13', 'publish-v12', 'publish-v11', 'publish-v10', 'publish-v9', 'publish-v8', 'publish-v7', 'publish-v6', 'publish-v5', 'publish-v4', 'publish-v3', 'publish-v2', 'publish']
      .map((directory) => path.join(this.projectRoot, 'native', 'WeChatBridge', directory, 'WeChatBridge.exe'));
    const published = candidates.find((candidate) => existsSync(candidate)) ?? candidates.at(-1)!;
    const executable = this.executablePath || (existsSync(published) ? published : undefined);
    const command = executable || 'dotnet';
    const args = executable
      ? []
      : ['run', '--project', path.join(this.projectRoot, 'native', 'WeChatBridge', 'WeChatBridge.csproj'), '--no-launch-profile'];
    this.process = spawn(command, args, { cwd: this.projectRoot, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = readline.createInterface({ input: this.process.stdout });
    lines.on('line', (line) => this.handleLine(line));
    this.process.stderr.on('data', (data) => {
      this.logger.debug({ component: 'wechat_bridge', event: 'stderr', detail: String(data).trim().slice(0, 500) }, '微信桥接进程输出');
    });
    this.process.once('exit', (code) => {
      const error = new Error(`微信桥接进程已退出，code=${code ?? 'unknown'}`);
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(error);
      }
      this.pending.clear();
      this.process = null;
    });
    await this.request<BridgeState>('health', {}, 30_000);
  }

  async stop(): Promise<void> {
    if (!this.process) return;
    await this.request('stop', {}).catch(() => undefined);
    this.process.kill();
    this.process = null;
  }

  health(): Promise<BridgeState> {
    return this.request('health', {});
  }

  poll(
    requirePrefix = false,
    prefixes: readonly string[] = [],
    canonicalNames: readonly string[] = [],
  ): Promise<BridgeIncomingMessage[]> {
    return this.request('poll', { requirePrefix, prefixes, canonicalNames }, 30_000);
  }

  send(displayName: string, text: string): Promise<void> {
    return this.request('send', { displayName, text });
  }

  select(displayName: string): Promise<void> {
    return this.request('select', { displayName });
  }

  snapshot(filePath: string): Promise<void> {
    return this.request('snapshot', { filePath });
  }

  inspect(): Promise<unknown> {
    return this.request('inspect', {});
  }

  ocrInspect(): Promise<unknown> {
    return this.request('ocr-inspect', {}, 30_000);
  }

  private request<T>(operation: string, payload: Record<string, unknown>, timeoutMs = 15_000): Promise<T> {
    if (!this.process) return Promise.reject(new Error('微信桥接进程未启动'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`微信桥接操作超时: ${operation}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.process?.stdin.write(`${JSON.stringify({ id, operation, ...payload })}\n`);
    });
  }

  private handleLine(line: string): void {
    let response: { id?: number; ok?: boolean; result?: unknown; error?: string };
    try {
      response = JSON.parse(line) as typeof response;
    } catch {
      this.logger.debug({ component: 'wechat_bridge', event: 'non_json_output', detail: line.slice(0, 500) }, '忽略桥接进程非协议输出');
      return;
    }
    if (typeof response.id !== 'number') return;
    const request = this.pending.get(response.id);
    if (!request) return;
    clearTimeout(request.timer);
    this.pending.delete(response.id);
    if (response.ok) request.resolve(response.result);
    else request.reject(new Error(response.error || '微信桥接操作失败'));
  }
}
