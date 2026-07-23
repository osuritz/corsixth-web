// GM synth glue: offline-render standard MIDI bytes to planar (per-channel) Float32 PCM using a
// caller-supplied SoundFont (SF2/SF3). Pure offline rendering — never realtime, never an
// AudioContext — so it works identically in Node, browsers, and Workers.
//
// Backed by spessasynth_core (Apache-2.0, pure JS/TS, no separate WASM blob to host,
// SF3-capable). API verified against spessasynth_core@4.3.15 (via its own
// examples/midi_to_wav_node.ts, fetched from upstream) — older `SpessaSynthProcessor`/`MIDI`
// shapes from earlier library versions are stale relative to this one.
import {
  BasicMIDI,
  SoundBankLoader,
  SpessaSynthProcessor,
  SpessaSynthSequencer,
} from 'spessasynth_core';

// Returns PLANAR stereo PCM ({ left, right }, one Float32Array per channel) rather than
// interleaved — this is the layout wasm-media-encoders' OGG encoder wants natively (see
// render.ts's encodeOgg). Only the WAV fallback path needs interleaved samples; render.ts does
// that conversion once, locally, right before handing bytes to encodeWav (encodeWav's own
// interleaved-PCM contract is unchanged — see wav.ts).
/** Planar (per-channel) stereo Float32 PCM: `left` and `right`, always the same length. */
export interface PcmRenderResult {
  left: Float32Array;
  right: Float32Array;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  // Uint8Array views (e.g. subarrays) may not start at byte 0 of a larger buffer —
  // BasicMIDI/SoundBankLoader read the whole ArrayBuffer, so slice defensively.
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer as ArrayBuffer;
  }
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

/**
 * Render a standard MIDI file to planar (per-channel) Float32 PCM using a General MIDI
 * SoundFont.
 *
 * @param mid Standard MIDI file bytes (e.g. from {@link transcodeXmiToMid}).
 * @param soundfont SF2 or SF3 SoundFont bytes. Not bundled by this package — see README.md
 *   for where to get a freely-licensed one (FluidR3) and its license terms.
 * @param sampleRate Output sample rate in Hz.
 * @returns Planar stereo Float32 PCM — `left` and `right`, each spanning the full song length
 *   plus a 1s tail (to let the last notes' release/reverb ring out).
 */
export async function renderMidiToPcm(
  mid: Uint8Array,
  soundfont: Uint8Array,
  sampleRate: number,
): Promise<PcmRenderResult> {
  const midi = BasicMIDI.fromArrayBuffer(toArrayBuffer(mid));
  const soundBank = SoundBankLoader.fromArrayBuffer(toArrayBuffer(soundfont));

  const synth = new SpessaSynthProcessor(sampleRate, { eventsEnabled: false });
  synth.soundBankManager.addSoundBank(soundBank, 'main');
  await synth.processorInitialized;

  const seq = new SpessaSynthSequencer(synth);
  seq.loadNewSongList([midi]);
  seq.play();

  // Render the full song length + a 1s tail into a stereo buffer, block by block.
  const durationSec = midi.duration + 1;
  const total = Math.ceil(durationSec * sampleRate);
  const left = new Float32Array(total);
  const right = new Float32Array(total);
  const BLOCK = 128;
  let filled = 0;
  while (filled < total) {
    seq.processTick();
    const n = Math.min(BLOCK, total - filled);
    synth.process(left, right, filled, n);
    filled += n;
  }

  return { left, right };
}
