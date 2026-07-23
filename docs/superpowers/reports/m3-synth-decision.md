# M3 Music Spike — Synth + Soundfont + OGG Encoder Decision (Task 2)

Branch: `wasm`. This is the evidenced decision record for M3 Task 2 (music spike). All rendered
audio and the fetched soundfont live in `$TMPDIR` only — **nothing audio-derived is committed**;
only this report, `web/src/synth.ts`, `web/scripts/fetch-soundfont.mjs`, and `package.json`/lock
changes are.

## Test corpus

Three demo tracks were confirmed present in the demo zip (`archive.org/download/HOSP_zip/HOSP.zip`,
already cached at `$TMPDIR/HOSP.zip` from a prior task):

```
SOUND/MIDI/ATLANTIS.XMI
SOUND/MIDI/NIGHTSH.XMI
SOUND/MIDI/STEADY.XMI
```

**XMI→MID conversion tool used**: per the task's allowance ("any local tool... sufficient for
these 3 files; Task 3 does the faithful port"), the engine's own `CorsixTH/Src/xmi2mid.cpp`
(MIT-licensed, same repo) was compiled as a **standalone native CLI** (a ~30-line `main()` +
a minimal `config.h` stub providing only `<cstdint>`/`<cstddef>` typedefs — no other engine code
touched or copied) — this is more faithful evidence than a hand-rolled reimplementation, since
it's the literal converter Task 3 will port. All 3 files converted cleanly to valid
`MThd`/`MTrk` Standard MIDI:

| Track | MID bytes |
|---|---|
| ATLANTIS | 43,892 |
| NIGHTSH | 24,060 |
| STEADY | 20,907 |

Independent cross-check via TinyMidiLoader (`tml_get_info`, see Candidate C below) on the
converted MID bytes — this is synth-independent (same bytes feed all 3 candidates):

| Track | channels used | programs used | notes | length |
|---|---|---|---|---|
| ATLANTIS | 6 | 5 | 11,586 | 206.4s |
| NIGHTSH | 9 | 8 | 6,540 | 195.8s |
| STEADY | 10 | 7 | 5,392 | 214.0s |

All non-trivial (multi-channel, multi-program, thousands of notes, ~3.3-3.6 min each — matches
the "~2-4min" expectation) — confirms the demo XMIs are not degenerate/near-empty streams.

## Soundfont: FluidR3.sf3

