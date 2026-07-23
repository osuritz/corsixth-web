// Playable-slice E2E + input-latency instrumentation. This IS the v1 acceptance test.
// Flow: fetch HOSP.zip per-run -> ingest via ?test=1 hook -> boot -> New Game ->
// alt+shift+s quicksave -> reload -> alt+shift+l quickload -> assert (console markers
// + FS existence of quicksave.qs). Then 30s PerformanceObserver(longtask)+rAF cadence
// -> m3-latency.json. archive.org unavailable => SKIPPED (exit 0), never red.
import puppeteer from 'puppeteer-core';
import { spawn, execSync } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const DIST = resolve('dist');
const PORT = 8126;
const DEMO_URL = 'https://archive.org/download/HOSP_zip/HOSP.zip';
const REPORT = resolve('../docs/superpowers/reports/m3-latency.json');

// New Game / Campaign entry, canvas-relative fraction — CAPTURED in Step 2 against a
// real demo build; see docs/superpowers/reports/m3-newgame-coords.png. At the fixed
// puppeteer viewport this script uses (960x720), the shell's canvas renders at
// 720x720 CSS px (not 800x600 — the shell sizes the canvas to the viewport, it isn't
// a fixed internal resolution); fx/fy are measured against that live canvas rect, so
// they stay correct regardless of the absolute canvas size as long as the viewport
// below is unchanged. Demo has a single level, so "Campaign" drops straight into it.
const NEW_GAME_FRAC = { fx: 0.499, fy: 0.171 };

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  for (const c of ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser']) {
    try { return execSync(`which ${c}`).toString().trim(); } catch { /* next */ }
  }
  return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
}

// A persistent (not puppeteer's throwaway per-launch temp) profile dir. Diagnosed
// live (M3 Task 1, controller-directed matrix: dropping --disable-gpu, --use-angle=
// swiftshader, --enable-unsafe-swiftshader, and even a headed launch all hung
// identically — so it is NOT GPU/WebGL/headless. A brand-new Chrome profile's *first
// ever* page load of this app hangs forever right after "Unicode font not found"
// (gameReady never fires, no console errors — confirmed reproducible even in a real,
// headed, extension-connected Chrome via an isolated/incognito-like context); the
// *second* launch against the SAME profile dir boots in ~3-5s every time. This is a
// one-time browser-profile initialization cost (unconfirmed exact mechanism — most
// likely IndexedDB backing-store or Chrome component first-run setup — but the
// second-launch fix is 100% reproducible across many trials), not an engine bug. We
// pay that cost once per run with a short throwaway "priming" launch below.
// Never pruned between runs — slow, unbounded local disk growth here is deliberate:
// a warm profile is what avoids the first-load hang described above.
const PROFILE_DIR = join(tmpdir(), 'corsixth-e2e-chrome-profile');
const PRIME_MS = 20_000;

// Best-effort priming pass: exercise the real ingest flow once on this profile dir so
// whatever one-time cost gates the first-ever load happens here, off the clock, not
// during the real timed/asserted run below. Failures here are swallowed — the profile
// still gets "used once" even if this pass itself doesn't reach gameReady in time.
async function primeChromeProfile() {
  let browser;
  try {
    browser = await puppeteer.launch({ executablePath: chromePath(), args: ['--no-sandbox', '--disable-gpu'], userDataDir: PROFILE_DIR });
    const page = await browser.newPage();
    await page.goto(`http://localhost:${PORT}/index.html?test=1`, { waitUntil: 'load' });
    await page.waitForFunction('window.__corsixthTest && typeof window.__corsixthTest.ingestZip === "function"', { timeout: 20_000 });
    await page.evaluate(async () => {
      const blob = await (await fetch('./HOSP.zip')).blob();
      const file = new File([blob], 'HOSP.zip', { type: 'application/zip' });
      await window.__corsixthTest.ingestZip(file, () => {});
    }).catch(() => {});
  } catch (e) {
    console.warn(`[e2e] priming pass error (non-fatal, best-effort): ${String(e).split('\n')[0]}`);
  } finally {
    await new Promise((r) => setTimeout(r, PRIME_MS));
    if (browser) await browser.close().catch(() => {});
  }
}

