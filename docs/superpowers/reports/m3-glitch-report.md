# M3 Task 4 — Bounded Glitch-Repro Report

**Verdict: SPRITE CORRUPTION NOT REPRODUCED.** Watch-item + sponsor-evidence
request below. **v1.x update:** a separate, severe engine crash (uncaught
Lua/WASM runtime errors, full simulation freeze — not sprite garbling) was
reproduced once during GP's Office room-construction UI automation, but was not
reliably reproducible in 3 follow-up attempts; see the "v1.x addendum" section
near the end of this file for full details, evidence, and an updated watch-item.

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

> **Update (post-review):** at the time chunks 0–3 ran, "zero heap-growth events"
> was **instrument unproven at the time** — nothing forced a real `grow()` call to
> confirm the `WebAssembly.Memory.prototype.grow` patch actually fired, so "0
> events" was indistinguishable from "the hook never engaged." The harness now
> self-validates the hook every session (see "Instrumentation self-validation
> follow-up" below), and the **re-validated instrument shows the same flat-memory
> behavior in the validation chunk** — i.e., this finding stands, but it is now
> backed by a proven-live instrument rather than an unverified one.

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

## Instrumentation self-validation follow-up

The M3 Task 4 reviewer flagged two Important gaps in the original harness
(`web/e2e-glitch.mjs`), both now fixed:

1. **Hook never self-validated.** Nothing proved the `WebAssembly.Memory.prototype.grow`
   patch actually fired — "0 events" was unverifiable, indistinguishable from the
   hook silently never engaging. **Fix:** immediately after boot, once per session,
   the harness now forces a real `new WebAssembly.Memory({initial:1}).grow(1)` call
   in-page, tags that event `{selfTest: true}`, and hard-asserts exactly one such
   event was logged — aborting loudly (non-zero exit, no data collected) if not.
2. **Two uncorrelated clocks.** Heap-growth events were timestamped with the page's
   `performance.now()`; screenshots were timestamped with the Node process's
   `Date.now() - chunkStart`, with no recorded relationship between the two clocks —
   correlating a heap event to a screenshot was impossible. **Fix:** at the start of
   each chunk's monitoring loop, a single in-page `evaluate()` call now captures
   `{ chunkStartEpochMs: Date.now(), chunkStartPerfMs: performance.now() }` at the
   same instant and records it as `chunkStartAnchor` in that chunk's JSON record,
   giving a common reference point to convert any `heapGrowthEvents[].tMs` into the
   same wall-clock frame as `screenshots[].tMs`.

**Re-validation run (chunk 4, ~2.5 min bounded chunk, appended to
`m3-glitch-heap-events.json`):**

- Self-test **PASSED**: `{"tMs":512,"deltaPages":1,"beforeBytes":65536,"afterBytes":131072,"selfTest":true}`
  — proving the grow-hook is live and captures real `grow()` calls correctly.
- `chunkStartAnchor` present: `{"chunkStartEpochMs":1784822903193,"chunkStartPerfMs":19649.4}`.
- Aside from the forced self-test event, **zero** engine-driven growth events
  occurred during the chunk, and `usedJSHeapSize` stayed flat at **~53.6MB** — in
  the same range as chunks 0–3 (~51–52MB). The flat-memory finding is unchanged;
  it is now backed by a hook proven live rather than an unverified one.
- No visual corruption observed in this chunk's screenshots either (consistent with
  Finding 1).

Both fixes live in `web/e2e-glitch.mjs`; no changes were made to the CI-green
`web/e2e-playable.mjs`. Chunk 4's raw screenshots were not added to the committed
set (kept small per existing convention above) — the validated data lives in the
JSON's `chunks[4]` record (`selfTestPassed`, `selfTestEvent`, `chunkStartAnchor`,
`heapGrowthEvents`, `perfMemoryAtEnd`).

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

## v1.x addendum: GP's Office automation attempt + long sprite-dense session

This addendum covers the watch-item's identified next step: get past Reception
Desk + Receptionist into an actively-diagnosing hospital (a built, staffed GP's
Office), then run a long instrumented session against that richer state.

