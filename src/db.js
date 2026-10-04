import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = dirname(fileURLToPath(new URL('../data/app.db', import.meta.url)));

const SCHEMA = `
CREATE TABLE IF NOT EXISTS raw_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  source     TEXT NOT NULL,
  kind       TEXT NOT NULL,
  content    TEXT,
  meta       TEXT,
  candidates TEXT,
  status     TEXT NOT NULL DEFAULT 'new',
  image_path TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  organizer   TEXT,
  campus      TEXT,
  start_at    TEXT,
  end_at      TEXT,
  due_at      TEXT,
  location    TEXT,
  capacity    TEXT,
  tags        TEXT NOT NULL DEFAULT '[]',
  doc_body    TEXT,
  doc_id      INTEGER,
  source_url  TEXT,
  source      TEXT NOT NULL,
  raw_item_id INTEGER REFERENCES raw_items(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS tasks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  due_at      TEXT,
  priority    TEXT NOT NULL DEFAULT 'unknown',
  status      TEXT NOT NULL DEFAULT 'todo',
  doc_id      INTEGER,
  source_url  TEXT,
  source      TEXT NOT NULL,
  raw_item_id INTEGER REFERENCES raw_items(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS resources (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT NOT NULL,
  url        TEXT,
  path       TEXT,
  kind       TEXT,
  course     TEXT,
  tags       TEXT NOT NULL DEFAULT '[]',
  note       TEXT,
  doc_id     INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS qq_msgs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id    INTEGER NOT NULL,
  group_name  TEXT,
  message_id  TEXT NOT NULL UNIQUE,
  seq         INTEGER,
  user_id     INTEGER,
  sender      TEXT,
  text        TEXT,
  time        INTEGER,
  batch_id    INTEGER,
  captured_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_qq_msgs_pending ON qq_msgs(batch_id, group_id);
CREATE TABLE IF NOT EXISTS sources (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  type         TEXT NOT NULL UNIQUE,
  config       TEXT NOT NULL DEFAULT '{}',
  last_sync_at TEXT
);
CREATE TABLE IF NOT EXISTS docs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  source     TEXT NOT NULL DEFAULT 'yuque',
  slug       TEXT NOT NULL,
  title      TEXT NOT NULL,
  kind       TEXT,
  hidden     INTEGER NOT NULL DEFAULT 0,
  doc_date   TEXT,
  body       TEXT,
  url        TEXT,
  updated_at TEXT,
  synced_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE(source, slug)
);
`;

export function openDb() {
  mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(join(DATA_DIR, 'app.db'));
  // qq-sync.js 是独立进程,可能在本地服务正在写库时同时写 → 等锁而不是直接 SQLITE_BUSY
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA);
  for (const [table, column, type] of [['events', 'doc_id', 'INTEGER'], ['tasks', 'doc_id', 'INTEGER'],
    ['docs', 'kind', 'TEXT'], ['docs', 'hidden', 'INTEGER NOT NULL DEFAULT 0'],
    ['resources', 'path', 'TEXT'], ['resources', 'doc_id', 'INTEGER'],
    ['raw_items', 'meta', 'TEXT'], ['raw_items', 'candidates', 'TEXT'],
    ['raw_items', 'status', `TEXT NOT NULL DEFAULT 'new'`],
    ['tasks', 'rank', 'INTEGER'], ['tasks', 'meta', 'TEXT']]) {
    const has = db.prepare(`SELECT 1 FROM pragma_table_info(?) WHERE name=?`).get(table, column);
    if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
  return db;
}
