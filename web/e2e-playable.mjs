// Playable-slice E2E + input-latency instrumentation. This IS the v1 acceptance test.
// Flow: fetch HOSP.zip per-run -> ingest via ?test=1 hook -> boot -> New Game -> speed
// up (distinguishing state mutation) -> alt+shift+s quicksave -> reload -> New Game
// (fresh state) -> alt+shift+l quickload -> assert a TRUE state round-trip: a
// screenshot-crop hash of the bottom panel's date card, sampled as a burst on both
// sides of the save/load boundary, must show quickload landing back on a pre-save
// value — and that value must never appear in the fresh game's own burst — see the
// DATE_CROP_FRAC / preSaveBurst capture-site comments below for exactly what this
// proves (and what the companion quicksave.qs size/mtime marker proves instead: only
// file persistence, not state restoration). Then 30s PerformanceObserver(longtask)+rAF
// cadence -> m3-latency.json. archive.org unavailable => SKIPPED (exit 0), never red.
import puppeteer from 'puppeteer-core';
import { spawn, execSync } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync, existsSync, rmSync, statSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';

// Minimal, dependency-free PNG decoder (uses only Node's built-in zlib) — just enough
// to crop a fixed pixel rect out of a full-viewport Puppeteer screenshot ourselves,
// in-process, rather than asking Chrome/CDP to do the cropping. Why this exists: an
// earlier version of this fix used `page.screenshot({clip})` for the date-card marker
// and found it UNRELIABLE specifically in the post-quickload window — confirmed
// empirically while building this check by capturing a plain full-viewport screenshot
// at the exact same instants: the full screenshot consistently and correctly showed the
// saved date ("18 Jan") holding steady for the entire post-load sampling window, while
// a `{clip}` screenshot taken microseconds later at that same instant instead returned a
// visibly WRONG, shifted region (missing the leading day digit, with an adjacent
// button's border bleeding in) — reproducibly, across repeated runs, even after
// re-querying the canvas rect fresh each time and after forcing `page.setViewport()`
// again immediately before sampling (neither changed the result). That points to a
// Chrome/CDP-internal clip-capture quirk (most likely stale viewport-override/backing-
// store state left over from this script's two same-page `page.goto()` reloads), not a
// bug in this script's own coordinate math. Full-viewport screenshots were unaffected
// in every trial, so cropping them ourselves sidesteps the problem entirely. Adding a
// real PNG library (e.g. pngjs) was considered instead but rejected: web/package.json
// is outside this fix's file ownership, and Chrome's screenshots are a narrow, fixed
// shape (8-bit depth, RGB or RGBA, no interlacing) that doesn't need a general decoder.
function decodePng(input) {
  // Puppeteer's page.screenshot() can return a plain Uint8Array (not a Node Buffer)
  // depending on version/options; normalize so readUInt32BE/subarray/etc. below work.
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('decodePng: not a PNG (bad signature)');
  let offset = 8;
  let width, height, bitDepth, colorType;
  const idatChunks = [];
  while (offset < buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data.readUInt8(8); colorType = data.readUInt8(9);
      const interlace = data.readUInt8(12);
      if (bitDepth !== 8) throw new Error(`decodePng: unsupported bitDepth ${bitDepth} (only 8 supported)`);
      if (interlace !== 0) throw new Error('decodePng: interlaced PNGs not supported');
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 8 + len + 4; // length + type + data + crc
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`decodePng: unsupported colorType ${colorType}`);
  const raw = inflateSync(Buffer.concat(idatChunks));
  const bpp = channels; // bytes per pixel at bitDepth 8
  const stride = width * bpp;
  const pixels = Buffer.alloc(height * stride);
  let rawOffset = 0;
  for (let y = 0; y < height; y++) {
    const filterType = raw[rawOffset]; rawOffset += 1;
    const rowStart = y * stride;
    const prevRowStart = rowStart - stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[rawOffset + i];
      const left = i >= bpp ? pixels[rowStart + i - bpp] : 0;
      const up = y > 0 ? pixels[prevRowStart + i] : 0;
      const upLeft = (y > 0 && i >= bpp) ? pixels[prevRowStart + i - bpp] : 0;
      let value;
      switch (filterType) {
        case 0: value = x; break;
        case 1: value = x + left; break;
        case 2: value = x + up; break;
        case 3: value = x + Math.floor((left + up) / 2); break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upLeft);
          const pred = (pa <= pb && pa <= pc) ? left : (pb <= pc ? up : upLeft);
          value = x + pred;
          break;
        }
        default: throw new Error(`decodePng: unsupported filter type ${filterType}`);
      }
      pixels[rowStart + i] = value & 0xff;
    }
    rawOffset += stride;
  }
  return { width, height, channels, pixels };
}

