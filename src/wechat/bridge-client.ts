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
}

export interface BridgeState {
  processRunning: boolean;
  windowFound: boolean;
  loggedIn: boolean;
  windowTitle?: string;
  detail?: string;
  protocolVersion?: number;
  sendMode?: 'uia' | 'legacy';
  windowMinimized?: boolean;
  sendAction?: 'enter' | 'ctrl-enter' | 'invoke';
}

/** Local client submission evidence, not server delivery or recipient receipt. */
export interface BridgeSendReceipt {
  submitted: true;
  verified: boolean;
  transport: 'uia' | 'legacy';
  confirmation: 'composer-cleared' | 'unverified';
  action?: 'enter' | 'ctrl-enter' | 'invoke' | 'legacy-enter';
}

export class WeChatBridgeError extends Error {
  constructor(message: string, readonly code: string, readonly deliveryUnknown = false) {
    super(message);
    this.name = 'WeChatBridgeError';
  }
}

interface PendingRequest {
  operation: string;
  resolve: (value: any) => void;
  reject: (error: unknown) => void;
  timer: NodeJS.Timeout;
}

export class WeChatBridgeClient {
  private process: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<void> | null = null;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private requestTail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly projectRoot: string,
    private readonly executablePath: string | undefined,
    private readonly logger: Logger,
  ) {}

  async start(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.process) return;
    const starting = this.startProcess();
    this.starting = starting;
    try { await starting; } finally { this.starting = null; }
  }

  private async startProcess(): Promise<void> {
    const published = path.join(this.projectRoot, 'native', 'WeChatBridge', 'publish', 'WeChatBridge.exe');
    const executable = this.executablePath || published;
    if (!existsSync(executable)) throw new WeChatBridgeError(
      '未找到微信桥接程序，请先运行 npm run wechat:build', 'WECHAT_BRIDGE_UNAVAILABLE');
    // Launch the worker directly: killing a `dotnet run` parent does not stop its child.
    const child = spawn(executable, [], {
      cwd: this.projectRoot, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        DOTNET_CLI_HOME: path.join(this.projectRoot, '.dotnet-home'),
        NUGET_PACKAGES: path.join(this.projectRoot, '.nuget'),
      },
    });
    this.process = child;
    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (line) => { if (this.process === child) this.handleLine(line); });
    child.stderr.on('data', (data) => {
      this.logger.debug({ component: 'wechat_bridge', event: 'stderr', detail: String(data).trim().slice(0, 500) }, '微信桥接进程输出');
    });
    child.on('error', (error) => this.invalidate(child, error.message));
    child.stdin.on('error', (error) => this.invalidate(child, error.message));
    child.once('exit', (code) => {
      lines.close();
      this.invalidate(child, `微信桥接进程已退出，code=${code ?? 'unknown'}`);
    });
    try {
      const state = await this.request<BridgeState>('health', {}, 30_000);
      if (state.protocolVersion !== 2) {
        throw new WeChatBridgeError('微信桥接程序版本过旧，请运行 npm run wechat:build', 'WECHAT_BRIDGE_VERSION');
      }
    } catch (error) {
      this.invalidate(child, '微信桥接进程启动失败');
      throw error;
    }
  }

  async stop(): Promise<void> {
    const child = this.process;
    if (!child) return;
    await this.request('stop', {}).catch(() => undefined);
    this.invalidate(child, '微信桥接进程已停止');
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

  async send(displayName: string, text: string, options: { resumeVerifiedDraft?: boolean } = {}): Promise<BridgeSendReceipt> {
    const result = await this.request<BridgeSendReceipt>('send', {
      displayName, text, ...(options.resumeVerifiedDraft ? { resumeVerifiedDraft: true } : {}),
    });
    if (result?.submitted !== true || typeof result.verified !== 'boolean'
      || !['uia', 'legacy'].includes(result.transport)
      || !['composer-cleared', 'unverified'].includes(result.confirmation)
      || result.verified !== (result.transport === 'uia' && result.confirmation === 'composer-cleared')) {
      throw new WeChatBridgeError('微信发送回执无效，提交状态未知，请先人工核对', 'WECHAT_DELIVERY_UNKNOWN', true);
    }
    return result;
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
    const child = this.process;
    if (!child) return Promise.reject(new WeChatBridgeError('微信桥接进程未启动',
      operation === 'send' ? 'WECHAT_SEND_REJECTED' : 'WECHAT_BRIDGE_UNAVAILABLE'));
    // Start the deadline only once the native single-threaded worker can execute it.
    const result = this.requestTail.then(() => {
      if (this.process !== child) throw new WeChatBridgeError('微信桥接进程已失效，操作未提交',
        operation === 'send' ? 'WECHAT_SEND_REJECTED' : 'WECHAT_BRIDGE_UNAVAILABLE');
      const id = this.nextId++;
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          // Stop the old worker so a timed-out send cannot execute later from its queue.
          this.invalidate(child, `微信桥接操作超时: ${operation}`);
        }, timeoutMs);
        this.pending.set(id, { operation, resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ id, operation, ...payload })}\n`, (error) => {
          if (error) this.invalidate(child, error.message);
        });
      });
    });
    this.requestTail = result.catch(() => undefined);
    return result;
  }

  private invalidate(child: ChildProcessWithoutNullStreams, message: string): void {
    if (this.process !== child) return;
    this.process = null;
    child.kill();
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      const unknown = request.operation === 'send';
      request.reject(new WeChatBridgeError(message,
        unknown ? 'WECHAT_DELIVERY_UNKNOWN' : 'WECHAT_BRIDGE_UNAVAILABLE', unknown));
    }
    this.pending.clear();
  }

  private handleLine(line: string): void {
    let response: { id?: number; ok?: boolean; result?: unknown; error?: string; code?: string; deliveryUnknown?: boolean };
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
    else request.reject(new WeChatBridgeError(response.error || '微信桥接操作失败',
      response.code || 'WECHAT_BRIDGE_ERROR', response.deliveryUnknown === true));
  }
}
