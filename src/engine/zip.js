// ZIP reading (random access, ZIP64, stored/deflate, CRC-32 verified) and writing (ZIP64-capable).
// Reading works on a "source" with { size, read(offset, length): Promise<Uint8Array> }.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(u8, crc = 0) {
  let c = ~crc >>> 0;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
  return ~c >>> 0;
}

export function sourceFromBytes(u8) {
  return { size: u8.length, read: async (o, l) => u8.subarray(o, o + l) };
}
export function sourceFromBlob(blob) {
  return { size: blob.size, read: async (o, l) => new Uint8Array(await blob.slice(o, o + l).arrayBuffer()) };
}

async function inflateRaw(u8, expectedSize) {
  if (typeof DecompressionStream !== 'undefined') {
    const ds = new DecompressionStream('deflate-raw');
    const out = new Response(new Blob([u8]).stream().pipeThrough(ds));
    return new Uint8Array(await out.arrayBuffer());
  }
  const { inflateSync } = await import('fflate');
  return inflateSync(u8, expectedSize ? { out: new Uint8Array(expectedSize) } : undefined);
}

async function deflateRaw(u8) {
  if (typeof CompressionStream !== 'undefined') {
    const cs = new CompressionStream('deflate-raw');
    const out = new Response(new Blob([u8]).stream().pipeThrough(cs));
    return new Uint8Array(await out.arrayBuffer());
  }
  const { deflateSync } = await import('fflate');
  return deflateSync(u8, { level: 6 });
}

export class ZipUnsupportedError extends Error {}

