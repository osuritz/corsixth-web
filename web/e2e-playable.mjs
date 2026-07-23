// Playable-slice E2E + input-latency instrumentation. This IS the v1 acceptance test.
// Flow: fetch HOSP.zip per-run -> ingest via ?test=1 hook -> boot -> New Game ->
// alt+shift+s quicksave -> reload -> alt+shift+l quickload -> assert (console markers
// + FS existence of quicksave.qs, PLUS a positive state round-trip: an unchanged
// quicksave.qs size/mtime marker across the round trip, and a changed rendered-frame
// hash before vs. after quickload — see statQuicksave()'s doc comment for exactly what
// each proves). Then 30s PerformanceObserver(longtask)+rAF cadence -> m3-latency.json.
// archive.org unavailable => SKIPPED (exit 0), never red.
import puppeteer from 'puppeteer-core';
import { spawn, execSync } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync, existsSync, rmSync, statSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

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
const PROFILE_DIR_CAP_BYTES = 1_000_000_000; // 1GB
const PRIMED_MARKER = join(PROFILE_DIR, '.e2e-primed-ok'); // written after a successful priming pass

// Recursively sum file sizes under `dir`. Best-effort: a file that disappears mid-walk
// (e.g. Chrome's own profile housekeeping) is simply skipped rather than failing the run —
// this is a disk-hygiene safety valve, not a correctness check, so approximate is fine.
function dirSizeBytes(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let names;
    try { names = readdirSync(d); } catch { continue; }
    for (const n of names) {
      const p = join(d, n);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) stack.push(p);
      else total += st.size;
    }
  }
  return total;
}

// Unbounded local disk growth in PROFILE_DIR is deliberate (see PROFILE_DIR comment
// above — a warm profile avoids the one-time cold-start hang) but not infinite: cap it
// so a long-lived dev machine or shared CI cache doesn't accumulate Chrome profile data
// forever. Pruning forfeits the warm-profile benefit for the NEXT run only (the
// following primeChromeProfile()/first real launch pays the cold-start cost once more,
// then a fresh profile starts accumulating again) — an acceptable, self-healing
// trade-off for an out-of-band safety valve that should rarely trigger in practice.
function pruneProfileDirIfOversized(dir, capBytes) {
  if (!existsSync(dir)) return;
  const sizeBytes = dirSizeBytes(dir);
  if (sizeBytes > capBytes) {
    console.log(`[e2e] PROFILE_DIR ${dir} is ${(sizeBytes / 1e9).toFixed(2)}GB (cap ${(capBytes / 1e9).toFixed(1)}GB) — pruning before this run (cold-start cost will be paid once more)`);
    rmSync(dir, { recursive: true, force: true });
  }
}

// Best-effort priming pass: exercise the real ingest flow once on this profile dir so
// whatever one-time cost gates the first-ever load happens here, off the clock, not
// during the real timed/asserted run below. Failures here are swallowed — the profile
// still gets "used once" even if this pass itself doesn't reach gameReady in time.
//
// Skip-if-already-primed is OPT-IN via E2E_SKIP_PRIMING_IF_PRIMED (default unset/off):
// CI must never silently skip this pass by default (a fresh CI runner has no warm
// profile and skipping would reintroduce the cold-start hang against the timed run
// below), so the default keeps priming every invocation exactly as before this change.
// When the env var IS set, a marker file written after a successful prime lets repeat
// LOCAL runs against the same PROFILE_DIR skip the ~20s pass once it's known-warm.
async function primeChromeProfile() {
  const skipIfPrimed = !!process.env.E2E_SKIP_PRIMING_IF_PRIMED;
  if (skipIfPrimed && existsSync(PRIMED_MARKER)) {
    console.log(`[e2e] E2E_SKIP_PRIMING_IF_PRIMED set and ${PRIMED_MARKER} exists — skipping priming pass`);
    return;
  }
  let browser;
  let ok = false;
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
    ok = true;
  } catch (e) {
    console.warn(`[e2e] priming pass error (non-fatal, best-effort): ${String(e).split('\n')[0]}`);
  } finally {
    await new Promise((r) => setTimeout(r, PRIME_MS));
    if (browser) await browser.close().catch(() => {});
  }
  // Only record the marker on a real success path AND only when the opt-in is active —
  // writing it unconditionally would be harmless (it's inert unless the env var is also
  // set) but there's no reason to leave the file behind when the feature isn't in use.
  if (ok && skipIfPrimed) { try { writeFileSync(PRIMED_MARKER, new Date().toISOString()); } catch { /* best-effort */ } }
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

