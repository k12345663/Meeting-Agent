/**
 * OTP login for end users of the desktop app (the exe/dmg), kept separate
 * from services/otp.service.js (admin login) on purpose: different
 * allowlist (end_users vs admins), different table, so a burst of desktop
 * app logins can never rate-limit or interfere with admin access.
 */
const crypto = require('crypto');
const { db } = require('../db');

const OTP_LENGTH = 6;
const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_MS = 30 * 1000;

function hashCode(code, email) {
  return crypto.createHash('sha256').update(`user:${email.toLowerCase()}:${code}`).digest('hex');
}

function isAllowlistedUser(email) {
  const row = db.prepare('SELECT id, enabled FROM end_users WHERE email = ?').get(email);
  return !!(row && row.enabled);
}

/**
 * Issue a new OTP for an email already in the end_users allowlist and
 * enabled. Returns { ok: false, reason } for anything that shouldn't
 * proceed, without revealing which case it was to the API caller.
 */
function issueUserOtp(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized || !normalized.includes('@')) {
    return { ok: false, reason: 'invalid_email' };
  }
  if (!isAllowlistedUser(normalized)) {
    return { ok: false, reason: 'not_allowed' };
  }

  const recent = db.prepare(
    `SELECT created_at FROM user_otp_codes WHERE email = ? ORDER BY created_at DESC LIMIT 1`
  ).get(normalized);
  if (recent) {
    const age = Date.now() - new Date(recent.created_at + 'Z').getTime();
    if (age < RESEND_COOLDOWN_MS) {
      return { ok: false, reason: 'cooldown', retryAfterMs: RESEND_COOLDOWN_MS - age };
    }
  }

  const code = crypto.randomInt(0, 10 ** OTP_LENGTH).toString().padStart(OTP_LENGTH, '0');
  const expiresAt = new Date(Date.now() + OTP_TTL_MS).toISOString();
  db.prepare(
    'INSERT INTO user_otp_codes (email, code_hash, expires_at) VALUES (?, ?, ?)'
  ).run(normalized, hashCode(code, normalized), expiresAt);

  return { ok: true, code, email: normalized, ttlMs: OTP_TTL_MS };
}

function verifyUserOtp(email, code) {
  const normalized = String(email || '').trim().toLowerCase();
  const row = db.prepare(
    `SELECT * FROM user_otp_codes WHERE email = ? AND used = 0 ORDER BY created_at DESC LIMIT 1`
  ).get(normalized);

  if (!row) return { ok: false, reason: 'no_pending_code' };
  if (row.attempts >= MAX_ATTEMPTS) return { ok: false, reason: 'too_many_attempts' };
  if (new Date(row.expires_at + 'Z').getTime() < Date.now()) return { ok: false, reason: 'expired' };

  db.prepare('UPDATE user_otp_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id);

  const submittedHash = hashCode(String(code || '').trim(), normalized);
  if (submittedHash !== row.code_hash) {
    return { ok: false, reason: 'incorrect' };
  }

  // Re-check the allowlist at verify time too -- an admin may have disabled
  // this user in the window between requesting and entering the code.
  if (!isAllowlistedUser(normalized)) {
    return { ok: false, reason: 'not_allowed' };
  }

  db.prepare('UPDATE user_otp_codes SET used = 1 WHERE id = ?').run(row.id);
  db.prepare('UPDATE end_users SET last_login_at = datetime(\'now\') WHERE email = ?').run(normalized);
  return { ok: true, email: normalized };
}

module.exports = { issueUserOtp, verifyUserOtp, isAllowlistedUser, OTP_TTL_MS };
