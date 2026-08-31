const express = require('express');
const { db, defaultFlags } = require('../db');
const { requireAdmin } = require('./auth');
const { isConfigured: emailConfigured } = require('../services/email.service');

const router = express.Router();

// Every route below requires a valid admin session.
router.use(requireAdmin);

// Settings that hold secrets (API keys) are masked on the way out — the
// dashboard shows "•••• last 4 chars" and only sends a real value back up
// when the admin actually types a new one, so a key already saved is never
// re-displayed in full just by loading the page.
const SECRET_KEYS = new Set(['gemini_api_key', 'azure_speech_key', 'zoho_smtp_pass']);

function maskSecret(value) {
  if (!value) return '';
  if (value.length <= 4) return '••••';
  return '•'.repeat(Math.max(4, value.length - 4)) + value.slice(-4);
}

router.get('/settings', (req, res) => {
  const rows = db.prepare('SELECT key, value, updated_at, updated_by FROM settings').all();
  const out = rows.map((r) => ({
    ...r,
    value: SECRET_KEYS.has(r.key) ? maskSecret(r.value) : r.value,
    isSecret: SECRET_KEYS.has(r.key)
  }));
  res.json({ settings: out, emailConfigured });
});

router.put('/settings/:key', (req, res) => {
  const { key } = req.params;
  const { value } = req.body || {};
  if (typeof value !== 'string') {
    return res.status(400).json({ error: 'value must be a string' });
  }
  db.prepare(`
    INSERT INTO settings (key, value, updated_at, updated_by)
    VALUES (?, ?, datetime('now'), ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by
  `).run(key, value, req.admin.email);
  res.json({ ok: true });
});

router.get('/feature-flags', (req, res) => {
  const rows = db.prepare('SELECT key, enabled, updated_at, updated_by FROM feature_flags').all();
  const labels = Object.fromEntries(defaultFlags);
  res.json({ flags: rows.map((r) => ({ ...r, enabled: !!r.enabled, label: labels[r.key] || r.key })) });
});

router.put('/feature-flags/:key', (req, res) => {
  const { key } = req.params;
  const { enabled } = req.body || {};
  db.prepare(`
    INSERT INTO feature_flags (key, enabled, updated_at, updated_by)
    VALUES (?, ?, datetime('now'), ?)
    ON CONFLICT(key) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at, updated_by = excluded.updated_by
  `).run(key, enabled ? 1 : 0, req.admin.email);
  res.json({ ok: true });
});

router.get('/admins', (req, res) => {
  const rows = db.prepare('SELECT id, email, created_at FROM admins ORDER BY created_at ASC').all();
  res.json({ admins: rows });
});

router.post('/admins', (req, res) => {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'A valid email is required' });
  }
  try {
    db.prepare('INSERT INTO admins (email) VALUES (?)').run(email);
    res.json({ ok: true });
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'That email is already an admin' });
    }
    res.status(500).json({ error: 'Failed to add admin' });
  }
});

router.delete('/admins/:id', (req, res) => {
  const { id } = req.params;
  const target = db.prepare('SELECT email FROM admins WHERE id = ?').get(id);
  if (target && target.email === req.admin.email) {
    return res.status(400).json({ error: "You can't remove your own admin access." });
  }
  db.prepare('DELETE FROM admins WHERE id = ?').run(id);
  res.json({ ok: true });
});

module.exports = router;
