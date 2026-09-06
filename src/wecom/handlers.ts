import type { WsFrame } from '@wecom/aibot-node-sdk';
import type { Logger } from 'pino';
import { HELP_TEXT } from '../commands/commands.js';
import type { MessageRouter } from '../core/message-router.js';
import type { IncomingMessage } from '../types/index.js';
import { StreamReply } from './stream-reply.js';
import type { WeComClient } from './client.js';

export interface HandlerOptions {
  streamIntervalMs: number;
}

/** Keeps all enterprise-WeChat SDK frame handling inside the adapter. */
export class MessageHandlers {
  constructor(
    private readonly wecom: WeComClient,
    private readonly router: MessageRouter,
    private readonly logger: Logger,
    private readonly options: HandlerOptions,
  ) {}

  async onText(frame: WsFrame): Promise<void> {
    const message = this.extract(frame);
    if (!message) return;
    const body = frame.body as Record<string, any>;
    if (body.chattype === 'group') {
      const stream = new StreamReply(this.wecom.raw, frame, this.options.streamIntervalMs, body.chatid ?? message.userId);
      await stream.finish('当前版本暂未开放群聊。');
      return;
    }
    const reply = new StreamReply(
      this.wecom.raw,
      frame,
      this.options.streamIntervalMs,
      typeof body.chatid === 'string' ? body.chatid : message.userId,
    );
    await this.router.handle({ message, reply });
  }

  async onEnterChat(frame: WsFrame): Promise<void> {
    await this.wecom.raw.replyWelcome(frame, {
      msgtype: 'text',
      text: { content: `您好，我可以通过本机已登录的 ChatGPT 回答问题。\n\n${HELP_TEXT}` },
    }).catch((error) => this.logger.warn({ component: 'wecom', event: 'welcome_failed', error }, '欢迎语发送失败'));
  }

  private extract(frame: WsFrame): IncomingMessage | null {
    const body = frame.body as Record<string, any>;
    const content = body.text?.content;
    const messageId = String(body.msgid ?? '');
    const userId = String(body.from?.userid ?? '');
    if (typeof content !== 'string' || !messageId || !userId) return null;
    return {
      platform: 'wecom',
      messageId,
      userId,
      displayName: typeof body.from?.name === 'string' ? body.from.name : undefined,
      type: 'text',
      text: content.trim(),
      timestamp: typeof body.create_time === 'number' ? body.create_time * 1_000 : Date.now(),
    };
  }
}
