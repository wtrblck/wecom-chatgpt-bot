import type { Logger } from 'pino';
import { HELP_TEXT, parseCommand } from '../commands/commands.js';
import { ChatGPTBrowser } from '../chatgpt/browser.js';
import { ChatGPTDOMChangedError, ChatGPTGenerationStoppedError, ChatGPTLoginRequiredError, ChatGPTSendUncertainError } from '../chatgpt/errors.js';
import { ConversationManager } from '../conversation/manager.js';
import { GlobalTaskQueue } from '../conversation/queue.js';
import { Repository } from '../conversation/repository.js';
import { BrowserState } from '../types/index.js';
import { conversationIdFromUrl } from '../utils/text.js';
import type { IncomingMessage, TaskRecord } from '../types/index.js';
import type { ReplySession } from './contracts.js';
import type { ChannelHealthProvider, ChannelPolicy, RoutedMessage } from './contracts.js';
import { applyReplyFormat, buildConversationInstructions, type ConversationStyle, type ReplyFormat } from './reply-style.js';

export interface MessageRouterOptions {
  logMessageContent: boolean;
  policies?: Partial<Record<'wecom' | 'wechat', ChannelPolicy>>;
  health?: Partial<Record<'wecom' | 'wechat', ChannelHealthProvider>>;
  systemPrompt?: (message: IncomingMessage) => string | undefined;
  initialInstruction?: (message: IncomingMessage) => string | undefined;
  replyFormat?: (message: IncomingMessage) => ReplyFormat;
  conversationStyle?: (message: IncomingMessage) => ConversationStyle;
  mediaEnabled?: boolean;
  accepts?: (message: IncomingMessage) => boolean;
}

export class MessageRouter {
  private readonly deliveries = new Set<Promise<void>>();
  constructor(
    private readonly browser: ChatGPTBrowser,
    private readonly conversations: ConversationManager,
    private readonly repository: Repository,
    private readonly queue: GlobalTaskQueue,
    private readonly logger: Logger,
    private readonly options: MessageRouterOptions,
  ) {}

  async waitForDeliveries(): Promise<void> {
    await Promise.allSettled([...this.deliveries]);
  }

  newConversation(platform: 'wechat' | 'wecom', userId: string): void {
    const key = `${platform}:${userId}`;
    if (this.queue.activeUser === key || this.repository.hasUnfinishedTask(key)) {
      throw new Error('此会话仍有问题正在排队、生成或发送，请完成或停止后再新建对话');
    }
    this.conversations.reset(key);
  }

  private deliver(taskId: number, reply: ReplySession, text: string): Promise<void> {
    const deliveryStartedAt = Date.now();
    const delivery = (async () => {
      try {
        await reply.finish(text, `task:${taskId}`);
        this.repository.updateTask(taskId, 'completed');
        this.logger.info({ component: 'task', event: 'completed', task_id: taskId,
          delivery_ms: Date.now() - deliveryStartedAt }, '回答已提交到客户端');
      } catch (error) {
        this.repository.updateTask(taskId, 'failed', { error: `delivery failed: ${error instanceof Error ? error.message : String(error)}` });
        this.logger.error({ component: 'task', event: 'delivery_failed', task_id: taskId, error }, '回答已保存，发送失败；可核验 outbox 后补发');
      }
    })();
    this.deliveries.add(delivery);
    void delivery.then(() => this.deliveries.delete(delivery), () => this.deliveries.delete(delivery));
    return delivery;
  }

