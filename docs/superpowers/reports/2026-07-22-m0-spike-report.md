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

## Post-M0 addendum: interpreter-path fix (Task 2.5)

**Authorized by:** controller (EP), plan amendment converting the row-1 boot-blocker above into a fix now, ahead of M1 hardening.

### The change

`CorsixTH/CMakeLists.txt:20-31` — added an `elseif(EMSCRIPTEN)` branch, placed before the generic `else()`, mirroring the sibling branches' two-variable pattern (each of `USE_SOURCE_DATADIRS` / `MSVC` / `APPLE` / generic-`else` sets both `CORSIX_TH_DATADIR` and `CORSIX_TH_INTERPRETER_PATH`, using `${CORSIX_TH_INTERPRETER_NAME}` rather than a hardcoded literal, no `CACHE`/type args since no sibling uses them):

```cmake
elseif(EMSCRIPTEN)
  # Engine Lua files are preloaded into the wasm virtual FS at /corsixth/
  set(CORSIX_TH_DATADIR /corsixth)
  set(CORSIX_TH_INTERPRETER_PATH ${CORSIX_TH_DATADIR}/${CORSIX_TH_INTERPRETER_NAME})
```

Deviation from the brief's literal 2-line illustrative snippet, discovered empirically: the brief's snippet set only `CORSIX_TH_INTERPRETER_PATH`. A first attempt matching that literally left `CORSIX_TH_DATADIR` unset for `EMSCRIPTEN`, which broke `cmake` **configure** itself — `CORSIX_TH_DATADIR` is referenced unconditionally later in three `install()` calls (`CorsixTH/CMakeLists.txt:349-353`, e.g. `install(DIRECTORY Campaigns Lua Levels DESTINATION ${CORSIX_TH_DATADIR})`), and CMake errors on an empty-string `DESTINATION` regardless of whether the install step is ever invoked. Setting `CORSIX_TH_DATADIR` too — exactly as every sibling branch already does — is a completion of the same single authorized branch, not a second edit site; no other line/branch/file was touched.

### Rebuild result

`build/build.sh` (no `clean`, incremental — CMake reconfigured automatically): **exit 0** on the first attempt after the fix (a prior attempt, before adding the `CORSIX_TH_DATADIR` line, failed at configure with `CMake Error ... install DIRECTORY given no DESTINATION!`, as described above). Artifacts refreshed at `build-wasm/CorsixTH/`:
- `corsix-th.js` — 268,908 bytes
- `corsix-th.wasm` — 3,462,886 bytes
- `corsix-th.data` — 15,484,956 bytes

### Boot re-test

Same flow as the M0 boot attempt: `build/serve.sh` (port 8123) + `web/dev/index.html` harness + Chrome DevTools MCP, observed ~15s post-load with no further console change after the initial burst (stable end state).

Network requests (all HTTP 200): `index.html`, `corsix-th.js`, `corsix-th.data`, `corsix-th.wasm`.

Console output (verbatim, in order):
1. `[warn] [stderr] An error has occurred in CorsixTH:`
2. `[warn] [stderr] /corsixth/CorsixTH.lua:79: Please recompile CorsixTH and link against Lua version 5.1, 5.2, 5.3 or 5.4`
3. `[warn] [stderr] stack traceback:`
4. `[warn] [stderr] 	[C]: in global 'error'`
5. `[warn] [stderr] 	/corsixth/CorsixTH.lua:79: in main chunk`
6. `[warn] [stderr] 	[C]: in ?`
7. `[warn] [stderr] Aborted(TypeError: _asyncify_start_unwind is not a function)`
8. `[error] [harness] instantiation failed RuntimeError: Aborted(TypeError: _asyncify_start_unwind is not a function). Build with -sASSERTIONS for more info.`

Screenshot: `docs/superpowers/reports/m0-boot-fixed.png` — no longer a solid black canvas (contrast with `m0-boot.png`). Shows the engine's own bootstrap error-report UI rendered on-canvas: white bitmap-font text reading "An error has occurred in CorsixTH:", the Lua-version message, a 3-line stack traceback, and a red "Exit" button — i.e. `bootstrap_lua_error_report` (`CorsixTH/Src/bootstrap.cpp`) ran a full Lua + font + palette + sheet render cycle inside the wasm sandbox before the runtime aborted.

