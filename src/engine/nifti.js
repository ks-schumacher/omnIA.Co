// NIfTI-1 / NIfTI-2 reader and minimal writer (header replacement), following the
// official nifti1.h / nifti2.h definitions and nibabel's affine conventions.
import { Gunzip, gzipSync } from 'fflate';

export const DT = {
  UINT8: 2, INT16: 4, INT32: 8, FLOAT32: 16, COMPLEX64: 32, FLOAT64: 64, RGB24: 128,
  INT8: 256, UINT16: 512, UINT32: 768, INT64: 1024, UINT64: 1280, FLOAT128: 1536, COMPLEX128: 1792, COMPLEX256: 2048, RGBA32: 2304,
};
const DT_INFO = {
  2: { name: 'uint8', bytes: 1, arr: Uint8Array },
  4: { name: 'int16', bytes: 2, arr: Int16Array },
  8: { name: 'int32', bytes: 4, arr: Int32Array },
  16: { name: 'float32', bytes: 4, arr: Float32Array },
  64: { name: 'float64', bytes: 8, arr: Float64Array },
  256: { name: 'int8', bytes: 1, arr: Int8Array },
  512: { name: 'uint16', bytes: 2, arr: Uint16Array },
  768: { name: 'uint32', bytes: 4, arr: Uint32Array },
  1024: { name: 'int64', bytes: 8, arr: BigInt64Array },
  1280: { name: 'uint64', bytes: 8, arr: BigUint64Array },
  128: { name: 'rgb24', bytes: 3, arr: null },
  2304: { name: 'rgba32', bytes: 4, arr: null },
  32: { name: 'complex64', bytes: 8, arr: null },
  1792: { name: 'complex128', bytes: 16, arr: null },
};
export function dtypeName(dt) { return DT_INFO[dt] ? DT_INFO[dt].name : `datatype ${dt}`; }

export const XFORM = { 0: 'UNKNOWN', 1: 'SCANNER_ANAT', 2: 'ALIGNED_ANAT', 3: 'TALAIRACH', 4: 'MNI_152', 5: 'TEMPLATE_OTHER' };

export function isGzip(b) { return b.length > 2 && b[0] === 0x1f && b[1] === 0x8b; }

/** Gunzip, including concatenated multi-member streams (legal in gzip, produced e.g. by pigz). */
export function gunzipAll(bytes) {
  const parts = [];
  let total = 0;
  const g = new Gunzip((chunk) => { parts.push(chunk); total += chunk.length; });
  g.push(bytes, true);
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of parts) { out.set(c, o); o += c.length; }
  return out;
}

function readString(u8, off, len) {
  let s = '';
  for (let i = 0; i < len; i++) { const c = u8[off + i]; if (c === 0) break; s += String.fromCharCode(c); }
  return s;
}

/** Parse a NIfTI header (348 or 540 bytes). Returns header object with endianness. */
export function parseNiftiHeader(u8) {
  if (u8.length < 348) throw new Error('File too short for a NIfTI header');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let le = true;
  let size = dv.getInt32(0, true);
  if (size !== 348 && size !== 540) { size = dv.getInt32(0, false); le = false; }
  if (size === 348) return parseN1(u8, dv, le);
  if (size === 540) return parseN2(u8, dv, le);
  throw new Error('Not a NIfTI file (sizeof_hdr is neither 348 nor 540)');
}

