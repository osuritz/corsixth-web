import { Unzip, UnzipInflate } from 'fflate';
import { putAsset, getAsset, clearAssets, listAssetPaths, validateAssetPaths } from './idb';
import { setStatus } from './main';

export const ALLOWED_TOP_DIRS = ['DATA', 'DATAM', 'LEVELS', 'QDATA', 'QDATAM', 'ANIMS', 'INTRO', 'SOUND'];
export const DEMO_URL = 'https://archive.org/download/HOSP_zip/HOSP.zip';

export function normalizeAssetPath(rawPath: string): string | null {
  if (rawPath.endsWith('/')) return null;
  const parts = rawPath.toUpperCase().split('/').filter(Boolean);
  const start = parts.findIndex((p) => ALLOWED_TOP_DIRS.includes(p));
  if (start === -1 || start === parts.length - 1) return null;
  return parts.slice(start).join('/');
}

type MusicRenderer = {
  renderXmiToAudio: (xmi: Uint8Array, sf: Uint8Array) => Promise<{ bytes: Uint8Array; ext: 'OGG' | 'WAV' }>;
};

// Lazily load the separate music-render IIFE bundle and return its global once ready.
function loadMusicRenderer(): Promise<MusicRenderer> {
  const g = self as unknown as { __corsixthRenderMusic?: MusicRenderer };
  if (g.__corsixthRenderMusic) return Promise.resolve(g.__corsixthRenderMusic);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'music-render.js';
    s.onload = () => g.__corsixthRenderMusic ? resolve(g.__corsixthRenderMusic) : reject(new Error('music-render loaded but global missing'));
    s.onerror = () => reject(new Error('failed to load music-render.js'));
    document.head.appendChild(s);
  });
}

// Render any ingested SOUND/MIDI/*.XMI to MUSIC/<NAME>.<OGG|WAV> (a dedicated music dir —
// see the storage-location note in the M3 plan). OGG Vorbis is the primary output format
// (music-render.ts tries it first); WAV is the zero-risk fallback on encoder failure —
// the emitted filename always follows the extension music-render actually returned.
// Best-effort: on any failure, suppress cleanly and defer (the in-game XMI-decode error
// is avoided because no XMI reaches the mixer).
async function renderMusic(onStatus: (msg: string) => void): Promise<void> {
  let paths: string[];
  try {
    paths = await listAssetPaths();
  } catch (e) {
    console.warn('[shell] music render: could not list assets, skipping:', e); // best-effort
    return;
  }
  const xmis = paths.filter((p) => /^SOUND\/MIDI\/[^/]+\.XMI$/.test(p));
  if (xmis.length === 0) return;
  let soundfont: Uint8Array;
  let renderer: MusicRenderer;
  try {
    onStatus('Preparing music…');
    const sfRes = await fetch('FluidR3.sf3');
    if (!sfRes.ok) throw new Error(`soundfont ${sfRes.status}`);
    soundfont = new Uint8Array(await sfRes.arrayBuffer());
    renderer = await loadMusicRenderer();
  } catch (e) {
    console.warn('[shell] music render unavailable, deferring:', e); // suppress cleanly
    return;
  }
  for (let i = 0; i < xmis.length; i++) {
    const p = xmis[i];
    try {
      onStatus(`Rendering music ${i + 1}/${xmis.length}…`);
      const xmi = await getAsset(p);
      if (!xmi) continue;
      const { bytes, ext } = await renderer.renderXmiToAudio(xmi, soundfont);
      const name = p.slice(p.lastIndexOf('/') + 1).replace(/\.XMI$/, `.${ext}`);
      await putAsset(`MUSIC/${name}`, bytes);
    } catch (e) {
      console.warn(`[shell] music render failed for ${p}:`, e); // per-track suppress
    }
  }
  // Preserve track titles: copy any track-list TXT (e.g. MIDIDEM.TXT) into MUSIC/ so
  // audio.lua's midi_txt detection still names tracks. Cosmetic, cheap. Best-effort:
  // this must never throw past renderMusic() — a failure here would otherwise skip
  // finishIngest()'s location.reload() and strand the user on the ingest overlay.
  try {
    for (const p of paths.filter((q) => /^SOUND\/MIDI\/[^/]+\.TXT$/.test(q))) {
      const txt = await getAsset(p);
      if (txt) await putAsset(`MUSIC/${p.slice(p.lastIndexOf('/') + 1)}`, txt);
    }
  } catch (e) {
    console.warn('[shell] music render: track-title copy failed, skipping:', e); // best-effort
  }
}