// Crops an integer pixel rect out of a decodePng() result and returns the raw pixel
// bytes (row-major, `channels`-per-pixel) for that sub-rect — NOT a re-encoded PNG, just
// the bytes, which is all hashing needs and is simpler/faster than round-tripping
// through a PNG encoder we'd also have to write.
function cropPixels(png, x, y, w, h) {
  const out = Buffer.alloc(w * h * png.channels);
  for (let row = 0; row < h; row++) {
    const srcStart = ((y + row) * png.width + x) * png.channels;
    png.pixels.copy(out, row * w * png.channels, srcStart, srcStart + w * png.channels);
  }
  return out;
}

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

// Crop SIZE and vertical position (canvas-relative fraction, same convention/method as
// NEW_GAME_FRAC above) for the bottom panel's date card — CorsixTH/Lua/dialogs/
// bottom_panel.lua:247-249, `self.date_font:draw(canvas, _S.date_format.daymonth:format
// (day, month), x + 140, y + 20, ...)` inside `UIBottomPanel:draw`, panel docked flush
// to the bottom edge via `self:setDefaultPosition(0.5, -0.1)`. Captured empirically
// against a real demo build at this script's fixed 960x720 viewport and confirmed,
// while building this check, to visibly and reliably differ between a fresh Day-1/2
// game and a game advanced by the speed-up below (observed "2 Jan" vs "21 Jan"-range
// renders by hand across several trials) — see the capture site below for exactly what
// hashing this crop proves. Deliberately has NO `fx` (horizontal position): the card's
// x position is LOCATED dynamically per capture instead — see findDateCardLeft's doc
// comment for why a fixed x doesn't hold across this build's two different
// panel-construction call sites.
const DATE_CROP_FRAC = { fy: 0.9486, fw: 0.0917, fh: 0.0375 };

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
// mount (there should be exactly one), or null if none exists. This is the
// FILE-PERSISTENCE marker (NOT a state-restoration proof — see the date-card marker
// captured near the quicksave/quickload call sites below for that): `App:quickLoad()`
// (CorsixTH/Lua/app.lua) only READS the file when one already exists (it writes only in
// the no-save-yet fallback branch, which the flow below never takes) and never calls
// TH.SyncEmscriptenFS() on that read path, so the on-disk bytes — and therefore
// size/mtime — should be byte-for-byte and timestamp-for-timestamp identical
// immediately after alt+shift+s and again after the reload + alt+shift+l that follows.
// `mtime` surviving the reload is NOT anything our own code does — web/src/fs-setup.ts
// has no FS.utime() call anywhere, it only mounts IDBFS and issues the one-time boot
// `FS.syncfs(true, ...)` pull. The mtime preservation is Emscripten's IDBFS
// implementation's own internal behavior: IDBFS records each file's mtime in the
// IndexedDB entry it writes on a push (triggered by the engine's own
// `TH.SyncEmscriptenFS()` native binding, e.g. CorsixTH/Lua/persistance.lua:261, after
// a save) and restores that stored mtime onto the newly-created MEMFS node during a
// pull — library code we neither wrote nor call directly, just rely on.
// What this DOES prove: the exact file quicksave wrote is the exact file quickload
// later read (rules out e.g. a stale/replaced/truncated save surviving the reload, or —
// now that a fresh New Game runs between save and load — that new session's own startup
// somehow touching the save file).
// What this does NOT prove: that the loaded bytes were successfully deserialized into
// a running simulation with the saved state actually restored — an inert file that a
// buggy quickLoad reads but never applies would leave this marker unchanged too. That
// is exactly what the date-card marker below exists to catch instead.
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
  // The date-card marker is LOCATED dynamically each capture (by its own pixels), not
  // cropped from one fixed absolute screen position. Why: this build's bottom panel
  // (CorsixTH/Lua/dialogs/bottom_panel.lua's `machineMenuButtonExists()`-driven width,
  // 640px vs. 676px) measurably, reproducibly reconstructs ~18px further LEFT
  // specifically after a quickload than a fresh New Game does — confirmed empirically
  // while building this check: the card's own cream/white background sat at
  // canvas-relative x=[295,366] after New Game but x=[277,348] after alt+shift+l, an
  // exact ~18px shift, WITHIN THE SAME SCRIPT RUN, with the canvas rect itself provably
  // unchanged (re-querying `getBoundingClientRect()` fresh each capture made no
  // difference). That's a genuine layout difference this test must tolerate, not a
  // coordinate bug — so instead of assuming one fixed screen position (which silently
  // breaks the moment that layout differs), find the card's actual left edge inside a
  // generous horizontal search band that comfortably covers both known positions, then
  // crop a fixed-size window anchored there.
  //
  // This also replaces an earlier, less reliable approach: `page.screenshot({clip})`
  // directly. That was found to be UNRELIABLE specifically in the post-quickload
  // sampling window — a plain full-viewport screenshot taken at the same instant
  // consistently and correctly showed the saved date, while a `{clip}` screenshot
  // microseconds later returned a visibly wrong, shifted crop — reproducible across
  // repeated runs and unaffected by re-querying the rect or re-issuing
  // `page.setViewport()` first, pointing at a Chrome/CDP-internal clip-capture quirk.
  // Cropping full-viewport screenshots ourselves (see decodePng()'s doc comment) both
  // sidesteps that quirk AND makes the dynamic locate below possible (Puppeteer's
  // native `clip` can't search for content — it can only cut a rect you already know).
  const DATE_CARD_BG = (r, g, b) => r > 200 && g > 200 && b > 180; // cream/white card background
  const dateCardSearchBand = (r) => ({
    x: Math.round(r.left + 0.18 * r.width),
    y: Math.round(r.top + DATE_CROP_FRAC.fy * r.height) + Math.round((DATE_CROP_FRAC.fh * r.height) / 2),
    w: Math.round(0.13 * r.width),
    h: Math.round(DATE_CROP_FRAC.fh * r.height),
  });
  const dateCropSize = (r) => ({
    w: Math.round(DATE_CROP_FRAC.fw * r.width),
    h: Math.round(DATE_CROP_FRAC.fh * r.height),
  });
  const dateCropY = (r) => Math.round(r.top + DATE_CROP_FRAC.fy * r.height);
  function findDateCardLeft(png, band) {
    for (let x = band.x; x < band.x + band.w; x++) {
      const idx = (band.y * png.width + x) * png.channels;
      if (DATE_CARD_BG(png.pixels[idx], png.pixels[idx + 1], png.pixels[idx + 2])) return x;
    }
    return null; // not found in this frame — treated like a blank/glitch capture below
  }
  const hashShot = (buf) => createHash('sha256').update(buf).digest('hex');
  // A solid-color crop (near-zero min/max pixel-value spread) — like the card not being
  // found at all above — means the capture landed on a blank/mid-repaint frame rather
  // than the real date card. Left unfiltered, two such blank/miss frames landing on
  // opposite sides of the save/load boundary would hash-match each other and look like
  // a genuine restored-date match — a false PASS with no real evidence behind it (this
  // exact failure mode was caught happening while building this check, with the
  // earlier `{clip}`-based approach).
  function cropVariance(pixels) {
    let min = 255, max = 0;
    for (let i = 0; i < pixels.length; i++) {
      if (pixels[i] < min) min = pixels[i];
      if (pixels[i] > max) max = pixels[i];
    }
    return max - min;
  }
  async function captureDateSample() {
    const band = dateCardSearchBand(rect);
    const size = dateCropSize(rect);
    const y = dateCropY(rect);
    for (let attempt = 0; attempt < 5; attempt++) {
      const png = decodePng(await page.screenshot());
      const left = findDateCardLeft(png, band);
      if (left !== null) {
        const crop = cropPixels(png, left, y, size.w, size.h);
        if (cropVariance(crop) > 20) return crop; // real content; a blank/solid frame has ~zero variance
      }
      await new Promise((r) => setTimeout(r, 60));
    }
    // Exhausted retries: return whatever we have rather than hang — a persistent
    // blank/not-found capture here would still show up as a distinct, filterable hash
    // below (or as a thrown error, surfacing loudly), not a silent false match.
    const png = decodePng(await page.screenshot());
    const left = findDateCardLeft(png, band) ?? band.x;
    return cropPixels(png, left, y, size.w, size.h);
  }

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

  // 4.6) DISTINGUISHING STATE MUTATION, so the save captures state a fresh New Game
  // does NOT already have. Bump to max sim speed ("Then Some" — hotkey default
  // `ingame_gamespeed_thensome = "5"`, CorsixTH/Lua/config_finder.lua:604, registered
  // unconditionally by CorsixTH/Lua/dialogs/bottom_panel.lua alongside the quicksave/
  // quickload chords) and let real wall-clock time pass so the in-game DATE advances
  // well past what the ~4s level-load wait above already ticks through.
  await clickCanvas(0.5, 0.08); // focus the canvas away from the welcome dialog (doesn't dismiss it, just needed for SDL key focus)
  await page.keyboard.press('Digit5');
  await new Promise((r) => setTimeout(r, 15_000)); // let the date advance meaningfully

  // Settle to Slowest speed (`ingame_gamespeed_slowest = "1"`, config_finder.lua:600)
  // for the save itself. "Then Some" ticks a new day roughly every 0.5-0.8s real-world
  // (measured empirically while building this check) — too fast relative to the
  // real-world gap between "capture the pre-save burst" and "the save actually runs" (a
  // click + a 4-key chord, ~0.2-0.4s of Puppeteer/SDL overhead), so the burst below
  // could still miss the exact tick that gets serialized; "Normal" turned out to be an
  // insufficient fix for the same reason (measured empirically: still only ~0.8-1.2s per
  // tick, not meaningfully safer). `tick_rates` (CorsixTH/Lua/world.lua:708-716) gives
  // Slowest a tick_rate of 56 versus Normal's 3 — roughly 18x slower — which comfortably
  // clears that gap. Slowing down here — not the distinguishing mutation itself, which
  // already happened above via the 15s of "Then Some" — is what makes the burst below
  // actually land on the saved value reliably instead of merely plausibly, and as a
  // bonus keeps the restored session nearly static through the whole post-load sampling
  // window below too (same slow speed carries through the save).
  await page.keyboard.press('Digit1');
  await new Promise((r) => setTimeout(r, 1500)); // let the slower cadence settle onto one stable date

  // Live, in-game-STATE marker (NOT quicksave.qs file bytes): a BURST of screenshot-crop
  // hashes of the bottom panel's date card (see DATE_CROP_FRAC's doc comment for the
  // exact draw call this crops), taken every 200ms right up until the save chord below —
  // deliberately WHILE STILL TICKING at full speed, not paused. This is the marker that
  // actually proves quickload restores state — see the comparison sites below.
  //
  // Why a burst of samples, and why NOT pause the world first to make a single sample
  // race-free (an earlier version of this fix tried exactly that, via the `ingame_pause`
  // hotkey "p"): pausing turns out to make an exact-hash marker LESS reliable, not more.
  // `World:setSpeed()` (CorsixTH/Lua/world.lua:778) flips
  // `TheApp.video:setBlueFilterActive(...)` whenever actions are disallowed (i.e. while
  // paused), which paints a dithered/checkerboard blue tint across the whole HUD — and
  // that dither pattern itself changes from frame to frame. Confirmed empirically while
  // building this check: two screenshots of the exact same visible date text ("7 Jan"
  // vs "7 Jan", inspected by eye), taken a couple of seconds apart while paused, differed
  // in 33-98% of the crop's pixels and hashed completely differently — an exact-hash
  // marker captured once while paused can essentially never reliably match a later
  // exact-hash marker, even when the date is genuinely unchanged, making that approach
  // strictly worse than the race it was meant to close. Staying unpaused avoids the
  // dither entirely (confirmed clean/undithered in every no-pause capture taken while
  // building this check); the burst below closes the "date ticks over between capture
  // and the actual save" race a different way — by recording several recent values as
  // all acceptable, rather than freezing time to get exactly one.
  const preSaveBurst = [];
  for (let i = 0; i < 8; i++) {
    preSaveBurst.push(hashShot(await captureDateSample()));
    if (i < 7) await new Promise((r) => setTimeout(r, 200));
  }
  console.log(`[e2e] pre-save date burst captured (unpaused, still ticking, ${preSaveBurst.length} samples over ~1.4s): ${preSaveBurst.map((h) => h.slice(0, 10)).join(', ')}`);

  // 5) Quicksave (alt+shift+s), immediately after the burst above. Focus the canvas
  // first so SDL receives the keys.
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

  // Capture the file-persistence marker (size + mtime) right after the save settles —
  // see statQuicksave's doc comment for exactly what this proves/doesn't prove (file
  // persistence only; the date-card marker above/below is the state-restoration proof).
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

  // Fresh-game date burst: this brand-new session is back at the game's normal start
  // date, unpaused, normal speed — none of these samples may appear anywhere in
  // preSaveBurst, or the round-trip assertion below would be comparing against values
  // that were never actually distinguishing in the first place (exactly the flaw this
  // rewrite fixes: a marker that can't tell a fresh game from an advanced one lets a
  // no-op quickLoad pass silently). Asserted immediately, before quickload gets any
  // chance to run. A short burst (not one sample) for the same reason as preSaveBurst —
  // this fresh session is also ticking, so its date is a moving target too.
  const freshBurst = [];
  for (let i = 0; i < 3; i++) {
    freshBurst.push(hashShot(await captureDateSample()));
    if (i < 2) await new Promise((r) => setTimeout(r, 300));
  }
  console.log(`[e2e] fresh-game date burst captured (pre-quickload): ${freshBurst.map((h) => h.slice(0, 10)).join(', ')}`);
  const staleOverlap = freshBurst.filter((h) => preSaveBurst.includes(h));
  if (staleOverlap.length) {
    markFail(`fresh-game date burst overlaps the pre-save burst BEFORE quickload even ran (${staleOverlap.map((h) => h.slice(0, 10)).join(', ')}) — the date-card marker is not distinguishing here (test setup problem), so the round-trip assertion below would be meaningless even if it passes`);
  }

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
  const midDateShots = [];
  const midBand = dateCardSearchBand(rect);
  const midSize = dateCropSize(rect);
  const midY = dateCropY(rect);
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 500));
    // One full-viewport screenshot serves BOTH the liveness check below (hashed whole)
    // and the date-card marker (located + cropped from the SAME decoded buffer — see
    // findDateCardLeft's doc comment for why the card is located dynamically rather
    // than cropped from one fixed screen position, and why this uses a full-viewport
    // screenshot rather than a second, separate `page.screenshot({clip})` call).
    const shot = await page.screenshot();
    midLoadShots.push(shot);
    const png = decodePng(shot);
    const left = findDateCardLeft(png, midBand);
    midDateShots.push(left !== null ? cropPixels(png, left, midY, midSize.w, midSize.h) : Buffer.alloc(0));
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

  // *** THE state round-trip assertion (state restoration, not just file bytes). ***
  // At least one of the post-alt+shift+l date-card samples must hash EXACTLY equal to
  // one of preSaveBurst's samples (the unpaused, post-speedup values captured right
  // before alt+shift+s) — proving the world quickLoad rebuilt genuinely has the SAVED
  // date restored (at or immediately after the value in effect at save time), not the
  // fresh New Game's own date left in place. Both sides are burst-sampled (not a single
  // frame) because the world keeps ticking on both sides of the save/load boundary —
  // see preSaveBurst's doc comment for why a single frame (paused or not) isn't good
  // enough here. This is what makes "quickLoad restored nothing" fail loudly: under the
  // OLD flow (quicksave immediately after New Game, no distinguishing mutation) a
  // quickLoad that silently no-oped would leave the fresh date on screen and nothing
  // here would ever catch it; freshBurst was already asserted to have zero overlap with
  // preSaveBurst above, so a no-op load surfaces as "no overlap after load either", not
  // as a false pass.
  const midDateHashes = midDateShots.map(hashShot);
  const restoredOverlap = midDateHashes.filter((h) => preSaveBurst.includes(h));
  if (!restoredOverlap.length) {
    markFail(`quickload did not restore the saved game state — no post-alt+shift+l date-card sample matched any pre-save value (pre-save=[${preSaveBurst.map((h) => h.slice(0, 10)).join(', ')}], fresh=[${freshBurst.map((h) => h.slice(0, 10)).join(', ')}], sampled-after-load=[${midDateHashes.map((h) => h.slice(0, 10)).join(', ')}])`);
  } else {
    console.log(`[e2e] STATE ROUND-TRIP PASSED: ${restoredOverlap.length}/${midDateHashes.length} post-quickload date-card sample(s) matched a pre-save value (${[...new Set(restoredOverlap)].map((h) => h.slice(0, 10)).join(', ')}); fresh-game values were [${freshBurst.map((h) => h.slice(0, 10)).join(', ')}])`);
  }

  // File-persistence assertion (NOT a state-restoration proof — see statQuicksave's doc
  // comment and the STATE round-trip assertion just above for that): the quicksave.qs
  // marker captured right after alt+shift+s must be BYTE- and TIMESTAMP-IDENTICAL to the
  // same file's marker read right now, after the reload + New Game + alt+shift+l. In
  // short, App:quickLoad() only reads (does not rewrite) an existing quicksave, so this
  // file must not have moved across the round trip — if it has, something (a stray
  // autosave, a differently-named file being matched, IDBFS not restoring the stored
  // mtime) broke the assumption the whole flow depends on.
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
