// GM synth glue: offline-render standard MIDI bytes to planar (per-channel) Float32 PCM using the
// soundfont chosen in the M3 music spike (see docs/superpowers/reports/m3-synth-decision.md).
// Winner: spessasynth_core (Apache-2.0, pure JS/TS, no separate wasm blob to host, SF3-capable).
// Runs only inside the lazy music-render bundle, during onboarding ingest — never realtime,
// never an AudioContext (no gameplay-time synth cost; see the spike report for the decision).
//
// API verified against the installed spessasynth_core@4.3.15 (via its own
// examples/midi_to_wav_node.ts, fetched from upstream — the older `SpessaSynthProcessor`/`MIDI`
// shape from earlier drafts of this task is stale for this version).
import {
  BasicMIDI,
  SoundBankLoader,
  SpessaSynthProcessor,
  SpessaSynthSequencer,
} from 'spessasynth_core';

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  // Uint8Array views (e.g. subarrays) may not start at byte 0 of a larger buffer —
  // BasicMIDI/SoundBankLoader read the whole ArrayBuffer, so slice defensively.
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer as ArrayBuffer;
  }
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

// Returns PLANAR stereo PCM ({ left, right }, one Float32Array per channel) rather than
// interleaved — this is the layout wasm-media-encoders' Ogg encoder wants natively
// (music-render.ts used to interleave here then de-interleave there, a ~4x transient
// PCM allocation: left+right+interleaved(2x) for a total of 4x frame count in Float32s
// live at once). Only the WAV fallback path needs interleaved samples, and that
// conversion now happens once, locally, in music-render.ts right before encodeWav's
// call — encodeWav's own interleaved-PCM contract is unchanged (see wav.ts).
export async function renderMidiToPcm(
  mid: Uint8Array,
  soundfont: Uint8Array,
  sampleRate: number,
): Promise<{ left: Float32Array; right: Float32Array }> {
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
