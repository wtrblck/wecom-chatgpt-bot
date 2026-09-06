import { generateReqId, type WSClient, type WsFrame } from '@wecom/aibot-node-sdk';
import { splitUtf8, takeUtf8Chunk, utf8ByteLength } from '../utils/text.js';
import { WeComSendError } from '../chatgpt/errors.js';

const STREAM_LIMIT = 19_000;
const STREAM_CONTENT_LIMIT = 18_000;
const CONTINUATION_NOTE = '\n\n（回答较长，剩余内容将继续发送）';

export class StreamReply {
  private readonly streamId = generateReqId('stream');
  private lastSent = '';
  private latest = '';
  private timer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(
    private readonly client: WSClient,
    private readonly frame: WsFrame,
    private readonly intervalMs: number,
    private readonly proactiveTarget: string,
  ) {}

  async begin(content = '正在思考…'): Promise<void> {
    await this.send(content, false);
  }

  async update(content: string): Promise<void> {
    if (this.closed || content === this.latest) return;
    this.latest = content;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush().catch(() => undefined);
    }, this.intervalMs);
  }

  async finish(content: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const [first, rest] = takeUtf8Chunk(content, STREAM_CONTENT_LIMIT);
    const streamed = rest ? first + CONTINUATION_NOTE : first;
    if (utf8ByteLength(streamed) > STREAM_LIMIT) throw new WeComSendError('流式回复超过企业微信上限');
    await this.send(streamed, true);
    if (rest) {
      for (const chunk of splitUtf8(rest, STREAM_LIMIT)) {
        await this.client.sendMessage(this.proactiveTarget, { msgtype: 'markdown', markdown: { content: chunk } });
      }
    }
  }

  private async flush(): Promise<void> {
    if (this.closed || !this.latest || this.latest === this.lastSent) return;
    const [visible, rest] = takeUtf8Chunk(this.latest, STREAM_CONTENT_LIMIT);
    await this.send(rest ? visible + CONTINUATION_NOTE : visible, false);
  }

  private async send(content: string, finish: boolean): Promise<void> {
    if (content === this.lastSent && !finish) return;
    try {
      await this.client.replyStream(this.frame, this.streamId, content, finish);
      this.lastSent = content;
    } catch (error) {
      throw new WeComSendError(error instanceof Error ? error.message : String(error));
    }
  }
}