### GP's Office room-construction automation: where it breaks

Room construction is a materially different UI flow from the single-click object
placement used for the Reception Desk (confirmed via engine-source read of
`CorsixTH/Lua/dialogs/edit_room.lua`, `bottom_panel.lua`, `place_objects.lua`):
open the "Build rooms" toolbar icon → pick the "Diagnosis" category tab → pick
"GP's Office" (first row, `rooms/gp.lua`'s `categories.diagnosis = 1`, so it needs
no research and is available immediately) → **drag** a rectangular wall footprint
(minimum 4×4 tiles, `rooms/gp.lua:35`) → click a wall edge to place a door → click
Confirm.

Per the brief, this automation pass was done **interactively via Chrome DevTools
MCP** against a fresh server (port 8129) and a dedicated Chrome instance, since
(as already noted in this file's Design section) that MCP has no raw-coordinate
click/drag primitive for canvas content — so each step used `evaluate_script` to
dispatch synthetic `mousedown`/`mousemove`/`mouseup` events directly at the
canvas element (verified working: it drives the exact same input path Reception
Desk/Hire Staff automation already uses). Toolbar navigation, category selection,
and room-type selection all worked first try. The **drag-to-define-footprint**
step took several iterations to land a rectangle that rendered fully valid (no
red overlap tiles) — early attempts were too small, overlapped the existing
Reception Desk building, overlapped the outer plot wall, or drifted onto the
outdoor grass verge outside the buildable plot; the final working footprint used
canvas-fraction anchors `(0.72, 0.36)` → `(0.72, 0.62)` at the harness's standard
960×720 viewport (see `docs/superpowers/reports/m3-glitch-gp-office-blueprint-stuck.png`).

**This is the breaking point:** even with a footprint that renders with zero red
(invalid/overlap) tiles, the Confirm button never activates. This was checked two
independent ways, both gated in the engine source on the exact same
`self.confirm_button.enabled` flag (`CorsixTH/Lua/dialogs/edit_room.lua:207-211`,
`window.lua:1591`):
1. A direct click on the Confirm button's screen position (verified correctly
   aligned — a "Confirm" tooltip and hand cursor render there).
2. The documented `global_confirm`/`global_confirm_alt` hotkeys (Enter / `e`,
   `config_finder.lua:581-582`), which `UIEditRoom:confirm` explicitly re-checks
   against the same enabled flag even when invoked via hotkey.

Neither ever advanced the dialog past the walls phase. Per
`edit_room.lua:1189-1230`, `confirm_button:enable(is_valid)` is set from a single
opaque boolean returned by a **native C++ function**
(`map.th:updateRoomBlueprint`, implemented in `CorsixTH/Src/th_lua.cpp` — outside
this task's Lua-level read), not from the simple per-tile red/blue overlap
rendering a screenshot can show. So a rectangle that *looks* fully valid can still
have `is_valid == false` for a reason opaque to black-box UI automation (the two
most likely candidates given the Lua source contains no plot-boundary or
decorative-object checks: a plot-ownership/buildable-area rule, or a stricter
geometric constraint than "no visible overlap" — both live in native code this
task did not read). **Conclusion: room construction cannot be completed via
UI automation within this task's bounded effort** (well past 3 focused attempts
once sub-attempts at finding a valid footprint and diagnosing the Confirm gate
are counted) — this is the honest stopping point the brief anticipated
("record exactly where it breaks... fall back... bounded honesty over burn").

### A genuine crash was reproduced once during this exploration

