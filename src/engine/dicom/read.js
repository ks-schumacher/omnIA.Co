// DICOM Part 10 / raw dataset parser (PS3.5, PS3.10).
// Supports Implicit VR LE, Explicit VR LE, Deflated Explicit VR LE, Explicit VR BE (retired),
// all encapsulated transfer syntaxes (pixel fragments are located, not decoded),
// nested sequences with defined/undefined lengths, and header-only (truncated) reads.
import { inflateSync } from 'fflate';
import { vrOf, tagOf } from './dict.js';
import { LONG_VRS, TEXT_VRS, NUMERIC_SIZE, decodeText, decodeNumbers, charsetToEncoding } from './values.js';

export const TS = {
  IMPLICIT_LE: '1.2.840.10008.1.2',
  EXPLICIT_LE: '1.2.840.10008.1.2.1',
  DEFLATED_LE: '1.2.840.10008.1.2.1.99',
  EXPLICIT_BE: '1.2.840.10008.1.2.2',
};

const ITEM = 0xFFFEE000, ITEM_DELIM = 0xFFFEE00D, SEQ_DELIM = 0xFFFEE0DD;
const PIXEL_DATA = 0x7FE00010;
const UNDEFINED = 0xFFFFFFFF;

export class TruncatedError extends Error {}

const VALID_VRS = new Set(['AE', 'AS', 'AT', 'CS', 'DA', 'DS', 'DT', 'FL', 'FD', 'IS', 'LO', 'LT', 'OB', 'OD', 'OF', 'OL', 'OV', 'OW', 'PN', 'SH', 'SL', 'SQ', 'SS', 'ST', 'SV', 'TM', 'UC', 'UI', 'UL', 'UN', 'UR', 'US', 'UT', 'UV']);

export class Dataset {
  constructor(encoding = 'ascii', littleEndian = true) {
    this.elements = new Map();
    this.encoding = encoding;
    this.littleEndian = littleEndian;
  }
  _t(t) { return typeof t === 'string' ? tagOf(t) : t >>> 0; }
  has(t) { return this.elements.has(this._t(t)); }
  get(t) { return this.elements.get(this._t(t)); }
  /** All string values of a text element (empty array if absent). */
  strings(t) {
    const e = this.get(t);
    if (!e || !e.bytes || e.length === 0) return [];
    const vr = e.vr;
    if (TEXT_VRS.has(vr)) return decodeText(vr, e.bytes, this.encoding);
    if (NUMERIC_SIZE[vr]) return decodeNumbers(vr, e.bytes, this.littleEndian).map(String);
    return [];
  }
  string(t) { const v = this.strings(t); return v.length ? v[0] : ''; }
  /** Numeric values of DS/IS/binary numeric elements. NaN for unparsable entries. */
  numbers(t) {
    const e = this.get(t);
    if (!e || !e.bytes || e.length === 0) return [];
    let vr = e.vr;
    if (vr === 'US|SS') vr = 'US';
    if (vr === 'DS' || vr === 'IS') return decodeText(vr, e.bytes).map((s) => (s.trim() === '' ? NaN : Number(s)));
    if (NUMERIC_SIZE[vr]) return decodeNumbers(vr, e.bytes, this.littleEndian);
    if (vr === 'OF') return Array.from(new Float32Array(e.bytes.slice().buffer));
    if (vr === 'OD') return Array.from(new Float64Array(e.bytes.slice().buffer));
    return [];
  }
  number(t) { const v = this.numbers(t); return v.length ? v[0] : undefined; }
  seq(t) { const e = this.get(t); return e && e.items ? e.items : []; }
  tags() { return [...this.elements.keys()].sort((a, b) => a - b); }
}

function encodingFromCharset(values) {
  // Use the first non-empty term (ISO 2022 code-extension lists start with an empty value).
  for (const v of values) {
    if (v && v.trim()) {
      const enc = charsetToEncoding(v);
      return enc || 'windows-1252';
    }
  }
  return 'ascii';
}