async function finishIngest(count: number): Promise<void> {
  const { ok, missing } = validateAssetPaths(await listAssetPaths());
  if (!ok) {
    await clearAssets();
    throw new Error(`Not a Theme Hospital data set — missing: ${missing.join(', ')}. ` +
      `Drop the demo zip (HOSP.zip) or your full game folder (containing DATA, LEVELS, QDATA).`);
  }
  await renderMusic((msg) => setStatus(msg));
  setStatus(`Loaded ${count} game files — starting…`);
  location.reload();
}

// True per-file backpressure bound: at most this many writes are EVER actually running
// concurrently (see BoundedQueue below), and the reader loop won't pull the next stream
// chunk while the backlog (queued + in-flight) is at or above this bound.
//
// This replaced an earlier per-reader-chunk checkpoint that only checked
// `pending.length >= MAX_INFLIGHT_PUTS` AFTER an entire reader chunk had already been
// processed — but fflate fires onfile/ondata synchronously, so every file that
// completed within that one chunk had ALREADY had its putAsset call started (and its
// buffer held live) before the check ever ran, and the subsequent `Promise.all(pending)`
// then awaited all of them concurrently rather than actually limiting concurrency to
// MAX_INFLIGHT_PUTS. Measured (web/measure-ingest-memory.mjs, 3 runs each, ~320MB
// synthetic zip, performance.memory.usedJSHeapSize peak — Chromium-only, coarse/
// GC-dependent, a DIRECTIONAL check not a precise allocator readout): BEFORE this
// change (per-reader-chunk checkpoint) 147.6 / 149.1 / 156.8 MB; AFTER (this file's
// true bounded-concurrency queue) 129.1 / 137.6 / 144.9 MB — roughly a 9-10% peak
// reduction on this synthetic payload (large ~0.4-2MB synthetic entries, comparable in
// size to a reader chunk; real Theme Hospital data has many more small files, where the
// per-reader-chunk burst this fix closes would be more pronounced). vs ~270MB fully
// unbounded pre-M3-Task-5 — see docs/superpowers/reports/m3-ingest-memory.md.
export const MAX_INFLIGHT_PUTS = 8;

// Bounded-concurrency work queue, generic over the async write function so it's unit-
// testable without IndexedDB (see onboarding.test.ts) — ingestZip below wires it to
// putAsset. fflate's onfile/ondata callbacks are synchronous (and may fire for several
// completed files within a single reader chunk), so we can't `await` a drain from
// inside them — instead, a completed item is queued here and a pump loop starts at most
// `limit` writes at a time; anything beyond that waits in `queue` (still memory, but now
// a hard cap instead of an unbounded per-chunk burst). `whenBelow` additionally lets the
// reader loop await queue capacity before requesting the next chunk, so backlog can't
// grow across chunk boundaries either.
export class BoundedQueue<T> {
  private queue: T[] = [];
  private inflight = 0;
  private waiters: (() => void)[] = [];
  private completed = 0;
  firstError: unknown;
  get count(): number { return this.completed; }

  constructor(
    private readonly limit: number,
    private readonly write: (item: T) => Promise<void>,
    private readonly onProgress: (done: number) => void,
  ) {}

  push(item: T): void {
    this.queue.push(item);
    this.pump();
  }

  private pump(): void {
    while (this.inflight < this.limit && this.queue.length > 0) {
      const item = this.queue.shift()!;
      this.inflight++;
      this.write(item)
        .then(() => this.onProgress(++this.completed))
        .catch((e) => { this.firstError = this.firstError ?? e; })
        .finally(() => { this.inflight--; this.pump(); this.notify(); });
    }
  }

  private notify(): void {
    for (const w of [...this.waiters]) w();
  }

  // Resolves once (queued + in-flight) drops below `bound`, or immediately if an error
  // has already occurred (so a stuck-open wait can't mask/deadlock past a failure).
  whenBelow(bound: number): Promise<void> {
    const size = () => this.queue.length + this.inflight;
    if (this.firstError || size() < bound) return Promise.resolve();
    return new Promise((resolve) => {
      const check = () => {
        if (!this.firstError && size() >= bound) return;
        const i = this.waiters.indexOf(check);
        if (i !== -1) this.waiters.splice(i, 1);
        resolve();
      };
      this.waiters.push(check);
    });
  }
}

