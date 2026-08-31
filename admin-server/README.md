# Offshoremitra Admin Panel

Backend + admin panel for the Meeting Copilot product. Provides OTP-based
admin login (no passwords, no self-signup), feature-flag control, and
centralized API key management — so end users of the deployed product only
ever get the finished feature, never the configuration behind it.

## What's here

- **OTP login** — an admin allowlisted by email requests a 6-digit code,
  receives it by email (or sees it printed to this server's console in dev
  mode, before Zoho SMTP is configured), and signs in. Sessions are signed
  JWT cookies, 12h expiry.
- **Feature flags** — turn product features (Listen, Auto-watch, Zoom bot,
  Minutes of Meeting, screenshot capture) on/off globally.
- **API key / provider config** — Gemini key, Azure Speech key/region,
  Whisper model/language, stored server-side. Secrets are masked in the UI
  (only the last 4 characters show) and never re-sent in full once saved.
- **Admin management** — add/remove admin emails from the dashboard itself,
  after the first admin exists.

## Setup

```bash
cd admin-server
npm install
cp .env.example .env
# generate a real session secret:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# paste it into .env as JWT_SECRET

# Bootstrap the first admin (there's no self-signup by design):
node seed-admin.js you@offshoremitra.com

npm start
```

Open `http://localhost:4500`. With Zoho SMTP left unconfigured, OTP codes
print to the server console instead of being emailed — enough to build and
test the whole flow before real credentials exist.

## Connecting real Zoho email

The company uses Zoho Mail. To send real OTP emails:

1. In Zoho Mail, generate an **app-specific password** for the mailbox
   that will send OTPs (Zoho requires this instead of the account password
   once 2FA is on): https://accounts.zoho.com/home#security/app-passwords
2. Set in `.env`:
   ```
   ZOHO_SMTP_USER=otp@offshoremitra.com
   ZOHO_SMTP_PASS=<the app password>
   ```
   (Use `smtp.zoho.in` or `smtp.zoho.eu` for `ZOHO_SMTP_HOST` instead of
   `smtp.zoho.com` if the account is on India/EU data centers.)
3. Restart the server. The dashboard's warning banner disappears once
   `ZOHO_SMTP_USER`/`ZOHO_SMTP_PASS` are both set.

## Deploying to the web

This is a normal Node/Express app — no Docker required. Recommended path is
Render.com:

1. Push this repo to GitHub (if it isn't already).
2. In Render: **New → Blueprint**, point it at the repo. Render reads
   [`render.yaml`](render.yaml) and provisions the service automatically, on
   Render's **free** plan.
3. In Render's dashboard, set these secret env vars (deliberately not in
   `render.yaml` since that file is meant to be committed to git):
   - `JWT_SECRET` — generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
   - `ZOHO_SMTP_USER` / `ZOHO_SMTP_PASS` — see the Zoho section above
   - `BOOTSTRAP_ADMIN_EMAIL` — your own email, so the first admin exists
     without needing shell access to run `seed-admin.js` (cheaper plans
     often don't include a shell). Safe to leave set permanently — it's a
     no-op once that email already exists.
4. Deploy. Visit the Render-provided URL (or point your own domain at it via
   Render's custom domain settings) — HTTPS is automatic.

**Free tier tradeoff:** the free plan has no persistent disk, so the SQLite
file resets to empty on every restart, redeploy, or wake from the free
tier's inactivity sleep — in practice this mostly means feature-flag/API-key
settings reset to their defaults. Your own login keeps working regardless,
since `BOOTSTRAP_ADMIN_EMAIL` re-seeds it on every startup. When you're ready
for settings to actually persist, switch `plan: free` to `plan: starter` in
[`render.yaml`](render.yaml) and add a `disk:` block back (see that file's
git history for the exact block) — nothing else needs to change.

A [`Dockerfile`](Dockerfile) is also included for platforms that require a
container instead of a native Node runtime. **Caveat:** I don't have Docker
available in the environment this was built in, so unlike everything else
in this project, that Dockerfile has not actually been build-tested — treat
it as a reasonable starting point, not verified working, and test it before
relying on it.

## What this does NOT do yet

This is the foundation only, scoped deliberately to match the priority
picked when this was built. Still to do, in rough order:

1. **Wire the desktop app to this backend.** Right now the Electron app
   still reads its own local `.env` — it doesn't yet fetch config or
   feature flags from here. That's the next integration step: an endpoint
   the app calls at startup (e.g. `GET /api/config`) to pull its Gemini
   key and feature-flag state instead of a local file, so an admin toggling
   a flag here actually changes what end users can do.
2. **The three deployment targets** (Windows .exe, Mac .dmg, real in-browser
   web app) are separate, large pieces of work not started yet — the web
   app in particular needs screen/system-audio capture and Whisper
   transcription rearchitected to run server-side, since browsers can't do
   what Electron does here.
3. **Production hardening**: rate-limiting beyond the basic per-email OTP
   cooldown, HTTPS/reverse-proxy setup, moving off SQLite if concurrent
   write load ever becomes real, encrypting secrets at rest (currently
   stored as plaintext in the SQLite file, only masked in the UI response).
