/**
 * SQLite storage for the admin panel. Deliberately file-based with zero
 * external services — the user confirmed no backend/database exists yet,
 * so this needs to stand up on its own. Swapping to Postgres later only
 * means changing this file; nothing else in the app talks to SQL directly.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, 'data');
// Gitignored (the DB is generated, not committed), and on hosts with no
// persistent disk (e.g. Render's free plan) this directory doesn't survive
// a redeploy either -- so it must be (re)created on every boot rather than
// assumed to exist.
fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'admin.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- OTP codes are stored as a salted hash, never in plaintext, so a DB leak
  -- alone can't be used to log in as an admin.
  CREATE TABLE IF NOT EXISTS otp_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL COLLATE NOCASE,
    code_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Arbitrary admin-managed config: provider API keys, Whisper model choice,
  -- feature toggles. Values are opaque strings (JSON-encode on the way in if
  -- a setting needs structure) so this table doesn't need a schema change
  -- every time a new setting is added.
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by TEXT
  );

  CREATE TABLE IF NOT EXISTS feature_flags (
    key TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_otp_email ON otp_codes(email);
`);

// Seed the default feature set once, so the dashboard has something
// meaningful to show on first run instead of an empty table.
const defaultFlags = [
  ['listen', 'Microphone + system-audio listening'],
  ['auto_watch', 'Continuous screen monitoring (Auto)'],
  ['zoom_bot', 'Zoom bot meeting join'],
  ['minutes_of_meeting', 'Minutes of Meeting generation'],
  ['screenshot_ask_ai', 'Screenshot / Ask AI capture']
];
const insertFlag = db.prepare(
  'INSERT OR IGNORE INTO feature_flags (key, enabled) VALUES (?, 1)'
);
for (const [key] of defaultFlags) insertFlag.run(key);

module.exports = { db, defaultFlags };
