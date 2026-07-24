# Porting DOS / 90s-Era Games to the Browser — A Field Playbook

*Distilled from the CorsixTH → WebAssembly port (Theme Hospital, in a browser tab, shipped v1).
Written for the next one — Theme Park, Syndicate, and the rest of the Bullfrog shelf.*

---

## TL;DR

You are almost never "porting a DOS binary." You are **reimplementing (or reusing a reimplementation of) the game's engine, compiling it to WebAssembly, and letting the user bring their own copyrighted data.** The engine is code you can legally redistribute; the art, levels, and music are not. Get to a real *boot* as fast as possible, make "it boots" a CI gate you can't fool, and treat everything the browser can't do natively (blocking loops, threads, MIDI, a real filesystem) as a known list of problems with known solutions. Build the reusable pieces once, because the second game is 60% the same project.

---

## 1. First, choose your approach

There is a spectrum, from "run the original" to "rewrite from nothing." Pick deliberately — this decision dominates everything downstream.

| Approach | What it is | Effort | Result | When |
|---|---|---|---|---|
| **Emulate the binary** | Run the original `.exe` in DOSBox-compiled-to-WASM (`js-dos`) | Near-zero | Playable, but *emulated* — no enhancements, quirky input/saves, the original untouched | You just want it playable this weekend |
| **Emscripten a reimplementation** | Take an existing open-source C/C++ engine reimplementation and compile it to WASM | Medium | Native-feeling, enhanceable, moddable — **our path** | An OSS reimplementation exists (CorsixTH, OpenTTD, devilutionX…) |
| **Web-native reimplementation** | Rewrite the engine directly for the web (TS + a 2D lib, ECS, etc.) | High | Best web integration, full control, shareable engine primitives | You're reimplementing anyway and want it web-first (e.g. a TS/Pixi Syndicate) |
| **Matching decompilation** | Reconstruct source that recompiles to a byte-identical binary | Extreme | Pristine source, wrong goal here | Preservation projects, not ports |

**The decision tree for "I want to port game X":**

1. **Does an open-source engine reimplementation already exist, in C/C++/SDL?**
   → **Emscripten it.** This is the cheapest good outcome. (CorsixTH gave us Theme Hospital.)
2. **Does one exist, but in a web-friendly language (TS/JS)?**
   → **Build web-native**, reuse it directly. (This is the shape of a TS/Pixi Syndicate.)
