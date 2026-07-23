// TypeScript port of CorsixTH/Src/xmi2mid.cpp transcode_xmi_to_midi (MIT, (c) 2009
// Peter "Corsix" Cawley). Converts Theme Hospital XMI music to standard MIDI at ingest,
// entirely in the browser. Faithful to the C++ control flow; see the .cpp for provenance.
const ZERO_BYTE = new Uint8Array([0]);

class InBuf {
  private p = 0;
  constructor(private readonly d: Uint8Array) {}
  get ptr(): number { return this.p; }
  isEnd(): boolean { return this.p >= this.d.length; }
  readByte(): number | null { return this.p < this.d.length ? this.d[this.p++] : null; }
  readBE24(): number {
    const a = this.readByte(), b = this.readByte(), c = this.readByte();
    if (a === null || b === null || c === null) return 0;
    return (((a << 8) | b) << 8) | c;
  }
  readVarLen(): number {
    let value = 0;
    for (let i = 0; i < 4; i++) {
      const byte = this.readByte();
      if (byte === null) break;
      value = (value << 7) | (byte & 0x7f);
      if ((byte & 0x80) === 0) break;
    }
    return value;
  }
  skip(distance: number): boolean {
    const target = this.p + distance;
    if (target < 0 || target > this.d.length) return false;
    this.p = target; return true;
  }
  scanTo(marker: string): boolean {
    const m = [...marker].map((c) => c.charCodeAt(0));
    for (; this.p + m.length <= this.d.length; this.p++) {
      let ok = true;
      for (let i = 0; i < m.length; i++) if (this.d[this.p + i] !== m[i]) { ok = false; break; }
      if (ok) return true;
    }
    return false;
  }
}

class OutBuf {
  private bytes: number[] = [];
  private p = 0;
  tell(): number { return this.p; }
  seek(position: number): void { this.p = position; }
  private put(b: number): void {
    if (this.p < this.bytes.length) this.bytes[this.p] = b & 0xff;
    else this.bytes.push(b & 0xff);
    this.p++;
  }
  writeByte(b: number): void { this.put(b); }
  writeStr(s: string): void { for (let i = 0; i < s.length; i++) this.put(s.charCodeAt(i)); }
  writeFrom(src: Uint8Array, off: number, len: number): void { for (let i = 0; i < len; i++) this.put(src[off + i]); }
  writeBE16(v: number): void { this.put((v >>> 8) & 0xff); this.put(v & 0xff); }
  writeBE32(v: number): void { this.put((v >>> 24) & 0xff); this.put((v >>> 16) & 0xff); this.put((v >>> 8) & 0xff); this.put(v & 0xff); }
  writeVarLen(value: number): void {
    let byteCount = 1;
    let buffer = value & 0x7f;
    let v = value;
    for (; (v >>>= 7); ++byteCount) buffer = (buffer << 8) | 0x80 | (v & 0x7f);
    for (let i = 0; i < byteCount; i++) { this.put(buffer & 0xff); buffer >>>= 8; }
  }
  take(): Uint8Array { return Uint8Array.from(this.bytes); }
}

interface Token {
  time: number; type: number; data: number;
  bufferLen: number; bufferOff: number; bufferSrc: Uint8Array | null;
}

export function transcodeXmiToMid(xmi: Uint8Array): Uint8Array | null {
  if (!xmi || xmi.length === 0) return null;
  const inp = new InBuf(xmi);
  if (!inp.scanTo('EVNT') || !inp.skip(8)) return null;

  const tokens: Token[] = [];
  let tokenTime = 0;
  let tempo = 500000;
  let tempoSet = false;
  let end = false;

  const append = (time: number, type: number): Token => {
    const t: Token = { time, type, data: 0, bufferLen: 0, bufferOff: 0, bufferSrc: null };
    tokens.push(t);
    return t;
  };

  while (!inp.isEnd() && !end) {
    let tokenType = 0;
    for (;;) {
      const b = inp.readByte();
      if (b === null) return null;
      tokenType = b;
      if (tokenType & 0x80) break;
      tokenTime += tokenType * 3;
    }
    let token = append(tokenTime, tokenType);
    token.bufferSrc = xmi;
    token.bufferOff = inp.ptr + 1; // C++ get_pointer()+1 (the 2nd data byte), taken pre-read
    switch (tokenType & 0xf0) {
      case 0xc0:
      case 0xd0: {
        const d = inp.readByte(); if (d === null) return null;
        token.data = d; token.bufferSrc = null;
        break;
      }
      case 0x80:
      case 0xa0:
      case 0xb0:
      case 0xe0: {
        const d = inp.readByte(); if (d === null) return null;
        token.data = d;
        if (!inp.skip(1)) return null;
        break;
      }
      case 0x90: {
        const ext = inp.readByte(); if (ext === null) return null;
        token.data = ext;
        if (!inp.skip(1)) return null;
        const dur = inp.readVarLen();
        token = append(tokenTime + dur * 3, tokenType);
        token.data = ext;
        token.bufferSrc = ZERO_BYTE; token.bufferOff = 0; // note-off velocity "\0"
        break;
      }
      case 0xf0: {
        let ext = 0;
        if (tokenType === 0xff) {
          const e = inp.readByte(); if (e === null) return null;
          ext = e;
          if (ext === 0x2f) {
            end = true;
          } else if (ext === 0x51) {
            if (!tempoSet) {
              inp.skip(1);
              tempo = inp.readBE24() * 3;
              tempoSet = true;
              inp.skip(-4);
            } else {
              tokens.pop();
              if (!inp.skip(inp.readVarLen())) return null;
              break;
            }
          }
        }
        token.data = ext;
        token.bufferLen = inp.readVarLen();
        token.bufferSrc = xmi;
        token.bufferOff = inp.ptr;
        if (!inp.skip(token.bufferLen)) return null;
        break;
      }
    }
  }

  if (tokens.length === 0) return null;

  const out = new OutBuf();
  out.writeStr('MThd'); out.writeBE32(6); out.writeBE16(0); out.writeBE16(1);
  out.writeBE16(Math.trunc((tempo * 3) / 25000) & 0xffff);
  out.writeStr('MTrk'); out.writeBE32(0); // track-length placeholder, patched below

  // C++ std::sort compares only .time; JS sort is stable (fine for MIDI — preserves
  // event order within a tick).
  tokens.sort((a, b) => a.time - b.time);

  tokenTime = 0;
  let outType = 0;
  end = false;
  for (const t of tokens) {
    if (end) break;
    out.writeVarLen(t.time - tokenTime);
    tokenTime = t.time;
    if (t.type >= 0xf0) {
      outType = t.type;
      out.writeByte(outType);
      if (outType === 0xff) {
        out.writeByte(t.data);
        if (t.data === 0x2f) end = true;
      }
      out.writeVarLen(t.bufferLen);
      if (t.bufferLen > 0 && t.bufferSrc) out.writeFrom(t.bufferSrc, t.bufferOff, t.bufferLen);
    } else {
      if (t.type !== outType) { outType = t.type; out.writeByte(outType); }
      out.writeByte(t.data);
      if (t.bufferSrc) out.writeByte(t.bufferSrc[t.bufferOff]); // 1 byte (2nd data byte or "\0")
    }
  }

  const len = out.tell() - 22;
  out.seek(18);
  out.writeBE32(len);
  return out.take();
}
