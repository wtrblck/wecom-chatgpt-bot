import type { ReplySession } from '../core/contracts.js';
import type { PersonalWeChatAdapter } from './types.js';

export class WeChatReplySession implements ReplySession {
  constructor(
    private readonly adapter: PersonalWeChatAdapter,
    private readonly userId: string,
    private readonly mentionName?: string,
  ) {}

  async begin(content = '正在思考…'): Promise<void> {
    // Personal WeChat has no replaceable stream message. Only queue notices are useful.
    if (content.startsWith('已收到')) await this.adapter.sendText(this.userId, this.withMention(content));
  }

  async update(_content: string): Promise<void> {}

  async finish(content: string): Promise<void> {
    await this.adapter.sendText(this.userId, this.withMention(content));
  }

  private withMention(content: string): string {
    return this.mentionName ? `@${this.mentionName} ${content}` : content;
  }
}
