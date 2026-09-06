import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import { parseCommand } from '../commands/commands.js';
import type { WeChatConversationConfig } from '../config/wechat-conversations.js';
import { resolveWechatPrefixes } from '../config/wechat-conversations.js';
import type { Repository } from '../conversation/repository.js';
import type { IncomingMessage } from '../types/index.js';
import { WeChatBridgeClient, type BridgeState } from './bridge-client.js';
import { WeChatDbReaderClient } from './db-reader-client.js';
import { OutgoingQueue } from './outgoing-queue.js';
import {
  addWechatGroupContext,
  extractWechatDatabaseSenderId,
  matchWechatPrefix,
  normalizeWechatDatabaseText,
  selectIncrementalWechatContext,
  splitWechatText,
} from './text.js';
import type { PersonalWeChatAdapter } from './types.js';

export interface PersonalWeChatAdapterOptions {
  projectRoot: string;
  bridgePath?: string;
  pollIntervalMs: number;
  sendIntervalMs: number;
  logDirectory: string;
  requirePrefix: boolean;
  prefixes: readonly string[];
  fallbackPrefixes?: readonly string[];
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
  private polling: Promise<void> | null = null;
  private receiving = true;
  private stopped = true;
  private lastState: BridgeState | null = null;
  private lastSnapshotAt = 0;
  private pollFailures = 0;

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
    this.receiving = true;
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
      await this.dbReader?.stop().catch(() => undefined);
      await this.bridge.stop().catch(() => undefined);
      throw error;
    }
  }

  async stop(): Promise<void> {
    await this.stopReceiving();
    this.stopped = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.outgoing.close();
    await this.dbReader?.stop();
    await this.bridge.stop();
  }

  async stopReceiving(): Promise<void> {
    this.receiving = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    await this.polling;
  }

  async sendText(userId: string, text: string, deliveryKey: string = randomUUID()): Promise<void> {
    const displayName = this.repository.getContactDisplayName('wechat', userId);
    if (!displayName) throw new Error(`找不到微信联系人映射: ${userId}`);
    const existing = this.repository.deliveryParts(deliveryKey);
    if (existing.some((part) => part.user_id !== userId)) throw new Error('已保存回复与目标会话不匹配');
    // Retry preserves the original addressee/mention and exact persisted chunks.
    if (!existing.length) this.repository.prepareDelivery(deliveryKey, userId, splitWechatText(text));
    // A whole answer owns the worker, so other groups cannot interleave its parts.
    await this.outgoing.enqueue(async () => {
      for (const part of this.repository.deliveryParts(deliveryKey)) {
        if (part.status === 'sent') continue;
        if (this.stopped) throw new Error('微信发送已停止');
        if (part.status === 'uncertain' || part.status === 'sending') {
          throw new Error(`发送状态未知，请先核对微信再处理 outbox: ${deliveryKey}/${part.part}`);
        }
        this.repository.updateDelivery(deliveryKey, part.part, 'sending');
        try {
          const receipt = await this.bridge.send(displayName, part.content);
          if (!receipt.verified) throw new Error('客户端未提供可验证的提交回执');
          this.repository.updateDelivery(deliveryKey, part.part, 'sent');
        } catch (error) {
          const code = (error as { code?: string } | null)?.code;
          this.repository.updateDelivery(deliveryKey, part.part, code === 'WECHAT_SEND_REJECTED' ? 'failed' : 'uncertain',
            error instanceof Error ? error.message : String(error));
          await this.recordFailure('send_text', userId, error);
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, this.options.sendIntervalMs));
      }
    });
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
    if (this.stopped || !this.receiving) return;
    this.pollTimer = setTimeout(() => {
      this.polling = this.poll().finally(() => { this.polling = null; });
    }, delayMs);
  }

  private async poll(): Promise<void> {
    try {
      await this.dispatchInbox();
      if (this.dbReader) {
        await this.dbReader.start();
      } else {
        this.lastState = await this.bridge.health();
        if (!this.lastState.windowFound || !this.lastState.loggedIn) return;
      }
      const batch = this.dbReader
        ? await this.dbReader.poll()
        : { batchId: null, messages: await this.bridge.poll(
            this.options.requirePrefix,
            this.options.prefixes,
            this.options.canonicalNames,
          ) };
      const incoming: IncomingMessage[] = [];
      for (const item of batch.messages) {
        const triggerPrefixes = resolveWechatPrefixes(
          this.options.dbConversations,
          item.userId,
          item.displayName,
          this.options.fallbackPrefixes ?? this.options.prefixes,
        );
        let text = this.dbReader
          ? normalizeWechatDatabaseText(item.userId, item.text)
          : item.text;
        const senderId = this.dbReader
          ? item.senderId ?? extractWechatDatabaseSenderId(item.userId, item.text)
          : item.senderId;
        if (item.isSelf || !item.messageId || !item.userId || !text) continue;
        const selected = this.options.dbConversations.some((chat) => chat.enabled && (
          chat.id ? chat.id === item.userId : chat.name === item.displayName
        ));
        if (!selected) continue;
        if (this.repository.hasIncoming('wechat', item.messageId)) continue;
        let contextMessageIds: string[] = [];
        let contextAttachments: Array<{ path: string; label: string }> = [];
        const mention = item.userId.endsWith('@chatroom')
          ? matchWechatPrefix(text, triggerPrefixes.filter((prefix) => prefix.startsWith('@')))
          : null;
        if (this.dbReader && mention && item.sortSeq && !parseCommand(mention.body)) {
          const history = await this.dbReader.context(item.userId, item.sortSeq);
          const unused = selectIncrementalWechatContext(
            history,
            (messageId) => this.repository.wasWechatMessageSubmitted(item.userId, messageId),
          );
          if (unused.length > 0) {
            contextMessageIds = unused.map((entry) => entry.messageId);
            const resolvedMedia = await this.dbReader.resolveMedia(
              item.userId,
              unused,
            ).catch((error: unknown) => {
              this.logger.warn({
                component: 'wechat_db', event: 'context_media_unavailable',
                error: error instanceof Error ? error.message : String(error),
              }, '群聊上下文媒体解析失败，将使用文字占位');
              return [];
            });
            const attachmentPathByMessage = new Map(
              resolvedMedia
                .filter((entry) => Boolean(entry.attachmentPath))
                .map((entry) => [entry.messageId, entry.attachmentPath!]),
            );
            const senderNameByMessage = new Map(
              resolvedMedia.map((entry) => [entry.messageId, entry.senderDisplayName]),
            );
            contextAttachments = unused
              .filter((entry) => attachmentPathByMessage.has(entry.messageId))
              .map((entry) => ({
                path: attachmentPathByMessage.get(entry.messageId)!,
                label: `${senderNameByMessage.get(entry.messageId) ?? entry.senderId ?? '未知成员'}发送的${entry.kind === 'sticker' ? '表情包' : '图片'}`,
              }));
            const attachmentNumber = new Map(
              unused.filter((entry) => attachmentPathByMessage.has(entry.messageId))
                .map((entry, index) => [entry.messageId, index + 1]),
            );
            text = addWechatGroupContext(
              text,
              triggerPrefixes,
              item.senderDisplayName ?? item.senderId ?? '提问者',
              unused.map((entry) => ({
                messageId: entry.messageId,
                speaker: senderNameByMessage.get(entry.messageId) ?? entry.senderId ?? '未知成员',
                text: attachmentNumber.has(entry.messageId)
                  ? `${entry.text}（见附件 ${attachmentNumber.get(entry.messageId)}）`
                  : entry.text,
              })),
              this.options.requirePrefix,
            );
          }
        }
        this.logger.info({
          component: 'wechat', event: 'incoming_text', user_id: item.userId, display_name: item.displayName,
          message_id: item.messageId, context_message_count: contextMessageIds.length,
        }, '收到普通微信文本消息');
        incoming.push({
          platform: 'wechat',
          messageId: item.messageId,
          userId: item.userId,
          displayName: item.displayName,
          senderId,
          senderDisplayName: item.senderDisplayName,
          type: 'text',
          text,
          timestamp: item.timestamp || Date.now(),
          triggerPrefixes,
          attachments: contextAttachments,
        });
        if (contextMessageIds.length > 0 && this.repository.wasWechatMessageSubmitted(item.userId, item.messageId)) {
          this.repository.markWechatContextSubmitted(item.userId, contextMessageIds);
        }
      }
      // Commit the complete batch before advancing the Python reader's cursor.
      this.repository.saveInbox(incoming);
      if (batch.batchId) await this.dbReader!.ack(batch.batchId);
      await this.dispatchInbox();
      this.pollFailures = 0;
    } catch (error) {
      this.pollFailures++;
      await this.bridge.start().catch(() => undefined);
      await this.dbReader?.start().catch(() => undefined);
      await this.recordFailure('poll', undefined, error);
    } finally {
      this.schedulePoll(Math.min(30_000, this.options.pollIntervalMs * 2 ** Math.min(this.pollFailures, 5)));
    }
  }

  private async dispatchInbox(): Promise<void> {
    if (!this.callback || this.stopped || !this.receiving) return;
    for (const message of this.repository.pendingInbox()) {
      if (this.stopped) break;
      await this.callback(message);
      this.repository.finishInbox(message.messageId);
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
    if (Date.now() - this.lastSnapshotAt >= 60_000) {
      this.lastSnapshotAt = Date.now();
      const imageFile = path.join(this.options.logDirectory, `${timestamp.replace(/[:.]/g, '-')}-${operation}.png`);
      await this.bridge.snapshot(imageFile).catch(() => undefined);
    }
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