function parseN1(u8, dv, le) {
  const h = { version: 1, littleEndian: le, sizeof_hdr: 348 };
  h.dim_info = u8[39];
  h.dim = Array.from({ length: 8 }, (_, i) => dv.getInt16(40 + 2 * i, le));
  h.intent_p = [dv.getFloat32(56, le), dv.getFloat32(60, le), dv.getFloat32(64, le)];
  h.intent_code = dv.getInt16(68, le);
  h.datatype = dv.getInt16(70, le);
  h.bitpix = dv.getInt16(72, le);
  h.slice_start = dv.getInt16(74, le);
  h.pixdim = Array.from({ length: 8 }, (_, i) => dv.getFloat32(76 + 4 * i, le));
  h.vox_offset = dv.getFloat32(108, le);
  h.scl_slope = dv.getFloat32(112, le);
  h.scl_inter = dv.getFloat32(116, le);
  h.slice_end = dv.getInt16(120, le);
  h.slice_code = u8[122];
  h.xyzt_units = u8[123];
  h.cal_max = dv.getFloat32(124, le);
  h.cal_min = dv.getFloat32(128, le);
  h.slice_duration = dv.getFloat32(132, le);
  h.toffset = dv.getFloat32(136, le);
  h.descrip = readString(u8, 148, 80);
  h.aux_file = readString(u8, 228, 24);
  h.qform_code = dv.getInt16(252, le);
  h.sform_code = dv.getInt16(254, le);
  h.quatern = [dv.getFloat32(256, le), dv.getFloat32(260, le), dv.getFloat32(264, le)];
  h.qoffset = [dv.getFloat32(268, le), dv.getFloat32(272, le), dv.getFloat32(276, le)];
  h.srow = [0, 1, 2].map((r) => Array.from({ length: 4 }, (_, c) => dv.getFloat32(280 + 16 * r + 4 * c, le)));
  h.intent_name = readString(u8, 328, 16);
  h.magic = readString(u8, 344, 4);
  if (h.magic !== 'n+1' && h.magic !== 'ni1') throw new Error(`Invalid NIfTI-1 magic "${h.magic}"`);
  return h;
}

function parseN2(u8, dv, le) {
  const h = { version: 2, littleEndian: le, sizeof_hdr: 540 };
  const magic = readString(u8, 4, 8);
  h.magic = magic;
  if (magic !== 'n+2' && magic !== 'ni2') throw new Error(`Invalid NIfTI-2 magic "${magic}"`);
  h.datatype = dv.getInt16(12, le);
  h.bitpix = dv.getInt16(14, le);
  h.dim = Array.from({ length: 8 }, (_, i) => Number(dv.getBigInt64(16 + 8 * i, le)));
  h.intent_p = [dv.getFloat64(80, le), dv.getFloat64(88, le), dv.getFloat64(96, le)];
  h.pixdim = Array.from({ length: 8 }, (_, i) => dv.getFloat64(104 + 8 * i, le));
  h.vox_offset = Number(dv.getBigInt64(168, le));
  h.scl_slope = dv.getFloat64(176, le);
  h.scl_inter = dv.getFloat64(184, le);
  h.cal_max = dv.getFloat64(192, le);
  h.cal_min = dv.getFloat64(200, le);
  h.slice_duration = dv.getFloat64(208, le);
  h.toffset = dv.getFloat64(216, le);
  h.slice_start = Number(dv.getBigInt64(224, le));
  h.slice_end = Number(dv.getBigInt64(232, le));
  h.descrip = readString(u8, 240, 80);
  h.aux_file = readString(u8, 320, 24);
  h.qform_code = dv.getInt32(344, le);
  h.sform_code = dv.getInt32(348, le);
  h.quatern = [dv.getFloat64(352, le), dv.getFloat64(360, le), dv.getFloat64(368, le)];
  h.qoffset = [dv.getFloat64(376, le), dv.getFloat64(384, le), dv.getFloat64(392, le)];
  h.srow = [0, 1, 2].map((r) => Array.from({ length: 4 }, (_, c) => dv.getFloat64(400 + 32 * r + 8 * c, le)));
  h.slice_code = dv.getInt32(496, le);
  h.xyzt_units = dv.getInt32(500, le);
  h.intent_code = dv.getInt32(504, le);
  h.intent_name = readString(u8, 508, 16);
  h.dim_info = u8[524];
  return h;
}

