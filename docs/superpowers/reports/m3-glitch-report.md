# M3 Task 4 — Bounded Glitch-Repro Report

**Verdict: NOT REPRODUCED.** Watch-item + sponsor-evidence request below.

## What was exercised

- **Harness:** `web/e2e-glitch.mjs`, extending the Task-1 playable-slice E2E
  (`web/e2e-playable.mjs`) machinery (persistent Chrome profile priming, `?test=1`
  ingest hook, canvas-fraction clicking).
- **Level:** the demo's single level (`LEVELS/LEVEL.L1`), same as all prior M3 recon.
- **Build actions per session** (all via a verified, screenshot-captured coordinate
  sequence — see `docs/superpowers/reports/m3-reception-coords.png`):
  1. New Game (Campaign) → dismiss the "Welcome to the demo hospital!" dialog.
  2. Build one **Reception Desk** via the Corridor Objects menu.
  3. **Hire one Receptionist** (`b` hotkey → Hire Staff dialog → Receptionist category →
     hire → place at the desk). This step was **not** in the original plan but proved
     necessary: a bare, unstaffed desk drew **zero visitors** even after ~1 simulated
     year (see Finding 2 below) — without it there is no "populated hospital" to test
     the hypothesis against at all.
  4. Set simulation speed to max ("Then Some", hotkey `5`) to maximize simulated time
     covered per bounded wall-clock session.
