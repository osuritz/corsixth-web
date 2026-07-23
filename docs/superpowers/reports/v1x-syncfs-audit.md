# SyncFS Writer Audit (v1.x, Lane C)

## Scope and method

Every persistent file-write site in the engine Lua (`CorsixTH/Lua/**`) was
enumerated and cross-referenced against the existing `TH.SyncEmscriptenFS()`
call sites, to find writers that never flush the Emscripten IDBFS mount to
IndexedDB (M2 flag: "never done").

Method: grep for every `io.open(..., "w"/"wb")` and every
`App:writeToFileOrTmp(...)` call (the shared write-or-fall-back-to-tmp
helper, `app.lua:1100`), then walk forward from each to its matching
`:close()`. Cross-checked completeness by also grepping for every
`:close()` call in the Lua tree and classifying each one (read vs. write).
No write- or close-site was left unclassified.

Baseline (pre-audit) sync call sites, per the lane brief:
`app.lua:418,1093,1199`; `persistance.lua:261`; `config_finder.lua:570,878`;
`world.lua:2145`.

## Audit table

| # | Writer | Path (persistent?) | Synced before audit? | Action |
|---|--------|---------------------|----------------------|--------|
| 1 | `App:initGamelogFile` (`app.lua:414`, via `writeToFileOrTmp`) | `user_log_dir/<ts>-gamelog.txt` (persistent) | Yes — `app.lua:418` | none |
| 2 | `World:dumpGameLog` (`world.lua:2137`, via `writeToFileOrTmp`) | `TheApp.gamelog_path` (persistent) | Yes — `world.lua:2145` | none |
| 3 | `App:saveConfig` (`app.lua:1088`, via `writeToFileOrTmp`) | `config.txt` (persistent) | Yes — `app.lua:1093` | none |
| 4 | `App:saveHotkeys` (`app.lua:1193`, via `writeToFileOrTmp`) | `hotkeys.txt` (persistent) | Yes — `app.lua:1199` | none |
| 5 | `config_finder.lua:567` initial-config write (via `writeToFileOrTmp`) | `config_filename` (persistent) | Yes — `config_finder.lua:570` | none |
| 6 | `config_finder.lua:875` initial-hotkeys write (via `writeToFileOrTmp`) | `hotkeys_filename` (persistent) | Yes — `config_finder.lua:878` | none |
| 7 | `SaveGameFile` (`persistance.lua:258`, via `writeToFileOrTmp`) | save-game file (persistent) | Yes — `persistance.lua:261` | none |
| 8 | `App:dumpStrings` write #1 (`app.lua:851`, `io.open(...,"w")`) | `debug-strings-orig.txt` next to config file (persistent) | **No** | **Fixed** — sync added after `fi:close()` (`app.lua:858`\*) |
| 9 | `App:dumpStrings` write #2 (`app.lua:899`) | `debug-strings-new-lines.txt` (persistent) | **No** | **Fixed** — sync added after `fi:close()` |
| 10 | `App:dumpStrings` write #3 (`app.lua:903`) | `debug-strings-new-grouped.txt` (persistent) | **No** | **Fixed** — sync added after `fi:close()` |
| 11 | `App:checkMissingStringsInLanguage` (`app.lua:974`, called from `dumpStrings`) | `debug-strings-diff-<lang>.txt` (persistent) | **No** | **Fixed** — sync added after `fi:close()` |
| 12 | `Audio:dumpSoundArchive` (`audio.lua:257,268`) | caller-supplied `out_dir` | No | **Not fixed** — see Finding A |
| 13 | `UI:makeScreenshot` -> `video:takeScreenshot` (`ui.lua:1130`) -> `render_target::take_screenshot` (`th_gfx_sdl.cpp:779`) | `TheApp.screenshot_dir` (persistent) | No | **Not fixed** — see Finding B |
| 14 | `App:trimLogs` (`app.lua:433`, `os.remove`, called from `initGamelogFile` right after its sync) | `user_log_dir` (persistent) | No (it's a delete, and it runs *after* #1's sync) | **Not fixed** — see Finding C |

\* Line numbers are pre-fix; see diff in `CorsixTH/Lua/app.lua` for exact
locations after the additive edits.

Every other `io.open`/`:close()` pair in the Lua tree opens in a read mode
(`"r"`, `"rb"`, or the default read mode) and was excluded as out of scope.

