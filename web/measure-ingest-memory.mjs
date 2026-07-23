// M3 Task 5: synthetic full-install-scale ingest memory measurement.
//
// Builds a GOG-scale (~300-400MB) zip from RANDOM bytes ONLY (crypto.randomFillSync —
// NEVER real game data, never committed), serves it alongside the built shell, ingests
// it through the ?test=1 hook (window.__corsixthTest.ingestZip — see web/src/main.ts),
// and records peak JS heap (performance.memory.usedJSHeapSize) during the storage
// phase. This is meant to be run once against the pre-fix (unbounded-drain) source and
// once against the post-fix (MAX_INFLIGHT_PUTS-bounded) source, to compare peak heap
// before vs after — see docs/superpowers/reports/m3-ingest-memory.md.
//
// NOTE: performance.memory is Chromium-only and coarse (rounded, GC-dependent) — this
// is a DIRECTIONAL check that the bound holds at size, not a precise allocator readout.
//
// The synthetic entries deliberately do NOT include the three engine-required paths
// (DATA/VBLK-0.TAB, LEVELS/LEVEL.L1, QDATA/SPOINTER.DAT), so validateAssetPaths() fails
// by design: ingestZip's finishIngest() clears the store and throws instead of
// rebooting the engine (location.reload()). That's fine here — the memory we care
// about is produced during the streaming unzip + putAsset storage phase, which runs to
// completion before validation ever looks at the result. Failing validation also means
// no reload races the measurement, and the recovery-branch clearAssets() is a useful
// bonus cleanup of the ~300-400MB we just wrote into IndexedDB.
import puppeteer from 'puppeteer-core';
import { zipSync } from 'fflate';
import { execSync } from 'node:child_process';
import { writeFileSync, rmSync, statSync, createReadStream, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, extname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomFillSync } from 'node:crypto';

const DIST = resolve('dist');
const PORT = 8129;
const TARGET_BYTES = 320 * 1024 * 1024; // ~320MB synthetic full-install profile
const MIN_CHUNK = 0.4 * 1024 * 1024;
const MAX_CHUNK = 2 * 1024 * 1024;
const ALLOWED_TOP_DIRS = ['DATA', 'DATAM', 'LEVELS', 'QDATA', 'QDATAM', 'ANIMS', 'INTRO', 'SOUND'];

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  for (const c of ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser']) {
    try { return execSync(`which ${c}`).toString().trim(); } catch { /* next */ }
  }
  return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
}

function randBytes(n) {
  const b = Buffer.allocUnsafe(n);
  randomFillSync(b);
  return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
}

// Build the synthetic zip's file table from random bytes only, laid out under the
// engine's allowed top-level dirs (so normalizeAssetPath accepts every entry) but never
// touching the three exact required filenames (see module doc above).
function buildSyntheticFiles() {
  const files = {};
  let total = 0;
  let i = 0;
  while (total < TARGET_BYTES) {
    const dir = ALLOWED_TOP_DIRS[i % ALLOWED_TOP_DIRS.length];
    const size = MIN_CHUNK + Math.floor(Math.random() * (MAX_CHUNK - MIN_CHUNK));
    files[`${dir}/SYNTH${String(i).padStart(4, '0')}.DAT`] = randBytes(size);
    total += size;
    i++;
  }
  return { files, count: i, total };
}

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.wasm': 'application/wasm',
  '.css': 'text/css', '.map': 'application/json', '.zip': 'application/zip',
};

// Serve DIST for the shell, plus /SYNTH.zip streamed straight from its $TMPDIR path —
// keeps the ~300-400MB synthetic payload out of the (gitignored, but otherwise
// untouched) dist/ directory entirely.
function serve(zipPath, port) {
  const server = createServer((req, res) => {
    const url = req.url.split('?')[0];
    const full = url === '/SYNTH.zip' ? zipPath : join(DIST, url === '/' ? '/index.html' : url);
    try {
      const st = statSync(full);
      res.writeHead(200, { 'Content-Type': MIME[extname(full)] || 'application/octet-stream', 'Content-Length': st.size });
      createReadStream(full).pipe(res);
    } catch {
      res.writeHead(404); res.end('not found');
    }
  });
  // Reject (not the default "throw and crash the process") on listen failure (e.g.
  // EPERM under a filesystem/network sandbox, or the port already in use) so the
  // caller's try/finally still runs and the synthetic zip gets cleaned up.
  return new Promise((resolve_, reject_) => {
    server.once('error', reject_);
    server.listen(port, () => resolve_(server));
  });
}

if (!existsSync(join(DIST, 'corsix-th.js'))) { console.error('FAIL: build dist/ first (npm run build)'); process.exit(1); }

const zipPath = join(tmpdir(), `corsixth-synth-ingest-${process.pid}.zip`);
const { files, count, total } = buildSyntheticFiles();
console.log(`synthetic zip (RANDOM bytes only, never real game data): ${count} entries, ${(total / 1024 / 1024).toFixed(1)} MB raw`);
writeFileSync(zipPath, zipSync(files, { level: 0 }));
console.log(`written to ${zipPath} (\$TMPDIR, never committed)`);

let server, browser;
try {
  server = await serve(zipPath, PORT);
  browser = await puppeteer.launch({ executablePath: chromePath(), args: ['--no-sandbox', '--disable-gpu', '--js-flags=--expose-gc'] });
  const page = await browser.newPage();
  await page.goto(`http://localhost:${PORT}/index.html?test=1`, { waitUntil: 'load' });
  await page.waitForFunction('window.__corsixthTest && typeof window.__corsixthTest.ingestZip === "function"', { timeout: 20_000 });

  const result = await page.evaluate(async () => {
    let peak = 0;
    const sample = () => { const m = performance.memory?.usedJSHeapSize ?? 0; if (m > peak) peak = m; };
    const iv = setInterval(sample, 100);
    const blob = await (await fetch('./SYNTH.zip')).blob();
    const file = new File([blob], 'SYNTH.zip', { type: 'application/zip' });
    let err = null;
    try {
      await window.__corsixthTest.ingestZip(file, () => sample());
    } catch (e) {
      // Expected: the synthetic zip deliberately fails validateAssetPaths (see module
      // doc), so finishIngest's recovery branch clears the store and throws.
      err = String(e && e.message ? e.message : e);
    }
    clearInterval(iv);
    sample();
    return { peak, err };
  });

  const mb = (result.peak / (1024 * 1024)).toFixed(1);
  console.log(`peak usedJSHeapSize during ~${(total / 1024 / 1024).toFixed(0)}MB ingest: ${mb} MB`);
  console.log(`ingestZip settled with (expected) validation error: ${result.err}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.close();
  rmSync(zipPath, { force: true });
}
