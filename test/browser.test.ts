import fs from 'node:fs/promises';
import type { Page } from 'playwright';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatGPTBrowser } from '../src/chatgpt/browser.js';
import { ChatGPTGenerationStoppedError, ChatGPTGenerationTimeoutError, ChatGPTNavigationError, ChatGPTSendUncertainError } from '../src/chatgpt/errors.js';
import * as selectors from '../src/chatgpt/selectors.js';
import { watchResponse } from '../src/chatgpt/response-watcher.js';
import { BrowserState } from '../src/types/index.js';
import { createLogger } from '../src/utils/logger.js';

vi.mock('../src/chatgpt/selectors.js', () => ({
  findAssistantMessages: vi.fn(), findAuthenticatedUi: vi.fn(), findConversationUi: vi.fn(),
  findLoginControls: vi.fn(), findPromptEditor: vi.fn(), findRegenerateButton: vi.fn(),
  findFileInput: vi.fn(), findAttachButton: vi.fn(),
  findSendButton: vi.fn(), findStopButton: vi.fn(), findUserMessages: vi.fn(),
}));
vi.mock('../src/chatgpt/response-watcher.js', () => ({ watchResponse: vi.fn() }));

function locator() {
  const item = {
    count: vi.fn().mockResolvedValue(0),
    innerText: vi.fn().mockResolvedValue(''),
    isVisible: vi.fn().mockResolvedValue(false),
    click: vi.fn().mockResolvedValue(undefined),
    fill: vi.fn().mockResolvedValue(undefined),
    press: vi.fn().mockResolvedValue(undefined),
    waitFor: vi.fn().mockResolvedValue(undefined),
    isEnabled: vi.fn().mockResolvedValue(true),
    setInputFiles: vi.fn().mockResolvedValue(undefined),
    last: () => item,
  };
  return item;
}

// All browser interactions are local fakes. These tests never open ChatGPT or
// send a real prompt; they exercise failure boundaries where retries are unsafe.
function fixture(initialUrl = 'https://chatgpt.com/') {
  const editor = locator();
  const users = locator();
  const assistants = locator();
  const send = locator();
  const stop = locator();
  const regenerate = locator();
  editor.isVisible.mockResolvedValue(true);
  send.isVisible.mockResolvedValue(true);
  vi.mocked(selectors.findPromptEditor).mockReturnValue(editor as never);
  vi.mocked(selectors.findUserMessages).mockReturnValue(users as never);
  vi.mocked(selectors.findAssistantMessages).mockReturnValue(assistants as never);
  vi.mocked(selectors.findSendButton).mockReturnValue(send as never);
  vi.mocked(selectors.findStopButton).mockReturnValue(stop as never);
  vi.mocked(selectors.findRegenerateButton).mockReturnValue(regenerate as never);
  let url = initialUrl;
  const page = {
    isClosed: () => false,
    url: () => url,
    goto: vi.fn(async (target: string) => { url = target; }),
    waitForFunction: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue({ previews: 1, busy: false, error: '' }),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    reload: vi.fn().mockResolvedValue(undefined),
  };
  const browser = new ChatGPTBrowser({
    profilePath: 'unused', chatgptUrl: 'https://chatgpt.com/', headless: true,
    timeoutMs: 180_000, debugDirectory: 'unused',
  }, createLogger('silent'));
  const internal = browser as unknown as {
    page: Page;
    assertReady(): Promise<void>;
    sendMessage(text: string, signal?: AbortSignal, paths?: readonly string[]): Promise<void>;
  };
  internal.page = page as unknown as Page;
  vi.spyOn(internal, 'assertReady').mockImplementation(async () => { browser.state = BrowserState.READY; });
  return { browser, internal, page, editor, users, assistants, send, stop, regenerate, setUrl: (value: string) => { url = value; } };
}

beforeEach(() => { vi.clearAllMocks(); });

