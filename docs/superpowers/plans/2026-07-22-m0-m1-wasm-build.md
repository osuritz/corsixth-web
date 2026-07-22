# M0+M1: WASM Spike & Reproducible Build — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the PR #3093 base branch actually compiles and boots in a browser (M0), then make that build reproducible, thread-free, hygienic, and CI-gated (M1).

**Architecture:** All builds run inside the `emscripten/emsdk` Docker image against the existing `if (EMSCRIPTEN)` CMake path already present on this branch (`CorsixTH/CMakeLists.txt` — emscripten ports incl. `contrib.lua`, `-sASYNCIFY`, `-sMODULARIZE`, IDBFS; `CorsixTH/Src/CMakeLists.txt` — pinned lpeg/lfs FetchContent). M0 produces an evidence report that gates everything downstream; M1 hardens what M0 proves.

**Tech Stack:** Emscripten (emsdk Docker), CMake, C++17, Lua (emscripten `contrib.lua` port), SDL2 ports, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-07-22-theme-hospital-wasm-port-design.md`

## Global Constraints

- Branch: `wasm`, based on PR #3093 tip `d2c3d038`. Do NOT rebase onto upstream master during M0/M1.
- CMake flags, exactly: `-DWITH_MOVIES=OFF -DWITH_UPDATE_CHECK=OFF -DWITH_LUAJIT=OFF`. Do NOT pass `-DWITH_MIDI_DEVICE` — that option does not exist on this tree (master-only feature).
- No pthreads, no SharedArrayBuffer, no COOP/COEP requirements anywhere.
- No Theme Hospital game data in the repo, build artifacts, or deploys — engine-only. Preloading the engine's own MIT files (`CorsixTH/Lua`, `Bitmap`, `Campaigns`, `Levels`) is fine and expected.
- All builds go through Docker (`emscripten/emsdk` image); never require a locally installed emcc/cmake.
- Docker needs network during configure (FetchContent for lpeg/lfs + emscripten port downloads).
- Commits: conventional-commit style, and every commit ends with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- MIT license text (`LICENSE.txt`) stays intact.

## File Structure

| Path | Responsibility |
|---|---|
| `build/build.sh` | The one canonical build entry point (Docker + emcmake) |
| `build/serve.sh` | Local static server for boot-testing artifacts |
| `build/check-artifacts.sh` | Hygiene gate: no TH data, no threaded runtime, engine preloads present |
| `web/dev/index.html` | Minimal dev harness that instantiates the MODULARIZE'd engine |
| `CorsixTH/Src/sdl_audio.cpp` | Only engine-source change in M1: sync music load under `__EMSCRIPTEN__` |
| `.github/workflows/wasm.yml` | CI: build + hygiene checks + artifact upload on the `wasm` branch |
| `docs/superpowers/reports/2026-07-22-m0-spike-report.md` | M0 evidence report (the milestone deliverable) |

> **AMENDED in execution:** M0/M1 ultimately required five authorized engine-tree deltas — sdl_audio.cpp sync-music #ifdef; CORSIX_TH_INTERPRETER_PATH/DATADIR EMSCRIPTEN branch; Lua 5.4 FetchContent replacing contrib.lua port; lfs pin bump to v1_9_0; -sEXPORT_ALL removal. Each was individually authorized and reviewed; see the spike report addenda.

---

## M0 — Evidence Spike

### Task 1: Compile the base branch in Docker

**Files:**
- Create: `build/build.sh`
- Create: `docs/superpowers/reports/2026-07-22-m0-spike-report.md`

**Interfaces:**
- Produces: `build/build.sh [clean]` → on success, artifacts `corsix-th.js`, `corsix-th.wasm`, `corsix-th.data` somewhere under `build-wasm/` (exact subdir recorded in the report; Tasks 2/5/6 locate them with `find`). Report file with sections `## Build attempt`, `## Boot attempt`, `## Verdict`.

- [ ] **Step 1: Write the build script**

```bash
#!/usr/bin/env bash
# Canonical WASM build. Only requirement on the host: Docker.
# Usage: build/build.sh [clean]
set -euo pipefail

IMAGE="${EMSDK_IMAGE:-emscripten/emsdk:latest}" # pinned in M1 Task 3
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="build-wasm"

if [[ "${1:-}" == "clean" ]]; then
  rm -rf "${ROOT:?}/${BUILD_DIR}"
fi

docker run --rm -v "$ROOT":/src -w /src "$IMAGE" bash -c "
  set -euo pipefail
  echo \"--- toolchain: \$(emcc --version | head -1)\"
  emcmake cmake -B ${BUILD_DIR} -DCMAKE_BUILD_TYPE=Release \
    -DWITH_MOVIES=OFF -DWITH_UPDATE_CHECK=OFF -DWITH_LUAJIT=OFF
  cmake --build ${BUILD_DIR} -j\$(nproc)
"

echo '--- artifacts:'
find "$ROOT/$BUILD_DIR" \( -name 'corsix-th.js' -o -name 'corsix-th.wasm' -o -name 'corsix-th.data' \) | sort
```

