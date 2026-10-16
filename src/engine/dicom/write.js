// DICOM Part 10 writer: Explicit VR Little Endian, defined-length sequences, strict validation.
import { vrOf, tagHex, tagOf } from './dict.js';
import { TEXT_VRS, CHARSET_VRS, LONG_VRS, NUMERIC_SIZE, encodeText, encodeNumbers, formatDS, formatIS } from './values.js';

export const EXPLICIT_VR_LE = '1.2.840.10008.1.2.1';

/**
 * A writable dataset: tag -> { vr, value }.
 * value: string | string[] | number | number[] | Uint8Array | TypedArray | WDataset[] (SQ)
 */
export class WDataset {
  constructor() { this.map = new Map(); }
  static t(t) { return typeof t === 'string' ? tagOf(t) : t >>> 0; }
  /** Set an element. vr defaults to the dictionary VR. Numbers for DS/IS are formatted strictly. */
  set(t, value, vr) {
    const tag = WDataset.t(t);
    let v = vr || vrOf(tag);
    if (v.includes('|')) throw new Error(`Ambiguous VR for ${tagHex(tag)}: specify explicitly`);
    if (v === 'UN') throw new Error(`Refusing to write unknown VR for ${tagHex(tag)}`);
    let val = value;
    if (v === 'DS') val = toStrings(value, formatDS);
    else if (v === 'IS') val = toStrings(value, formatIS);
    this.map.set(tag, { vr: v, value: val });
    return this;
  }
  /** Type 2 element with zero length. */
  empty(t, vr) {
    const tag = WDataset.t(t);
    const v = vr || vrOf(tag);
    this.map.set(tag, { vr: v, value: v === 'SQ' ? [] : (TEXT_VRS.has(v) ? '' : new Uint8Array(0)) });
    return this;
  }
  seq(t, items) { return this.set(t, items, 'SQ'); }
  has(t) { return this.map.has(WDataset.t(t)); }
  get(t) { const e = this.map.get(WDataset.t(t)); return e ? e.value : undefined; }
  delete(t) { this.map.delete(WDataset.t(t)); return this; }
}

function toStrings(value, fmt) {
  if (value === '' || value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value) || ArrayBuffer.isView(value)) return Array.from(value).map((x) => (typeof x === 'string' ? x : fmt(x)));
  return fmt(value);
}

function hasNonAscii(ds) {
  for (const { vr, value } of ds.map.values()) {
    if (vr === 'SQ') { for (const it of value) if (hasNonAscii(it)) return true; continue; }
    if (CHARSET_VRS.has(vr) || vr === 'PN') {
      const s = Array.isArray(value) ? value.join('') : String(value);
      if (/[^\x00-\x7F]/.test(s)) return true;
    }
  }
  return false;
}

class ByteSink {
  constructor() { this.chunks = []; this.length = 0; }
  push(u8) { this.chunks.push(u8); this.length += u8.length; }
  concat() {
    const out = new Uint8Array(this.length);
    let o = 0;
    for (const c of this.chunks) { out.set(c, o); o += c.length; }
    return out;
  }
}

function header(tag, vr, length) {
  const long = LONG_VRS.has(vr);
  const h = new Uint8Array(long ? 12 : 8);
  const dv = new DataView(h.buffer);
  dv.setUint16(0, (tag >>> 16) & 0xFFFF, true);
  dv.setUint16(2, tag & 0xFFFF, true);
  h[4] = vr.charCodeAt(0); h[5] = vr.charCodeAt(1);
  if (long) dv.setUint32(8, length, true);
  else {
    if (length > 0xFFFF) throw new Error(`${tagHex(tag)} ${vr} value too long (${length} bytes)`);
    dv.setUint16(6, length, true);
  }
  return h;
}

function valueBytes(tag, vr, value) {
  const label = tagHex(tag);
  if (TEXT_VRS.has(vr)) {
    if (value === '' || (Array.isArray(value) && value.length === 0)) return new Uint8Array(0);
    return encodeText(vr, value, label);
  }
  if (NUMERIC_SIZE[vr]) {
    if (value instanceof Uint8Array && value.length === 0) return value;
    return encodeNumbers(vr, value);
  }
  // OB, OW, OF, OD, OL, OV, UN: raw little-endian bytes
  let u8;
  if (value instanceof Uint8Array) u8 = value;
  else if (ArrayBuffer.isView(value)) u8 = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  else throw new Error(`${label} ${vr}: expected bytes`);
  if (u8.length % 2 === 1) {
    const p = new Uint8Array(u8.length + 1);
    p.set(u8);
    return p;
  }
  return u8;
}

