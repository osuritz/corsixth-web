# xmidi-render-kit

*(working name — not yet published; see the "Publish checklist" note in the sibling report
for name alternatives under consideration)*

Convert **Miles Sound System XMIDI (`.xmi`)** music — the format behind Theme Hospital, Theme
Park, Warcraft II, and dozens of other early-90s DOS/Windows games — into a standard MIDI
file, render it offline with a General MIDI SoundFont, and encode the result to OGG Vorbis or
WAV. Pure TypeScript, zero DOM assumptions: runs identically in Node, browsers, and Workers.

## Scope (read this before filing a bug)

This is a **Theme-Hospital-proven XMIDI subset**, not a complete implementation of the XMIDI
spec:

| Feature | Status |
|---|---|
| Inline note-on durations (note-off synthesis) | ✅ Implemented |
| Fixed ~120Hz XMIDI timebase → MIDI PPQN/tempo | ✅ Implemented |
| `TIMB` timbre chunk (bank/patch setup) | ✅ Passed through as opaque meta data |
| `RBRN` branch/loop chunks (CC 116/117 seamless loops) | ❌ Not implemented |
| MT-32 → GM patch remap | ❌ Not implemented (assumes GM-mapped source) |
| Multi-song `.xmi` containers | ❌ Only the first `EVNT` chunk is read |