class Reader {
  constructor(bytes, littleEndian, explicit) {
    this.bytes = bytes;
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.le = littleEndian;
    this.explicit = explicit;
  }
  need(pos, n) { if (pos + n > this.bytes.length) throw new TruncatedError('truncated'); }
  u16(p) { this.need(p, 2); return this.dv.getUint16(p, this.le); }
  u32(p) { this.need(p, 4); return this.dv.getUint32(p, this.le); }
  tag(p) { return ((this.u16(p) << 16) | this.u16(p + 2)) >>> 0; }

  /** Parse elements from pos until end (exclusive) or a delimiter. Returns { ds, pos }. */
  parseDataset(pos, end, parentEncoding, opts, isTop) {
    const ds = new Dataset(parentEncoding, this.le);
    while (pos < end) {
      if (pos + 8 > this.bytes.length) { if (isTop && pos >= this.bytes.length) break; throw new TruncatedError('truncated'); }
      const tag = this.tag(pos);
      if (tag === ITEM_DELIM) { return { ds, pos: pos + 8, delimited: true }; }
      if (tag === SEQ_DELIM) { return { ds, pos, delimited: false }; }
      if (isTop && opts.untilTag !== undefined && tag >= opts.untilTag) { ds.stoppedAt = pos; return { ds, pos, stopped: true }; }
      const el = this.readElement(pos, ds.encoding, opts);
      ds.elements.set(tag, el.element);
      if (tag === 0x00080005) ds.encoding = encodingFromCharset(decodeText('CS', el.element.bytes || new Uint8Array(0)));
      pos = el.next;
    }
    return { ds, pos };
  }

  readElement(pos, encoding, opts) {
    const tag = this.tag(pos);
    let vr, length, valuePos;
    let explicit = this.explicit;
    if (explicit) {
      this.need(pos, 8);
      const c0 = this.bytes[pos + 4], c1 = this.bytes[pos + 5];
      const cand = String.fromCharCode(c0, c1);
      if (VALID_VRS.has(cand)) {
        vr = cand;
        if (LONG_VRS.has(vr)) { length = this.u32(pos + 8); valuePos = pos + 12; }
        else { length = this.u16(pos + 6); valuePos = pos + 8; }
      } else {
        // Non-conformant: implicit encoding inside an explicit stream. Fall back for this element.
        explicit = false;
      }
    }
    if (!explicit) {
      vr = vrOf(tag);
      length = this.u32(pos + 4);
      valuePos = pos + 8;
    }
    const element = { tag, vr, length, offset: valuePos };
    if (vr.includes('|')) element.vr = tag === PIXEL_DATA ? 'OW' : vr; // ambiguous VRs resolved on use

    if (length === UNDEFINED) {
      if (tag === PIXEL_DATA) {
        // Encapsulated pixel data: Basic Offset Table item + fragments, until sequence delimiter.
        const frags = [];
        let p = valuePos;
        for (;;) {
          const t = this.tag(p);
          const l = this.u32(p + 4);
          if (t === SEQ_DELIM) { p += 8; break; }
          if (t !== ITEM) throw new Error(`Malformed encapsulated pixel data at ${p}`);
          this.need(p + 8, l);
          frags.push(this.bytes.subarray(p + 8, p + 8 + l));
          p += 8 + l;
        }
        element.vr = 'OB';
        element.fragments = frags; // frags[0] is the Basic Offset Table
        return { element, next: p };
      }
      // Undefined-length sequence (SQ, or UN which per PS3.5 §6.2.2 is implicit VR LE)
      const asImplicit = vr === 'UN' || !this.explicit;
      return this.readSequence(element, valuePos, UNDEFINED, encoding, opts, asImplicit);
    }
    if (vr === 'SQ') return this.readSequence(element, valuePos, length, encoding, opts, !this.explicit);
    this.need(valuePos, length);
    element.bytes = this.bytes.subarray(valuePos, valuePos + length);
    return { element, next: valuePos + length };
  }

