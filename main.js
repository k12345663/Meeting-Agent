const path = require("path");
const fs = require("fs");
const { fileURLToPath } = require("url");
const { app, BrowserWindow, globalShortcut, session, ipcMain, desktopCapturer } = require("electron");

// ── Resolve a stable .env location ──
// In packaged builds process.cwd() is unstable and frequently read-only
// (NSIS install dir, AppImage mount, .app bundle), so the canonical config
// lives in Electron's userData directory. We still prefer an existing
// project-local .env in development (npm start) so the dev workflow is
// unchanged. Both onboarding (FirstRunManager) and persistEnvUpdates() write
// to this same path so settings survive restarts on every platform.
function resolveEnvPath() {
  try {
    const userDataEnv = path.join(app.getPath("userData"), ".env");
    const projectEnv = path.join(process.cwd(), ".env");
    // Prefer a project .env only when it already exists and userData has none
    // (i.e. a developer running from the repo). Otherwise use userData.
    if (!fs.existsSync(userDataEnv) && fs.existsSync(projectEnv)) {
      return projectEnv;
    }
    return userDataEnv;
  } catch (_) {
    // On packaged macOS builds, process.cwd() may be inside a read-only .app
    // bundle. Fall back to userData so .env writes never fail.
    try {
      return path.join(app.getPath("userData"), ".env");
    } catch (e2) {
      return path.join(process.cwd(), ".env");
    }
  }
}
const ENV_PATH = resolveEnvPath();
require("dotenv").config({ path: ENV_PATH });

// Format a value for a single .env line. Newlines are collapsed to spaces and
// backslashes are kept verbatim (doubling them corrupts Windows paths on the
// next load). Values containing whitespace, a double-quote, or a leading '#'
// are wrapped in single quotes so dotenv parses them as one token — essential
// for Whisper commands like:  "C:\Users\Jane Doe\...\python.exe" -m whisper
function formatEnvValue(raw) {
  const v = String(raw).replace(/[\r\n]+/g, " ").trim();
  if (!/[\s"#]/.test(v)) return v;
  if (!v.includes("'")) return `'${v}'`;
  // Rare: value already contains a single quote — fall back to double quotes.
  return `"${v.replace(/"/g, '\\"')}"`;
}

// ── Linux GPU process crash workaround ──
// On many Linux setups (Wayland, X11 without GPU drivers, Docker, headless,
// or systems with broken Mesa/NVIDIA stacks), Chromium's GPU process crashes
// on startup with:
//   FATAL:gpu_data_manager_impl_private.cc(448)] GPU process isn't usable.
// This kills the entire app and can leave orphan helper processes that
// exhaust the X11 client limit, producing "Maximum number of clients reached".
//
// Disabling hardware acceleration and the GPU subprocess forces Chromium to
// render via the CPU (SwiftShader). AI Copilot's UI is light enough that
// this is imperceptible, and it eliminates the GPU crash entirely.
if (process.platform === "linux") {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-gpu-compositing");
  app.commandLine.appendSwitch("disable-software-rasterizer");
  app.commandLine.appendSwitch("disable-gpu-sandbox");
  // On X11 only; harmless on Wayland. Prevents Chromium from spawning a
  // compositor process that adds another X11 client.
  app.commandLine.appendSwitch("in-process-gpu");
}

// Keep Chromium network noise out of the terminal; app-level logs still go through Winston.
app.commandLine.appendSwitch("log-level", "3");
app.commandLine.appendSwitch("disable-background-networking");
app.commandLine.appendSwitch("disable-component-update");
app.commandLine.appendSwitch("disable-domain-reliability");
app.commandLine.appendSwitch("no-pings");

const logger = require("./src/core/logger").createServiceLogger("MAIN");
const config = require("./src/core/config");
const FirstRunManager = require("./src/core/first-run");

// ── Global crash guard ──
// The speech path spawns external processes (Whisper CLI, and on macOS/Linux
// the sox/rec/arecord recorders via node-record-lpcm16). A missing recorder
// binary makes that library emit an 'error' on its child process with no
// listener, which would otherwise become an uncaughtException and quit the
// entire app the moment the user clicks the mic. We log and stay alive — the
// speech service surfaces a friendly status to the UI instead.
process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception (kept alive)", {
    error: err && err.message,
    stack: err && err.stack,
  });
});
process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled rejection (kept alive)", {
    reason: String((reason && reason.message) || reason),
  });
});

// Services
// Screen capture (image-based)
const captureService = require("./src/services/capture.service");
const speechService = require("./src/services/speech.service");
const llmService = require("./src/services/llm.service");
const zoomBotService = require("./src/services/zoom-bot.service");
const adminClient = require("./src/services/admin-client.service");

// Managers
const windowManager = require("./src/managers/window.manager");
const sessionManager = require("./src/managers/session.manager");

class ApplicationController {
  constructor() {
    this.isReady = false;
    this.starting = false;
    this.activeSkill = "meeting";
  // Default to C++ so language is enforced from first run
  this.codingLanguage = "cpp";
    this.speechAvailable = false;

    // Utterance coalescing: VAD emits a transcript per natural pause, but a
    // single spoken question can still arrive as a few fragments (mid-thought
    // pauses). We buffer fragments and debounce so one question yields one LLM
    // call instead of a fractured mess.
    this._utteranceBuffer = "";
    this._utteranceTimer = null;
    this._utteranceDispatchInFlight = false;
    this._utteranceCoalesceMs = 800;

    // First-run onboarding: detects missing .env / API key and triggers
    // a settings-window prompt on first launch so users don't have to
    // dig through docs to figure out they need a Gemini API key.
    this.firstRunManager = new FirstRunManager({
      logger: logger,
      // .env and the sentinel both live in userData so they survive cwd
      // changes and read-only install dirs (the app may be launched from
      // any directory). ENV_PATH is the same file dotenv loaded at startup
      // and that persistEnvUpdates() writes to.
      envPath: ENV_PATH,
      sentinelPath: path.join(app.getPath("userData"), ".ai-copilot-firstrun-completed"),
    });
    // Lazily-initialised in getWhisperInstaller() so tests can mock
    // the constructor without polluting main-process startup.
    this._whisperInstaller = null;
    this.isFirstRun = false;

    // Window configurations for reference
    this.windowConfigs = {
      main: { title: "AI Copilot" },
      chat: { title: "Chat" },
      llmResponse: { title: "AI Response" },
      settings: { title: "Settings" },
    };

    this.setupStealth();
    this.setupEventHandlers();
  }

  setupStealth() {
    if (config.get("stealth.disguiseProcess")) {
      process.title = config.get("app.processTitle");
    }

    // Set default stealth app name early
    if (app && typeof app.setName === 'function') {
      app.setName("Terminal ");
    }
    process.title = "Terminal ";

    if (
      process.platform === "darwin" &&
      config.get("stealth.noAttachConsole")
    ) {
      process.env.ELECTRON_NO_ATTACH_CONSOLE = "1";
      process.env.ELECTRON_NO_ASAR = "1";
    }
  }

  setupEventHandlers() {
    app.whenReady().then(() => this.onAppReady());
    app.on("window-all-closed", () => this.onWindowAllClosed());
    app.on("activate", () => this.onActivate());
    app.on("will-quit", () => this.onWillQuit());

    this.setupIPCHandlers();
    this.setupServiceEventHandlers();
  }

  handleSecondInstance() {
    logger.info("Second instance launch detected; focusing existing windows");

    const focusExistingWindows = () => {
      try {
        const mainWindow = windowManager.getWindow("main");
        if (mainWindow) {
          if (mainWindow.isMinimized && mainWindow.isMinimized()) {
            mainWindow.restore();
          }
          windowManager.showAllWindows();
          windowManager.showOnCurrentDesktop(mainWindow);
          mainWindow.focus();
          return;
        }

        if (this.isReady) {
          windowManager.showAllWindows();
        }
      } catch (error) {
        logger.error("Failed to focus existing instance", {
          error: error.message,
        });
      }
    };

    if (app.isReady()) {
      focusExistingWindows();
    } else {
      app.whenReady().then(focusExistingWindows);
    }
  }

  async onAppReady() {
    if (this.starting || this.isReady) {
      logger.debug("onAppReady skipped: already starting or ready");
      return;
    }
    this.starting = true;

    // Force stealth mode IMMEDIATELY when app is ready
    app.setName("Terminal ");
    process.title = "Terminal ";

    logger.info("Application starting", {
      version: config.get("app.version"),
      environment: config.get("app.isDevelopment")
        ? "development"
        : "production",
      platform: process.platform,
    });

    try {
      this.setupPermissions();
      this.setupNetworkConfiguration();

      // Small delay to ensure desktop/space detection is accurate
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Admin-managed account gate: confirms this install is signed in
      // against the admin panel and pulls its live API keys/feature flags
      // before anything else starts. Blocks (showing a login window) only
      // when there's no way to proceed — see the method for the offline/
      // cached-config fallback that keeps this from being a hard
      // dependency on the admin server being reachable every launch.
      await this.ensureAccountAuthenticated();

      // First-run onboarding: ensure .env exists and read status once
      // so we can decide whether to defer showing the main overlay.
      //
      // Skipped entirely for anyone signed in via the admin panel --
      // ensureAccountAuthenticated() above is a hard gate, so reaching
      // this line means that already succeeded. This wizard predates the
      // admin panel and asks the person running the app to type in their
      // own Gemini API key; that's wrong for a signed-in user, who should
      // never be prompted for one -- it's the admin's job to set it
      // centrally, not each end user's. If the admin hasn't set one yet,
      // that's a config gap to flag to the admin, not something to solve
      // by asking a random end user to supply a personal key.
      let status;
      if (adminClient.isSignedIn()) {
        status = { needsOnboarding: false };
        this.isFirstRun = false;
      } else {
        try {
          this.firstRunManager.ensureEnv();
          status = this.firstRunManager.getStatus();
          this.isFirstRun = status.needsOnboarding;
          logger.info("First-run status", status);
        } catch (e) {
          logger.warn("First-run check failed", { error: e.message });
          status = { needsOnboarding: false };
          this.isFirstRun = false;
        }
      }
      const isFirstRun = status.needsOnboarding;

      await windowManager.initializeWindows({ showMainWindow: !isFirstRun });
      this.setupGlobalShortcuts();

      // Initialize default stealth mode with terminal icon
      this.updateAppIcon("terminal");

      this.starting = false;
      this.isReady = true;

      // Launch the onboarding wizard if this is the first run.
      if (this.isFirstRun) {
        // Defer slightly so all windows finish loading before we pop
        // the wizard on top of them.
        setTimeout(() => {
          try {
            windowManager.showOnboarding();
            windowManager.broadcastToAllWindows("first-run", status);
            logger.info("First-run onboarding: wizard opened");
          } catch (e) {
            logger.warn("Could not open first-run onboarding window", {
              error: e.message
            });
            // Fallback to legacy settings prompt
            try { this.showSettings(); } catch (_) { /* ignore */ }
          }
        }, 800);
      } else {
        // Already configured — mark completed so we never nag again.
        this.firstRunManager.markCompleted();
        // Show startup window
        setTimeout(() => {
          windowManager.showStartup();
        }, 800);
      }

      logger.info("Application initialized successfully", {
        windowCount: Object.keys(windowManager.getWindowStats().windows).length,
        currentDesktop: "detected",
      });

      sessionManager.addEvent("Application started");
    } catch (error) {
      this.starting = false;
      logger.error("Application initialization failed", {
        error: error.message,
      });
      app.quit();
    }
  }

