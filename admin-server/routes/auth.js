const express = require('express');
const jwt = require('jsonwebtoken');
const { issueOtp, verifyOtp } = require('../services/otp.service');
const { sendOtpEmail } = require('../services/email.service');

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-insecure-secret-change-in-production';
const SESSION_TTL = '12h';
const COOKIE_NAME = 'admin_session';

if (JWT_SECRET === 'dev-only-insecure-secret-change-in-production') {
  console.warn(
    '[auth] JWT_SECRET is not set — using an insecure development default. ' +
    'Set a real JWT_SECRET in admin-server/.env before deploying anywhere real.'
  );
}

// Step 1: request a code. Always returns the same generic response whether
// the email is a known admin or not, so this endpoint can't be used to
// enumerate which emails are admins.
router.post('/request-otp', async (req, res) => {
  const { email } = req.body || {};
  const result = issueOtp(email);

  if (result.ok) {
    try {
      await sendOtpEmail(result.email, result.code, result.ttlMs);
    } catch (error) {
      console.error('[auth] Failed to send OTP email:', error.message);
      return res.status(502).json({ error: 'Failed to send email. Check the server\'s Zoho SMTP configuration.' });
    }
  } else if (result.reason === 'cooldown') {
    return res.status(429).json({ error: 'Please wait before requesting another code.', retryAfterMs: result.retryAfterMs });
  }
  // 'not_admin' and 'invalid_email' fall through to the same generic success
  // response as a real send — deliberately indistinguishable from outside.

  res.json({ ok: true, message: 'If that email is registered, a code has been sent.' });
});

// Step 2: verify the code and issue a session cookie.
router.post('/verify-otp', (req, res) => {
  const { email, code } = req.body || {};
  const result = verifyOtp(email, code);

  if (!result.ok) {
    const messages = {
      no_pending_code: 'No code was requested for this email, or it already expired.',
      too_many_attempts: 'Too many incorrect attempts. Request a new code.',
      expired: 'This code has expired. Request a new one.',
      incorrect: 'Incorrect code.'
    };
    return res.status(401).json({ error: messages[result.reason] || 'Verification failed.' });
  }

  const token = jwt.sign({ email: result.email }, JWT_SECRET, { expiresIn: SESSION_TTL });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: req.secure,
    maxAge: 12 * 60 * 60 * 1000
  });
  res.json({ ok: true, email: result.email });
});

router.post('/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'Not signed in' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    res.json({ email: payload.email });
  } catch (error) {
    res.status(401).json({ error: 'Session expired' });
  }
});

/** Express middleware: blocks the request unless a valid admin session cookie is present. */
function requireAdmin(req, res, next) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'Not signed in' });
  try {
    req.admin = jwt.verify(token, JWT_SECRET);
    next();
  } catch (error) {
    res.status(401).json({ error: 'Session expired' });
  }
}

module.exports = { router, requireAdmin, JWT_SECRET };
