import { describe, expect, it, vi } from 'vitest';
import { chromium } from 'playwright';
import { ChatGPTBrowser } from '../src/chatgpt/browser.js';
import { createLogger } from '../src/utils/logger.js';

vi.mock('playwright', () => ({ chromium: { launchPersistentContext: vi.fn() } }));
vi.mock('node:fs/promises', () => ({ default: { mkdir: vi.fn().mockResolvedValue(undefined) } }));

function fixture() {
  const browser = new ChatGPTBrowser({ profilePath: 'unused', debugDirectory: 'unused',
    chatgptUrl: 'https://chatgpt.com/', headless: true, timeoutMs: 1000 }, createLogger('silent'));
  const internal = browser as unknown as { refreshLoginState(): Promise<void> };
  vi.spyOn(internal, 'refreshLoginState').mockResolvedValue(undefined);
  const page = { goto: vi.fn().mockResolvedValue(undefined), on: vi.fn() };
  const context = { pages: () => [page], browser: () => ({ on: vi.fn() }), close: vi.fn().mockResolvedValue(undefined) };
  return { browser, context, page };
}

describe('browser launch and shutdown races', () => {
  it('closes a late launch and refuses subsequent launches after shutdown', async () => {
    const f = fixture();
    let release!: (value: unknown) => void;
    const launch = vi.mocked(chromium.launchPersistentContext).mockImplementationOnce(() => new Promise((resolve) => { release = resolve as typeof release; }));
    const starting = f.browser.start();
    const rejection = expect(starting).rejects.toThrow('关闭');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const closing = f.browser.close();
    release(f.context);
    await rejection;
    await closing;
    expect(f.context.close).toHaveBeenCalledOnce();
    expect(f.page.goto).not.toHaveBeenCalled();
    await expect(f.browser.start()).rejects.toThrow('关闭');
    launch.mockClear();
  });

  it('coalesces concurrent starts and disposes a failed navigation', async () => {
    const f = fixture();
    f.page.goto.mockRejectedValue(new Error('network unavailable'));
    const launch = vi.mocked(chromium.launchPersistentContext).mockResolvedValueOnce(f.context as never);
    await Promise.all([expect(f.browser.start()).rejects.toThrow('network unavailable'),
      expect(f.browser.start()).rejects.toThrow('network unavailable')]);
    expect(launch).toHaveBeenCalledOnce();
    expect(f.context.close).toHaveBeenCalledOnce();
    await f.browser.close();
    expect(f.context.close).toHaveBeenCalledOnce();
    launch.mockClear();
  });
});
