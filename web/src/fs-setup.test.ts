import test from 'node:test';
import assert from 'node:assert';
import { ensureInstallPath, ensureConfigDefaults, ensureMusicDir, MOUNT_MUSIC, type EmFS } from './fs-setup';

// The exact key list from CorsixTH/Lua/config_finder.lua's `config_defaults` table
// (independently transcribed here, not imported from fs-setup.ts — a typo in either
// place should make this test fail). config_finder.lua rewrites config.txt from scratch
// whenever ANY of these is missing (`needs_rewrite`), discarding any custom line NOT in
// this table — including audio_music. See fs-setup.ts's DEFAULT_CONFIG_LINES comment for
// the full story (a real bug found and fixed during Task 3: the engine's own config
// rewrite was silently clobbering our audio_music override on the very first boot).
const CONFIG_FINDER_DEFAULT_KEYS = [
  'fullscreen', 'width', 'height', 'language', 'audio', 'free_build_mode', 'play_sounds',
  'sound_volume', 'play_announcements', 'announcement_volume', 'play_music',
  'music_volume', 'prevent_edge_scrolling', 'capture_mouse', 'right_mouse_scrolling',
  'adviser_disabled', 'scrolling_momentum', 'twentyfour_hour_clock',
  'warmth_colors_display_default', 'grant_wage_increase', 'movies', 'play_intro',
  'play_demo', 'allow_user_actions_while_paused', 'volume_opens_casebook',
  'alien_dna_only_by_emergency', 'alien_dna_must_stand', 'alien_dna_can_knock_on_doors',
  'disable_fractured_bones_females', 'enable_avg_contents', 'remove_destroyed_rooms',
  'machine_menu_button', 'enable_screen_shake', 'audio_frequency', 'audio_channels',
  'audio_buffer_size', 'theme_hospital_install', 'debug', 'track_fps', 'zoom_speed',
  'scroll_speed', 'shift_scroll_speed', 'new_graphics_folder', 'use_new_graphics',
  'check_for_updates', 'room_information_dialogs', 'allow_blocking_off_areas',
  'direct_zoom', 'new_machine_extra_info', 'player_name',
];

// A minimal in-memory EmFS mock: a single-file store, enough for the config functions
// under test (none of them touch mkdir/mount/syncfs/filesystems).
function makeFS(initial: Record<string, string> = {}): EmFS {
  const files = new Map<string, string>(Object.entries(initial));
  return {
    mkdir() { /* unused */ },
    mount() { /* unused */ },
    syncfs(_populate, cb) { cb(null); },
    writeFile(p, data) { files.set(p, typeof data === 'string' ? data : new TextDecoder().decode(data)); },
    readFile(p) { return files.get(p) ?? ''; },
    // A path "exists" if it's a stored file OR a prefix of one (simulates a directory
    // containing files, matching how populateThData's mkdirDeep + writeFile leaves
    // MOUNT_MUSIC itself analyzable even though only files under it are ever "written").
    analyzePath(p) { return { exists: files.has(p) || [...files.keys()].some((k) => k.startsWith(`${p}/`)) }; },
    filesystems: { IDBFS: {} },
  };
}

// Mirrors config_finder.lua's own "is this key present" scan (config_finder.lua:172):
// `string.find(file_contents, "\n" .. "%s*" .. key .. "%s*=")` — a LITERAL leading
// newline is required, with no start-of-string exception. A key sitting as the literal
// first line of the file (no preceding "\n") counts as "missing" to the real engine and
// would trip needs_rewrite for that key.
function luaWouldFindKey(text: string, key: string): boolean {
  return new RegExp(`\\n\\s*${key}\\s*=`).test(text);
}

test('ensureConfigDefaults seeds every config_finder.lua default key (regression: prevents needs_rewrite from clobbering audio_music)', () => {
  const fs = makeFS();
  // ensureInstallPath always runs immediately before ensureConfigDefaults in the real
  // preRun sequence (buildModuleConfig) — call it here too so this test reflects that
  // real ordering. The line-0 guard (ensureLine0Guard, written unconditionally by both
  // functions) means EVERY tracked key, including theme_hospital_install, now gets a
  // leading "\n" regardless of position — no exclusion needed.
  ensureInstallPath(fs);
  ensureConfigDefaults(fs);
  const text = fs.readFile('/home/web_user/.config/CorsixTH/config.txt', { encoding: 'utf8' });
  const missing = CONFIG_FINDER_DEFAULT_KEYS.filter((k) => !luaWouldFindKey(text, k));
  assert.deepEqual(missing, [], 'every default key (including theme_hospital_install) must be present so config_finder.lua does not rewrite the file');
});

