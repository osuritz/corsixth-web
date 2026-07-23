import test from 'node:test';
import assert from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderXmiToAudio } from './render';

// Build a synthetic, minimal XMI: [filler]"EVNT"[4-byte len][event stream]. Based on
// xmi2mid.test.ts's fixture (a standalone copy, not an import, so this file's esbuild-bundled
// test module doesn't also re-register xmi2mid.test.ts's own tests as a side effect), but with
// an added trailing delay before the end-of-track marker: xmi2mid.test.ts's original fixture
// packs every event back-to-back with no delay bytes, so its generated note-off (which lands
// at tick 24 — the note-on's `duration 8` XMI ticks * 3) sorts *after* an end-of-track marker
// that's otherwise still sitting at tick 0, and transcodeXmiToMid's output loop stops at the
// first end-of-track it emits — cutting the note-off, and leaving the render pipeline's
// downstream MIDI with a duration of exactly 0 (spessasynth_core's sequencer then refuses to
// load it at all, silently rendering nothing but the 1s tail of silence). That's fine for
// xmi2mid.test.ts's structural byte-layout assertions, but it would make this smoke test only
// prove "silence encodes to a valid OGG container" — not that a real note gets synthesized. A
// delay byte (0x28 = 40 XMI ticks -> 120 raw ticks) pushes the end-of-track marker past the
// note-off, giving a small but genuinely nonzero MIDI duration.
function syntheticXmi(): Uint8Array {
  const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
  const events = [
    0x90, 0x3c, 0x64, 0x08,               // note-on C4 vel100, duration 8 (-> note-off @ tick 24)
    0xb0, 0x07, 0x7f,                      // controller 7 (volume) = 127
    0xc0, 0x00,                            // program change -> piano
    0xff, 0x51, 0x03, 0x07, 0xa1, 0x20,    // set tempo 500000us
    0x28,                                  // delay 40 XMI ticks (120 raw ticks) before ending
    0xff, 0x2f, 0x00,                      // end of track (now safely after the note-off)
  ];
  return new Uint8Array([...ascii('EVNT'), 0, 0, 0, events.length, ...events]);
}

// End-to-end smoke test: the synthetic XMI above (zero real game/copyrighted bytes) rendered
// all the way to an OGG file, using a real GM SoundFont fetched to .assets/ (gitignored —
// `npm run fetch-assets`, or `npm test` which fetches it first; see
// scripts/fetch-soundfont.mjs and README.md).
const SOUNDFONT_PATH = resolve('.assets', 'FluidR3.sf3');

test('renderXmiToAudio: synthetic XMI -> real OGG bytes', { skip: !existsSync(SOUNDFONT_PATH) && 'run `npm run fetch-assets` first' }, async () => {
  const soundfont = readFileSync(SOUNDFONT_PATH);
  const result = await renderXmiToAudio(syntheticXmi(), soundfont, { sampleRate: 22050 });

  assert.equal(result.format, 'ogg', 'expected the primary OGG encode path to succeed (no silent WAV fallback)');
  assert.ok(result.bytes.length > 0, 'non-empty encoded audio');
  assert.deepEqual(
    [...result.bytes.subarray(0, 4)],
    [...'OggS'].map((c) => c.charCodeAt(0)),
    'output starts with the OggS page-capture-pattern magic',
  );
});