/** qform affine (4x4 row-major nested arrays), following nifti1_io / nibabel. */
export function qformAffine(h) {
  let [b, c, d] = h.quatern;
  let a2 = 1.0 - (b * b + c * c + d * d);
  let a;
  if (a2 < 1e-7) {
    // nibabel: treat as 180 degree rotation; renormalise (b,c,d)
    const n = Math.sqrt(b * b + c * c + d * d);
    b /= n; c /= n; d /= n; a = 0;
  } else a = Math.sqrt(a2);
  const R = [
    [a * a + b * b - c * c - d * d, 2 * b * c - 2 * a * d, 2 * b * d + 2 * a * c],
    [2 * b * c + 2 * a * d, a * a + c * c - b * b - d * d, 2 * c * d - 2 * a * b],
    [2 * b * d - 2 * a * c, 2 * c * d + 2 * a * b, a * a + d * d - c * c - b * b],
  ];
  let qfac = h.pixdim[0];
  if (qfac !== -1) qfac = 1; // nibabel: 0 or anything else treated as 1
  const zooms = [h.pixdim[1], h.pixdim[2], h.pixdim[3] * qfac];
  const A = [0, 1, 2].map((r) => [R[r][0] * zooms[0], R[r][1] * zooms[1], R[r][2] * zooms[2], h.qoffset[r]]);
  A.push([0, 0, 0, 1]);
  return A;
}

export function sformAffine(h) {
  return [h.srow[0].slice(), h.srow[1].slice(), h.srow[2].slice(), [0, 0, 0, 1]];
}

/**
 * Select the voxel->RAS+ affine.
 * priority 'sform' (NIfTI/nibabel convention) or 'qform'. Returns { affine, source, divergence }.
 */
export function chooseAffine(h, priority = 'sform') {
  const hasS = h.sform_code > 0, hasQ = h.qform_code > 0;
  const S = hasS ? sformAffine(h) : null;
  const Q = hasQ ? qformAffine(h) : null;
  let divergence = null;
  if (S && Q) {
    let m = 0;
    for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) m = Math.max(m, Math.abs(S[r][c] - Q[r][c]));
    divergence = m;
  }
  if (!S && !Q) return { affine: null, source: 'none', divergence };
  if (priority === 'qform') return Q ? { affine: Q, source: 'qform', code: h.qform_code, divergence } : { affine: S, source: 'sform', code: h.sform_code, divergence };
  return S ? { affine: S, source: 'sform', code: h.sform_code, divergence } : { affine: Q, source: 'qform', code: h.qform_code, divergence };
}

/** Effective scaling (NIfTI: apply only when scl_slope is finite and non-zero). */
export function effectiveScaling(h) {
  const s = h.scl_slope, i = h.scl_inter;
  if (!Number.isFinite(s) || s === 0) return { slope: 1, inter: 0, applied: false };
  const inter = Number.isFinite(i) ? i : 0;
  return { slope: s, inter, applied: !(s === 1 && inter === 0) };
}

/**
 * Read a NIfTI volume.
 * @param {Uint8Array} bytes .nii or .nii.gz (or .hdr when imgBytes given)
 * @param {Uint8Array} [imgBytes] separate .img data for ni1/ni2 pairs
 */
