PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS processed_messages (
  msgid TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS incoming_messages (
  platform TEXT NOT NULL,
  message_id TEXT NOT NULL,
  processed_at INTEGER NOT NULL,
  PRIMARY KEY(platform, message_id)
);

CREATE TABLE IF NOT EXISTS contact_mappings (
  platform TEXT NOT NULL,
  user_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(platform, user_id)
);

CREATE TABLE IF NOT EXISTS conversations (
  userid TEXT PRIMARY KEY,
  chatgpt_url TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  msgid TEXT UNIQUE NOT NULL,
  userid TEXT NOT NULL,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','cancelled','aborted')),
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  response TEXT,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_user_created ON tasks(userid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
