// NIfTI reader: header fields, affines (sform/qform, nibabel conventions), scaling, gzip members.
import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'fflate';
import { readNifti, chooseAffine, qformAffine, effectiveScaling } from '../../src/engine/nifti.js';

function makeNifti({ dims = [3, 2, 2], datatype = 4, bitpix = 16, data, srow, sform = 1, qform = 1, quatern = [0, 0, 0], qoffset = [0, 0, 0], pixdim = [1, 1, 1, 1], slope = 0, inter = 0, le = true }) {
  const buf = new ArrayBuffer(352 + data.byteLength);
  const dv = new DataView(buf); const u8 = new Uint8Array(buf);
  dv.setInt32(0, 348, le);
  dv.setInt16(40, dims.length, le); dims.forEach((d, i) => dv.setInt16(42 + 2 * i, d, le));
  for (let i = dims.length; i < 7; i++) dv.setInt16(42 + 2 * i, 1, le);
  dv.setInt16(70, datatype, le); dv.setInt16(72, bitpix, le);
  pixdim.forEach((p, i) => dv.setFloat32(76 + 4 * i, p, le));
  dv.setFloat32(108, 352, le); dv.setFloat32(112, slope, le); dv.setFloat32(116, inter, le);
  dv.setInt16(252, qform, le); dv.setInt16(254, sform, le);
  quatern.forEach((q, i) => dv.setFloat32(256 + 4 * i, q, le)); qoffset.forEach((q, i) => dv.setFloat32(268 + 4 * i, q, le));
  if (srow) srow.forEach((r, ri) => r.forEach((v, ci) => dv.setFloat32(280 + 16 * ri + 4 * ci, v, le)));
  u8.set([0x6e, 0x2b, 0x31, 0], 344);
  const src = new Uint8Array(data.buffer.slice(0));
  if (!le && data.BYTES_PER_ELEMENT > 1) for (let i = 0; i < src.length; i += data.BYTES_PER_ELEMENT) src.subarray(i, i + data.BYTES_PER_ELEMENT).reverse();
  u8.set(src, 352);
  return u8;
}

test('reads a little-endian int16 NIfTI-1 with sform', () => {
  const data = Int16Array.from({ length: 12 }, (_, i) => i - 6);
  const srow = [[-1, 0, 0, 10], [0, 1, 0, -5], [0, 0, 2.5, 3]];
  const v = readNifti(makeNifti({ data, srow }));
  assert.deepEqual(v.dims, [3, 2, 2]); assert.equal(v.dtype, 'int16'); assert.deepEqual(Array.from(v.data), Array.from(data));
  const a = chooseAffine(v.header, 'sform');
  assert.equal(a.source, 'sform'); assert.deepEqual(a.affine.slice(0, 3), srow);
});

test('big-endian files are byte-swapped', () => {
  const data = Int16Array.from([1, -2, 300, -4000, 5, 6, 7, 8, 9, 10, 11, 12]);
  const v = readNifti(makeNifti({ data, srow: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]], le: false }));
  assert.equal(v.header.littleEndian, false); assert.deepEqual(Array.from(v.data), Array.from(data));
});

test('gzip with several members is fully decompressed', () => {
  const raw = makeNifti({ data: new Int16Array(12).fill(3), srow: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]] });
  const half = raw.length >> 1;
  const a = gzipSync(raw.subarray(0, half)), b = gzipSync(raw.subarray(half));
  const both = new Uint8Array(a.length + b.length); both.set(a); both.set(b, a.length);
  const v = readNifti(both);
  assert.deepEqual(Array.from(v.data), new Array(12).fill(3));
});

test('qform follows nibabel: quaternion, qfac and offsets', () => {
  // 90 degrees about z: b=c=0, d=sin(45deg)
  const d = Math.SQRT1_2;
  const v = readNifti(makeNifti({ data: new Int16Array(12), quatern: [0, 0, d], qoffset: [1, 2, 3], pixdim: [-1, 2, 3, 4], sform: 0 }));
  const A = qformAffine(v.header);
  const r = (x) => Math.round(x * 1e6) / 1e6 + 0;
  assert.deepEqual(A.slice(0, 3).map((row) => row.map(r)), [[0, -3, 0, 1], [2, 0, 0, 2], [0, 0, -4, 3]]);
  assert.equal(chooseAffine(v.header, 'sform').source, 'qform', 'falls back to qform when sform_code is 0');
});

test('scl_slope 0 means no scaling (NIfTI standard)', () => {
  assert.deepEqual(effectiveScaling({ scl_slope: 0, scl_inter: 5 }), { slope: 1, inter: 0, applied: false });
  assert.deepEqual(effectiveScaling({ scl_slope: 2, scl_inter: NaN }), { slope: 2, inter: 0, applied: true });
});

test('truncated data is reported, not silently padded', () => {
  const u8 = makeNifti({ data: new Int16Array(12), srow: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]] });
  assert.throws(() => readNifti(u8.subarray(0, u8.length - 2)), /truncated/);
});