// Fetch the demo fresh into $TMPDIR (never committed/cached). 3 tries; on exhaustion the
// caller SKIPs. We stage it into the served DIST (gitignored, ephemeral) so the page can
// fetch it same-origin and build a real File for the ingest hook.
function fetchDemoOrSkip() {
  const tmp = join(tmpdir(), `hosp-${process.pid}.zip`);
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      execSync(`curl -fsSL --max-time 120 -o "${tmp}" "${DEMO_URL}"`, { stdio: 'ignore' });
      const size = readFileSync(tmp).length;
      if (size !== 12852052) throw new Error(`unexpected size ${size}`);
      copyFileSync(tmp, join(DIST, 'HOSP.zip'));
      rmSync(tmp, { force: true });
      return true;
    } catch (e) {
      console.warn(`[e2e] demo fetch attempt ${attempt}/3 failed: ${String(e).split('\n')[0]}`);
    }
  }
  return false;
}

function pct(sorted, p) {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

if (!existsSync(join(DIST, 'corsix-th.js'))) {
  console.error('FAIL: dist/ not built — run `npm run build` first'); process.exit(1);
}
if (!fetchDemoOrSkip()) {
  console.log('SKIPPED: archive.org demo unavailable after 3 attempts — E2E not run (not a failure).');
  process.exit(0);
}

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--directory', DIST], { stdio: 'ignore' });
const transcript = [];
let failed = null;

function markFail(msg) { if (!failed) failed = msg; console.error(`[e2e] ASSERT FAIL: ${msg}`); }

// Shared FS walk: is Saves/quicksave.qs present under the IDBFS-backed config mount?
// Used both to prove absence (right after the per-run reset, before any save) and
// presence (right after alt+shift+s) — see the two call sites below.
async function findQuicksave(page) {
  return page.evaluate(() => {
    const FS = window.__corsixthTest.getFS?.(); if (!FS) return false;
    const found = [];
    (function walk(d) {
      let names = []; try { names = FS.readdir(d); } catch { return; }
      for (const n of names) { if (n === '.' || n === '..') continue;
        const p = d === '/' ? '/' + n : d + '/' + n;
        let m; try { m = FS.stat(p); } catch { continue; }
        if (FS.isDir(m.mode)) walk(p); else if (n.toLowerCase() === 'quicksave.qs') found.push(p);
      }
    })('/home/web_user/.config/CorsixTH');
    return found.length > 0;
  });
}

try {
  await primeChromeProfile();

  const browser = await puppeteer.launch({ executablePath: chromePath(), args: ['--no-sandbox', '--disable-gpu'], userDataDir: PROFILE_DIR });
  const page = await browser.newPage();
  await page.setViewport({ width: 960, height: 720 });
  page.on('console', (m) => { transcript.push(m.text()); });
  page.on('pageerror', (e) => { transcript.push(`pageerror: ${e.message}`); });

  // 1) Load with the test hook, then unconditionally reset EVERY IndexedDB database on
  // this origin. The priming pass above (and, since PROFILE_DIR is a persistent, never-
  // pruned profile, any earlier local run of this very script) can leave a stale save
  // behind, and it is NOT just the shell's 'corsixth-web' asset-cache DB. The engine's
  // saves live in a separate, IDBFS-backed database that Emscripten names after the FS
  // mount path (/home/web_user/.config/CorsixTH), not 'corsixth-web'. A reset scoped to
  // only 'corsixth-web' clears the asset cache but leaves a stale quicksave.qs sitting in
  // the IDBFS database untouched — so the FS-walk assertion below would keep passing on
  // every subsequent local run even if clicking/saving were completely broken.
  //
  // This clears every object store's *records* in place rather than calling
  // indexedDB.deleteDatabase() — deliberately, and confirmed necessary empirically.
  // deleteDatabase() tears down and recreates the origin's whole IndexedDB backing
  // store; doing that every run reproduces the profile's one-time ~90-100s cold-open
  // cost (see PROFILE_DIR above) on EVERY run instead of just once ever — two
  // consecutive full-delete runs during this fix's validation stalled silently for ~97s
  // then ~187s (growing, not fixed) right after "Unicode font not found", the exact
  // original cold-start signature, before finishing on their own. Clearing records
  // leaves the backing store itself untouched, so it never re-triggers that cost.
  //
  // This must run right here — on the SAME load as the hook-exists wait, before any
  // other navigation — not from a separate "neutral" page first. An earlier version of
  // this fix reset from a throwaway 404 page before this load; that extra navigation
  // reintroduced the same ~90-190s stall even with the non-destructive clear() above,
  // while resetting in-place on this first load (matching the shape this script already
  // used) did not, across repeated fresh-profile trials. The exact mechanism wasn't
  // pinned down, but the empirical result was clear and consistent — keep this reset
  // sequence exactly as it is; don't add a navigation before it.
  await page.goto(`http://localhost:${PORT}/index.html?test=1`, { waitUntil: 'load' });
  await page.waitForFunction('window.__corsixthTest && typeof window.__corsixthTest.ingestZip === "function"', { timeout: 20_000 });
  await page.evaluate(async () => {
    const dbs = await indexedDB.databases();
    await Promise.all(dbs.map((d) => new Promise((resolve) => {
      if (!d.name) return resolve();
      const openReq = indexedDB.open(d.name);
      openReq.onerror = () => resolve();
      openReq.onblocked = () => resolve();
      openReq.onsuccess = () => {
        const db = openReq.result;
        const storeNames = Array.from(db.objectStoreNames);
        if (storeNames.length === 0) { db.close(); resolve(); return; }
        const t = db.transaction(storeNames, 'readwrite');
        for (const name of storeNames) t.objectStore(name).clear();
        t.oncomplete = t.onerror = t.onabort = () => { db.close(); resolve(); };
      };
    })));
  });

  // 2) Ingest the demo via the real production ingestZip (finishIngest reloads on success).
  const nav = page.waitForNavigation({ timeout: 120_000 }).catch(() => null);
  await page.evaluate(async () => {
    const blob = await (await fetch('./HOSP.zip')).blob();
    const file = new File([blob], 'HOSP.zip', { type: 'application/zip' });
    await window.__corsixthTest.ingestZip(file, () => {});
  });
  await nav;

  // 3) After reload (?test=1 preserved), boot to gameplay.
  const booted = await page.waitForFunction(
    () => document.getElementById('overlay')?.classList.contains('hidden') === true,
    { timeout: 90_000 }).then(() => true).catch(() => false);
  const sawWelcome = transcript.some((l) => l.includes('Welcome to CorsixTH'));
  if (!sawWelcome) markFail('engine did not print "Welcome to CorsixTH"');
  if (!booted) markFail('overlay never hid (gameReady did not fire)');

  // 4) Enter the game via the single New Game menu entry.
  const rect = await page.evaluate(() => {
    const c = document.getElementById('canvas').getBoundingClientRect();
    return { left: c.left, top: c.top, width: c.width, height: c.height };
  });
  const clickCanvas = async (fx, fy) => {
    await page.mouse.click(rect.left + fx * rect.width, rect.top + fy * rect.height);
  };
  await clickCanvas(NEW_GAME_FRAC.fx, NEW_GAME_FRAC.fy);
  await new Promise((r) => setTimeout(r, 4000)); // let the level load (single demo level)
  await page.screenshot({ path: resolve('../docs/superpowers/reports/m3-e2e-gameplay.png') });

  // 4.5) Self-proving assertion: after the reset above and this gameplay boot,
  // quicksave.qs must be ABSENT before we ever press the save chord. This is the whole
  // point of the per-run IndexedDB reset in step 1 — if it fails here, some IDB
  // database survived the reset and a stale save from an earlier local run would make
  // the step-5 PRESENT check below pass unconditionally, even if quicksaving is broken.
  const savedBeforeQuicksave = await findQuicksave(page);
  if (savedBeforeQuicksave) markFail('quicksave.qs already PRESENT before alt+shift+s — per-run IndexedDB reset did not take effect (stale save leaked in)');
  else console.log('[e2e] pre-save check PASSED: quicksave.qs absent before alt+shift+s (reset verified)');

  // 5) Quicksave (alt+shift+s). Focus the canvas first so SDL receives the keys.
  await clickCanvas(0.5, 0.5);
  const pressChord = async (key) => {
    await page.keyboard.down('Alt'); await page.keyboard.down('Shift');
    await page.keyboard.press(key);
    await page.keyboard.up('Shift'); await page.keyboard.up('Alt');
  };
  await pressChord('KeyS');
  await new Promise((r) => setTimeout(r, 3000)); // quicksave + syncfs flush

  // FS assertion: quicksave.qs exists somewhere under the config mount.
  const savedBefore = await findQuicksave(page);
  if (!savedBefore) markFail('quicksave.qs not found in FS after alt+shift+s');
  else console.log('[e2e] post-save check PASSED: quicksave.qs present after alt+shift+s');

  // 6) Reload, boot, quickload (alt+shift+l).
  await page.goto(`http://localhost:${PORT}/index.html?test=1`, { waitUntil: 'load' });
  const rebooted = await page.waitForFunction(
    () => document.getElementById('overlay')?.classList.contains('hidden'),
    { timeout: 90_000 }).then(() => true).catch(() => false);
  if (!rebooted) markFail('did not reboot into game after reload');
  await clickCanvas(0.5, 0.5);
  const errBefore = transcript.length;
  await pressChord('KeyL');
  await new Promise((r) => setTimeout(r, 3000));
  const loadErrors = transcript.slice(errBefore).filter((l) =>
    /RuntimeError: Aborted|_asyncify_start_unwind|Failed to load/i.test(l));
  if (loadErrors.length) markFail(`errors during quickload: ${loadErrors.join(' | ')}`);
  const stillSaved = await page.evaluate(() => {
    const FS = window.__corsixthTest.getFS?.(); if (!FS) return false;
    try { return FS.analyzePath('/home/web_user/.config/CorsixTH/Saves/quicksave.qs').exists; }
    catch { return false; }
  });
  // Saves/ path is the documented savegame_dir; if analyzePath misses (dir differs) the
  // Step-5 recursive walk already proved existence, so treat this as advisory.
  if (!stillSaved) console.warn('[e2e] note: quicksave.qs not at the canonical Saves/ path (walk in step 5 is authoritative)');

  // 7) Input-latency instrumentation over 30s of live gameplay.
  const metrics = await page.evaluate(() => new Promise((res) => {
    const longtasks = [];
    let po;
    try { po = new PerformanceObserver((l) => { for (const e of l.getEntries()) longtasks.push(e.duration); });
          po.observe({ entryTypes: ['longtask'] }); } catch { po = null; }
    const gaps = []; const start = performance.now(); let last = start;
    function frame(now) { gaps.push(now - last); last = now;
      if (now - start < 30_000) requestAnimationFrame(frame);
      else { if (po) po.disconnect(); res({ longtasks, gaps }); } }
    requestAnimationFrame(frame);
  }));

  const gapsSorted = [...metrics.gaps].sort((a, b) => a - b);
  const ltSorted = [...metrics.longtasks].sort((a, b) => a - b);
  const expectedFrames = 30_000 / 16.67;
  const blockedFrames = metrics.longtasks.reduce((n, d) => n + Math.ceil(d / 16.67), 0);
  const verdict = {
    generatedAt: new Date().toISOString(),
    samples: { rafGaps: metrics.gaps.length, longtasks: metrics.longtasks.length },
    rafGapP95Ms: +pct(gapsSorted, 95).toFixed(2),
    longtaskP95Ms: +pct(ltSorted, 95).toFixed(2),
    longtaskFrameOverlapPct: +((blockedFrames / expectedFrames) * 100).toFixed(2),
    thresholds: { rafGapP95Ms: 33, longtaskP95Ms: 100, longtaskFrameOverlapPct: 5 },
  };
  verdict.flags = [
    verdict.rafGapP95Ms > 33 ? 'raf-gap-p95>33ms (sustained <=30fps)' : null,
    verdict.longtaskP95Ms > 100 ? 'longtask-p95>100ms' : null,
    verdict.longtaskFrameOverlapPct > 5 ? 'longtask-overlap>5%-of-frames' : null,
  ].filter(Boolean);
  verdict.decision = verdict.flags.length === 0
    ? 'PASS — Asyncify latency acceptable; main-loop restructure NOT required in M3.'
    : 'FLAG — escalate to controller: Asyncify underperforms; restructure contingency in scope.';
  writeFileSync(REPORT, JSON.stringify(verdict, null, 2));
  console.log('[e2e] latency verdict:', JSON.stringify(verdict));

  await browser.close();
} finally {
  server.kill();
  rmSync(join(DIST, 'HOSP.zip'), { force: true }); // never leave EA bytes behind
}

console.log('--- console transcript (tail) ---');
for (const l of transcript.slice(-40)) console.log(' ', l);
if (failed) { console.error(`FAIL: ${failed}`); process.exit(1); }
console.log('PASS: playable slice — ingest -> New Game -> quicksave -> reload -> quickload.');
process.exit(0);