While iterating on the footprint drag (many small/overlapping/reversed-direction
drags in one interactive session, followed by a Confirm click attempt), the
engine hit **three uncaught, unrecoverable Lua/WASM runtime errors** and the
entire simulation froze — the in-game date and money stopped advancing, and
neither the Confirm nor Cancel button produced any further effect (checked by
waiting several seconds and re-screenshotting, then clicking Cancel: zero visual
change). Console errors (with full stack traces, on file in the session
transcript):
```
Uncaught RuntimeError: table index is out of bounds   (×2)
Uncaught (in promise)                                  — Asyncify doRewind/handleSleep chain
Uncaught RuntimeError: null function
Uncaught RuntimeError: memory access out of bounds     — appeared ~4s after the first two
```
`performance.memory.usedJSHeapSize` at the time of the freeze was ~41MB — in the
same flat range as every other session in this investigation, i.e. **this crash
was not preceded by a heap-growth event**, arguing against the heap-growth
hypothesis as this particular crash's cause (though it doesn't rule out a
separate, non-growth memory-corruption path — "memory access out of bounds" is
consistent with either a genuine Lua logic bug or actual wasm heap corruption;
distinguishing the two would need native-code-level debugging out of scope here).

**Reproducibility: not achieved.** Two follow-up attempts — a fast clean replay of
the exact same final action, and a fast then a slow (matching the original's
pacing) replay of the *entire* invalid-drag-then-valid-confirm sequence — both
completed without any error. This is consistent with a timing-sensitive/
non-deterministic trigger (plausible given the errors surfaced through the
engine's Asyncify coroutine-rewind machinery, `corsix-th.js`'s `doRewind`/
`handleSleep`, which is inherently sensitive to real-world event timing) rather
than a deterministic function of the click sequence alone — and is honestly a
closer match to the sponsor's own vague "after playing for a while" description
than a hard, always-reproducible bug would be. **This is escalated as a new,
stronger watch-item entry below**, not folded into "reproduced" with false
confidence.

### Long sprite-dense session (fallback: Reception Desk + Receptionist, as before)

