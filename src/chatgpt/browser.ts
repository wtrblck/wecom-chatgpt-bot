import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import type { Logger } from 'pino';
import { BrowserState } from '../types/index.js';
import { retry } from '../utils/retry.js';
import {
  BrowserLaunchError,
  ChatGPTDOMChangedError,
  ChatGPTGenerationStoppedError,
  ChatGPTLoginRequiredError,
  ChatGPTNavigationError,
  ChatGPTSendError,
} from './errors.js';
import {
  findAssistantMessages,
  findAttachButton,
  findAuthenticatedUi,
  findConversationUi,
  findLoginControls,
  findPromptEditor,
  findFileInput,
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
  private recoveryAttempts = 0;
  private closing = false;
  private lastLoginDiagnosticAt = 0;
  state = BrowserState.STARTING;

  constructor(
    private readonly options: ChatGPTBrowserOptions,
    private readonly logger: Logger,
  ) {}

  async start(): Promise<void> {
    this.state = BrowserState.STARTING;
    await fs.mkdir(this.options.profilePath, { recursive: true });
    await fs.mkdir(this.options.debugDirectory, { recursive: true });
    try {
      this.context = await chromium.launchPersistentContext(this.options.profilePath, {
        headless: this.options.headless,
        viewport: { width: 1365, height: 900 },
        args: ['--disable-blink-features=AutomationControlled'],
      });
      this.page = this.context.pages()[0] ?? (await this.context.newPage());
      await this.navigate(this.currentConversationUrl ?? this.options.chatgptUrl);
      await this.refreshLoginState();
      this.bindCrashRecovery();
      this.recoveryAttempts = 0;
    } catch (error) {
      this.state = BrowserState.ERROR;
      await this.context?.close().catch(() => undefined);
      this.context = null;
      this.page = null;
      throw new BrowserLaunchError(error instanceof Error ? error.message : String(error));
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.context?.close().catch(() => undefined);
    this.context = null;
    this.page = null;
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
    if (!this.page) await this.start();
    const target = url ?? this.options.chatgptUrl;
    this.currentConversationUrl = url;
    const page = this.requirePage();
    if (page.url() !== target) await this.navigate(target);
    await this.assertReady();
  }

  async generate(
    prompt: string,
    onUpdate: (text: string) => Promise<void>,
    signal?: AbortSignal,
    attachmentPaths: readonly string[] = [],
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
        await this.sendMessage(prompt, signal, attachmentPaths);
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
    if (!(await regenerate.isVisible().catch(() => false))) return this.generate(fallbackPrompt, onUpdate, signal);
    this.state = BrowserState.GENERATING;
    try {
      const assistantCount = await findAssistantMessages(page).count();
      const initialText = assistantCount > 0
        ? (await findAssistantMessages(page).last().innerText().catch(() => '')).trim()
        : '';
      await regenerate.click();
      const text = await watchResponse({
        page,
        previousAssistantCount: assistantCount,
        baselineText: initialText,
        timeoutMs: this.options.timeoutMs,
        signal,
        onUpdate,
      });
      return { text, conversationUrl: page.url() };
    } finally {
      if (this.state === BrowserState.GENERATING) this.state = BrowserState.READY;
    }
  }

  async stopGeneration(): Promise<boolean> {
    if (this.state !== BrowserState.GENERATING || !this.page) return false;
    const stop = findStopButton(this.page);
    if (!(await stop.isVisible().catch(() => false))) return false;
    await stop.click().catch(() => undefined);
    return true;
  }

  private async sendMessage(
    text: string,
    signal?: AbortSignal,
    attachmentPaths: readonly string[] = [],
  ): Promise<void> {
    const page = this.requirePage();
    if (signal?.aborted) throw new ChatGPTGenerationStoppedError('generation stopped');
    const oldUserCount = await findUserMessages(page).count();
    await this.uploadAttachments(attachmentPaths, signal);
    await retry(async () => {
      if (await findStopButton(page).isVisible().catch(() => false)) throw new ChatGPTSendError('上一次生成尚未结束');
      const editor = findPromptEditor(page);
      await editor.waitFor({ state: 'visible', timeout: 15_000 });
      await editor.fill(text);
      const send = findSendButton(page);
      if (await send.isVisible().catch(() => false)) await send.click();
      else await editor.press('Enter');
      await page.waitForFunction(
        (count) => document.querySelectorAll('[data-message-author-role="user"]').length > count,
        oldUserCount,
        { timeout: 10_000 },
      );
    }, 2, 700).catch((error) => {
      throw new ChatGPTSendError(error instanceof Error ? error.message : String(error));
    });
  }

  private async uploadAttachments(paths: readonly string[], signal?: AbortSignal): Promise<void> {
    if (paths.length === 0) return;
    if (paths.length > 10) throw new ChatGPTSendError('单次上下文图片不能超过 10 张');
    if (signal?.aborted) throw new ChatGPTGenerationStoppedError('generation stopped');
    await Promise.all(paths.map((filePath) => fs.access(filePath)));
    const page = this.requirePage();
    const input = findFileInput(page);
    if (await input.count()) {
      await input.setInputFiles([...paths]);
    } else {
      const attach = findAttachButton(page);
      await attach.waitFor({ state: 'visible', timeout: 10_000 });
      const chooserPromise = page.waitForEvent('filechooser', { timeout: 10_000 });
      await attach.click();
      const chooser = await chooserPromise;
      await chooser.setFiles([...paths]);
    }
    // Attachment previews are rendered asynchronously and image-only previews do
    // not consistently expose filenames. Wait for the draft to settle before send.
    await page.waitForTimeout(1_000);
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
    if (this.state === BrowserState.RECOVERING || this.closing) return;
    this.state = BrowserState.RECOVERING;
    this.logger.warn({ component: 'browser', event: reason }, '正在恢复浏览器');
    while (this.recoveryAttempts < 3 && !this.closing) {
      this.recoveryAttempts += 1;
      await this.context?.close().catch(() => undefined);
      this.context = null;
      this.page = null;
      try {
        await this.start();
        return;
      } catch (error) {
        this.logger.error({ component: 'browser', event: 'recovery_failed', attempt: this.recoveryAttempts, error }, '浏览器恢复失败');
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
