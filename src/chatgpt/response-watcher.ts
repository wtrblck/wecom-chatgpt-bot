import type { Page } from 'playwright';
import {
  ChatGPTGenerationStoppedError,
  ChatGPTGenerationTimeoutError,
} from './errors.js';
import {
  findAssistantMessages,
  findLastAssistantMessage,
  findSendButton,
  findStopButton,
} from './selectors.js';

export function responseIsComplete(options: {
  text: string;
  stopVisible: boolean;
  sendVisible: boolean;
  stableForMs: number;
}): boolean {
  if (!options.text || options.stableForMs < 1_300) return false;
  // Thinking, web searches, and tool use can pause the visible answer for a
  // long time. A visible Stop control takes precedence over both text stability
  // and a Send control; if it never disappears, report a timeout, not success.
  return !options.stopVisible;
}

export function hasAssistantResponseStarted(options: {
  assistantCount: number;
  previousAssistantCount: number;
  text: string;
  baselineText: string;
}): boolean {
  return options.assistantCount > options.previousAssistantCount
    || Boolean(options.text && options.text !== options.baselineText);
}

export async function watchResponse(options: {
  page: Page;
  previousAssistantCount: number;
  baselineText?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  onUpdate: (text: string) => Promise<void>;
}): Promise<string> {
  const { page, previousAssistantCount, baselineText = '', timeoutMs, signal, onUpdate } = options;
  const startedAt = Date.now();
  let lastText = '';
  let lastChangedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (signal?.aborted) throw new ChatGPTGenerationStoppedError('generation stopped');
    const count = await findAssistantMessages(page).count();
    const text = count > 0
      ? (await findLastAssistantMessage(page).innerText().catch(() => '')).trim()
      : '';
    if (hasAssistantResponseStarted({
      assistantCount: count,
      previousAssistantCount,
      text,
      baselineText,
    })) {
      if (text !== lastText) {
        lastText = text;
        lastChangedAt = Date.now();
        if (text) await onUpdate(text);
      }
      const stopVisible = await findStopButton(page).isVisible().catch(() => false);
      const sendVisible = await findSendButton(page).isVisible().catch(() => false);
      if (responseIsComplete({
        text: lastText,
        stopVisible,
        sendVisible,
        stableForMs: Date.now() - lastChangedAt,
      })) return lastText;
    }
    await page.waitForTimeout(200);
  }

  throw new ChatGPTGenerationTimeoutError(`ChatGPT 在 ${timeoutMs}ms 内未完成回复`);
}
