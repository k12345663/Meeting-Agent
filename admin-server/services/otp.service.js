const crypto = require('crypto');
const { db } = require('../db');

const OTP_LENGTH = 6;
const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_ATTEMPTS = 5; // guesses allowed against one code before it's dead
const RESEND_COOLDOWN_MS = 30 * 1000; // stops one click from firing 10 emails

function hashCode(code, email) {
  // Salting with the email means two admins who happen to get the same
  // 6-digit code never produce the same hash.
  return crypto.createHash('sha256').update(`${email.toLowerCase()}:${code}`).digest('hex');
}

function isAllowlistedAdmin(email) {
  const row = db.prepare('SELECT id FROM admins WHERE email = ?').get(email);
  return !!row;
}

/**
 * Issue a new OTP for an email already in the admins allowlist. Returns
 * { ok: false, reason } for anything that shouldn't proceed (unknown email,
 * still in cooldown) without ever revealing which case it was to the caller
 * response — the API layer decides what, if anything, to tell the client.
 */
function issueOtp(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized || !normalized.includes('@')) {
    return { ok: false, reason: 'invalid_email' };
  }
  if (!isAllowlistedAdmin(normalized)) {
    return { ok: false, reason: 'not_admin' };
  }

  const recent = db.prepare(
    `SELECT created_at FROM otp_codes WHERE email = ? ORDER BY created_at DESC LIMIT 1`
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
    'INSERT INTO otp_codes (email, code_hash, expires_at) VALUES (?, ?, ?)'
  ).run(normalized, hashCode(code, normalized), expiresAt);

  return { ok: true, code, email: normalized, ttlMs: OTP_TTL_MS };
}

/**
 * Verify a submitted code against the most recent unused OTP for that email.
 * Attempts are capped per-code so the 6-digit space can't be brute-forced by
 * hammering one request.
 */
function verifyOtp(email, code) {
  const normalized = String(email || '').trim().toLowerCase();
  const row = db.prepare(
    `SELECT * FROM otp_codes WHERE email = ? AND used = 0 ORDER BY created_at DESC LIMIT 1`
  ).get(normalized);

  if (!row) return { ok: false, reason: 'no_pending_code' };
  if (row.attempts >= MAX_ATTEMPTS) return { ok: false, reason: 'too_many_attempts' };
  if (new Date(row.expires_at + 'Z').getTime() < Date.now()) return { ok: false, reason: 'expired' };

  db.prepare('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id);

  const submittedHash = hashCode(String(code || '').trim(), normalized);
  if (submittedHash !== row.code_hash) {
    return { ok: false, reason: 'incorrect' };
  }

  db.prepare('UPDATE otp_codes SET used = 1 WHERE id = ?').run(row.id);
  return { ok: true, email: normalized };
}

module.exports = { issueOtp, verifyOtp, isAllowlistedAdmin, OTP_TTL_MS };
