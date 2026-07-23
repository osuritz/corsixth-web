// Lazy-loaded music renderer: XMI -> MID -> PCM -> OGG (Vorbis, primary) / WAV (fallback),
// all client-side, during ingest. Built as a separate IIFE bundle (dist/music-render.js)
// and injected on demand so the synth + its weight never load on the initial page.
//
// AMENDED (sponsor size question, docs/superpowers/m3 plan amendment 2026-07-23): OGG
// Vorbis is the primary output — the mixer build already decodes it
// (-sSDL2_MIXER_FORMATS=ogg, confirmed in CorsixTH/CMakeLists.txt) at zero engine/build
// cost, and it's ~10x smaller than WAV at 22050Hz (everything under /th-data is copied
// into MEMFS at every boot, so full-size WAVs would bloat browser RAM). `wasm-media-
// encoders`'s Vorbis encoder (MIT, spike-evaluated in Task 2 — see
// docs/superpowers/reports/m3-synth-decision.md) is tried first; encodeWav is the
// zero-risk fallback on any encoder failure. Rendered audio bytes are TH-derived and
// live only in the user's IndexedDB — never hosted or committed.
import { transcodeXmiToMid } from './xmi2mid';
import { encodeWav } from './wav';
import { renderMidiToPcm } from './synth';
import { createOggEncoder } from 'wasm-media-encoders';

const SAMPLE_RATE = 22050;
// Per the Task 2 spike's measured vbrQuality/size table (m3-synth-decision.md): q3
// (~113kbps) lands closest to the plan amendment's ~1.5-2MB/track sizing assumption
// (actual ~2.9MB/track at the demo tracks' real ~3.5min length, still a ~10x WAV saving).
const VBR_QUALITY = 3;

// De-interleave synth.ts's interleaved Float32 PCM into one Float32Array per channel —
// the shape wasm-media-encoders' encode() expects.
function deinterleave(pcm: Float32Array, channels: number): Float32Array[] {
  const frames = Math.floor(pcm.length / channels);
  const out: Float32Array[] = [];
  for (let c = 0; c < channels; c++) out.push(new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) out[c][i] = pcm[i * channels + c];
  }
  return out;
}

async function encodeOgg(pcm: Float32Array, sampleRate: number, channels: number): Promise<Uint8Array> {
  const encoder = await createOggEncoder();
  encoder.configure({ sampleRate, channels: channels as 1 | 2, vbrQuality: VBR_QUALITY });
  const chans = deinterleave(pcm, channels);
  const chunks: Uint8Array[] = [];
  // encode()'s returned buffer is owned by the encoder and must be copied (README) —
  // .slice() does that. A single encode() call for the whole track is well within what
  // the spike's functional test already exercised (full-track PCM -> real Ogg files).
  const enc = encoder.encode(chans);
  if (enc.length) chunks.push(enc.slice());
  const tail = encoder.finalize();
  if (tail.length) chunks.push(tail.slice());
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const result = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { result.set(c, off); off += c.length; }
  return result;
}

async function renderXmiToAudio(
  xmi: Uint8Array,
  soundfont: Uint8Array,
): Promise<{ bytes: Uint8Array; ext: 'OGG' | 'WAV' }> {
  const mid = transcodeXmiToMid(xmi);
  if (!mid) throw new Error('XMI transcode failed');
  const { pcm, channels } = await renderMidiToPcm(mid, soundfont, SAMPLE_RATE);
  try {
    const bytes = await encodeOgg(pcm, SAMPLE_RATE, channels);
    if (bytes.length === 0) throw new Error('encoder produced zero bytes');
    return { bytes, ext: 'OGG' };
  } catch (e) {
    console.warn('[music-render] OGG encode failed, falling back to WAV:', e);
    return { bytes: encodeWav(pcm, SAMPLE_RATE, channels), ext: 'WAV' };
  }
}

(self as unknown as { __corsixthRenderMusic: unknown }).__corsixthRenderMusic = { renderXmiToAudio };