/** List entries of a ZIP archive. Each entry has getBytes() which decompresses and verifies CRC-32. */
export async function readZip(src) {
  const size = src.size;
  const tailLen = Math.min(size, 65557);
  const tail = await src.read(size - tailLen, tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a ZIP archive (end of central directory not found)');
  const dv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let count = dv.getUint16(eocd + 10, true);
  let cdSize = dv.getUint32(eocd + 12, true);
  let cdOffset = dv.getUint32(eocd + 16, true);
  // ZIP64 locator precedes the EOCD
  const loc = eocd - 20;
  if (loc >= 0 && dv.getUint32(loc, true) === 0x07064b50) {
    const z64off = Number(dv.getBigUint64(loc + 8, true));
    const z = await src.read(z64off, 56);
    const zdv = new DataView(z.buffer, z.byteOffset, z.byteLength);
    if (zdv.getUint32(0, true) !== 0x06064b50) throw new Error('Corrupt ZIP64 end of central directory');
    count = Number(zdv.getBigUint64(32, true));
    cdSize = Number(zdv.getBigUint64(40, true));
    cdOffset = Number(zdv.getBigUint64(48, true));
  }
  const cd = await src.read(cdOffset, cdSize);
  const cdv = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
  const entries = [];
  let p = 0;
  const dec = new TextDecoder('utf-8');
  const decCp437 = new TextDecoder('windows-1252');
  for (let n = 0; n < count; n++) {
    if (cdv.getUint32(p, true) !== 0x02014b50) throw new Error('Corrupt ZIP central directory');
    const flags = cdv.getUint16(p + 8, true);
    const method = cdv.getUint16(p + 10, true);
    const crc = cdv.getUint32(p + 16, true);
    let csize = cdv.getUint32(p + 20, true);
    let usize = cdv.getUint32(p + 24, true);
    const nlen = cdv.getUint16(p + 28, true), xlen = cdv.getUint16(p + 30, true), clen = cdv.getUint16(p + 32, true);
    let lho = cdv.getUint32(p + 42, true);
    const nameBytes = cd.subarray(p + 46, p + 46 + nlen);
    const name = flags & 0x800 ? dec.decode(nameBytes) : decCp437.decode(nameBytes);
    // ZIP64 extra field
    let xp = p + 46 + nlen;
    const xend = xp + xlen;
    while (xp + 4 <= xend) {
      const id = cdv.getUint16(xp, true), sz = cdv.getUint16(xp + 2, true);
      if (id === 0x0001) {
        let q = xp + 4;
        if (usize === 0xFFFFFFFF) { usize = Number(cdv.getBigUint64(q, true)); q += 8; }
        if (csize === 0xFFFFFFFF) { csize = Number(cdv.getBigUint64(q, true)); q += 8; }
        if (lho === 0xFFFFFFFF) { lho = Number(cdv.getBigUint64(q, true)); q += 8; }
      }
      xp += 4 + sz;
    }
    p += 46 + nlen + xlen + clen;
    const isDir = name.endsWith('/');
    const encrypted = !!(flags & 1);
    entries.push({
      path: name, size: usize, compressedSize: csize, isDir, encrypted, method,
      async getBytes() {
        if (encrypted) throw new ZipUnsupportedError('encrypted ZIP entry');
        if (method !== 0 && method !== 8) throw new ZipUnsupportedError(`ZIP compression method ${method}`);
        const lh = await src.read(lho, 30);
        const ldv = new DataView(lh.buffer, lh.byteOffset, lh.byteLength);
        if (ldv.getUint32(0, true) !== 0x04034b50) throw new Error(`Corrupt local header for ${name}`);
        const dataStart = lho + 30 + ldv.getUint16(26, true) + ldv.getUint16(28, true);
        const raw = await src.read(dataStart, csize);
        const out = method === 0 ? raw.slice() : await inflateRaw(raw, usize);
        if (out.length !== usize) throw new Error(`Size mismatch extracting ${name}`);
        if (crc32(out) !== crc) throw new Error(`CRC-32 mismatch extracting ${name} (corrupt archive)`);
        return out;
      },
    });
  }
  return entries;
}

/**
 * ZIP writer producing Blob parts; ZIP64 records are emitted automatically when needed.
 * add(path, bytes, {compress}) then finish() -> { blob, size }.
 */
export class ZipWriter {
  constructor() { this.parts = []; this.offset = 0; this.central = []; this.count = 0; }
  _push(u8) { this.parts.push(u8); this.offset += u8.length; }
  async add(path, bytes, { compress = true } = {}) {
    const name = new TextEncoder().encode(path);
    const crc = crc32(bytes);
    let data = bytes, method = 0;
    if (compress && bytes.length > 64) {
      const d = await deflateRaw(bytes);
      if (d.length < bytes.length) { data = d; method = 8; }
    }
    const zip64 = bytes.length >= 0xFFFFFFFF || data.length >= 0xFFFFFFFF || this.offset >= 0xFFFFFFFF;
    const extra = zip64 ? 20 : 0;
    const lh = new Uint8Array(30 + name.length + extra);
    const v = new DataView(lh.buffer);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(4, zip64 ? 45 : 20, true);
    v.setUint16(6, 0x0800, true); // UTF-8 names
    v.setUint16(8, method, true);
    v.setUint16(10, 0, true); v.setUint16(12, 0x21, true); // DOS time/date (1980-01-01): no timestamps leak
    v.setUint32(14, crc, true);
    v.setUint32(18, zip64 ? 0xFFFFFFFF : data.length, true);
    v.setUint32(22, zip64 ? 0xFFFFFFFF : bytes.length, true);
    v.setUint16(26, name.length, true);
    v.setUint16(28, extra, true);
    lh.set(name, 30);
    if (zip64) {
      v.setUint16(30 + name.length, 0x0001, true);
      v.setUint16(32 + name.length, 16, true);
      v.setBigUint64(34 + name.length, BigInt(bytes.length), true);
      v.setBigUint64(42 + name.length, BigInt(data.length), true);
    }
    const localOffset = this.offset;
    this._push(lh);
    this._push(data);
    this.central.push({ name, crc, csize: data.length, usize: bytes.length, method, offset: localOffset });
    this.count++;
  }
  finish() {
    const cdStart = this.offset;
    for (const e of this.central) {
      const need64 = e.csize >= 0xFFFFFFFF || e.usize >= 0xFFFFFFFF || e.offset >= 0xFFFFFFFF;
      const extra = need64 ? 28 : 0;
      const h = new Uint8Array(46 + e.name.length + extra);
      const v = new DataView(h.buffer);
      v.setUint32(0, 0x02014b50, true);
      v.setUint16(4, need64 ? 45 : 20, true);
      v.setUint16(6, need64 ? 45 : 20, true);
      v.setUint16(8, 0x0800, true);
      v.setUint16(10, e.method, true);
      v.setUint16(12, 0, true); v.setUint16(14, 0x21, true);
      v.setUint32(16, e.crc, true);
      v.setUint32(20, need64 ? 0xFFFFFFFF : e.csize, true);
      v.setUint32(24, need64 ? 0xFFFFFFFF : e.usize, true);
      v.setUint16(28, e.name.length, true);
      v.setUint16(30, extra, true);
      v.setUint32(42, need64 ? 0xFFFFFFFF : e.offset, true);
      h.set(e.name, 46);
      if (need64) {
        const q = 46 + e.name.length;
        v.setUint16(q, 0x0001, true); v.setUint16(q + 2, 24, true);
        v.setBigUint64(q + 4, BigInt(e.usize), true);
        v.setBigUint64(q + 12, BigInt(e.csize), true);
        v.setBigUint64(q + 20, BigInt(e.offset), true);
      }
      this._push(h);
    }
    const cdSize = this.offset - cdStart;
    const need64 = this.count >= 0xFFFF || cdStart >= 0xFFFFFFFF || cdSize >= 0xFFFFFFFF;
    if (need64) {
      const z = new Uint8Array(56);
      const v = new DataView(z.buffer);
      v.setUint32(0, 0x06064b50, true);
      v.setBigUint64(4, 44n, true);
      v.setUint16(12, 45, true); v.setUint16(14, 45, true);
      v.setBigUint64(24, BigInt(this.count), true);
      v.setBigUint64(32, BigInt(this.count), true);
      v.setBigUint64(40, BigInt(cdSize), true);
      v.setBigUint64(48, BigInt(cdStart), true);
      const z64at = this.offset;
      this._push(z);
      const l = new Uint8Array(20);
      const lv = new DataView(l.buffer);
      lv.setUint32(0, 0x07064b50, true);
      lv.setBigUint64(8, BigInt(z64at), true);
      lv.setUint32(16, 1, true);
      this._push(l);
    }
    const e = new Uint8Array(22);
    const v = new DataView(e.buffer);
    v.setUint32(0, 0x06054b50, true);
    v.setUint16(8, need64 ? 0xFFFF : this.count, true);
    v.setUint16(10, need64 ? 0xFFFF : this.count, true);
    v.setUint32(12, need64 ? 0xFFFFFFFF : cdSize, true);
    v.setUint32(16, need64 ? 0xFFFFFFFF : cdStart, true);
    this._push(e);
    return { parts: this.parts, size: this.offset };
  }
}
