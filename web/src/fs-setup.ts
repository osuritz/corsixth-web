// All Emscripten filesystem policy for the shell lives here.
export const MOUNT_CONFIG = '/home/web_user/.config/CorsixTH';
export const MOUNT_DATA = '/th-data';
export const MOUNT_MUSIC = `${MOUNT_DATA}/MUSIC`;

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

// Defensive guard against a real, empirically-confirmed fragility: config_finder.lua's
// needs_rewrite scan (config_finder.lua:172, `string.find(file_contents, "\n" ..
// "%s*" .. key .. "%s*=")`) requires a LITERAL leading "\n" before every tracked key —
// a tracked key sitting as the literal first line of config.txt (no preceding newline)
// is invisible to that scan and trips needs_rewrite for that key. Today this is only
// incidentally avoided: ensureMusicDir's prepend happens to push theme_hospital_install
// off line 0, but ONLY when MUSIC/ already exists (i.e. after music has rendered at
// least once) — a freshly-ingested profile with no rendered tracks yet (or any future
// reordering of these preRun calls) would leave theme_hospital_install sitting on line
// 0. Guarantee a non-tracked first line UNCONDITIONALLY, independent of call order or
// whether ensureMusicDir ever runs, so no tracked key can ever occupy line 0.
const LINE0_GUARD = '-- corsixth-web generated config';
function ensureLine0Guard(text: string): string {
  if (text === LINE0_GUARD || text.startsWith(`${LINE0_GUARD}\n`)) return text;
  return text.length ? `${LINE0_GUARD}\n${text}` : LINE0_GUARD;
}

// Ensure config.txt sends the engine straight to /th-data (skips setup UI).
// config.txt is a Lua chunk of `key = value` lines; install path uses [[...]] strings
// (config_finder.lua). Rewrite/append only the theme_hospital_install line.
export function ensureInstallPath(FS: EmFS): void {
  const cfgFile = `${MOUNT_CONFIG}/config.txt`;
  const line = `theme_hospital_install = [[${MOUNT_DATA}]]`;
  let text = '';
  if (FS.analyzePath(cfgFile).exists) text = FS.readFile(cfgFile, { encoding: 'utf8' });
  const before = text;
  text = ensureLine0Guard(text);
  if (!new RegExp(`theme_hospital_install\\s*=\\s*\\[\\[${MOUNT_DATA}\\]\\]`).test(text)) {
    if (/theme_hospital_install\s*=/.test(text)) {
      text = text.replace(/theme_hospital_install\s*=\s*(\[\[[^\]]*\]\]|"[^"]*"|nil)/, line);
    } else {
      text = `${text}\n${line}`;
    }
  }
  if (text !== before) FS.writeFile(cfgFile, text);
}

