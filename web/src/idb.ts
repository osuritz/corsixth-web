import type { EmFS } from './fs-setup';
import { MOUNT_DATA } from './fs-setup';

const DB_NAME = 'corsixth-web';
const STORE = 'th-data';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDB().then((db) => new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    t.oncomplete = () => db.close();
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
  tx('readwrite', (s) => s.put(data, path)).then(() => undefined);
export const getAsset = (path: string): Promise<Uint8Array | undefined> =>
  tx('readonly', (s) => s.get(path) as IDBRequest<Uint8Array | undefined>);
export const listAssetPaths = (): Promise<string[]> =>
  tx('readonly', (s) => s.getAllKeys() as IDBRequest<IDBValidKey[]>).then((ks) => ks.map(String));
export const assetCount = (): Promise<number> => tx('readonly', (s) => s.count());
export const clearAssets = (): Promise<void> => tx('readwrite', (s) => s.clear()).then(() => undefined);

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
