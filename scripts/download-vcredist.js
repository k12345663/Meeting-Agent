/**
 * Fetches the Microsoft Visual C++ Redistributable installer, run
 * automatically before a Windows build (see package.json's build:win /
 * build:all) and bundled into the NSIS installer (see
 * scripts/post-install-nsis.nsh) so it can be silently installed alongside
 * the app.
 *
 * Why this exists: the bundled whisper.cpp Windows binaries
 * (resources/whisper-cpp/win/*.dll, main.exe) are built with MSVC and
 * dynamically link against the VC++ runtime (MSVCP140.dll,
 * VCRUNTIME140.dll, VCRUNTIME140_1.dll) -- confirmed via `strings` on the
 * shipped DLLs. That runtime is NOT part of Windows by default and is not
 * something electron-builder bundles on its own. A dev machine (or a CI
 * runner) almost always already has it from some other app/toolchain, so
 * this gap only surfaces on a genuinely clean end-user Windows install --
 * exactly the "Speech provider whisper is not available" symptom, except
 * this time on Windows rather than the missing-shared-library bug that hit
 * macOS. Bundling this and installing it silently closes that gap for
 * every install, not just ones that happen to already have it.
 *
 * This is Microsoft's own official redistributable, licensed specifically
 * for exactly this purpose (bundling into a third-party installer) --
 * https://aka.ms/vs/17/release/vc_redist.x64.exe is Microsoft's permanent,
 * always-current-version permalink for it, the same one Microsoft's own
 * docs point developers to.
 *
 * Not committed to git (this repo's convention for large fetched binaries
 * -- see download-whisper-model.js): ~25MB, and re-downloading it here on
 * every build guarantees the latest security-patched version, not
 * whatever version happened to be committed at some point in the past.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const VCREDIST_URL = 'https://aka.ms/vs/17/release/vc_redist.x64.exe';
const OUT_PATH = path.join(__dirname, '..', 'resources', 'vc_redist.x64.exe');

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
          if (pct !== lastPct && pct % 10 === 0) {
            lastPct = pct;
            process.stdout.write(`\r  Downloading VC++ Redistributable: ${pct}%`);
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
    console.log(`VC++ Redistributable already present: ${OUT_PATH}`);
    return;
  }

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  console.log(`Fetching VC++ Redistributable from ${VCREDIST_URL} ...`);

  const tmpPath = OUT_PATH + '.download';
  try {
    await download(VCREDIST_URL, tmpPath);
    fs.renameSync(tmpPath, OUT_PATH);
    console.log(`Saved to ${OUT_PATH}`);
  } catch (error) {
    try { fs.unlinkSync(tmpPath); } catch (e) { /* best-effort cleanup */ }
    console.error(`Failed to download VC++ Redistributable: ${error.message}`);
    process.exit(1);
  }
}

main();