test('line-0 guard: no tracked key ever sits on line 0, regardless of call order', () => {
  // Reverse of the real preRun order (ensureConfigDefaults before ensureInstallPath) —
  // the guard is written unconditionally by BOTH functions, so this must hold even if a
  // future refactor reorders the preRun sequence.
  const fs = makeFS();
  ensureConfigDefaults(fs);
  ensureInstallPath(fs);
  const text = fs.readFile('/home/web_user/.config/CorsixTH/config.txt', { encoding: 'utf8' });
  assert.ok(text.startsWith('-- corsixth-web generated config'), 'line 0 must be the non-tracked guard comment');
  const missing = CONFIG_FINDER_DEFAULT_KEYS.filter((k) => !luaWouldFindKey(text, k));
  assert.deepEqual(missing, [], 'every default key must be present so config_finder.lua does not rewrite the file, regardless of call order');
});

test('line-0 guard is idempotent (no duplicate guard comment across repeated calls)', () => {
  const fs = makeFS();
  ensureInstallPath(fs);
  ensureConfigDefaults(fs);
  ensureInstallPath(fs);
  ensureConfigDefaults(fs);
  const text = fs.readFile('/home/web_user/.config/CorsixTH/config.txt', { encoding: 'utf8' });
  const guardOccurrences = text.split('-- corsixth-web generated config').length - 1;
  assert.equal(guardOccurrences, 1);
});

test('ensureConfigDefaults is idempotent (no duplicate lines on a second call)', () => {
  const fs = makeFS();
  ensureConfigDefaults(fs);
  const once = fs.readFile('/home/web_user/.config/CorsixTH/config.txt', { encoding: 'utf8' });
  ensureConfigDefaults(fs);
  const twice = fs.readFile('/home/web_user/.config/CorsixTH/config.txt', { encoding: 'utf8' });
  assert.equal(twice, once);
});

test('full preRun sequence (install path + defaults + music dir) leaves every default key AND both overrides present', () => {
  const fs = makeFS();
  // Simulate MUSIC/ existing (rendered tracks present) — same shape populateThData leaves.
  fs.writeFile('/th-data/MUSIC/ATLANTIS.OGG', 'fake-ogg-bytes');
  ensureInstallPath(fs);
  ensureConfigDefaults(fs);
  ensureMusicDir(fs);
  const text = fs.readFile('/home/web_user/.config/CorsixTH/config.txt', { encoding: 'utf8' });
  for (const key of CONFIG_FINDER_DEFAULT_KEYS) {
    assert.ok(luaWouldFindKey(text, key), `config_finder.lua would consider "${key}" missing -> needs_rewrite`);
  }
  assert.match(text, /theme_hospital_install\s*=\s*\[\[\/th-data\]\]/);
  assert.match(text, new RegExp(`audio_music\\s*=\\s*\\[\\[${MOUNT_MUSIC.replace('/', '\\/')}\\]\\]`));
});

test('ensureMusicDir does not write an audio_music line when MUSIC/ is absent (no rendered tracks)', () => {
  const fs = makeFS();
  ensureInstallPath(fs);
  ensureConfigDefaults(fs);
  ensureMusicDir(fs);
  const text = fs.readFile('/home/web_user/.config/CorsixTH/config.txt', { encoding: 'utf8' });
  assert.ok(!/audio_music\s*=/.test(text), 'no MUSIC dir -> engine should keep scanning Sound/Midi (audio.lua default), not get a dangling audio_music line');
  // This is exactly the scenario the line-0 guard fixes: before the guard existed,
  // ensureMusicDir's prepend was the ONLY thing pushing theme_hospital_install off line
  // 0, and only fired once MUSIC/ existed. A freshly-ingested profile with no rendered
  // tracks yet (this test's scenario) must still keep every tracked key discoverable.
  const missing = CONFIG_FINDER_DEFAULT_KEYS.filter((k) => !luaWouldFindKey(text, k));
  assert.deepEqual(missing, [], 'every default key must be present even when no music has rendered yet');
});
