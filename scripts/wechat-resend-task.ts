import 'dotenv/config';
import path from 'node:path';
import { openDatabase } from '../src/db/sqlite.js';
import { Repository } from '../src/conversation/repository.js';
import { splitWechatText } from '../src/wechat/text.js';
import { createLogger } from '../src/utils/logger.js';
import { WeChatBridgeClient } from '../src/wechat/bridge-client.js';
import { acquireProcessLock } from '../src/utils/process-lock.js';

const taskId = Number(process.argv[2]);
if (!Number.isInteger(taskId) || taskId <= 0) throw new Error('Usage: npm run wechat:resend:task -- <taskId>');
const databasePath = path.resolve(process.env.DATABASE_PATH || 'data/bot.sqlite');
const release = acquireProcessLock(databasePath);
process.once('exit', release);
const db = openDatabase(databasePath);
const repository = new Repository(db);
const bridge = new WeChatBridgeClient(process.cwd(), process.env.WECHAT_BRIDGE_PATH, createLogger('warn'));
try {
  const task = db.prepare('SELECT userid, response FROM tasks WHERE id = ?').get(taskId) as { userid: string; response: string | null } | undefined;
  if (!task?.userid.startsWith('wechat:') || !task.response) throw new Error(`Task ${taskId} has no saved WeChat response`);
  const userId = task.userid.slice('wechat:'.length);
  const displayName = repository.getContactDisplayName('wechat', userId);
  if (!displayName) throw new Error('找不到目标群映射');
  const key = `task:${taskId}`;
  if (!repository.deliveryParts(key).length) repository.prepareDelivery(key, userId, splitWechatText(task.response));
  await bridge.start();
  for (const part of repository.deliveryParts(key)) {
    if (part.status === 'sent') continue;
    if (['sending', 'uncertain'].includes(part.status)) throw new Error('先停止 Bot 并核对微信，使用 wechat:outbox 处理未知状态，禁止盲目补发');
    repository.updateDelivery(key, part.part, 'sending');
    try {
      const receipt = await bridge.send(displayName, part.content);
      if (!receipt.verified) throw new Error('没有可验证的提交回执');
      repository.updateDelivery(key, part.part, 'sent');
    } catch (error) {
      repository.updateDelivery(key, part.part, (error as { code?: string }).code === 'WECHAT_SEND_REJECTED' ? 'failed' : 'uncertain', String(error));
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, Number(process.env.WECHAT_SEND_INTERVAL_MS || 300)));
  }
  repository.updateTask(taskId, 'completed');
  console.log(JSON.stringify({ submitted: true, taskId }));
} finally { await bridge.stop(); db.close(); release(); }
