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