### Root-cause trace (source-level only, no further engine edits — not authorized this task)

- **Confirms the fix worked**: `search_script_file()` now resolves `/corsixth/CorsixTH.lua` and the engine's own bootstrap Lua script executes (console messages 2/5 show `/corsixth/CorsixTH.lua:79`, not the old "cannot find CorsixTH.lua" message from the base M0 report). This is real progress past the row-1 blocker this task set out to fix.
- **New blocker 1 (primary)**: `CorsixTH/CorsixTH.lua:76-79` — `local support = list_to_set({"Lua 5.1", "Lua 5.2", "Lua 5.3", "Lua 5.4"}); if not support[_VERSION] then error "Please recompile CorsixTH and link against Lua version 5.1, 5.2, 5.3 or 5.4" end`. Per the base M0 report's Task 1.5 section, `CorsixTH/CMakeLists.txt`'s `--use-port=contrib.lua` resolves, on `emsdk:latest`, to Lua 5.5 (`lua-5.5.0.tar.gz`). The `luafilesystem` version guard was already bumped in Task 1.5 to accept 5.5, but this separate, engine-level version allowlist in `CorsixTH.lua` itself was not — it still only accepts 5.1-5.4, so it rejects the linked 5.5 runtime and calls `error(...)`, which is exactly the message reported.
- **New blocker 2 (secondary, uncovered only because blocker 1's error-reporting path was reached)**: `Aborted(TypeError: _asyncify_start_unwind is not a function)`. The bootstrap error screen's single static frame renders successfully (confirmed by the screenshot), but it then calls `SDL.mainloop(coroutine.create(...))` (`CorsixTH/Src/bootstrap.cpp:82`) → `l_mainloop` (`CorsixTH/Src/sdl_core.cpp:134`), which blocks in a `while (SDL_WaitEvent(&e) != 0)` loop. Under Emscripten this blocking wait needs Asyncify to yield to the browser event loop; the JS glue calls an Asyncify runtime function (`_asyncify_start_unwind`) that is apparently not present/exported despite `-sASYNCIFY` being linked (`CorsixTH/CMakeLists.txt`, EMSCRIPTEN link flags). Root cause not fully diagnosed beyond this call-site trace (Asyncify import/allow-list configuration was not investigated further — out of scope for a "cheaply traceable" check, and no engine/build edits are authorized here). Because `SDL.mainloop`/`l_mainloop` is the same binding used by the normal game loop (not just the bootstrap error UI), this blocker is likely to recur on the happy path too, once blocker 1 is fixed — flagging for M1 planning.

### Classification

**PROGRESS with new blocker(s)** — not BOOT SUCCESS. The engine did not reach TH-data-related behavior (no missing-data message, config creation, or directory-browser UI); it hit an internal Lua-version compatibility guard (a build-toolchain/engine-source mismatch unrelated to TH game data), then a secondary Asyncify runtime abort while trying to render the resulting error screen interactively. Per the brief's Step 4 criteria, this is squarely the "hits a NEW blocker" case: console output recorded verbatim above, file:line root causes traced where cheaply possible, no further fix applied.

### Next blocker(s) for follow-up (not fixed in this task)

1. `CorsixTH/CorsixTH.lua:79` Lua-version allowlist (5.1-5.4) vs. the Lua 5.5 pulled by the `contrib.lua` Emscripten port on `emsdk:latest` — needs a source-level decision (widen the engine's allowlist vs. pin the Emscripten Lua port to an older release) outside this task's authorization.
2. `Aborted(TypeError: _asyncify_start_unwind is not a function)` surfacing from `l_mainloop`'s (`CorsixTH/Src/sdl_core.cpp:134`) blocking `SDL_WaitEvent` loop under Emscripten/Asyncify — needs investigation into the Asyncify build configuration; likely blocks any interactive frame loop, not only the bootstrap error screen.

## Post-M0 addendum 2: Lua 5.4 alignment (Task 2.6)

**Authorized by:** controller (EP), plan amendment. New blocker 1 above (`CorsixTH.lua:79` rejects Lua 5.5) is resolved by pinning the *build* to Lua 5.4 — upstream's own supported matrix — rather than widening the engine's version guard to accept 5.5, an interpreter upstream never tested. Engine-tree changes confined to the two CMake files' `EMSCRIPTEN` blocks; no engine C++/Lua source edits.

### Round taken

**Round A (probed, no option found):** `docker run --rm emscripten/emsdk:latest bash -c "emcc --use-port=contrib.lua:help /dev/null 2>&1"` → `No options.`. Read the port source directly (`/emsdk/upstream/emscripten/tools/ports/contrib/lua.py` inside the image): `TAG = '5.5.0'` is hardcoded with no version parameter exposed to `get()`/`create()`. Confirms the port cannot be pinned via a flag — moved to Round B.

**Round B (applied):** Replaced the port with `FetchContent`-built Lua 5.4.8, mirroring the existing lpeg/lfs pattern in `CorsixTH/Src/CMakeLists.txt` exactly. Verified `v5.4.8` is a real upstream tag (`github.com/lua/lua/tags`, released 2025-05-21; newest v5.4.x) before using it.

### Exact change

- `CorsixTH/CMakeLists.txt` (EMSCRIPTEN `USE_FLAGS` block, ~line 119): removed the `--use-port=contrib.lua \` line. No other USE_FLAGS line touched.
- `CorsixTH/Src/CMakeLists.txt` (EMSCRIPTEN block, top of file): added `FetchContent_Declare(lua54 GIT_REPOSITORY https://github.com/lua/lua.git GIT_TAG v5.4.8 SOURCE_DIR ${CMAKE_BINARY_DIR}/ep_lua54 DOWNLOAD_EXTRACT_TIMESTAMP false)` + `FetchContent_MakeAvailable(lua54)`, then `file(GLOB LUA54_SRC_FILES ${lua54_SOURCE_DIR}/*.c)` filtered with `list(FILTER LUA54_SRC_FILES EXCLUDE REGEX "(lua|luac|onelua)\\.c$")` (drops the three files with a `main()`/standalone entrypoint, matching how the upstream port's own `srcs` list omits them) and `file(GLOB LUA54_HRC_FILES ${lua54_SOURCE_DIR}/*.h)`. Added `target_include_directories(CorsixTH_lib PUBLIC ${lua54_SOURCE_DIR})` so `th_lua.cpp` and friends (outside the FetchContent tree, unlike lpeg/lfs's own sources) can find `lua.h`/`lauxlib.h`/`lualib.h` — previously supplied automatically by the port's system-include injection. `${LUA54_SRC_FILES}`/`${LUA54_HRC_FILES}` appended to the same `target_sources(CorsixTH_lib ...)` lists lpeg/lfs already land in.

### Build result

`build/build.sh clean` (required — toolchain-level change): **exit 0**, first attempt, no iteration needed. Toolchain unchanged (`emcc` 6.0.3, `cmake` 3.28.3 — same as prior tasks). Build log shows `ep_lua54/*.c` objects compiling (`lapi.c` … `lzio.c`, `ltests.c` included per the brief's exact exclude-regex — its content is inert without the debug macros that would activate it, and the link succeeded with no duplicate-symbol errors), immediately after the `ep_lpeg`/`ep_lfs` objects — confirming lpeg/lfs compiled against the same FetchContent'd Lua 5.4 headers. No `--use-port=contrib.lua` occurrence remained in the CMake-emitted compiler/linker command lines. Artifacts refreshed at `build-wasm/CorsixTH/`: `corsix-th.js`, `corsix-th.wasm`, `corsix-th.data` (all present, `find` in `build.sh`'s own artifact check confirmed all three).

### Lua version confirmation

No live `_VERSION` console print was available (the runtime aborts — see below — before any point that would print it, and adding one would be an unauthorized engine-source edit). Instead confirmed via the compiled binary: `strings build-wasm/CorsixTH/corsix-th.wasm | grep -E "^Lua 5\.[0-9]"` → **`Lua 5.4`** only (no `5.5` string present). This is Lua's own `LUA_VERSION`/`_VERSION` literal, embedded verbatim in `lstate.c`/`lauxlib.c`, baked into the binary at compile time from the FetchContent'd v5.4.8 sources.

### Boot re-test

Same flow as Task 2.5: `build/build.sh clean` → `build/serve.sh` (port 8123) → Chrome DevTools MCP `new_page` on `http://localhost:8123/index.html`, waited ~30s, reloaded (`ignoreCache`), waited another ~30s, then read console.

Network requests (all HTTP 200 except a harmless browser-initiated `favicon.ico` 404): `index.html`, `corsix-th.js`, `corsix-th.data`, `corsix-th.wasm`.

Console output (verbatim, all 3 messages, in order):
1. `[error] Failed to load resource: the server responded with a status of 404 (File not found)` — `favicon.ico`, unrelated to the boot path.
2. `[warn] [stderr] Aborted(TypeError: _asyncify_start_unwind is not a function)`
3. `[error] [harness] instantiation failed RuntimeError: Aborted(TypeError: _asyncify_start_unwind is not a function). Build with -sASSERTIONS for more info.`

Critically: **the `CorsixTH.lua:79` Lua-version guard message is gone.** No `An error has occurred in CorsixTH:` bootstrap error-report text, no stack traceback, no "Please recompile ... link against Lua version 5.1, 5.2, 5.3 or 5.4" — all present verbatim in Task 2.5's addendum, all absent here. The guard passed cleanly under Lua 5.4.8; the engine's own bootstrap Lua script executed and got further before hitting a different wall.

Screenshot: `docs/superpowers/reports/m0-boot-lua54.png` — a solid black canvas (viewport). This matches Task 2.5's *pre-fix* `m0-boot.png` state (before the bootstrap error-report UI had a chance to render), not the *post-fix* `m0-boot-fixed.png` state (which showed the rendered error screen) — consistent with the abort happening earlier this time, before the bootstrap error-report's own render/mainloop cycle got a frame on-canvas.

### Classification

**Not BOOT SUCCESS.** No TH-data-related behavior was reached (no missing-data message, config creation, or directory-browser UI). The Lua-version guard genuinely passed — a real, verified fix — but the very next thing the normal boot path hits is Blocker #2 from Task 2.5 (`Aborted(TypeError: _asyncify_start_unwind is not a function)`), now confirmed (per that task's note that this determination was mine to make) to also afflict the **normal boot path**, not only the bootstrap error-screen path. This is the same Asyncify runtime issue already flagged as Task 2.5's "next blocker 2" — it was already going to need its own fix regardless of the Lua-version outcome, and this task's re-test confirms it sits immediately behind the now-cleared Lua guard.

### Next blocker for follow-up (not fixed in this task)

`Aborted(TypeError: _asyncify_start_unwind is not a function)` — the sole remaining item between current state and further boot progress. Per Task 2.5's trace, this originates in `SDL.mainloop`/`l_mainloop` (`CorsixTH/Src/sdl_core.cpp:134`)'s blocking `SDL_WaitEvent` loop needing Asyncify to yield to the browser event loop; `-sASYNCIFY` is linked (`CorsixTH/CMakeLists.txt`) but the expected `_asyncify_start_unwind` export/import appears missing or misconfigured. Needs Asyncify build-configuration investigation (e.g. `ASYNCIFY_IMPORTS`/`ASYNCIFY_ONLY` allow-listing, or an emscripten-version-specific Asyncify API change) — out of this task's scope.

## Post-M0 addendum 3: Asyncify fix (Task 2.7)

The last boot blocker from addendum 2 — `Aborted(TypeError: _asyncify_start_unwind is not a function)` — is fixed. The engine now boots into its real SDL main loop and renders its interactive graphical UI.

### Root cause (evidenced)

`-sASYNCIFY` **did** reach the final link command — disproving the "flag mangled before the linker" hypothesis. Extracted from the generated `build-wasm/CorsixTH/CMakeFiles/CorsixTH.dir/link.txt` (tokens 54-55):

```
-sASYNCIFY
-sASYNCIFY_STACK_SIZE=32768
```

The JS glue (`corsix-th.js`) references the Asyncify runtime (`asyncify_start_unwind`/`_stop_unwind`/`_start_rewind`/`_stop_rewind` wrappers — on the current post-fix artifact `grep -o 'Asyncify' build-wasm/CorsixTH/corsix-th.js | wc -l` → **57**, and case-insensitive `grep -o -i 'asyncify' … | wc -l` → **71**), yet in the failing (pre-fix, `-sEXPORT_ALL`) build the wasm binary carried no asyncify machinery — so the JS wrapper's call to `wasmExports.asyncify_start_unwind` resolved to `undefined` at runtime → the TypeError. The asyncify JS runtime is emitted regardless of the bug; the defect was purely wasm-side, which is why those same JS-side references persist unchanged in the fixed build.

The culprit was isolated with a minimal `emscripten_sleep()` repro (emcc 6.0.3, in-container, scratch dir), first by additive/subtractive flag bisection and then confirmed **functionally** by running each variant in node:

| variant (all with `-sASYNCIFY`) | runtime result |
|---|---|
| `-Os -sMODULARIZE ...full flag set... -sEXPORT_ALL` | `before sleep` then **`Aborted(TypeError: _asyncify_start_unwind is not a function)`** — exact match to the CorsixTH failure |
| same set **without** `-sEXPORT_ALL` | `before sleep` → `module resolved OK` → `after sleep` — works |
| minimal trigger `-sASYNCIFY -Os -sMODULARIZE -sEXPORT_ALL` | reproduces the abort |

Mechanism: at `-Os` emscripten minifies wasm import/export names (and rewrites the JS glue to match). `-sEXPORT_ALL` force-exports every symbol under its **full** name, which breaks that minification's consistency, so the Asyncify runtime exports the JS glue expects (`asyncify_start_unwind`, ...) are no longer reachable — hence "is not a function" the instant `SDL.mainloop` (`l_mainloop`, `CorsixTH/Src/sdl_core.cpp:134`) tries to unwind out of its blocking `SDL_WaitEvent`. This is precisely the "EXPORT_ALL + MODULARIZE glue minification renaming/omitting asyncify exports" known-suspect from the task lead. (Note: a plain `strings corsix-th.wasm | grep asyncify` is a *false-negative* discriminator here — at `-Os` the export names are minified out of the binary even in a working build; only the functional run in node is authoritative.)

### Verbatim repro evidence

Reproduced in `emscripten/emsdk:latest`. Source `t.c`: `int main(){ printf("before sleep\n"); emscripten_sleep(100); printf("after sleep\n"); return 0; }`. `harness.js`: loads the MODULARIZE factory and logs `HARNESS: module resolved OK` on resolve, `HARNESS: caught <msg>` on reject. Both variants are run in node, so they omit only `-sENVIRONMENT=web` from the CorsixTH link set — that flag selects the JS environment target and is orthogonal to the EXPORT_ALL/asyncify interaction (the browser boot under the full flag set, below, exhibits the identical failure/fix). The two `emcc` command lines are the full CorsixTH linker flag list, unelided, differing only by the trailing `-sEXPORT_ALL`:

```text
emcc (Emscripten gcc/clang-like replacement + linker emulating GNU ld) 6.0.3 (283e2d130132859fde6a4e4c87fd254b38127651)

############ VARIANT A (FAILING): with -sEXPORT_ALL ############
$ emcc t.c -o A.js -sASYNCIFY -Os -sALLOW_MEMORY_GROWTH -sINITIAL_MEMORY=128mb -sMEMORY_GROWTH_LINEAR_STEP=32mb -sMODULARIZE -sCASE_INSENSITIVE_FS=1 -lidbfs.js -lwebsocket.js -sEXPORTED_RUNTIME_METHODS=callMain,addRunDependency,removeRunDependency -sEXIT_RUNTIME -sNO_DISABLE_EXCEPTION_CATCHING -sASYNCIFY_STACK_SIZE=32768 -sEXPORT_ALL
$ node harness.js ./A.js
before sleep
Aborted(TypeError: _asyncify_start_unwind is not a function)
HARNESS: caught Aborted(TypeError: _asyncify_start_unwind is not a function). Build with -sASSERTIONS for more info.

############ VARIANT B (PASSING): without -sEXPORT_ALL ############
$ emcc t.c -o B.js -sASYNCIFY -Os -sALLOW_MEMORY_GROWTH -sINITIAL_MEMORY=128mb -sMEMORY_GROWTH_LINEAR_STEP=32mb -sMODULARIZE -sCASE_INSENSITIVE_FS=1 -lidbfs.js -lwebsocket.js -sEXPORTED_RUNTIME_METHODS=callMain,addRunDependency,removeRunDependency -sEXIT_RUNTIME -sNO_DISABLE_EXCEPTION_CATCHING -sASYNCIFY_STACK_SIZE=32768
$ node harness.js ./B.js
before sleep
HARNESS: module resolved OK
after sleep
```

Post-fix CorsixTH artifact evidence (run from repo root after `build/build.sh`; commands shown so numbers are reproducible):

```text
$ grep -o -- '-sASYNCIFY[A-Za-z_=0-9]*' build-wasm/CorsixTH/CMakeFiles/CorsixTH.dir/link.txt | sort -u
-sASYNCIFY
-sASYNCIFY_STACK_SIZE=32768
$ grep -c -- '-sEXPORT_ALL' build-wasm/CorsixTH/CMakeFiles/CorsixTH.dir/link.txt
0
$ wc -c < build-wasm/CorsixTH/corsix-th.js
238597
$ grep -o 'Asyncify' build-wasm/CorsixTH/corsix-th.js | wc -l
57
$ grep -o -i 'asyncify' build-wasm/CorsixTH/corsix-th.js | wc -l
71
```

### The fix (minimal)

`CorsixTH/CMakeLists.txt`, EMSCRIPTEN block only — removed the single `-sEXPORT_ALL` line from `CMAKE_EXE_LINKER_FLAGS`, with an inline comment recording why. Nothing else changed. `-sEXPORT_ALL` was inherited from the base branch and already flagged as "suspicious (bloat / apparently unused)" in the M0/M1 plan; the dev harness (`web/dev/index.html`) boots via the standard MODULARIZE factory + `callMain` (already an exported runtime method) and calls no C symbol directly, so removing it is safe. Confirmed post-fix: `EXPORT_ALL` absent from `link.txt`, `-sASYNCIFY`/`-sASYNCIFY_STACK_SIZE` still present.

### Build result

`build/build.sh clean` (full from-scratch Docker build, emscripten/emsdk:latest, emcc 6.0.3) — succeeded, ~58s. Artifacts (`wc -c`): `corsix-th.js` 238,597 B (~233 KB), `corsix-th.wasm` 3,443,339 B (~3.4 MB), `corsix-th.data` 15,484,956 B (~15 MB).

### Boot re-test

`build/serve.sh` (port 8123) → Chrome DevTools MCP `new_page` on `http://localhost:8123/index.html`. All 4 network requests HTTP 200 (`index.html`, `corsix-th.js`, `corsix-th.data` 15 MB, `corsix-th.wasm`).

Console output (verbatim, in order):
1. `[log] [harness] module instantiated`
2. `[log] [stdout] Welcome to CorsixTH v0.69.1-dev235!`
3. `[log] [stdout] This window will display useful information if an error occurs.`
4. `[log] [stdout] Unicode font not found, no fallback available.`
5. `[warn] The ScriptProcessorNode is deprecated. Use AudioWorkletNode instead.` (SDL2_mixer audio init)

**No asyncify TypeError. No abort.** The module fully instantiated, `main()` ran, SDL video+audio initialized, and the CorsixTH Lua engine started and drove its SDL main loop — which only renders/stays interactive because Asyncify is now yielding to the browser event loop.

Screenshot: `docs/superpowers/reports/m0-boot-asyncify.png` — the fully rendered CorsixTH graphical menu (hospital scene, "CorsixTH" road sign, logo building) with the interactive **"CorsixTH Setup"** dialog on top: *"CorsixTH needs a copy of the data files from the original Theme Hospital game (or demo) in order to run. Please use the below selector to locate the Theme Hospital install directory."* — plus a working directory-browser tree (`/`, `corsixth`, `dev`, `home`, `proc`, `tmp`, expandable) and OK / Exit buttons that respond to the event loop.

### Classification

**Genuine BOOT SUCCESS.** The engine proceeded through `SDL.mainloop` into the real game loop and rendered an interactive, event-driven UI — exactly the "TH-data-missing handling (message/UI/directory browser)" landing the task defined as boot success. This is the M0 boot-chain goal reached: interpreter path ✅ (2.5), Lua 5.4 ✅ (2.6), Asyncify ✅ (2.7).

### Next step (not a blocker — expected, out of scope)

The engine is doing the correct thing for a fresh install with no game data: prompting for the Theme Hospital data directory. Providing/mounting TH game data (and font handling for the "Unicode font not found" notice) is downstream product work (M2+), not a boot defect.