  /**
   * Confirms this install is signed in with the admin panel and applies
   * whatever config it returns (Gemini/Azure keys, feature flags) before
   * the rest of startup runs. Three outcomes, in priority order:
   *   1. A cached session's token still works -> apply the fresh config.
   *   2. The server is unreachable (offline, DNS, timeout) but we have a
   *      previously-fetched config cached -> apply that and carry on, so
   *      a flaky network doesn't strand a previously-working install.
   *   3. Neither works (never signed in, session expired/revoked, or
   *      unreachable with nothing cached) -> block on the login window.
   */
  async ensureAccountAuthenticated() {
    try {
      const cfg = await adminClient.fetchConfig();
      adminClient.applyConfig(cfg);
      this._persistGeminiKeyIfPresent(cfg);
      logger.info("Account config loaded from admin server", {
        email: adminClient.getSignedInEmail(),
      });
      return;
    } catch (error) {
      if (error.code !== "UNAUTHENTICATED") {
        const cached = adminClient.loadCachedConfig();
        if (cached) {
          adminClient.applyConfig(cached);
          this._persistGeminiKeyIfPresent(cached);
          logger.warn("Admin server unreachable — using cached config", {
            error: error.message,
          });
          return;
        }
        logger.warn("Admin server unreachable and no cached config — requiring login", {
          error: error.message,
        });
      }
    }

    await this._showAccountLoginAndWait();
  }

  /** Writes GEMINI_API_KEY to .env so FirstRunManager's onboarding check
   *  (which only reads the .env file, not process.env) doesn't re-prompt
   *  a user who is already signed in and configured via the admin panel. */
  _persistGeminiKeyIfPresent(cfg) {
    const key = cfg && cfg.settings && cfg.settings.geminiApiKey;
    if (key) {
      try {
        this.persistEnvUpdates({ GEMINI_API_KEY: key });
      } catch (error) {
        logger.warn("Failed to persist Gemini key from admin config", { error: error.message });
      }
    }
  }

  _showAccountLoginAndWait() {
    return new Promise((resolve) => {
      let settled = false;
      windowManager.showAccountLogin({
        onClosed: () => {
          if (settled) return;
          settled = true;
          // Window closed without a successful login (user clicked the
          // close control) -- there is nothing usable to start the app
          // with, so quit rather than opening a half-configured session.
          logger.warn("Account login window closed without signing in — quitting");
          app.quit();
        },
      });

      this._pendingAccountLoginResolve = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
    });
  }

