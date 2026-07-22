// All Emscripten filesystem policy for the shell lives here.
export const MOUNT_CONFIG = '/home/web_user/.config/CorsixTH';
export const MOUNT_DATA = '/th-data';

// Minimal structural types for the Emscripten surface we touch (FS/ENV exported in Task 2's flag delta).
export interface EmFS {
  mkdir(p: string): void;
  mount(fs: unknown, opts: object, p: string): void;
  syncfs(populate: boolean, cb: (err: unknown) => void): void;
  writeFile(p: string, data: Uint8Array | string): void;
  readFile(p: string, opts: { encoding: 'utf8' }): string;
  analyzePath(p: string): { exists: boolean };
  filesystems: { IDBFS: unknown };
}
export interface EmModuleConfig { [k: string]: unknown }
export interface ShellHooks {
  onGameReady(): void;
  onSaveSyncError(detail: string): void;
  onFatal(detail: string): void;
}

function mkdirDeep(FS: EmFS, path: string): void {
  let cur = '';
  for (const part of path.split('/').filter(Boolean)) {
    cur += '/' + part;
    try { FS.mkdir(cur); } catch { /* EEXIST — fine */ }
  }
}

// Ensure config.txt sends the engine straight to /th-data (skips setup UI).
// config.txt is a Lua chunk of `key = value` lines; install path uses [[...]] strings
// (config_finder.lua). Rewrite/append only the theme_hospital_install line.
export function ensureInstallPath(FS: EmFS): void {
  const cfgFile = `${MOUNT_CONFIG}/config.txt`;
  const line = `theme_hospital_install = [[${MOUNT_DATA}]]`;
  let text = '';
  if (FS.analyzePath(cfgFile).exists) text = FS.readFile(cfgFile, { encoding: 'utf8' });
  if (new RegExp(`theme_hospital_install\\s*=\\s*\\[\\[${MOUNT_DATA}\\]\\]`).test(text)) return;
  if (/theme_hospital_install\s*=/.test(text)) {
    text = text.replace(/theme_hospital_install\s*=\s*(\[\[[^\]]*\]\]|"[^"]*"|nil)/, line);
  } else {
    text = `${line}\n${text}`;
  }
  FS.writeFile(cfgFile, text);
}

export function buildModuleConfig(
  canvas: HTMLCanvasElement,
  hooks: ShellHooks,
  populateData: (FS: EmFS) => Promise<number>,
): EmModuleConfig {
  const config: EmModuleConfig = {
    canvas,
    print: (t: string) => console.log('[stdout]', t),
    printErr: (t: string) => console.warn('[stderr]', t),
    gameReady: () => hooks.onGameReady(),
    onSaveSyncError: (detail: string) => hooks.onSaveSyncError(detail),
    onAbort: (what: unknown) => hooks.onFatal(`Engine aborted: ${String(what)}`),
  };
  config.preRun = [() => {
    const FS = (config as { FS?: EmFS }).FS;
    if (!FS) { hooks.onFatal('Module.FS missing — EXPORTED_RUNTIME_METHODS must include FS'); return; }
    // 1) Persistent config+saves dir on IDBFS (engine writes config.txt, Saves/, etc. here).
    mkdirDeep(FS, MOUNT_CONFIG);
    FS.mount(FS.filesystems.IDBFS, {}, MOUNT_CONFIG);
    // 2) Game-data root on MEMFS (read-only working set, repopulated each boot).
    mkdirDeep(FS, MOUNT_DATA);
    // 3) Gate main() until IDBFS pull + data population complete.
    const dep = 'corsixth-web-fs';
    (config.addRunDependency as (id: string) => void)(dep);
    FS.syncfs(true, (err: unknown) => {
      if (err) hooks.onSaveSyncError(`initial syncfs: ${String(err)}`);
      populateData(FS)
        .then((count) => { if (count > 0) ensureInstallPath(FS); })
        .catch((e) => hooks.onFatal(`asset population failed: ${String(e)}`))
        .finally(() => (config.removeRunDependency as (id: string) => void)(dep));
    });
  }];
  return config;
}