  readSequence(element, valuePos, length, encoding, opts, implicitItems) {
    element.vr = 'SQ';
    element.items = [];
    const sub = implicitItems && this.explicit ? new Reader(this.bytes, true, false) : this;
    const end = length === UNDEFINED ? Infinity : valuePos + length;
    let p = valuePos;
    while (p < end) {
      const t = sub.tag(p);
      if (t === SEQ_DELIM) { p += 8; break; }
      if (t !== ITEM) throw new Error(`Expected item tag in sequence ${element.tag.toString(16)} at ${p}`);
      const il = sub.u32(p + 4);
      const itemStart = p + 8;
      if (il === UNDEFINED) {
        const r = sub.parseDataset(itemStart, Infinity, encoding, opts, false);
        element.items.push(r.ds);
        p = r.pos; // after item delimiter
      } else {
        const r = sub.parseDataset(itemStart, itemStart + il, encoding, opts, false);
        element.items.push(r.ds);
        p = itemStart + il;
      }
    }
    return { element, next: length === UNDEFINED ? p : valuePos + length };
  }
}

/**
 * Parse DICOM bytes.
 * @param {Uint8Array} bytes
 * @param {{untilTag?:number, allowTruncated?:boolean}} opts
 */
export function parseDicom(bytes, opts = {}) {
  let pos = 0;
  let hasPreamble = false;
  if (bytes.length >= 132 && bytes[128] === 0x44 && bytes[129] === 0x49 && bytes[130] === 0x43 && bytes[131] === 0x4D) {
    pos = 132; hasPreamble = true;
  }
  const result = { hasPreamble, meta: new Dataset(), dataset: null, transferSyntax: null, truncated: false };
  // File Meta Information (group 0002) is always Explicit VR Little Endian.
  const metaReader = new Reader(bytes, true, true);
  try {
    while (pos + 8 <= bytes.length && metaReader.u16(pos) === 0x0002) {
      const { element, next } = metaReader.readElement(pos, 'ascii', opts);
      result.meta.elements.set(element.tag, element);
      pos = next;
    }
  } catch (e) {
    if (e instanceof TruncatedError) { result.truncated = true; return result; }
    throw e;
  }
  let ts = result.meta.string(0x00020010);
  if (!ts) {
    // No meta information: guess explicit vs implicit from the first element.
    if (bytes.length >= pos + 6) {
      const c0 = bytes[pos + 4], c1 = bytes[pos + 5];
      ts = VALID_VRS.has(String.fromCharCode(c0, c1)) ? TS.EXPLICIT_LE : TS.IMPLICIT_LE;
    } else ts = TS.IMPLICIT_LE;
    result.noMeta = true;
  }
  result.transferSyntax = ts;
  let dsBytes = bytes, dsPos = pos;
  if (ts === TS.DEFLATED_LE) {
    dsBytes = inflateSync(bytes.subarray(pos));
    dsPos = 0;
  }
  const le = ts !== TS.EXPLICIT_BE;
  const explicit = ts !== TS.IMPLICIT_LE;
  const reader = new Reader(dsBytes, le, explicit);
  try {
    const r = reader.parseDataset(dsPos, dsBytes.length, 'ascii', opts, true);
    result.dataset = r.ds;
    if (r.stopped) result.stoppedAt = r.pos;
  } catch (e) {
    if (e instanceof TruncatedError && opts.allowTruncated) {
      result.truncated = true;
      // Re-parse up to the last complete element to keep what was read.
      result.dataset = reparsePartial(reader, dsPos, dsBytes.length, opts);
    } else throw e;
  }
  result.littleEndian = le;
  result.explicit = explicit;
  result.bytes = dsBytes;
  return result;
}

function reparsePartial(reader, pos, end, opts) {
  const ds = new Dataset('ascii', reader.le);
  while (pos < end) {
    try {
      const tag = reader.tag(pos);
      if (opts.untilTag !== undefined && tag >= opts.untilTag) break;
      const el = reader.readElement(pos, ds.encoding, opts);
      ds.elements.set(tag, el.element);
      if (tag === 0x00080005) ds.encoding = encodingFromCharset(decodeText('CS', el.element.bytes || new Uint8Array(0)));
      pos = el.next;
    } catch (e) {
      if (e instanceof TruncatedError) break;
      throw e;
    }
  }
  return ds;
}

