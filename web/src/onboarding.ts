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

// Cap on putAsset promises in flight at once. Each holds one assembled file buffer alive
// until IndexedDB commits it, so this bounds ingest peak memory regardless of zip size
// (GOG installs are hundreds of MB). fflate's onfile/ondata are synchronous, so we drain
// between reader chunks rather than inside the callbacks.
export const MAX_INFLIGHT_PUTS = 8;

// Streaming zip ingest: file bytes are assembled one at a time and handed to IndexedDB,
// with at most MAX_INFLIGHT_PUTS writes (and their buffers) live concurrently.
export async function ingestZip(file: File, onProgress: (done: number) => void): Promise<void> {
  let count = 0;
  const unzip = new Unzip();
  unzip.register(UnzipInflate);
  let pending: Promise<void>[] = [];
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
        pending.push(putAsset(norm, total).then(() => { onProgress(++count); }));
      }
    };
    f.start();
  };
  const reader = file.stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) { unzip.push(new Uint8Array(0), true); break; }
    unzip.push(value, false);
    if (pending.length >= MAX_INFLIGHT_PUTS) { await Promise.all(pending); pending = []; }
  }
  await Promise.all(pending);
  await finishIngest(count);
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
    <p>Theme Hospital in your browser. The engine is free & open source — the game data is not included.</p>
    <p><a class="button" href="${DEMO_URL}" download>1&#41; Download the free demo (12&nbsp;MB, archive.org)</a></p>
    <div id="drop-zone">
      <p><strong>2&#41; Drop the downloaded HOSP.zip here</strong><br>— or drop your own GOG/CD Theme Hospital folder —</p>
      <progress id="ingest-progress" class="hidden" max="100"></progress>
      <p id="ingest-status"></p>
    </div>
    <p style="font-size:.8rem;opacity:.7">The demo was freely distributed by Bullfrog/EA in 1997 to promote the game.
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
