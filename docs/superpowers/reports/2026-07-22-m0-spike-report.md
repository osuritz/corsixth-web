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

## Boot attempt
(Task 2 fills this in.)

## Verdict
(Task 2 fills this in.)
