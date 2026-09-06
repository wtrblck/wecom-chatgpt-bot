import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import type { Logger } from 'pino';
import { BrowserState } from '../types/index.js';
import {
  BrowserLaunchError,
  ChatGPTDOMChangedError,
  ChatGPTGenerationStoppedError,
  ChatGPTLoginRequiredError,
  ChatGPTNavigationError,
  ChatGPTSendError,
  ChatGPTSendUncertainError,
} from './errors.js';
import {
  findAssistantMessages,
  findAuthenticatedUi,
  findConversationUi,
  findLoginControls,
  findPromptEditor,
  findRegenerateButton,
  findSendButton,
  findStopButton,
  findUserMessages,
} from './selectors.js';
import { watchResponse } from './response-watcher.js';

export interface ChatGPTBrowserOptions {
  profilePath: string;
  chatgptUrl: string;
  headless: boolean;
  timeoutMs: number;
  debugDirectory: string;
}

export class ChatGPTBrowser {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private currentConversationUrl: string | null = null;
  private closing = false;
  private starting: Promise<void> | null = null;
  private recovering: Promise<void> | null = null;
  private closingPromise: Promise<void> | null = null;
  private lastLoginDiagnosticAt = 0;
  state = BrowserState.STARTING;

  constructor(
    private readonly options: ChatGPTBrowserOptions,
    private readonly logger: Logger,
  ) {}

  async start(): Promise<void> {
    if (this.closing) throw new BrowserLaunchError('浏览器正在关闭，不能重新启动');
    if (this.starting) return this.starting;
    if (this.context && this.page) return;
    const starting = Promise.resolve().then(() => this.launch());
    this.starting = starting;
    try { await starting; } finally {
      if (this.starting === starting) this.starting = null;
    }
  }

  private async launch(): Promise<void> {
    if (this.closing) throw new BrowserLaunchError('浏览器正在关闭，不能重新启动');
    this.state = BrowserState.STARTING;
    let context: BrowserContext | null = null;
    try {
      await fs.mkdir(this.options.profilePath, { recursive: true });
      await fs.mkdir(this.options.debugDirectory, { recursive: true });
      if (this.closing) throw new BrowserLaunchError('浏览器正在关闭，不能重新启动');
      context = await chromium.launchPersistentContext(this.options.profilePath, {
        headless: this.options.headless,
        viewport: { width: 1365, height: 900 },
        args: ['--disable-blink-features=AutomationControlled'],
      });
      if (this.closing) throw new BrowserLaunchError('浏览器启动期间收到关闭请求');
      this.context = context;
      this.page = context.pages()[0] ?? (await context.newPage());
      await this.navigate(this.currentConversationUrl ?? this.options.chatgptUrl);
      await this.refreshLoginState();
      this.bindCrashRecovery();
    } catch (error) {
      this.state = BrowserState.ERROR;
      await context?.close().catch((closeError) => {
        this.logger.error({ component: 'browser', event: 'launch_cleanup_failed', error: closeError }, '浏览器启动失败后的清理失败');
      });
      if (this.context === context) {
        this.context = null;
        this.page = null;
      }
      throw new BrowserLaunchError(error instanceof Error ? error.message : String(error));
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.closingPromise) return this.closingPromise;
    this.closingPromise = (async () => {
      // A recovery may still be launching Chromium. Wait for it to either hand
      // us its context or close that context after observing `closing`.
      await this.starting?.catch(() => undefined);
      await this.recovering?.catch(() => undefined);
      const context = this.context;
      try { await context?.close(); } finally {
        this.context = null;
        this.page = null;
      }
    })();
    return this.closingPromise;
  }

