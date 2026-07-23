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

test('encodeWav header math + interleave order for stereo (channels=2)', () => {
  // encodeWav's contract (per wav.ts) treats `pcm` as already-interleaved samples —
  // it has no notion of channels beyond the header fields; the caller is responsible
  // for interleaving L/R before calling. This test picks a distinct, decodable value
  // per (frame, channel) slot to prove the header's per-channel math is self-consistent
  // AND that encodeWav does not reorder/transform samples relative to input order.
  const sampleRate = 44100;
  const channels = 2;
  // 3 stereo frames: [L0,R0, L1,R1, L2,R2], each value distinct so a transposition or
  // channel swap would be caught (not just a byte-count assertion).
  const pcm = new Float32Array([0.1, 0.2, -0.3, 0.4, -0.5, 0.6]);
  const wav = encodeWav(pcm, sampleRate, channels);
  const dv = new DataView(wav.buffer);

  // -- fmt chunk: channel-dependent fields --
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * channels * bytesPerSample;
  assert.equal(dv.getUint16(22, true), channels, 'channels');
  assert.equal(dv.getUint32(24, true), sampleRate, 'sample rate');
  assert.equal(dv.getUint32(28, true), byteRate, 'byte rate = sampleRate * channels * bytesPerSample');
  assert.equal(dv.getUint16(32, true), blockAlign, 'block align = channels * bytesPerSample');
  assert.equal(dv.getUint16(34, true), 16, 'bits per sample unaffected by channel count');

  // -- data chunk size + overall RIFF size --
  const dataLen = pcm.length * bytesPerSample;
  assert.equal(dv.getUint32(40, true), dataLen, 'data chunk length = total sample count * bytesPerSample (channels already folded into pcm.length)');
  assert.equal(dv.getUint32(4, true), 36 + dataLen, 'RIFF chunk size = 36 + data length');
  assert.equal(wav.length, 44 + dataLen, 'total buffer length = header + data');

  // -- interleave order: samples appear in the data chunk in the exact input order,
  // i.e. L/R alternate per frame with no reordering (frame 0's L immediately followed
  // by frame 0's R, then frame 1's L, etc.) --
  const expectedInt16 = (s: number) => {
    const c = Math.max(-1, Math.min(1, s));
    return (c < 0 ? c * 0x8000 : c * 0x7fff) | 0;
  };
  for (let i = 0; i < pcm.length; i++) {
    assert.equal(
      dv.getInt16(44 + i * bytesPerSample, true),
      expectedInt16(pcm[i]),
      `sample ${i} (frame ${Math.floor(i / channels)}, channel ${i % channels}) preserved in input order`,
    );
  }
});
