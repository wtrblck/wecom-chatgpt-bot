import fs from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from 'pino';
import type { WeChatConversationConfig } from '../config/wechat-conversations.js';
import type { Repository } from '../conversation/repository.js';
import type { IncomingMessage } from '../types/index.js';
import { WeChatBridgeClient, type BridgeState } from './bridge-client.js';
import { WeChatDbReaderClient } from './db-reader-client.js';
import { OutgoingQueue } from './outgoing-queue.js';
import { extractWechatDatabaseSenderId, normalizeWechatDatabaseText, splitWechatText } from './text.js';
import type { PersonalWeChatAdapter } from './types.js';

export interface PersonalWeChatAdapterOptions {
  projectRoot: string;
  bridgePath?: string;
  pollIntervalMs: number;
  sendIntervalMs: number;
  logDirectory: string;
  requirePrefix: boolean;
  prefixes: readonly string[];
  canonicalNames: readonly string[];
  readMode: 'ocr' | 'db';
  dbPythonPath: string;
  dbConversations: readonly WeChatConversationConfig[];
}

export class WindowsPersonalWeChatAdapter implements PersonalWeChatAdapter {
  private readonly bridge: WeChatBridgeClient;
  private readonly dbReader: WeChatDbReaderClient | null;
  private readonly outgoing: OutgoingQueue;
  private callback: ((message: IncomingMessage) => Promise<void>) | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private stopped = true;
  private lastState: BridgeState | null = null;

  constructor(
    private readonly options: PersonalWeChatAdapterOptions,
    private readonly repository: Repository,
    private readonly logger: Logger,
  ) {
    this.bridge = new WeChatBridgeClient(options.projectRoot, options.bridgePath, logger);
    this.dbReader = options.readMode === 'db'
      ? new WeChatDbReaderClient(options.projectRoot, options.dbPythonPath, options.dbConversations, logger)
      : null;
    this.outgoing = new OutgoingQueue(options.sendIntervalMs);
  }

  onMessage(callback: (message: IncomingMessage) => Promise<void>): void {
    this.callback = callback;
  }

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    await fs.mkdir(this.options.logDirectory, { recursive: true });
    try {
      await this.bridge.start();
      await this.dbReader?.start();
      this.lastState = await this.bridge.health();
      this.logger.info({ component: 'wechat', event: 'started', state: this.safeState(this.lastState) }, '普通微信 Adapter 已启动');
      this.schedulePoll(0);
    } catch (error) {
      this.stopped = true;
      await this.recordFailure('start', undefined, error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.outgoing.close();
    await this.dbReader?.stop();
    await this.bridge.stop();
  }

  async sendText(userId: string, text: string): Promise<void> {
    const displayName = this.repository.getContactDisplayName('wechat', userId);
    if (!displayName) throw new Error(`找不到微信联系人映射: ${userId}`);
    for (const chunk of splitWechatText(text)) {
      await this.outgoing.enqueue(async () => {
        try {
          await this.bridge.send(displayName, chunk);
        } catch (error) {
          await this.recordFailure('send_text', userId, error);
          throw error;
        }
      });
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      this.lastState = await this.bridge.health();
      const databaseReady = this.dbReader ? (await this.dbReader.health()).ready : true;
      return databaseReady && this.lastState.processRunning && this.lastState.windowFound && this.lastState.loggedIn;
    } catch {
      return false;
    }
  }

  private schedulePoll(delayMs: number): void {
    if (this.stopped) return;
    this.pollTimer = setTimeout(() => void this.poll(), delayMs);
  }

  private async poll(): Promise<void> {
    try {
      if (this.dbReader) {
        if (!(await this.dbReader.health()).ready) return;
      } else {
        this.lastState = await this.bridge.health();
        if (!this.lastState.windowFound || !this.lastState.loggedIn) return;
      }
      const messages = this.dbReader
        ? await this.dbReader.poll()
        : await this.bridge.poll(
            this.options.requirePrefix,
            this.options.prefixes,
            this.options.canonicalNames,
          );
      for (const item of messages) {
        const text = this.dbReader
          ? normalizeWechatDatabaseText(item.userId, item.text)
          : item.text;
        const senderId = this.dbReader
          ? extractWechatDatabaseSenderId(item.userId, item.text) ?? item.senderId
          : item.senderId;
        if (item.isSelf || !item.messageId || !item.userId || !text) continue;
        if (this.repository.hasIncoming('wechat', item.messageId)) continue;
        this.logger.info({
          component: 'wechat', event: 'incoming_text', user_id: item.userId, display_name: item.displayName,
          message_id: item.messageId,
        }, '收到普通微信文本消息');
        await this.callback?.({
          platform: 'wechat',
          messageId: item.messageId,
          userId: item.userId,
          displayName: item.displayName,
          senderId,
          senderDisplayName: item.senderDisplayName,
          type: 'text',
          text,
          timestamp: item.timestamp || Date.now(),
        });
      }
    } catch (error) {
      await this.bridge.start().catch(() => undefined);
      await this.dbReader?.start().catch(() => undefined);
      await this.recordFailure('poll', undefined, error);
    } finally {
      this.schedulePoll(this.options.pollIntervalMs);
    }
  }

  private async recordFailure(operation: string, targetUser: string | undefined, error: unknown): Promise<void> {
    const timestamp = new Date().toISOString();
    const entry = {
      timestamp,
      operation,
      target_user: targetUser,
      error: error instanceof Error ? error.message : String(error),
      client_state: this.safeState(this.lastState),
    };
    this.logger.error({ component: 'wechat', event: 'operation_failed', ...entry }, '普通微信 Adapter 操作失败');
    const logFile = path.join(this.options.logDirectory, 'adapter-errors.jsonl');
    await fs.appendFile(logFile, `${JSON.stringify(entry)}\n`, 'utf8').catch(() => undefined);
    const imageFile = path.join(this.options.logDirectory, `${timestamp.replace(/[:.]/g, '-')}-${operation}.png`);
    await this.bridge.snapshot(imageFile).catch(() => undefined);
  }

  private safeState(state: BridgeState | null): Record<string, unknown> {
    if (!state) return { available: false };
    return {
      process_running: state.processRunning,
      window_found: state.windowFound,
      logged_in: state.loggedIn,
      window_title: state.windowTitle,
      detail: state.detail,
    };
  }
}
