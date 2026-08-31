/**
 * Fetches the bundled whisper.cpp model weights, run automatically before
 * building an installer (see package.json's build:* scripts) and usable
 * standalone for local dev setup.
 *
 * These aren't committed to git: at ~487MB they'd be rejected outright by
 * GitHub's 100MB-per-file push limit, and would bloat the repo permanently
 * even with Git LFS. Fetching from the same official Hugging Face source
 * whisper.cpp's own download script uses keeps the repo small while still
 * giving every build the exact same model — no local variation.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const MODEL_NAME = process.env.WHISPER_MODEL || 'small.en';
const MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${MODEL_NAME}.bin`;
const OUT_DIR = path.join(__dirname, '..', 'resources', 'whisper-cpp', 'models');
const OUT_PATH = path.join(OUT_DIR, `ggml-${MODEL_NAME}.bin`);

function download(url, destPath, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Too many redirects'));

    const request = https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(download(res.headers.location, destPath, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Download failed: HTTP ${res.statusCode} for ${url}`));
      }

      const total = Number(res.headers['content-length'] || 0);
      let received = 0;
      let lastPct = -1;
      const file = fs.createWriteStream(destPath);

      res.on('data', (chunk) => {
        received += chunk.length;
        if (total) {
          const pct = Math.floor((received / total) * 100);
          if (pct !== lastPct && pct % 5 === 0) {
            lastPct = pct;
            process.stdout.write(`\r  Downloading ${MODEL_NAME} model: ${pct}%`);
          }
        }
      });

      res.pipe(file);
      file.on('finish', () => {
        file.close(() => {
          process.stdout.write('\n');
          resolve();
        });
      });
      file.on('error', reject);
    });

    request.on('error', reject);
  });
}

async function main() {
  if (fs.existsSync(OUT_PATH) && fs.statSync(OUT_PATH).size > 0) {
    console.log(`Whisper model already present: ${OUT_PATH}`);
    return;
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`Fetching bundled Whisper model from ${MODEL_URL} ...`);

  const tmpPath = OUT_PATH + '.download';
  try {
    await download(MODEL_URL, tmpPath);
    fs.renameSync(tmpPath, OUT_PATH);
    console.log(`Saved to ${OUT_PATH}`);
  } catch (error) {
    try { fs.unlinkSync(tmpPath); } catch (e) { /* best-effort cleanup */ }
    console.error(`Failed to download Whisper model: ${error.message}`);
    process.exit(1);
  }
}

main();
