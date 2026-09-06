import { WSClient, type WsFrame } from '@wecom/aibot-node-sdk';
import type { Logger } from 'pino';
import { sdkLogger } from '../utils/logger.js';

export class WeComClient {
  readonly raw: WSClient;
  connected = false;

  constructor(botId: string, secret: string, logger: Logger) {
    this.raw = new WSClient({ botId, secret, maxReconnectAttempts: -1, logger: sdkLogger(logger) });
    this.raw.on('authenticated', () => {
      this.connected = true;
      logger.info({ component: 'wecom', event: 'authenticated' }, '企业微信认证成功');
    });
    this.raw.on('disconnected', (reason) => {
      this.connected = false;
      logger.warn({ component: 'wecom', event: 'disconnected', reason }, '企业微信连接断开');
    });
    this.raw.on('reconnecting', (attempt) => {
      logger.info({ component: 'wecom', event: 'reconnecting', attempt }, '企业微信正在重连');
    });
    this.raw.on('error', (error) => {
      logger.error({ component: 'wecom', event: 'error', error }, '企业微信连接错误');
    });
  }

  onText(handler: (frame: WsFrame) => Promise<void>): void {
    this.raw.on('message.text', (frame) => void handler(frame));
  }

  onEnterChat(handler: (frame: WsFrame) => Promise<void>): void {
    this.raw.on('event.enter_chat', (frame) => void handler(frame));
  }

  connect(): void { this.raw.connect(); }
  disconnect(): void { this.connected = false; this.raw.disconnect(); }
}
