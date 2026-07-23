# XMIDI (.xmi) Music in WASM — Library Options

> Sponsor-authored research note (Olivier, 2026-07-23), preserved verbatim as provenance for the M3
> music decision. Controller resolution recorded at the end.

Our game's music is **General MIDI delivered as `.xmi`** — the Miles Sound System
(AIL) XMIDI format: an IFF-wrapped extension of Standard MIDI. You cannot synthesize
`.xmi` directly; it must first be **parsed into MIDI events** (durations, loop points,
timbre chunks handled), then rendered by a synth.

## XMIDI quirks any solution must handle
- **Inline note durations** — note-on carries its own length; note-offs must be scheduled.
- **Fixed ~120 Hz timebase / nonstandard tempo** — must be translated to correct PPQN/tempo.
- **Branch/loop controllers** (`RBRN` chunk + CC 116/117) — needed for seamless music loops.
- **`TIMB` timbre chunk + bank CC 114** — patch/bank setup → standard program/bank-select.
- **MT-32 heritage** — even "GM" AIL titles may assume MT-32 patch maps; may need MT-32→GM remap.
- **Multi-song containers** — one `.xmi` can hold several sequences.

## Architecture A — Convert/parse XMI → MIDI events, then render with a SoundFont synth
Isolates all XMIDI weirdness in one step; lets you pick the soundfont sound. **Recommended.**

### XMI parser (port one, don't write your own)
| Option | Pros | Cons |
|---|---|---|
| **Exult `xmidi.cc`** | Reference XMIDI→SMF impl; handles durations, branches, tempo; MT-32↔GM conversion; portable C++, WASM-friendly | Tied to Exult's helpers; extraction effort |
| **ScummVM `MidiParser_XMIDI`** | Battle-tested; parses XMI directly into a playable stream incl. loops; no intermediate file | Coupled to ScummVM's MidiParser base class |

### SoundFont synth (renders the parsed events)
| Option | Pros | Cons |
|---|---|---|
| **TinySoundFont (TSF)** | Single-header C, zero deps, trivial WASM embed; ships `tml.h`; small | Lower fidelity than FluidSynth; fewer SF2 features |
| **FluidSynth (WASM)** | High fidelity, faithful SF2 2.01; best quality | Heavier binary; more build complexity |
| **Munt (libmt32emu)** | Correct for MT-32-oriented tracks; far better than GM soundfont there | Needs MT-32 ROMs; only for MT-32 material |

## Architecture B — Synth library that ingests `.xmi` natively (skip conversion)
| Option | Pros | Cons |
|---|---|---|
| **WildMIDI** | Loads XMI/XFM directly; small C API; WASM-friendly; fast prototype | Uses GUS patch sets, not SF2 — different sound; extra asset |
| **libADLMIDI / libOPNMIDI** | Native internal XMI conversion; authentic OPL sound | OPL3 FM synth — wrong if you want sampled General MIDI |

## Recommendation
1. **Architecture A**: port Exult's or ScummVM's XMIDI parser → render via **TinySoundFont** (easy) or **FluidSynth-WASM** (fidelity).
2. **Verify GM vs MT-32** on the real files; if MT-32-oriented, enable remap or use **Munt**.
3. **Confirm loop support** (RBRN / CC 116-117) survives — most commonly dropped.
4. Keep **WildMIDI** as a quick PoC path.
5. Run the synth in an **AudioWorklet** to avoid main-thread starvation.

---

## Controller resolution (2026-07-23, recorded in the M3 plan)

Architecture A adopted (matches the committed M3 plan), with three deltas from this note:

1. **Parser = CorsixTH's own `Src/xmi2mid.cpp`** (TS port), not Exult/ScummVM: field-proven on
   exactly Theme Hospital's XMI corpus for years, and **MIT-licensed same-repo** — Exult and
   ScummVM are GPL, which would contaminate the MIT shell.
2. **Offline render-at-ingest to WAV**, not runtime synthesis: the engine's own SDL2_mixer plays
   the rendered WAV (`-DMUSIC_WAV` unconditionally compiled in; `audio.lua` prefers waveform
   files). Zero engine changes, zero gameplay-time synth cost; AudioWorklet unnecessary (a plain
   Worker for ingest-time rendering if UI smoothness demands it). Rendered audio is TH-derived
   content: stored only in the user's IndexedDB, never committed/hosted.
3. **Fidelity bar = native CorsixTH**, not the Miles driver: whole-track `Mix_PlayMusic` looping
   (no RBRN branch loops) and GM/FluidR3 (no MT-32 remap; Munt's ROM requirement is a legal
   nonstarter here). The Task 2 spike verifies the 3 demo tracks convert + render listenably.

TSF added as the third synth-spike candidate on this note's strength. WildMIDI/OPL paths declined
(different sound + extra patch assets vs. our GM/FluidR3 parity bar).
