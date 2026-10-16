// Geometry: every DICOM pixel centre written by OMNIA must land exactly on the NIfTI voxel it came from.
import test from 'node:test';
import assert from 'node:assert/strict';
import { planSlices, inv4, applyAffine, GeometryError } from '../../src/engine/geometry.js';

function rot(ax, ay, az) {
  const [cx, sx, cy, sy, cz, sz] = [Math.cos(ax), Math.sin(ax), Math.cos(ay), Math.sin(ay), Math.cos(az), Math.sin(az)];
  const Rx = [[1, 0, 0], [0, cx, -sx], [0, sx, cx]], Ry = [[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]], Rz = [[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]];
  const mul = (A, B) => A.map((r) => [0, 1, 2].map((c) => r[0] * B[0][c] + r[1] * B[1][c] + r[2] * B[2][c]));
  return mul(Rz, mul(Ry, Rx));
}
function affine(R, zooms, t, flip = [1, 1, 1]) {
  return [0, 1, 2].map((r) => [R[r][0] * zooms[0] * flip[0], R[r][1] * zooms[1] * flip[1], R[r][2] * zooms[2] * flip[2], t[r]]).concat([[0, 0, 0, 1]]);
}
function checkExact(A, dims) {
  const p = planSlices(A, dims);
  const inv = inv4(A);
  const rowDir = p.iop.slice(0, 3), colDir = p.iop.slice(3);
  let maxErr = 0;
  const seen = new Set();
  for (let k = 0; k < dims[2]; k++) {
    for (let r = 0; r < p.rows; r++) for (let c = 0; c < p.columns; c++) {
      const lps = [0, 1, 2].map((a) => p.positions[k][a] + c * p.pixelSpacing[1] * rowDir[a] + r * p.pixelSpacing[0] * colDir[a]);
      const ras = [-lps[0], -lps[1], lps[2]];
      const idx = applyAffine(inv, ras);
      const ri = idx.map((v) => Math.round(v) + 0);
      maxErr = Math.max(maxErr, ...idx.map((v, i) => Math.abs(v - ri[i])));
      assert.deepEqual(ri, p.toIndex(r, c, k));
      seen.add(ri.join(','));
    }
  }
  assert.ok(maxErr < 1e-9, `index error ${maxErr}`);
  assert.equal(seen.size, dims[0] * dims[1] * dims[2], 'every voxel exactly once');
  // IOP unit vectors, orthogonal
  const dot = rowDir[0] * colDir[0] + rowDir[1] * colDir[1] + rowDir[2] * colDir[2];
  assert.ok(Math.abs(dot) < 1e-12);
  return p;
}

test('axial RAS identity grid maps voxel-exactly and is displayed radiologically', () => {
  const p = checkExact(affine(rot(0, 0, 0), [0.9, 0.9, 2], [10, -20, 30]), [7, 5, 4]);
  assert.equal(p.plane, 'AXIAL');
  assert.deepEqual(p.iop.map((x) => Math.round(x) + 0), [1, 0, 0, 0, 1, 0]);
  assert.ok(Math.abs(p.planeSpacing - 2) < 1e-12);
  assert.equal(p.tilted, false);
});

test('LAS / flipped and permuted grids (coronal, sagittal) map voxel-exactly', () => {
  checkExact(affine(rot(0, 0, 0), [1, 1, 1.5], [0, 0, 0], [-1, 1, 1]), [6, 5, 3]);
  const cor = checkExact(affine(rot(Math.PI / 2, 0, 0), [0.8, 0.8, 3], [5, 5, 5]), [6, 7, 3]);
  assert.equal(cor.plane, 'CORONAL');
  const sag = checkExact(affine(rot(0, Math.PI / 2, 0), [1, 1, 4], [-5, 2, 1]), [5, 6, 3]);
  assert.equal(sag.plane, 'SAGITTAL');
});

test('random oblique grids (200 cases) map voxel-exactly', () => {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let n = 0; n < 200; n++) {
    const R = rot((rnd() - 0.5) * 6, (rnd() - 0.5) * 6, (rnd() - 0.5) * 6);
    const z = [0.3 + rnd() * 3, 0.3 + rnd() * 3, 0.5 + rnd() * 5];
    const flip = [rnd() < 0.5 ? -1 : 1, 1, rnd() < 0.5 ? -1 : 1];
    checkExact(affine(R, z, [(rnd() - 0.5) * 300, (rnd() - 0.5) * 300, (rnd() - 0.5) * 300], flip), [4 + Math.floor(rnd() * 4), 4 + Math.floor(rnd() * 4), 2 + Math.floor(rnd() * 3)]);
  }
});

test('gantry tilt (slice axis sheared out of the image plane) is detected and stays exact', () => {
  const t = 20 * Math.PI / 180;
  // slices step along z but also along y: tilt of 20 degrees, in-plane axes stay orthogonal
  const A = [[0.5, 0, 0, 0], [0, 0.5, 2 * Math.tan(t), 0], [0, 0, 2, 0], [0, 0, 0, 1]];
  const p = checkExact(A, [5, 5, 4]);
  assert.equal(p.tilted, true);
  assert.ok(Math.abs(Math.abs(p.gantryTiltDeg) - 20) < 1e-9, `tilt ${p.gantryTiltDeg}`);
  assert.ok(Math.abs(p.planeSpacing - 2) < 1e-12, 'distance between planes is the z step');
});

test('in-plane shear is refused (DICOM cannot represent it without resampling)', () => {
  const A = [[1, 0.2, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  assert.throws(() => planSlices(A, [4, 4, 4]), GeometryError);
});

test('zero voxel size is refused', () => {
  const A = [[0, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  assert.throws(() => planSlices(A, [4, 4, 4]), GeometryError);
});
