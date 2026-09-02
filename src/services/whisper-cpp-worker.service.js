/**
 * Bundled, no-Python transcription backend using whisper.cpp instead of
 * openai-whisper/PyTorch.
 *
 * Why this exists: the original WhisperWorkerService spawns a persistent
 * Python process running PyTorch + openai-whisper. That's fine when the user
 * sets up their own Python environment, but it cannot be "bundled" into a
 * distributable installer without shipping PyTorch itself — several hundred
 * MB, platform-specific (separate Mac/Windows builds), and still requires a
 * working Python on the target machine. whisper.cpp is a self-contained
 * native binary with no runtime dependency at all, small enough to ship
 * directly inside the app (~1.7MB on Mac, ~8MB on Windows with its DLLs).
 *
 * This implements the exact same public interface as WhisperWorkerService
 * (configure/isConfigured/transcribe/warmup/releaseWhenIdle) so
 * speech.service.js can use either one interchangeably. Unlike the Python
 * worker, this has no persistent process to manage — whisper.cpp's model
 * load time on modern hardware (~250ms with Metal on Apple Silicon) is fast
 * enough that a one-shot process per utterance is simpler and more robust
 * than keeping a server alive, with nothing to leak or hang.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const logger = require('../core/logger').createServiceLogger('WHISPER-CPP');

/**
 * Resolve the bundled whisper.cpp binary for the current platform/arch.
 * Works both in development (resources/ next to the project root) and in a
 * packaged Electron app (process.resourcesPath, via electron-builder's
 * extraResources — see package.json).
 */
function resolveBundledBinary() {
  const isPackaged = !!(process.versions && process.versions.electron) &&
    require('electron').app && require('electron').app.isPackaged;
  const base = isPackaged
    ? path.join(process.resourcesPath, 'whisper-cpp')
    : path.join(__dirname, '..', '..', 'resources', 'whisper-cpp');

  if (process.platform === 'darwin') {
    return path.join(base, 'mac', 'whisper-cli');
  }
  if (process.platform === 'win32') {
    return path.join(base, 'win', 'main.exe');
  }
  // Linux isn't bundled yet — no official prebuilt binary was vetted for it
  // in this pass. Falls through to isConfigured() returning false, so the
  // caller's existing Python-CLI fallback path still works there.
  return null;
}

function resolveBundledModel(modelName, language) {
  const isPackaged = !!(process.versions && process.versions.electron) &&
    require('electron').app && require('electron').app.isPackaged;
  const base = isPackaged
    ? path.join(process.resourcesPath, 'whisper-cpp', 'models')
    : path.join(__dirname, '..', '..', 'resources', 'whisper-cpp', 'models');

  // English-only models (ggml-<size>.en.bin) are smaller and more accurate
  // than the multilingual ones, but ONLY understand English — using one for
  // any other language would silently mistranscribe everything. Only prefer
  // it when the configured language is actually English; "auto"/unset stays
  // on the multilingual model so language auto-detection still works.
  if (language === 'en') {
    const enVariant = path.join(base, `ggml-${modelName}.en.bin`);
    if (fs.existsSync(enVariant)) {
      return enVariant;
    }
  }

  const exact = path.join(base, `ggml-${modelName}.bin`);
  if (fs.existsSync(exact)) {
    return exact;
  }

  // Fall back to whatever model file actually got bundled, rather than
  // hard-failing on an exact filename match. Only one model is ever
  // downloaded per build (see scripts/download-whisper-model.js), so if
  // the configured language/model-name combination doesn't match its
  // exact filename -- e.g. a fresh install with no local .env yet
  // defaults WHISPER_LANGUAGE to "auto", but only the "small.en" model
  // was actually bundled -- this still finds and uses it instead of
  // reporting Whisper as unavailable. Verified this was a real gap: a
  // genuinely fresh install (no pre-existing .env) hit exactly this
  // mismatch and got "Speech provider whisper is not available".
  try {
    const bundled = fs.readdirSync(base).find((f) => f.startsWith('ggml-') && f.endsWith('.bin'));
    if (bundled) {
      return path.join(base, bundled);
    }
  } catch (_) {
    // models directory doesn't exist at all -- fall through to the
    // exact (missing) path below, which isConfigured() will correctly
    // report as not ready.
  }

  return exact;
}

class WhisperCppWorkerService {
  constructor() {
    this.binaryPath = null;
    this.modelPath = null;
  }

  /** Auto-detects the bundled binary/model; call this before isConfigured(). */
  autoConfigure(modelName, language) {
    this.binaryPath = resolveBundledBinary();
    this.modelPath = this.binaryPath ? resolveBundledModel(modelName || 'small', language) : null;
  }

  isConfigured() {
    return !!(
      this.binaryPath &&
      this.modelPath &&
      fs.existsSync(this.binaryPath) &&
      fs.existsSync(this.modelPath)
    );
  }

  /** No persistent process to warm up — native load is fast enough that this is a no-op. */
  async warmup() {
    return { model: path.basename(this.modelPath || ''), device: 'cpu', gpu: null };
  }

  /** No persistent process to release. */
  releaseWhenIdle() {}

  /**
   * Transcribe a WAV file. Returns the same shape WhisperWorkerService
   * returns: { text, model, device, gpu, language }.
   */
  async transcribe(audioPath, options = {}) {
    if (!this.isConfigured()) {
      throw new Error('whisper.cpp worker is not configured (missing bundled binary or model)');
    }

    const modelName = options.model || 'small';
    // Re-resolve in case the configured model/language differs from what
    // autoConfigure picked (e.g. changed mid-session).
    const modelPath = resolveBundledModel(modelName, options.language);
    if (!fs.existsSync(modelPath)) {
      throw new Error(`Bundled whisper.cpp model not found for "${modelName}": ${modelPath}`);
    }

    const outputBase = path.join(os.tmpdir(), `whisper-cpp-out-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const args = [
      '-m', modelPath,
      '-f', audioPath,
      '-of', outputBase,
      '-otxt',
      '-nt', // no timestamps in the text output
      '-t', String(Math.max(1, os.cpus().length - 1))
    ];

    const language = options.language;
    if (language && language !== 'auto' && language !== 'detect') {
      args.push('-l', language);
    }

    const startedAt = Date.now();
    await new Promise((resolve, reject) => {
      const child = spawn(this.binaryPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(stderr.trim() || `whisper.cpp exited with code ${code}`));
      });
    });

    const txtPath = `${outputBase}.txt`;
    let text = '';
    try {
      text = fs.existsSync(txtPath) ? fs.readFileSync(txtPath, 'utf8').trim() : '';
    } finally {
      try { fs.unlinkSync(txtPath); } catch (e) { /* best-effort cleanup */ }
    }

    logger.debug('whisper.cpp transcription completed', {
      processingTime: Date.now() - startedAt,
      model: modelName
    });

    return { text, model: modelName, device: 'cpu', gpu: null, language: language || 'auto' };
  }
}

module.exports = { WhisperCppWorkerService, resolveBundledBinary, resolveBundledModel };