function encodeDataset(ds, sink) {
  const tags = [...ds.map.keys()].sort((a, b) => a - b);
  for (const tag of tags) {
    if ((tag >>> 16) === 0x0002) throw new Error('Group 0002 belongs to the file meta information');
    const { vr, value } = ds.map.get(tag);
    if (vr === 'SQ') {
      const inner = new ByteSink();
      for (const item of value) {
        const itemSink = new ByteSink();
        encodeDataset(item, itemSink);
        const ih = new Uint8Array(8);
        const dv = new DataView(ih.buffer);
        dv.setUint16(0, 0xFFFE, true); dv.setUint16(2, 0xE000, true); dv.setUint32(4, itemSink.length, true);
        inner.push(ih);
        for (const c of itemSink.chunks) inner.push(c);
      }
      sink.push(header(tag, 'SQ', inner.length));
      for (const c of inner.chunks) sink.push(c);
      continue;
    }
    const vb = valueBytes(tag, vr, value);
    sink.push(header(tag, vr, vb.length));
    if (vb.length) sink.push(vb);
  }
}

/**
 * Serialize a Part 10 file.
 * @param {WDataset} ds dataset (must contain SOPClassUID and SOPInstanceUID)
 * @param {{implementationClassUID:string, implementationVersionName:string, sourceAET?:string}} impl
 */
export function writePart10(ds, impl) {
  const sopClass = ds.get('SOPClassUID');
  const sopInst = ds.get('SOPInstanceUID');
  if (!sopClass || !sopInst) throw new Error('SOPClassUID and SOPInstanceUID are required');
  if (hasNonAscii(ds)) {
    const cs = ds.get('SpecificCharacterSet');
    if (cs !== 'ISO_IR 192') ds.set('SpecificCharacterSet', 'ISO_IR 192');
  }
  const meta = new WDataset();
  meta.map.set(0x00020001, { vr: 'OB', value: new Uint8Array([0x00, 0x01]) });
  meta.map.set(0x00020002, { vr: 'UI', value: sopClass });
  meta.map.set(0x00020003, { vr: 'UI', value: sopInst });
  meta.map.set(0x00020010, { vr: 'UI', value: EXPLICIT_VR_LE });
  meta.map.set(0x00020012, { vr: 'UI', value: impl.implementationClassUID });
  meta.map.set(0x00020013, { vr: 'SH', value: impl.implementationVersionName });
  if (impl.sourceAET) meta.map.set(0x00020016, { vr: 'AE', value: impl.sourceAET });
  const metaSink = new ByteSink();
  for (const tag of [...meta.map.keys()].sort((a, b) => a - b)) {
    const { vr, value } = meta.map.get(tag);
    const vb = valueBytes(tag, vr, value);
    metaSink.push(header(tag, vr, vb.length));
    metaSink.push(vb);
  }
  const out = new ByteSink();
  out.push(new Uint8Array(128));
  out.push(new Uint8Array([0x44, 0x49, 0x43, 0x4D]));
  const gl = new Uint8Array(12);
  const gdv = new DataView(gl.buffer);
  gdv.setUint16(0, 0x0002, true); gdv.setUint16(2, 0x0000, true);
  gl[4] = 0x55; gl[5] = 0x4C; // 'UL'
  gdv.setUint16(6, 4, true);
  gdv.setUint32(8, metaSink.length, true);
  out.push(gl);
  for (const c of metaSink.chunks) out.push(c);
  encodeDataset(ds, out);
  return out.concat();
}

/** Build a code sequence item (Code Sequence Macro, PS3.3 Table 8.8-1). */
export function codeItem(value, scheme, meaning) {
  const it = new WDataset();
  it.set('CodeValue', value, 'SH');
  it.set('CodingSchemeDesignator', scheme, 'SH');
  it.set('CodeMeaning', meaning, 'LO');
  return it;
}