/** Quick probe: does this buffer look like DICOM (with or without preamble)? */
export function looksLikeDicom(bytes) {
  if (bytes.length >= 132 && bytes[128] === 0x44 && bytes[129] === 0x49 && bytes[130] === 0x43 && bytes[131] === 0x4D) return true;
  if (bytes.length < 8) return false;
  const g = bytes[0] | (bytes[1] << 8);
  const e = bytes[2] | (bytes[3] << 8);
  // raw dataset starting at group 0002/0008 with a small element number
  if ((g === 0x0002 || g === 0x0008) && e < 0x0100) {
    const vr = String.fromCharCode(bytes[4], bytes[5]);
    if (VALID_VRS.has(vr)) return true;
    const len = bytes[4] | (bytes[5] << 8) | (bytes[6] << 16) | (bytes[7] << 24);
    return len >= 0 && len < 1024;
  }
  return false;
}

/**
 * Decode native (uncompressed) monochrome pixel data of a single-frame or multi-frame dataset.
 * Returns { frames: TypedArray[], rows, cols, bitsAllocated, signed } or throws if unsupported.
 */
export function nativePixelFrames(file) {
  const ds = file.dataset;
  const el = ds.get(PIXEL_DATA);
  if (!el) throw new Error('No Pixel Data');
  if (el.fragments) throw new Error('Encapsulated (compressed) pixel data is not decoded here');
  if (!file.littleEndian) throw new Error('Big-endian pixel data not supported');
  const rows = ds.number(0x00280010), cols = ds.number(0x00280011);
  const spp = ds.number(0x00280002) ?? 1;
  const ba = ds.number(0x00280100), bs = ds.number(0x00280101) ?? ba;
  const pr = ds.number(0x00280103) ?? 0;
  const nf = Math.max(1, ds.number(0x00280008) ?? 1);
  if (spp !== 1) throw new Error('Only monochrome pixel data supported');
  const n = rows * cols;
  const frames = [];
  const raw = el.bytes;
  if (ba === 16) {
    const need = n * nf * 2;
    if (raw.length < need) throw new Error('Pixel data shorter than expected');
    const copy = raw.slice(0, need);
    const all = pr ? new Int16Array(copy.buffer) : new Uint16Array(copy.buffer);
    const shift = 16 - bs;
    for (let f = 0; f < nf; f++) {
      const fr = all.subarray(f * n, (f + 1) * n);
      if (bs < 16) {
        // mask to Bits Stored, sign-extend if signed
        for (let i = 0; i < n; i++) {
          let v = fr[i] & ((1 << bs) - 1);
          if (pr && v & (1 << (bs - 1))) v -= 1 << bs;
          fr[i] = v;
        }
      }
      frames.push(fr);
    }
    void shift;
  } else if (ba === 8) {
    const copy = raw.slice(0, n * nf);
    for (let f = 0; f < nf; f++) frames.push(pr ? new Int8Array(copy.buffer, f * n, n) : new Uint8Array(copy.buffer, f * n, n));
  } else if (ba === 32) {
    const copy = raw.slice(0, n * nf * 4);
    const all = pr ? new Int32Array(copy.buffer) : new Uint32Array(copy.buffer);
    for (let f = 0; f < nf; f++) frames.push(all.subarray(f * n, (f + 1) * n));
  } else if (ba === 1) {
    for (let f = 0; f < nf; f++) {
      const fr = new Uint8Array(n);
      const base = f * n;
      for (let i = 0; i < n; i++) { const b = base + i; fr[i] = (raw[b >> 3] >> (b & 7)) & 1; }
      frames.push(fr);
    }
  } else throw new Error(`Bits Allocated ${ba} not supported`);
  return { frames, rows, cols, bitsAllocated: ba, signed: !!pr };
}