## Fixes applied (additive only, mirrors the existing pattern exactly)

`App:dumpStrings()` and its helper `App:checkMissingStringsInLanguage()`
are reachable from live gameplay via the in-game debug menu ("DUMP
STRINGS", gated on `config.debug`, `dialogs/menu.lua:839`) and the
`ingame_poopStrings` hotkey (`game_ui.lua:160`) — not just from the
`--dump=strings` command-line flag. All four of their writes land next to
the user's config file (a persistent, IDBFS-backed path) and had no sync,
so debug-string dumps taken in a browser session could be silently lost on
reload. Added one `TH.SyncEmscriptenFS()` line immediately after each of
the four `fi:close()` calls, exactly matching the existing convention used
at every other writer in the codebase. No other files touched; no
behavior changed on non-Emscripten builds (`TH.SyncEmscriptenFS()` is a
no-op stub there, per `th_lua.cpp`'s existing `#if __EMSCRIPTEN__` /
`#else` split for that binding).

## Findings (documented, not fixed)

**Finding A — `Audio:dumpSoundArchive` is dead code, not a live writer.**
Its only call site in the entire tree is a commented-out debug line inside
`Audio:init()` (`audio.lua:243`,
`--self:dumpSoundArchive[[E:\CPP\2K8\CorsixTH\DataRaw\Sound\]]`). There is
no menu item, hotkey, or command-line flag that reaches it. It's only
invocable at all via the in-game Lua console (itself gated behind
`config.debug`), which grants essentially arbitrary code execution and so
isn't a meaningful "reachability" bar — every Lua function is
Lua-console-reachable by that standard. `out_dir` is also a caller-supplied
argument with no default, so it's not necessarily even a path inside the
IDBFS-persisted directories. No fix applied; recommend deleting this
function in a future cleanup pass if the RE-tooling has no active user.

**Finding B — Screenshot writes finish entirely in C++.**
`UI:makeScreenshot()` (`ui.lua:1118`, bound to hotkey `global_screenshot`
= Ctrl+S) calls `self.app.video:takeScreenshot(filename)`, which is
`l_surface_screenshot` in `th_lua_gfx.cpp:804`, which calls
`render_target::take_screenshot` in `th_gfx_sdl.cpp:779` — a synchronous
C++ function that opens the file and writes PNG data via libpng directly,
with no Lua-side `io.open`/`:close()` anywhere in the path. Per the lane's
"do NOT patch C++" instruction for this writer, this is documented as a
finding rather than fixed: **screenshots taken in the wasm build are not
flushed to IndexedDB and can be lost on reload.** Note for whoever picks
this up: the fix would not require patching C++ at all — a
`TH.SyncEmscriptenFS()` call could be added in Lua at the `ui.lua:1130`
call site, immediately after `takeScreenshot()` returns (the C++ write is
synchronous, so the file is fully written by the time control returns to
Lua). That one-line Lua-only fix was left out of this pass only because
it wasn't explicitly authorized, not because it's technically difficult.

**Finding C — `App:trimLogs()` deletes rotated-out gamelogs after the sync, with no sync of its own.**
`App:initGamelogFile()` writes the new gamelog, closes it, calls
`TH.SyncEmscriptenFS()` (`app.lua:418`), and only *then* calls
`self:trimLogs()` (`app.lua:419`), which `os.remove()`s any gamelog beyond
the 10 most recent (`app.lua:433`). Because trimming happens after the
sync, IndexedDB never learns about the deletions. This is a deletion, not
a "file-WRITE site" in the literal sense this audit's authorization
covered, so no fix was applied — but it means pruned gamelogs can
reappear in `user_log_dir` after a reload (stale-but-harmless storage
bloat, not a correctness/data-loss bug like the other findings).

## Summary

- 7 pre-existing writers audited: all correctly synced, no regressions.
- 4 missed writers found and fixed (all within `App:dumpStrings` /
  `App:checkMissingStringsInLanguage`), additive one-liners only.
- 3 findings documented, not fixed: dead code (A), C++-side write outside
  this lane's authorized patch surface (B), and a post-sync deletion that
  is out of the literal "write site" scope (C).
- Verified via a full incremental wasm rebuild (repackages the Lua data
  blob) and a live boot through `build/serve.sh` + the dev harness: engine
  still prints "Welcome to CorsixTH" with no Lua load/console errors.