| Field | Value |
|---|---|
| URL | `https://raw.githubusercontent.com/Jacalz/fluid-soundfont/master/SF3/FluidR3.sf3` |
| SHA256 | `32039e039c2f708467a6f171fbfd9fecdcadfe40a2327837c391490c8de70021` (independently verified: downloaded + `shasum -a 256` matched exactly) |
| Size | 19,964,002 bytes |
| License | **MIT** — Frank Wen, 2000-2002/2008. Exact text: [`original-files/COPYING`](https://github.com/Jacalz/fluid-soundfont/blob/master/original-files/COPYING) in the same repo; the accompanying `original-files/README` states verbatim "I hereby release Fluid under the MIT license, as described in COPYING." |
| Format | SF3 (Ogg-Vorbis-compressed SF2) |

`web/scripts/fetch-soundfont.mjs` (written verbatim per the brief) run output:

```
fetched FluidR3.sf3 (19964002 bytes, sha256 OK)
```

— matches the brief's expected output exactly. Re-running is idempotent (`cached FluidR3.sf3
present, sha256 OK`), and `--dist` copies it into `web/dist/`. No SF2 fallback was needed — all
three synth candidates below render this exact SF3 file successfully (one, TinySoundFont,
required bundling `stb_vorbis.c` itself to decode it; see below).

## Synth candidates — evaluated on license, bundle, offline-API fit, rendered quality

All three were fed the **identical** converted MID bytes above and the **identical** FluidR3.sf3,
rendered offline (no AudioContext, no realtime playback) to 44.1kHz stereo Float32 PCM, in Node
(not a browser) — proving the offline-render code path directly.

### A. spessasynth_core 4.3.15 — **WINNER**

- **License**: Apache-2.0 (npm `license` field + `LICENSE` file both confirm). Pure TS/JS, one
  package, no companion wasm binary.
- **API fit**: verified against spessasynth_core's own upstream example
  (`examples/midi_to_wav_node.ts`, fetched from GitHub since it's not shipped in the npm tarball)
  — the API in the task brief's draft (`SpessaSynthProcessor`/`MIDI` import, `soundfontManager`)
  is **stale for this version**; the real 4.3.15 shape is `BasicMIDI.fromArrayBuffer`,
  `SoundBankLoader.fromArrayBuffer`, `new SpessaSynthProcessor(sampleRate, {eventsEnabled:false})`,
  `synth.soundBankManager.addSoundBank(...)`, `new SpessaSynthSequencer(synth)`,
  `seq.loadNewSongList([midi])`, `seq.play()`, then a plain loop of `seq.processTick()` +
  `synth.process(left, right, offset, n)`. Zero AudioContext, zero wasm-loading step — runs
  identically in Node, a Worker, or the main thread. `web/src/synth.ts` was written against this
  real API (not the brief's stale sketch) and is the simplest of the three integrations.
- **SF3 support**: native — `SoundBankLoader` decodes the compressed samples with no extra
  dependency.
- **Bundle** (`esbuild --bundle --minify --format=esm --platform=browser` of the actual
  `web/src/synth.ts`): **389,551 bytes minified / 124,123 bytes gzip**. Self-contained — this is
  the entire cost, no separate wasm blob to host.
- **Render time**: ATLANTIS 3,001ms / NIGHTSH 2,091ms / STEADY 2,730ms wall-clock for ~3.3-3.6min
  tracks (≈70-100x real-time).

### B. js-synthesizer 1.13.0 (libfluidsynth-emscripten 2.4.6) — fallback

- **License**: wrapper is BSD-3-Clause (npm `license` field + LICENSE file); the actual synth core
  is `fluidsynth-emscripten`, **LGPL-2.1-only** (confirmed via
  `js-synthesizer/libfluidsynth/package.json`'s `"license": "LGPL-2.1-only"` and the README's
  explicit callout). Acceptable for a hosted static site per the brief's guidance (dynamically
  loaded wasm, not statically linked into proprietary code).
- **API fit**: works standalone in Node via the documented path
  (`require('js-synthesizer/libfluidsynth')` + `JSSynth.Synthesizer.initializeWithFluidSynthModule`
  + `waitForReady()`), then `init(sampleRate)` → `loadSFont` → `addSMFDataToPlayer` →
  `playPlayer()` → pull frames via `render([left, right])` while `isPlayerPlaying()` — matches the
  brief's Step-3 fallback shape exactly. Heavier than A: an explicit wasm-module-init step plus a
  companion glue file to load.
- **SF3 support**: requires the `-with-libsndfile` build variant (the plain variant can't decode
  our SF3). `js-synthesizer/libfluidsynth` resolves to this variant by default, confirming it's the
  one to use.
- **Bundle**: wrapper alone (`esbuild --bundle --minify` of an equivalent `renderMidiToPcm`) is
  **24,007 bytes minified / 6,113 bytes gzip** — tiny. But it requires the externally-loaded
  `libfluidsynth-2.4.6-with-libsndfile.js` (Emscripten MODULARIZE glue+wasm, **not**
  esbuild-bundled per upstream's own `<script>`-tag-based integration story):
  **2,371,527 bytes / 895,638 bytes gzip**. Total realistic cost ≈ **2.40MB uncompressed /
  ≈902KB gzip** — ~6x spessasynth_core's total, dwarfing the wrapper's own tiny size.
- **Render time**: ATLANTIS 1,921ms / NIGHTSH 1,144ms / STEADY 1,468ms (fastest of the three, but
  bundle cost is the deciding factor against it).

### C. TinySoundFont (tsf.h 0.9 + tml.h + stb_vorbis.c) — real emcc build, smallest bundle, declined

Per the sponsor research note, this candidate needed an actual tiny wasm build to evaluate fairly
(not just theory). Docker was already set up in this repo for the engine build, so the **exact
pinned image** (`emscripten/emsdk:6.0.3`) was reused to compile a genuine wasm module:

- **License**: `tsf.h`/`tml.h` are MIT (Bernhard Schelling, schellingb/TinySoundFont, verified from
  the fetched header's license block). `stb_vorbis.c` (needed for SF3 sample decode — TSF only
  decodes Vorbis-compressed SF3 samples if you supply it yourself) is public domain
  (nothings/stb). All three permissive, no build-tooling license concerns.
- **API fit**: no npm package exists for a maintained TSF-wasm build (`tsf`/`tinysoundfont`/
  `tsf-wasm`/etc. on npm are all either unrelated or 404 — confirmed by direct registry lookups).
  This candidate requires **writing and maintaining our own C harness** (a ~70-line
  `render_midi()` wrapping `tsf_load_memory` + `tml_load_memory` + a `tml_message`-driven event
  loop calling `tsf_channel_note_on/off`/`tsf_render_float`) and **our own Docker/emcc build step**
  — real, ongoing project overhead beyond `npm install`, even though the runtime call shape once
  built (`Module._malloc`/`HEAPU8.set`/`Module._render_midi`/`HEAPF32`/`Module._free_buffer`) is
  simple.
- **SF3 support**: works, but only after bundling `stb_vorbis.c` and defining the integration
  macro `tsf.h` expects (`STB_VORBIS_INCLUDE_STB_VORBIS_H`, which is `stb_vorbis.c`'s own include
  guard — it must be *included*, not manually pre-defined, or its implementation gets skipped;
  this cost real debugging time during this spike).
- **Bundle**: compiled via `emcc tsf_wasm.c -O3 -s MODULARIZE=1 -s ALLOW_MEMORY_GROWTH=1 ...`:
  JS glue 10,959 bytes (5,888 minified/2,871 gzip) + wasm 101,101 bytes (48,913 gzip) = **106,989
  bytes total uncompressed / 51,784 bytes gzip** — by far the smallest of the three (confirms the
  sponsor research note's expectation), ~3.6x smaller gzipped than spessasynth_core and ~17x
  smaller than js-synthesizer's realistic total.
- **Render quality gotcha (real finding)**: the default `tsf_set_output(..., 0.0f)` master gain
  **clips** (peak abs sample >2.0 across all 3 tracks) — TSF does no automatic headroom
  management the way the other two do internally. Using `-10.0f` (upstream's own
  `examples/example3.c` uses exactly this) fixes it to a peak range (0.50-0.73) comparable to the
  other candidates. Not a synthesis defect, but a real "you must know to do this" gotcha —
  consistent with the sponsor research's stated "known lower fidelity"/less-polished-defaults
  trade-off for TSF vs. FluidSynth-class engines.
- **Render time**: ~1.9-3.8s per track, native and wasm equally (numerically cross-verified: the
  wasm build's PCM analysis — peak/RMS/spectral-centroid — is byte-for-byte identical to the
  native CLI build's, to 5 decimal places, confirming the wasm build is functionally correct, not
  just "compiles").
- **Verdict**: declined. The ~72KB gzip bundle saving vs. spessasynth_core is real but marginal
  next to the 19.96MB soundfont fetch it sits beside, and doesn't justify taking on a bespoke
  Docker/emcc build step as an ongoing maintenance surface for this project (the M3 plan's global
  constraint is also "no engine-tree/build-tooling changes" in spirit — TSF is the only candidate
  that would introduce a *second* wasm build pipeline alongside the engine's).

### Rendered-audio evidence (all 3 candidates × all 3 tracks — 9 renders total)

44.1kHz stereo Float32 PCM, analyzed with a self-contained Node script (peak/RMS + a radix-2 FFT
crude spectral check: bins-above-noise-threshold, DC-energy fraction, spectral centroid). All 9
renders **pass every check**: non-silent (peak > 0.01), duration in a sane 60-400s envelope
(actual: 195.4-217.1s, i.e. ~3.3-3.6min — matches "~2-4min" expectation), and spectrally
non-degenerate (thousands of non-DC bins carry energy, not a silence/DC-only signal).

| Candidate | Track | duration(s) | peak | RMS | spectral centroid (Hz) | bins>thresh | dcFraction |
|---|---|---|---|---|---|---|---|
| spessasynth_core | ATLANTIS | 206.49 | 0.848 | 0.0756 | 4763.5 | 4096 | 0.0008 |
| spessasynth_core | NIGHTSH | 196.35 | 0.678 | 0.0688 | 4758.9 | 3927 | 0.0001 |
| spessasynth_core | STEADY | 213.57 | 0.892 | 0.1065 | 4625.6 | 4096 | 0.0007 |
| js-synthesizer | ATLANTIS | 212.51 | 0.888 | 0.0849 | 3165.1 | 4091 | 0.0006 |
| js-synthesizer | NIGHTSH | 205.73 | 0.735 | 0.0783 | 4156.0 | 4088 | 0.0005 |
| js-synthesizer | STEADY | 217.06 | 0.958 | 0.1225 | 4084.9 | 4094 | 0.0015 |
| TinySoundFont (-10dB) | ATLANTIS | 207.40 | 0.645 | 0.0676 | 1562.0 | 4096 | 0.0015 |
| TinySoundFont (-10dB) | NIGHTSH | 196.79 | 0.504 | 0.0590 | 6546.3 | 4084 | 0.0003 |
| TinySoundFont (-10dB) | STEADY | 215.04 | 0.725 | 0.0726 | 5701.0 | 4094 | 0.0003 |

(All rendered PCM lives only under `$TMPDIR/m3-music-spike/renders/`, never in the repo.)

## Decision: **spessasynth_core**

Apache-2.0 (cleanest license — no LGPL core, no bespoke build tooling), self-contained bundle
(389KB min/124KB gzip, no separate wasm blob to host — deploy is `npm install` + esbuild, nothing
else), native SF3 support (zero extra dependency for our chosen soundfont), the simplest offline
API of the three (verified 1:1 against upstream's own Node example), and it passes every
render-quality check on all 3 real demo tracks. This matches the brief's decision guidance exactly
("prefer spessasynth_core if its license is Apache-2.0/MIT-class and its offline API renders
correctly"). `web/src/synth.ts` is written and smoke-tested against this real API (see below).

TinySoundFont's bundle is smaller by ~72KB gzip, but that's marginal next to the 19.96MB soundfont
it ships alongside, and it's the only candidate that would require this project to stand up and
maintain a second wasm build pipeline (Docker/emcc) beyond the engine's own — declined.
js-synthesizer's LGPL-2.1 core is legally fine but its realistic bundle cost (~902KB gzip, because
SF3 support requires the `-with-libsndfile` variant) and heavier module-init API make it the
documented fallback only, not the winner.

## `synth.ts` acceptance (spike Step 4)

Smoke-rendered a minimal hand-built 2-note Standard MIDI file (format 0, 480 PPQN, program 0,
C4→E4) through the **actual, unmodified, esbuild-bundled `web/src/synth.ts`**, against the real
fetched `web/.assets/FluidR3.sf3`:

```json
{"channels":2,"frames":88200,"durationSec":2,"peakAbsSample":0.11056,"renderMs":54}
PASS: synth.ts smoke render OK (non-silent, non-zero duration)
```

Also re-ran the same bundled `synth.ts` against the real ATLANTIS.mid demo track for a fuller
check — output is numerically identical to the Candidate-A probe render above (frames=9,106,283,
duration=206.492s, peak=0.84779), confirming `synth.ts` reproduces the winning candidate's
evaluated behavior exactly (not a divergent reimplementation).

## OGG Vorbis encoder decision (plan amendment: primary output format)

- **`wasm-media-encoders` 0.7.0 — winner (only viable candidate)**. MIT license (LICENSE file
  confirmed). Real API (verified via README + reading `dist/es/index.mjs` directly, since it's not
  in context7's index either): `createOggEncoder()` → `.configure({sampleRate, channels,
  vbrQuality})` → `.encode([left, right])` (called incrementally) → `.finalize()` (drains the
  tail). `ogg.wasm` is 450,589 bytes (upstream's README states 158 KiB combined+gzipped for the
  Ogg path).
  - **Functional test**: encoded all 3 rendered demo tracks (spessasynth_core's PCM output) to
    real Ogg Vorbis files — `OggS` magic bytes confirmed on every output — at multiple quality
    settings:

    | vbrQuality | ATLANTIS bytes | ATLANTIS kbps | NIGHTSH bytes | NIGHTSH kbps | STEADY bytes | STEADY kbps |
    |---|---|---|---|---|---|---|
    | 0 | 1,588,424 | 61.5 | — | — | — | — |
    | 1 | 1,983,112 | 76.8 | — | — | — | — |
    | 2 | 2,402,985 | 93.1 | — | — | — | — |
    | 3 | 2,920,724 | 113.2 | — | — | — | — |
    | 4 (package default) | 3,374,904 | 130.8 | 3,111,913 | 126.8 | 3,704,856 | 138.8 |

    q3 (~113kbps) is the closest match to the plan amendment's "~q4/~110kbps" sizing assumption;
    q4 is the package's own default and renders slightly larger/higher-quality. **Recommend Task 3
    default to `vbrQuality: 3`** to land closest to the ~1.5-2MB/track budget the sizing amendment
    assumed (actual measured range at q3 is closer to ~2.9MB for a ~3.5min track — tracks are
    longer than the amendment's estimate assumed, so even q3 runs a bit over; q0-q2 are available
    if Task 3 needs to trade quality for size further).
- **`ogg-vorbis-encoder-js` — does not exist.** 404 on the npm registry; no matching GitHub repo
  found via search either. Confirmed dead end, no further evaluation possible or needed — the
  brief's own fallback note anticipated this.
- `wasm-media-encoders` was added to `web/package.json` dependencies now (Task 3 will wire the
  actual `encode`/`finalize` calls into `music-render.ts`); `wav.ts`/`encodeWav` remains the
  documented zero-risk fallback per the plan amendment and is unchanged/unbuilt by this spike.

## Files touched by this spike

- `web/src/synth.ts` — created, against spessasynth_core's real API.
- `web/scripts/fetch-soundfont.mjs` — created, verbatim per brief (URL/hash unchanged — no
  soundfont switch was needed).
- `web/package.json` — added `fetch-assets` script, `spessasynth_core` + `wasm-media-encoders`
  dependencies.
- `web/.gitignore` — added `.assets/`.
- `web/package-lock.json` — updated by `npm install`.
- This report.

No engine-tree files touched. No audio or soundfont binary committed — everything reproducible
(rendered PCM/OGG, the native `xmi2mid` CLI, the TSF wasm build) lives only under
`$TMPDIR/m3-music-spike/`.