  async waitForLogin(): Promise<void> {
    while (!this.closing && this.state === BrowserState.LOGIN_REQUIRED) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      await this.refreshLoginState().catch(() => undefined);
    }
  }

  async isLoggedIn(): Promise<boolean> {
    const page = this.requirePage();
    const deadline = Date.now() + 15_000;
    let loginVisibleSince: number | null = null;
    while (Date.now() < deadline) {
      if (await findPromptEditor(page).isVisible().catch(() => false)) return true;
      if (await findAuthenticatedUi(page).isVisible().catch(() => false)) return true;
      if (/auth|login|signup/i.test(page.url())) {
        await this.captureLoginDiagnostic('login-page-visible');
        return false;
      }

      const loginVisible = await findLoginControls(page).isVisible().catch(() => false);
      if (loginVisible) {
        loginVisibleSince ??= Date.now();
        // ChatGPT can briefly render logged-out controls while hydrating a logged-in
        // page. Only treat them as authoritative after they remain stable.
        if (Date.now() - loginVisibleSince >= 5_000) {
          // Re-check authenticated markers immediately before deciding. The new
          // ChatGPT shell can render stale logged-out controls during hydration.
          if (await findPromptEditor(page).isVisible().catch(() => false)) return true;
          if (await findAuthenticatedUi(page).isVisible().catch(() => false)) return true;
          await this.captureLoginDiagnostic('login-controls-visible');
          return false;
        }
      } else {
        loginVisibleSince = null;
      }
      await page.waitForTimeout(300);
    }

    const conversation = await findConversationUi(page).isVisible().catch(() => false);
    await this.captureDomError('login-state-unknown');
    throw new ChatGPTDOMChangedError(conversation
      ? 'ChatGPT 对话区域已加载，但输入框在 15 秒内未就绪'
      : '找不到输入框、登录入口或对话区域');
  }

  async loadConversation(url: string | null): Promise<void> {
    if (this.recovering) await this.recovering;
    if (this.closing) throw new BrowserLaunchError('浏览器正在关闭');
    if (!this.page) await this.start();
    const target = url ?? this.options.chatgptUrl;
    this.currentConversationUrl = url;
    const page = this.requirePage();
    // The root URL can stay unchanged for temporary chats or while a new chat
    // is being saved. Always reload it for a fresh conversation, even when the
    // address matches, so a second group cannot inherit the previous chat.
    if (url === null || page.url() !== target) await this.navigate(target);
    await this.assertReady();
    const expectedUrl = new URL(target);
    const actualUrl = new URL(page.url());
    if (actualUrl.origin !== expectedUrl.origin || actualUrl.pathname !== expectedUrl.pathname) {
      throw new ChatGPTNavigationError('ChatGPT 未打开指定会话，已停止本次发送，避免会话混用');
    }
    if (url === null && (await findUserMessages(page).count() > 0 || await findAssistantMessages(page).count() > 0)) {
      throw new ChatGPTNavigationError('ChatGPT 新会话仍含历史消息，请将 CHATGPT_URL 配置为新会话页面');
    }
  }

  async generate(
    prompt: string,
    onUpdate: (text: string) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<{ text: string; conversationUrl: string }> {
    await this.assertReady();
    const page = this.requirePage();
    this.state = BrowserState.GENERATING;
    try {
      const previousAssistantCount = await findAssistantMessages(page).count();
      const previousAssistantText = previousAssistantCount > 0
        ? (await findAssistantMessages(page).last().innerText().catch(() => '')).trim()
        : '';
      try {
        await this.sendMessage(prompt, signal);
      } catch (error) {
        if (!(await findPromptEditor(page).isVisible().catch(() => false))) {
          await this.captureDomError('prompt-editor-missing');
          throw new ChatGPTDOMChangedError('ChatGPT 输入区域不可用');
        }
        throw error;
      }
      const text = await watchResponse({
        page,
        previousAssistantCount,
        baselineText: previousAssistantText,
        timeoutMs: this.options.timeoutMs,
        signal,
        onUpdate,
      });
      const conversationUrl = page.url();
      this.currentConversationUrl = conversationUrl;
      return { text, conversationUrl };
    } catch (error) {
      await this.stopGeneration().catch(() => undefined);
      throw error;
    } finally {
      if (this.state === BrowserState.GENERATING) this.state = BrowserState.READY;
    }
  }

  async retryLast(
    fallbackPrompt: string,
    onUpdate: (text: string) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<{ text: string; conversationUrl: string }> {
    await this.assertReady();
    const page = this.requirePage();
    const regenerate = findRegenerateButton(page);
    const previousPrompt = await findUserMessages(page).last().innerText().catch(() => '');
    // A failed task may never have reached the webpage. In that case the
    // regenerate control still belongs to an older question.
    if (previousPrompt.trim() !== fallbackPrompt.trim() || !(await regenerate.isVisible().catch(() => false))) {
      return this.generate(fallbackPrompt, onUpdate, signal);
    }
    this.state = BrowserState.GENERATING;
    try {
      const assistantCount = await findAssistantMessages(page).count();
      const initialText = assistantCount > 0
        ? (await findAssistantMessages(page).last().innerText().catch(() => '')).trim()
        : '';
      if (signal?.aborted) throw new ChatGPTGenerationStoppedError('generation stopped');
      await regenerate.click();
      const text = await watchResponse({
        page,
        previousAssistantCount: assistantCount,
        baselineText: initialText,
        timeoutMs: this.options.timeoutMs,
        signal,
        onUpdate,
      });
      this.currentConversationUrl = page.url();
      return { text, conversationUrl: page.url() };
    } catch (error) {
      await this.stopGeneration().catch(() => undefined);
      throw error;
    } finally {
      if (this.state === BrowserState.GENERATING) this.state = BrowserState.READY;
    }
  }

  async stopGeneration(): Promise<boolean> {
    // State may already have changed after a generation error or cancellation.
    // The actual page control is the authority on whether generation can stop.
    if (!this.page) return false;
    const stop = findStopButton(this.page);
    if (!(await stop.isVisible().catch(() => false))) return false;
    return stop.click().then(() => true, () => false);
  }

  private async sendMessage(text: string, signal?: AbortSignal): Promise<void> {
    const page = this.requirePage();
    if (signal?.aborted) throw new ChatGPTGenerationStoppedError('generation stopped');
    const oldUserCount = await findUserMessages(page).count();
    let submissionAttempted = false;
    try {
      if (await findStopButton(page).isVisible().catch(() => false)) throw new ChatGPTSendError('上一次生成尚未结束');
      const editor = findPromptEditor(page);
      await editor.waitFor({ state: 'visible', timeout: 15_000 });
      await editor.fill(text);
      if (signal?.aborted) throw new ChatGPTGenerationStoppedError('generation stopped');
      const send = findSendButton(page);
      if (await send.isVisible().catch(() => false)) {
        submissionAttempted = true;
        await send.click();
      } else {
        submissionAttempted = true;
        await editor.press('Enter');
      }
      await page.waitForFunction(
        (count) => document.querySelectorAll('[data-message-author-role="user"]').length > count,
        oldUserCount,
        { timeout: 10_000 },
      );
    } catch (error) {
      if (error instanceof ChatGPTGenerationStoppedError) throw error;
      if (submissionAttempted) {
        throw new ChatGPTSendUncertainError('ChatGPT 提交状态无法确认，问题可能已发送；未自动重发，请检查网页后再决定是否 /retry');
      }
      throw new ChatGPTSendError(error instanceof Error ? error.message : String(error));
    }
  }

  private async refreshLoginState(): Promise<void> {
    try {
      this.state = (await this.isLoggedIn()) ? BrowserState.READY : BrowserState.LOGIN_REQUIRED;
    } catch (error) {
      this.state = BrowserState.ERROR;
      throw error;
    }
  }

  private async assertReady(): Promise<void> {
    await this.refreshLoginState();
    if (this.state === BrowserState.LOGIN_REQUIRED) throw new ChatGPTLoginRequiredError('ChatGPT 未登录');
    if (this.state !== BrowserState.READY) throw new ChatGPTDOMChangedError(`浏览器状态为 ${this.state}`);
  }

  private async navigate(url: string): Promise<void> {
    try {
      await this.requirePage().goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    } catch (error) {
      throw new ChatGPTNavigationError(error instanceof Error ? error.message : String(error));
    }
  }

  private bindCrashRecovery(): void {
    this.requirePage().on('crash', () => void this.recover('page-crash'));
    this.context?.browser()?.on('disconnected', () => {
      if (!this.closing) void this.recover('browser-disconnected');
    });
  }

  private async recover(reason: string): Promise<void> {
    if (this.closing) return;
    if (this.recovering) return this.recovering;
    const recovering = Promise.resolve().then(() => this.recoverBrowser(reason));
    this.recovering = recovering;
    try { await recovering; } finally {
      if (this.recovering === recovering) this.recovering = null;
    }
  }

  async showWindow(): Promise<void> {
    await this.start();
    await this.requirePage().bringToFront();
  }

  /** Account evidence only: an anonymous ChatGPT page can also have an editor. */
  async accountStatus(): Promise<'authenticated' | 'signed-out' | 'unknown'> {
    if (!this.page || this.page.isClosed()) return 'unknown';
    if (await findAuthenticatedUi(this.page).isVisible().catch(() => false)) return 'authenticated';
    if (/auth|login|signup/i.test(this.page.url()) || await findLoginControls(this.page).isVisible().catch(() => false)) return 'signed-out';
    return 'unknown';
  }

  private async recoverBrowser(reason: string): Promise<void> {
    if (this.closing) return;
    this.state = BrowserState.RECOVERING;
    this.logger.warn({ component: 'browser', event: reason }, '正在恢复浏览器');
    for (let attempt = 1; attempt <= 3 && !this.closing; attempt++) {
      const context = this.context;
      this.context = null;
      this.page = null;
      await context?.close().catch((error) => {
        this.logger.warn({ component: 'browser', event: 'recovery_close_failed', error }, '恢复前关闭浏览器失败');
      });
      if (this.closing) return;
      try {
        await this.start();
        return;
      } catch (error) {
        this.logger.error({ component: 'browser', event: 'recovery_failed', attempt, error }, '浏览器恢复失败');
      }
    }
    this.state = BrowserState.ERROR;
  }

  async captureDomError(label: string): Promise<void> {
    if (!this.page) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = path.join(this.options.debugDirectory, `${stamp}-${label}`);
    await Promise.allSettled([
      this.page.screenshot({ path: `${base}.png`, fullPage: true }),
      this.page.content().then((html) => fs.writeFile(`${base}.html`, html, 'utf8')),
      fs.writeFile(`${base}.url.txt`, this.page.url(), 'utf8'),
    ]);
  }

  private async captureLoginDiagnostic(label: string): Promise<void> {
    const now = Date.now();
    if (now - this.lastLoginDiagnosticAt < 60_000) return;
    this.lastLoginDiagnosticAt = now;
    await this.captureDomError(label);
  }

  private requirePage(): Page {
    if (!this.page) throw new BrowserLaunchError('浏览器页面尚未启动');
    return this.page;
  }
}