describe('ChatGPT submission and conversation isolation', () => {
  it('does not report an anonymous editor as an authenticated account', async () => {
    const f = fixture();
    const account = locator(); const login = locator();
    vi.mocked(selectors.findAuthenticatedUi).mockReturnValue(account as never);
    vi.mocked(selectors.findLoginControls).mockReturnValue(login as never);
    expect(await f.browser.accountStatus()).toBe('unknown');
    login.isVisible.mockResolvedValue(true);
    expect(await f.browser.accountStatus()).toBe('signed-out');
    account.isVisible.mockResolvedValue(true);
    expect(await f.browser.accountStatus()).toBe('authenticated');
  });
  it('submits only once when the webpage acknowledgement times out', async () => {
    const f = fixture();
    f.page.waitForFunction.mockRejectedValue(new Error('acknowledgement timeout'));
    await expect(f.internal.sendMessage('question')).rejects.toBeInstanceOf(ChatGPTSendUncertainError);
    expect(f.send.click).toHaveBeenCalledTimes(1);
    expect(f.editor.fill).toHaveBeenCalledTimes(1);
    expect(f.editor.press).not.toHaveBeenCalled();
  });

  it('does not resubmit when a send click fails after it may have dispatched', async () => {
    const f = fixture();
    f.send.click.mockRejectedValue(new Error('page detached after click'));
    await expect(f.internal.sendMessage('question')).rejects.toBeInstanceOf(ChatGPTSendUncertainError);
    expect(f.send.click).toHaveBeenCalledTimes(1);
    expect(f.editor.press).not.toHaveBeenCalled();
  });

  it('honors cancellation after filling but before submitting', async () => {
    const f = fixture();
    const controller = new AbortController();
    f.editor.fill.mockImplementation(async () => { controller.abort(); });
    await expect(f.internal.sendMessage('question', controller.signal)).rejects.toBeInstanceOf(ChatGPTGenerationStoppedError);
    expect(f.send.click).not.toHaveBeenCalled();
  });

  it('reloads a new chat even when the previous chat has the same root URL', async () => {
    const f = fixture();
    await f.browser.loadConversation(null);
    expect(f.page.goto).toHaveBeenCalledTimes(1);
    expect(f.page.goto).toHaveBeenCalledWith('https://chatgpt.com/', expect.anything());
  });

  it('refuses a new-chat page that still contains the previous group history', async () => {
    const f = fixture();
    f.users.count.mockResolvedValue(1);
    await expect(f.browser.loadConversation(null)).rejects.toBeInstanceOf(ChatGPTNavigationError);
    expect(f.send.click).not.toHaveBeenCalled();
  });

  it('refuses to use a saved conversation that redirects to another page', async () => {
    const f = fixture();
    f.page.goto.mockImplementation(async () => { f.setUrl('https://chatgpt.com/'); });
    await expect(f.browser.loadConversation('https://chatgpt.com/c/group-a')).rejects.toBeInstanceOf(ChatGPTNavigationError);
    expect(f.send.click).not.toHaveBeenCalled();
  });

  it('stops an active web generation when observing the answer times out', async () => {
    const f = fixture();
    vi.spyOn(f.internal, 'sendMessage').mockResolvedValue();
    f.stop.isVisible.mockResolvedValue(true);
    vi.mocked(watchResponse).mockRejectedValue(new ChatGPTGenerationTimeoutError('timeout'));
    await expect(f.browser.generate('question', async () => {})).rejects.toBeInstanceOf(ChatGPTGenerationTimeoutError);
    expect(f.stop.click).toHaveBeenCalledTimes(1);
  });

  it('can stop the actual page even after browser state has changed', async () => {
    const f = fixture();
    f.browser.state = BrowserState.READY;
    f.stop.isVisible.mockResolvedValue(true);
    expect(await f.browser.stopGeneration()).toBe(true);
    expect(f.stop.click).toHaveBeenCalledTimes(1);
  });

  it('does not regenerate an older question when the latest task was never submitted', async () => {
    const f = fixture();
    f.users.innerText.mockResolvedValue('old question');
    f.regenerate.isVisible.mockResolvedValue(true);
    const generate = vi.spyOn(f.browser, 'generate').mockResolvedValue({ text: 'answer', conversationUrl: 'https://chatgpt.com/c/group-a' });
    await f.browser.retryLast('new question', async () => {});
    expect(generate).toHaveBeenCalledWith('new question', expect.any(Function), undefined);
    expect(f.regenerate.click).not.toHaveBeenCalled();
  });
});

afterEach(() => vi.restoreAllMocks());
describe('attachment upload boundaries', () => {
  function mediaFixture() {
    const f = fixture(); const input = locator(); input.count.mockResolvedValue(1);
    vi.mocked(selectors.findFileInput).mockReturnValue(input as never);
    vi.spyOn(fs, 'stat').mockResolvedValue({ size: 100, isFile: () => true } as never);
    return { ...f, input };
  }
  it('waits for upload progress to clear before submitting once', async () => {
    const f = mediaFixture();
    f.page.evaluate.mockResolvedValueOnce({ previews: 1, busy: true, error: '' });
    await f.internal.sendMessage('看图', undefined, ['image.png']);
    expect(f.page.evaluate).toHaveBeenCalledTimes(2);
    expect(f.send.click).toHaveBeenCalledOnce();
    expect(f.page.waitForTimeout).toHaveBeenCalledWith(250);
  });
  it('refuses partial previews and discards the draft when readiness times out', async () => {
    const f = mediaFixture();
    vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(61000);
    await expect(f.internal.sendMessage('看图', undefined, ['image.png'])).rejects.toThrow('附件上传未就绪');
    expect(f.send.click).not.toHaveBeenCalled(); expect(f.page.reload).toHaveBeenCalledOnce();
  });
  it('does not submit after an upload error or cancellation', async () => {
    const f = mediaFixture(); f.page.evaluate.mockResolvedValue({ previews: 1, busy: false, error: '上传失败' });
    await expect(f.internal.sendMessage('看图', undefined, ['image.png'])).rejects.toThrow('上传失败');
    expect(f.send.click).not.toHaveBeenCalled();
    const controller = new AbortController(); f.input.setInputFiles.mockImplementation(async () => { controller.abort(); });
    await expect(f.internal.sendMessage('看图', controller.signal, ['image.png'])).rejects.toBeInstanceOf(ChatGPTGenerationStoppedError);
    expect(f.send.click).not.toHaveBeenCalled();
  });
  it('rejects oversized or unsupported files before starting an upload', async () => {
    const f = mediaFixture(); vi.mocked(fs.stat).mockResolvedValue({ size: 21 * 1024 * 1024, isFile: () => true } as never);
    await expect(f.internal.sendMessage('看图', undefined, ['image.png'])).rejects.toThrow('20 MB');
    expect(f.input.setInputFiles).not.toHaveBeenCalled();
  });
  it('includes original files when retry falls back to submitting the question', async () => {
    const f = fixture(); const generate = vi.spyOn(f.browser, 'generate').mockResolvedValue({ text: 'answer', conversationUrl: 'https://chatgpt.com/c/test' });
    await f.browser.retryLast('看图', async () => {}, undefined, ['original.png']);
    expect(generate).toHaveBeenCalledWith('看图', expect.any(Function), undefined, ['original.png']);
  });
});
