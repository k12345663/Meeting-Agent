/**
 * SQLite storage for the admin panel. Deliberately file-based with zero
 * external services — the user confirmed no backend/database exists yet,
 * so this needs to stand up on its own. Swapping to Postgres later only
 * means changing this file; nothing else in the app talks to SQL directly.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// DATA_DIR is overridable so a deploy with real persistent storage (an EBS
// volume on EC2, a Render paid-plan disk, an EFS mount, ...) can point this
// at that mounted path and have the SQLite file actually survive restarts.
// Left unset, it falls back to a folder next to this file -- fine for local
// dev, but on any host with no persistent disk (e.g. Render's free plan)
// that folder doesn't survive a redeploy, so it's (re)created on every boot
// rather than assumed to exist. See docs/DEVOPS.md for the AWS setup.
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'admin.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    -- NULL means "no password set" -- OTP is the only way in for that admin
    -- until they set one themselves from the dashboard (routes/auth.js
    -- POST /set-password). Never written to directly by anyone but the
    -- admin it belongs to.
    password_hash TEXT
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

  -- Allowlisted end users of the desktop app (distinct from admins: they can
  -- log the app in and pull config, but have no access to this dashboard).
  CREATE TABLE IF NOT EXISTS end_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_login_at TEXT
  );

  -- Mirrors otp_codes but kept separate so end-user login attempts can never
  -- collide with, rate-limit, or leak timing info about admin login.
  CREATE TABLE IF NOT EXISTS user_otp_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL COLLATE NOCASE,
    code_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_otp_email ON otp_codes(email);
  CREATE INDEX IF NOT EXISTS idx_user_otp_email ON user_otp_codes(email);
`);

// Migration for any admins table created before password_hash existed --
// CREATE TABLE IF NOT EXISTS above only applies the full schema on a truly
// fresh database. SQLite has no "ADD COLUMN IF NOT EXISTS", so check first.
const adminColumns = db.prepare("PRAGMA table_info(admins)").all().map((c) => c.name);
if (!adminColumns.includes('password_hash')) {
  db.exec('ALTER TABLE admins ADD COLUMN password_hash TEXT');
}

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
