// Bounded glitch-repro harness (M3 Task 4). Extends the Task-1 playable-slice flow
// (web/e2e-playable.mjs) into a longer, populated-hospital session and instruments
// wasm heap-growth events (the leading hypothesis for the sponsor's sprite-corruption
// report) while capturing a screenshot series for human visual inspection.
//
// Design notes (read before changing):
//
// - HEAP-GROWTH INSTRUMENTATION IS ENGINE-FREE. The engine's -sALLOW_MEMORY_GROWTH
//   build (CMakeLists.txt:137) does NOT export HEAP8/wasmMemory on the Module object
//   under the current EXPORTED_RUNTIME_METHODS (callMain,addRunDependency,
//   removeRunDependency,FS,ENV) — verified by inspecting dist/corsix-th.js: HEAP8 and
//   wasmMemory are closure-local vars inside the MODULARIZE factory, never assigned
//   onto Module[...]. Rather than add a shell/engine hook (which the brief allows but
//   discourages unless needed), this harness patches WebAssembly.Memory.prototype.grow
//   via page.evaluateOnNewDocument BEFORE any page script runs. The wasm module's own
//   growMemory() (dist/corsix-th.js) calls `wasmMemory.grow(pages)` — a plain method
//   call that resolves through the shared global prototype regardless of whether the
//   Memory object was created in JS or exported by the wasm module (it's exported here:
//   `memory=wasmMemory=wasmExports["..."]`), so patching the prototype catches every
//   growth event with zero changes to web/src/main.ts or the engine tree.
//
// - THIS HARNESS DELIBERATELY DOES NOT RESET INDEXEDDB, unlike e2e-playable.mjs (which
//   resets every run for test isolation). Here we WANT the demo assets to persist
//   across repeated invocations against the same PROFILE_DIR, both to skip the ~13MB
//   re-ingest on every chunk and to reuse the one-time browser-profile warmup cost
//   documented in e2e-playable.mjs. A dedicated profile dir keeps this harness from
//   ever touching the CI-green e2e-playable.mjs's own profile/state.
//
// - CHUNKING MODEL: each invocation is an INDEPENDENT fresh session (New Game -> build
//   Reception Desk -> hire Receptionist -> max sim speed -> monitor -> screenshot),
//   not a save/quickload chain. This is a deliberate simplicity choice for a
//   bounded-effort task: chaining sessions via quicksave/quickload would add an
//   untested failure surface for marginal benefit, since at max sim speed ("Then
//   Some") a single ~8min wall-clock
//   chunk already covers a long simulated span. Running N independent chunks gives N
//   independent bounded trials of the heap-growth+corruption hypothesis (arguably
//   better evidence than one long continuous run) at the cost of not exploring "deep"
//   game states. Documented explicitly in the report.
//
// - Reception Desk build coordinates were captured against a REAL, LIVE demo build
//   (see docs/superpowers/reports/m3-reception-coords.png) via a scripted
//   click+screenshot+inspect loop (chrome-devtools-mcp has no coordinate-click
//   primitive for canvas apps — only element-uid clicks — so the same puppeteer
//   machinery this harness already uses was reused for the capture pass itself).
import puppeteer from 'puppeteer-core';
import { spawn, execSync } from 'node:child_process';
import { existsSync, copyFileSync, readFileSync, writeFileSync, rmSync, mkdirSync, statSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const DIST = resolve('dist');
const PORT = 8128;
const SHOTS = resolve('../docs/superpowers/reports');
const DEMO_URL = 'https://archive.org/download/HOSP_zip/HOSP.zip';
const STATE_FILE = join(tmpdir(), 'corsixth-glitch-state.json'); // cross-chunk bookkeeping only (screenshot index) — never committed
const REPORT_JSON = resolve('../docs/superpowers/reports/m3-glitch-heap-events.json');

// Bounded per-invocation session length + screenshot cadence. Kept comfortably under
// the 600s foreground-Bash timeout including boot/ingest/build overhead. Override via
// argv for a shorter smoke run: `node e2e-glitch.mjs 60 15`.
const CHUNK_MS = Number(process.argv[2] ?? 480_000);
const SHOT_INTERVAL_MS = Number(process.argv[3] ?? 30_000);

// Captured canvas-relative fractions (960x720 viewport => 720x720 canvas, left-offset
// 120px — same geometry as e2e-playable.mjs). See docs/superpowers/reports/
// m3-reception-coords.png for the final placement frame this sequence produces.
const NEW_GAME_FRAC = { fx: 0.499, fy: 0.171 };        // "Campaign" main-menu entry (Task 1)
const WELCOME_DISMISS_FRAC = { fx: 0.701, fy: 0.629 }; // close box on the "Welcome to the demo hospital!" dialog
const BUILD_MENU_FRAC = { fx: 0.4236, fy: 0.9625 };    // "Corridor Objects" toolbar icon (flashes red on a fresh hospital)
const RECEPTION_ITEM_FRAC = { fx: 0.7167, fy: 0.3056 };// "+" next to the "Reception desk" row in the Choose Items dialog
const RECEPTION_CONFIRM_FRAC = { fx: 0.5167, fy: 0.5944 }; // confirm-purchase hotspot; also the initial placement-cursor position
const RECEPTION_PLACE_FRAC = RECEPTION_CONFIRM_FRAC;   // clicking again at the same spot places the desk (valid corridor tile by the entrance)
// Hiring a receptionist is NOT optional decoration: verified empirically (first smoke
// run of this harness) that a bare, unstaffed Reception Desk gets ZERO visitors even
// after ~1 simulated year at max speed ("Most Visitors: 0" on the year-end Charts
// screen) — patients never spawn without a working reception. So "sprite-dense
// gameplay" per the brief requires this hire, not just the desk. No toolbar icon for
// Hire Staff renders on a fresh hospital (only 4 of ~11 toolbar slots are populated
// this early — a real CorsixTH UI-unlock detail, not a bug we're chasing), but the
// dialog opens via the documented global hotkey (config_finder.lua:641,
// ingame_panel_hireStaff = "b") regardless of toolbar state.
const RECEPTIONIST_CATEGORY_FRAC = { fx: 0.1764, fy: 0.5333 }; // bottom-left staff-category icon in the Hire Staff dialog (Receptionist)
const HIRE_CONFIRM_FRAC = { fx: 0.3056, fy: 0.5542 };  // envelope ("hire this candidate") icon
const PLACE_RECEPTIONIST_FRAC = HIRE_CONFIRM_FRAC;     // same click-twice pattern as the desk: confirm, then place at the same screen spot (she then autonomously walks to the desk)

// Parameterized (GLITCH_PROFILE_DIR) so a long-running session can use a dedicated
// profile dir instead of the one shared by day-to-day short chunked runs — the shared
// dir is also used by parallel-lane contention scenarios (multiple lanes/worktrees
// running e2e harnesses concurrently against ports/profiles), and userDataDir is an
// exclusive Chrome lock for the whole browser lifetime, so a 30-45min long session
// would lock other lanes out of the shared profile for its entire duration. Default
// preserves prior behavior exactly (same fixed path) when the env var is unset.
const PROFILE_DIR = process.env.GLITCH_PROFILE_DIR
  ? resolve(process.env.GLITCH_PROFILE_DIR)
  : join(tmpdir(), 'corsixth-glitch-e2e-chrome-profile');
const PROFILE_DIR_CAP_BYTES = 1_000_000_000; // 1GB

// Recursively sum file sizes under `dir`; best-effort (a file racing Chrome's own
// profile housekeeping is simply skipped, not fatal — this is a disk-hygiene safety
// valve, not a correctness check).
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

// Unbounded profile growth across chunks is the deliberate default (see header note:
// we WANT the demo assets to persist to skip re-ingest) but not infinite — cap it so a
// long-lived dev machine doesn't accumulate Chrome profile data forever. Pruning costs
// the NEXT run a re-ingest + one-time cold-start pass (self-healing), which is an
// acceptable trade for a safety valve that should rarely trigger.
function pruneProfileDirIfOversized(dir, capBytes) {
  if (!existsSync(dir)) return;
  const sizeBytes = dirSizeBytes(dir);
  if (sizeBytes > capBytes) {
    console.log(`[glitch] PROFILE_DIR ${dir} is ${(sizeBytes / 1e9).toFixed(2)}GB (cap ${(capBytes / 1e9).toFixed(1)}GB) — pruning before this run (next run re-ingests + re-warms)`);
    rmSync(dir, { recursive: true, force: true });
  }
}

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  for (const c of ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser']) {
    try { return execSync(`which ${c}`).toString().trim(); } catch { /* next */ }
  }
  return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
}