Save as `build/build.sh`, then: `chmod +x build/build.sh`

- [ ] **Step 2: Run it and capture the log**

Run: `build/build.sh clean 2>&1 | tee /tmp/m0-build.log; echo "exit=$?"`

Expected: one of two outcomes — (a) `exit=0` and the three artifacts listed, or (b) a nonzero exit with a specific first error. Both are valid M0 evidence. Record the `--- toolchain:` line either way.

- [ ] **Step 3: If it failed, triage — max 3 rounds, then stop**

Work only the FIRST error in the log per round, using this table:

| Error class | Action |
|---|---|
| FetchContent / git clone failure | Confirm Docker network; retry once. If the pinned lpeg/lfs SHA is gone upstream, record it — that is a report finding, not something to fix in M0. |
| Unknown `--use-port` (e.g. `contrib.lua` not in this emsdk) | Retry with `EMSDK_IMAGE=emscripten/emsdk:3.1.64` (a 2024-era toolchain closer to the PR's vintage). Record which image works. |
| Missing dependency at configure (SDL2/Lua/freetype "not found") | The `if (EMSCRIPTEN)` branch was not taken. Verify the configure log's compiler line says `emcc`; if not, `emcmake` failed — record exact configure invocation and abort triage. |
| C++ compile error in engine source | Record file:line + error verbatim. If it is an isolated trivial fix (missing include, `#ifdef` guard), apply it, note it in the report, and rebuild. Anything structural: record, don't fix in M0. |
| Linker error (Asyncify, memory, missing symbol) | Record verbatim. One retry after reading the specific `-s` flag docs (`emcc --help`). Structural: record, don't fix. |

After 3 rounds without a successful build, stop — an unfixed build is a legitimate M0 verdict.

- [ ] **Step 4: Write the report's build section**

Create `docs/superpowers/reports/2026-07-22-m0-spike-report.md`:

```markdown
# M0 Spike Report — corsixth-web

## Build attempt
- Date / emsdk image / emcc version: <from the log's `--- toolchain:` line>
- Command: `build/build.sh clean` (flags: -DWITH_MOVIES=OFF -DWITH_UPDATE_CHECK=OFF -DWITH_LUAJIT=OFF)
- Outcome: SUCCESS | FAILURE
- Artifacts + paths (if success): <find output verbatim>
- Errors hit + triage actions taken (if any): <table: error → action → result>
- Source patches applied during triage (if any): <file:line + one-line rationale each>

## Boot attempt
(Task 2 fills this in.)

## Verdict
(Task 2 fills this in.)
```

- [ ] **Step 5: Commit**

```bash
git add build/build.sh docs/superpowers/reports/2026-07-22-m0-spike-report.md
git commit -m "feat(m0): canonical Docker wasm build script + spike report (build section)"
```
(If triage patched engine source, `git add` those files too and name them in the commit body.)

### Task 2: Boot attempt + M0 verdict

**Files:**
- Create: `web/dev/index.html`
- Create: `build/serve.sh`
- Modify: `docs/superpowers/reports/2026-07-22-m0-spike-report.md` (Boot + Verdict sections)

**Interfaces:**
- Consumes: artifacts from Task 1 (`corsix-th.js` is a MODULARIZE'd factory whose global is `Module`; `-sEXPORTED_RUNTIME_METHODS=callMain,...`; `-sENVIRONMENT=web`).
- Produces: `build/serve.sh` → serves the artifact dir + harness at `http://localhost:8123`. Completed M0 report with a Verdict of A, B, or C (matrix below) — the gate for all M1+ work.

**Precondition:** Task 1 built successfully. If not, skip Steps 1–4, write `## Boot attempt: not reached (build failed)`, and go to Step 5's verdict matrix.

- [ ] **Step 1: Write the dev harness**

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>corsixth-web dev harness</title>
  <style>
    html, body { margin: 0; height: 100%; background: #111; }
    canvas { display: block; margin: 0 auto; height: 100%; }
  </style>
</head>
<body>
  <canvas id="canvas" oncontextmenu="event.preventDefault()"></canvas>
  <script src="corsix-th.js"></script>
  <script>
    Module({
      canvas: document.getElementById('canvas'),
      print: (t) => console.log('[stdout]', t),
      printErr: (t) => console.warn('[stderr]', t),
    })
      .then(() => console.log('[harness] module instantiated'))
      .catch((e) => console.error('[harness] instantiation failed', e));
  </script>
</body>
</html>
```

Save as `web/dev/index.html`.

- [ ] **Step 2: Write the serve script**

```bash
#!/usr/bin/env bash
# Serve the built artifacts + dev harness for a local boot test.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
JS="$(find "$ROOT/build-wasm" -name 'corsix-th.js' | head -1)"
[[ -n "$JS" ]] || { echo "No corsix-th.js under build-wasm/ — run build/build.sh first"; exit 1; }
ART_DIR="$(dirname "$JS")"

cp "$ROOT/web/dev/index.html" "$ART_DIR/"
echo "Serving $ART_DIR at http://localhost:8123"
python3 -m http.server 8123 --directory "$ART_DIR"
```

Save as `build/serve.sh`, then: `chmod +x build/serve.sh`

- [ ] **Step 3: Boot it**

Run: `build/serve.sh` (background it), open `http://localhost:8123` in Chrome with DevTools console open (browser-automation tooling if available, manual otherwise).

Capture: (1) full console output, (2) a screenshot of the tab, (3) network tab — did `corsix-th.wasm` and `corsix-th.data` load (HTTP 200, sizes)?

- [ ] **Step 4: Classify what happened**

| Observation | Classification |
|---|---|
| Engine reaches TH-data-missing handling: directory-browser UI, or a Lua error / console message about missing `theme_hospital_install` / data files | **BOOT SUCCESS for M0** — engine runs; only assets are absent (expected: we supply none) |
| Module instantiates, preloads load, then JS exception / abort before any engine output | Partial — record the exact exception + stack |
| `corsix-th.js`/`.wasm`/`.data` fail to load, or `Module` is undefined | Harness/artifact mismatch — check artifact names, `EXPORT_NAME`, paths; one retry after fixing the harness, then record |

- [ ] **Step 5: Complete the report — Boot section + Verdict**

Fill in `## Boot attempt` (evidence: console excerpts, screenshot filename, network results). Then write `## Verdict` using this matrix:

```markdown
## Verdict
One of:
- **A — GREEN:** builds + boots to asset-missing behavior. M1 proceeds as planned.
- **B — YELLOW:** builds; boot fails before engine output. M1 Task 3 (reproducible build) still proceeds;
  boot-blocker becomes the top M1 fix item. List the blocker(s) verbatim with stack traces.
- **C — RED:** does not build after triage protocol. STOP — escalate to sponsor with the evidence and a
  recommendation chosen from: (1) fix-forward on this base, (2) re-apply the emscripten commits onto
  current upstream master instead, (3) revisit strategy. Do not start M1.
```

- [ ] **Step 6: Commit (and push — this is the M0 deliverable)**

```bash
git add web/dev/index.html build/serve.sh docs/superpowers/reports/2026-07-22-m0-spike-report.md
git commit -m "feat(m0): dev harness + serve script; complete M0 spike report with verdict"
git push
```

---

## M1 — Reproducible, Thread-Free, CI-Gated
*(Gate: only start after M0 verdict A or B. On C, this section is void pending sponsor decision.)*

### Task 3: Pin the toolchain

**Files:**
- Modify: `build/build.sh` (the `IMAGE=` line)

**Interfaces:**
- Consumes: the working emsdk image tag recorded in the M0 report.
- Produces: `build/build.sh` defaulting to an exact `emscripten/emsdk:<version>` tag (no `latest`). Task 6's CI uses the same tag.

- [ ] **Step 1: Pin the image**

In `build/build.sh`, replace the `IMAGE=` line with the exact version that succeeded in M0 (example — substitute the real recorded tag; if M0 ran on `latest`, resolve it: `docker run --rm emscripten/emsdk:latest emcc --version | head -1` and use that version number):

```bash
IMAGE="${EMSDK_IMAGE:-emscripten/emsdk:4.0.10}"
```

- [ ] **Step 2: Verify a from-scratch build works with the pin**

Run: `build/build.sh clean 2>&1 | tail -5`
Expected: exit 0; the three artifacts listed; `--- toolchain:` line shows the pinned version.

- [ ] **Step 3: Commit**

```bash
git add build/build.sh
git commit -m "build: pin emsdk image for reproducible wasm builds"
```

### Task 4: Emscripten sync-music patch (zero threads)

**Files:**
- Modify: `CorsixTH/Src/sdl_audio.cpp` (the `SDL_CreateThread` call at the end of `l_load_music_async`, ~line 153)

**Interfaces:**
- Consumes: existing `load_music_async_thread(void*)` (same file, ~line 100) — loads via `Mix_LoadMUS_RW` and pushes `SDL_USEREVENT_MUSIC_LOADED` itself.
- Produces: an engine with zero `SDL_CreateThread`/`std::thread` calls compiled in for the wasm target. Task 5's `PThread` artifact check relies on this.

- [ ] **Step 1: Confirm the current state (the "failing test")**

Run: `grep -n "SDL_CreateThread" CorsixTH/Src/sdl_audio.cpp`
Expected: exactly one hit, inside `l_load_music_async`, NOT wrapped in any `#ifdef` — confirming the thread is unconditionally created today.

- [ ] **Step 2: Apply the patch**

In `CorsixTH/Src/sdl_audio.cpp`, replace:

```cpp
  async->thread =
      SDL_CreateThread(load_music_async_thread, "music_thread", async);
```

with:

```cpp
#ifdef __EMSCRIPTEN__
  // Single-threaded wasm build: no worker threads. Run the loader
  // synchronously — load_music_async_thread pushes
  // SDL_USEREVENT_MUSIC_LOADED itself, so the main loop's existing
  // callback path is preserved unchanged.
  async->thread = nullptr;
  load_music_async_thread(async);
#else
  async->thread =
      SDL_CreateThread(load_music_async_thread, "music_thread", async);
#endif
```

- [ ] **Step 3: Verify the patch shape**

Run: `grep -n -A2 -B6 "SDL_CreateThread" CorsixTH/Src/sdl_audio.cpp`
Expected: the single `SDL_CreateThread` call now sits in the `#else` branch of an `#ifdef __EMSCRIPTEN__` block.

- [ ] **Step 4: Rebuild**

Run: `build/build.sh 2>&1 | tail -3`
Expected: exit 0 (incremental rebuild fine). Runtime music verification is an M2 concern (needs assets); M1's gate is compile + Task 5's thread-runtime check.

- [ ] **Step 5: Commit**

```bash
git add CorsixTH/Src/sdl_audio.cpp
git commit -m "fix(wasm): load music synchronously under Emscripten (zero-thread build)"
```

### Task 5: Artifact hygiene gate

**Files:**
- Create: `build/check-artifacts.sh`

**Interfaces:**
- Consumes: `corsix-th.js` + `corsix-th.data` under `build-wasm/` (Task 1's build).
- Produces: `build/check-artifacts.sh` → exit 0 = "PASS: engine-only artifacts", nonzero with a `FAIL:` line otherwise. Task 6's CI calls it verbatim.

- [ ] **Step 1: Write the check script**

```bash
#!/usr/bin/env bash
# Hygiene gate: artifacts must contain NO Theme Hospital game data and no
# threaded (pthread) runtime; engine's own preloads must be present.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
JS="$(find "$ROOT/build-wasm" -name 'corsix-th.js' | head -1)"
DATA="$(find "$ROOT/build-wasm" -name 'corsix-th.data' | head -1)"
[[ -n "$JS" && -n "$DATA" ]] || { echo "FAIL: artifacts not found under build-wasm/ — build first"; exit 1; }

python3 - "$JS" "$DATA" <<'PY'
import sys

js_path, data_path = sys.argv[1], sys.argv[2]
blob = open(js_path, 'rb').read() + open(data_path, 'rb').read()
low = blob.lower()

# TH game-data filename signatures that must NEVER ship (spec: engine-only deploys)
banned = [b'vblk-0', b'spointer', b'demo.dat']
hits = [b.decode() for b in banned if b in low]
if hits:
    print(f"FAIL: Theme Hospital game-data signatures in artifacts: {hits}")
    sys.exit(1)

# Threaded runtime marker: 'PThread' object is only emitted by -pthread builds
if b'PThread' in blob:
    print("FAIL: threaded (pthread) runtime detected in corsix-th.js")
    sys.exit(1)

# Sanity: prove the scan sees real content — engine's own preload must be present
if b'corsixth.lua' not in low:
    print("FAIL: engine preload (CorsixTH.lua) not found — scan or packaging is broken")
    sys.exit(1)

print("PASS: engine-only artifacts (no TH game data, no pthread runtime, engine preloads present)")
PY
```

Save as `build/check-artifacts.sh`, then: `chmod +x build/check-artifacts.sh`

> **AMENDED during execution:** the banned-substring scan above false-positives on the engine's own bundled Lua source, which legitimately *references* TH filenames (`VBlk-0.tab`, `Demo.dat`) in its file-checking code. The shipped script replaces the content-substring scan with a **preload-manifest path allowlist**: parse the file-packager manifest embedded in `corsix-th.js`, assert every preloaded path is under `/corsixth/` within `{CorsixTH.lua, Lua/, Bitmap/, Campaigns/, Levels/}` (mirroring the CMake preload glob), and FAIL on any other path. The PThread check and the `/corsixth/CorsixTH.lua` presence check stay as designed.

- [ ] **Step 2: Verify it fails without artifacts (negative test)**

Run: `mv build-wasm /tmp/build-wasm-stash && build/check-artifacts.sh; echo "exit=$?"; mv /tmp/build-wasm-stash build-wasm`
Expected: `FAIL: artifacts not found…` and `exit=1`.

- [ ] **Step 3: Verify it passes on real artifacts**

Run: `build/check-artifacts.sh`
Expected: the `PASS: engine-only artifacts…` line, exit 0.

- [ ] **Step 4: Commit**

```bash
git add build/check-artifacts.sh
git commit -m "build: artifact hygiene gate (no TH data, no pthread runtime)"
```

### Task 6: CI workflow

**Files:**
- Create: `.github/workflows/wasm.yml`

**Interfaces:**
- Consumes: the pinned emsdk tag (Task 3 — keep the two in lockstep) and `build/check-artifacts.sh` (Task 5).
- Produces: green `WASM build` check on pushes/PRs to `wasm`; downloadable `corsixth-wasm` artifact bundle.

- [ ] **Step 1: Write the workflow**

```yaml
name: WASM build

on:
  push:
    branches: [wasm]
  pull_request:
    branches: [wasm]

jobs:
  build:
    runs-on: ubuntu-latest
    container: emscripten/emsdk:4.0.10   # keep in lockstep with build/build.sh
    steps:
      - uses: actions/checkout@v4

      - name: Configure and build
        run: |
          emcmake cmake -B build-wasm -DCMAKE_BUILD_TYPE=Release \
            -DWITH_MOVIES=OFF -DWITH_UPDATE_CHECK=OFF -DWITH_LUAJIT=OFF
          cmake --build build-wasm -j"$(nproc)"

      - name: Artifact hygiene gate
        run: build/check-artifacts.sh

      - uses: actions/upload-artifact@v4
        with:
          name: corsixth-wasm
          path: |
            build-wasm/**/corsix-th.js
            build-wasm/**/corsix-th.wasm
            build-wasm/**/corsix-th.data
```

Save as `.github/workflows/wasm.yml`. Substitute the container tag with Task 3's actual pin.

- [ ] **Step 2: Commit, push, watch**

```bash
git add .github/workflows/wasm.yml
git commit -m "ci: wasm build + hygiene gate on the wasm branch"
git push
gh run watch --repo osuritz/corsixth-web --exit-status
```
Expected: run completes green; `corsixth-wasm` artifact attached.

- [ ] **Step 3: If CI fails but local passed**

Diff the environments, not the code: container tag mismatch with `build/build.sh`, missing `git` for FetchContent (emsdk image ships it — verify with `git --version` step if hit), or artifact glob paths. Fix, push, re-watch. Do not merge a red `wasm` branch state — M1 exits green.

---

## Self-Review Notes

- Spec coverage: M0 spike (Tasks 1–2 = spec §Verification M0 gate), reproducible Docker build (Task 3 = M1 exit criterion), sync-music/zero-thread patch (Task 4 = spec §V1 build config), engine-only artifact guarantee (Task 5 = spec §Deployment + global constraint), CI (Task 6 = spec §Deployment). Deliberately NOT in this plan (deferred to the M2/M3 plan, pending M0 evidence): web shell onboarding, IDBFS syncfs error propagation, archive.org CORS spike, memory-budget work, E2E smoke test, ISO bypass.
- The `-sEXPORT_ALL`, `-sEXIT_RUNTIME`, `-lwebsocket.js` flags inherited from the base branch are suspicious (bloat / odd-for-a-game / apparently unused) but are NOT touched in M0/M1 — churn on unproven ground is how spikes die. Logged for the M2 plan. (AMENDED: `-sEXPORT_ALL` was subsequently removed in Task 2.7 — it broke Asyncify exports under `-Os`; see spike report addendum 3.)
- Type/name consistency: artifact names (`corsix-th.js/.wasm/.data` — corrected from `CorsixTH.*` after Task 1.5 discovered the `OUTPUT_NAME corsix-th` target property), port 8123, `build-wasm/`, and the emsdk pin appear in Tasks 1/2/3/5/6 — all consistent; Task 3 and Task 6 both carry the "keep in lockstep" note.
