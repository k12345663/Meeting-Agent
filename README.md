# Meeting Copilot

An Electron desktop app (Windows + macOS) that sits alongside a live meeting,
transcribes it locally, watches for questions directed at the user, and
answers them with Google Gemini — plus screenshot-based Q&A, a Zoom bot that
can join a call on its own, and automatic Minutes of Meeting generation.

All configuration (API keys, which features are turned on, who's allowed to
sign in) is managed centrally from a small hosted **admin panel**
([`admin-server/`](admin-server/)), not by end users editing local files. An
end user just installs the app, signs in with their work email, and gets
whatever the admin has configured — no API keys to obtain or paste in
themselves.

- **How everything works internally** (speech pipeline, LLM pipeline, screen
  capture, Zoom bot, admin panel wiring): see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- **How to deploy / operate this in production**, including moving the admin
  panel's storage onto real persistent infrastructure (AWS or otherwise):
  see [docs/DEVOPS.md](docs/DEVOPS.md)
- **Admin panel specifics** (env vars, OTP/password login, Zoho email setup):
  see [admin-server/README.md](admin-server/README.md)

## Features

| Feature | What it does |
|---|---|
| **Listen** | Captures microphone + system audio and transcribes it locally (no audio ever leaves the machine for transcription). |
| **Meeting mode Q&A** | Watches the live transcript, detects when someone asks the user a direct question, and proactively answers it with Gemini. |
| **Screenshot / Ask AI** | Capture the screen and ask Gemini about whatever's on it (code, a slide, an error message). |
| **Zoom bot** | Can join a Zoom meeting on the user's behalf as a silent participant to capture audio for transcription. |
| **Minutes of Meeting** | Generates a formal MoM (attendees, agenda, decisions, action items) from the session transcript afterward. |
| **Session summary** | A narrative recap of the whole session, diarized by speaker where available. |

Every feature above is a **feature flag** an admin can turn on/off globally
from the dashboard — an end user never sees a flag that's off, the action
just isn't available.

## Tech stack

- **Desktop app**: Electron 29, vanilla JS/HTML/CSS (no frontend framework),
  Node.js main process
- **Speech-to-text**: [whisper.cpp](https://github.com/ggml-org/whisper.cpp)
  bundled as a native binary (default, fully offline) or Azure Speech SDK
  (optional, cloud-based, admin-configurable)
- **LLM**: Google Gemini via `@google/genai`
- **Admin panel backend**: Node.js + Express + SQLite (`better-sqlite3`),
  JWT session cookies, OTP email login (Zoho SMTP) with an optional
  password fallback
- **Packaging**: `electron-builder` → `.dmg`/`.zip` (macOS, universal
  arm64+x64), `.exe`/NSIS installer (Windows), `.AppImage`/`.deb` (Linux)
- **Hosting (current)**: admin panel on [Render](https://render.com); see
  [docs/DEVOPS.md](docs/DEVOPS.md) for moving this to AWS with real
  persistent storage

## Repository layout

```
main.js                    Electron main process — app lifecycle, IPC, orchestration
preload.js                 contextBridge API surface exposed to renderer windows
index.html, unified.html,  Renderer windows (main UI, chat, settings, onboarding, ...)
settings.html, chat.html,
onboarding.html, ...
src/
  core/                     config, logging, first-run/onboarding, whisper installer
  managers/                 window.manager.js (window lifecycle), session.manager.js
  services/                 speech, LLM, screen capture, Zoom bot, admin-client, export
  ui/                       per-window renderer glue
  preload/                  preload script used inside the injected Zoom bot page
scripts/                    build-time helpers (download-whisper-model.js, packaging hooks)
resources/whisper-cpp/      bundled whisper.cpp binaries + model, per platform
admin-server/               the admin panel — see admin-server/README.md
docs/                       ARCHITECTURE.md, DEVOPS.md (this repo's other two docs)
```

## Prerequisites

- Node.js 18+ and npm
- macOS or Windows to build/run the desktop app (Linux is supported at
  runtime but its whisper.cpp binary isn't bundled yet — see
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#platform-support))
- A Google Gemini API key ([aistudio.google.com/apikey](https://aistudio.google.com/apikey))
  if running the desktop app standalone without the admin panel

## Quick start (desktop app, local dev)

```bash
git clone https://github.com/Offshore-Mitra/meeting-copilot.git
cd meeting-copilot
npm install
cp env.example .env
# edit .env: at minimum set GEMINI_API_KEY, or point ADMIN_SERVER_URL at a
# running admin-server instance and sign in through the app instead
npm start
```

`npm run dev` runs the same thing with `--no-sandbox --disable-gpu`, useful
on Linux dev machines or in a VM where the sandbox/GPU process is flaky.

### Running the admin panel locally

```bash
cd admin-server
npm install
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"  # paste as JWT_SECRET
node seed-admin.js you@yourcompany.com   # bootstrap the first admin
npm start
```

Open `http://localhost:4500`. Full details (Zoho email setup, password
login, feature flags, deploying) are in
[admin-server/README.md](admin-server/README.md).

## Building installers

```bash
npm run build:mac      # .dmg + .zip, universal (arm64 + x64)
npm run build:win      # NSIS .exe installer
npm run build:linux    # .AppImage + .deb
npm run build:all      # all three
```

Each build target first runs `scripts/download-whisper-model.js` to fetch
the bundled Whisper model, then invokes `electron-builder`. Output lands in
`dist/`. See [docs/DEVOPS.md](docs/DEVOPS.md) for the CI (GitHub Actions)
setup that does this automatically.

## Configuration

The desktop app is configured from two possible sources, in this order of
precedence at runtime:

1. **The admin panel** (`ADMIN_SERVER_URL`, default: the hosted instance) —
   on every launch the app signs in as an allowlisted end user and fetches
   live Gemini/Azure keys + feature flags. This is the normal path for any
   real user and needs no local `.env` at all.
2. **Local `.env`** (see [`env.example`](env.example)) — only used as a
   fallback if the admin server is unreachable and nothing has ever been
   cached locally. Not the supported path for end users; useful for
   standalone development.

Whisper's model/language are the one exception — they're baked into the
installer at build time, not fetched live. See
[admin-server/README.md](admin-server/README.md#desktop-app-integration)
for why, and the workaround.

## License

See [LICENSE](LICENSE). © Offshoremitra.