function fetchDemoOrSkip() {
  const tmp = join(tmpdir(), `hosp-glitch-${process.pid}.zip`);
  for (let a = 1; a <= 3; a++) {
    try {
      execSync(`curl -fsSL --max-time 120 -o "${tmp}" "${DEMO_URL}"`, { stdio: 'ignore' });
      if (readFileSync(tmp).length !== 12852052) throw new Error('size');
      copyFileSync(tmp, join(DIST, 'HOSP.zip')); rmSync(tmp, { force: true }); return true;
    } catch (e) { console.warn(`[glitch] fetch ${a}/3 failed: ${String(e).split('\n')[0]}`); }
  }
  return false;
}

function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return { nextShotIndex: 0, chunkIndex: 0 }; }
}
function saveState(s) { writeFileSync(STATE_FILE, JSON.stringify(s)); }

function loadReport() {
  try { return JSON.parse(readFileSync(REPORT_JSON, 'utf8')); } catch { return { chunks: [] }; }
}
function saveReport(r) { writeFileSync(REPORT_JSON, JSON.stringify(r, null, 2)); }

mkdirSync(SHOTS, { recursive: true });
if (!existsSync(join(DIST, 'corsix-th.js'))) { console.error('FAIL: build dist/ first'); process.exit(1); }

