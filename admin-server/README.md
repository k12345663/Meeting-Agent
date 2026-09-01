# Offshoremitra Admin Panel

Backend + admin panel for the Meeting Copilot product. Provides OTP-based
admin login (no self-signup — every admin is explicitly allowlisted),
feature-flag control, and centralized API key management — so end users of
the deployed product only ever get the finished feature, never the
configuration behind it.

## What's here

- **OTP login** — an admin allowlisted by email requests a 6-digit code,
  receives it by email (or sees it printed to this server's console in dev
  mode, before Zoho SMTP is configured), and signs in. Sessions are signed
  JWT cookies, 12h expiry.
- **Optional password login** — an admin can set their own password from
  the dashboard (**My Password** section) as a faster alternative to
  waiting for a code; OTP always still works too, even after setting one.
  Self-service only: nobody, including another admin, ever sets or sees
  anyone else's password. Hashed with Node's built-in `scrypt` (salted,
  never stored in plaintext), 10-character minimum enforced server-side.
  Login failures for a wrong password, an unset password, and an unknown
  email all return the identical generic error — this endpoint can't be
  used to check which emails are admins or which admins have a password.
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
   [`render.yaml`](../render.yaml) and provisions the service automatically, on
   Render's **free** plan.
3. In Render's dashboard, set these secret env vars (deliberately not in
   `render.yaml` since that file is meant to be committed to git):
   - `JWT_SECRET` — generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
   - `ZOHO_SMTP_USER` / `ZOHO_SMTP_PASS` — see the Zoho section above
   - `BOOTSTRAP_ADMIN_EMAIL` — comma-separated list of admin emails to
     seed on every startup, so admins exist without needing shell access
     to run `seed-admin.js` (cheaper plans often don't include a shell).
     Safe to leave set permanently — a no-op for any email that already
     exists.
   - `BOOTSTRAP_APP_USER_EMAIL` — same idea, comma-separated, but for the
     App Users allowlist (desktop app sign-in) instead of Admin Access.
     Matters even more on the free plan: admins re-seed themselves via
     the var above and can always get back into the dashboard to fix
     things, but app users have no such recovery path — without this,
     every restart/redeploy silently locks every app user out until an
     admin manually re-adds them from the dashboard.
4. Deploy. Visit the Render-provided URL (or point your own domain at it via
   Render's custom domain settings) — HTTPS is automatic.

**Free tier tradeoff:** the free plan has no persistent disk, so the SQLite
file resets to empty on every restart, redeploy, or wake from the free
tier's inactivity sleep — in practice this mostly means feature-flag/API-key
settings reset to their defaults. Your own login keeps working regardless,
since `BOOTSTRAP_ADMIN_EMAIL` re-seeds it on every startup. When you're ready
for settings to actually persist, switch `plan: free` to `plan: starter` in
[`render.yaml`](../render.yaml) and add a `disk:` block back (see that file's
git history for the exact block) — nothing else needs to change.

A [`Dockerfile`](Dockerfile) is also included for platforms that require a
container instead of a native Node runtime. **Caveat:** I don't have Docker
available in the environment this was built in, so unlike everything else
in this project, that Dockerfile has not actually been build-tested — treat
it as a reasonable starting point, not verified working, and test it before
relying on it.

## Desktop app integration

The Electron app (repo root) is wired to this backend: on every launch it
signs in against `/api/user/request-otp` + `/api/user/verify-otp` (a
lightweight email-only login, separate from the admin allowlist above —
see the **App Users** section of the dashboard to manage who can sign in),
then fetches `/api/user/config` and applies the returned Gemini/Azure keys
and feature flags immediately — no local `.env` editing needed for a
signed-in user. The session token and last-fetched config are cached
locally (in the OS user-data dir) so a flaky connection doesn't strand an
already-working install; disabling a user in the dashboard blocks their
next login and their next config refresh, whichever comes first.

Toggling a feature flag here actually gates the corresponding action in
the app: Listen, Auto-watch, Zoom bot join, Minutes of Meeting, and
Screenshot/Ask AI each check their flag before running.

**Important limit — the Whisper Model/Language fields are not fully live.**
Gemini and Azure Speech keys are genuinely dynamic: change them here and any
signed-in app picks up the new value on its next config fetch, no rebuild.
Whisper is different because the actual model *file* (e.g.
`ggml-small.en.bin`) is downloaded and packaged into the installer at build
time (see `scripts/download-whisper-model.js` and `win.extraResources` /
`mac.extraResources` in the root `package.json`), not fetched at runtime. If
this field is changed to a model that particular build doesn't have bundled,
the app throws `Bundled whisper.cpp model not found for "<model>"` at
transcription time instead of silently doing nothing — a deliberate choice
so a mismatch is loud rather than silently mistranscribing. In practice:
leave this field matching whatever model was actually bundled when the
installer was built, or switch the **Speech Provider** to Azure (fully
dynamic, cloud-based, needs no local model file) if you want the dashboard
to actually control the STT engine choice. Bundling multiple model sizes so
this field could switch freely was considered and deliberately skipped for
now — it would add hundreds of MB to every installer for a need that hasn't
come up yet.

## What this does NOT do yet

This is the foundation only, scoped deliberately to match the priority
picked when this was built. Still to do, in rough order:

1. **The three deployment targets** (Windows .exe, Mac .dmg, real in-browser
   web app) are separate, large pieces of work not started yet — the web
   app in particular needs screen/system-audio capture and Whisper
   transcription rearchitected to run server-side, since browsers can't do
   what Electron does here.
2. **Production hardening**: rate-limiting beyond the basic per-email OTP
   cooldown, HTTPS/reverse-proxy setup, moving off SQLite if concurrent
   write load ever becomes real, encrypting secrets at rest (currently
   stored as plaintext in the SQLite file, only masked in the UI response).
