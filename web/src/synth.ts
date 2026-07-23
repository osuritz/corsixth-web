// GM synth glue: offline-render standard MIDI bytes to interleaved Float32 PCM using the
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

export async function renderMidiToPcm(
  mid: Uint8Array,
  soundfont: Uint8Array,
  sampleRate: number,
): Promise<{ pcm: Float32Array; channels: number }> {
  const channels = 2;

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

  const pcm = new Float32Array(total * channels);
  for (let i = 0; i < total; i++) {
    pcm[i * 2] = left[i];
    pcm[i * 2 + 1] = right[i];
  }
  return { pcm, channels };
}
