/**
 * Auth + config API for END USERS of the desktop app (the exe/dmg) — not
 * admins. A logged-in desktop app uses this to fetch the real (unmasked)
 * API keys and feature-flag state an admin has configured, instead of
 * shipping them baked into the installer or read from a local .env.
 *
 * Deliberately token-in-body rather than a cookie: the caller is an
 * Electron main process making its own HTTP requests, not a browser page,
 * so there's no cookie jar to rely on — the app stores the JWT itself and
 * sends it back as `Authorization: Bearer <token>`.
 */
const express = require('express');
const jwt = require('jsonwebtoken');
const { db, defaultFlags } = require('../db');
const { issueUserOtp, verifyUserOtp } = require('../services/user-otp.service');
const { sendOtpEmail } = require('../services/email.service');
const { JWT_SECRET } = require('./auth');

const router = express.Router();

// Long-lived on purpose: this is a desktop app people leave signed in for
// weeks, not a browser session — re-prompting for an OTP every 12h would be
// disruptive for an internal tool.
const SESSION_TTL = '30d';

router.post('/request-otp', async (req, res) => {
  const { email } = req.body || {};
  const result = issueUserOtp(email);

  if (result.ok) {
    try {
      await sendOtpEmail(result.email, result.code, result.ttlMs);
    } catch (error) {
      console.error('[user-auth] Failed to send OTP email:', error.message);
      return res.status(502).json({ error: 'Failed to send email. Check the server\'s Zoho SMTP configuration.' });
    }
  } else if (result.reason === 'cooldown') {
    return res.status(429).json({ error: 'Please wait before requesting another code.', retryAfterMs: result.retryAfterMs });
  }
  // 'not_allowed' / 'invalid_email' fall through to the same generic
  // response as a real send — deliberately indistinguishable from outside.

  res.json({ ok: true, message: 'If that email is registered, a code has been sent.' });
});

router.post('/verify-otp', (req, res) => {
  const { email, code } = req.body || {};
  const result = verifyUserOtp(email, code);

  if (!result.ok) {
    const messages = {
      no_pending_code: 'No code was requested for this email, or it already expired.',
      too_many_attempts: 'Too many incorrect attempts. Request a new code.',
      expired: 'This code has expired. Request a new one.',
      incorrect: 'Incorrect code.',
      not_allowed: 'This account no longer has access. Contact your admin.'
    };
    return res.status(401).json({ error: messages[result.reason] || 'Verification failed.' });
  }

  const token = jwt.sign({ email: result.email, role: 'user' }, JWT_SECRET, { expiresIn: SESSION_TTL });
  res.json({ ok: true, token, email: result.email });
});

/** Blocks the request unless a valid end-user bearer token is present. */
function requireUser(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not signed in' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role !== 'user') return res.status(401).json({ error: 'Not signed in' });
    req.user = payload;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Session expired' });
  }
}

router.get('/me', requireUser, (req, res) => {
  res.json({ email: req.user.email });
});

// The one real payload the app is here for: unmasked settings + feature
// flags, current as of this call. Every field an admin can edit from the
// dashboard is mapped to the env-var-shaped name the app already expects,
// so wiring it in on the app side is a straight assignment.
router.get('/config', requireUser, (req, res) => {
  // Re-check the allowlist on every fetch, not just at login -- revoking a
  // user should take effect on their next config refresh, not just block
  // future logins.
  const row = db.prepare('SELECT enabled FROM end_users WHERE email = ?').get(req.user.email);
  if (!row || !row.enabled) {
    return res.status(403).json({ error: 'Access revoked. Contact your admin.' });
  }

  const settingsRows = db.prepare('SELECT key, value FROM settings').all();
  const settings = Object.fromEntries(settingsRows.map((r) => [r.key, r.value]));

  const flagRows = db.prepare('SELECT key, enabled FROM feature_flags').all();
  const featureFlags = Object.fromEntries(flagRows.map((r) => [r.key, !!r.enabled]));
  // Any flag not yet touched in the dashboard still defaults to on, same as
  // the seeded default -- a brand new flag shouldn't silently disable itself.
  for (const [key] of defaultFlags) {
    if (!(key in featureFlags)) featureFlags[key] = true;
  }

  res.json({
    email: req.user.email,
    settings: {
      geminiApiKey: settings.gemini_api_key || '',
      azureSpeechKey: settings.azure_speech_key || '',
      azureSpeechRegion: settings.azure_speech_region || '',
      speechProvider: settings.speech_provider || '',
      whisperModel: settings.whisper_model || '',
      whisperLanguage: settings.whisper_language || ''
    },
    featureFlags
  });
});

module.exports = { router, requireUser };
