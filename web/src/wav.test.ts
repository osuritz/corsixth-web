import test from 'node:test';
import assert from 'node:assert';
import { encodeWav } from './wav';

test('encodeWav writes a canonical 16-bit PCM WAV header', () => {
  const wav = encodeWav(new Float32Array([0, 1, -1, 0.5]), 22050, 1);
  const dv = new DataView(wav.buffer);
  assert.deepEqual([...wav.subarray(0, 4)], [...'RIFF'].map((c) => c.charCodeAt(0)));
  assert.deepEqual([...wav.subarray(8, 12)], [...'WAVE'].map((c) => c.charCodeAt(0)));
  assert.deepEqual([...wav.subarray(12, 16)], [...'fmt '].map((c) => c.charCodeAt(0)));
  assert.equal(dv.getUint16(20, true), 1, 'PCM');
  assert.equal(dv.getUint16(22, true), 1, 'mono');
  assert.equal(dv.getUint32(24, true), 22050, 'sample rate');
  assert.equal(dv.getUint16(34, true), 16, 'bits per sample');
  assert.deepEqual([...wav.subarray(36, 40)], [...'data'].map((c) => c.charCodeAt(0)));
  assert.equal(dv.getUint32(40, true), 8, 'data chunk = 4 samples * 2 bytes');
  assert.equal(dv.getInt16(44 + 2, true), 0x7fff, '+1.0 -> full-scale positive');
  assert.equal(dv.getInt16(44 + 4, true), -0x8000, '-1.0 -> full-scale negative');
});
