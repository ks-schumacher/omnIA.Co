// Value encoding/decoding and validation for DICOM Value Representations (PS3.5 §6.2).

export const TEXT_VRS = new Set(['AE', 'AS', 'CS', 'DA', 'DS', 'DT', 'IS', 'LO', 'LT', 'PN', 'SH', 'ST', 'TM', 'UC', 'UI', 'UR', 'UT']);
// VRs that use the specific character set (others are restricted to the default repertoire).
export const CHARSET_VRS = new Set(['LO', 'LT', 'PN', 'SH', 'ST', 'UC', 'UT']);
// VRs whose explicit-VR encoding uses a 2-byte reserved field + 4-byte length.
export const LONG_VRS = new Set(['OB', 'OD', 'OF', 'OL', 'OV', 'OW', 'SQ', 'UC', 'UR', 'UT', 'UN', 'SV', 'UV']);
// VRs whose value is a single string (backslash is not a delimiter).
export const SINGLE_VALUE_TEXT = new Set(['LT', 'ST', 'UT', 'UR']);

const MAX_LEN = { AE: 16, AS: 4, CS: 16, DA: 8, DS: 16, DT: 26, IS: 12, LO: 64, LT: 10240, SH: 16, ST: 1024, TM: 14, UI: 64 };

export const NUMERIC_SIZE = { US: 2, SS: 2, UL: 4, SL: 4, FL: 4, FD: 8, SV: 8, UV: 8, AT: 4 };

/** Format a number as a DICOM Decimal String (max 16 bytes) keeping maximal precision. */
export function formatDS(x) {
  if (!Number.isFinite(x)) throw new Error(`DS cannot encode non-finite value ${x}`);
  if (Object.is(x, -0) || x === 0) return '0';
  if (Number.isInteger(x) && Math.abs(x) < 1e15) {
    const s = String(x);
    if (s.length <= 16) return s;
  }
  // most significant digits that fit in 16 characters, in fixed or exponent notation (both valid DS)
  for (let p = 17; p >= 1; p--) {
    const fixed = trimNumber(x.toPrecision(p));
    const expo = trimNumber(x.toExponential(p - 1));
    if (fixed.length <= 16) return fixed;
    if (expo.length <= 16) return expo;
  }
  throw new Error(`DS cannot encode ${x}`);
}

function trimNumber(s) {
  let mant = s, exp = '';
  const e = s.search(/e/i);
  if (e >= 0) { mant = s.slice(0, e); exp = s.slice(e + 1); }
  if (mant.includes('.')) mant = mant.replace(/0+$/, '').replace(/\.$/, '');
  if (exp) {
    let n = parseInt(exp, 10);
    return n === 0 ? mant : `${mant}E${n}`;
  }
  return mant;
}

export function formatIS(x) {
  if (!Number.isInteger(x) || x < -2147483648 || x > 2147483647) throw new Error(`IS out of range: ${x}`);
  return String(x);
}

