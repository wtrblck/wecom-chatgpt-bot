import 'dotenv/config';
import Database from 'better-sqlite3';
import path from 'node:path';
import { chromium } from 'playwright';
import { acquireProcessLock } from '../src/utils/process-lock.js';

const cwd = process.cwd();
const taskId = Number(process.argv[2]);
if (!Number.isSafeInteger(taskId) || taskId <= 0) throw new Error('Usage: node scripts/project-run.mjs tsx scripts/chatgpt-response-inspect.ts <taskId>');
const databasePath = path.resolve(cwd, process.env.DATABASE_PATH || './data/bot.sqlite');
const release = acquireProcessLock(databasePath);
process.once('exit', release);
const db = new Database(databasePath, { readonly: true });
const row = db.prepare(`
  SELECT c.chatgpt_url FROM conversations c JOIN tasks t ON t.userid=c.userid
  WHERE t.id=?
`).get(taskId) as { chatgpt_url?: string } | undefined;
db.close();
if (!row?.chatgpt_url) throw new Error('找不到群聊对应的 ChatGPT 会话 URL');

const profile = path.resolve(cwd, process.env.BROWSER_PROFILE || './data/browser-profile');
const context = await chromium.launchPersistentContext(profile, {
  headless: false,
  viewport: { width: 1365, height: 900 },
  args: ['--disable-blink-features=AutomationControlled'],
});
try {
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(row.chatgpt_url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForTimeout(5_000);
  const buttonLocator = page.locator('button');
  const buttons = [];
  for (let index = 0; index < await buttonLocator.count(); index += 1) {
    const button = buttonLocator.nth(index);
    const detail = {
      ariaLabel: await button.getAttribute('aria-label'),
      testId: await button.getAttribute('data-testid'),
      text: ((await button.textContent()) || '').trim().slice(0, 80),
      visible: await button.isVisible().catch(() => false),
      disabled: await button.isDisabled().catch(() => false),
    };
    if (/stop|send|停止|发送|提交/i.test(`${detail.ariaLabel} ${detail.testId} ${detail.text}`)) buttons.push(detail);
  }
  const messages = page.locator('[data-message-author-role="assistant"]');
  const assistantMessages = [];
  for (let index = 0; index < await messages.count(); index += 1) {
    const message = messages.nth(index);
    assistantMessages.push({
      index,
      innerText: (await message.innerText().catch(() => '')).trim().slice(0, 120),
      textContent: ((await message.textContent().catch(() => '')) || '').trim().slice(0, 120),
    });
  }
  const result = {
    url: page.url(),
    title: await page.title(),
    assistantCount: await messages.count(),
    lastAssistantLength: ((await messages.last().textContent().catch(() => '')) || '').trim().length,
    promptEditorCount: await page.locator('#prompt-textarea, [data-testid="prompt-textarea"], [contenteditable="true"][role="textbox"]').count(),
    buttons,
    assistantMessages,
  };
  console.log(JSON.stringify(result, null, 2));
} finally {
  await context.close();
  release();
}
