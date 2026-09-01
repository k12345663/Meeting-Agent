/**
 * Talks to the Offshoremitra admin panel (admin-server/) on behalf of this
 * desktop app instance. This is the "end user" side of the OTP auth system
 * admin-server/routes/user.js implements — a lightweight email login (no
 * password) that unlocks a config fetch: the real Gemini/Azure keys and
 * feature-flag state an admin has set, instead of a local .env.
 *
 * Session (the JWT) and the last-successfully-fetched config are both
 * cached to disk in the OS user-data dir so:
 *   - the app doesn't need a fresh OTP login every single launch (the
 *     server issues a 30-day token)
 *   - the app can still start on a plane/VPN-less network using the last
 *     known-good config, rather than hard-failing the moment the admin
 *     server is unreachable
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { app } = require('electron');

const DEFAULT_SERVER_URL = 'https://offshoremitra-admin.onrender.com';

class AdminClientService {
  constructor() {
    this.serverUrl = (process.env.ADMIN_SERVER_URL || DEFAULT_SERVER_URL).replace(/\/+$/, '');
    // Resolved lazily (see _sessionPath/_cachePath) rather than here: this
    // singleton is constructed at module-require time, which happens near
    // the very top of main.js -- well before app.whenReady() -- and
    // app.getPath('userData') is safest to call once the app is actually
    // ready rather than assumed safe at arbitrary require-time ordering.
    this._sessionPathCache = null;
    this._cachePathCache = null;
    // Feature-flag state as of the last successful fetch (fresh or cached).
    // Deliberately starts empty rather than all-false: isFeatureEnabled()
    // fails OPEN for any flag it has no data on yet, so a flag added on the
    // server after this app version shipped doesn't silently disable
    // itself, and a not-yet-authenticated app doesn't lock every feature.
    this.featureFlags = {};
  }

  get sessionPath() {
    if (!this._sessionPathCache) {
      this._sessionPathCache = path.join(app.getPath('userData'), 'account-session.json');
    }
    return this._sessionPathCache;
  }

  get cachePath() {
    if (!this._cachePathCache) {
      this._cachePathCache = path.join(app.getPath('userData'), 'account-config-cache.json');
    }
    return this._cachePathCache;
  }

  // ---- local persistence -------------------------------------------------

  loadSession() {
    try {
      const raw = fs.readFileSync(this.sessionPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.token === 'string' && typeof parsed.email === 'string') {
        return parsed;
      }
    } catch (_) { /* no session yet, or corrupt -- treat as signed out */ }
    return null;
  }

  saveSession(session) {
    try {
      fs.mkdirSync(path.dirname(this.sessionPath), { recursive: true });
      fs.writeFileSync(this.sessionPath, JSON.stringify(session), { mode: 0o600 });
    } catch (error) {
      console.error('[admin-client] Failed to persist session:', error.message);
    }
  }

  clearSession() {
    try { fs.unlinkSync(this.sessionPath); } catch (_) { /* already gone */ }
  }

  loadCachedConfig() {
    try {
      return JSON.parse(fs.readFileSync(this.cachePath, 'utf8'));
    } catch (_) {
      return null;
    }
  }

  saveCachedConfig(cfg) {
    try {
      fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
      fs.writeFileSync(this.cachePath, JSON.stringify(cfg), { mode: 0o600 });
    } catch (error) {
      console.error('[admin-client] Failed to cache config:', error.message);
    }
  }

  // ---- HTTP ----------------------------------------------------------------

  _request(method, urlPath, { body, token } = {}) {
    return new Promise((resolve, reject) => {
      let target;
      try {
        target = new URL(this.serverUrl + urlPath);
      } catch (error) {
        return reject(new Error(`Invalid ADMIN_SERVER_URL: ${this.serverUrl}`));
      }
      const transport = target.protocol === 'http:' ? http : https;
      const payload = body ? Buffer.from(JSON.stringify(body)) : null;
      const headers = { 'Content-Type': 'application/json' };
      if (payload) headers['Content-Length'] = payload.length;
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const req = transport.request(
        target,
        // Render's free tier can take 50+ seconds to wake from its
        // inactivity sleep (per its own dashboard warning) -- a shorter
        // timeout here guarantees the very first request after any idle
        // period fails client-side before the server even finishes
        // waking up, which is exactly what was happening (surfaced as
        // "Request to admin server timed out" on a real cold instance).
        { method, headers, timeout: 70000 },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let data = {};
            try { data = text ? JSON.parse(text) : {}; } catch (_) { /* non-JSON error page */ }
            resolve({ status: res.statusCode, data });
          });
        }
      );
      req.on('timeout', () => req.destroy(new Error('Request to admin server timed out')));
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  async requestOtp(email) {
    const { status, data } = await this._request('POST', '/api/user/request-otp', { body: { email } });
    if (status === 429) throw new Error(data.error || 'Please wait before requesting another code.');
    if (status >= 400) throw new Error(data.error || 'Failed to request a login code.');
    return data;
  }

  async verifyOtp(email, code) {
    const { status, data } = await this._request('POST', '/api/user/verify-otp', { body: { email, code } });
    if (status >= 400) throw new Error(data.error || 'Incorrect or expired code.');
    this.saveSession({ token: data.token, email: data.email });
    return data;
  }

  /**
   * Fetches live config using the cached session token. Throws with
   * `.code = 'UNAUTHENTICATED'` if there's no session or the server
   * rejects the token (expired/revoked) -- callers should route that into
   * the login flow rather than treating it as a transient network error.
   */
  async fetchConfig() {
    const session = this.loadSession();
    if (!session) {
      const err = new Error('Not signed in');
      err.code = 'UNAUTHENTICATED';
      throw err;
    }
    const { status, data } = await this._request('GET', '/api/user/config', { token: session.token });
    if (status === 401 || status === 403) {
      this.clearSession();
      const err = new Error(data.error || 'Session expired or access revoked');
      err.code = 'UNAUTHENTICATED';
      throw err;
    }
    if (status >= 400) {
      throw new Error(data.error || 'Failed to fetch config from admin server');
    }
    this.saveCachedConfig(data);
    return data;
  }

  signOut() {
    this.clearSession();
  }

  // ---- applying fetched config into the running app ------------------------

  /**
   * Pushes a fetched (or cached) config payload into the app's live state:
   * env vars the rest of the codebase already reads (config.getApiKey, etc.)
   * plus the already-initialized llm/speech service singletons, so a config
   * refresh takes effect immediately without restarting the app. Blank
   * fields are skipped rather than clearing an existing value -- an admin
   * leaving Azure fields empty shouldn't wipe out a Gemini-only setup.
   */
  applyConfig(cfg) {
    const settings = (cfg && cfg.settings) || {};

    if (settings.geminiApiKey) {
      process.env.GEMINI_API_KEY = settings.geminiApiKey;
      try {
        // eslint-disable-next-line global-require
        require('./llm.service').updateApiKey(settings.geminiApiKey);
      } catch (error) {
        console.error('[admin-client] Failed to apply Gemini key to llm.service:', error.message);
      }
    }
    if (settings.azureSpeechRegion) process.env.AZURE_SPEECH_REGION = settings.azureSpeechRegion;
    if (settings.whisperModel) process.env.WHISPER_MODEL = settings.whisperModel;
    if (settings.whisperLanguage) process.env.WHISPER_LANGUAGE = settings.whisperLanguage;
    if (settings.speechProvider) process.env.SPEECH_PROVIDER = settings.speechProvider;

    const speechUpdates = {};
    if (settings.azureSpeechKey) speechUpdates.azureKey = settings.azureSpeechKey;
    if (settings.azureSpeechRegion) speechUpdates.azureRegion = settings.azureSpeechRegion;
    if (settings.whisperModel) speechUpdates.whisperModel = settings.whisperModel;
    if (settings.whisperLanguage) speechUpdates.whisperLanguage = settings.whisperLanguage;
    if (settings.speechProvider) speechUpdates.speechProvider = settings.speechProvider;
    if (Object.keys(speechUpdates).length) {
      try {
        // eslint-disable-next-line global-require
        require('./speech.service').updateSettings(speechUpdates);
      } catch (error) {
        console.error('[admin-client] Failed to apply settings to speech.service:', error.message);
      }
    }

    if (cfg && cfg.featureFlags && typeof cfg.featureFlags === 'object') {
      this.featureFlags = { ...cfg.featureFlags };
    }
  }

  /** Fails open for any flag never seen from the server (see constructor note). */
  isFeatureEnabled(key) {
    if (!(key in this.featureFlags)) return true;
    return this.featureFlags[key] !== false;
  }

  getFeatureFlags() {
    return { ...this.featureFlags };
  }

  isSignedIn() {
    return !!this.loadSession();
  }

  getSignedInEmail() {
    return this.loadSession()?.email || null;
  }
}

module.exports = new AdminClientService();
