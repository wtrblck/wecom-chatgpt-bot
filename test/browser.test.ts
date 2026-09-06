import type { Page } from 'playwright';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatGPTBrowser } from '../src/chatgpt/browser.js';
import { ChatGPTGenerationStoppedError, ChatGPTGenerationTimeoutError, ChatGPTNavigationError, ChatGPTSendUncertainError } from '../src/chatgpt/errors.js';
import * as selectors from '../src/chatgpt/selectors.js';
import { watchResponse } from '../src/chatgpt/response-watcher.js';
import { BrowserState } from '../src/types/index.js';
import { createLogger } from '../src/utils/logger.js';

vi.mock('../src/chatgpt/selectors.js', () => ({
  findAssistantMessages: vi.fn(), findAuthenticatedUi: vi.fn(), findConversationUi: vi.fn(),
  findLoginControls: vi.fn(), findPromptEditor: vi.fn(), findRegenerateButton: vi.fn(),
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
  };
  const browser = new ChatGPTBrowser({
    profilePath: 'unused', chatgptUrl: 'https://chatgpt.com/', headless: true,
    timeoutMs: 180_000, debugDirectory: 'unused',
  }, createLogger('silent'));
  const internal = browser as unknown as {
    page: Page;
    assertReady(): Promise<void>;
    sendMessage(text: string, signal?: AbortSignal): Promise<void>;
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