- **Sessions run:** 4 independent bounded trials (fresh New Game each time, not a
  save/quickload chain — see rationale in the harness's header comment), totaling
  **~25 minutes** of monitored wall-clock time:
  | chunk | wall-clock | in-game time reached | heap-growth events | screenshots |
  |---|---|---|---|---|
  | 0 (no receptionist — pre-fix baseline) | 8 min | ~1 year (Jan → next Jan) | 0 | 16 |
  | 1 (post-fix smoke check) | 1 min | ~2 months | 0 | 3 |
  | 2 | 8 min | ~1 year | 0 | 16 |
  | 3 | 8 min | ~1 year | 0 | 16 |
- **Instrumentation:** `WebAssembly.Memory.prototype.grow` patched via
  `page.evaluateOnNewDocument` (before any page script runs), so every wasm
  heap-growth event is logged with a timestamp and before/after byte size — with
  **zero changes to `web/src/main.ts` or the engine tree** (see design note below).
  Full timeline: `docs/superpowers/reports/m3-glitch-heap-events.json`.
- Screenshots taken every 30s (16 per 8-minute chunk) and visually inspected in full
  (all ~50 raw frames across the 4 chunks) for sprite garbling, tearing, or palette
  corruption. A small representative subset is committed here (not all raw frames —
  see Global Constraints):
  - `m3-glitch-00-baseline-newgame.png` — fresh level entry.
  - `m3-glitch-01-reception-built.png` — desk placed.
  - `m3-glitch-02-receptionist-hired.png` — receptionist assigned and working.
  - `m3-glitch-03-midsession-15jun.png` — representative mid-session frame (~5 months
    simulated, max speed running).
  - `m3-glitch-04-yearend-pause-0-visitors.png` — the year-end Charts screen (see
    Finding 2), showing "Most Visitors: 0" across all 4 in-hospital entities.

## Findings

**Finding 1 — no visual corruption observed.** Across all 4 sessions (~25 min
wall-clock, up to ~1 simulated year each), zero heap-growth events fired and zero
frames (of ~50 inspected) showed sprite garbling, tearing, or palette corruption. The
in-browser memory footprint stayed flat at **~51–52MB `usedJSHeapSize`** the entire
time (via `performance.memory`, logged per chunk in the JSON) — nowhere near the
128MB `-sINITIAL_MEMORY` ceiling that would need to be crossed before the first
32MB `-sMEMORY_GROWTH_LINEAR_STEP` growth event could even occur.

**Finding 2 — this demo build/level does not spawn patients without a functioning
diagnosis room.** This is the most actionable result of this task. A Reception Desk
alone (Task 4's originally-planned setup) produced **zero patient visitors** over ~1
simulated year (confirmed in the pre-fix chunk 0 baseline). Hiring a Receptionist
(added mid-task once this was discovered) still produced **zero visitors** over a
further ~2 simulated years across chunks 1–3 — the game's own tutorial hint
("To start diagnosing your patients' diseases you must build a GP's Office") and the
year-end Charts screens (`Most Visitors: 0` for every entity, every chunk) confirm
that no patient traffic exists until a diagnosis room (GP's Office) is built and
staffed with a doctor.

**This means the harness, as bounded by this task's authorized scope (Reception
Desk + one follow-on hire, both single-click object placements), cannot reach the
sprite-dense, actively-treating-patients state the sponsor's own session apparently
reached** ("saw garbled/corrupted sprites during demo gameplay... after playing for a
while"). Building a GP's Office requires room-boundary drawing (a drag/multi-click
wall-placement UI, not a single-click object placement like the desk/receptionist),
which is a materially larger and untested automation surface — reasonably out of
scope for this bounded-effort task per "no milestone-burning open-ended bisect."

## Heap-growth hypothesis: not testable to a conclusion in this session

The leading hypothesis (heap-growth pointer invalidation via
`-sALLOW_MEMORY_GROWTH -sINITIAL_MEMORY=128mb -sMEMORY_GROWTH_LINEAR_STEP=32mb`,
`CorsixTH/CMakeLists.txt:137`) requires a heap-growth event to occur at all before it
can be tested. None occurred in ~25 minutes of idle-hospital play because memory
usage never approached the 128MB initial ceiling (it sat at ~51MB throughout,
essentially flat regardless of simulated time elapsed) — consistent with growth being
driven by loaded **content** (patient sprite variety, room objects, staff, active
animations) rather than elapsed wall-clock or simulated time alone. An empty,
patient-free hospital — which is all this task's authorized build actions can
produce — does not generate that content.

**Fallback `-O2` vs `-Os` bisect (CMakeLists.txt:120):** not attempted. Per the
brief, this is only in scope once heap-growth is affirmatively ruled out as a cause
of corruption *given corruption occurred* — here neither corruption nor heap growth
occurred at all, so there is nothing to bisect yet.

## Watch-item

- **Status:** open, unresolved. Not reproduced under this task's bounded, scripted
  conditions (single demo level, Reception Desk + Receptionist only, no diagnosis
  room, ~25 min / up to ~1 simulated year per trial, 4 independent trials).
- **What would move this forward:** a session that reaches actual sprite-dense,
  actively-treating-patients gameplay — i.e., a GP's Office (or further rooms) built
  and staffed, patients queueing/being treated/leaving over an extended session. That
  requires either (a) a follow-up task authorizing room-building automation (out of
  this task's scope), or (b) the sponsor's own repro session as evidence (see below).

## Sponsor-evidence request

To make further progress without an open-ended engineering effort, please ask the
sponsor for:
1. **Exact repro steps**: which rooms/objects were built, roughly how many patients
   were in the hospital, and what actions were being taken right before corruption
   appeared.
2. **A screenshot** of the corruption itself (even a phone photo of the screen is
   fine) — this is the single most useful artifact, since it lets us compare the
   corruption pattern against the `-fmax-type-align=1` class already ruled out (M3
   recon) and against a heap-growth-timed screenshot if we can reproduce growth.
2. **Browser / OS / GPU**: exact Chrome version, macOS version, and GPU (integrated
   vs discrete) — corruption could be a WebGL/software-rendering-path issue specific
   to their hardware, not just an engine/wasm memory issue.
3. **How long into the session** it first appeared (elapsed wall-clock time, and/or
   what was happening in the hospital at that point — e.g., "right after the 10th
   patient arrived" or "after building the 3rd room").

## Design notes (for whoever picks this up next)

- **No engine or shell changes were made.** Heap-growth instrumentation is achieved
  entirely via `page.evaluateOnNewDocument` patching `WebAssembly.Memory.prototype.grow`
  from outside the page, before any engine script runs — verified against
  `dist/corsix-th.js` that `HEAP8`/`wasmMemory` are not exported on the `Module`
  object (so a `Module.HEAP8`-based hook, as originally sketched in the task brief,
  would not have worked without an engine-tree `EXPORTED_RUNTIME_METHODS` change).
- The Reception Desk and Hire-Staff coordinate sequences were captured against a real,
  live demo build via a scripted click→screenshot→inspect loop (not chrome-devtools-mcp
  — it has no coordinate-click primitive for canvas-rendered apps, only element-uid
  clicks, which don't exist for SDL2 canvas content). See `web/e2e-glitch.mjs`'s header
  comment for the full rationale and `docs/superpowers/reports/m3-reception-coords.png`
  for the captured evidence frame.
- `web/e2e-glitch.mjs` is runnable standalone: `cd web && npm run build && node
  e2e-glitch.mjs [chunkMs] [shotIntervalMs]` (defaults 480000/30000). Each invocation
  is one independent bounded trial; heap events and screenshots accumulate across
  repeated invocations into `m3-glitch-heap-events.json` and numbered
  `m3-glitch-NN.png` files (this report's committed screenshots were hand-curated from
  a larger raw set produced during this task — see Global Constraints on keeping the
  committed set small).