const state = loadState();
const report = loadReport();
const chunkIndex = state.chunkIndex ?? 0;
console.log(`[glitch] chunk ${chunkIndex} starting; CHUNK_MS=${CHUNK_MS} SHOT_INTERVAL_MS=${SHOT_INTERVAL_MS}; PROFILE_DIR=${PROFILE_DIR}`);
pruneProfileDirIfOversized(PROFILE_DIR, PROFILE_DIR_CAP_BYTES);

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--directory', DIST], { stdio: 'ignore' });
const transcript = [];
let fetchedDemoThisRun = false;

try {
  const browser = await puppeteer.launch({ executablePath: chromePath(), args: ['--no-sandbox', '--disable-gpu'], userDataDir: PROFILE_DIR });
  const page = await browser.newPage();
  await page.setViewport({ width: 960, height: 720 });
  page.on('console', (m) => { const t = m.text(); transcript.push(t); if (/glitch|corrupt|texture|surface|render/i.test(t)) console.log('[page]', t); });
  page.on('pageerror', (e) => transcript.push(`pageerror: ${e.message}`));

  // Patch BEFORE any navigation so it applies to every document this page loads,
  // including the reload ingestZip triggers on success. See header note.
  //
  // `__glitchSelfTestArmed` lets the forced self-test grow() call below (run once
  // per session, right after boot) tag its own event `{selfTest: true}` so it's
  // distinguishable from real engine-driven growth events in the emitted JSON,
  // without changing the shape of ordinary events at all.
  await page.evaluateOnNewDocument(() => {
    window.__glitchHeapEvents = [];
    window.__glitchSelfTestArmed = false;
    const OrigGrow = WebAssembly.Memory.prototype.grow;
    WebAssembly.Memory.prototype.grow = function (delta) {
      const beforeBytes = this.buffer.byteLength;
      const tMs = Math.round(performance.now());
      const result = OrigGrow.call(this, delta);
      const afterBytes = this.buffer.byteLength;
      const event = { tMs, deltaPages: delta, beforeBytes, afterBytes };
      if (window.__glitchSelfTestArmed) event.selfTest = true;
      window.__glitchHeapEvents.push(event);
      console.log(`[glitch-heap] grow: ${beforeBytes} -> ${afterBytes} bytes @ t=${tMs}ms${event.selfTest ? ' [selfTest]' : ''}`);
      return result;
    };
  });

  await page.goto(`http://localhost:${PORT}/index.html?test=1`, { waitUntil: 'load' });
  await page.waitForFunction('window.__corsixthTest && typeof window.__corsixthTest.ingestZip === "function"', { timeout: 20_000 });

  // Skip ingest if this profile already has the demo assets stored (persistent
  // PROFILE_DIR across chunks) — probe with a short non-ingesting wait first.
  let booted = await page.waitForFunction(
    () => document.getElementById('overlay')?.classList.contains('hidden') === true,
    { timeout: 8_000 }).then(() => true).catch(() => false);

  if (!booted) {
    if (!existsSync(join(DIST, 'HOSP.zip'))) {
      if (!fetchDemoOrSkip()) { console.log('SKIPPED: demo unavailable'); server.kill(); process.exit(0); }
      fetchedDemoThisRun = true;
    }
    const nav = page.waitForNavigation({ timeout: 180_000 }).catch(() => null);
    await page.evaluate(async () => {
      const b = await (await fetch('./HOSP.zip')).blob();
      await window.__corsixthTest.ingestZip(new File([b], 'HOSP.zip'), () => {});
    });
    await nav;
    booted = await page.waitForFunction(
      () => document.getElementById('overlay')?.classList.contains('hidden') === true,
      { timeout: 90_000 }).then(() => true).catch(() => false);
  }
  if (!booted) { console.error('[glitch] FAIL: engine never booted'); await browser.close(); server.kill(); process.exit(1); }

  // --- Self-validate the grow-hook instrumentation (once per session) ---
  // Nothing above proves the WebAssembly.Memory.prototype.grow patch actually
  // fires — without this, "0 heap-growth events" at the end of a chunk is
  // unverifiable: it's indistinguishable from "the hook never engaged". Force one
  // real grow() call here, tag it `{selfTest: true}` (see patch above), and
  // hard-abort rather than silently collect data from an unproven instrument.
  console.log('[glitch] running grow-hook self-test');
  const selfTestRaw = await page.evaluate(() => {
    window.__glitchSelfTestArmed = true;
    const before = window.__glitchHeapEvents.length;
    new WebAssembly.Memory({ initial: 1 }).grow(1);
    window.__glitchSelfTestArmed = false;
    return window.__glitchHeapEvents.slice(before);
  });
  const selfTestEvents = selfTestRaw.filter((e) => e.selfTest === true);
  if (selfTestEvents.length !== 1) {
    console.error(`[glitch] SELF-TEST FAILED: expected exactly 1 tagged selfTest grow event, observed ${selfTestEvents.length} (raw: ${JSON.stringify(selfTestRaw)}). The grow-hook instrumentation is unproven for this session — aborting rather than report unverifiable heap-event data.`);
    await browser.close(); server.kill(); process.exit(1);
  }
  console.log(`[glitch] SELF-TEST PASSED: grow-hook fired exactly once -> ${JSON.stringify(selfTestEvents[0])}`);

  const rect = await page.evaluate(() => {
    const c = document.getElementById('canvas').getBoundingClientRect();
    return { left: c.left, top: c.top, width: c.width, height: c.height };
  });
  const click = async (f) => page.mouse.click(rect.left + f.fx * rect.width, rect.top + f.fy * rect.height);
  const pressKey = async (key) => page.keyboard.press(key);

  // Fresh session every chunk (see header note): New Game -> dismiss welcome ->
  // build Reception Desk -> hire Receptionist -> max sim speed.
  console.log('[glitch] entering New Game');
  await click(NEW_GAME_FRAC); await new Promise((r) => setTimeout(r, 4000));
  await page.screenshot({ path: join(SHOTS, 'm3-glitch-baseline-newgame.png') });

  console.log('[glitch] dismissing welcome dialog + building Reception Desk');
  await click(WELCOME_DISMISS_FRAC); await new Promise((r) => setTimeout(r, 1000));
  await click(BUILD_MENU_FRAC); await new Promise((r) => setTimeout(r, 1200));
  await click(RECEPTION_ITEM_FRAC); await new Promise((r) => setTimeout(r, 1200));
  await click(RECEPTION_CONFIRM_FRAC); await new Promise((r) => setTimeout(r, 1200));
  await click(RECEPTION_PLACE_FRAC); await new Promise((r) => setTimeout(r, 1500));
  await page.screenshot({ path: join(SHOTS, `m3-glitch-${String(state.nextShotIndex).padStart(2, '0')}-reception-built.png`) });
  state.nextShotIndex++;

  // Focus point deliberately empty grass, well away from the just-placed Reception
  // Desk (~0.52,0.59) — clicking on the desk itself pops its queue-management dialog,
  // which then sits over the whole session blocking the very sprite-dense view this
  // harness exists to capture (caught in a smoke test: every subsequent screenshot
  // showed the queue dialog, never the hospital floor).
  const EMPTY_FOCUS_FRAC = { fx: 0.5, fy: 0.08 };

  console.log('[glitch] hiring a Receptionist (required: verified a bare desk gets 0 visitors)');
  await click(EMPTY_FOCUS_FRAC); await new Promise((r) => setTimeout(r, 300));
  await pressKey('KeyB'); await new Promise((r) => setTimeout(r, 1500));
  await click(RECEPTIONIST_CATEGORY_FRAC); await new Promise((r) => setTimeout(r, 1500));
  await click(HIRE_CONFIRM_FRAC); await new Promise((r) => setTimeout(r, 2000));
  await click(PLACE_RECEPTIONIST_FRAC); await new Promise((r) => setTimeout(r, 2500));
  await page.screenshot({ path: join(SHOTS, `m3-glitch-${String(state.nextShotIndex).padStart(2, '0')}-receptionist-hired.png`) });
  state.nextShotIndex++;

  console.log('[glitch] setting max sim speed ("Then Some", key 5) to populate the hospital faster');
  await click(EMPTY_FOCUS_FRAC); // focus canvas for SDL keyboard input
  await pressKey('Digit5');
  await new Promise((r) => setTimeout(r, 1000));

  // Monitoring loop: screenshot every SHOT_INTERVAL_MS; heap events accumulate in
  // window.__glitchHeapEvents (read in full at the end, not polled incrementally, to
  // keep this loop cheap).
  //
  // Clock anchor: heap events are timestamped with the PAGE's `performance.now()`
  // (monotonic, page-context clock) while screenshots below are timestamped with
  // `Date.now() - chunkStart` (Node-context wall clock) — two uncorrelated clocks
  // with no recorded relationship between them. Capture both clocks' readings
  // in ONE in-page evaluate call, at the same instant, so any heap event's tMs can
  // be converted to the same wall-clock frame as a screenshot's tMs:
  //   epochMs(event) = chunkStartAnchor.chunkStartEpochMs
  //                     + (event.tMs - chunkStartAnchor.chunkStartPerfMs)
  // `chunkStart` itself is then pinned to that same anchor read (not a separate
  // Node-side Date.now() call) so screenshots' `Date.now() - chunkStart` and the
  // anchor share one originating instant.
  const chunkStartAnchor = await page.evaluate(() => ({ chunkStartEpochMs: Date.now(), chunkStartPerfMs: performance.now() }));
  const chunkStart = chunkStartAnchor.chunkStartEpochMs;
  const shotPaths = [];
  for (let elapsed = 0; elapsed < CHUNK_MS; elapsed += SHOT_INTERVAL_MS) {
    await new Promise((r) => setTimeout(r, SHOT_INTERVAL_MS));
    const shotPath = join(SHOTS, `m3-glitch-${String(state.nextShotIndex).padStart(2, '0')}.png`);
    await page.screenshot({ path: shotPath });
    const tMs = Date.now() - chunkStart;
    shotPaths.push({ index: state.nextShotIndex, file: shotPath, tMs });
    console.log(`[glitch] shot ${state.nextShotIndex} @ t=${tMs}ms -> ${shotPath}`);
    state.nextShotIndex++;
  }

  const heapEvents = await page.evaluate(() => window.__glitchHeapEvents ?? []);
  const perfMemory = await page.evaluate(() => {
    const m = performance.memory;
    return m ? { usedJSHeapSize: m.usedJSHeapSize, totalJSHeapSize: m.totalJSHeapSize, jsHeapSizeLimit: m.jsHeapSizeLimit } : null;
  }).catch(() => null);

  // Quicksave at the end of the chunk (best-effort; not required for the next chunk,
  // which starts a fresh session — see header note — but costs nothing and leaves a
  // save-file artifact in the profile for any follow-up manual inspection).
  await click(EMPTY_FOCUS_FRAC);
  await page.keyboard.down('Alt'); await page.keyboard.down('Shift');
  await page.keyboard.press('KeyS');
  await page.keyboard.up('Shift'); await page.keyboard.up('Alt');
  await new Promise((r) => setTimeout(r, 2000));

  report.chunks.push({
    chunkIndex,
    startedAt: new Date(chunkStart).toISOString(),
    chunkStartAnchor, // { chunkStartEpochMs, chunkStartPerfMs } — see Monitoring loop note above; correlates heapGrowthEvents[].tMs (page performance.now()) with screenshots[].tMs (Date.now() - chunkStart)
    selfTestPassed: true, // hard-aborted above if the grow-hook self-test didn't fire exactly once
    selfTestEvent: selfTestEvents[0],
    chunkMs: CHUNK_MS,
    shotIntervalMs: SHOT_INTERVAL_MS,
    screenshots: shotPaths,
    heapGrowthEvents: heapEvents,
    perfMemoryAtEnd: perfMemory,
    consoleTail: transcript.slice(-30),
  });
  state.chunkIndex = chunkIndex + 1;
  saveReport(report);
  saveState(state);

  console.log(`[glitch] chunk ${chunkIndex} done: ${heapEvents.length} heap-growth event(s), ${shotPaths.length} screenshot(s).`);
  if (heapEvents.length) console.log('[glitch] heap growth events:', JSON.stringify(heapEvents));
  else console.log('[glitch] no heap-growth events observed this chunk.');

  await browser.close();
} finally {
  server.kill();
  if (fetchedDemoThisRun) rmSync(join(DIST, 'HOSP.zip'), { force: true }); // never leave EA bytes behind
}
console.log(`[glitch] chunk complete. Inspect m3-glitch-*.png for corruption; see ${REPORT_JSON} for the heap-event timeline.`);