// Streaming zip ingest: file bytes are assembled one at a time and handed to a bounded
// concurrency queue (BoundedQueue, see above) so at most MAX_INFLIGHT_PUTS putAsset
// writes are ever in flight — true per-file backpressure, not just a per-reader-chunk
// checkpoint.
export async function ingestZip(file: File, onProgress: (done: number) => void): Promise<void> {
  const unzip = new Unzip();
  unzip.register(UnzipInflate);
  const puts = new BoundedQueue<{ path: string; data: Uint8Array }>(
    MAX_INFLIGHT_PUTS,
    (item) => putAsset(item.path, item.data),
    onProgress,
  );
  unzip.onfile = (f) => {
    const norm = normalizeAssetPath(f.name);
    if (!norm) return;
    const chunks: Uint8Array[] = [];
    f.ondata = (err, data, final) => {
      if (err) throw err;
      chunks.push(data);
      if (final) {
        const total = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
        let o = 0;
        for (const c of chunks) { total.set(c, o); o += c.length; }
        chunks.length = 0;
        puts.push({ path: norm, data: total });
      }
    };
    f.start();
  };
  const reader = file.stream().getReader();
  for (;;) {
    if (puts.firstError) throw puts.firstError;
    await puts.whenBelow(MAX_INFLIGHT_PUTS);
    const { done, value } = await reader.read();
    if (done) { unzip.push(new Uint8Array(0), true); break; }
    unzip.push(value, false);
  }
  await puts.whenBelow(1); // full drain: nothing queued, nothing in flight
  if (puts.firstError) throw puts.firstError;
  await finishIngest(puts.count);
}

async function walkEntry(entry: FileSystemEntry, prefix: string, out: { path: string; file: () => Promise<File> }[]): Promise<void> {
  if (entry.isFile) {
    out.push({ path: `${prefix}${entry.name}`, file: () => new Promise((res, rej) => (entry as FileSystemFileEntry).file(res, rej)) });
  } else if (entry.isDirectory) {
    const dr = (entry as FileSystemDirectoryEntry).createReader();
    for (;;) {
      const batch: FileSystemEntry[] = await new Promise((res, rej) => dr.readEntries(res, rej));
      if (batch.length === 0) break;
      for (const e of batch) await walkEntry(e, `${prefix}${entry.name}/`, out);
    }
  }
}

export async function ingestDropped(dt: DataTransfer, onProgress: (done: number) => void): Promise<void> {
  const items = Array.from(dt.items).map((i) => i.webkitGetAsEntry?.()).filter((e): e is FileSystemEntry => !!e);
  // Single zip file → zip path
  if (items.length === 1 && items[0].isFile && /\.zip$/i.test(items[0].name)) {
    const file = await new Promise<File>((res, rej) => (items[0] as FileSystemFileEntry).file(res, rej));
    return ingestZip(file, onProgress);
  }
  // Folder(s) → traverse
  const all: { path: string; file: () => Promise<File> }[] = [];
  for (const e of items) await walkEntry(e, '', all);
  let count = 0;
  for (const f of all) {
    const norm = normalizeAssetPath(f.path);
    if (!norm) continue;
    const data = new Uint8Array(await (await f.file()).arrayBuffer());
    await putAsset(norm, data);
    onProgress(++count);
  }
  await finishIngest(count);
}

export function showOnboarding(): void {
  const root = document.getElementById('overlay-content')!;
  root.innerHTML = `
    <h1>CorsixTH Web</h1>
    <p class="lede">Theme Hospital in your browser. The engine is free &amp; open source — the game data is not included.</p>
    <p><a class="button" href="${DEMO_URL}" download><span class="step-num">1</span> Download the free demo <small>12&nbsp;MB, from archive.org</small></a></p>
    <div id="drop-zone">
      <span class="drop-icon" aria-hidden="true">📥</span>
      <p><span class="step-num">2</span><strong>Drop the downloaded HOSP.zip here</strong><br>— or drop your own GOG/CD Theme Hospital folder —</p>
      <progress id="ingest-progress" class="hidden" max="100"></progress>
      <p id="ingest-status"></p>
    </div>
    <p class="fine-print">The demo was freely distributed by Bullfrog/EA in 1997 to promote the game.
    It downloads directly from archive.org to your browser — this site never serves game data.
    Your files stay in your browser's local storage.</p>`;
  const zone = document.getElementById('drop-zone')!;
  const status = document.getElementById('ingest-status')!;
  const prog = document.getElementById('ingest-progress') as HTMLProgressElement;
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault(); zone.classList.remove('drag');
    if (!e.dataTransfer) return;
    prog.classList.remove('hidden'); prog.removeAttribute('value');
    status.textContent = 'Reading files…';
    ingestDropped(e.dataTransfer, (n) => { status.textContent = `Stored ${n} files…`; })
      .catch((err) => { prog.classList.add('hidden'); status.textContent = String(err instanceof Error ? err.message : err); status.classList.add('error'); });
  });
}
