# DevOps: Deploying & Operating Meeting Copilot

There are **two independent things** to deploy, and they don't share
infrastructure:

1. **The admin panel backend** (`admin-server/`) — a small always-on Node
   service. Every installed copy of the desktop app phones home to this on
   every launch.
2. **The desktop app itself** — built into installers (`.dmg`/`.exe`/etc.)
   and handed to end users; it isn't "deployed" to a server at all.

This doc covers both, plus the thing most worth fixing next: giving the
admin panel **real persistent storage** instead of the free-tier setup it
runs on today.

## Current state (as of this handover)

- Admin panel: deployed on **Render** (free plan), auto-deploying from the
  `feature/bundled-whisper-admin-panel-ci` branch of the GitHub repo, at
  `https://offshoremitra-admin.onrender.com`.
- Desktop app: built via **GitHub Actions** (`.github/workflows/release.yml`)
  for **Windows and Linux only** — pushing a `v*` tag builds both and
  attaches installers to a GitHub Release automatically. **macOS is not in
  that CI matrix** (electron-builder needs a real Mac to produce a
  installer without a lot of extra cross-compile tooling this repo doesn't
  set up) — build the `.dmg` locally on a Mac with `npm run build:mac` and
  attach it to the release by hand.
- Neither the app nor the CI does code signing (`CSC_IDENTITY_AUTO_DISCOVERY:
  false`) — installers are unsigned. Windows/macOS will show an
  "unidentified developer" warning on first run. Getting real code-signing
  certificates is a separate, unstarted piece of work.

## Part 1 — Deploying the admin panel (current: Render)

This is already set up and working; day-to-day you mostly just push to the
tracked branch and Render redeploys automatically. To do it from scratch,
or to redeploy to a fresh Render account:

1. Push this repo to GitHub (already done —
   [Offshore-Mitra/meeting-copilot](https://github.com/Offshore-Mitra/meeting-copilot)).
2. In Render: **New → Blueprint**, point it at the repo. Render reads
   [`render.yaml`](../render.yaml) (repo root) and provisions the service —
   this is a plain Node web service, `rootDir: admin-server`, `npm install`
   / `npm start`, no Docker.
3. Set the secret env vars Render's dashboard needs (deliberately not in
   `render.yaml`, which is committed to git) — see the
   [full env var reference](#environment-variables-reference) below.
4. Deploy. HTTPS is automatic on Render's provided URL.

Full admin-panel-specific detail (OTP/password login, Zoho SMTP setup,
dashboard walkthrough) is in
[admin-server/README.md](../admin-server/README.md) — this doc only covers
the infra/hosting side.

### The free-tier problem (read this before you assume something is broken)

Render's **free** plan has no persistent disk. The admin panel's SQLite
file resets to empty every time the instance restarts, redeploys, or wakes
from the free tier's inactivity sleep (~15 minutes idle). In practice that
means every admin, every allowlisted app user, and every saved API key
periodically vanishes and has to be re-entered — which looks exactly like
"the dashboard isn't saving anything," even though saving works fine in
the moment.

**The current workaround**: `BOOTSTRAP_*` environment variables
(`BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_APP_USER_EMAIL`,
`BOOTSTRAP_GEMINI_API_KEY`, and a few more — see the reference table below)
re-seed the critical rows from env vars on every boot, so the important
stuff survives even though the underlying file doesn't. This is a
reasonable stopgap, **not** a real fix — anything an admin changes from
the dashboard that *isn't* covered by a `BOOTSTRAP_*` var (e.g. toggling a
feature flag, or a key not mirrored into an env var) still resets on the
next restart.

The real fix is persistent storage, covered next.

## Part 2 — Real persistent storage

Three options, cheapest/least-effort first. All three need **zero code
changes** beyond what's already shipped — `admin-server/db.js` reads an
optional `DATA_DIR` environment variable and puts the SQLite file there;
point it at whatever real storage you pick and the app doesn't care.

### Option A — Render paid plan + disk (least effort, stay on Render)

If moving off Render isn't otherwise necessary, this is a five-minute
change: upgrade the service from **Free** to **Starter** and attach a
Render **Disk**, mounted at e.g. `/var/data`. Then either set `DATA_DIR=/var/data`
as an env var, or just mount the disk at `admin-server/data` directly (same
effect, no env var needed). Render's own disk docs:
https://render.com/docs/disks. No AWS, no new infrastructure to operate.

### Option B — AWS EC2 + EBS volume (recommended if moving to AWS)

This mirrors the app's existing assumptions (a single Node process, a
file-based SQLite database) almost exactly, so it's the lowest-risk AWS
path — one instance, one attached volume, done.

**What you're building:** one small EC2 instance running the Node
process under `systemd` (so it restarts on crash/reboot automatically),
behind Nginx for TLS termination, with the SQLite file living on a
separate EBS volume that survives instance stop/start/replace.

#### Step by step

