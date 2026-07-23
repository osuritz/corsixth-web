// Top-level render pipeline: XMI -> MID -> PCM -> OGG (primary) / WAV (fallback or explicit).
// Extracted from CorsixTH-Web's ingest-time music-render glue into a game-agnostic library
// entry point (no engine-specific sizing/format assumptions baked in beyond sane defaults).
import { transcodeXmiToMid } from './xmi2mid';
import { encodeWav } from './wav';
import { renderMidiToPcm } from './synth';
import { createOggEncoder } from 'wasm-media-encoders';

/** Default output PCM sample rate (Hz) when {@link RenderXmiToAudioOptions.sampleRate} is omitted. */
export const DEFAULT_SAMPLE_RATE = 22050;
/** Default wasm-media-encoders VBR quality (0-10) when {@link RenderXmiToAudioOptions.vbrQuality} is omitted. */
export const DEFAULT_VBR_QUALITY = 3;

export type AudioFormat = 'ogg' | 'wav';

export interface RenderXmiToAudioOptions {
  /**
   * Preferred output container. Default `'ogg'`.
   *
   * If `'ogg'` (or unset) and OGG Vorbis encoding fails for any reason (WebAssembly
   * unavailable, encoder error, zero-byte output), this silently falls back to WAV — check
   * the returned `format` field to see which one you actually got. Pass `'wav'` explicitly to
   * skip the OGG encoder entirely and always get WAV.
   */
  format?: AudioFormat;
  /**
   * wasm-media-encoders VBR quality, 0 (smallest/lowest quality) - 10 (largest/highest
   * quality). Default 3 (roughly 113kbps at 22050Hz stereo — a reasonable size/quality
   * tradeoff for chiptune-era General MIDI source material; tune for your own assets).
   * Ignored when the resolved format is `'wav'`.
   */
  vbrQuality?: number;
  /**
   * Output PCM sample rate in Hz. Default 22050 (matches the sample rate most Miles Sound
   * System-era XMIDI source material was authored/mixed for; raise for higher-fidelity
   * SoundFonts or modern playback targets).
   */
  sampleRate?: number;
}

export interface RenderXmiToAudioResult {
  bytes: Uint8Array;
  /**
   * The format actually produced. May be `'wav'` even when `'ogg'` was requested (or left
   * as the default) if OGG encoding failed and this toolkit fell back to WAV.
   */
  format: AudioFormat;
}

// De-interleave synth.ts's interleaved Float32 PCM into one Float32Array per channel — the
// shape wasm-media-encoders' encode() expects.
function deinterleave(pcm: Float32Array, channels: number): Float32Array[] {
  const frames = Math.floor(pcm.length / channels);
  const out: Float32Array[] = [];
  for (let c = 0; c < channels; c++) out.push(new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) out[c][i] = pcm[i * channels + c];
  }
  return out;
}

async function encodeOgg(
  pcm: Float32Array,
  sampleRate: number,
  channels: number,
  vbrQuality: number,
): Promise<Uint8Array> {
  const encoder = await createOggEncoder();
  encoder.configure({ sampleRate, channels: channels as 1 | 2, vbrQuality });
  const chans = deinterleave(pcm, channels);
  const chunks: Uint8Array[] = [];
  // encode()'s returned buffer is owned by the encoder and must be copied (see the
  // wasm-media-encoders README) — .slice() does that.
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

/**
 * Render Miles Sound System XMIDI (.xmi) bytes all the way to encoded audio bytes: XMI ->
 * standard MIDI -> PCM (via a caller-supplied GM SoundFont) -> OGG Vorbis (default) or WAV.
 *
 * ```ts
 * import { readFileSync } from 'node:fs';
 * import { renderXmiToAudio } from 'xmidi-render-kit';
 *
 * const xmi = readFileSync('track.xmi');
 * const soundfont = readFileSync('FluidR3.sf3'); // see README.md — not bundled
 * const { bytes, format } = await renderXmiToAudio(xmi, soundfont);
 * // bytes is an OGG (or WAV, on fallback) file ready to write out or hand to an <audio> tag
 * ```
 *
 * @throws if `xmi` has no `EVNT` chunk or its event stream is truncated/corrupt (see
 *   {@link transcodeXmiToMid}).
 */
export async function renderXmiToAudio(
  xmi: Uint8Array,
  soundfont: Uint8Array,
  opts: RenderXmiToAudioOptions = {},
): Promise<RenderXmiToAudioResult> {
  const sampleRate = opts.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const vbrQuality = opts.vbrQuality ?? DEFAULT_VBR_QUALITY;
  const requestedFormat = opts.format ?? 'ogg';

  const mid = transcodeXmiToMid(xmi);
  if (!mid) {
    throw new Error('renderXmiToAudio: XMI transcode failed (no EVNT chunk, or corrupt/truncated event stream)');
  }

  const { pcm, channels } = await renderMidiToPcm(mid, soundfont, sampleRate);

  if (requestedFormat === 'wav') {
    return { bytes: encodeWav(pcm, sampleRate, channels), format: 'wav' };
  }
  try {
    const bytes = await encodeOgg(pcm, sampleRate, channels, vbrQuality);
    if (bytes.length === 0) throw new Error('OGG encoder produced zero bytes');
    return { bytes, format: 'ogg' };
  } catch (e) {
    console.warn('[xmidi-render-kit] OGG encode failed, falling back to WAV:', e);
    return { bytes: encodeWav(pcm, sampleRate, channels), format: 'wav' };
  }
}