The parser (`transcodeXmiToMid`) has been battle-tested end-to-end against Theme Hospital's
own XMI corpus (in the sibling [corsixth-web](https://github.com/CorsixTH/CorsixTH) project)
but not against other games' `.xmi` files, which may exercise the unimplemented branch-loop or
MT-32 paths. **Contributions welcome** — especially an `RBRN` implementation and an MT-32→GM
remap table, both called out as gaps in the upstream research this package's parser derives
from.

## Quickstart

```ts
import { readFileSync, writeFileSync } from 'node:fs';
import { renderXmiToAudio } from 'xmidi-render-kit';

const xmi = readFileSync('track.xmi');
const soundfont = readFileSync('FluidR3.sf3'); // see "SoundFont" below — not bundled

const { bytes, format } = await renderXmiToAudio(xmi, soundfont);
writeFileSync(`track.${format}`, bytes); // -> track.ogg (or track.wav on fallback)
```

That's the whole quickstart — XMI in, OGG out, in under 10 lines. For finer control, drop
down to the individual stages:

```ts
import { transcodeXmiToMid, renderMidiToPcm, renderXmiToAudio } from 'xmidi-render-kit';

// Stage 1: XMI -> standard MIDI bytes (synchronous, no I/O).
const mid = transcodeXmiToMid(xmi);
if (!mid) throw new Error('not a valid XMI (no EVNT chunk, or corrupt event stream)');

// Stage 2: MIDI + SoundFont -> planar stereo Float32 PCM ({ left, right }).
const { left, right } = await renderMidiToPcm(mid, soundfont, 22050);

// Stage 3 (the one-liner above does stages 1-3 + encoding together):
const result = await renderXmiToAudio(xmi, soundfont, {
  format: 'ogg',      // or 'wav' to skip the OGG encoder entirely
  vbrQuality: 3,       // 0 (smallest) - 10 (highest quality); default 3
  sampleRate: 22050,   // Hz; default 22050
});
```

## API

- **`transcodeXmiToMid(xmi: Uint8Array): Uint8Array | null`**
  Parse XMIDI event bytes and emit a standard Format-0 MIDI file. Returns `null` if `xmi` has
  no `EVNT` chunk or its event stream is truncated/corrupt.

- **`renderMidiToPcm(mid: Uint8Array, soundfont: Uint8Array, sampleRate: number): Promise<{ left: Float32Array; right: Float32Array }>`**
  Render a standard MIDI file to planar (per-channel) stereo Float32 PCM using a GM SoundFont
  (SF2/SF3), via [spessasynth_core](https://github.com/spessasus/spessasynth_core). `left` and
  `right` are always the same length. The render spans the full song length plus a 1-second
  tail so the last notes' release/reverb aren't cut off.

- **`renderXmiToAudio(xmi: Uint8Array, soundfont: Uint8Array, opts?: RenderXmiToAudioOptions): Promise<{ bytes: Uint8Array; format: 'ogg' | 'wav' }>`**
  The end-to-end pipeline (stages 1-3 above combined). `opts.format` defaults to `'ogg'`; if
  OGG encoding fails for any reason, this **silently falls back to WAV** — check the returned
  `format` field to see which one you actually got. Pass `format: 'wav'` to skip the OGG
  encoder entirely.

- **`encodeWav(pcm: Float32Array, sampleRate: number, channels: number): Uint8Array`**
  Standalone canonical 44-byte-header PCM WAV encoder, used internally as the fallback
  container and exported for callers who want WAV output without going through
  `renderXmiToAudio`.

Full parameter/return docs are in the shipped `.d.ts` (hover in your editor, or read
`dist/index.d.ts` / the JSDoc comments in `src/render.ts` and `src/synth.ts`).

## SoundFont

**This package does not bundle a SoundFont.** You must supply your own SF2 or SF3 file to
`renderMidiToPcm` / `renderXmiToAudio`. A good freely-licensed General MIDI option:

```ts
// One-time fetch, e.g. in a setup script — SHA256-pin whatever URL you use in production.
const res = await fetch('https://raw.githubusercontent.com/Jacalz/fluid-soundfont/master/SF3/FluidR3.sf3');
const soundfont = new Uint8Array(await res.arrayBuffer());
```

**FluidR3 GM** (Frank Wen, 2000-2002/2008) is MIT-licensed; license text confirmed at
https://github.com/Jacalz/fluid-soundfont/blob/master/original-files/COPYING (mirrored
verbatim from the original Fluid release). This package's own tests fetch it the same way —
see `scripts/fetch-soundfont.mjs`.

## Runtime environments

Verified (by inspection — `grep -rn "window\.\|document\." src/`) to have no `window`/
`document`/other DOM references anywhere in this package's own source (`src/**/*.ts`,
excluding the `spessasynth_core` and `wasm-media-encoders` dependencies, which are themselves
isomorphic — `spessasynth_core` builds with esbuild's `--platform neutral`, and
`wasm-media-encoders` embeds its WASM as an inline base64 data URI rather than fetching a
file). `tsconfig.json` includes the `DOM` lib only because `wasm-media-encoders`' own type
declarations reference the ambient `WebAssembly` namespace, which TypeScript's lib set
otherwise only ships bundled with `DOM` or `WebWorker` — not because this package's own code
uses any DOM API. Confirmed to run under:

- **Node** (this package's own tests run under `node --test`)
- **Browsers** (no `AudioContext`/DOM API dependency — pure typed-array math + WASM)
- **Workers** (same reasoning; no `self`-as-`window` assumptions)

## NOTICE (attribution)

`src/xmi2mid.ts` is a TypeScript port of
[CorsixTH's `Src/xmi2mid.cpp`](https://github.com/CorsixTH/CorsixTH/blob/master/CorsixTH/Src/xmi2mid.cpp)
(`transcode_xmi_to_midi`), MIT-licensed:

> Copyright (c) 2009 Peter "Corsix" Cawley

The port is faithful to the original's control flow; see the file's own header comment and
`LICENSE` for the full original license text. This package (as a whole) is separately
MIT-licensed — see `LICENSE`.

This package was extracted from the [corsixth-web](https://github.com/CorsixTH/CorsixTH)
project's `web/src/` (which continues to vendor its own copy pending a documented dedup
follow-up — see the sibling `docs/superpowers/reports/xmidi-toolkit-notes.md` in that repo).

## Development

```sh
npm install
npm test    # fetches the test SoundFont (cached, SHA256-checked), builds + runs the tests
npm run build
```

- `npm test` runs `node --test` over `esbuild`-compiled test files (`src/**/*.test.ts` ->
  `dist-test/`), including an end-to-end smoke test that renders a synthetic (in-test, no
  real game data) minimal XMI all the way to a real OGG file and checks its magic bytes.
- `npm run build` produces `dist/index.js` (a single bundled ESM file; `spessasynth_core` and
  `wasm-media-encoders` stay external, since they're `dependencies`, not vendored) plus
  `dist/*.d.ts` via `tsc`.

## License

MIT — see `LICENSE` (includes the carried-over `xmi2mid.cpp` attribution above).
