import type Database from 'better-sqlite3';
import type { TaskRecord, TaskStatus } from '../types/index.js';

export class Repository {
  constructor(private readonly db: Database.Database) {}

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
        started_at = COALESCE(?, started_at),
        finished_at = COALESCE(?, finished_at),
        response = COALESCE(?, response),
        error = COALESCE(?, error)
      WHERE id = ?
    `).run(status, startedAt, finishedAt, fields.response ?? null, fields.error ?? null, id);
  }

  abortInterruptedTasks(): number {
    return this.db
      .prepare("UPDATE tasks SET status = 'aborted', finished_at = ?, error = 'process restarted' WHERE status = 'running'")
      .run(Date.now()).changes;
  }

  lastPrompt(userid: string): string | null {
    const row = this.db.prepare(`
      SELECT prompt FROM tasks
      WHERE userid = ? AND status IN ('completed', 'failed', 'cancelled')
      ORDER BY created_at DESC LIMIT 1
    `).get(userid) as Pick<TaskRecord, 'prompt'> | undefined;
    return row?.prompt ?? null;
  }
}
