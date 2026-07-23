// Headless boot smoke test: proves the wasm engine boots in a real browser to
// its "Welcome" banner (the marker that only prints after real engine init),
// and fails fast on the known abort classes. Runs in CI on the bare ubuntu
// runner's system Chrome (puppeteer-core: no browser download).
import puppeteer from 'puppeteer-core';
import { spawn, execSync } from 'node:child_process';
import { readdirSync, statSync, cpSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SUCCESS = 'Welcome to CorsixTH';
const FAILURES = ['_asyncify_start_unwind', '[harness] instantiation failed', 'RuntimeError: Aborted'];
const TIMEOUT_MS = 60_000;
const PORT = 8125;

function findArtifactDir(root) {
  const hits = [];
  (function walk(d) {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (e === 'corsix-th.js') hits.push(d);
    }
  })(root);
  if (hits.length === 0) throw new Error(`no corsix-th.js under ${root}`);
  return hits[0];
}

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  for (const c of ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser']) {
    try { return execSync(`which ${c}`).toString().trim(); } catch { /* next */ }
  }
  // macOS fallback for local runs
  return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
}

const artDir = findArtifactDir(resolve(process.env.ARTIFACTS_DIR ?? '../build-wasm'));
cpSync(resolve('dev/index.html'), join(artDir, 'index.html'));
const server = spawn('python3', ['-m', 'http.server', String(PORT), '--directory', artDir], { stdio: 'ignore' });

const transcript = [];
let verdict;
try {
  const browser = await puppeteer.launch({ executablePath: chromePath(), args: ['--no-sandbox', '--disable-gpu'] });
  const page = await browser.newPage();
  const outcome = new Promise((resolveOutcome) => {
    page.on('console', (msg) => {
      const line = msg.text();
      transcript.push(line);
      if (line.includes(SUCCESS)) resolveOutcome({ ok: true, line });
      const hit = FAILURES.find((f) => line.includes(f));
      if (hit) resolveOutcome({ ok: false, line, marker: hit });
    });
    page.on('pageerror', (err) => {
      transcript.push(`pageerror: ${err.message}`);
      resolveOutcome({ ok: false, line: `pageerror: ${err.message}`, marker: 'pageerror' });
    });
  });
  await page.goto(`http://localhost:${PORT}/index.html`);
  verdict = await Promise.race([
    outcome,
    new Promise((r) => setTimeout(() => r({ ok: false, line: `timeout after ${TIMEOUT_MS}ms` }), TIMEOUT_MS)),
  ]);
  await browser.close();
} finally {
  server.kill();
}

console.log('--- console transcript ---');
for (const l of transcript) console.log(' ', l);
console.log('--- verdict ---');
if (verdict.ok) { console.log(`PASS: engine booted ("${verdict.line}")`); process.exit(0); }
console.error(`FAIL: ${verdict.marker ?? 'no success marker'} — ${verdict.line}`);
process.exit(1);