  async handle(context: RoutedMessage): Promise<void> {
    const { message } = context;
    this.logger.debug({
      component: 'router', event: 'message_received', platform: message.platform,
      userid: message.userId, message_id: message.messageId,
      ...(this.options.logMessageContent ? { text: message.text } : {}),
    }, '收到消息');
    if (this.repository.hasIncoming(message.platform, message.messageId)) {
      this.logger.info({ component: 'router', event: 'duplicate_ignored', platform: message.platform, message_id: message.messageId }, '忽略重复消息');
      return;
    }
    if (message.displayName) this.repository.saveContact(message.platform, message.userId, message.displayName);

    if (this.options.accepts && !this.options.accepts(message)) {
      this.repository.claimIncoming(message.platform, message.messageId);
      return;
    }

    const text = this.applyPolicy(message.platform, message.userId, message.text, message.triggerPrefixes);
    if (text === null || !text) {
      this.repository.claimIncoming(message.platform, message.messageId);
      this.logger.debug({ component: 'router', event: 'policy_filtered', platform: message.platform, userid: message.userId }, '消息被渠道策略过滤');
      return;
    }
    const normalized = { ...message, text };
    const command = parseCommand(text);
    if (command) {
      if (command !== '/retry') this.repository.claimIncoming(message.platform, message.messageId);
      this.logger.debug({ component: 'router', event: 'command_parsed', platform: message.platform, userid: message.userId, command }, '解析到指令');
      await this.handleCommand(command, { ...context, message: normalized });
      return;
    }
    await this.enqueuePrompt({ ...context, message: normalized }, text, false);
  }

  async restoreQueued(replyFor: (message: IncomingMessage) => ReplySession): Promise<void> {
    for (const { task, message } of this.repository.recoverableWechatReplies()) {
      if (this.applyPolicy(message.platform, message.userId, message.text, message.triggerPrefixes) === null || (this.options.accepts && !this.options.accepts(message))) continue;
      this.repository.updateTask(task.id, 'running');
      void this.deliver(task.id, replyFor(message), task.response!);
    }
    for (const { task, message } of this.repository.queuedWechatTasks()) {
      const allowed = this.applyPolicy(message.platform, message.userId, message.text, message.triggerPrefixes);
      if (allowed === null || (this.options.accepts && !this.options.accepts(message))) {
        this.repository.updateTask(task.id, 'cancelled', { error: 'channel policy changed' });
        continue;
      }
      await this.enqueuePrompt({ message, reply: replyFor(message) }, task.prompt, false, task);
    }
  }

  private applyPolicy(
    platform: 'wecom' | 'wechat',
    userId: string,
    text: string,
    messagePrefixes?: readonly string[],
  ): string | null {
    const policy = this.options.policies?.[platform];
    if (policy?.allowlist?.size && !policy.allowlist.has(userId)) return null;
    if (!policy?.requirePrefix) return text.trim();
    const trimmed = text.trim();
    const prefixes = messagePrefixes?.length
      ? messagePrefixes
      : policy.prefixes?.length ? policy.prefixes : [policy.prefix || '/gpt'];
    if (prefixes.includes('')) return trimmed;
    const matched = prefixes.find((prefix) => {
      const candidate = trimmed.slice(0, prefix.length);
      return candidate === prefix
        && (trimmed.length === prefix.length || /^\s/u.test(trimmed.slice(prefix.length)));
    });
    if (!matched) return null;
    return trimmed.slice(matched.length).trim();
  }

  private conversationKey(context: RoutedMessage): string {
    return `${context.message.platform}:${context.message.userId}`;
  }

