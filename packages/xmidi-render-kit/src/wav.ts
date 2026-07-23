// Canonical 44-byte-header PCM WAV encoder. Float32 [-1,1] interleaved -> 16-bit LE PCM.
// Zero-dependency, zero-platform-assumption: pure typed-array math, so it runs identically
// in Node, browsers, and Workers. Used as the universally-decodable fallback container when
// OGG Vorbis encoding is unavailable or fails (see render.ts).
export function encodeWav(pcm: Float32Array, sampleRate: number, channels: number): Uint8Array {
  const bytesPerSample = 2;
  const dataLen = pcm.length * bytesPerSample;
  const buf = new ArrayBuffer(44 + dataLen);
  const view = new DataView(buf);
  const str = (off: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); view.setUint32(4, 36 + dataLen, true); str(8, 'WAVE');
  str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, channels, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true); view.setUint16(34, 16, true);
  str(36, 'data'); view.setUint32(40, dataLen, true);
  let off = 44;
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    view.setInt16(off, (s < 0 ? s * 0x8000 : s * 0x7fff) | 0, true);
    off += 2;
  }
  return new Uint8Array(buf);
}
