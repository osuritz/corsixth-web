import { Unzip, UnzipInflate } from 'fflate';
import { putAsset, clearAssets, listAssetPaths, validateAssetPaths } from './idb';
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

async function finishIngest(count: number): Promise<void> {
  const { ok, missing } = validateAssetPaths(await listAssetPaths());
  if (!ok) {
    await clearAssets();
    throw new Error(`Not a Theme Hospital data set — missing: ${missing.join(', ')}. ` +
      `Drop the demo zip (HOSP.zip) or your full game folder (containing DATA, LEVELS, QDATA).`);
  }
  setStatus(`Loaded ${count} game files — starting…`);
  location.reload();
}

// Streaming zip ingest: one file's bytes in memory at a time (memory budget requirement).
export async function ingestZip(file: File, onProgress: (done: number) => void): Promise<void> {
  let count = 0;
  const unzip = new Unzip();
  unzip.register(UnzipInflate);
  const pending: Promise<void>[] = [];
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
