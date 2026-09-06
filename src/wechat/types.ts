import type { IncomingMessage } from '../types/index.js';

export interface PersonalWeChatAdapter {
  start(): Promise<void>;
  stop(): Promise<void>;
  onMessage(callback: (message: IncomingMessage) => Promise<void>): void;
  sendText(userId: string, text: string): Promise<void>;
  healthCheck(): Promise<boolean>;
}
