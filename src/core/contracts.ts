import type { IncomingMessage } from '../types/index.js';

export interface ReplySession {
  begin(content?: string): Promise<void>;
  update(content: string): Promise<void>;
  finish(content: string, deliveryKey?: string): Promise<void>;
}

export interface RoutedMessage {
  message: IncomingMessage;
  reply: ReplySession;
}

export interface ChannelPolicy {
  allowlist?: ReadonlySet<string>;
  requirePrefix?: boolean;
  prefix?: string;
  prefixes?: readonly string[];
}

export type ChannelHealthProvider = () => Promise<boolean>;
