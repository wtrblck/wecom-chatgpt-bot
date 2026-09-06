import type Database from 'better-sqlite3';
import type { IncomingMessage, TaskRecord, TaskStatus } from '../types/index.js';

export interface OutboxPart {
  delivery_key: string;
  part: number;
  user_id: string;
  content: string;
  status: 'pending' | 'sending' | 'sent' | 'failed' | 'uncertain';
  error: string | null;
}

export class Repository {
  constructor(private readonly db: Database.Database) {}

  transaction<T>(work: () => T): T {
    return this.db.transaction(work)();
  }

  saveInbox(messages: readonly IncomingMessage[]): void {
    this.transaction(() => {
      const insert = this.db.prepare('INSERT OR IGNORE INTO wechat_inbox(message_id, payload, received_at) VALUES (?, ?, ?)');
      for (const message of messages) insert.run(message.messageId, JSON.stringify(message), Date.now());
    });
  }

  pendingInbox(limit = 200): IncomingMessage[] {
    return (this.db.prepare('SELECT payload FROM wechat_inbox WHERE handled_at IS NULL ORDER BY received_at, rowid LIMIT ?')
      .all(limit) as { payload: string }[]).map((row) => JSON.parse(row.payload) as IncomingMessage);
  }

  finishInbox(messageId: string): void {
    this.db.prepare('UPDATE wechat_inbox SET handled_at = ? WHERE message_id = ?').run(Date.now(), messageId);
  }

  queuedWechatTasks(): { task: TaskRecord; message: IncomingMessage }[] {
    const rows = this.db.prepare(`SELECT tasks.*, wechat_inbox.payload FROM tasks JOIN wechat_inbox
      ON tasks.msgid = 'wechat:' || wechat_inbox.message_id WHERE tasks.status = 'queued' ORDER BY tasks.id`)
      .all() as (TaskRecord & { payload: string })[];
    return rows.map(({ payload, ...task }) => ({ task, message: JSON.parse(payload) as IncomingMessage }));
  }

  recoverableWechatReplies(): { task: TaskRecord; message: IncomingMessage }[] {
    const rows = this.db.prepare(`SELECT tasks.*, wechat_inbox.payload FROM tasks JOIN wechat_inbox
      ON tasks.msgid = 'wechat:' || wechat_inbox.message_id
      WHERE tasks.status IN ('failed','aborted') AND tasks.response IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM wechat_outbox WHERE delivery_key = 'task:' || tasks.id
          AND status IN ('sending','uncertain')) ORDER BY tasks.id`).all() as (TaskRecord & { payload: string })[];
    return rows.map(({ payload, ...task }) => ({ task, message: JSON.parse(payload) as IncomingMessage }));
  }

  lastTask(userid: string): TaskRecord | null {
    return (this.db.prepare(`SELECT * FROM tasks WHERE userid = ?
      AND status IN ('completed','failed','cancelled','aborted') ORDER BY id DESC LIMIT 1`).get(userid) as TaskRecord | undefined) ?? null;
  }

  hasUnfinishedTask(userid: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM tasks WHERE userid = ? AND status IN ('queued','running') LIMIT 1").get(userid));
  }

  prepareDelivery(key: string, userId: string, chunks: readonly string[]): OutboxPart[] {
    return this.transaction(() => {
      const existing = this.deliveryParts(key);
      if (existing.length) {
        if (existing.length !== chunks.length || existing.some((part, index) => part.user_id !== userId || part.content !== chunks[index])) {
          throw new Error('发送幂等键与已保存内容不一致');
        }
        return existing;
      }
      const insert = this.db.prepare(`INSERT INTO wechat_outbox(delivery_key, part, user_id, content, status, updated_at)
        VALUES (?, ?, ?, ?, 'pending', ?)`);
      chunks.forEach((chunk, index) => insert.run(key, index, userId, chunk, Date.now()));
      return this.deliveryParts(key);
    });
  }

  deliveryParts(key: string): OutboxPart[] {
    return this.db.prepare('SELECT * FROM wechat_outbox WHERE delivery_key = ? ORDER BY part').all(key) as OutboxPart[];
  }

  updateDelivery(key: string, part: number, status: OutboxPart['status'], error?: string): void {
    this.db.prepare('UPDATE wechat_outbox SET status = ?, error = ?, updated_at = ? WHERE delivery_key = ? AND part = ?')
      .run(status, error ?? null, Date.now(), key, part);
  }