  setupNetworkConfiguration() {
    // Configure session to handle network requests better
    const ses = session.defaultSession;
    
    // Allow HTTPS requests to Google APIs
    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      if (details.url.includes('generativelanguage.googleapis.com')) {
        const platformUA = process.platform === 'darwin'
          ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.6261.156 Safari/537.36'
          : 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.6261.156 Safari/537.36';
        details.requestHeaders['User-Agent'] = platformUA;
      }
      callback({ requestHeaders: details.requestHeaders });
    });
    
    // Handle certificate errors for Google APIs
    ses.setCertificateVerifyProc((request, callback) => {
      if (request.hostname === 'generativelanguage.googleapis.com') {
        callback(0); // Trust Google's certificates
      } else {
        callback(-2); // Use default verification
      }
    });
    
    logger.debug('Network configuration applied for Gemini API');
  }

  setupPermissions() {
    const appSession = session.defaultSession;
    const isTrustedAppContents = (webContents) => {
      if (!webContents || webContents.isDestroyed()) {
        return false;
      }
      try {
        const pagePath = path.resolve(fileURLToPath(webContents.getURL()));
        const appRoot = path.resolve(__dirname);
        const normalizeForComparison = (value) => process.platform === "win32"
          ? value.toLowerCase()
          : value;
        const page = normalizeForComparison(pagePath);
        const root = normalizeForComparison(appRoot + path.sep);
        return page.startsWith(root);
      } catch (_) {
        return false;
      }
    };

    // Electron exposes camera/microphone access as the single `media`
    // permission. The requested device type is provided separately in details.
    appSession.setPermissionCheckHandler(
      (webContents, permission, _requestingOrigin, details = {}) => {
        if (!isTrustedAppContents(webContents)) {
          return false;
        }
        if (permission === "media") {
          return !details.mediaType || details.mediaType === "audio";
        }
        return permission === "display-capture";
      }
    );

    appSession.setPermissionRequestHandler(
      (webContents, permission, callback, details = {}) => {
        let granted = false;
        if (isTrustedAppContents(webContents)) {
          if (permission === "media") {
            const mediaTypes = Array.isArray(details.mediaTypes) ? details.mediaTypes : [];
            granted = mediaTypes.length === 0 || mediaTypes.includes("audio");
          } else {
            granted = permission === "display-capture";
          }
        }

        logger.debug("Permission request", {
          permission,
          mediaTypes: details.mediaTypes || [],
          granted
        });
        callback(granted);
      }
    );

    // System audio loopback — lets the app hear the OTHER side of a meeting
    // (everyone else's voice) when the user is on headphones/AirPods, where a
    // microphone physically cannot pick up anything playing to the ear. This
    // resolves getUserMedia's blind spot without any third-party virtual
    // audio driver: Electron's own display-media handler can request the
    // system's audio output directly via the special 'loopback' device.
    // Video is required by the API shape but never used — the renderer drops
    // the video track immediately and keeps only the audio track.
    appSession.setDisplayMediaRequestHandler(async (request, callback) => {
      // request.frame is a WebFrameMain, not a WebContents — it exposes `.url`
      // directly rather than isTrustedAppContents()'s webContents.getURL()/
      // isDestroyed() shape, so it needs its own trust check.
      try {
        const frameUrl = request.frame && request.frame.url;
        const pagePath = frameUrl ? path.resolve(fileURLToPath(frameUrl)) : null;
        const appRoot = path.resolve(__dirname) + path.sep;
        if (!pagePath || !pagePath.startsWith(appRoot)) {
          callback({});
          return;
        }
      } catch (error) {
        callback({});
        return;
      }
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen'] });
        // getSources() can resolve with zero results (commonly: macOS Screen
        // Recording permission isn't granted) without throwing at all. Passing
        // `video: undefined` to callback() here doesn't fail inside this
        // try/catch — Chromium rejects the *renderer's* getDisplayMedia promise
        // asynchronously afterward ("Video was requested, but no video stream
        // was provided"), which is a separate promise this function's own
        // error handling never sees, so it surfaced as an unhandled rejection
        // in the main process instead of a caught error here.
        if (!sources.length) {
          logger.warn('System audio loopback unavailable: no screen sources (likely missing Screen Recording permission)');
          callback({});
          return;
        }
        callback({ video: sources[0], audio: 'loopback' });
      } catch (error) {
        logger.error('Failed to set up system audio loopback', { error: error.message });
        callback({});
      }
    });
  }

  setupGlobalShortcuts() {
    const shortcuts = {
      "CommandOrControl+Shift+S": () => this.triggerScreenshotOCR(),
      "CommandOrControl+Shift+V": () => windowManager.toggleVisibility(),
      "CommandOrControl+Shift+I": () => windowManager.toggleInteraction(),
      // The standalone chat window is superseded by the unified window's
      // inline feed; this shortcut now just brings the unified window
      // forward instead of resurrecting the old popup.
      "CommandOrControl+Shift+C": () => windowManager.showAllWindows(),
      "CommandOrControl+Shift+\\": () => this.clearSessionMemory(),
      "CommandOrControl+,": () => windowManager.showSettings(),
      "Alt+A": () => windowManager.toggleInteraction(),
      "Alt+R": () => this.toggleSpeechRecognition(),
      "CommandOrControl+Shift+T": () => windowManager.forceAlwaysOnTopForAllWindows(),
      "CommandOrControl+Shift+Alt+T": () => {
        const results = windowManager.testAlwaysOnTopForAllWindows();
        logger.info('Always-on-top test triggered via shortcut', results);
      },
      // Context-sensitive shortcuts based on interaction mode
      "CommandOrControl+Up": () => this.handleUpArrow(),
      "CommandOrControl+Down": () => this.handleDownArrow(),
      "CommandOrControl+Left": () => this.handleLeftArrow(),
      "CommandOrControl+Right": () => this.handleRightArrow(),
    };

    Object.entries(shortcuts).forEach(([accelerator, handler]) => {
      const success = globalShortcut.register(accelerator, handler);
      logger.debug("Global shortcut registered", { accelerator, success });
    });
  }

  setupServiceEventHandlers() {
    speechService.on("recording-started", () => {
      windowManager.handleRecordingStarted();
    });

    speechService.on("recording-stopped", () => {
      windowManager.handleRecordingStopped();
    });

    speechService.on("transcription", (text) => {
      this.handleTranscriptionFragment(text);
    });

    speechService.on("interim-transcription", (text) => {
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send("interim-transcription", { text });
      });
    });

    speechService.on("status", (status) => {
      this.speechAvailable = speechService.isAvailable ? speechService.isAvailable() : false;
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send("speech-status", { status, available: this.speechAvailable });
      });
      // Also broadcast availability specifically
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send("speech-availability", { available: this.speechAvailable });
      });
    });

    speechService.on("error", (error) => {
      // In error, still compute availability
      this.speechAvailable = speechService.isAvailable ? speechService.isAvailable() : false;
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send("speech-error", { error, available: this.speechAvailable });
      });
    });
  }

  async captureScreen() {
    try {
      // Get the primary display source
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1920, height: 1080 } });
      const primarySource = sources[0];
      if (primarySource) {
        // Return base64 png
        return primarySource.thumbnail.toPNG().toString('base64');
      }
      return null;
    } catch (err) {
      logger.error('Failed to capture screen', { error: err.message });
      return null;
    }
  }

  /**
   * Continuous screen monitoring.
   *
   * Every interval the copilot looks at the screen (the bot's meeting view when
   * it's in a call, otherwise the user's own display) and answers only when
   * something on it actually warrants an answer — a question on a slide, an
   * error, a prompt aimed at the user. Frames that haven't changed are skipped
   * so an idle screen costs nothing, and the model is told to reply NONE when
   * there's nothing worth saying, which keeps it from narrating the desktop.
   */
  startScreenMonitor(intervalMs) {
    if (this._screenMonitorTimer) {
      return { active: true, intervalMs: this._screenMonitorIntervalMs };
    }

    const interval = Math.max(5000, Number(intervalMs) || 15000);
    this._screenMonitorIntervalMs = interval;
    this._screenMonitorLastHash = null;
    this._screenMonitorBusy = false;
    this._screenMonitorWarnedNoFrame = false;

    this._screenMonitorTimer = setInterval(() => {
      this.runScreenMonitorTick().catch((error) => {
        logger.error('Screen monitor tick failed', { error: error.message });
      });
    }, interval);

    logger.info('Screen monitor started', { intervalMs: interval });
    this.broadcastScreenMonitorState(true);
    return { active: true, intervalMs: interval };
  }

  stopScreenMonitor() {
    if (this._screenMonitorTimer) {
      clearInterval(this._screenMonitorTimer);
      this._screenMonitorTimer = null;
      logger.info('Screen monitor stopped');
    }
    this._screenMonitorLastHash = null;
    this.broadcastScreenMonitorState(false);
    return { active: false };
  }

  isScreenMonitorActive() {
    return !!this._screenMonitorTimer;
  }

  broadcastScreenMonitorState(active) {
    const unified = windowManager.getWindow("unified");
    if (unified && !unified.isDestroyed()) {
      unified.webContents.send("screen-monitor-state", { active });
    }
  }

  async runScreenMonitorTick() {
    // Skip if the previous tick's LLM call is still in flight, so a slow model
    // can't queue up a backlog of stale screens.
    if (this._screenMonitorBusy) {
      return;
    }

    const frameBase64 = zoomBotService.isBotActive
      ? await zoomBotService.captureMeetingFrame()
      : await this.captureScreen();

    if (!frameBase64) {
      // captureScreen() uses desktopCapturer, which needs macOS Screen
      // Recording permission — when it's missing, getSources() throws and
      // captureScreen() swallows it into a null return. Without this, Auto
      // would sit there forever silently doing nothing, which is exactly
      // indistinguishable from "working but nothing to say" — tell the user
      // once instead of leaving them guessing.
      if (!this._screenMonitorWarnedNoFrame) {
        this._screenMonitorWarnedNoFrame = true;
        logger.warn('Screen monitor got no frame to analyze', {
          botActive: zoomBotService.isBotActive
        });
        const unified = windowManager.getWindow("unified");
        if (unified && !unified.isDestroyed()) {
          unified.webContents.send("screen-monitor-answer", {
            content: zoomBotService.isBotActive
              ? 'Auto-watch can\'t get a frame from the meeting bot right now.'
              : 'Auto-watch can\'t capture your screen — this usually means macOS Screen Recording ' +
                'permission isn\'t granted. Check System Settings → Privacy & Security → Screen Recording ' +
                'and enable it for this app, then restart the app.',
            timestamp: Date.now(),
            isWarning: true
          });
        }
      }
      return;
    }
    this._screenMonitorWarnedNoFrame = false;

    // Cheap change detection: identical frames mean nothing new to look at.
    const hash = require('crypto').createHash('sha1').update(frameBase64).digest('hex');
    if (hash === this._screenMonitorLastHash) {
      return;
    }
    this._screenMonitorLastHash = hash;

    this._screenMonitorBusy = true;
    try {
      const recentTranscript = sessionManager.fullTranscript.slice(-10);
      const contextText = recentTranscript
        .map(t => `${t.role.toUpperCase()}: ${t.content}`)
        .join('\n');

      const prompt = `You are an AI copilot silently watching the user's screen during a live meeting.

${sessionManager.meetingPrompt ? `USER'S INSTRUCTIONS:\n${sessionManager.meetingPrompt}\n\n` : ''}${contextText ? `Recent conversation:\n${contextText}\n\n` : ''}Look at the attached screen image. Answer ONLY if there is something the user clearly needs help with right now — a question directed at them, an error or failing test, a coding problem, or a slide/prompt awaiting a response.

If there is nothing that needs an answer, reply with exactly: NONE

Otherwise give a concise, immediately useful answer (a few bullet points at most). Do not describe the screen or narrate what you see. Do not greet. Just answer.`;

      const geminiRequest = {
        contents: [{
          role: 'user',
          parts: [
            { text: prompt },
            { inlineData: { data: frameBase64, mimeType: 'image/png' } }
          ]
        }],
        generationConfig: llmService.getGenerationConfig({
          temperature: 0.3,
          maxOutputTokens: 1024
        })
      };

      const text = (await llmService.executeRequest(geminiRequest) || '').trim();

      // The model returns NONE for an idle screen; don't surface those.
      if (!text || /^none\b/i.test(text)) {
        return;
      }

      sessionManager.addModelResponse(text, { source: 'screen-monitor' });

      const unified = windowManager.getWindow("unified");
      if (unified && !unified.isDestroyed()) {
        unified.webContents.send("screen-monitor-answer", {
          content: text,
          timestamp: Date.now()
        });
      }

      logger.info('Screen monitor produced an answer', { responseLength: text.length });
    } finally {
      this._screenMonitorBusy = false;
    }
  }

  async executeAskAiHelp(isProactive = false) {
    logger.info(`Ask AI Help requested during meeting (Proactive: ${isProactive})`);
    
    // Get recent transcript context (last 20 entries)
    const recentTranscript = sessionManager.fullTranscript.slice(-20);
    if (recentTranscript.length === 0) {
      return { success: false, error: 'No conversation context yet. Start speaking first.' };
    }

    const contextText = recentTranscript
      .map(t => `${t.role.toUpperCase()}: ${t.content}`)
      .join('\n');

    const referenceContext = sessionManager.referenceContext || '';
    const meetingPrompt = sessionManager.meetingPrompt || '';

    try {
      let screenContext = '';
      let inlineData = null;

      // When the bot is in the meeting, its own window is what "sees" the
      // discussion — shared screens, slides, diagrams. Prefer that frame, and
      // include it on proactive answers too: an auto-detected question is
      // exactly when the agent needs to see what's being presented, and that
      // path previously sent no visual context at all.
      if (zoomBotService.isBotActive) {
        const frameBase64 = await zoomBotService.captureMeetingFrame();
        if (frameBase64) {
          screenContext = "\n\n[MEETING VIEW INCLUDED] Note: I have attached a live frame of the meeting itself (shared screen, slides, whiteboard, or participant video). Please analyze any relevant code, errors, slides, or diagrams visible in it.";
          inlineData = { data: frameBase64, mimeType: 'image/png' };
        }
      }

      // Fall back to the user's own screen whenever the bot didn't supply a
      // frame — including proactive (auto-detected) answers. This used to be
      // manual-only; that meant every auto-detected spoken question during a
      // non-bot session got answered blind, with no screenshot at all, even
      // though the whole point of "it should see what's on screen and
      // answer" is that it also fires for questions it noticed itself.
      if (!inlineData) {
        const screenBase64 = await this.captureScreen();
        if (screenBase64) {
          screenContext = "\n\n[SCREEN CAPTURE INCLUDED] Note: I have attached a screenshot of the user's current primary screen. Please analyze any relevant code, errors, slides, or diagrams visible in this screenshot.";
          inlineData = { data: screenBase64, mimeType: 'image/png' };
        } else if (!this._screenCaptureWarnedOnce) {
          // Same underlying cause as the Auto-watch warning (missing macOS
          // Screen Recording permission) — Ask AI would otherwise just answer
          // with no visual context and no explanation why. display-llm-response
          // with source:'system' gets filtered by the renderer (it's used for
          // transient "analyzing…" notices), so this reuses the warning
          // channel that's actually wired to show a message.
          this._screenCaptureWarnedOnce = true;
          const unified = windowManager.getWindow("unified");
          if (unified && !unified.isDestroyed()) {
            unified.webContents.send("screen-monitor-answer", {
              content: "Couldn't capture your screen (this usually means macOS Screen Recording permission " +
                "isn't granted — check System Settings → Privacy & Security → Screen Recording). Answering from " +
                "conversation context only.",
              timestamp: Date.now(),
              isWarning: true
            });
          }
        }
      }

      // Build a prompt that asks the LLM to help based on meeting context
      const helpPrompt = `You are an AI meeting assistant. The user is currently in a live meeting and ${isProactive ? 'a technical question was detected' : 'they have pressed the "Ask AI" button'} because they need help.

${meetingPrompt ? `USER'S MEETING INSTRUCTIONS:\n${meetingPrompt}\n` : ''}

Here is the recent meeting conversation:
${contextText}

${referenceContext ? `Reference documents for context:\n${referenceContext}\n` : ''}${screenContext}

Based on the above conversation, the user's instructions, and the attached image (if any), provide a helpful, actionable response. Consider:
- What is being discussed right now?
- What might the user need help with?
- Answer any technical questions directed at the user.
- Suggest troubleshooting steps or architecture improvements based on the conversation and the screenshot.
- Keep it concise and immediately useful.
- Do NOT use code blocks unless the conversation is explicitly about code.
- Format with bullet points for clarity.
- IMPORTANT DIARIZATION: The transcript does not distinguish speakers well. Please infer who is asking questions (e.g., "Client") and who is the user (e.g., "You"). Frame your response to help "You".`;

      const contents = [];
      const parts = [{ text: helpPrompt }];
      if (inlineData) {
        parts.push({ inlineData });
      }
      contents.push({ role: 'user', parts });

      const geminiRequest = {
        contents: contents,
        generationConfig: llmService.getGenerationConfig({
          temperature: 0.4,
          maxOutputTokens: 2048
        })
      };
      
      const messageId = `help-${Date.now()}`;
      this.sendToVoiceResponseWindows("transcription-llm-response-start", {
        messageId,
        skill: this.activeSkill
      });
      
      let text = await llmService.executeStreamingRequest(geminiRequest, (delta) => {
        this.sendToVoiceResponseWindows("transcription-llm-response-chunk", {
          messageId,
          delta
        });
      });
      
      // Add AI response to transcript
      sessionManager.addModelResponse(text, { source: isProactive ? 'proactive-ai' : 'ask-ai-help' });
      // Send to LLM response window
      this.sendToVoiceResponseWindows("display-llm-response", {
        content: text,
        metadata: { skill: this.activeSkill, source: 'ask-ai-help' },
        timestamp: Date.now()
      });
      
      // Also send to chat window
      this.sendToVoiceResponseWindows("transcription-llm-response-final", {
        messageId: messageId,
        content: text,
        skill: this.activeSkill
      });

      if (this.shouldShowVoiceOverlay()) {
        windowManager.showLLMResponse(text, this.activeSkill);
      }

      logger.info('Ask AI Help response generated', { responseLength: text.length });
      return { success: true, response: text };
    } catch (error) {
      logger.error('Ask AI Help failed', { error: error.message });
      return { success: false, error: error.message };
    }
  }

  setupIPCHandlers() {
    ipcMain.on("startup-complete", async (event, data) => {
      const { mode, referenceFiles, meetingPrompt, useBot, zoomUrl, botName } = data;
      sessionManager.setMode(mode);

      // Initialize the Zoom bot if selected
      if (useBot && zoomUrl) {
        if (!adminClient.isFeatureEnabled('zoom_bot')) {
          logger.warn("Zoom bot join blocked — disabled by admin");
          sessionManager.addConversationEvent({
            role: 'system',
            content: 'Zoom bot join was skipped: this feature has been disabled by your admin.',
            action: 'bot_blocked'
          });
        } else {
          zoomBotService.startBot(zoomUrl, botName);

          // Let the session manager know we are using bot mode
          sessionManager.addConversationEvent({
            role: 'system',
            content: `AI Bot joining Zoom Meeting: ${zoomUrl}`,
            action: 'bot_joined'
          });
        }
      }

      // Store user's meeting instructions
      if (meetingPrompt) {
        sessionManager.meetingPrompt = meetingPrompt;
      } else {
        const { promptLoader } = require('./prompt-loader');
        sessionManager.meetingPrompt = promptLoader.getSkillPrompt('meeting');
      }

      if (sessionManager.meetingPrompt) {
        sessionManager.addConversationEvent({
          role: 'system',
          content: `Meeting instructions: ${sessionManager.meetingPrompt.substring(0, 50)}...`,
          action: 'meeting_prompt_set'
        });
        logger.info('Meeting prompt set', { promptLength: sessionManager.meetingPrompt.length });
      }

      let contextText = '';
      for (const filePath of referenceFiles) {
        try {
          const fs = require('fs');
          const ext = require('path').extname(filePath).toLowerCase();
          
          if (ext === '.pdf') {
            const pdf = require('pdf-parse');
            const dataBuffer = fs.readFileSync(filePath);
            const pdfData = await pdf(dataBuffer);
            contextText += `\n--- Document: ${filePath} ---\n${pdfData.text}\n`;
          } else {
            const textData = fs.readFileSync(filePath, 'utf8');
            contextText += `\n--- Document: ${filePath} ---\n${textData}\n`;
          }
        } catch (e) {
          logger.error(`Failed to read reference file ${filePath}`, { error: e.message });
        }
      }

      if (contextText) {
        sessionManager.setReferenceContext(contextText);
      }

      windowManager.hideStartup();
      await windowManager.showUnifiedWindow();
    });

    ipcMain.handle("end-session", async () => {
      logger.info('Ending session and generating summary...');
      const exportService = require('./src/services/export.service');
      const summaryFile = await exportService.saveSession(llmService, sessionManager);

      // Minutes must be generated BEFORE the session is cleared — clearing
      // wipes the transcript they're built from. Capture the roster first too,
      // since stopping the bot resets it.
      const participants = zoomBotService.isBotActive
        ? zoomBotService.getParticipants()
        : [];
      const mom = await exportService.saveMinutesOfMeeting(llmService, sessionManager, participants);
      if (mom.content) {
        this._lastMom = mom.content;
      }

      // Stop the bot if it's running
      zoomBotService.stopBot();

      // Otherwise the auto-watch timer keeps capturing and calling the LLM
      // after the session is over.
      this.stopScreenMonitor();

      sessionManager.clear();

      if (windowManager.windows.has('main')) {
        windowManager.windows.get('main').hide();
      }
      windowManager.hideChatWindow();
      windowManager.hideLLMResponse();

      // Keep the unified window up so the user can read and download the
      // minutes; it offers a "New session" button to reopen the startup screen.
      const unified = windowManager.getWindow("unified");
      if (unified && !unified.isDestroyed()) {
        unified.webContents.send("mom-ready", {
          content: mom.content || null,
          filepath: mom.filepath || null,
          error: mom.error || null,
          participants,
          summaryFile
        });
      } else {
        windowManager.showStartup();
      }

      return summaryFile;
    });

    ipcMain.handle("show-startup", async () => {
      await windowManager.showStartup();
      const unified = windowManager.getWindow("unified");
      if (unified && !unified.isDestroyed()) {
        unified.hide();
      }
      return { success: true };
    });

    ipcMain.handle("ask-ai-help", async () => {
      if (!adminClient.isFeatureEnabled('screenshot_ask_ai')) {
        return { success: false, error: 'This feature has been disabled by your admin.' };
      }
      return await this.executeAskAiHelp(false);
    });

    // Minutes of Meeting: generate once, then let the user save a copy wherever
    // they want. The generated markdown is cached on the instance so choosing
    // "save as" doesn't trigger a second (billable) generation.
    ipcMain.handle("generate-mom", async () => {
      if (!adminClient.isFeatureEnabled('minutes_of_meeting')) {
        return { success: false, error: 'This feature has been disabled by your admin.' };
      }
      const participants = zoomBotService.isBotActive
        ? zoomBotService.getParticipants()
        : [];
      const result = await require('./src/services/export.service')
        .saveMinutesOfMeeting(llmService, sessionManager, participants);

      if (result.content) {
        this._lastMom = result.content;
      }
      return result;
    });

    ipcMain.handle("save-mom-as", async () => {
      if (!this._lastMom) {
        return { success: false, error: 'Generate the minutes first.' };
      }
      try {
        const { dialog } = require("electron");
        const date = new Date();
        const stamp = `${date.getFullYear()}${(date.getMonth() + 1).toString().padStart(2, '0')}${date.getDate().toString().padStart(2, '0')}`;
        const { canceled, filePath } = await dialog.showSaveDialog({
          title: 'Save Minutes of Meeting',
          defaultPath: require('path').join(app.getPath('documents'), `MoM_${stamp}.md`),
          filters: [
            { name: 'Markdown', extensions: ['md'] },
            { name: 'Text', extensions: ['txt'] }
          ]
        });
        if (canceled || !filePath) {
          return { success: false, canceled: true };
        }
        require('fs').writeFileSync(filePath, this._lastMom, 'utf8');
        logger.info('Minutes of meeting saved by user', { filePath });
        return { success: true, filePath };
      } catch (error) {
        logger.error('Failed to save minutes', { error: error.message });
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("reveal-file", (_event, filePath) => {
      try {
        if (filePath) {
          require("electron").shell.showItemInFolder(filePath);
          return { success: true };
        }
      } catch (error) {
        logger.error('Failed to reveal file', { error: error.message });
      }
      return { success: false };
    });

    // Continuous screen monitoring (auto-watch)
    ipcMain.handle("toggle-screen-monitor", () => {
      if (!this.isScreenMonitorActive() && !adminClient.isFeatureEnabled('auto_watch')) {
        return { success: false, error: 'This feature has been disabled by your admin.' };
      }
      return this.isScreenMonitorActive()
        ? this.stopScreenMonitor()
        : this.startScreenMonitor();
    });

    ipcMain.handle("get-screen-monitor-status", () => ({
      active: this.isScreenMonitorActive(),
      intervalMs: this._screenMonitorIntervalMs || null
    }));

    // Lets the renderer check screen-capture availability BEFORE calling
    // getDisplayMedia() for system-audio loopback. Chromium requires a real
    // video stream whenever video is requested — there's no clean way to
    // "deny" that from setDisplayMediaRequestHandler once the request is in
    // flight (even callback({}) triggers an unhandled rejection in the main
    // process when desktopCapturer has no sources, e.g. missing macOS Screen
    // Recording permission). Checking first and simply not attempting the
    // call avoids that path entirely instead of trying to catch it after
    // the fact.
    ipcMain.handle("get-screen-capture-status", () => windowManager.screenCaptureStatus);

  ipcMain.handle("take-screenshot", () => {
    if (!adminClient.isFeatureEnabled('screenshot_ask_ai')) {
      return { success: false, error: 'This feature has been disabled by your admin.' };
    }
    return this.triggerScreenshotOCR();
  });
  ipcMain.handle("list-displays", () => captureService.listDisplays());
  ipcMain.handle("capture-area", (event, options) => captureService.captureAndProcess(options));
    
    // Provide reliable clipboard write via main process
    ipcMain.handle("copy-to-clipboard", (event, text) => {
      try {
        const { clipboard } = require("electron");
        clipboard.writeText(String(text ?? ""));
        return true;
      } catch (e) {
        logger.error("Failed to write to clipboard", { error: e.message });
        return false;
      }
    });
    
    ipcMain.handle("get-speech-availability", () => {
      return speechService.isAvailable ? speechService.isAvailable() : false;
    });

    ipcMain.handle("start-speech-recognition", () => {
      if (!adminClient.isFeatureEnabled('listen')) {
        return { ...speechService.getStatus(), error: 'This feature has been disabled by your admin.' };
      }
      speechService.startRecording();
      return speechService.getStatus();
    });

    ipcMain.handle("stop-speech-recognition", () => {
      speechService.stopRecording();
      return speechService.getStatus();
    });

    // Raw PCM audio captured by the renderer's Web Audio API (Windows Whisper path)
    let audioChunkCount = 0;
    let lastMicLevelSentAt = 0;
    ipcMain.on("audio-chunk", (_event, data) => {
      if (data && data.buffer) {
        audioChunkCount++;
        const buf = Buffer.from(data.buffer);
        if (audioChunkCount === 1 || audioChunkCount % 50 === 0) {
          logger.info("Renderer audio chunk received", {
            count: audioChunkCount,
            bytes: buf.length
          });
        }

        // Live level meter: lets the user SEE whether their voice is actually
        // reaching the app, instead of a silent pass/fail. Throttled to ~8/s
        // so it doesn't flood IPC.
        const now = Date.now();
        if (now - lastMicLevelSentAt > 120) {
          lastMicLevelSentAt = now;
          let sumSquares = 0;
          const sampleCount = Math.floor(buf.length / 2);
          for (let i = 0; i < sampleCount; i++) {
            const s = buf.readInt16LE(i * 2) / 32768;
            sumSquares += s * s;
          }
          const rms = sampleCount ? Math.sqrt(sumSquares / sampleCount) : 0;
          const unified = windowManager.getWindow("unified");
          if (unified && !unified.isDestroyed()) {
            unified.webContents.send("mic-level", { level: rms, chunkCount: audioChunkCount });
          }
        }

        speechService.handleAudioChunkFromRenderer(buf);
      }
    });

    // System audio (loopback) — the OTHER side of a meeting, which a
    // microphone physically cannot pick up when the user is on headphones.
    // Runs as its own independent stream alongside the mic one above, feeding
    // the same Whisper VAD pipeline with a source tag so segments can be
    // attributed to "you" vs "the meeting" (see _ingestWhisperAudio).
    let sysAudioChunkCount = 0;
    let lastSysLevelSentAt = 0;
    ipcMain.on("system-audio-chunk", (_event, data) => {
      if (data && data.buffer) {
        sysAudioChunkCount++;
        const buf = Buffer.from(data.buffer);
        if (sysAudioChunkCount === 1 || sysAudioChunkCount % 50 === 0) {
          logger.info("System audio chunk received", {
            count: sysAudioChunkCount,
            bytes: buf.length
          });
        }

        const now = Date.now();
        if (now - lastSysLevelSentAt > 120) {
          lastSysLevelSentAt = now;
          let sumSquares = 0;
          const sampleCount = Math.floor(buf.length / 2);
          for (let i = 0; i < sampleCount; i++) {
            const s = buf.readInt16LE(i * 2) / 32768;
            sumSquares += s * s;
          }
          const rms = sampleCount ? Math.sqrt(sumSquares / sampleCount) : 0;
          const unified = windowManager.getWindow("unified");
          if (unified && !unified.isDestroyed()) {
            unified.webContents.send("sys-level", { level: rms, chunkCount: sysAudioChunkCount });
          }
        }

        speechService.handleAudioChunkFromRenderer(buf, 'system');
      }
    });

    // Zoom Bot audio is already wired to speechService.handleBotAudioChunk
    // via its own ipcMain listener registered in the SpeechService constructor.
    // (A duplicate listener here previously caused every chunk to be ingested twice.)

    // We don't need bot-active-speaker here because zoomBotService already listens to it!
    
    // start-zoom-bot and stop-zoom-bot are handled in UI or startup flow


    // Also handle direct send events for fallback
    ipcMain.on("start-speech-recognition", () => {
      speechService.startRecording();
    });

    ipcMain.on("stop-speech-recognition", () => {
      speechService.stopRecording();
    });

    ipcMain.on("chat-window-ready", () => {
      // Send a test message to confirm communication
      setTimeout(() => {
        windowManager.broadcastToAllWindows("transcription-received", {
          text: "Test message from main process - chat window communication is working!",
        });
      }, 1000);
    });

    ipcMain.on("main-window-ready", () => {
      // Re-check availability whenever the main overlay finishes loading;
      // this covers first-run where the window was hidden during onboarding.
      this.speechAvailable = speechService.isAvailable
        ? speechService.isAvailable()
        : false;
      const { BrowserWindow } = require("electron");
      BrowserWindow.getAllWindows().forEach((win) => {
        if (!win.isDestroyed()) {
          win.webContents.send("speech-availability", { available: this.speechAvailable });
        }
      });
    });

    ipcMain.on("test-chat-window", () => {
      windowManager.broadcastToAllWindows("transcription-received", {
        text: "🧪 IMMEDIATE TEST: Chat window IPC communication test successful!",
      });
    });

    ipcMain.handle("show-all-windows", () => {
      windowManager.showAllWindows();
      return windowManager.getWindowStats();
    });

    ipcMain.handle("hide-all-windows", () => {
      windowManager.hideAllWindows();
      return windowManager.getWindowStats();
    });

    ipcMain.handle("enable-window-interaction", () => {
      windowManager.setInteractive(true);
      return windowManager.getWindowStats();
    });

    ipcMain.handle("disable-window-interaction", () => {
      windowManager.setInteractive(false);
      return windowManager.getWindowStats();
    });

    ipcMain.handle("switch-to-chat", () => {
      windowManager.switchToWindow("chat");
      return windowManager.getWindowStats();
    });

    ipcMain.handle("switch-to-skills", () => {
      windowManager.switchToWindow("skills");
      return windowManager.getWindowStats();
    });

    ipcMain.handle("resize-window", (event, { width, height }) => {
      // Resize whichever window asked. This used to always target the `main`
      // sidebar and clamp the width to ~60px, which is right for that icon
      // strip but wrong for the unified window (it would collapse it to a
      // sliver and leave the real window untouched).
      const senderWindow = BrowserWindow.fromWebContents(event.sender);
      const mainWindow = windowManager.getWindow("main");
      const target = senderWindow || mainWindow;
      if (!target || target.isDestroyed()) {
        return { success: false };
      }

      let clampedWidth = Math.max(1, Math.round(width || 1));
      if (target === mainWindow) {
        // Enforce horizontal constraints: min ~one icon, max original width
        const minW = 60;
        const maxW = windowManager.windowConfigs?.main?.width || 520;
        clampedWidth = Math.max(minW, Math.min(maxW, Math.round(width || minW)));
      }

      const clampedHeight = Math.max(1, Math.round(height || 1));
      try {
        // Match content size to the DOM so no extra transparent area remains
        target.setContentSize(clampedWidth, clampedHeight);
      } catch (e) {
        // Fallback in case setContentSize isn’t available on some platform
        target.setSize(clampedWidth, clampedHeight);
      }
      logger.debug("Window resized (content)", { width: clampedWidth, height: clampedHeight });
      return { success: true };
    });

    ipcMain.handle("move-window", (event, { deltaX, deltaY }) => {
      const mainWindow = windowManager.getWindow("main");
      if (mainWindow) {
        const [currentX, currentY] = mainWindow.getPosition();
        const newX = currentX + deltaX;
        const newY = currentY + deltaY;
        mainWindow.setPosition(newX, newY);
        logger.debug("Main window moved", {
          deltaX,
          deltaY,
          from: { x: currentX, y: currentY },
          to: { x: newX, y: newY },
        });
      }
      return { success: true };
    });

    ipcMain.handle("get-session-history", () => {
      return sessionManager.getOptimizedHistory();
    });

    ipcMain.handle("clear-session-memory", () => {
      sessionManager.clear();
      windowManager.broadcastToAllWindows("session-cleared");
      return { success: true };
    });

    ipcMain.handle("force-always-on-top", () => {
      windowManager.forceAlwaysOnTopForAllWindows();
      return { success: true };
    });

    ipcMain.handle("test-always-on-top", () => {
      const results = windowManager.testAlwaysOnTopForAllWindows();
      return { success: true, results };
    });

    ipcMain.handle("send-chat-message", async (event, text) => {
      // Add chat message to session memory
      sessionManager.addUserInput(text, 'chat');
      logger.debug('Chat message added to session memory', { textLength: text.length });

      // Typed messages need the full skill pipeline (with history context),
      // NOT the voice "intelligent filter" pipeline. Voice keeps its filter
      // behaviour; typed chat goes through processWithLLM so it gets real
      // answers using the active skill prompt and recent conversation history.
      (async () => {
        try {
          const sessionHistory = sessionManager.getOptimizedHistory();
          await this.processWithLLM(text, sessionHistory);
        } catch (error) {
          logger.error("Failed to process chat message with LLM", {
            error: error.message,
            text: text.substring(0, 100)
          });
        }
      })();

      return { success: true };
    });

    ipcMain.handle("set-mode", (event, mode) => {
      sessionManager.setMode(mode);
      return { success: true };
    });

    ipcMain.handle("get-skill-prompt", (event, skillName) => {
      try {
        const { promptLoader } = require('./prompt-loader');
        const skillPrompt = promptLoader.getSkillPrompt(skillName);
        return skillPrompt;
      } catch (error) {
        logger.error('Failed to get skill prompt', { skillName, error: error.message });
        return null;
      }
    });

    ipcMain.handle("set-gemini-api-key", (event, apiKey) => {
      llmService.updateApiKey(apiKey);
      return llmService.getStats();
    });

    ipcMain.handle("get-gemini-status", () => {
      return llmService.getStats();
    });

    // Window binding IPC handlers
    ipcMain.handle("set-window-binding", (event, enabled) => {
      return windowManager.setWindowBinding(enabled);
    });

    ipcMain.handle("toggle-window-binding", () => {
      return windowManager.toggleWindowBinding();
    });

    ipcMain.handle("get-window-binding-status", () => {
      return windowManager.getWindowBindingStatus();
    });

    ipcMain.handle("get-window-stats", () => {
      return windowManager.getWindowStats();
    });

    ipcMain.handle("set-window-gap", (event, gap) => {
      return windowManager.setWindowGap(gap);
    });

    ipcMain.handle("move-bound-windows", (event, { deltaX, deltaY }) => {
      windowManager.moveBoundWindows(deltaX, deltaY);
      return windowManager.getWindowBindingStatus();
    });

    ipcMain.handle("test-gemini-connection", async () => {
      return await llmService.testConnection();
    });

    ipcMain.handle("run-gemini-diagnostics", async () => {
      try {
        const connectivity = await llmService.checkNetworkConnectivity();
        const apiTest = await llmService.testConnection();
        
        return {
          success: true,
          connectivity,
          apiTest,
          timestamp: new Date().toISOString()
        };
      } catch (error) {
        return {
          success: false,
          error: error.message,
          timestamp: new Date().toISOString()
        };
      }
    });

    // Settings handlers
    ipcMain.handle("show-settings", () => {
      windowManager.showSettings();

      // Send current settings to the settings window
      const settingsWindow = windowManager.getWindow("settings");
      if (settingsWindow) {
        const currentSettings = this.getSettings();
        setTimeout(() => {
          settingsWindow.webContents.send("load-settings", currentSettings);
        }, 100);
      }

      return { success: true };
    });

    ipcMain.handle("get-settings", () => {
      return this.getSettings();
    });

    // First-run onboarding status — renderer can query to know whether
    // to show the welcome banner / prompt for API-key entry.
    ipcMain.handle("get-first-run-status", () => {
      try {
        return this.firstRunManager.getStatus();
      } catch (e) {
        logger.warn("Failed to get first-run status", { error: e.message });
        return { needsOnboarding: false, error: e.message };
      }
    });

    ipcMain.handle("complete-first-run", async () => {
      try {
        this.firstRunManager.markCompleted();
        this.isFirstRun = false;
        // Reinitialize speech service with the latest persisted settings
        // so the mic button reflects the provider/command set during onboarding.
        speechService.initializeClient();
        this.speechAvailable = speechService.isAvailable
          ? speechService.isAvailable()
          : false;
        // Show the startup (mode/meeting-setup) screen now that onboarding is
        // done and API keys are configured — the same screen a returning user
        // sees on launch. This used to show the legacy "main" sidebar window,
        // which no longer exists now that the unified window replaced it.
        await windowManager.showStartup();
        // Broadcast speech availability so the mic button appears
        const { BrowserWindow } = require("electron");
        BrowserWindow.getAllWindows().forEach((win) => {
          if (!win.isDestroyed()) {
            win.webContents.send("speech-availability", { available: this.speechAvailable });
          }
        });
        return { success: true };
      } catch (e) {
        return { success: false, error: e.message };
      }
    });

    // Open a URL in the system browser (used by the GitHub star button
    // in onboarding).
    ipcMain.handle("open-external", async (_event, url) => {
      try {
        if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
          return { ok: false, error: "Invalid URL" };
        }
        const { shell } = require("electron");
        await shell.openExternal(url);
        return { ok: true };
      } catch (e) {
        logger.warn("Failed to open external URL", { url, error: e.message });
        return { ok: false, error: e.message };
      }
    });

    // Admin-panel account login (see ensureAccountAuthenticated). Both
    // return { ok:false, error } on failure rather than throwing -- see
    // preload.js, which unwraps that into a real rejection for the
    // renderer's try/catch.
    ipcMain.handle("account-request-otp", async (event, email) => {
      try {
        await adminClient.requestOtp(email);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    });

    ipcMain.handle("account-verify-otp", async (event, { email, code } = {}) => {
      try {
        await adminClient.verifyOtp(email, code);
        const cfg = await adminClient.fetchConfig();
        adminClient.applyConfig(cfg);
        this._persistGeminiKeyIfPresent(cfg);
        logger.info("Signed in via admin panel", { email: adminClient.getSignedInEmail() });

        // Close the login window now that we actually have a working
        // config, and let ensureAccountAuthenticated's waiting promise
        // continue app startup. Deferred slightly so the renderer's own
        // "Signed in — starting the app…" success message is visible
        // before the window disappears.
        setTimeout(() => {
          // Resolve BEFORE closing the window: closeAccountLogin() fires
          // the same 'closed' event as the user clicking the window's own
          // close control, and that handler only distinguishes "cancelled"
          // from "succeeded" by checking whether resolve already ran.
          if (this._pendingAccountLoginResolve) {
            this._pendingAccountLoginResolve();
            this._pendingAccountLoginResolve = null;
          }
          windowManager.closeAccountLogin();
        }, 400);

        return { ok: true };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    });

    // Close the onboarding wizard window.
    ipcMain.handle("close-onboarding", () => {
      try {
        windowManager.closeOnboarding();
        return { success: true };
      } catch (e) {
        return { success: false, error: e.message };
      }
    });

    // Detect an installed Whisper CLI across common locations.
    ipcMain.handle("detect-whisper", async () => {
      try {
        const installer = this.getWhisperInstaller();
        return await installer.detect();
      } catch (e) {
        logger.warn("Whisper detection failed", { error: e.message });
        return { found: false, command: null, version: null, error: e.message };
      }
    });

    // Install Whisper. Streams progress lines back via `webContents.send`
    // so the renderer can paint them as they arrive.
    ipcMain.handle("install-whisper", async (event) => {
      try {
        const installer = this.getWhisperInstaller();
        const sender = event.sender;
        const result = await installer.install({
          onProgress: (line) => {
            try { sender.send("install-progress", line); } catch (_) { /* ignore */ }
          },
        });
        return result;
      } catch (e) {
        logger.error("Whisper install failed", { error: e.message });
        return { ok: false, command: null, message: e.message, logs: "" };
      }
    });

    // Download Whisper model. Streams progress lines back via `webContents.send`
    ipcMain.handle("download-whisper-model", async (event, modelName) => {
      try {
        const installer = this.getWhisperInstaller();
        const sender = event.sender;
        const result = await installer.downloadModel(modelName || 'small', {
          onProgress: (line) => {
            try { sender.send("install-progress", line); } catch (_) { /* ignore */ }
          },
        });
        return result;
      } catch (e) {
        logger.error("Whisper model download failed", { error: e.message });
        return { ok: false, message: e.message, path: null };
      }
    });

    ipcMain.handle("save-settings", (event, settings) => {
      return this.saveSettings(settings);
    });

    ipcMain.handle("update-app-icon", (event, iconKey) => {
      return this.updateAppIcon(iconKey);
    });

    ipcMain.handle("update-active-skill", (event, skill) => {
      this.activeSkill = skill;
      windowManager.broadcastToAllWindows("skill-changed", { skill });
      return { success: true };
    });

    ipcMain.handle("restart-app-for-stealth", () => {
      // Force restart the app to ensure stealth name changes take effect
      const { app } = require("electron");
      app.relaunch();
      app.exit();
    });

    ipcMain.handle("close-window", (event) => {
      const webContents = event.sender;
      const window = windowManager.windows.forEach((win, type) => {
        if (win.webContents === webContents) {
          win.hide();
          return true;
        }
      });
      return { success: true };
    });

    // LLM window specific handlers
    ipcMain.handle("expand-llm-window", (event, contentMetrics) => {
      windowManager.expandLLMWindow(contentMetrics);
      return { success: true, contentMetrics };
    });

    ipcMain.handle("resize-llm-window-for-content", (event, contentMetrics) => {
      // Use the same expansion logic for now, can be enhanced later
      windowManager.expandLLMWindow(contentMetrics);
      return { success: true, contentMetrics };
    });

    ipcMain.handle("quit-app", () => {
      logger.info("Quit app requested via IPC");
      try {
        // Force quit the application
        const { app } = require("electron");

        // Close all windows first
        windowManager.destroyAllWindows();

        // Unregister shortcuts
        globalShortcut.unregisterAll();

        // Force quit
        app.quit();

        // If the above doesn't work, force exit
        setTimeout(() => {
          process.exit(0);
        }, 2000);
      } catch (error) {
        logger.error("Error during quit:", error);
        process.exit(1);
      }
    });

    // Handle close settings
    ipcMain.on("close-settings", () => {
      const settingsWindow = windowManager.getWindow("settings");
      if (settingsWindow) {
        settingsWindow.hide();
      }
    });

    // Handle save settings (synchronous)
    ipcMain.on("save-settings", (event, settings) => {
      this.saveSettings(settings);
    });

    // Handle update skill
    ipcMain.on("update-skill", (event, skill) => {
      this.activeSkill = skill;
      windowManager.broadcastToAllWindows("skill-updated", { skill });
    });

    // Handle quit app (alternative method)
    ipcMain.on("quit-app", () => {
      logger.info("Quit app requested via IPC (on method)");
      try {
        const { app } = require("electron");
        windowManager.destroyAllWindows();
        globalShortcut.unregisterAll();
        app.quit();
        setTimeout(() => process.exit(0), 1000);
      } catch (error) {
        logger.error("Error during quit (on method):", error);
        process.exit(1);
      }
    });
  }

  toggleSpeechRecognition() {
    const isAvailable = typeof speechService.isAvailable === 'function' ? speechService.isAvailable() : !!speechService.getStatus?.().isInitialized;
    if (!isAvailable) {
      logger.warn("Speech recognition unavailable; toggle ignored");
      try {
        windowManager.broadcastToAllWindows("speech-status", { status: 'Speech recognition unavailable', available: false });
        windowManager.broadcastToAllWindows("speech-availability", { available: false });
      } catch (e) {}
      return;
    }
    const currentStatus = speechService.getStatus();
    if (currentStatus.isRecording) {
      try {
        speechService.stopRecording();
        logger.info("Speech recognition stopped via global shortcut");
      } catch (error) {
        logger.error("Error stopping speech recognition:", error);
      }
    } else {
      try {
        speechService.startRecording();
        windowManager.showChatWindow();
        logger.info("Speech recognition started via global shortcut");
      } catch (error) {
        logger.error("Error starting speech recognition:", error);
      }
    }
  }

  clearSessionMemory() {
    try {
      sessionManager.clear();
      windowManager.broadcastToAllWindows("session-cleared");
      logger.info("Session memory cleared via global shortcut");
    } catch (error) {
      logger.error("Error clearing session memory:", error);
    }
  }

  handleUpArrow() {
    const isInteractive = windowManager.getWindowStats().isInteractive;

    if (isInteractive) {
      // Interactive mode: Navigate to previous skill
      this.navigateSkill(-1);
    } else {
      // Non-interactive mode: Move window up
      windowManager.moveBoundWindows(0, -20);
    }
  }

  handleDownArrow() {
    const isInteractive = windowManager.getWindowStats().isInteractive;

    if (isInteractive) {
      // Interactive mode: Navigate to next skill
      this.navigateSkill(1);
    } else {
      // Non-interactive mode: Move window down
      windowManager.moveBoundWindows(0, 20);
    }
  }

  handleLeftArrow() {
    const isInteractive = windowManager.getWindowStats().isInteractive;

    if (!isInteractive) {
      // Non-interactive mode: Move window left
      windowManager.moveBoundWindows(-20, 0);
    }
    // Interactive mode: Left arrow does nothing
  }

  handleRightArrow() {
    const isInteractive = windowManager.getWindowStats().isInteractive;

    if (!isInteractive) {
      // Non-interactive mode: Move window right
      windowManager.moveBoundWindows(20, 0);
    }
    // Interactive mode: Right arrow does nothing
  }

  navigateSkill(direction) {
    const availableSkills = [
      "meeting",
      "dsa",
    ];

    const currentIndex = availableSkills.indexOf(this.activeSkill);
    if (currentIndex === -1) {
      logger.warn("Current skill not found in available skills", {
        currentSkill: this.activeSkill,
        availableSkills,
      });
      return;
    }

    // Calculate new index with wrapping
    let newIndex = currentIndex + direction;
    if (newIndex >= availableSkills.length) {
      newIndex = 0; // Wrap to beginning
    } else if (newIndex < 0) {
      newIndex = availableSkills.length - 1; // Wrap to end
    }

    const newSkill = availableSkills[newIndex];
    this.activeSkill = newSkill;

    // Update session manager with the new skill
    sessionManager.setActiveSkill(newSkill);

    logger.info("Skill navigated via global shortcut", {
      from: availableSkills[currentIndex],
      to: newSkill,
      direction: direction > 0 ? "down" : "up",
    });

    // Broadcast the skill change to all windows
    windowManager.broadcastToAllWindows("skill-updated", { skill: newSkill });
  }

  async triggerScreenshotOCR() {
    if (!this.isReady) {
      logger.warn("Screenshot requested before application ready");
      return;
    }

    const startTime = Date.now();

    try {
      // Guarded like every other answer path: with the unified window
      // present, the loading state and final answer already render inline
      // there via the broadcasts below — popping the separate llmResponse
      // window on top of it is exactly the extra window the unified UI
      // exists to avoid. This call was unconditional, so every screenshot
      // (⌘⇧S or the camera button) opened a second window regardless.
      if (this.shouldShowVoiceOverlay()) {
        windowManager.showLLMLoading();
      }

  const capture = await captureService.captureAndProcess();

      if (!capture.imageBuffer || !capture.imageBuffer.length) {
        windowManager.hideLLMResponse();
        this.broadcastOCRError("Failed to capture screenshot image");
        return;
      }

      // Use image directly with LLM and active skill; do not send chat messages here
      const sessionHistory = sessionManager.getOptimizedHistory();

      const skillsRequiringProgrammingLanguage = ['dsa'];
      const needsProgrammingLanguage = skillsRequiringProgrammingLanguage.includes(this.activeSkill);

      this._responseSeq = (this._responseSeq || 0) + 1;
      const messageId = `img-${Date.now()}-${this._responseSeq}`;
      windowManager.broadcastToAllWindows("transcription-llm-response-start", {
        messageId,
        skill: this.activeSkill
      });

      const llmResult = await llmService.processImageWithSkillStream(
        capture.imageBuffer,
        capture.mimeType || 'image/png',
        this.activeSkill,
        sessionHistory.recent,
        needsProgrammingLanguage ? this.codingLanguage : null,
        (delta) => {
          windowManager.broadcastToAllWindows("transcription-llm-response-chunk", {
            messageId,
            delta
          });
        }
      );
      llmResult.metadata = { ...llmResult.metadata, messageId };

      sessionManager.addModelResponse(llmResult.response, {
        skill: this.activeSkill,
        processingTime: llmResult.metadata.processingTime,
        usedFallback: llmResult.metadata.usedFallback,
        isImageAnalysis: true
      });

      this.broadcastTranscriptionLLMResponse(llmResult);

      if (this.shouldShowVoiceOverlay()) {
        windowManager.showLLMResponse(llmResult.response, {
          skill: this.activeSkill,
          processingTime: llmResult.metadata.processingTime,
          usedFallback: llmResult.metadata.usedFallback,
          isImageAnalysis: true
        });
      }
    } catch (error) {
      logger.error("Screenshot OCR process failed", {
        error: error.message,
        duration: Date.now() - startTime,
      });

      windowManager.hideLLMResponse();
      this.broadcastOCRError(error.message);
      
      sessionManager.addConversationEvent({
        role: 'system',
        content: `Screenshot OCR failed: ${error.message}`,
        action: 'ocr_error',
        metadata: {
          error: error.message
        }
      });
    }
  }

  async processWithLLM(text, sessionHistory) {
    try {
      // Add user input to session memory
      sessionManager.addUserInput(text, 'llm_input');

      // Check if current skill needs programming language context
      const skillsRequiringProgrammingLanguage = ['dsa'];
      const needsProgrammingLanguage = skillsRequiringProgrammingLanguage.includes(this.activeSkill);

      this._responseSeq = (this._responseSeq || 0) + 1;
      const messageId = `chat-${Date.now()}-${this._responseSeq}`;
      windowManager.broadcastToAllWindows("transcription-llm-response-start", {
        messageId,
        skill: this.activeSkill
      });
      // Same guard as triggerScreenshotOCR — was unconditional, so every chat
      // message typed into the unified window's own input box ALSO popped the
      // separate llmResponse window on top of it.
      if (this.shouldShowVoiceOverlay()) {
        windowManager.showLLMLoading();
      }

      const llmResult = await llmService.processTextWithSkillStream(
        text,
        this.activeSkill,
        sessionHistory.recent,
        needsProgrammingLanguage ? this.codingLanguage : null,
        (delta) => {
          windowManager.broadcastToAllWindows("transcription-llm-response-chunk", {
            messageId,
            delta
          });
        }
      );
      llmResult.metadata = { ...llmResult.metadata, messageId };

      logger.info("LLM processing completed, showing response", {
        responseLength: llmResult.response.length,
        skill: this.activeSkill,
        programmingLanguage: needsProgrammingLanguage ? this.codingLanguage : 'not applicable',
        processingTime: llmResult.metadata.processingTime,
        responsePreview: llmResult.response.substring(0, 200) + "...",
      });

      // Add LLM response to session memory
      sessionManager.addModelResponse(llmResult.response, {
        skill: this.activeSkill,
        processingTime: llmResult.metadata.processingTime,
        usedFallback: llmResult.metadata.usedFallback,
      });

      this.broadcastTranscriptionLLMResponse(llmResult);

      if (this.shouldShowVoiceOverlay()) {
        windowManager.showLLMResponse(llmResult.response, {
          skill: this.activeSkill,
          processingTime: llmResult.metadata.processingTime,
          usedFallback: llmResult.metadata.usedFallback,
        });
      }
    } catch (error) {
      logger.error("LLM processing failed", {
        error: error.message,
        skill: this.activeSkill,
      });

      windowManager.hideLLMResponse();
      sessionManager.addConversationEvent({
        role: 'system',
        content: `LLM processing failed: ${error.message}`,
        action: 'llm_error',
        metadata: {
          error: error.message,
          skill: this.activeSkill
        }
      });

      this.broadcastLLMError(error.message);
    }
  }

  /**
   * Buffer a transcribed fragment and (re)arm the coalesce debounce. Fragments
   * are shown in the UI immediately so speech feels live, but the LLM is only
   * asked once the speaker has actually paused — this is what stops one spoken
   * line from producing two separate, slow answers.
   */
  handleTranscriptionFragment(text) {
    const fragment = (text || "").trim();
    if (!fragment) {
      return;
    }

    // Route speech UI events according to the user's response-target setting.
    sessionManager.addUserInput(fragment, 'speech');
    this.sendToVoiceResponseWindows("transcription-received", { text: fragment });

    // Stamp the speaker now, while this fragment is arriving. Reading it later
    // at dispatch time (after the coalesce delay) misattributes fast
    // back-and-forth to whoever happens to be talking when the timer fires.
    const speakerNow = zoomBotService.isBotActive ? zoomBotService.getCurrentSpeaker() : null;
    this._utteranceParts = this._utteranceParts || [];
    this._utteranceParts.push({ speaker: speakerNow, text: fragment });

    this._utteranceBuffer = this._utteranceBuffer
      ? `${this._utteranceBuffer} ${fragment}`
      : fragment;

    if (this._utteranceTimer) {
      clearTimeout(this._utteranceTimer);
      this._utteranceTimer = null;
    }

    // Manual capture emits one complete transcript after the user presses stop,
    // so no debounce/coalescing delay is needed.
    if (speechService.isManualCaptureMode()) {
      this.dispatchCoalescedUtterance();
      return;
    }

    this._utteranceTimer = setTimeout(() => {
      this._utteranceTimer = null;
      this.dispatchCoalescedUtterance();
    }, this._utteranceCoalesceMs);
  }

  /**
   * Send the coalesced utterance to the LLM. If a previous dispatch is still
   * running, leave the buffer intact and let that dispatch's completion pick it
   * up — so we never pile up overlapping requests for the same person talking.
   */
  async dispatchCoalescedUtterance() {
    if (this._utteranceDispatchInFlight) {
      return;
    }
    const rawCombined = this._utteranceBuffer.trim();
    if (!rawCombined) {
      return;
    }
    const parts = this._utteranceParts || [];
    this._utteranceBuffer = "";
    this._utteranceParts = [];
    this._utteranceDispatchInFlight = true;

    // Rebuild the utterance from the per-fragment speaker stamps, merging
    // consecutive fragments from the same person. When several people spoke
    // inside one coalesce window this keeps each line attributed to whoever
    // actually said it instead of collapsing it all onto one name.
    let combined = rawCombined;
    if (zoomBotService.isBotActive && parts.length) {
      const groups = [];
      for (const part of parts) {
        const speaker = part.speaker && part.speaker !== 'Unknown' ? part.speaker : null;
        const last = groups[groups.length - 1];
        if (last && last.speaker === speaker) {
          last.text += ` ${part.text}`;
        } else {
          groups.push({ speaker, text: part.text });
        }
      }
      if (groups.some(g => g.speaker)) {
        combined = groups
          .map(g => (g.speaker ? `[Speaker: ${g.speaker}] ${g.text}` : g.text))
          .join('\n');
      }
    }

    try {
      const sessionHistory = sessionManager.getOptimizedHistory();
      await this.processTranscriptionWithLLM(combined, sessionHistory);
    } catch (error) {
      logger.error("Failed to process transcription with LLM", {
        error: error.message,
        text: combined.substring(0, 100)
      });
    } finally {
      this._utteranceDispatchInFlight = false;
      // Anything that arrived while we were busy gets answered now.
      if (this._utteranceBuffer.trim()) {
        this.dispatchCoalescedUtterance();
      }
    }
  }

  async processTranscriptionWithLLM(text, sessionHistory) {
    // Hoisted so the catch block can tie a fallback answer to the same UI
    // bubble the streaming start event created; otherwise a total failure
    // leaves an empty streamed bubble stranded next to the fallback message.
    let messageId = null;
    try {
      // Validate input text
      if (!text || typeof text !== 'string' || text.trim().length === 0) {
        logger.warn("Skipping LLM processing for empty or invalid transcription", {
          textType: typeof text,
          textLength: text ? text.length : 0
        });
        return;
      }

      const cleanText = text.trim();
      if (cleanText.length < 2) {
        logger.debug("Skipping LLM processing for very short transcription", {
          text: cleanText
        });
        return;
      }

      logger.info("Processing transcription with intelligent LLM response", {
        skill: this.activeSkill,
        textLength: cleanText.length,
        textPreview: cleanText.substring(0, 100) + "..."
      });

      // Meeting mode silencer: transcription is already recorded by
      // handleTranscriptionFragment → sessionManager.addUserInput().
      if (sessionManager.currentMode === 'meeting' || sessionManager.currentMode === 'meet') {
        // Proactive AI Check: See if this text contains a question directed at the user or needs help
        const isQuestion = await llmService.checkIfQuestionPrompt(cleanText);
        
        if (isQuestion) {
          logger.info('Meeting mode: proactive question detected, triggering Ask AI help');
          
          // Send notification to UI
          this.sendToVoiceResponseWindows("display-llm-response", {
            content: "I detected a technical question. Analyzing conversation context...",
            metadata: { source: 'system' }
          });
          
          if (this.shouldShowVoiceOverlay()) {
            windowManager.showLLMLoading();
          }

          // Execute help pipeline proactively
          await this.executeAskAiHelp(true);
        } else {
          logger.info('Meeting mode: transcription recorded silently');
        }
        return;
      }

      // Check if current skill needs programming language context
      const skillsRequiringProgrammingLanguage = ['dsa'];
      const needsProgrammingLanguage = skillsRequiringProgrammingLanguage.includes(this.activeSkill);

      // Stream the answer progressively to the configured speech target.
      // A unique messageId ties the start/chunk/final events to one bubble so
      // the UI never duplicates or interleaves concurrent responses.
      this._responseSeq = (this._responseSeq || 0) + 1;
      messageId = `tr-${Date.now()}-${this._responseSeq}`;
      this.sendToVoiceResponseWindows("transcription-llm-response-start", {
        messageId,
        skill: this.activeSkill
      });
      if (this.shouldShowVoiceOverlay()) {
        windowManager.showLLMLoading();
      }
      const llmResult = await llmService.processTranscriptionWithIntelligentResponseStream(
        cleanText,
        this.activeSkill,
        sessionHistory.recent,
        needsProgrammingLanguage ? this.codingLanguage : null,
        (delta) => {
          this.sendToVoiceResponseWindows("transcription-llm-response-chunk", {
            messageId,
            delta
          });
        }
      );
      llmResult.metadata = { ...llmResult.metadata, messageId };

      // Add LLM response to session memory
      sessionManager.addModelResponse(llmResult.response, {
        skill: this.activeSkill,
        processingTime: llmResult.metadata.processingTime,
        usedFallback: llmResult.metadata.usedFallback,
        isTranscriptionResponse: true
      });

      this.sendTranscriptionLLMResponseToVoiceTargets(llmResult);
      if (this.shouldShowVoiceOverlay()) {
        windowManager.showLLMResponse(llmResult.response, {
          skill: this.activeSkill,
          processingTime: llmResult.metadata.processingTime,
          usedFallback: llmResult.metadata.usedFallback,
          isTranscriptionResponse: true
        });
      }

      logger.info("Transcription LLM response completed", {
        responseLength: llmResult.response.length,
        skill: this.activeSkill,
        programmingLanguage: needsProgrammingLanguage ? this.codingLanguage : 'not applicable',
        processingTime: llmResult.metadata.processingTime
      });

    } catch (error) {
      logger.error("Transcription LLM processing failed", {
        error: error.message,
        errorStack: error.stack,
        skill: this.activeSkill,
        text: text ? text.substring(0, 100) : 'undefined'
      });

      // Try to provide a fallback response
      try {
        const fallbackResult = llmService.generateIntelligentFallbackResponse(text, this.activeSkill);
        // Carry the streaming messageId so the target replaces the live
        // bubble instead of leaving it stuck and appending a duplicate.
        if (messageId) {
          fallbackResult.metadata = { ...fallbackResult.metadata, messageId };
        }

        sessionManager.addModelResponse(fallbackResult.response, {
          skill: this.activeSkill,
          processingTime: fallbackResult.metadata.processingTime,
          usedFallback: true,
          isTranscriptionResponse: true,
          fallbackReason: error.message
        });

        this.sendTranscriptionLLMResponseToVoiceTargets(fallbackResult);
        if (this.shouldShowVoiceOverlay()) {
          windowManager.showLLMResponse(fallbackResult.response, {
            skill: this.activeSkill,
            processingTime: fallbackResult.metadata.processingTime,
            usedFallback: true,
            isTranscriptionResponse: true
          });
        }
        logger.info("Used fallback response for transcription", {
          skill: this.activeSkill,
          fallbackResponse: fallbackResult.response
        });
        
      } catch (fallbackError) {
        logger.error("Fallback response also failed", {
          fallbackError: fallbackError.message
        });

        sessionManager.addConversationEvent({
          role: 'system',
          content: `Transcription LLM processing failed: ${error.message}`,
          action: 'transcription_llm_error',
          metadata: {
            error: error.message,
            skill: this.activeSkill
          }
        });
      }
    }
  }

  broadcastOCRSuccess(ocrResult) {
    windowManager.broadcastToAllWindows("ocr-completed", {
      text: ocrResult.text,
      metadata: ocrResult.metadata,
    });
  }

  broadcastOCRError(errorMessage) {
    windowManager.broadcastToAllWindows("ocr-error", {
      error: errorMessage,
      timestamp: new Date().toISOString(),
    });
  }

  broadcastLLMSuccess(llmResult) {
    const broadcastData = {
      response: llmResult.response,
      metadata: llmResult.metadata,
      skill: this.activeSkill, // Add the current active skill to the top level
    };

    logger.info("Broadcasting LLM success to all windows", {
      responseLength: llmResult.response.length,
      skill: this.activeSkill,
      dataKeys: Object.keys(broadcastData),
      responsePreview: llmResult.response.substring(0, 100) + "...",
    });

    windowManager.broadcastToAllWindows("llm-response", broadcastData);
  }

  broadcastLLMError(errorMessage) {
    windowManager.broadcastToAllWindows("llm-error", {
      error: errorMessage,
      timestamp: new Date().toISOString(),
    });
  }

  broadcastTranscriptionLLMResponse(llmResult) {
    const broadcastData = {
      response: llmResult.response,
      metadata: llmResult.metadata,
      messageId: llmResult.metadata && llmResult.metadata.messageId,
      skill: this.activeSkill,
      isTranscriptionResponse: true
    };

    logger.info("Broadcasting transcription LLM response to all windows", {
      responseLength: llmResult.response.length,
      skill: this.activeSkill,
      responsePreview: llmResult.response.substring(0, 100) + "..."
    });

    windowManager.broadcastToAllWindows("transcription-llm-response", broadcastData);
  }

  sendToChatWindow(channel, data) {
    const chatWindow = windowManager.getWindow("chat");
    if (!chatWindow || chatWindow.isDestroyed()) {
      logger.warn("Chat window unavailable for speech event", { channel });
      return;
    }
    chatWindow.webContents.send(channel, data);
  }

  getVoiceResponseTarget() {
    const configured = String(process.env.WHISPER_RESPONSE_TARGET || 'both').trim().toLowerCase();
    return ['chat', 'overlay', 'both'].includes(configured) ? configured : 'both';
  }

  shouldShowVoiceOverlay() {
    // With the unified window present, answers already render inline there.
    // Popping the separate overlay on top of it is exactly the extra window
    // the single-UI layout exists to avoid.
    const unified = windowManager.getWindow("unified");
    if (unified && !unified.isDestroyed()) {
      return false;
    }
    return ['overlay', 'both'].includes(this.getVoiceResponseTarget());
  }

  sendToVoiceResponseWindows(channel, data) {
    // The unified window shows answers, transcript, and chat together, so it
    // always receives everything regardless of the legacy overlay/chat routing
    // preference (which only chose between the old separate popups).
    const unified = windowManager.getWindow("unified");
    if (unified && !unified.isDestroyed()) {
      unified.webContents.send(channel, data);
    }

    const target = this.getVoiceResponseTarget();
    if (target === 'chat' || target === 'both') {
      this.sendToChatWindow(channel, data);
    }
    if (target === 'overlay' || target === 'both') {
      const responseWindow = windowManager.getWindow("llmResponse");
      if (responseWindow && !responseWindow.isDestroyed()) {
        responseWindow.webContents.send(channel, data);
      }
    }
  }

  sendTranscriptionLLMResponseToVoiceTargets(llmResult) {
    const data = {
      response: llmResult.response,
      metadata: llmResult.metadata,
      messageId: llmResult.metadata && llmResult.metadata.messageId,
      skill: this.activeSkill,
      isTranscriptionResponse: true
    };
    this.sendToVoiceResponseWindows("transcription-llm-response", data);
  }

  onWindowAllClosed() {
    if (process.platform !== "darwin") {
      app.quit();
    }
  }

  onActivate() {
    if (!this.isReady && !this.starting) {
      this.onAppReady();
    } else if (this.isReady) {
      // When app is activated, ensure windows appear on current desktop
      const mainWindow = windowManager.getWindow("main");
      if (mainWindow && mainWindow.isVisible()) {
        windowManager.showOnCurrentDesktop(mainWindow);
      }

      // Also handle other visible windows
      windowManager.windows.forEach((window, type) => {
        if (window.isVisible()) {
          windowManager.showOnCurrentDesktop(window);
        }
      });

      logger.debug("App activated - ensured windows appear on current desktop");
    }
  }

  onWillQuit() {
    globalShortcut.unregisterAll();
    speechService.shutdown();
    windowManager.destroyAllWindows();

    const sessionStats = sessionManager.getMemoryUsage();
    logger.info("Application shutting down", {
      sessionEvents: sessionStats.eventCount,
      sessionSize: sessionStats.approximateSize,
    });
  }

  getWhisperInstaller() {
    if (!this._whisperInstaller) {
      const WhisperInstaller = require("./src/core/whisper-installer");
      const { app } = require("electron");
      this._whisperInstaller = new WhisperInstaller({
        cwd: process.cwd(),
        dataDir: app.getPath("userData"),
        platform: process.platform,
      });
    }
    return this._whisperInstaller;
  }

  getSettings() {
    // Surface every value the settings UI can edit, reading the live source
    // of truth (process.env) so the UI shows exactly what the running app is
    // using. Empty strings are returned rather than skipped so the UI can
    // distinguish "unset" from "stale value from a previous load".
    return {
      codingLanguage: this.codingLanguage || "cpp",
      activeSkill: this.activeSkill || "meeting",
      appIcon: this.appIcon || "terminal",
      selectedIcon: this.appIcon || "terminal",
      windowGap: windowManager.windowGap,
      privacyMode: windowManager.privacyMode,

      speechProvider: speechService.provider || "whisper",
      azureKey: process.env.AZURE_SPEECH_KEY || "",
      azureRegion: process.env.AZURE_SPEECH_REGION || "",
      whisperCommand: process.env.WHISPER_COMMAND || "",
      whisperModel: process.env.WHISPER_MODEL || "small",
      whisperLanguage: process.env.WHISPER_LANGUAGE || "auto",
      whisperDevice: process.env.WHISPER_DEVICE || "auto",
      whisperCaptureMode: process.env.WHISPER_CAPTURE_MODE ||
        (process.env.WHISPER_MANUAL_CAPTURE === "true" ? "manual" : "vad"),
      whisperResponseTarget: process.env.WHISPER_RESPONSE_TARGET || "both",
      whisperSegmentMs: process.env.WHISPER_SEGMENT_MS || "4000",
      geminiKey: process.env.GEMINI_API_KEY || "",

      azureConfigured: !!process.env.AZURE_SPEECH_KEY && !!process.env.AZURE_SPEECH_REGION,
      speechAvailable: this.speechAvailable
    };
  }

  saveSettings(settings) {
    try {
      // ── In-memory updates + window broadcasts ──
      if (settings.codingLanguage) {
        this.codingLanguage = settings.codingLanguage;
        windowManager.broadcastToAllWindows("coding-language-changed", {
          language: settings.codingLanguage,
        });
      }
      if (settings.activeSkill) {
        this.activeSkill = settings.activeSkill;
        windowManager.broadcastToAllWindows("skill-updated", {
          skill: settings.activeSkill,
        });
      }
      if (settings.appIcon) {
        this.appIcon = settings.appIcon;
      }
      if (settings.selectedIcon) {
        this.appIcon = settings.selectedIcon;
        this.updateAppIcon(settings.selectedIcon);
      }
      if (settings.windowGap !== undefined) {
        const gap = Number(settings.windowGap);
        if (Number.isFinite(gap)) windowManager.setWindowGap(gap);
      }
      
      if (settings.privacyMode !== undefined) {
        windowManager.setPrivacyMode(settings.privacyMode);
      }

      // ── Persist provider / API-key fields back to .env ──
      // The settings UI is now the source of truth for these values.
      // Writing to .env ensures they survive app restarts and are picked
      // up the next time the app boots.
      const envUpdates = {};
      if (settings.privacyMode !== undefined) {
        envUpdates.PRIVACY_MODE = String(settings.privacyMode);
      }
      if (settings.speechProvider === "azure" || settings.speechProvider === "whisper") {
        envUpdates.SPEECH_PROVIDER = settings.speechProvider;
      }
      if (settings.azureKey !== undefined) {
        envUpdates.AZURE_SPEECH_KEY = settings.azureKey;
      }
      if (settings.azureRegion !== undefined) {
        envUpdates.AZURE_SPEECH_REGION = settings.azureRegion;
      }
      if (settings.whisperCommand !== undefined) {
        envUpdates.WHISPER_COMMAND = settings.whisperCommand;
      }
      if (settings.whisperModel !== undefined) {
        envUpdates.WHISPER_MODEL = settings.whisperModel;
      }
      if (settings.whisperLanguage !== undefined) {
        envUpdates.WHISPER_LANGUAGE = settings.whisperLanguage;
      }
      if (["auto", "cpu", "cuda"].includes(settings.whisperDevice)) {
        envUpdates.WHISPER_DEVICE = settings.whisperDevice;
      }
      if (["manual", "vad"].includes(settings.whisperCaptureMode)) {
        envUpdates.WHISPER_CAPTURE_MODE = settings.whisperCaptureMode;
      }
      if (["chat", "overlay", "both"].includes(settings.whisperResponseTarget)) {
        envUpdates.WHISPER_RESPONSE_TARGET = settings.whisperResponseTarget;
      }
      if (settings.whisperSegmentMs !== undefined) {
        envUpdates.WHISPER_SEGMENT_MS = String(settings.whisperSegmentMs);
      }
      if (settings.geminiKey !== undefined) {
        envUpdates.GEMINI_API_KEY = settings.geminiKey;
      }

      // Capture the previous whisper command BEFORE persisting — persistEnvUpdates
      // mutates process.env in place, so comparing afterwards would always read
      // equal and skip the speech re-init below (the exact stale-mic-after-install
      // bug the re-init guards against).
      const prevWhisperCommand = process.env.WHISPER_COMMAND || '';

      const persistedKeys = this.persistEnvUpdates(envUpdates);

      // If the Gemini key was just saved, reinitialize the LLM service
      // so the new client picks up the key. Without this, the test-
      // connection button in the onboarding wizard fails with
      // "Service not initialized" because the client was first created
      // at app startup, before any key was set.
      if (settings.geminiKey !== undefined && envUpdates.GEMINI_API_KEY !== undefined) {
        try {
          llmService.initializeClient();
          logger.info("LLM service reinitialized after Gemini key update");
        } catch (e) {
          logger.warn("Failed to reinitialize LLM service after Gemini key update", {
            error: e.message
          });
        }
      }

      // Reinitialize speech service when provider OR whisper command
      // changes. Without the second check, the install flow (which
      // writes a new whisperCommand after install but keeps the same
      // provider) would leave the speech service pointing at a stale
      // (or non-existent) binary, and the main overlay's mic button
      // would stay hidden / non-functional.
      const providerChanged = settings.speechProvider && speechService.provider !== settings.speechProvider;
      const whisperCommandChanged = settings.whisperCommand !== undefined &&
        prevWhisperCommand !== String(settings.whisperCommand || '');
      if (providerChanged || whisperCommandChanged) {
        try {
          speechService.initializeClient();
          this.speechAvailable = speechService.isAvailable
            ? speechService.isAvailable()
            : false;
          // Broadcast so any open window (settings, overlay, chat)
          // can react immediately — especially the main overlay's
          // mic button, which queries availability on load.
          const { BrowserWindow } = require("electron");
          BrowserWindow.getAllWindows().forEach((win) => {
            if (!win.isDestroyed()) {
              win.webContents.send("speech-availability", { available: this.speechAvailable });
            }
          });
          logger.info('Speech service reinitialized after settings change', {
            providerChanged,
            whisperCommandChanged,
            speechAvailable: this.speechAvailable,
          });
        } catch (e) {
          logger.warn("Failed to reinitialize speech service after settings change", {
            error: e.message
          });
        }
      }

      logger.info("Settings saved successfully", {
        ...settings,
        persistedEnvKeys: persistedKeys
      });
      return { success: true, persistedEnvKeys: persistedKeys };
    } catch (error) {
      logger.error("Failed to save settings", { error: error.message });
      return { success: false, error: error.message };
    }
  }

  persistSettings(settings) {
    // You can extend this to save to a file or database
    // For now, we'll just keep them in memory
    logger.debug("Settings persisted", settings);
  }

  /**
   * Write key=value pairs to the project's .env file. Existing keys are
   * replaced in-place; new keys are appended. Comments and unrelated lines
   * are preserved. Uses an atomic write (temp file + rename) so a crash
   * mid-write cannot corrupt .env.
   *
   * @param {Object<string, string>} updates - keys to upsert
   * @returns {string[]} keys that were actually persisted
   */
  persistEnvUpdates(updates) {
    if (!updates || typeof updates !== "object") return [];
    const keys = Object.keys(updates);
    if (keys.length === 0) return [];

    const fs = require("fs");
    // Single source of truth — the same file dotenv loaded at startup and that
    // FirstRunManager reads/writes (userData in packaged builds, project .env
    // in dev). Writing to process.cwd() here would silently diverge.
    const envPath = ENV_PATH;

    let existing = "";
    try {
      existing = fs.readFileSync(envPath, "utf8");
    } catch (_) {
      // .env doesn't exist yet — we'll create one from scratch
      existing = "";
    }

    const existingLines = existing.length > 0 ? existing.split(/\r?\n/) : [];
    const updated = new Set();
    const outLines = [];

    for (const line of existingLines) {
      // Match "KEY=" (with optional whitespace) but skip comment lines
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=/);
      if (m && Object.prototype.hasOwnProperty.call(updates, m[1])) {
        const key = m[1];
        outLines.push(`${key}=${formatEnvValue(updates[key])}`);
        updated.add(key);
      } else {
        outLines.push(line);
      }
    }

    // Append any keys that weren't already present
    for (const key of keys) {
      if (!updated.has(key)) {
        outLines.push(`${key}=${formatEnvValue(updates[key])}`);
        updated.add(key);
      }
    }

    // Update process.env so the running app picks up the new values
    // immediately (and so the settings UI reads the same source of truth).
    for (const key of keys) {
      process.env[key] = String(updates[key]);
    }

    const newContent = outLines.join("\n");
    try {
      const tmpPath = envPath + ".tmp";
      fs.writeFileSync(tmpPath, newContent, "utf8");
      fs.renameSync(tmpPath, envPath);
    } catch (e) {
      logger.error("Failed to persist .env updates", {
        error: e.message,
        keys
      });
      return [];
    }

    logger.info("Persisted .env updates", { keys: Array.from(updated) });
    return Array.from(updated);
  }

  updateAppIcon(iconKey) {
    try {
      const { app } = require("electron");
      const path = require("path");
      const fs = require("fs");

      // Icon mapping for available icons in assests/icons folder
      const iconPaths = {
        terminal: "assests/icons/terminal.png",
        activity: "assests/icons/activity.png",
        settings: "assests/icons/settings.png",
      };

      // App name mapping for stealth mode
      const appNames = {
        terminal: "Terminal ",
        activity: "Activity Monitor ",
        settings: "System Settings ",
      };

      const iconPath = iconPaths[iconKey];
      const appName = appNames[iconKey];

      if (!iconPath) {
        logger.error("Invalid icon key", { iconKey });
        return { success: false, error: "Invalid icon key" };
      }

      const fullIconPath = path.resolve(__dirname, iconPath);

      if (!fs.existsSync(fullIconPath)) {
        logger.error("Icon file not found", {
          iconKey,
          iconPath: fullIconPath,
        });
        return { success: false, error: "Icon file not found" };
      }

      // Set app icon for dock/taskbar
      if (process.platform === "darwin") {
        // macOS - update dock icon (only if dock is available)
        if (app.dock) {
          app.dock.setIcon(fullIconPath);

          // Force dock refresh with multiple attempts
          const retryDockIcon = () => {
            try { app.dock.setIcon(fullIconPath); } catch (_) { /* dock may not exist */ }
          };
          setTimeout(retryDockIcon, 100);
          setTimeout(retryDockIcon, 500);
        }
      } else {
        // Windows/Linux - update window icons
        windowManager.windows.forEach((window, type) => {
          if (window && !window.isDestroyed()) {
            window.setIcon(fullIconPath);
          }
        });
      }

      // Update app name for stealth mode
      this.updateAppName(appName, iconKey);

      logger.info("App icon and name updated successfully", {
        iconKey,
        appName,
        iconPath: fullIconPath,
        platform: process.platform,
        fileExists: fs.existsSync(fullIconPath),
      });

      this.appIcon = iconKey;
      return { success: true };
    } catch (error) {
      logger.error("Failed to update app icon", {
        error: error.message,
        stack: error.stack,
      });
      return { success: false, error: error.message };
    }
  }

  updateAppName(appName, iconKey) {
    try {
      const { app } = require("electron");

      // Force update process title for Activity Monitor stealth - CRITICAL
      process.title = appName;

      // Set app name in dock (macOS) - this affects the dock and Activity Monitor
      if (process.platform === "darwin") {
        // Multiple attempts to ensure the name sticks
        app.setName(appName);

        // Clear dock badge and reset
        if (app.dock) {
          app.dock.setBadge("");
          // Force dock refresh
          setTimeout(() => {
            app.dock.setIcon(
              require("path").resolve(__dirname, `assests/icons/${iconKey}.png`)
            );
          }, 50);
        }
      }

      // Set app user model ID for Windows taskbar grouping (Windows only)
      if (process.platform === "win32") {
        app.setAppUserModelId(`${appName.trim()}-${iconKey}`);
      }

      // Update all window titles to match the new app name
      const windows = windowManager.windows;
      windows.forEach((window, type) => {
        if (window && !window.isDestroyed()) {
          // Use stealth name for all windows
          const stealthTitle = appName.trim();
          window.setTitle(stealthTitle);
        }
      });

      // Multiple force refreshes with increasing delays
      const refreshTimes = [50, 100, 200, 500];
      refreshTimes.forEach((delay) => {
        setTimeout(() => {
          process.title = appName;
          if (process.platform === "darwin") {
            app.setName(appName);
            // Force update bundle display name
            if (app.getName() !== appName) {
              app.setName(appName);
            }
          }
        }, delay);
      });

      logger.info("App name updated for stealth mode", {
        appName,
        processTitle: process.title,
        appGetName: app.getName(),
        iconKey,
        platform: process.platform,
      });
    } catch (error) {
      logger.error("Failed to update app name", { error: error.message });
    }
  }
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  const controller = new ApplicationController();
  app.on("second-instance", () => controller.handleSecondInstance());
}
