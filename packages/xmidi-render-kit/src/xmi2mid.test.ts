import test from 'node:test';
import assert from 'node:assert';
import { transcodeXmiToMid } from './xmi2mid';

// Build a synthetic XMI: [filler]"EVNT"[4-byte len][event stream]. The converter scans
// to "EVNT" and skips 8 bytes (the 4-char tag + a 4-byte length). Event stream tokens:
//   0x90 note-on (note, velocity, varlen duration)  -> note-on + generated note-off
//   0xB0 controller (ctrl, value)
//   0xC0 program change (program)
//   0xFF 0x51 tempo meta (len=3, 24-bit tempo)
//   0xFF 0x2F end-of-track (len=0)
function syntheticXmi(): Uint8Array {
  const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
  const events = [
    0x90, 0x3c, 0x64, 0x08,        // note-on C4 vel100, duration 8
    0xb0, 0x07, 0x7f,              // controller 7 (volume) = 127
    0xc0, 0x00,                    // program change -> piano
    0xff, 0x51, 0x03, 0x07, 0xa1, 0x20, // set tempo 500000us
    0xff, 0x2f, 0x00,             // end of track
  ];
  return new Uint8Array([...ascii('EVNT'), 0, 0, 0, events.length, ...events]);
}

test('transcodeXmiToMid emits a valid MThd/MTrk MIDI', () => {
  const mid = transcodeXmiToMid(syntheticXmi());
  assert.ok(mid && mid.length > 0, 'non-null MIDI output');
  assert.deepEqual([...mid!.subarray(0, 4)], [...'MThd'].map((c) => c.charCodeAt(0)));
  // header length 6, format 0, ntrks 1
  // division: the C++ (and this port) apply the *3 XMI->MIDI tick-rate factor TWICE —
  // once when the tempo meta is first parsed (`tempo = readBE24() * 3`, giving the
  // 500000us raw tempo -> 1,500,000) and again at header-write time
  // (`(tempo * 3) / 25000`) — so division = (500000*3*3)/25000 = 180, not the naive
  // single-multiply (500000*3)/25000 = 60. Verified against a native build of the real
  // CorsixTH/Src/xmi2mid.cpp fed these exact synthetic bytes: identical 44-byte output,
  // division bytes `00 b4` = 180.
  assert.deepEqual([...mid!.subarray(4, 14)], [0, 0, 0, 6, 0, 0, 0, 1, 0, 180]);
  assert.deepEqual([...mid!.subarray(14, 18)], [...'MTrk'].map((c) => c.charCodeAt(0)));
  // track length field is patched (not the 0xBAADF00D-class placeholder)
  const trackLen = (mid![18] << 24) | (mid![19] << 16) | (mid![20] << 8) | mid![21];
  assert.ok(trackLen > 0 && trackLen === mid!.length - 22, 'track length patched to real value');
  // ends with the end-of-track meta FF 2F 00
  assert.deepEqual([...mid!.subarray(mid!.length - 3)], [0xff, 0x2f, 0x00]);
});

test('transcodeXmiToMid returns null when no EVNT chunk', () => {
  assert.equal(transcodeXmiToMid(new Uint8Array([1, 2, 3, 4, 5])), null);
});

test('transcodeXmiToMid returns null on empty input', () => {
  assert.equal(transcodeXmiToMid(new Uint8Array(0)), null);
});
