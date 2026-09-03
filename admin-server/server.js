require('dotenv').config();
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const { db } = require('./db'); // initializes the SQLite schema on first run

// Optional admin bootstrap via env var, for hosting platforms where getting
// a shell into the running container to run seed-admin.js isn't available
// on cheaper plans (and, on a free-tier host with no persistent disk, for
// admins to survive the database getting wiped on every restart/redeploy
// too). Accepts a comma-separated list so more than one person can be
// bootstrapped this way, not just the first admin. Idempotent — safe to
// leave set permanently, it just no-ops for any email that already exists.
const bootstrapEmails = String(process.env.BOOTSTRAP_ADMIN_EMAIL || '')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

for (const email of bootstrapEmails) {
  try {
    db.prepare('INSERT INTO admins (email) VALUES (?)').run(email);
    console.log(`[bootstrap] Added admin from BOOTSTRAP_ADMIN_EMAIL: ${email}`);
  } catch (error) {
    if (!String(error.message).includes('UNIQUE')) {
      console.error(`[bootstrap] Failed to add admin "${email}":`, error.message);
    }
    // already exists — nothing to do
  }
}

// Same idea as BOOTSTRAP_ADMIN_EMAIL above, but for the App Users allowlist
// (desktop app sign-in). This one matters even more on a host with no
// persistent disk: admins re-seed themselves via the env var above and can
// always get back into the dashboard, but end users have no such recovery
// path today -- without this, every restart/redeploy on the free tier
// silently locks every app user out until an admin manually re-adds them.
const bootstrapAppUserEmails = String(process.env.BOOTSTRAP_APP_USER_EMAIL || '')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

for (const email of bootstrapAppUserEmails) {
  try {
    db.prepare('INSERT INTO end_users (email) VALUES (?)').run(email);
    console.log(`[bootstrap] Added app user from BOOTSTRAP_APP_USER_EMAIL: ${email}`);
  } catch (error) {
    if (!String(error.message).includes('UNIQUE')) {
      console.error(`[bootstrap] Failed to add app user "${email}":`, error.message);
    }
    // already exists — nothing to do
  }
}

// Same free-tier problem as the two bootstraps above, but for the actual
// API keys/settings an admin sets from the dashboard: the `settings` table
// lives in the same disk-less SQLite file, so it goes back to empty on
// every restart/redeploy/sleep-wake too -- which looks exactly like "the
// dashboard isn't storing data" even though saving worked fine in the
// moment. Re-seeding from env vars on every boot is the same fix as
// BOOTSTRAP_ADMIN_EMAIL, applied to settings: set these once in Render and
// they survive every wipe, no re-entering a key after every cold start.
// Only touches a setting whose env var is actually set (non-empty), so
// leaving one unset never overwrites a value entered through the dashboard
// during the current boot's uptime.
const settingsBootstrapMap = {
  BOOTSTRAP_GEMINI_API_KEY: 'gemini_api_key',
  BOOTSTRAP_AZURE_SPEECH_KEY: 'azure_speech_key',
  BOOTSTRAP_AZURE_SPEECH_REGION: 'azure_speech_region',
  BOOTSTRAP_SPEECH_PROVIDER: 'speech_provider',
  BOOTSTRAP_WHISPER_MODEL: 'whisper_model',
  BOOTSTRAP_WHISPER_LANGUAGE: 'whisper_language'
};

const upsertSetting = db.prepare(`
  INSERT INTO settings (key, value, updated_at, updated_by)
  VALUES (?, ?, datetime('now'), 'bootstrap-env')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by
`);

for (const [envVar, settingKey] of Object.entries(settingsBootstrapMap)) {
  const value = String(process.env[envVar] || '').trim();
  if (!value) continue;
  try {
    upsertSetting.run(settingKey, value);
    console.log(`[bootstrap] Seeded setting "${settingKey}" from ${envVar}`);
  } catch (error) {
    console.error(`[bootstrap] Failed to seed setting "${settingKey}" from ${envVar}:`, error.message);
  }
}

const { router: authRouter } = require('./routes/auth');
const adminRouter = require('./routes/admin');
const { router: userRouter } = require('./routes/user');

const app = express();
const PORT = process.env.PORT || 4500;

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/auth', authRouter);
app.use('/api/admin', adminRouter);
app.use('/api/user', userRouter);

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Admin panel server listening on http://localhost:${PORT}`);
});
