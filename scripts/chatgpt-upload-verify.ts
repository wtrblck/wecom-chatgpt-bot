/** Offline Chromium check for the actual upload DOM logic. Never opens ChatGPT. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import { ChatGPTBrowser } from '../src/chatgpt/browser.js';
import { createLogger } from '../src/utils/logger.js';

const base = path.resolve('.cache');
await fs.mkdir(base, { recursive: true });
const directory = await fs.mkdtemp(path.join(base, 'upload-verify-'));
const file = path.join(directory, 'image.png');
await fs.writeFile(file, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64'));
const browser = await chromium.launch({ headless: true, executablePath: process.env.VERIFY_BROWSER_EXECUTABLE });
try {
  const page = await browser.newPage();
  await page.route('**/*', route => route.abort());
  const bot = new ChatGPTBrowser({ profilePath: directory, chatgptUrl: 'https://chatgpt.com/', headless: true,
    timeoutMs: 1500, debugDirectory: directory }, createLogger('silent'));
  const internal = bot as unknown as { page: Page; sendMessage(text: string, signal?: AbortSignal, paths?: readonly string[]): Promise<void> };
  internal.page = page;
  async function fixture(mode: 'ready' | 'error' | 'partial') {
    await page.setContent(`<form>
      <textarea id="prompt-textarea"></textarea><input type="file" multiple>
      <div id="previews"></div><button type="submit" data-testid="send-button">Send</button>
      </form><section id="messages"></section><script>(() => {
      let ready = false;
      document.querySelector('input').onchange = () => {
        document.querySelector('#previews').innerHTML = '<button type="button" aria-label="Remove file">Remove</button><span role="progressbar">Uploading</span>';
        setTimeout(() => {
          ${mode === 'error' ? "document.querySelector('#previews').innerHTML = '<div role=\"alert\">上传失败</div>';" : mode === 'ready' ? "document.querySelector('[role=progressbar]').remove(); ready = true;" : ''}
        }, 450);
      };
      document.querySelector('form').onsubmit = e => {
        e.preventDefault(); document.querySelector('#messages').innerHTML = '<div data-message-author-role="user">' + (ready ? 'uploaded' : 'too early') + '</div>';
      };
      })();</script>`);
  }
  await fixture('ready');
  await internal.sendMessage('看图', undefined, [file]);
  assert.equal(await page.locator('[data-message-author-role="user"]').innerText(), 'uploaded');
  await fixture('error');
  await assert.rejects(internal.sendMessage('看图', undefined, [file]), /上传失败/);
  await fixture('partial');
  await assert.rejects(internal.sendMessage('看图', undefined, [file]), /未就绪/);
  assert.equal(await page.locator('[data-message-author-role="user"]').count(), 0);
  console.log('Chromium upload verification passed: delayed readiness, failure, incomplete preview; no network requests.');
} finally {
  await browser.close();
  const resolved = path.resolve(directory);
  if (!resolved.startsWith(base + path.sep)) throw new Error('Invalid verification directory');
  await fs.rm(resolved, { recursive: true, force: true });
}
