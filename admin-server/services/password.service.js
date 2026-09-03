/**
 * Password hashing for admins who opt into password login (OTP remains the
 * default and always-available method -- see routes/auth.js). Uses Node's
 * built-in scrypt rather than adding bcrypt/bcryptjs as a dependency: no
 * native compilation step, nothing extra to install, and scrypt is a
 * modern, memory-hard KDF suitable for password storage.
 */
const crypto = require('crypto');

const KEY_LENGTH = 64;

/** Returns a single string ("salt:hash", both hex) safe to store in one column. */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, KEY_LENGTH).toString('hex');
  return `${salt}:${hash}`;
}

/** `stored` is the "salt:hash" string from hashPassword(). Constant-time compare. */
function verifyPassword(password, stored) {
  if (!password || !stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const candidate = crypto.scryptSync(password, salt, KEY_LENGTH);
  const expected = Buffer.from(hash, 'hex');
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

module.exports = { hashPassword, verifyPassword };
