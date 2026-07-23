import type { EmFS } from './fs-setup';
import { MOUNT_DATA } from './fs-setup';

const DB_NAME = 'corsixth-web';
const STORE = 'th-data';
// Reserved second store for per-track music-render status (M3+ retriable worker
// render — see music-orchestrator.ts). Deliberately a SEPARATE object store rather than
// a reserved key prefix inside STORE: populateThData below copies every key in STORE
// verbatim into the engine's MEMFS at every boot, so status metadata living alongside
// real asset bytes there would leak into the emulated game filesystem. A second store
// keeps it out of that path entirely, with no filtering logic needed anywhere else.
const STATUS_STORE = 'render-status';
// Bumped from 1 (STORE only) to add STATUS_STORE. onupgradeneeded preserves existing
// STORE contents automatically — this only adds the new store.
const DB_VERSION = 2;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      if (!db.objectStoreNames.contains(STATUS_STORE)) db.createObjectStore(STATUS_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDB().then((db) => new Promise<T>((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    t.oncomplete = () => db.close();
    // AMENDED (Task 3 review): a failed request aborts the transaction, and
    // 'complete' never fires on abort — close there too or every failed
    // put/get leaks the connection (matters for Task 4's bulk ingest).
    t.onabort = () => db.close();
  }));
}

// AMENDED (Task 2 review finding): required-file validation lives HERE (not onboarding.ts)
// so the boot path can re-validate stored assets — partial IndexedDB writes or quota
// eviction would otherwise strand the user behind the overlay with no error.
export const REQUIRED_FILES = ['DATA/VBLK-0.TAB', 'LEVELS/LEVEL.L1', 'QDATA/SPOINTER.DAT'];
export function validateAssetPaths(paths: string[]): { ok: boolean; missing: string[] } {
  const set = new Set(paths);
  const missing = REQUIRED_FILES.filter((f) => !set.has(f));
  return { ok: missing.length === 0, missing };
}

export const putAsset = (path: string, data: Uint8Array): Promise<void> =>
  tx(STORE, 'readwrite', (s) => s.put(data, path)).then(() => undefined);
export const getAsset = (path: string): Promise<Uint8Array | undefined> =>
  tx(STORE, 'readonly', (s) => s.get(path) as IDBRequest<Uint8Array | undefined>);
export const listAssetPaths = (): Promise<string[]> =>
  tx(STORE, 'readonly', (s) => s.getAllKeys() as IDBRequest<IDBValidKey[]>).then((ks) => ks.map(String));
export const clearAssets = (): Promise<void> => tx(STORE, 'readwrite', (s) => s.clear()).then(() => undefined);

// --- Music-render status (M3+ worker offload + retry — see music-orchestrator.ts) ---
// Keyed by the source XMI's asset path (e.g. "SOUND/MIDI/TRACK1.XMI"), one entry per
// track. 'pending': discovered, never attempted. 'rendering': in progress this session
// (a crash/reload mid-render leaves this stale — resumeMusicRendering treats stale
// 'rendering' the same as 'pending', see its own comment). 'done': rendered file is in
// MUSIC/. 'error': last attempt failed; `error` holds a human-readable message; retriable.
export type MusicRenderState = 'pending' | 'rendering' | 'done' | 'error';
export interface MusicRenderStatus {
  state: MusicRenderState;
  error?: string;
  updatedAt: number;
}

export const getRenderStatus = (track: string): Promise<MusicRenderStatus | undefined> =>
  tx(STATUS_STORE, 'readonly', (s) => s.get(track) as IDBRequest<MusicRenderStatus | undefined>);
export const setRenderStatus = (track: string, status: MusicRenderStatus): Promise<void> =>
  tx(STATUS_STORE, 'readwrite', (s) => s.put(status, track)).then(() => undefined);
export const clearRenderStatuses = (): Promise<void> => tx(STATUS_STORE, 'readwrite', (s) => s.clear()).then(() => undefined);

// One round trip for every track's status rather than N (used by resumeMusicRendering
// to decide what needs (re)rendering before starting any work). getAll() doesn't return
// keys, so this walks a cursor and builds the map itself.
export function listRenderStatuses(): Promise<Map<string, MusicRenderStatus>> {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const out = new Map<string, MusicRenderStatus>();
    const t = db.transaction(STATUS_STORE, 'readonly');
    const req = t.objectStore(STATUS_STORE).openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) { out.set(String(cursor.key), cursor.value as MusicRenderStatus); cursor.continue(); }
    };
    req.onerror = () => reject(req.error);
    t.oncomplete = () => { db.close(); resolve(out); };
    t.onabort = () => { db.close(); reject(t.error); };
  }));
}

// Boot-time: copy every cached asset into the engine's /th-data (MEMFS). One entry
// in memory at a time — bounded regardless of total asset size.
export async function populateThData(FS: EmFS): Promise<number> {
  const paths = await listAssetPaths();
  for (const p of paths) {
    const data = await getAsset(p);
    if (!data) continue;
    const full = `${MOUNT_DATA}/${p}`;
    const dir = full.slice(0, full.lastIndexOf('/'));
    let cur = '';
    for (const part of dir.split('/').filter(Boolean)) {
      cur += '/' + part;
      try { FS.mkdir(cur); } catch { /* EEXIST */ }
    }
    FS.writeFile(full, data);
  }
  return paths.length;
}
