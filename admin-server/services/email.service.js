/**
 * OTP email delivery via Zoho Mail SMTP (the company's existing email
 * provider). Falls back to logging the code to the console when SMTP
 * credentials aren't configured yet, so the whole auth flow can be built and
 * tested end-to-end before real credentials are available — the caller
 * doesn't need to know which mode is active.
 */
const nodemailer = require('nodemailer');

const {
  ZOHO_SMTP_HOST = 'smtp.zoho.com',
  ZOHO_SMTP_PORT = '465',
  ZOHO_SMTP_USER,   // full Zoho email address to send FROM, e.g. otp@offshoremitra.com
  ZOHO_SMTP_PASS,   // Zoho app-specific password (Zoho requires this over the account password once 2FA is on)
  OTP_FROM_NAME = 'Offshoremitra Admin'
} = process.env;

const isConfigured = !!(ZOHO_SMTP_USER && ZOHO_SMTP_PASS);

let transporter = null;
if (isConfigured) {
  transporter = nodemailer.createTransport({
    host: ZOHO_SMTP_HOST,
    port: Number(ZOHO_SMTP_PORT),
    secure: Number(ZOHO_SMTP_PORT) === 465,
    auth: { user: ZOHO_SMTP_USER, pass: ZOHO_SMTP_PASS }
  });
}

async function sendOtpEmail(toEmail, code, ttlMs) {
  const minutes = Math.round(ttlMs / 60000);

  if (!isConfigured) {
    // Dev mode: no real email provider wired up yet. Loud and unmistakable
    // in the server log so it's never confused for a real delivery.
    console.log('\n' + '='.repeat(60));
    console.log(`[DEV MODE — NO EMAIL SENT] OTP for ${toEmail}: ${code}`);
    console.log(`Valid for ${minutes} minutes. Set ZOHO_SMTP_USER/ZOHO_SMTP_PASS in .env to send real emails.`);
    console.log('='.repeat(60) + '\n');
    return { sent: false, devMode: true };
  }

  await transporter.sendMail({
    from: `"${OTP_FROM_NAME}" <${ZOHO_SMTP_USER}>`,
    to: toEmail,
    subject: `Your admin sign-in code: ${code}`,
    text: `Your sign-in code is ${code}. It expires in ${minutes} minutes. If you didn't request this, ignore this email.`,
    html: `
      <div style="font-family: -apple-system, sans-serif; max-width: 420px; margin: auto;">
        <h2 style="margin-bottom: 4px;">Your sign-in code</h2>
        <p style="color: #555;">Use this code to sign in to the admin panel. It expires in ${minutes} minutes.</p>
        <div style="font-size: 32px; font-weight: 700; letter-spacing: 6px; background: #f4f4f5; padding: 16px 24px; border-radius: 8px; text-align: center; margin: 16px 0;">
          ${code}
        </div>
        <p style="color: #999; font-size: 12px;">If you didn't request this, you can safely ignore this email.</p>
      </div>
    `
  });
  return { sent: true, devMode: false };
}

module.exports = { sendOtpEmail, isConfigured };
