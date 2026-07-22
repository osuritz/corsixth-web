# M0 Spike Report — corsixth-web

## Build attempt
- Date / emsdk image / emcc version:
  - 2026-07-22, `emscripten/emsdk:latest` → `emcc ... 6.0.3 (283e2d130132859fde6a4e4c87fd254b38127651)`
  - 2026-07-22, `emscripten/emsdk:3.1.64` → `emcc ... 3.1.64 (a1fe3902bf73a3802eae0357d273d0e37ea79898)`
- Command: `build/build.sh clean` (flags: `-DWITH_MOVIES=OFF -DWITH_UPDATE_CHECK=OFF -DWITH_LUAJIT=OFF`)
- Outcome: **FAILURE** (both toolchain images tried; neither reaches a link step)
- Artifacts + paths (if success): none. `find build-wasm/ -name 'CorsixTH.js' -o -name 'CorsixTH.wasm' -o -name 'CorsixTH.data'` → empty output in both attempts.
- Errors hit + triage actions taken:

  | Round | Error class (table row) | First error (verbatim) | Action taken | Result |
  |---|---|---|---|---|
  | 1 | Unknown `--use-port` / toolchain-vintage mismatch | `/src/build-wasm/ep_lfs/src/lfs.c:322:2: error: unsupported Lua version` (`#error unsupported Lua version`, guarded by `#if LUA_VERSION_NUM == 501` / `#elif LUA_VERSION_NUM >= 502 && LUA_VERSION_NUM <= 504` / `#else #error ...`) | Retried with `EMSDK_IMAGE=emscripten/emsdk:3.1.64` per table | Different failure surfaced (round 2) — not resolved by image switch |
  | 2 | FetchContent / git clone failure | `fatal: 'DOWNLOAD_EXTRACT_TIMESTAMP' does not appear to be a git repository` / `fatal: Could not read from remote repository.` during the `lpeg-populate` update step, followed by `CMake Error ... FetchContent.cmake:1087: Build step for lpeg failed: 2` | Confirmed Docker network is fine (image pulls and emscripten port downloads succeeded in both rounds); retried once with the identical command | Retry reproduced the **identical** failure — deterministic, not a network flake. Stopped triage here (2 of 3 rounds used; no further table-prescribed action exists for this error class). |

  Root causes identified during triage (diagnosis only, no fix applied — see "Source patches" below):
  - **Round 1**: `CorsixTH/Src/CMakeLists.txt` (`--use-port=contrib.lua`, set in `CorsixTH/CMakeLists.txt:115`) resolves, on `emsdk:latest`, to `https://www.lua.org/ftp/lua-5.5.0.tar.gz` (confirmed via log: `ports:INFO: retrieving port: contrib.lua from ... lua-5.5.0.tar.gz`). The vendored `ep_lfs` (luafilesystem, fetched via `FetchContent` from `github.com/lunarmodules/luafilesystem` @ `09511782...`) only supports `LUA_VERSION_NUM` 501 or 502–504 (`lfs.c:305-324`), so Lua 5.5 (`LUA_VERSION_NUM` 505) trips the `#error`. This is the toolchain-vintage mismatch the plan anticipated: the base branch's WIP PR was authored against an older `emsdk` whose `contrib.lua` port pinned an older Lua release.
  - **Round 2**: `CorsixTH/Src/CMakeLists.txt:15` and `:21` pass `DOWNLOAD_EXTRACT_TIMESTAMP false` to `FetchContent_Declare(... GIT_REPOSITORY ...)` for both `lpeg` and `lfs`. `DOWNLOAD_EXTRACT_TIMESTAMP` is a URL-download-only option introduced in CMake 3.24. `emscripten/emsdk:3.1.64` bundles CMake 3.22 (`/usr/share/cmake-3.22/Modules/FetchContent.cmake` in the error trace), whose argument handling for this keyword combined with `GIT_REPOSITORY` corrupts the generated git "update step" script, so the literal string `DOWNLOAD_EXTRACT_TIMESTAMP` gets passed to `git` as if it were a repository/remote argument. The top-level `CMakeLists.txt:27` only declares `cmake_minimum_required(VERSION 3.14)`, understating the real requirement for this code path.
  - **Evidence the pinned SHAs are still valid** (ruling out the table's other stated cause, "the pinned lpeg/lfs SHA is gone upstream"): in round 1 (`emsdk:latest`, CMake ≥ 3.24), `FetchContent` successfully cloned and populated both `ep_lpeg` and `ep_lfs` — the build got as far as compiling `lpcap.c`, `lpcode.c`, `lpcset.c`, `lpprint.c`, `lptree.c`, `lpvm.c` (from `ep_lpeg`) and `lfs.c` (from `ep_lfs`) before hitting the Lua-version `#error`. So the SHAs are reachable; the round-2 failure is purely a CMake-version/keyword-compatibility issue, not a dead upstream ref.
  - Net finding: the two emsdk images tried are **mutually exclusive failure modes** — the newer image (whose CMake tolerates `DOWNLOAD_EXTRACT_TIMESTAMP` on a git source) breaks on the newer Lua pulled by `contrib.lua`; the older, PR-vintage-closer image (whose `contrib.lua` Lua version was never verified, because configure failed first) breaks on its own bundled CMake's handling of the `DOWNLOAD_EXTRACT_TIMESTAMP` keyword. Neither combination was made to work within the M0 budget.
- Source patches applied during triage: **none.** Both triage rounds identified structural causes (a fetched third-party lib's Lua-version compatibility ceiling; a build-system keyword incompatible with an older bundled CMake) that the task brief's table explicitly scopes as "record, don't fix in M0" (row: C++ compile error — "anything structural: record, don't fix") or offers no patch action for (row: FetchContent failure — only "confirm network / retry once / record if SHA gone"). No engine source or CMakeLists.txt was modified.

### Other notes
- Docker/OrbStack was not running at the start of this task (`docker.sock` missing); it was started (`open -a OrbStack`) before any build attempt — recorded here since it's an environment fact, not a build error.
- `emscripten/emsdk:3.1.64` is an `linux/amd64` image; on this Apple Silicon (arm64) host, Docker printed: `WARNING: The requested image's platform (linux/amd64) does not match the detected host platform (linux/arm64/v8) and no specific platform was requested`. It ran under emulation (not native arm64) rather than failing, but this is worth noting as a possible source of slowness for any future attempts with this image.
- `.gitignore` line 33 (`/build*/`) matches both `/build/` and `/build-wasm/`, so `build/build.sh` is ignored by default. `git add -f` was required to track it (see Files changed). This is a pre-existing repo condition, not something introduced by this task.

## Extended triage (Task 1.5)

Goal: find a working `emsdk` + CMake + engine-pin combo between Task 1's two mutually-exclusive failures, with minimal, bounded probes (max 4 rounds, STOP at first success).

### Rounds table

| Round | Combo | Result | Error (verbatim) / Notes |
|---|---|---|---|
| A | `emsdk:3.1.64` + CMake upgraded in-container via `pip3 install "cmake>=3.24,<4"` (installed 3.31.10) | Configure PASSED; compile FAILED — **new** error, not Task 1's Lua-version `#error` | `em++: error: error with `--use-port=contrib.lua` \| invalid port name: `contrib.lua`` (repeated per translation unit); `gmake: *** [Makefile:136: all] Error 2` |
| B (triage of A's new error) | — | Root cause identified; no build-tooling one-liner fix possible → recorded, moved to C | Confirmed via `docker run --rm emscripten/emsdk:3.1.64 bash -c "ls .../tools/ports/ ...; ls .../tools/ports/contrib"`: emcc 3.1.64's ports tree has no `lua.py` anywhere (main ports list or `contrib/`) — the `contrib.lua` port itself was added to Emscripten at some version after 3.1.64. This is a harder version-skew than Round C's stated trigger ("resolves to Lua >5.4") — 3.1.64 doesn't resolve the port to *any* Lua version, it doesn't recognize the port name at all. Judged to be the same failure family (contrib.lua/toolchain-vintage mismatch) and not fixable via a build-tooling one-liner (the port is compiled into `emcc` itself), so per Round B's "otherwise record and move to C" this was treated as satisfying the move to Round C. Flagging this divergence from the literal trigger text explicitly rather than silently reinterpreting it. |
| C | `emsdk:latest` (emcc 6.0.3, bundled CMake 3.28.3 — no shim needed) + bumped `luafilesystem` `GIT_TAG` in `CorsixTH/Src/CMakeLists.txt` (line with the `lfs` `FetchContent_Declare`) from `0951178...` to upstream master HEAD `a186cca5833691e830ed255e38ace8ff6b870dbf` (= tag `v1_9_0`) | **SUCCESS** — configure passed, compile passed, link passed, exit 0, 3 artifacts produced | See "Winning combo" below |
| D | Not needed (stopped at first success per instructions) | — | — |

### Evidence gate for Round C (upstream luafilesystem Lua 5.5 support)

- Checked via `WebFetch` of `github.com/lunarmodules/luafilesystem` (`blob/master/src/lfs.c` and `commits/master`) before touching engine source, per the brief's evidence requirement.
- Current pinned commit `0951178...` (full: `09511782201302ade916d4b250d01a6c61b56844`) is the commit *immediately before* `31dcb88 "Support Lua 5.5 (#180)"` (merged, per GitHub, as part of "Release 1.9.0", Dec 28 2025).
- `git ls-remote https://github.com/lunarmodules/luafilesystem.git HEAD refs/heads/master 'refs/tags/*'` confirmed: `master` HEAD == `a186cca5833691e830ed255e38ace8ff6b870dbf` == tag `v1_9_0`.
- WebFetch of `lfs.c` on master confirmed the version-guard block now spans `LUA_VERSION_NUM` 501 and 502–505 (was 501 and 502–504 at the old pin), with the `#error unsupported Lua version` only tripping outside that range — i.e. 505 (Lua 5.5, what `contrib.lua` resolves to on `emsdk:latest`) is now accepted.
- Conclusion: evidence supported the bump; applied it (the single authorized engine-tree line).

### Winning combo

- Image: `emscripten/emsdk:latest` → `emcc ... 6.0.3 (283e2d130132859fde6a4e4c87fd254b38127651)`
- CMake: bundled `3.28.3` (already ≥ 3.24 — no pip shim needed; the Round-A shim was written, proven to work on `3.1.64`, then **removed** from the final `build/build.sh` per the brief's "keep the shim only if the winning image needs it")
- Engine-tree change: `CorsixTH/Src/CMakeLists.txt` — `lfs` `FetchContent_Declare`'s `GIT_TAG` bumped `09511782201302ade916d4b250d01a6c61b56844` → `a186cca5833691e830ed255e38ace8ff6b870dbf`
- Command: `build/build.sh clean` (no `EMSDK_IMAGE` override needed — `latest` is already the script default) → **exit 0**
- Artifacts (`build-wasm/CorsixTH/`):
  - `corsix-th.js` — 268,908 bytes
  - `corsix-th.wasm` — 3,462,912 bytes
  - `corsix-th.data` — 15,484,956 bytes

  Note: actual output basename is `corsix-th` (lowercase-hyphenated), not `CorsixTH` — set explicitly at `CorsixTH/CMakeLists.txt:91` (`set_target_properties(CorsixTH PROPERTIES OUTPUT_NAME corsix-th)`), a pre-existing engine-source line not touched by this task. The brief's success criterion and `build/build.sh`'s original `find` both assumed `CorsixTH.js/.wasm/.data`; this was a naming assumption that didn't hold. `build/build.sh`'s `find` pattern was corrected (build-tooling change, within authorization) to match the real names; the CMake `OUTPUT_NAME` itself was left untouched.

### build/build.sh final state

- `EMSDK_IMAGE` override pattern preserved (`IMAGE="${EMSDK_IMAGE:-emscripten/emsdk:latest}"`), now pointing at the winning combo by default.
- CMake-upgrade shim from Round A removed (not needed for the winning image); a harmless `--- cmake: ...` version-echo line was kept for diagnostics.
- `find` pattern fixed to the real artifact basename (`corsix-th.*`, case-insensitive).
- Re-ran the finalized script once more end-to-end (`build/build.sh clean`, no image override) to confirm the *committed* script version reproduces the exit-0 result — confirmed.

## Boot attempt

- Harness: `web/dev/index.html` (verbatim per Task 2 brief) + `build/serve.sh` (verbatim per Task 2 brief), serving `build-wasm/CorsixTH/` (the winning Task 1.5 artifacts) at `http://localhost:8123/`.
- Confirmed via source inspection before boot: the WASM link flags (`CorsixTH/CMakeLists.txt:113-131`) include `-sMODULARIZE` with no `-sEXPORT_NAME` override, and `corsix-th.js` itself shows `var Module=(()=>{...return async function(moduleArg={})...})()` — the factory global is `Module`, exactly matching the harness. No harness/artifact-mismatch retry was needed.
- Server: `python3 -m http.server 8123` via `build/serve.sh`. Confirmed via `curl -I`: `corsix-th.js` → 200 (268,908 B, `text/javascript`), `corsix-th.wasm` → 200 (3,462,912 B, `application/wasm`), `corsix-th.data` → 200 (15,484,956 B, `application/octet-stream`) — all three sizes match the Task 1.5 build output exactly.
- Browser: Chrome via `chrome-devtools-mcp`, navigated to `http://localhost:8123/`, observed for ~25s post-load (no change in console after the first ~1s — the engine exits almost immediately; see below).
- Network tab (DevTools): same 3 artifacts at HTTP 200 with identical byte counts confirmed via `get_network_request` (`corsix-th.data` content-length 15,484,956; `corsix-th.wasm` content-length 3,462,912, `content-type: application/wasm`); only other request was `favicon.ico` → 404 (irrelevant browser chrome request, not an engine asset).
- Console output (verbatim, in order):
  1. `[error] Failed to load resource: the server responded with a status of 404 (File not found)` — the `favicon.ico` request above; unrelated to the engine.
  2. `[warn] [stderr] CorsixTH cannot find CorsixTH.lua. If you want use a custom location, specify it by --interpreter=FILE`
  3. `[log] [harness] module instantiated` — the `Module({...})` promise **resolved** (no `.catch`), i.e. no JS exception was thrown; the engine's native `exit(1)` (see below) unwound cleanly through Emscripten's `-sEXIT_RUNTIME`.
  No further messages appeared in ~25s of observation — a single clean native exit, not a crash loop.
- Screenshot: `docs/superpowers/reports/m0-boot.png` — solid black canvas (matches the harness's `#111` body background). Confirmed via `evaluate_script` that `#canvas` still has its un-initialized default bitmap size (`300×150`), i.e. SDL video/window setup was never reached — consistent with the engine exiting during Lua-interpreter bootstrap, before any SDL calls.

### Root-cause analysis (source-level only — no code changed, per binding constraint)

Traced why `CorsixTH.lua` isn't found, since the `.data` preload package does contain it:
- `CorsixTH/CMakeLists.txt:132-143` (the `EMSCRIPTEN` branch): globs `CorsixTH.lua`, `Lua/*.lua`, `Bitmap/*`, `Campaigns/*`, `Levels/*` and preloads each via `--preload-file "<file>@/corsixth/<relative_file>"`. The engine's own bootstrap script is bundled, at virtual path `/corsixth/CorsixTH.lua`.
- `CorsixTH/Src/main.cpp`, `search_script_file()` (lines 65-129) checks, in order: (1) a `--interpreter=` CLI arg — not passed by our harness/Module config; (2) a hardcoded local-dir list (`./`, `CorsixTH/`, `Contents/Resources/`, `../Resources/`, `../share/corsix-th/`, lines 77-124) — but this whole block is gated by `#ifdef CORSIX_TH_SEARCH_LOCAL_DATADIRS`, and top-level `CMakeLists.txt:88-92` defaults `SEARCH_LOCAL_DATADIRS` to `OFF` for every non-Apple platform (including `EMSCRIPTEN`), so this block is not even compiled into our build; (3) `CORSIX_TH_INTERPRETER_PATH` (lines 127-129), a compile-time constant. `CorsixTH/CMakeLists.txt:20-31` sets this per-platform (`USE_SOURCE_DATADIRS` / `MSVC` / `APPLE` / generic `else()`) but has **no `elseif(EMSCRIPTEN)` branch**, so it falls through to the generic Unix `else()` (line 29-31), yielding `${CMAKE_INSTALL_FULL_DATADIR}/corsix-th/CorsixTH.lua` — a host-filesystem install path (e.g. `/usr/local/share/corsix-th/CorsixTH.lua`) with no relation to the browser sandbox's actual virtual-FS mount point (`/corsixth/CorsixTH.lua`).
- Net effect: none of `search_script_file()`'s 3 candidate paths can ever resolve to `/corsixth/CorsixTH.lua`, **regardless of whether Theme Hospital game data is supplied**. This is a WASM-porting gap in the engine's own CMake (missing an `EMSCRIPTEN` case for `CORSIX_TH_INTERPRETER_PATH`), not evidence of "missing TH game data" per se — the printed message is real engine/Lua-VM code executing and failing at a bootstrap step that happens to precede any TH-data check.

Checked against the brief's Step 4 table: this does **not** match row 1 (row 1 requires the engine to *reach* TH-data-missing handling — a directory-browser UI, or a Lua error / console message about the missing `theme_hospital_install` or TH data files). The root-cause trace above shows the opposite: `exit(1)` happens while the engine is still resolving its own bundled interpreter script (`search_script_file()` failing to find `CorsixTH.lua`), a step that runs *before* any TH-data logic is reached, and that would fail identically even if a user supplied TH game data. There is no JS exception and all three artifacts loaded correctly — but the engine never got past its own bootstrap to the point the table's row 1 describes.

## Verdict

**B — YELLOW:** builds (via the Task 1.5 toolchain fix: `emsdk:latest`/emcc 6.0.3 + `luafilesystem` `GIT_TAG` bump to `v1_9_0`); `Module` instantiated cleanly (no JS exception — the promise resolved via `.then()`, never hit `.catch()`); all 3 artifacts (`corsix-th.js`/`.wasm`/`.data`) loaded at HTTP 200 with byte counts matching the Task 1.5 build exactly; real engine/Lua-VM code executed (`lua_main_no_eval` → `search_script_file()`). But boot fails **before** the engine reaches any TH-data-missing handling — it exits(1) while still failing to resolve its own bundled `CorsixTH.lua` interpreter script. Per the brief's matrix, M1 Task 3 (reproducible build) still proceeds; this boot-blocker becomes the top M1 fix item.

Blocker (verbatim + file:line trace, no fix applied — no engine-source changes in this task):
- Console (verbatim): `[stderr] CorsixTH cannot find CorsixTH.lua. If you want use a custom location, specify it by --interpreter=FILE`
- `CorsixTH/Src/main.cpp:170-176`: `search_script_file()` returns an empty path → `std::fprintf(stderr, ...)` → `exit(1)`.
- `CorsixTH/Src/main.cpp:65-129` (`search_script_file`): checks, in order: (1) a `--interpreter=` CLI arg (not passed by our harness), (2) a hardcoded local-dir list gated by `#ifdef CORSIX_TH_SEARCH_LOCAL_DATADIRS` — compiled out entirely, since `SEARCH_LOCAL_DATADIRS` defaults `OFF` for every non-Apple platform (top-level `CMakeLists.txt:88-92`), (3) `CORSIX_TH_INTERPRETER_PATH` (lines 127-129), a compile-time constant.
- `CorsixTH/CMakeLists.txt:20-31`: sets `CORSIX_TH_INTERPRETER_PATH` per platform (`USE_SOURCE_DATADIRS` / `MSVC` / `APPLE` / generic `else()`) — **no `elseif(EMSCRIPTEN)` branch exists**, so it falls through to the generic Unix `else()` (lines 29-31), yielding `${CMAKE_INSTALL_FULL_DATADIR}/corsix-th/CorsixTH.lua`, a host-filesystem install path with no meaning inside the browser sandbox.
- `CorsixTH/CMakeLists.txt:132-143`: the actual preloaded location, set up by this same build, is `/corsixth/CorsixTH.lua` (via `--preload-file "<file>@/corsixth/<relative_file>"` over `CorsixTH.lua`, `Lua/*.lua`, `Bitmap/*`, `Campaigns/*`, `Levels/*`) — a path none of `search_script_file()`'s 3 candidates ever check.

Top M1 fix item: add an `elseif(EMSCRIPTEN)` branch in `CorsixTH/CMakeLists.txt:20-31` setting `CORSIX_TH_INTERPRETER_PATH` (and/or `CORSIX_TH_DATADIR`) to `/corsixth/CorsixTH.lua`, so the engine can locate its own bundled interpreter and progress to actual Theme-Hospital-data-missing logic. Until this lands, boot cannot progress further **regardless of TH game data availability**.