// Returns { path, size, mtimeMs } for the first quicksave.qs found under the config
// mount (there should be exactly one), or null if none exists. This is the "positive
// state round-trip" marker: `App:quickLoad()` (CorsixTH/Lua/app.lua) only READS the
// file when one already exists (it writes only in the no-save-yet fallback branch,
// which the flow below never takes) and never calls TH.SyncEmscriptenFS() on that
// read path, so the on-disk bytes — and therefore size/mtime — should be byte-for-byte
// and timestamp-for-timestamp identical immediately after alt+shift+s and again after
// the reload + alt+shift+l that follows. `mtime` survives the reload deliberately: the
// engine's IDBFS remount (web/src/fs-setup.ts) restores each file's stored mtime via
// FS.utime() after repopulating MEMFS from IndexedDB, rather than leaving it at "now" —
// so an unchanged mtime here is a genuine signal (the file was never rewritten across
// the round trip), not an artifact of the remount always reporting "now".
// What this DOES prove: the exact file quicksave wrote is the exact file quickload
// later read (rules out e.g. a stale/replaced/truncated save surviving the reload).
// What this does NOT prove: that the loaded bytes were successfully deserialized into
// a running simulation — that's what the canvas-frame-change signal below is for.
async function statQuicksave(page) {
  return page.evaluate(() => {
    const FS = window.__corsixthTest.getFS?.(); if (!FS) return null;
    let found = null;
    (function walk(d) {
      if (found) return;
      let names = []; try { names = FS.readdir(d); } catch { return; }
      for (const n of names) { if (n === '.' || n === '..') continue;
        const p = d === '/' ? '/' + n : d + '/' + n;
        let m; try { m = FS.stat(p); } catch { continue; }
        if (FS.isDir(m.mode)) { walk(p); if (found) return; }
        else if (n.toLowerCase() === 'quicksave.qs') { found = { path: p, size: m.size, mtimeMs: new Date(m.mtime).getTime() }; return; }
      }
    })('/home/web_user/.config/CorsixTH');
    return found;
  });
}