/** Validate one string value for a text VR. Throws with a precise message on violation. */
export function validateText(vr, v, tagLabel = '') {
  if (typeof v !== 'string') throw new Error(`${tagLabel} ${vr}: value must be a string`);
  const max = MAX_LEN[vr];
  if (vr === 'PN') {
    for (const group of v.split('=')) {
      if ([...group].length > 64) throw new Error(`${tagLabel} PN component group exceeds 64 chars`);
    }
  } else if (max !== undefined && (CHARSET_VRS.has(vr) ? [...v].length : v.length) > max) {
    throw new Error(`${tagLabel} ${vr} value exceeds ${max} chars: "${v}"`);
  }
  if (!CHARSET_VRS.has(vr) && vr !== 'PN') {
    // default character repertoire only
    if (/[^\x20-\x7E]/.test(v)) throw new Error(`${tagLabel} ${vr} contains characters outside the default repertoire`);
  }
  if (!SINGLE_VALUE_TEXT.has(vr) && v.includes('\\')) throw new Error(`${tagLabel} ${vr} value contains backslash`);
  switch (vr) {
    case 'UI':
      if (!/^(0|[1-9][0-9]*)(\.(0|[1-9][0-9]*))*$/.test(v)) throw new Error(`${tagLabel} invalid UID "${v}"`);
      break;
    case 'DA':
      if (!/^\d{8}$/.test(v)) throw new Error(`${tagLabel} invalid DA "${v}"`);
      break;
    case 'TM':
      if (!/^\d{2}(\d{2}(\d{2}(\.\d{1,6})?)?)?$/.test(v)) throw new Error(`${tagLabel} invalid TM "${v}"`);
      break;
    case 'CS':
      if (!/^[A-Z0-9 _]*$/.test(v)) throw new Error(`${tagLabel} invalid CS "${v}"`);
      break;
    case 'DS':
      if (!/^ *[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)? *$/.test(v)) throw new Error(`${tagLabel} invalid DS "${v}"`);
      break;
    case 'IS':
      if (!/^ *[+-]?\d+ *$/.test(v)) throw new Error(`${tagLabel} invalid IS "${v}"`);
      break;
    case 'AS':
      if (!/^\d{3}[DWMY]$/.test(v)) throw new Error(`${tagLabel} invalid AS "${v}"`);
      break;
    default:
  }
  // control characters are not allowed except in LT/ST/UT (CR, LF, FF, TAB, ESC)
  if (!['LT', 'ST', 'UT'].includes(vr) && /[\x00-\x1F]/.test(v.replace(/\x1B/g, ''))) {
    throw new Error(`${tagLabel} ${vr} contains control characters`);
  }
}

/** Map DICOM Specific Character Set defined terms to WHATWG encoding labels. */
export function charsetToEncoding(term) {
  const t = (term || '').trim().toUpperCase();
  switch (t) {
    case '': case 'ISO_IR 6': return 'ascii';
    case 'ISO_IR 100': case 'ISO 2022 IR 100': return 'iso-8859-1';
    case 'ISO_IR 101': case 'ISO 2022 IR 101': return 'iso-8859-2';
    case 'ISO_IR 109': case 'ISO 2022 IR 109': return 'iso-8859-3';
    case 'ISO_IR 110': case 'ISO 2022 IR 110': return 'iso-8859-4';
    case 'ISO_IR 144': case 'ISO 2022 IR 144': return 'iso-8859-5';
    case 'ISO_IR 127': case 'ISO 2022 IR 127': return 'iso-8859-6';
    case 'ISO_IR 126': case 'ISO 2022 IR 126': return 'iso-8859-7';
    case 'ISO_IR 138': case 'ISO 2022 IR 138': return 'iso-8859-8';
    case 'ISO_IR 148': case 'ISO 2022 IR 148': return 'iso-8859-9';
    case 'ISO_IR 203': case 'ISO 2022 IR 203': return 'iso-8859-15';
    case 'ISO_IR 13': case 'ISO 2022 IR 13': return 'shift_jis';
    case 'ISO_IR 166': case 'ISO 2022 IR 166': return 'windows-874';
    case 'ISO_IR 192': return 'utf-8';
    case 'GB18030': return 'gb18030';
    case 'GBK': return 'gbk';
    case 'ISO 2022 IR 149': return 'euc-kr';
    case 'ISO 2022 IR 87': case 'ISO 2022 IR 159': return 'iso-2022-jp';
    case 'ISO 2022 IR 58': return 'gb18030';
    default: return null;
  }
}

const decoderCache = new Map();
export function getDecoder(encoding) {
  let d = decoderCache.get(encoding);
  if (!d) {
    d = new TextDecoder(encoding === 'ascii' ? 'windows-1252' : encoding, { fatal: false });
    decoderCache.set(encoding, d);
  }
  return d;
}

export const utf8 = new TextEncoder();