1. **Launch the instance.**
   - AMI: Amazon Linux 2023 (or Ubuntu 22.04 — adjust package manager
     commands below accordingly).
   - Instance size: `t3.micro` or `t4g.micro` is genuinely enough for this
     workload (a handful of admins, low request volume).
   - Security group: allow inbound `22` (SSH, ideally restricted to your
     office/VPN IP), `80` and `443` (HTTP/HTTPS), nothing else.

2. **Create and attach a persistent EBS volume** for the database (keeping
   it separate from the root volume means you can terminate/replace the
   instance later without touching the data):
   - EC2 Console → Volumes → Create volume (8 GiB `gp3` is overkill for a
     SQLite file this small, but it's EBS's practical minimum-cost size;
     don't bother sizing this up).
   - Attach it to the instance (e.g. as `/dev/sdf`, which Linux typically
     exposes as `/dev/nvme1n1` or `/dev/xvdf`).

3. **Format and mount the volume** (first time only — skip `mkfs` if
   you're reattaching an existing volume with data already on it):
   ```bash
   # find the device name Linux actually gave it
   lsblk

   sudo mkfs -t ext4 /dev/nvme1n1          # first-time only — this erases the volume
   sudo mkdir -p /mnt/data
   sudo mount /dev/nvme1n1 /mnt/data

   # make the mount survive a reboot
   echo '/dev/nvme1n1  /mnt/data  ext4  defaults,nofail  0  2' | sudo tee -a /etc/fstab
   ```

4. **Install Node.js** (match the version CI uses — Node 20):
   ```bash
   curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -   # Amazon Linux
   sudo dnf install -y nodejs git nginx
   ```

5. **Clone the repo and install dependencies:**
   ```bash
   sudo mkdir -p /opt/meeting-copilot
   sudo chown $USER:$USER /opt/meeting-copilot
   git clone https://github.com/Offshore-Mitra/meeting-copilot.git /opt/meeting-copilot
   cd /opt/meeting-copilot/admin-server
   npm install --omit=dev
   ```

6. **Point the database at the persistent volume and configure secrets** —
   create `/opt/meeting-copilot/admin-server/.env`:
   ```bash
   PORT=4500
   DATA_DIR=/mnt/data/admin-server
   JWT_SECRET=<paste output of: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))">
   BOOTSTRAP_ADMIN_EMAIL=you@yourcompany.com
   BOOTSTRAP_APP_USER_EMAIL=you@yourcompany.com
   ZOHO_SMTP_HOST=smtp.zoho.com
   ZOHO_SMTP_PORT=465
   ZOHO_SMTP_USER=otp@yourcompany.com
   ZOHO_SMTP_PASS=<Zoho app-specific password>
   OTP_FROM_NAME=Your Company Admin
   ```
   With real persistent storage, the `BOOTSTRAP_*` re-seeding vars stop
   being load-bearing (data no longer disappears on restart) — leave them
   set anyway as a safety net; they're no-ops once the row already exists.

7. **Run it as a systemd service** so it survives reboots and restarts on
   crash — create `/etc/systemd/system/meeting-copilot-admin.service`:
   ```ini
   [Unit]
   Description=Meeting Copilot admin panel
   After=network.target

   [Service]
   Type=simple
   WorkingDirectory=/opt/meeting-copilot/admin-server
   ExecStart=/usr/bin/node server.js
   Restart=on-failure
   User=ec2-user
   EnvironmentFile=/opt/meeting-copilot/admin-server/.env

   [Install]
   WantedBy=multi-user.target
   ```
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now meeting-copilot-admin
   sudo systemctl status meeting-copilot-admin   # confirm it's running
   ```

8. **Put Nginx in front for TLS** — point your domain (e.g.
   `admin.yourcompany.com`) at the instance's IP, then:
   ```nginx
   # /etc/nginx/conf.d/meeting-copilot-admin.conf
   server {
       listen 80;
       server_name admin.yourcompany.com;
       location / {
           proxy_pass http://127.0.0.1:4500;
           proxy_set_header Host $host;
           proxy_set_header X-Real-IP $remote_addr;
       }
   }
   ```
   ```bash
   sudo systemctl enable --now nginx
   sudo dnf install -y certbot python3-certbot-nginx
   sudo certbot --nginx -d admin.yourcompany.com   # gets + auto-renews a real cert
   ```

9. **Point the desktop app at the new URL** — set `ADMIN_SERVER_URL` in the
   app's build/env to `https://admin.yourcompany.com` (see
   [env.example](../env.example) at the repo root) before building the next
   round of installers.

10. **Back it up.** The whole point of this move is that the data now
    persists — protect it from instance/volume loss too: EC2 Console →
    Volumes → your volume → **Create snapshot**, or automate it with AWS
    Backup on a daily schedule targeting that volume's tag. A snapshot
    restore is how you recover if the instance itself is ever lost.

#### Updating the deployed code later

```bash
cd /opt/meeting-copilot
git pull
cd admin-server && npm install --omit=dev
sudo systemctl restart meeting-copilot-admin
```

The database on `/mnt/data` is untouched by any of this — that's the
entire point of moving it off the instance's own disk.

### Option C — Managed database (best long-term, more work)

If concurrent admin usage or write volume ever becomes real (unlikely at
this app's current scale — it's a handful of admins clicking Save
occasionally), the more "correct" AWS path is: run the Node app on
**Elastic Beanstalk** or **ECS Fargate** (so the compute layer is
stateless and disposable) and swap SQLite for **Amazon RDS (Postgres)**.
That requires replacing `better-sqlite3` with a Postgres client and
rewriting the raw-SQL calls in `admin-server/db.js` and the route files —
real code work, not a config change, and not something this handover
includes. Flagging it here as the eventual direction, not a checklist
item to do now. Option B above (EC2 + EBS) is the right-sized fix for the
app as it exists today.

## Part 3 — Building & releasing the desktop app

**Automated (Windows + Linux):**
```bash
git tag v1.9.0
git push origin v1.9.0
```
This triggers `.github/workflows/release.yml`, which builds both
platforms and creates a GitHub Release with the installers attached
(`--publish never` is passed to `electron-builder` itself; the workflow's
own release step does the actual GitHub Release creation).

**Manual (macOS — not in CI):**
```bash
npm run build:mac
```
Run this on an actual Mac (Apple Silicon or Intel — `electron-builder` is
configured to produce a universal binary covering both from either host).
Output lands in `dist/`; upload the `.dmg` to the same GitHub Release by
hand.

**Local test build of any platform**, without touching CI or tags:
```bash
npm run build:mac    # or build:win / build:linux / build:all
```

## Environment variables reference

### Desktop app (`.env` at repo root — see [env.example](../env.example))

| Variable | Required? | Purpose |
|---|---|---|
| `ADMIN_SERVER_URL` | No | Overrides which admin panel instance the app signs into. Defaults to the hosted one. |
| `GEMINI_API_KEY` | No | Fallback only, used if the admin server is unreachable and nothing is cached yet. Normally irrelevant — the admin panel supplies this. |
| `SPEECH_PROVIDER`, `AZURE_SPEECH_*`, `WHISPER_*` | No | Same story — admin-panel-managed in normal operation; see [env.example](../env.example) for the full list of local-dev knobs. |

### Admin server (`admin-server/.env` — see [admin-server/.env.example](../admin-server/.env.example))

| Variable | Required? | Purpose |
|---|---|---|
| `PORT` | No (default `4500`) | What port the server listens on. |
| `DATA_DIR` | No | Where the SQLite file lives. Unset = a folder next to `db.js` (fine for local dev, **not** for any host without a persistent disk). Set this to your mounted EBS path / Render disk path in production. |
| `JWT_SECRET` | **Yes** | Signs admin session cookies. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Never commit this. |
| `BOOTSTRAP_ADMIN_EMAIL` | Recommended | Comma-separated list of emails seeded as admins on every boot. Without this, a fresh/wiped deploy has zero admins and no self-signup path. |
| `BOOTSTRAP_APP_USER_EMAIL` | Recommended | Same, for the desktop-app sign-in allowlist. |
| `BOOTSTRAP_GEMINI_API_KEY` / `BOOTSTRAP_AZURE_SPEECH_KEY` / `BOOTSTRAP_AZURE_SPEECH_REGION` / `BOOTSTRAP_SPEECH_PROVIDER` / `BOOTSTRAP_WHISPER_MODEL` / `BOOTSTRAP_WHISPER_LANGUAGE` | No | Re-seed the corresponding dashboard setting on every boot. Matters most without real persistent storage (Part 2); harmless no-ops once `DATA_DIR` points at real storage and the value already matches. |
| `ZOHO_SMTP_HOST` / `_PORT` / `_USER` / `_PASS` | No (recommended) | Real OTP emails via Zoho. Unset = OTP codes print to server console/logs instead — fine for testing, not for real users who can't see your server logs. |
| `OTP_FROM_NAME` | No | Display name on OTP emails. |

**Never commit real values for `JWT_SECRET`, `ZOHO_SMTP_PASS`, or any
`BOOTSTRAP_*` API key** — set these directly in Render's dashboard / the
EC2 instance's `.env` (which is gitignored), never in `render.yaml` or any
file tracked by git.

## Operational notes

- **Logs**: Render → service → Logs tab (or `journalctl -u
  meeting-copilot-admin -f` on the EC2 path). `[bootstrap] ...` lines on
  startup confirm which env-var seeding actually ran; watch for these
  after any redeploy to confirm settings survived.
- **Rotating `JWT_SECRET`**: invalidates every existing admin session
  immediately (everyone has to sign in again) — fine to do, just expect
  the support question afterward.
- **Rotating the Gemini key**: no restart needed — save it in the
  dashboard and every signed-in app picks it up on its next config fetch
  (see [ARCHITECTURE.md](ARCHITECTURE.md#admin-panel-integration)).
- **Health check**: `GET /health` returns `{"ok": true}` — this is what
  Render's `healthCheckPath` polls; use the same URL for any external
  uptime monitor.
