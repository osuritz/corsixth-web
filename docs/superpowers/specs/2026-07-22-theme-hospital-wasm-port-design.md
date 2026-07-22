# Theme Hospital in the Browser — CorsixTH → WASM Port Design

**Date:** 2026-07-22
**Status:** Approved by sponsor
**Repo:** `corsixth-web` — fork of [CorsixTH/CorsixTH](https://github.com/CorsixTH/CorsixTH) (MIT), `wasm` branch based on upstream [PR #3093](https://github.com/CorsixTH/CorsixTH/pull/3093) head (`d2c3d038`; merge-base with master `540826f8`, upstream master at `b96a85ae` as of 2026-07-20)

## Goal

**V1 = playable slice:** CorsixTH boots in a browser tab, the player gets Theme Hospital assets in via demo-fetch or drag-drop, the first campaign level is fully playable, and saves survive page reloads.

Explicitly out of scope for v1: in-game movies (FFmpeg), hardware/virtual MIDI output, update checker, ISO-image asset sources, multiplayer.

## Sponsor decisions (2026-07-22)

1. **V1 scope** — playable slice as defined above.
2. **Assets** — demo-first onboarding + full-game drag-drop upload. Confirmed viable: CorsixTH has first-class demo support (`DataM/Demo.dat` detection in `CorsixTH/Lua/app.lua:1533`, `using_demo_files` consumed throughout; `CorsixTH/Lua/config_finder.lua:416` documents the demo as a supported install source).
3. **Repo model** — GitHub fork, long-lived `wasm` branch, in-tree changes, new `web/` dir for the browser shell.
4. **Operating model** — sponsor (Olivier) makes scope calls; Claude acts as executive producer, delegating to Sonnet/Opus subagent swarms and making technical calls.

## Architecture

| Component | What it is | Interface |
|---|---|---|
| **Engine** (existing tree) | C++17 + Lua + SDL2 compiled to a single-threaded WASM module via Emscripten | Canvas + mounted virtual FS in; `Module.gameReady()` and Emscripten `Module` API out |
| **`web/`** (new) | TS browser shell: asset onboarding UI, IndexedDB mounts, loading/error UX, audio-unlock gesture | Talks to engine only via the Emscripten `Module` API |
| **Build** | Docker `emscripten/emsdk` + `emcmake` CMake presets; no local toolchain | `docker run … emcmake cmake && cmake --build` |

### Base-branch rationale

PR #3093 already embodies the architectural decisions that killed the 2022 attempt (PR #1891) and were re-derived at cost there:

- Static-links lpeg/LuaFileSystem (via the `CORSIX_TH_LINK_LUA_MODULES || __EMSCRIPTEN__` preload path, `Src/main.cpp`) — eliminates the dlopen-vs-Emscripten blocker.
- `-sASYNCIFY` wraps the blocking main loop instead of restructuring it.
- `idbfs.js` + `FS.syncfs` hooks (`SyncEmscriptenFS` in `th_lua.cpp`, wired into `app.lua`/`persistance.lua`) for persistence.
- Emscripten CMake wiring with `--use-port=sdl2/sdl2_mixer/zlib/…`.

We inherit it as **raw material, not gospel**. The upstream reviewers' pinning complaint is already addressed on this branch — lpeg/lfs `FetchContent` is pinned to exact commit hashes (`CorsixTH/Src/CMakeLists.txt:11,17`); keep it that way. Remaining hygiene: verify the `--preload-file` set embeds only the engine's own MIT-licensed resources (`CorsixTH/Lua`, bitmaps, campaigns, levels — fine to keep) and that no Theme Hospital game data can end up in a build artifact — TH data arrives exclusively at runtime via the onboarding flow. We do not cherry-pick individual commits (WIP-quality, reviewer-flagged) and we do not reimplement from scratch.

## Main-loop strategy

The engine's sole event loop is `l_mainloop()` at `CorsixTH/Src/sdl_core.cpp:134` — a blocking `while (SDL_WaitEvent…)` (`sdl_core.cpp:145`) with an 18ms `SDL_AddTimer` tick and an FPS-unlimited busy-spin path (`sdl_core.cpp:284`). No secondary event loops exist anywhere in `Src/` (grep-verified) — a materially better starting position than e.g. devilutionX's five loops.

**Decision: ship on Asyncify first** (what the base branch does — fastest path to first pixel), with the `emscripten_set_main_loop` restructure held as a **pre-mapped contingency**, executed only if M2 testing shows input lag or frame-pacing problems (OpenTTD's merged port rejected Asyncify for exactly those symptoms). The contingency plan, from recon:

- `l_mainloop()` → per-invocation callback: one `SDL_PollEvent` drain + existing `do_timer`/`do_frame` logic.
- Synthesize the 18ms tick from elapsed time (`SDL_GetTicks`) instead of `SDL_AddTimer` (unreliable single-threaded under Emscripten).
- Cap the FPS-unlimited busy-spin to one frame per callback (`#ifdef __EMSCRIPTEN__`) — unbounded it freezes the tab.
- Neuter the `while (bRun)` full-teardown restart loop in `CorsixTH/SrcUnshared/main.cpp` → `location.reload()` on the web.

## V1 build configuration

```
-DWITH_MOVIES=OFF -DWITH_UPDATE_CHECK=OFF -DWITH_LUAJIT=OFF
```

All existing flags in this tree. **Branch delta:** upstream master has since added a MIDI-device feature (`midi_player.cpp`, `WITH_MIDI_DEVICE`) that does not exist on our branch's older base — when we rebase onto master, add `-DWITH_MIDI_DEVICE=OFF`. Consequences (verified against this tree):

- **Zero threads, after one planned patch** — this tree's only thread users are movie playback (`th_movie.cpp:443`) and async music loading (`SDL_CreateThread` at `sdl_audio.cpp:153`; `loadMusicAsync` registered at `sdl_audio.cpp:240`). Movies are compiled out by `WITH_MOVIES=OFF`; the async-music path still exists — a small Emscripten-only patch to load synchronously is **M1 work, not current state**, and the zero-thread claim is contingent on it.
- Therefore **no pthreads → no SharedArrayBuffer → no COOP/COEP headers** → any static host works.
- The one synchronous `curl_easy_perform` (`th_lua.cpp:171-213`) goes away with `WITH_UPDATE_CHECK=OFF`.
- LuaJIT cannot target wasm; plain Lua compiles from source. lpeg/lfs statically linked and preloaded.
- Emscripten ports supply SDL2, SDL2_mixer (reduced codec set), zlib, libpng, freetype.
- ISO-image support **to be bypassed for the wasm target** (planned work — `iso_fs.cpp`/`th_lua_iso.cpp` currently compile unconditionally per `Src/CMakeLists.txt:44`, and Lua exposes ISO handling via `filesystem.lua:24`) — browser users supply extracted folders.

Known-trap flags from prior art: `-sALLOW_MEMORY_GROWTH`, evaluate `-fmax-type-align=1` (OpenRCT2 struct-alignment rendering glitch), `-sCASE_INSENSITIVE_FS=1` (already in base branch; TH data has mixed-case filenames).

## Filesystem & assets

I/O is almost entirely Lua `io.*`/lfs plus a few C++ `fopen`/`ofstream` sites — standard Emscripten POSIX emulation covers it; the port risk is mount configuration and syncfs discipline, not I/O rewrites.

| Mount | Backing | Contents | Lifecycle |
|---|---|---|---|
| `/th-data` | MEMFS (populated from IndexedDB cache at boot) | `Data/`, `Levels/`, `QData/`, `Anims/`, `DataM/` | Read-only, load-once |
| `/user` | IDBFS | `config.txt`, `hotkeys.txt`, `Saves/`, `Autosaves/`, `Screenshots/` | Persistent; `FS.syncfs` after every write path (base branch hooks saves/config; audit for missed writers, e.g. screenshots, gamelogs). **Syncfs failures must propagate to Lua/UI** — the base branch's `SyncEmscriptenFS` (`th_lua.cpp:222`) swallows errors, which would silently lose saves on quota failure. M2 acceptance criterion. |

Browser-side onboarding (in `web/`), replacing the OS install-folder probing loop (`App:checkInstallFolder`, `app.lua:1450`) with direct `fs:setRoot`:

1. **"Play the demo"** — the browser fetches the freely-distributed TH demo archive client-side directly from the Internet Archive. We never host, proxy, or bundle EA-copyrighted bytes — engine-only deploys, matching upstream maintainers' hard requirement (they cited a takedown precedent for a similar retro web port). **Verification spike required (M2):** archive.org CORS headers + item availability; drag-drop is the guaranteed fallback if the fetch path proves unreliable.
2. **"I own the game"** — drag-drop of a GOG/CD Theme Hospital folder or zip; validated (`Data/VBlk-0.tab`, `Levels/Level.L1`, `QData/SPointer.dat` presence checks mirror `app.lua:1520-1522`), extracted into IndexedDB once, reused on later visits.

**Memory budget (M2 requirement):** onboarding must stream-extract archives and release intermediate buffers — a naïve flow holds game data as zip buffer + IndexedDB copy + MEMFS copy simultaneously, while the wasm heap starts at `-sINITIAL_MEMORY=128mb` (`CorsixTH/CMakeLists.txt:121`) with `ALLOW_MEMORY_GROWTH`. Mobile Safari is the tightest constraint.

## Deployment

Static hosting; GitHub Pages initially (no special headers required). Repo and deploy contain engine + shell only — zero game data. CI: Docker build must pass on every PR to `wasm`.

## Verification

- **M0 evidence gate:** the base branch is unproven (no confirmed boot in the PR thread; one reviewer hit a `FetchContent` build failure). Milestone 0 is a throwaway spike build in Docker; downstream plans re-anchor on its findings.
- **E2E smoke test** (Playwright or Chrome DevTools MCP), which *is* the v1 acceptance test: boot → demo assets onboarded → start first level → save → reload page → load the save.
- Audio requires a user-gesture unlock (autoplay policy) — the onboarding click doubles as it.
- Early audit: which audio formats do shipped TH assets actually use vs. what Emscripten's reduced SDL2_mixer port decodes (vcpkg wants fluidsynth/libmodplug/mpg123/opusfile — the port won't have all of that).
- M1 CI gates build + artifact hygiene only — it does NOT yet gate boot/runtime correctness (the EXPORT_ALL asyncify regression compiled green). A headless boot smoke test is the top M2 CI item.

## Milestones

| # | Deliverable | Exit criterion |
|---|---|---|
| **M0** | Spike build of base branch in Docker | Evidence report: compiles? boots? what breaks? |
| **M1** | Reproducible build + zero-thread patch | `docker …` one-liner produces `corsix-th.{js,wasm,data}` (lpeg/lfs/lua pinned to exact hashes; lfs bumped to v1_9_0 during execution); Emscripten sync-music patch landed; CI green |
| **M2** | Web shell | Demo-fetch + drag-drop onboarding working; IDBFS saves survive reload (verified by test) |
| **M3** | Playable slice | E2E smoke test green; input-latency check → loop restructure only if Asyncify underperforms; deployed to Pages |

## Risks

| Risk | Sev | Mitigation |
|---|---|---|
| Base branch doesn't build/boot | High | M0 spike before further commitment; loop-restructure contingency pre-mapped |
| Asyncify input lag / vsync issues (OpenTTD precedent) | Med | Measure in M2/M3; execute pre-mapped restructure if needed |
| SDL2_mixer Emscripten port lacks needed codecs | Med | Early asset-format audit; add codecs from source only as required |
| Upstream SDL3 migration forces rebase | Low | Not started as of `b96a85ae` (grep-verified in-tree); monitor upstream |
| IndexedDB quota limits / silent `FS.syncfs` failures losing saves | Med | Quota check in onboarding; syncfs error propagation to UI (M2 acceptance criterion) |
| Onboarding memory spike (zip + IndexedDB + MEMFS triplication) | Med | Stream-extraction + buffer release; measure on a full GOG install in M2 |

## Appendix: recon provenance

Six recon lanes (subagent swarm, 2026-07-22) inform this design: build-deps, main-loop, filesystem/assets, threads/AV, prior art, PR #3093 deep-dive. An independent Codex CLI (gpt-5.5) review on 2026-07-22 fact-checked the spec against this branch's tree; its corrections are incorporated. File:line citations reference **this branch's tree** (base `d2c3d038`); upstream master (`b96a85ae`) has drifted — most notably the master-only MIDI-device feature (`WITH_MIDI_DEVICE`), which does not exist here.

Key prior art: [PR #3093](https://github.com/CorsixTH/CorsixTH/pull/3093) (active WIP browser platform), [PR #1891](https://github.com/CorsixTH/CorsixTH/pull/1891) (2022 PoC; blockers: dlopen-vs-pthreads, main loop), [issue #1883](https://github.com/CorsixTH/CorsixTH/issues/1883), [OpenTTD #8355](https://github.com/OpenTTD/OpenTTD/pull/8355) (merged Emscripten support; rejected Asyncify), [OpenRCT2 web-port writeup](https://olydis.medium.com/roller-coaster-tycoon-in-the-browser-ef6a340bced8), [devilutionX #228](https://github.com/diasurgical/devilutionX/issues/228) (multiple-event-loop blocker).