/** Encode a (possibly multi-valued) text value into bytes, padded to even length. */
export function encodeText(vr, value, tagLabel = '') {
  const values = Array.isArray(value) ? value : [value];
  for (const v of values) validateText(vr, v, tagLabel);
  if (SINGLE_VALUE_TEXT.has(vr) && values.length > 1) throw new Error(`${tagLabel} ${vr} is single-valued`);
  let s = values.join('\\');
  let bytes = utf8.encode(s); // ASCII-only VRs are validated above; charset VRs are UTF-8 (ISO_IR 192)
  if (bytes.length % 2 === 1) {
    const padded = new Uint8Array(bytes.length + 1);
    padded.set(bytes);
    padded[bytes.length] = vr === 'UI' ? 0x00 : 0x20;
    bytes = padded;
  }
  return bytes;
}

/** Encode binary numeric values (little endian). */
export function encodeNumbers(vr, value) {
  const values = Array.isArray(value) || ArrayBuffer.isView(value) ? Array.from(value) : [value];
  const size = NUMERIC_SIZE[vr];
  const buf = new Uint8Array(values.length * size);
  const dv = new DataView(buf.buffer);
  values.forEach((v, i) => {
    const o = i * size;
    switch (vr) {
      case 'US': if (!Number.isInteger(v) || v < 0 || v > 0xFFFF) throw new Error(`US out of range ${v}`); dv.setUint16(o, v, true); break;
      case 'SS': if (!Number.isInteger(v) || v < -32768 || v > 32767) throw new Error(`SS out of range ${v}`); dv.setInt16(o, v, true); break;
      case 'UL': if (!Number.isInteger(v) || v < 0 || v > 0xFFFFFFFF) throw new Error(`UL out of range ${v}`); dv.setUint32(o, v, true); break;
      case 'SL': if (!Number.isInteger(v) || v < -2147483648 || v > 2147483647) throw new Error(`SL out of range ${v}`); dv.setInt32(o, v, true); break;
      case 'FL': dv.setFloat32(o, v, true); break;
      case 'FD': dv.setFloat64(o, v, true); break;
      case 'SV': dv.setBigInt64(o, BigInt(v), true); break;
      case 'UV': dv.setBigUint64(o, BigInt(v), true); break;
      case 'AT': dv.setUint16(o, (v >>> 16) & 0xFFFF, true); dv.setUint16(o + 2, v & 0xFFFF, true); break;
      default: throw new Error(`encodeNumbers: unsupported VR ${vr}`);
    }
  });
  return buf;
}

/** Decode text bytes to an array of string values (padding removed). */
export function decodeText(vr, bytes, encoding = 'ascii') {
  const enc = CHARSET_VRS.has(vr) || vr === 'PN' ? encoding : 'ascii';
  let s = getDecoder(enc || 'ascii').decode(bytes);
  if (SINGLE_VALUE_TEXT.has(vr)) return [s.replace(/[\0 ]+$/, '')];
  return s.split('\\').map((v) => {
    if (vr === 'UI') return v.replace(/[\0 ]+$/, '').trim();
    return v.replace(/[\0 ]+$/, '').replace(/^ +/, '');
  });
}

export function decodeNumbers(vr, bytes, littleEndian = true) {
  const size = NUMERIC_SIZE[vr];
  const n = Math.floor(bytes.length / size);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * size;
    switch (vr) {
      case 'US': out[i] = dv.getUint16(o, littleEndian); break;
      case 'SS': out[i] = dv.getInt16(o, littleEndian); break;
      case 'UL': out[i] = dv.getUint32(o, littleEndian); break;
      case 'SL': out[i] = dv.getInt32(o, littleEndian); break;
      case 'FL': out[i] = dv.getFloat32(o, littleEndian); break;
      case 'FD': out[i] = dv.getFloat64(o, littleEndian); break;
      case 'SV': out[i] = Number(dv.getBigInt64(o, littleEndian)); break;
      case 'UV': out[i] = Number(dv.getBigUint64(o, littleEndian)); break;
      case 'AT': out[i] = ((dv.getUint16(o, littleEndian) << 16) | dv.getUint16(o + 2, littleEndian)) >>> 0; break;
      default: throw new Error(`decodeNumbers: unsupported VR ${vr}`);
    }
  }
  return out;
}