  private async enqueuePrompt(context: RoutedMessage, prompt: string, useRetry: boolean, restored?: TaskRecord): Promise<void> {
    const { message, reply } = context;
    const enqueuedAt = restored?.created_at ?? Date.now();
    const conversationKey = this.conversationKey(context);
    const sourceMessageId = `${message.platform}:${message.messageId}`;
    const taskId = restored?.id ?? this.repository.transaction(() => {
      // These writes are one transaction: no durable dedup marker without a task.
      this.repository.claimIncoming(message.platform, message.messageId);
      if (message.platform === 'wechat') {
        this.repository.updateInboxSource(message);
        this.repository.markWechatContextSubmitted(message.userId, message.contextMessageIds ?? []);
      }
      return this.repository.createTask(sourceMessageId, conversationKey, prompt);
    });
    const style = this.options.conversationStyle?.(message) ?? {};
    const replyFormat = style.enabled === false ? {} : { ...this.options.replyFormat?.(message) };
    const instructions = buildConversationInstructions(
      this.options.systemPrompt?.(message), replyFormat, style, this.options.initialInstruction?.(message),
    );
    // Re-check the current switch when restoring persisted tasks after a restart.
    const attachmentPaths = message.platform !== 'wechat' || this.options.mediaEnabled === true
      ? message.attachments?.map(attachment => attachment.path) ?? [] : [];
    this.logger.debug({
      component: 'task', event: 'enqueued', platform: message.platform, userid: message.userId,
      message_id: message.messageId, task_id: taskId, retry: useRetry,
      ...(this.options.logMessageContent ? { prompt } : {}),
    }, '任务入队');
    const ahead = this.queue.enqueue({
      key: String(taskId),
      userid: conversationKey,
      cancel: () => this.repository.updateTask(taskId, 'cancelled'),
      run: async (signal) => {
        const startedAt = Date.now();
        let answerSaved = false;
        this.repository.updateTask(taskId, 'running');
        try {
          await reply.begin();
          const conversationUrl = this.conversations.get(conversationKey);
          await this.browser.loadConversation(conversationUrl);
          const initialize = conversationUrl === null && instructions !== null;
          if (initialize) {
            // Separate setup turn: never forward its acknowledgement to WeChat.
            const setup = await this.browser.generate(instructions, async () => {}, signal);
            this.conversations.save(conversationKey, setup.conversationUrl);
            this.logger.info({ component: 'task', event: 'conversation_initialized', task_id: taskId }, '新 GPT 对话已设置回复风格');
          }
          const result = useRetry && !initialize
            ? attachmentPaths.length
              ? await this.browser.retryLast(prompt, (text) => reply.update(text), signal, attachmentPaths)
              : await this.browser.retryLast(prompt, (text) => reply.update(text), signal)
            : attachmentPaths.length
              ? await this.browser.generate(
                  prompt,
                  (text) => reply.update(text),
                  signal,
                  attachmentPaths,
                )
              : await this.browser.generate(prompt, (text) => reply.update(text), signal);
          this.conversations.save(conversationKey, result.conversationUrl);
          const answer = applyReplyFormat(result.text, replyFormat);
          this.repository.updateTask(taskId, 'running', { response: answer });
          answerSaved = true;
          if (message.platform === 'wechat') {
            // Sending uses another worker: the browser may start the next question now.
            void this.deliver(taskId, reply, answer);
            this.logger.info({ component: 'task', event: 'answer_saved', task_id: taskId,
              generation_ms: Date.now() - startedAt, queue_wait_ms: startedAt - enqueuedAt,
              message_age_ms: Math.max(0, startedAt - message.timestamp) }, '回答已保存并进入发送队列');
            return;
          }
          await reply.finish(answer, `task:${taskId}`);
          this.repository.updateTask(taskId, 'completed', { response: answer });
          this.logger.info({
            component: 'task', event: 'completed', platform: message.platform, userid: message.userId,
            message_id: message.messageId, task_id: taskId, conversation_url: result.conversationUrl,
            duration_ms: Date.now() - startedAt,
            ...(this.options.logMessageContent ? { prompt, response: answer } : {}),
          }, '任务完成');
        } catch (error) {
          if (answerSaved) {
            this.repository.updateTask(taskId, 'failed', { error: `delivery failed: ${error instanceof Error ? error.message : String(error)}` });
            this.logger.error({ component: 'task', event: 'delivery_failed', task_id: taskId, error }, '回答已保存，发送失败；可核验 outbox 后补发');
            return;
          }
          if (error instanceof ChatGPTGenerationStoppedError || signal.aborted) {
            await this.browser.stopGeneration();
            this.repository.updateTask(taskId, 'cancelled');
            await reply.finish('⏹ 已停止生成。').catch(() => undefined);
            return;
          }
          this.repository.updateTask(taskId, 'failed', { error: error instanceof Error ? error.message : String(error) });
          await reply.finish(this.friendlyError(error)).catch(() => undefined);
          this.logger.error({ component: 'task', event: 'failed', platform: message.platform, userid: message.userId, message_id: message.messageId, task_id: taskId, error }, '任务失败');
        }
      },
    });
    if (ahead > 0 && message.platform !== 'wechat') await reply.begin(`已收到，前面还有 ${ahead} 个任务。`);
  }

