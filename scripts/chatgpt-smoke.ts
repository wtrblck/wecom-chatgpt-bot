import 'dotenv/config';
import path from 'node:path';
import { ChatGPTBrowser } from '../src/chatgpt/browser.js';
import { createLogger } from '../src/utils/logger.js';

const browser = new ChatGPTBrowser({
  profilePath: path.resolve(process.env.BROWSER_PROFILE || './data/browser-profile'),
  chatgptUrl: process.env.CHATGPT_URL || 'https://chatgpt.com/',
  headless: false,
  timeoutMs: Number(process.env.CHATGPT_TIMEOUT_MS || 180_000),
  debugDirectory: path.resolve('./logs/debug'),
}, createLogger(process.env.LOG_LEVEL || 'info'));

await browser.start();
console.log('请在浏览器中完成登录；检测到登录后会发送 hello。');
await browser.waitForLogin();
const result = await browser.generate('hello', async (text) => {
  process.stdout.write(`\r${text.slice(-100)}`);
});
console.log(`\n\n最终回复：\n${result.text}`);
await browser.close();
