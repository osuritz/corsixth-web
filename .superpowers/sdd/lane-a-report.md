# Lane A report — v1.x parallel effort

Branch: `worktree-agent-a6d3673cbfdc58693`
Worktree: `/Users/oliviersuritz/dev/corsixth-web/.claude/worktrees/agent-a6d3673cbfdc58693`

## Environment setup

- `build-wasm/` copied read-only from the main checkout (`cp -R`; the `.git` dirs of
  vendored external projects (`ep_lfs`, `ep_lua54`, `ep_lpeg`) hit permission errors on
  `.git/hooks/*.sample` — harmless, only the three needed artifacts
  (`corsix-th.{js,wasm,data}`) were required by `build.mjs` and are present).
- `web/.assets/FluidR3.sf3` copied from the main checkout (network sandbox blocks
  `raw.githubusercontent.com`; `npm run fetch-assets` then verified the cached file's
  sha256 and passed).
- `npm ci` in `web/` — clean.

## Item 1 — Worker offload + retriable music render

**Redesign, in three parts:**

1. **Worker.** `web/src/music-render.ts` is now dual-mode: detected via
   `typeof self.importScripts === 'function'` (worker-only, avoids needing the
   `webworker` tsconfig lib, which would conflict with the project's `DOM` lib). In a
   Worker it answers `{type:'render', id, xmi}` messages, fetching+caching its own
   soundfont copy internally (no postMessage soundfont round-trip). Outside a worker it
   still exports the original `window.__corsixthRenderMusic` global — the same-thread
   fallback path, used when `new Worker(...)` throws synchronously (caught in
   `music-orchestrator.ts#createWorkerClient`) or when the worker fails/crashes mid-batch
   (`WorkerFatalError`, distinguished from a normal per-track failure so a bad XMI
   doesn't abandon a healthy worker for the rest of the batch).
2. **Lazy + retriable.** New `web/src/music-orchestrator.ts` + a second IndexedDB object
   store (`idb.ts`, `render-status`, DB bumped v1→v2 — a separate store rather than a
   reserved key prefix in `th-data`, since `populateThData` copies every key in that
   store verbatim into MEMFS and would otherwise leak status metadata into the emulated
   filesystem). Per-track status: `pending | rendering | done | error`. `finishIngest`
   (onboarding.ts) no longer renders before reload — it reloads immediately after
   validation. `startShell()` (main.ts) calls `resumeMusicRendering()` on every
   successful boot (fire-and-forget); it finds XMIs without a trustworthy `done` status
   (including stale `rendering` from a crash, and `done` whose file has since vanished —
   `computeTracksNeedingRender`, a pure function, unit-tested directly) and renders them
   in the background. **Chosen UX (documented in code, not hidden):** rendered files only
   get picked up by `ensureMusicDir` on the *next* boot's `preRun`, so a fresh ingest is
   two reloads — reload #1 boots fast without music and renders in the background,
   reload #2 (manual, via the notice's button) has music. Never auto-reloads out from
   under a session in progress.
3. **Visible surface.** New DOM ids only (`#music-notice`, `#music-notice-text`,
   `#music-notice-retry` — existing overlay/status/save-banner ids untouched): a small
   bottom-right corner banner (`style.css`, TH stone/gold homage) for
   rendering/failed+retry/ready-to-reload states, wired in `main.ts#renderMusicNotice`.

**Tests:** `music-orchestrator.test.ts` (11 new tests) — `computeTracksNeedingRender`
pure-function cases, and `resumeMusicRendering` driven via injected fakes
(`MusicOrchestratorDeps`): happy path, a per-track failure that doesn't abandon the
client, `WorkerFatalError` mid-batch switching to fallback and completing, synchronous
Worker-construction failure going straight to fallback, and a concurrency guard
(`running` flag) test.

**Real-browser verification** (Chrome DevTools MCP, sandbox-disabled, port 8177 — 8126
was already in use by another lane; demo zip curl'd to `$TMPDIR` from archive.org):
ingested the real HOSP.zip via the `?test=1` hook → reload #1 booted with the expected
(pre-render) "Could not load music file" console message → notice showed
"Preparing music… (n/3)" then "🎵 Music ready" / "Reload to enable" → IndexedDB
confirmed all 3 tracks `done` with real `MUSIC/*.OGG` files (~1.5-1.8MB each) +
`MIDIDEM.TXT` copied → clicked reload → reload #2 booted with **no** music-load error,
notice stayed hidden (nothing left to do). Also visually confirmed the "rendering" and
"failed + Retry" notice CSS states via direct DOM injection — both render correctly, TH
styling intact, no layout issues.

**Did not run** `web/e2e-playable.mjs`: it hardcodes port 8126 (already bound by another
lane during my session) and shares a Chrome profile dir across lanes — skipping per the
brief's explicit allowance rather than risking a profile-lock collision; the manual
Chrome DevTools verification above exercised the same real ingest→boot→render→reload
path. The controller can run it at merge.

**Files touched:** `web/src/music-render.ts`, `web/src/music-orchestrator.ts` (new),
`web/src/music-orchestrator.test.ts` (new), `web/src/idb.ts`, `web/src/onboarding.ts`,
`web/src/main.ts`, `web/src/index.html`, `web/src/style.css`, `web/build.mjs` (added the
new test file to the `--tests` esbuild entry points — the only change outside `src/`).

## Item 2 — Config line-0 guard

`ensureLine0Guard` (fs-setup.ts), written unconditionally by both `ensureInstallPath`
and `ensureConfigDefaults`, guarantees a non-tracked Lua comment (`-- corsixth-web
generated config`) always occupies config.txt's line 0, regardless of call order —
closing the real gap where a freshly-ingested profile with **no rendered music yet**
(so `ensureMusicDir` never runs) left `theme_hospital_install` sitting on line 0, which
`config_finder.lua:172`'s strict `\n`-prefixed scan would flag as missing and trigger
`needs_rewrite`. Also switched `ensureMusicDir`'s audio_music write from prepend to
append so the guard stays permanently first. `fs-setup.test.ts`: dropped the old
`theme_hospital_install` exclusion (now covered), added a reversed-call-order
regression test, a guard-idempotency test, and strengthened the existing
no-music-rendered-yet test to check every tracked key.

## Item 3 — Per-file ingest backpressure

`onboarding.ts`'s `BoundedQueue<T>` (generic over the write function, so it's unit-
testable without IndexedDB) replaces the old per-reader-chunk `pending.length >=
MAX_INFLIGHT_PUTS` checkpoint, which — because fflate's callbacks are synchronous —
let every file completed within a single chunk start its IndexedDB write immediately,
with the checkpoint only limiting how many `Promise.all`-awaited promises accumulated,
not actual concurrency. Now at most `MAX_INFLIGHT_PUTS` (8) writes are ever actually
running; `whenBelow(bound)` lets the reader loop await backlog capacity before pulling
the next stream chunk.

**Measured** (`web/measure-ingest-memory.mjs`, 3 runs each, ~320MB synthetic zip,
`performance.memory.usedJSHeapSize` peak — Chromium-only, coarse/GC-dependent,
directional not precise): **before** 147.6 / 149.1 / 156.8 MB, **after** 129.1 / 137.6 /
144.9 MB — roughly a 9-10% peak reduction. Smaller than hoped because this synthetic
corpus's entries (0.4-2MB each) are comparable in size to a reader chunk, so the
"many small files complete within one chunk" burst this fix targets is less pronounced
than it would be on real Theme Hospital data (many more genuinely small files). Full
numbers + rationale are in the updated code comment (`onboarding.ts`, `MAX_INFLIGHT_PUTS`).

## Item 4 — Planar PCM

`synth.ts#renderMidiToPcm` now returns `{ left, right }` planar Float32Arrays instead of
interleaving them into one buffer. `music-render.ts`'s `encodeOgg` consumes the planar
channels directly (dropped the `deinterleave` step entirely — it was undoing work
`synth.ts` had just done). Only the WAV fallback still needs interleaved samples
(`encodeWav`'s contract, owned by Lane D via `wav.ts`/`wav.test.ts`, is unchanged) — a
small `interleave()` helper in `music-render.ts` does that conversion once, right before
the `encodeWav` call. Removes the ~4x transient PCM allocation (left + right +
interleaved-2x) that existed per track.

## Verification summary

- `npm test`: **29/29 pass** (12 pre-existing + 3 config-guard + 3 BoundedQueue +
  11 music-orchestrator new tests).
- `npx tsc --noEmit`: clean.
- `npm run build`: clean, all 3 engine artifacts + `music-render.js` + `FluidR3.sf3`
  staged.
- Real-browser Chrome DevTools MCP verification of the full ingest → lazy-render →
  retry-notice → reload → music-enabled flow (see Item 1).
- `web/e2e-playable.mjs` not run (port/profile conflict with a parallel lane — see
  Item 1; skipped honestly per the brief rather than risking a collision).

## Concerns / follow-ups for the controller

- `web/build.mjs` was touched (one line, adding the new test file to the `--tests`
  entry-points array) — outside the literal file list in my brief but necessary for
  `npm test` to pick up `music-orchestrator.test.ts`; flagging in case another lane
  also touches this file.
- `docs/superpowers/reports/m3-ingest-memory.md`'s existing "left as a follow-up" note
  (per-file backpressure) is now addressed by Item 3, but I did not edit that report
  file (out of my explicit file ownership) — worth a follow-up doc update at merge time.
- The chosen two-reload music UX (documented above and in `music-orchestrator.ts`'s
  header comment) is a product decision the controller/user may want to weigh in on —
  an alternative (hot-swap MUSIC/ into a running engine's MEMFS without reload) was not
  pursued since the engine has no live-reload hook for its data directory.