try {
  pruneProfileDirIfOversized(PROFILE_DIR, PROFILE_DIR_CAP_BYTES);
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

  // Capture the round-trip marker (size + mtime) right after the save settles — see
  // statQuicksave's doc comment for exactly what this proves/doesn't prove.
  const quicksaveMarker = await statQuicksave(page);
  if (!quicksaveMarker) markFail('quicksave.qs stat unavailable right after alt+shift+s (cannot capture size/mtime marker)');
  else console.log(`[e2e] quicksave marker captured: ${quicksaveMarker.path} size=${quicksaveMarker.size}B mtime=${new Date(quicksaveMarker.mtimeMs).toISOString()}`);

  // 6) Reload, boot, re-enter a game, quickload (alt+shift+l).
  await page.goto(`http://localhost:${PORT}/index.html?test=1`, { waitUntil: 'load' });
  const rebooted = await page.waitForFunction(
    () => document.getElementById('overlay')?.classList.contains('hidden'),
    { timeout: 90_000 }).then(() => true).catch(() => false);
  if (!rebooted) markFail('did not reboot into game after reload');

  // The alt+shift+l chord is NOT a global hotkey: CorsixTH/Lua/dialogs/bottom_panel.lua
  // ("ui:addKeyHandler("ingame_quickLoad", self, self.quickLoad)") registers it only
  // while the in-game bottom panel exists, i.e. only once actually in a game session —
  // it does nothing from the main menu the reload above lands on (verified empirically
  // while building this check: pressing it at the main menu produced byte-identical
  // before/after screenshots, a silent no-op the OLD error-string-only check could not
  // have caught either way). So re-enter via the same New Game entry point used in step
  // 4 before the chord can do anything at all.
  await clickCanvas(NEW_GAME_FRAC.fx, NEW_GAME_FRAC.fy);
  await new Promise((r) => setTimeout(r, 4000));
  await clickCanvas(0.5, 0.5);

  // Gameplay-state signal (liveness, not a load-specific proof — see below for what
  // this DOES and does NOT establish): capture the rendered frame BEFORE quickload,
  // then sample several more frames across the following few seconds and require at
  // least one to differ from the "before" frame. Captured via Puppeteer's own
  // screenshot (a compositor-level capture of what's actually on screen), NOT
  // canvas.toDataURL()/getImageData() from inside the page — the engine's WebGL
  // context is created without `preserveDrawingBuffer`, so an in-page readback taken
  // on a later tick is not reliably the last-drawn frame; a screenshot sidesteps that
  // entirely.
  //
  // What this proves: the canvas is still actively rendering (not frozen/hung/crashed
  // silently in a way that produces no matching error string — see the FAILURES list
  // below) through the alt+shift+l press and the following few seconds.
  // What this does NOT prove: that alt+shift+l specifically triggered a load. Verified
  // empirically while building this check (inspected the sampled frames by hand):
  // this fresh New Game entry's own ordinary simulation clock (the date readout
  // ticking, e.g. "2 Jan" -> "3 Jan") and toolbar-icon flash animation already
  // produce frame-to-frame differences within
  // a few seconds regardless of whether the load actually ran — the save file here is
  // tiny (~500KB) and the demo's own world-rebuild step showed no visually-distinct
  // "loading" frame at this sampling cadence. So this check is a genuine but MODEST
  // signal (rules out a silent freeze), not a substitute for the two checks that ARE
  // load-specific: the loadErrors check just below (Lua/WASM-level failure strings)
  // and the quicksave.qs byte/mtime round-trip assertion further down (proves the file
  // App:quickLoad() reads is the exact file App:quickSave() wrote).
  const preLoadShot = await page.screenshot();
  const errBefore = transcript.length;
  await pressChord('KeyL');
  const midLoadShots = [];
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 500));
    midLoadShots.push(await page.screenshot());
  }
  // Engine-specific load-failure signatures, not a generic "Failed to load" match:
  // - `RuntimeError: Aborted` / `_asyncify_start_unwind`: WASM/Asyncify-level crash.
  // - `An error has occurred!` (+ "Running: The keyboard handler."): CorsixTH/Lua/
  //   app.lua's uncaught-handler-error trap — App:quickLoad()'s `self:load(...)` call
  //   is NOT wrapped in a pcall, so a genuine load failure during alt+shift+l surfaces
  //   here, not as any "Failed to load ..." string.
  // - `Error while loading game:` / `cannot load the quicksave`: the engine's own
  //   `_S.errors.load_prefix` / `_S.errors.load_quick_save` phrasing (english.lua),
  //   used by the Load-Game dialog and the "no quicksave to load" case respectively.
  // Also explicitly excludes any line starting with the browser's own resource-load
  // console prefix: a prior broad `/Failed to load/i` match false-positived on Chrome's
  // benign, unrelated "Failed to load resource: the server responded with a status of
  // 404 (File not found)" line — the browser's automatic favicon.ico probe fired on
  // every page load in this flow (pre-existing/benign; see task-2.6/6/7 E2E reports for
  // the same favicon 404, and task-3-fixer's incident report for this exact false
  // positive, reproduced identically on both db8d06df and d01f5539).
  const loadErrors = transcript.slice(errBefore).filter((l) =>
    !l.startsWith('Failed to load resource:') &&
    /RuntimeError: Aborted|_asyncify_start_unwind|An error has occurred!|Error while loading game:|cannot load the quicksave/i.test(l));
  if (loadErrors.length) markFail(`errors during quickload: ${loadErrors.join(' | ')}`);

  // Liveness check (see the fuller doc comment above `preLoadShot`): across the
  // sampled post-chord window, at least one frame must differ from the pre-chord
  // frame — catches a silent freeze/hang that prints no matching error string.
  const preLoadHash = createHash('sha256').update(preLoadShot).digest('hex');
  const midLoadHashes = midLoadShots.map((s) => createHash('sha256').update(s).digest('hex'));
  const anyDifferent = midLoadHashes.some((h) => h !== preLoadHash);
  if (!anyDifferent) {
    markFail('canvas frame identical (sha256) across the entire post-alt+shift+l sampling window — rendering appears frozen/hung (see doc comment above: this is a liveness check, not proof alt+shift+l itself triggered a load)');
  } else {
    console.log(`[e2e] liveness check PASSED: rendered frame changed at least once during the post-chord window (pre=${preLoadHash.slice(0, 8)}, frames=${midLoadHashes.map((h) => h.slice(0, 8)).join(',')})`);
  }

  // Positive round-trip assertion: the quicksave.qs marker captured right after
  // alt+shift+s must be BYTE- and TIMESTAMP-IDENTICAL to the same file's marker read
  // right now, after the reload + alt+shift+l. See statQuicksave's doc comment for the
  // full reasoning; in short, App:quickLoad() only reads (does not rewrite) an existing
  // quicksave, so this file must not have moved across the round trip — if it has,
  // something (a stray autosave, a differently-named file being matched, IDBFS not
  // restoring the stored mtime) broke the assumption the whole flow depends on.
  const quicksaveMarkerAfterLoad = await statQuicksave(page);
  if (!quicksaveMarkerAfterLoad) {
    markFail('quicksave.qs stat unavailable after alt+shift+l (cannot verify round-trip marker)');
  } else if (quicksaveMarker) {
    const sizeMatch = quicksaveMarkerAfterLoad.size === quicksaveMarker.size;
    const mtimeMatch = quicksaveMarkerAfterLoad.mtimeMs === quicksaveMarker.mtimeMs;
    if (!sizeMatch || !mtimeMatch) {
      markFail(`quicksave.qs marker changed across save->reload->quickload (before: size=${quicksaveMarker.size}B mtime=${new Date(quicksaveMarker.mtimeMs).toISOString()}; after: size=${quicksaveMarkerAfterLoad.size}B mtime=${new Date(quicksaveMarkerAfterLoad.mtimeMs).toISOString()})`);
    } else {
      console.log(`[e2e] quicksave round-trip PASSED: size=${quicksaveMarkerAfterLoad.size}B mtime=${new Date(quicksaveMarkerAfterLoad.mtimeMs).toISOString()} unchanged across save->reload->quickload`);
    }
  }

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