// Mirrors CorsixTH/Lua/config_finder.lua's `config_defaults` table (this pinned engine
// build) MINUS theme_hospital_install (already written above with our real path instead
// of the Lua default).
//
// Why this exists — a real, empirically-confirmed bug this fix closes: config_finder.lua
// rewrites config.txt from scratch whenever ANY of its ~48 tracked default keys is
// missing from the file (its `needs_rewrite` check), and that rewrite emits
// `audio_music = nil` as a hardcoded literal — audio_music is NOT one of the tracked
// config_defaults keys, so it is never preserved across a rewrite (see
// config_finder.lua:481, a static string template, not built from config_values). Our
// preRun writes config.txt from scratch on a fresh IDBFS profile (only 1-2 lines), so
// without this, the very first boot after ingest always tripped that rewrite and
// silently discarded our `audio_music` override — reproducing the exact "Could not load
// music file ... Unrecognized audio format" bug this task exists to fix. Confirmed via a
// live browser run before this fix (config.txt read back post-boot showed the stock
// `audio_music = nil -- [[X:\ThemeHospital\Music]]` default, not our override).
//
// Pre-seeding these keeps needs_rewrite false so config_finder.lua leaves config.txt —
// and our own theme_hospital_install/audio_music override lines — untouched. Values are
// copied verbatim from config_defaults; if a future engine version adds a new default
// key we don't know about, the rewrite would only recur for that one new key (a narrow
// regression, not a silent reintroduction of this bug).
const DEFAULT_CONFIG_LINES = [
  'fullscreen = false', 'width = 800', 'height = 600', 'language = [[English]]',
  'audio = true', 'free_build_mode = false', 'play_sounds = true', 'sound_volume = 0.5',
  'play_announcements = true', 'announcement_volume = 0.5', 'play_music = true',
  'music_volume = 0.5', 'prevent_edge_scrolling = false', 'capture_mouse = true',
  'right_mouse_scrolling = false', 'adviser_disabled = false', 'scrolling_momentum = 0.8',
  'twentyfour_hour_clock = true', 'warmth_colors_display_default = 1',
  'grant_wage_increase = false', 'movies = true', 'play_intro = true', 'play_demo = true',
  'allow_user_actions_while_paused = false', 'volume_opens_casebook = false',
  'alien_dna_only_by_emergency = true', 'alien_dna_must_stand = true',
  'alien_dna_can_knock_on_doors = false', 'disable_fractured_bones_females = true',
  'enable_avg_contents = false', 'remove_destroyed_rooms = false',
  'machine_menu_button = true', 'enable_screen_shake = true', 'audio_frequency = 22050',
  'audio_channels = 2', 'audio_buffer_size = 2048', 'debug = false', 'track_fps = false',
  'zoom_speed = 80', 'scroll_speed = 2', 'shift_scroll_speed = 4',
  'new_graphics_folder = nil', 'use_new_graphics = false', 'check_for_updates = true',
  'room_information_dialogs = true', 'allow_blocking_off_areas = false',
  'direct_zoom = nil', 'new_machine_extra_info = true', 'player_name = [[]]',
];

export function ensureConfigDefaults(FS: EmFS): void {
  const cfgFile = `${MOUNT_CONFIG}/config.txt`;
  let text = '';
  if (FS.analyzePath(cfgFile).exists) text = FS.readFile(cfgFile, { encoding: 'utf8' });
  const before = text;
  text = ensureLine0Guard(text);
  for (const line of DEFAULT_CONFIG_LINES) {
    const key = line.slice(0, line.indexOf('=')).trim();
    if (new RegExp(`(^|\\n)\\s*${key}\\s*=`).test(text)) continue;
    text = `${text}\n${line}`;
  }
  if (text !== before) FS.writeFile(cfgFile, text);
}

// After data population, if rendered music is present, set audio_music so the engine
// scans /th-data/MUSIC (rendered OGG/WAV) instead of Sound/Midi (failing XMIs). This is
// the zero-engine-change realization of the music MUST-HAVE — see the M3 plan's storage
// note: config_finder.lua defaults audio_music to nil, and Audio:init() (called
// unprotected at app.lua:274) would concatenate a nil music_dir if we pointed it at a
// path that never gets populated, so this only writes the line when MUSIC/ truly exists.
// Relies on ensureConfigDefaults() having already made needs_rewrite false (see there) —
// without that, config_finder.lua's own rewrite would silently discard this line.
export function ensureMusicDir(FS: EmFS): void {
  if (!FS.analyzePath(MOUNT_MUSIC).exists) return;
  const cfgFile = `${MOUNT_CONFIG}/config.txt`;
  const line = `audio_music = [[${MOUNT_MUSIC}]]`;
  let text = '';
  if (FS.analyzePath(cfgFile).exists) text = FS.readFile(cfgFile, { encoding: 'utf8' });
  if (new RegExp(`audio_music\\s*=\\s*\\[\\[${MOUNT_MUSIC}\\]\\]`).test(text)) return;
  if (/audio_music\s*=/.test(text)) {
    text = text.replace(/audio_music\s*=\s*(\[\[[^\]]*\]\]|"[^"]*"|nil)/, line);
  } else {
    // Append (not prepend) — keeps the line-0 guard permanently first regardless of
    // whether ensureMusicDir ever runs (see ensureLine0Guard's comment above).
    text = `${text}\n${line}`;
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
        .then((count) => { if (count > 0) { ensureInstallPath(FS); ensureConfigDefaults(FS); ensureMusicDir(FS); } })
        .catch((e) => hooks.onFatal(`asset population failed: ${String(e)}`))
        .finally(() => (config.removeRunDependency as (id: string) => void)(dep));
    });
  }];
  return config;
}
