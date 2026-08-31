/**
 * Bootstrap script: adds an email to the admins allowlist directly, since
 * there's no self-signup by design. Needed once to create the very first
 * admin (after that, the dashboard's own "Add admin" form handles the rest).
 *
 * Usage: node seed-admin.js someone@offshoremitra.com
 */
const { db } = require('./db');

const email = String(process.argv[2] || '').trim().toLowerCase();
if (!email || !email.includes('@')) {
  console.error('Usage: node seed-admin.js someone@offshoremitra.com');
  process.exit(1);
}

try {
  db.prepare('INSERT INTO admins (email) VALUES (?)').run(email);
  console.log(`Added admin: ${email}`);
} catch (error) {
  if (String(error.message).includes('UNIQUE')) {
    console.log(`${email} is already an admin.`);
  } else {
    console.error('Failed to add admin:', error.message);
    process.exit(1);
  }
}