3. **No reimplementation exists?**
   → You must first **reverse-engineer the engine** (a much bigger project — that's what CorsixTH/OpenTTD *are*), **or** fall back to **emulation** for a quick-but-limited result.

> Reality check for Bullfrog specifically: **Theme Hospital** had CorsixTH (done). **Theme Park** has file-format tooling but no mature engine reimplementation — closer to greenfield. **Syndicate** has partial efforts (freesynd, Syndicate Wars ports) — check their license and completeness before committing. Each game sits at a *different* point on this tree; don't assume the Theme Hospital recipe transfers wholesale.

---

## 2. The golden rule: engine vs. assets

This split is the legal *and* technical backbone of every port. Internalize it:

- **Engine (code):** the `.exe`/reimplementation logic. Copyright protects the *expression*, not the *behavior* — so reimplementing what it does is fine, and an OSS reimplementation is redistributable under its own (usually permissive) license.
- **Assets (data):** sprites, levels, sounds, music, fonts. Copyrighted content you **may not host, bundle, or proxy.**

Therefore, universally:

> **Ship the engine. The user brings the data.** Zero game bytes in your repo, build artifacts, or deploy. Ever.

Everything else in this doc is downstream of that sentence.

---

## 3. The reimplementation → WASM playbook

This is the bulk of the work when an OSS engine exists (approach #2). In rough order:

### 3.1 Find prior art first — it's the highest-leverage hour you'll spend

Before writing anything, search for:
- An **existing browser/Emscripten attempt** on the engine (issues, PRs, forks). We found an abandoned WIP PR that had already solved the hard architectural questions (static-linking the scripting modules, the FS persistence hook) and re-derived the mistakes we'd otherwise repeat. We branched from it.
- **Sibling ports** for transferable lessons: **OpenTTD** (rejected Asyncify for `set_main_loop`; IDBFS for persistence), **OpenRCT2** (blocking-loop→callback, VFS pre-population, a `-fmax-type-align=1` sprite-corruption fix), **devilutionX** (blocked for *years* by having multiple SDL event loops), **ScummVM/OpenMW** (the engine-vs-assets model at scale).

Reusing prior art is not cheating; it's the difference between weeks and months.

### 3.2 Get to first boot — and make "boot" a gate you can't fool

Your first milestone is a single question: **does it compile *and reach real engine code* in a browser?** Not "does it compile." A build can link cleanly and still never run a line of game logic.

- Build in a **pinned Docker `emscripten/emsdk`** image (never `latest` — pin the exact tag; it pins the whole toolchain *including CMake*, which matters).
- Serve the artifacts, load them in a headless browser, and **assert a success marker that only prints after genuine initialization** — not a JS "module instantiated" log (that fires on any clean exit, including an immediate failure).
- Produce an **evidence report** for the milestone. A fully-triaged *failure* is a successful spike; it tells you exactly what to fix next.

### 3.3 The main-loop problem

Old games run a blocking loop: `while (SDL_WaitEvent(&e)) { ... }`. The browser has **one thread and cannot block it** — a blocking wait freezes the tab forever. Two solutions:

1. **Asyncify** (`-sASYNCIFY`): Emscripten rewrites the blocking calls to yield to the browser and resume. Minimal code change. **We used this**, and it passed a real latency test (rafGap p95 ≈ 17ms, vsync-clean). Costs: binary size, some edge cases.
2. **Restructure to `emscripten_set_main_loop`**: turn the loop into a per-frame callback driven by `requestAnimationFrame`. More invasive; **OpenTTD chose this and explicitly rejected Asyncify** for input lag / vsync distortion.

**Decide on numbers, not vibes.** Ship Asyncify first (it's fast to try), *instrument input latency* (PerformanceObserver long-tasks + rAF cadence over ~30s of play), and only pay for the restructure if the numbers fail. We pre-mapped the restructure as a contingency and never needed it.

> Watch for **secondary loops**. If the engine has more than one blocking event loop (dialogs, movies, load screens), Emscripten's single-event-loop model breaks — this is what stalled devilutionX. Grep for every `SDL_WaitEvent`/`SDL_PollEvent` early.

### 3.4 Go single-threaded first

The browser can do threads (pthreads → `SharedArrayBuffer`), but it demands `COOP`/`COEP` headers, which constrains where you can host. **Avoid all of it for v1:** disable the features that spawn threads.

- Compile out in-game movies (FFmpeg), hardware MIDI, and any update-checker.
- Result: **no pthreads → no SharedArrayBuffer → no COOP/COEP → deploys on any static host** (GitHub Pages, S3, anything).
- Patch any remaining stray thread (we had one async-music-loader `SDL_CreateThread`) to run synchronously under `#ifdef __EMSCRIPTEN__`.

This one decision removes a huge amount of deployment and debugging pain. Re-add threads later only if a feature truly needs them.

### 3.5 The boot-chain gremlins (a generalizable failure list)

Between "compiles" and "plays," expect a *sequence* of unrelated blockers. Ours, all of which recur across engines:

1. **Path/interpreter resolution.** Native code assumes a real OS filesystem and hunts for its data/scripts on disk. Under WASM there is no such disk — you must point the engine's data-root and script-interpreter path at the virtual FS mount explicitly (often a missing `elseif(EMSCRIPTEN)` in the build).
2. **Scripting-language version mismatch.** The engine embeds Lua/Python/etc.; the WASM toolchain's bundled version may differ and get *rejected by the engine's own version guard*. (Our toolchain shipped Lua 5.5; the engine demanded ≤5.4. Fix: build the exact version from source via FetchContent.)
3. **Linker flags that silently break codegen.** `-sEXPORT_ALL` combined with `-Os` name-minification silently broke Asyncify's exported functions → `_asyncify_start_unwind is not a function` at the first blocking call. **A build can be "green" and still be subtly miscompiled.** Isolate with a minimal repro (a 20-line `emscripten_sleep()` program) to bisect which flag kills it.

The meta-lesson: **each gremlin looks like the whole thing is broken; it's usually one layer.** Fix the first error only, rebuild, repeat. Cap triage rounds and *record* what you tried.

### 3.6 The filesystem model

Two mounts, two lifecycles, one owner:

| Mount | Backing | Contents | Lifecycle |
|---|---|---|---|
| Game data | **MEMFS** (populated at boot from an IndexedDB cache) | sprites, levels, sounds | read-only, load-once |
| User data | **IDBFS** | saves, config, screenshots | **persistent** — needs `FS.syncfs` after every write |

- The **shell owns all FS policy**, set up in `Module.preRun` *before* `main()` runs: `FS.mkdir` the mounts, `FS.mount(IDBFS, …)`, then `FS.syncfs(true, cb)` to pull existing saves — all gated by `addRunDependency`/`removeRunDependency` so the engine can't start against an empty filesystem.
- **Surface `syncfs` errors.** A save that silently fails to persist is worse than a crash — the user loses progress on reload with no warning. Propagate the failure to a visible UI banner. (The engine's own write path usually fires-and-forgets; add the hook.)
- `-sCASE_INSENSITIVE_FS=1` if the original data has mixed-case filenames (DOS-era data usually does).

### 3.7 Getting the user's assets in

The user has the game files; you must get them into IndexedDB without ever touching the bytes yourself.

- **Drag-drop / file-picker → parse (zip via a streaming unzipper, or folder traversal) → IndexedDB → populate MEMFS at boot.**
- **CORS will block a convenient direct fetch of a third-party archive** (e.g. archive.org's file servers send no `Access-Control-Allow-Origin`). This *feels* like a limitation but is actually **aligned with the legal posture** — you shouldn't be piping copyrighted bytes through your origin anyway. Resolve it as **"click this link to download from the archive, then drop the file"** (two-click) — zero bytes transit your infrastructure.
- **Memory:** ingest is a spike. Stream the archive and bound in-flight writes; don't hold the whole decompressed set in RAM. And remember **everything under the game-data mount is resident RAM at every boot** — a full install's assets live in MEMFS, which matters especially on mobile Safari. Measure it.
- **Validate** the dropped data against the files the engine actually checks for, and recover gracefully (clear + re-prompt) if it's incomplete — partial writes and quota eviction happen.

### 3.8 Audio: the MIDI / tracker problem

90s games store music as **MIDI / XMI (Miles Sound System) / MOD/tracker** — formats no browser and few WASM mixer builds can play. Sound *effects* (WAV/PCM) usually just work; **music is the hard part.**

The pattern that needs **zero engine changes**:

1. At ingest, detect the music files (e.g. `*.XMI`).
2. **Render them to audio client-side, once:** XMI → MID → PCM (via a soundfont synth) → encode to a format the engine's mixer *already* decodes.
3. Store the rendered files where the engine looks, exploiting its **"prefer a waveform sibling over the tracker file"** behavior. The engine plays your rendered audio and never touches the format it can't handle.

Concrete choices from our build:
- **Parser:** port the engine's *own* XMI→MID converter (it's field-proven on exactly this game's files, and if the engine is permissively licensed, so is the port). **Avoid GPL parsers (Exult/ScummVM)** unless your shell is GPL — porting GPL code stays GPL.
- **Synth:** a JS/WASM GM synth (we compared spessasynth / js-synthesizer / TinySoundFont — pick on license, bundle size, and a *listen test*) + a permissively-licensed GM soundfont (FluidR3, ~19MB, fetched as *your* asset — a soundfont is not game data).
- **Output format:** whatever your mixer was built with. **OGG Vorbis** is ~10-20× smaller than WAV and matters because it lives in MEMFS every boot. Keep WAV as a zero-risk fallback (its decoder is unconditionally compiled in).
- **Render off the main thread and make it lazy + retriable** — a one-shot render that fails silently (bad fetch, quota) strands the user music-less forever.
- **XMI is a shared format** across Miles-engine games (Theme Hospital, Theme Park, Warcraft II, Ultima…). Extract this pipeline as a **standalone package** — you write it once and every future Miles-based port consumes it.

### 3.9 Rendering gotchas

- **Sprite corruption / garbage tiles:** the classic suspect is **struct alignment** — Emscripten assumes natural alignment for over-aligned loads on packed data structs. OpenRCT2 fixed exactly this with `-fmax-type-align=1`. (Check first whether the engine reads multi-byte fields via byte-safe helpers vs. raw pointer casts — if byte-safe, look elsewhere: heap-growth pointer invalidation after `ALLOW_MEMORY_GROWTH` resizes, or `-Os` vs `-O2` codegen.)
- **`-sALLOW_MEMORY_GROWTH=1`** with a sane `INITIAL_MEMORY`; anything cached as a raw pointer *before* a growth event and dereferenced after is a landmine.

### 3.10 Deployment

- **Static hosting** (single-threaded build → no special headers). GitHub Pages works.
- **Relative URLs everywhere** — Pages serves under a subpath (`/repo-name/`); a single root-absolute `src="/…"` breaks it.
- **A hygiene gate before publish** that *proves* no game data ships — parse the build's preload manifest and fail if any path falls outside the engine's own (permissively-licensed) files. Automate it in CI so a mistake can't reach production.

---

## 4. Verification that actually means something

The single most valuable testing lesson from this project:

> **"It printed the welcome banner" is not "it works," and a green build is not a working boot.**

- **Boot-smoke ≠ playable.** Our early smoke test only waited for a console line — it stayed green through a build where a whole gameplay path (quickload) was a silent no-op. A console print proves the loader ran, nothing more.
- **Build a headless E2E that actually plays and make *it* the acceptance gate:** ingest demo → enter a level → mutate state → save → reload → **load and assert the state came back.** Use deterministic hooks (fixed quicksave filename, quick-save/-load *hotkeys*) instead of clicking menus, and assert a **live game-state marker** (we hashed the on-screen date region), not just "the save file still exists" — a load that restores *nothing* must **fail** the test.
- **Instrument, don't guess.** The Asyncify-vs-restructure call was made on measured latency, not opinion.
- **Real gotchas that will eat a day:** a fresh Chrome profile's *first* headless load can hang forever (prime a persistent profile); headless GPU/WebGL negotiation differs from headed; per-run IndexedDB isolation is essential or a stale save silently passes your assertion.

---

## 5. Legal & ethical posture (non-negotiable)

- Reimplement **behavior**; never redistribute copyrighted **code or assets**.
- **Zero game bytes** in repo / artifacts / deploy. The user supplies their own files.
- **Don't proxy copyrighted data** server- or client-side. (The CORS wall is a feature here.)
- **Derived content counts.** Music you *rendered* from the original XMI is still derived from copyrighted material — keep it in the user's browser storage, never commit or host it. (Even a gameplay screenshot/GIF contains the original art — treat those as share-only, not repo assets.)
- Publishers *do* issue takedowns for close-to-the-line web ports (EA / Ultima 4 is the cited precedent). Maintainers of these engines are rightly cautious — meet their bar (user-selected files, engine-only) from day one, not as an afterthought.

---

## 6. How to run the project

The methodology mattered as much as the tech:

- **Recon before planning.** Map the codebase with fast, read-only investigation and cite `file:line` facts — then plan on facts, not guesses. A plan built on "I think the main loop is around here" wastes the implementation.
- **Milestones with evidence gates.** M0 (does it boot?), M1 (reproducible build), M2 (product shell), M3 (finish the spec). Each milestone re-anchors on the previous one's *evidence report*, and each gets its own spec → plan → build → review cycle.
- **Small, always-bootable increments.** Never a big-bang rewrite. Get something running, keep it running.
- **Adversarial review as a gate, not a formality.** Every change reviewed against the spec *and* for quality before it lands; findings fixed and re-verified. Reviews caught a data-destroying IndexedDB migration risk, a hollow acceptance assertion, and a silently-hanging worker fallback that "passing" tests missed.
- **Keep a human as sponsor** for scope, legal, and taste calls — the decisions that aren't in the code.

> *If you're orchestrating this with AI agents:* parallelize with **git-worktree-isolated lanes that have disjoint file ownership** (conflicts designed out, not merged out); use **read-only recon swarms** to map fast; and demand **honest verdicts** — a documented "NOT reproduced, here's the watch-item" is worth more than a false "fixed."

---

## 7. Build the platform, not just the port

The second game is not a fresh project — it's ~60% the same one. Extract the reusable layer as you go:

- **The XMIDI → audio render pipeline** → a standalone package (done). Every Miles-engine game reuses it.
- **The web shell pattern:** onboarding (drag-drop → IndexedDB), the `Module.preRun` FS lifecycle, IDBFS persistence with error surfacing, the music orchestrator, the "unavailable/retry" UI. This is game-agnostic scaffolding.
- **The E2E + boot-smoke harness** and the **CI hygiene gate** — copy them; only the game-specific coordinates and success markers change.
- **The build recipe:** pinned emsdk Docker image, the single-threaded flag set, the boot-chain fixes.

Per-game, only these change: **asset discovery/extraction** (where *this* game's files live and how they're packed), the **engine-specific boot fixes**, and the **game-specific E2E markers**. Everything else is platform.

> Bullfrog games rhyme: isometric management/strategy sims, Miles/XMI music, similar-era C engines. That rhyme is exactly what makes a shared platform pay off across Theme Hospital → Theme Park → Syndicate.

---

## 8. Per-game starting checklist

Apply this the day you pick the next game:

1. **Reimplementation exists?** Find it. Check language and **license**. (Determines your branch of §1's tree.)
2. **Prior browser attempt?** Search issues/PRs/forks on that reimplementation. Branch from it if it exists.
3. **Asset shape:** what files, what archive format, what does the engine check for on load? Is there a **freely-distributable demo** (your onboarding on-ramp)?
4. **Music format:** MIDI/XMI/MOD? Which mixer formats does your target build decode? (Reuse the render pipeline.)
5. **Boot spike:** pinned emsdk Docker build → serve → assert a *real* success marker. Expect a chain of gremlins (§3.5).
6. **Single-threaded flag set;** main-loop strategy (Asyncify first, instrument latency).
7. **Shell:** drop-in the onboarding + FS + music platform; wire game-specific paths.
8. **E2E-as-acceptance:** ingest → play → save → reload → assert restored state.
9. **Legal gate:** engine-only deploy, user-supplied files, hygiene check in CI.

---

## 9. Reference family (and what each teaches)

- **CorsixTH** (Theme Hospital) — our subject; the engine-reuse + Emscripten path end-to-end.
- **OpenTTD** — merged Emscripten support; **`set_main_loop` over Asyncify** for input fidelity; IDBFS persistence; documented socket-API quirks.
- **OpenRCT2** — blocking-loop→callback; VFS pre-population; the **`-fmax-type-align=1` sprite-corruption** fix.
- **devilutionX** (Diablo) — cautionary tale: **multiple SDL event loops** block the single-event-loop WASM model.
- **OpenMW** (Morrowind) / **ScummVM** (dozens of adventure games) — the **engine-reimplementation-loads-original-assets** model proven at scale.
- **js-dos / DOSBox-WASM** — the emulation alternative when no reimplementation exists.

---

## 10. Mistakes we made (so you don't)

The honest appendix — the most useful section.

- **Assumed the base branch black-screened forever.** It didn't; it was three fixable gremlins (path, Lua version, a linker flag) away from a real boot. *Don't inherit a prior attempt's despair — re-verify.*
- **Shipped a hollow acceptance test.** The E2E "verified" save/load while the quickload keypress was a silent no-op — it only ever proved the *file persisted*, never that *loading worked*. Passed green for a whole milestone. *Assert live restored state, not file existence.*
- **Lost a day to a non-bug.** A "hang" we chased as a headless-GPU problem was a fresh-Chrome-profile first-load quirk. *Falsify the exciting hypothesis cheaply before committing to it.*
- **Coupled the shell to the engine's config-defaults list.** A music-config trick depends on seeding the engine's exact default keys; if upstream adds/removes one, it drifts silently. *Prefer fixing the coupling at the engine (and upstreaming it) over mirroring a list.*
- **Under-bounded ingest memory** the first time (per-reader-chunk, not per-file) — the win was real but smaller than claimed until fixed. *Measure; don't trust the naive estimate.*
- **Made music a one-shot silent-failure** initially — a bad soundfont fetch left the user permanently music-less with only a console warning. Later hardened to Worker + lazy + retriable + visible status. *Any "best-effort" background task needs a visible failure + retry path.*
- **Kept engine changes larger than necessary in a couple of spots.** The smaller and more `EMSCRIPTEN`-guarded your engine diff, the cheaper every future upstream merge. *Shrink the fork; upstream what you can — each merged delta is one you never rebase again.*

---

*This playbook is game-agnostic scaffolding. Copy it into the next port and delete what doesn't apply. The engine changes; the method doesn't.*