  recoverDeliveries(): number {
    return this.db.prepare("UPDATE wechat_outbox SET status = 'uncertain', error = 'process restarted during send', updated_at = ? WHERE status = 'sending'")
      .run(Date.now()).changes;
  }

  claimMessage(msgid: string): boolean {
    const result = this.db
      .prepare('INSERT OR IGNORE INTO processed_messages(msgid, received_at) VALUES (?, ?)')
      .run(msgid, Date.now());
    return result.changes === 1;
  }

  claimIncoming(platform: 'wecom' | 'wechat', messageId: string): boolean {
    const result = this.db
      .prepare('INSERT OR IGNORE INTO incoming_messages(platform, message_id, processed_at) VALUES (?, ?, ?)')
      .run(platform, messageId, Date.now());
    return result.changes === 1;
  }

  hasIncoming(platform: 'wecom' | 'wechat', messageId: string): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM incoming_messages WHERE platform = ? AND message_id = ?')
      .get(platform, messageId);
    return row !== undefined;
  }

  saveContact(platform: 'wecom' | 'wechat', userId: string, displayName: string): void {
    this.db.prepare(`
      INSERT INTO contact_mappings(platform, user_id, display_name, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(platform, user_id) DO UPDATE SET display_name = excluded.display_name, updated_at = excluded.updated_at
    `).run(platform, userId, displayName, Date.now());
  }

  getContactDisplayName(platform: 'wecom' | 'wechat', userId: string): string | null {
    const row = this.db
      .prepare('SELECT display_name FROM contact_mappings WHERE platform = ? AND user_id = ?')
      .get(platform, userId) as { display_name: string } | undefined;
    return row?.display_name ?? null;
  }

  getConversation(userid: string): string | null {
    const row = this.db
      .prepare('SELECT chatgpt_url FROM conversations WHERE userid = ?')
      .get(userid) as { chatgpt_url: string | null } | undefined;
    return row?.chatgpt_url ?? null;
  }

  resolveWechatUserId(name: string, id?: string): string | null {
    if (id) return id;
    const rows = this.db.prepare("SELECT user_id FROM contact_mappings WHERE platform = 'wechat' AND display_name = ?")
      .all(name) as { user_id: string }[];
    if (rows.length > 1) throw new Error('存在多个同名会话映射，请先填写稳定微信 ID');
    return rows[0]?.user_id ?? null;
  }

  saveConversation(userid: string, url: string): void {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO conversations(userid, chatgpt_url, created_at, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(userid) DO UPDATE SET chatgpt_url = excluded.chatgpt_url, updated_at = excluded.updated_at
    `).run(userid, url, now, now);
  }

  clearConversation(userid: string): void {
    this.db.prepare('DELETE FROM conversations WHERE userid = ?').run(userid);
  }

  createTask(msgid: string, userid: string, prompt: string): number {
    const result = this.db
      .prepare("INSERT INTO tasks(msgid, userid, prompt, status, created_at) VALUES (?, ?, ?, 'queued', ?)")
      .run(msgid, userid, prompt, Date.now());
    return Number(result.lastInsertRowid);
  }

  updateTask(
    id: number,
    status: TaskStatus,
    fields: { response?: string; error?: string } = {},
  ): void {
    const startedAt = status === 'running' ? Date.now() : null;
    const finishedAt = ['completed', 'failed', 'cancelled', 'aborted'].includes(status) ? Date.now() : null;
    this.db.prepare(`
      UPDATE tasks SET status = ?,
        started_at = COALESCE(started_at, ?),
        finished_at = COALESCE(?, finished_at),
        response = COALESCE(?, response),
        error = COALESCE(?, error)
      WHERE id = ?
    `).run(status, startedAt, finishedAt, fields.response ?? null, fields.error ?? null, id);
  }

  abortInterruptedTasks(): number {
    return this.db
      .prepare(`UPDATE tasks SET status = 'aborted', finished_at = ?, error = 'process restarted'
        WHERE status = 'running' OR (status = 'queued' AND NOT EXISTS (
          SELECT 1 FROM wechat_inbox WHERE tasks.msgid = 'wechat:' || wechat_inbox.message_id
        ))`)
      .run(Date.now()).changes;
  }

  lastPrompt(userid: string): string | null {
    const row = this.db.prepare(`
      SELECT prompt FROM tasks
      WHERE userid = ? AND status IN ('completed', 'failed', 'cancelled', 'aborted')
      ORDER BY id DESC LIMIT 1
    `).get(userid) as Pick<TaskRecord, 'prompt'> | undefined;
    return row?.prompt ?? null;
  }
}
