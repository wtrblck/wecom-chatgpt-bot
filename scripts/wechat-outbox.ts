import 'dotenv/config';
import path from 'node:path';
import { openDatabase } from '../src/db/sqlite.js';
import { acquireProcessLock } from '../src/utils/process-lock.js';

const [operation = 'list', key, partText] = process.argv.slice(2);
const databasePath = path.resolve(process.env.DATABASE_PATH || 'data/bot.sqlite');
const release = operation === 'list' ? () => {} : acquireProcessLock(databasePath);
process.once('exit', release);
const db = openDatabase(databasePath);
try {
  if (operation === 'list') {
    console.table(db.prepare(`SELECT delivery_key, part, user_id, status, error FROM wechat_outbox
      WHERE status != 'sent' ORDER BY updated_at`).all());
  } else if (['mark-sent', 'retry'].includes(operation) && key && /^\d+$/.test(partText || '')) {
    const result = db.prepare(`UPDATE wechat_outbox SET status = ?, error = NULL, updated_at = ?
      WHERE delivery_key = ? AND part = ? AND status IN ('uncertain','failed')`)
      .run(operation === 'mark-sent' ? 'sent' : 'pending', Date.now(), key, Number(partText));
    if (!result.changes) throw new Error('未找到可处理的分片（仅 uncertain/failed 可处理）');
    console.log(operation === 'mark-sent' ? '已记录人工核对结果。' : '已允许补发此分片。确认微信中未出现该消息后再执行 resend:task。');
  } else {
    throw new Error('Usage: npm run wechat:outbox -- list | mark-sent <delivery-key> <part> | retry <delivery-key> <part>');
  }
} finally { db.close(); release(); }