Since GP's Office construction could not be completed, the long session used
this task's only *proven-functioning* populated-hospital setup — the same
Reception Desk + Receptionist flow as the original 4 trials — run for
substantially longer to give the heap-growth hypothesis a much larger, harder-to-
dismiss negative if nothing shows up.  Run against a **dedicated profile dir**
(`GLITCH_PROFILE_DIR`, now a first-class option on `web/e2e-glitch.mjs` — see that
file's diff) so this ~32-minute session wouldn't hold an exclusive Chrome
`userDataDir` lock against the other lanes' concurrent use of the harness's
default shared profile.

| chunk | wall-clock | heap-growth events (non-self-test) | `usedJSHeapSize` at end | notes |
|---|---|---|---|---|
| 5 (smoke) | 1 min | 0 | 39.4MB | profile warm-up validation |
| 6 | 8 min | 0 | 46.2MB | |
| 7 | 8 min | 0 | 46.0MB | |
| 8 | 8 min | 0 | 46.2MB | |
| 9 | 8 min | 0 | 49.8MB | in-game date reached 1 Jan (year 2000); year-end Charts screen reconfirmed "Most Visitors: 0" for every entity — Finding 2 (no GP's Office ⇒ no patients) holds at this longer duration too |

All 4 long (8-minute) chunks plus the smoke chunk ran to completion with no
visual corruption in any of the 4×16 = 64 periodic screenshots inspected
(spot-checked in full; two representative frames pulled for this addendum,
`m3-glitch-124.png`-equivalent and the chunk-9 Charts screen — not committed
individually per the existing "keep the committed set small" convention,
since they show the same flat/uneventful state as the already-committed
`m3-glitch-03`/`m3-glitch-04` frames).

**Correction — this session was NOT fully error-free.** An earlier draft of
this addendum claimed "no crash, no engine error" here; the committed data
does not support that. `m3-glitch-heap-events.json`'s `consoleTail` (the last
30 console lines recorded before each chunk's browser session closed) shows
a `pageerror` in 3 of the 4 long chunks — chunk 6 (`null function`), chunk 7
(`function signature mismatch`), and chunk 9 (`null function` followed by
`memory access out of bounds` ×2); chunk 8 alone shows none. This is the
SAME error vocabulary as the room-drag crash reproduced earlier in this
report (`RuntimeError: null function`, `RuntimeError: memory access out of
bounds`), not a distinct, unrelated failure mode.

In every occurrence, the `pageerror` is literally the last line captured
before that chunk's harness (`web/e2e-glitch.mjs`) runs its end-of-chunk
sequence — a best-effort quicksave (itself an Asyncify-driven filesystem
sync) immediately followed by `browser.close()`. That timing is consistent
with a teardown-artifact hypothesis: the automated shutdown drives the
engine through the same Asyncify unwind/rewind machinery implicated in the
room-drag crash, and closing the browser while that is in flight could
plausibly surface a spurious `pageerror` reflecting the teardown itself
rather than an in-game defect.

That hypothesis does not make these errors safe to dismiss, though. This is
the SAME crash family recurring in 3 of 4 independent chunks under
**passive**, fast-forwarded Reception Desk + Receptionist play — zero active
room-construction UI manipulation — the exact condition this addendum
otherwise reports as clean. A crash family reappearing even in passive
sessions, at a 3-of-4 rate too high to dismiss as noise, argues the
underlying defect is not confined to active room-drag stress. Whether the
proximate trigger is the harness's own teardown sequence or something
reachable from ordinary accelerated simulation, either reading strengthens —
not weakens — the crash watch-item below; "no crash, no engine error" was
the wrong takeaway from this data and is retracted here.

Across all of today's chunks, `usedJSHeapSize` again stayed flat (~39-50MB,
consistent with every prior chunk in this file, including chunk 4's earlier
self-validation run) and zero real (non-self-test) heap-growth events fired.
Combined with the original 4 trials, this investigation has now observed **zero
engine-driven heap-growth events across 9 independent sessions and roughly
65+ minutes of monitored wall-clock time**, entirely under Reception Desk +
Receptionist conditions (no diagnosis room ever functioning). The flat-memory
finding (Finding 1) is unchanged and now backed by substantially more data.

### Updated watch-item

- **Status:** open, unresolved, but materially changed. The original watch-item
  ("no sprite-dense session was reached at all") is now a **much stronger
  negative**: even with room-construction UI automation attempted directly
  (not just requested as future scope), and even with a session length roughly
  double the original, no visual sprite corruption was observed and no
  heap-growth event fired outside the self-test.
- **New, separate watch-item (crash, not sprite corruption) — now STRENGTHENED
  by the long-session data above, not just a single active-manipulation
  incident:** a real, uncaught Lua/WASM crash (full freeze, three distinct
  runtime-error strings: `null function`, `memory access out of bounds`,
  `table index is out of bounds`) was first observed during **active
  room-construction UI manipulation** (not idle/fast-forwarded simulation),
  and was not reproducible in 3 immediate follow-up attempts of that same
  interaction. The SAME error vocabulary (`null function`,
  `memory access out of bounds`, plus `function signature mismatch`) then
  recurred as the final `consoleTail` entry in 3 of the 4 long **passive**
  chunks in the table above — sessions with zero room-construction UI
  manipulation at all. A teardown-artifact explanation is plausible for the
  passive-session occurrences (see the correction above) but does not fully
  explain away a 3-of-4 recurrence rate of the identical error family across
  two very different interaction modes (active drag-stress and idle
  fast-forward). Taken together this is a genuine engine defect reachable
  from mainline interaction (not confined to UI-automation-stress-level
  input), and is worth a dedicated follow-up task with real native-code
  debugging (`CorsixTH/Src/th_lua.cpp`'s `l_map_updateblueprint`, whatever Lua
  callback the Asyncify `doRewind` stack trace was resuming into, and — for
  the passive-session occurrences — `web/e2e-glitch.mjs`'s end-of-chunk
  quicksave/`browser.close()` sequence) rather than further black-box UI
  automation, which has now been pushed about as far as it usefully can be
  without that access.
- **What would move the sprite-corruption question forward:** unchanged from the
  original report — either a follow-up task with the native-code access needed to
  fix/re-attempt the GP's Office Confirm gate (so an actually-treating-patients
  session becomes reachable), or the sponsor's own repro session as evidence (see
  below, unchanged).