export function readNifti(bytes, imgBytes) {
  let u8 = isGzip(bytes) ? gunzipAll(bytes) : bytes;
  const h = parseNiftiHeader(u8);
  const ndim = h.dim[0];
  if (ndim < 1 || ndim > 7) throw new Error(`Invalid dim[0]=${ndim}`);
  const dims = h.dim.slice(1, ndim + 1).map((d) => Math.max(1, d));
  // collapse trailing singleton dimensions beyond 3
  while (dims.length > 3 && dims[dims.length - 1] === 1) dims.pop();
  while (dims.length < 3) dims.push(1);
  const info = DT_INFO[h.datatype];
  if (!info) throw new Error(`Unsupported NIfTI datatype ${h.datatype}`);
  const nvox = dims.reduce((a, b) => a * b, 1);
  let src, off;
  if (h.magic === 'ni1' || h.magic === 'ni2') {
    if (!imgBytes) throw new Error('Two-file NIfTI (.hdr/.img) requires the .img file');
    src = isGzip(imgBytes) ? gunzipAll(imgBytes) : imgBytes; off = 0;
  } else { src = u8; off = Math.round(h.vox_offset); }
  if (off < h.sizeof_hdr && h.magic.startsWith('n+')) throw new Error(`Invalid vox_offset ${h.vox_offset}`);
  const nbytes = nvox * info.bytes;
  if (src.length < off + nbytes) throw new Error(`NIfTI data truncated: need ${off + nbytes} bytes, have ${src.length}`);
  let data = null;
  const raw = src.subarray(off, off + nbytes);
  if (info.arr) {
    const copy = raw.slice();
    if (!h.littleEndian && info.bytes > 1) byteSwap(copy, info.bytes);
    data = new info.arr(copy.buffer);
  }
  return { header: h, dims, nvox, datatype: h.datatype, dtype: info.name, data, raw: info.arr ? null : raw.slice(), headerBytes: u8.subarray(0, off) };
}

function byteSwap(u8, size) {
  for (let i = 0; i < u8.length; i += size) {
    for (let a = i, b = i + size - 1; a < b; a++, b--) { const t = u8[a]; u8[a] = u8[b]; u8[b] = t; }
  }
}

/**
 * Write a single-file NIfTI-1 (.nii) volume. Used for re-emitting dcm2niix output after defacing
 * or header anonymisation: the original header block (incl. extensions) is kept byte-for-byte,
 * except for explicitly patched fields.
 */
export function rewriteNifti(headerBlock, data, patch = {}) {
  const h = parseNiftiHeader(headerBlock);
  const le = h.littleEndian;
  const out = new Uint8Array(headerBlock.length + data.byteLength);
  out.set(headerBlock, 0);
  const dv = new DataView(out.buffer);
  if (patch.descrip !== undefined) writeString(out, h.version === 1 ? 148 : 240, 80, patch.descrip);
  if (patch.aux_file !== undefined) writeString(out, h.version === 1 ? 228 : 320, 24, patch.aux_file);
  if (patch.srow !== undefined) {
    for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) {
      if (h.version === 1) dv.setFloat32(280 + 16 * r + 4 * c, patch.srow[r][c], le);
      else dv.setFloat64(400 + 32 * r + 8 * c, patch.srow[r][c], le);
    }
  }
  if (patch.sform_code !== undefined) { if (h.version === 1) dv.setInt16(254, patch.sform_code, le); else dv.setInt32(348, patch.sform_code, le); }
  if (patch.qform_code !== undefined) { if (h.version === 1) dv.setInt16(252, patch.qform_code, le); else dv.setInt32(344, patch.qform_code, le); }
  if (patch.cal !== undefined) {
    if (h.version === 1) { dv.setFloat32(124, patch.cal[1], le); dv.setFloat32(128, patch.cal[0], le); }
    else { dv.setFloat64(192, patch.cal[1], le); dv.setFloat64(200, patch.cal[0], le); }
  }
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
  const bpv = data.BYTES_PER_ELEMENT;
  if (!le && bpv > 1) byteSwap(bytes, bpv);
  out.set(bytes, headerBlock.length);
  return out;
}

function writeString(u8, off, len, s) {
  for (let i = 0; i < len; i++) u8[off + i] = i < s.length ? s.charCodeAt(i) & 0x7f : 0;
}

export function gzip(u8, level = 6) { return gzipSync(u8, { level }); }

/** Physical value accessor (applies NIfTI scaling). */
export function physicalValueFn(vol) {
  const { slope, inter } = effectiveScaling(vol.header);
  const d = vol.data;
  const big = d instanceof BigInt64Array || d instanceof BigUint64Array;
  return big ? (i) => Number(d[i]) * slope + inter : (i) => d[i] * slope + inter;
}
