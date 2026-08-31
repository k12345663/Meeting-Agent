require('dotenv').config();
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const { db } = require('./db'); // initializes the SQLite schema on first run

// Optional first-admin bootstrap via env var, for hosting platforms where
// getting a shell into the running container to run seed-admin.js isn't
// available on cheaper plans. Idempotent — safe to leave set across
// restarts/redeploys, it just no-ops once that email already exists.
if (process.env.BOOTSTRAP_ADMIN_EMAIL) {
  const email = String(process.env.BOOTSTRAP_ADMIN_EMAIL).trim().toLowerCase();
  try {
    db.prepare('INSERT INTO admins (email) VALUES (?)').run(email);
    console.log(`[bootstrap] Added admin from BOOTSTRAP_ADMIN_EMAIL: ${email}`);
  } catch (error) {
    if (!String(error.message).includes('UNIQUE')) {
      console.error('[bootstrap] Failed to add BOOTSTRAP_ADMIN_EMAIL:', error.message);
    }
    // already exists — nothing to do
  }
}

const { router: authRouter } = require('./routes/auth');
const adminRouter = require('./routes/admin');

const app = express();
const PORT = process.env.PORT || 4500;

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/auth', authRouter);
app.use('/api/admin', adminRouter);

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Admin panel server listening on http://localhost:${PORT}`);
});
