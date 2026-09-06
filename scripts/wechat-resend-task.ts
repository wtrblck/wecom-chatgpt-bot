import path from 'node:path';
import Database from 'better-sqlite3';
import { config as loadEnv } from 'dotenv';
import { createLogger } from '../src/utils/logger.js';
import { WeChatBridgeClient } from '../src/wechat/bridge-client.js';

loadEnv();
const taskId = Number(process.argv[2]);
if (!Number.isInteger(taskId) || taskId <= 0) throw new Error('Usage: npm run wechat:resend:task -- <taskId>');
const databasePath = path.resolve(process.cwd(), process.env.DATABASE_PATH || './data/bot.sqlite');
const database = new Database(databasePath, { readonly: true });
const task = database.prepare('SELECT userid, response FROM tasks WHERE id = ?').get(taskId) as
  | { userid: string; response: string | null }
  | undefined;
if (!task?.userid.startsWith('wechat:') || !task.response) throw new Error(`Task ${taskId} has no WeChat response`);
const userId = task.userid.slice('wechat:'.length);
const contact = database.prepare(
  'SELECT display_name FROM contact_mappings WHERE platform = ? AND user_id = ?',
).get('wechat', userId) as { display_name: string } | undefined;
database.close();
if (!contact) throw new Error(`Task ${taskId} has no WeChat contact mapping`);

const bridge = new WeChatBridgeClient(process.cwd(), process.env.WECHAT_BRIDGE_PATH, createLogger('warn'));
try {
  await bridge.start();
  await bridge.send(contact.display_name, task.response);
  console.log(JSON.stringify({ sent: true, taskId, displayName: contact.display_name }));
} finally {
  await bridge.stop();
}
