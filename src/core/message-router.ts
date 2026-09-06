import type { Logger } from 'pino';
import { HELP_TEXT, parseCommand } from '../commands/commands.js';
import { ChatGPTBrowser } from '../chatgpt/browser.js';
import { ChatGPTDOMChangedError, ChatGPTGenerationStoppedError, ChatGPTLoginRequiredError } from '../chatgpt/errors.js';
import { ConversationManager } from '../conversation/manager.js';
import { GlobalTaskQueue } from '../conversation/queue.js';
import { Repository } from '../conversation/repository.js';
import { BrowserState } from '../types/index.js';
import { conversationIdFromUrl } from '../utils/text.js';
import type { IncomingMessage } from '../types/index.js';
import type { ChannelHealthProvider, ChannelPolicy, RoutedMessage } from './contracts.js';

export interface MessageRouterOptions {
  logMessageContent: boolean;
  policies?: Partial<Record<'wecom' | 'wechat', ChannelPolicy>>;
  health?: Partial<Record<'wecom' | 'wechat', ChannelHealthProvider>>;
  systemPrompt?: (message: IncomingMessage) => string | undefined;
}

export function applySystemPrompt(prompt: string, systemPrompt?: string): string {
  const instruction = systemPrompt?.trim();
  if (!instruction) return prompt;
  return [
    '【管理员为此微信会话配置的系统指令】',
    instruction,
    '【用户消息】',
    prompt,
  ].join('\n\n');
}

export class MessageRouter {
  constructor(
    private readonly browser: ChatGPTBrowser,
    private readonly conversations: ConversationManager,
    private readonly repository: Repository,
    private readonly queue: GlobalTaskQueue,
    private readonly logger: Logger,
    private readonly options: MessageRouterOptions,
  ) {}

  async handle(context: RoutedMessage): Promise<void> {
    const { message } = context;
    this.logger.debug({
      component: 'router', event: 'message_received', platform: message.platform,
      userid: message.userId, message_id: message.messageId,
      ...(this.options.logMessageContent ? { text: message.text } : {}),
    }, '收到消息');
    if (!this.repository.claimIncoming(message.platform, message.messageId)) {
      this.logger.info({ component: 'router', event: 'duplicate_ignored', platform: message.platform, message_id: message.messageId }, '忽略重复消息');
      return;
    }
    if (message.displayName) this.repository.saveContact(message.platform, message.userId, message.displayName);

    const text = this.applyPolicy(message.platform, message.userId, message.text, message.triggerPrefixes);
    if (text === null || !text) {
      this.logger.debug({ component: 'router', event: 'policy_filtered', platform: message.platform, userid: message.userId }, '消息被渠道策略过滤');
      return;
    }
    const normalized = { ...message, text };
    const command = parseCommand(text);
    if (command) {
      this.logger.debug({ component: 'router', event: 'command_parsed', platform: message.platform, userid: message.userId, command }, '解析到指令');
      await this.handleCommand(command, { ...context, message: normalized });
      return;
    }
    await this.enqueuePrompt({ ...context, message: normalized }, text, false);
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

  private async enqueuePrompt(context: RoutedMessage, prompt: string, useRetry: boolean): Promise<void> {
    const { message, reply } = context;
    const conversationKey = this.conversationKey(context);
    const sourceMessageId = `${message.platform}:${message.messageId}`;
    const taskId = this.repository.createTask(sourceMessageId, conversationKey, prompt);
    const browserPrompt = applySystemPrompt(prompt, this.options.systemPrompt?.(message));
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
        this.repository.updateTask(taskId, 'running');
        try {
          await reply.begin();
          await this.browser.loadConversation(this.conversations.get(conversationKey));
          const result = useRetry
            ? await this.browser.retryLast(browserPrompt, (text) => reply.update(text), signal)
            : await this.browser.generate(
                browserPrompt,
                (text) => reply.update(text),
                signal,
                message.attachments?.map((attachment) => attachment.path) ?? [],
              );
          this.conversations.save(conversationKey, result.conversationUrl);
          await reply.finish(result.text);
          this.repository.updateTask(taskId, 'completed', { response: result.text });
          this.logger.info({
            component: 'task', event: 'completed', platform: message.platform, userid: message.userId,
            message_id: message.messageId, task_id: taskId, conversation_url: result.conversationUrl,
            duration_ms: Date.now() - startedAt,
            ...(this.options.logMessageContent ? { prompt, response: result.text } : {}),
          }, '任务完成');
        } catch (error) {
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
    if (ahead > 0) await reply.begin(`已收到，前面还有 ${ahead} 个任务。`);
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
      const prompt = this.repository.lastPrompt(key);
      if (!prompt) return reply.finish('还没有可以重试的问题。');
      return this.enqueuePrompt(context, prompt, true);
    }
  }

  private friendlyError(error: unknown): string {
    if (error instanceof ChatGPTLoginRequiredError) return '⚠️ ChatGPT 当前未登录。\n\n请打开运行 Bot 的电脑，在已经启动的浏览器窗口中完成登录。';
    if (error instanceof ChatGPTDOMChangedError) return '⚠️ ChatGPT 网页结构可能发生变化，目前无法正常操作。\n\n请检查运行 Bot 的电脑。';
    return '⚠️ 本次请求处理失败，请稍后使用 /retry 重试。';
  }
}