  private async handleCommand(command: string, context: RoutedMessage): Promise<void> {
    const { message, reply } = context;
    const key = this.conversationKey(context);
    if (command === '/help') return reply.finish(HELP_TEXT);
    if (command === '/status') {
      const channelHealthy = await this.options.health?.[message.platform]?.().catch(() => false);
      const status = [
        'Bot: Online',
        `${message.platform === 'wechat' ? 'WeChat' : 'WeCom'}: ${channelHealthy ? 'Connected' : 'Disconnected'}`,
        `ChatGPT: ${this.browser.state === BrowserState.READY || this.browser.state === BrowserState.GENERATING ? 'Logged in' : this.browser.state}`,
        `Queue: ${this.queue.size}`,
        `Conversation: ${conversationIdFromUrl(this.conversations.get(key))}`,
      ].join('\n');
      return reply.finish(status);
    }
    if (command === '/new') {
      if (this.queue.activeUser === key) return reply.finish('当前回答仍在生成，请先使用 /stop，再使用 /new。');
      await this.queue.stopUser(key);
      this.conversations.reset(key);
      return reply.finish('✅ 已开始新的 ChatGPT 对话。');
    }
    if (command === '/stop') {
      const result = await this.queue.stopUser(key);
      if (result.running) await this.browser.stopGeneration();
      return reply.finish(result.running || result.queued > 0 ? '⏹ 已停止生成。' : '当前没有正在生成或排队的任务。');
    }
    if (command === '/retry') {
      if (this.repository.hasUnfinishedTask(key)) {
        this.repository.claimIncoming(message.platform, message.messageId);
        return reply.finish('当前会话还有问题正在排队、生成或发送，请等待完成后再重试。');
      }
      const previous = this.repository.lastTask(key);
      if (message.platform === 'wechat' && previous?.response && previous.status !== 'completed') {
        this.repository.claimIncoming(message.platform, message.messageId);
        try {
          await reply.finish(previous.response, `task:${previous.id}`);
          this.repository.updateTask(previous.id, 'completed');
        } catch (error) {
          this.logger.error({ component: 'task', event: 'redelivery_failed', task_id: previous.id, error }, '补发失败；请检查本地 outbox 状态');
        }
        return;
      }
      const prompt = this.repository.lastPrompt(key);
      if (!prompt) {
        this.repository.claimIncoming(message.platform, message.messageId);
        return reply.finish('还没有可以重试的问题。');
      }
      const source = previous ? this.repository.taskSource(previous.msgid) : undefined;
      return this.enqueuePrompt({ ...context, message: { ...message,
        attachments: source?.attachments, contextMessageIds: source?.contextMessageIds,
      } }, prompt, true);
    }
  }

  private friendlyError(error: unknown): string {
    if (error instanceof ChatGPTSendUncertainError) return '⚠️ ChatGPT 提交状态未知，未自动重发。请先在电脑上核对网页中的问题和回答。';
    if (error instanceof ChatGPTLoginRequiredError) return '⚠️ ChatGPT 当前未登录。\n\n请打开运行 Bot 的电脑，在已经启动的浏览器窗口中完成登录。';
    if (error instanceof ChatGPTDOMChangedError) return '⚠️ ChatGPT 网页结构可能发生变化，目前无法正常操作。\n\n请检查运行 Bot 的电脑。';
    return '⚠️ 本次请求处理失败，请稍后使用 /retry 重试。';
  }
}
