// Geometry: NIfTI (RAS+) <-> DICOM (LPS+) patient coordinate mapping and slice planning.
// Conventions:
//   NIfTI affine maps voxel index (i,j,k) to RAS+ world (mm).
//   DICOM Patient Coordinate System is LPS+. ImageOrientationPatient = [rowDir, colDir] where
//   rowDir is the direction of increasing column index (along a row) and colDir the direction
//   of increasing row index. PixelSpacing = [spacing between rows, spacing between columns].

export const ORTHO_TOL = 1e-4; // |cos| tolerance for in-plane orthogonality

export class GeometryError extends Error {}

export function lpsFromRas(A) {
  return [
    [-A[0][0], -A[0][1], -A[0][2], -A[0][3]],
    [-A[1][0], -A[1][1], -A[1][2], -A[1][3]],
    [A[2][0], A[2][1], A[2][2], A[2][3]],
    [0, 0, 0, 1],
  ];
}

export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const norm = (a) => Math.sqrt(dot(a, a));
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const unit = (a) => scale(a, 1 / norm(a));

export function applyAffine(M, idx) {
  return [0, 1, 2].map((r) => M[r][0] * idx[0] + M[r][1] * idx[1] + M[r][2] * idx[2] + M[r][3]);
}

export function inv4(m) {
  // General 4x4 inverse (Gauss-Jordan with partial pivoting), float64.
  const a = m.map((r) => r.slice());
  const inv = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  for (let c = 0; c < 4; c++) {
    let p = c;
    for (let r = c + 1; r < 4; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    if (Math.abs(a[p][c]) < 1e-12) throw new GeometryError('Singular affine');
    [a[c], a[p]] = [a[p], a[c]]; [inv[c], inv[p]] = [inv[p], inv[c]];
    const d = a[c][c];
    for (let k = 0; k < 4; k++) { a[c][k] /= d; inv[c][k] /= d; }
    for (let r = 0; r < 4; r++) {
      if (r === c) continue;
      const f = a[r][c];
      if (f === 0) continue;
      for (let k = 0; k < 4; k++) { a[r][k] -= f * a[c][k]; inv[r][k] -= f * inv[c][k]; }
    }
  }
  return inv;
}

/** Plane name from a slice normal (dominant LPS axis). */
export function planeOf(normal) {
  const ax = [0, 1, 2].reduce((best, i) => (Math.abs(normal[i]) > Math.abs(normal[best]) ? i : best), 0);
  return ax === 2 ? 'AXIAL' : ax === 1 ? 'CORONAL' : 'SAGITTAL';
}

// Conventional radiological display targets (LPS): [rowDir target, colDir target].
const TARGETS = {
  AXIAL: [[1, 0, 0], [0, 1, 0]], // columns run R->L, rows run A->P
  CORONAL: [[1, 0, 0], [0, 0, -1]], // columns R->L, rows S->I
  SAGITTAL: [[0, 1, 0], [0, 0, -1]], // columns A->P, rows S->I
};

/**
 * Analyse a NIfTI affine and produce the slice plan for a classic DICOM series.
 * @param {number[][]} rasAffine 4x4
 * @param {number[]} dims [nx, ny, nz]
 * @param {{reference?: object}} opts optional reference series geometry to match exactly
 */
export function planSlices(rasAffine, dims, opts = {}) {
  const M = lpsFromRas(rasAffine);
  const cols = [0, 1, 2].map((c) => [M[0][c], M[1][c], M[2][c]]);
  const s = cols.map(norm);
  if (s.some((x) => !(x > 0) || !Number.isFinite(x))) throw new GeometryError('Affine has zero or invalid voxel size');
  const u = cols.map((c, i) => scale(c, 1 / s[i]));
  const cosInPlane = dot(u[0], u[1]);
  if (Math.abs(cosInPlane) > ORTHO_TOL) {
    throw new GeometryError(`In-plane axes are not orthogonal (cos=${cosInPlane.toExponential(3)}); DICOM cannot represent in-plane shear without resampling`);
  }
  const n = unit(cross(u[0], u[1]));
  const sliceCos = dot(u[2], n);
  if (Math.abs(sliceCos) < 0.1) throw new GeometryError('Slice axis is (nearly) parallel to the image plane');

  const plane = planeOf(n);
  let choice = null;
  if (opts.reference) choice = matchReference(u, s, dims, M, opts.reference);
  if (!choice) choice = conventionalChoice(u, plane);

  const { colAxis, colSign, rowAxis, rowSign } = choice;
  const rowDir = scale(u[colAxis], colSign);
  const colDir = scale(u[rowAxis], rowSign);
  const columns = dims[colAxis], rows = dims[rowAxis];
  const nz = dims[2];
  const toIndex = (r, c, k) => {
    const idx = [0, 0, k];
    idx[colAxis] = colSign > 0 ? c : dims[colAxis] - 1 - c;
    idx[rowAxis] = rowSign > 0 ? r : dims[rowAxis] - 1 - r;
    return idx;
  };
  const positions = [];
  for (let k = 0; k < nz; k++) positions.push(applyAffine(M, toIndex(0, 0, k)));
  const sliceNormal = cross(rowDir, colDir); // right-handed with IOP
  const planeSpacing = Math.abs(s[2] * dot(u[2], sliceNormal));
  return {
    plane, rows, columns, nz,
    iop: [...rowDir, ...colDir],
    pixelSpacing: [s[rowAxis], s[colAxis]],
    positions,
    sliceNormal,
    planeSpacing,
    sliceStep: s[2],
    tilted: Math.abs(Math.abs(dot(u[2], sliceNormal)) - 1) > 1e-6,
    choice, toIndex, lps: M, matchedReference: !!choice.reference,
    sliceLocation: positions.map((p) => dot(p, sliceNormal)),
    // nominal gantry tilt (degrees): angle between the slice stepping direction and the image plane normal,
    // signed by the column-direction component (matches vendor 0018,1120 sign in validation data)
    gantryTiltDeg: Math.asin(Math.max(-1, Math.min(1, dot(u[2], colDir)))) * 180 / Math.PI,
  };
}

function conventionalChoice(u, plane) {
  const [tr, tc] = TARGETS[plane];
  // pick the in-plane NIfTI axis best aligned with the target row direction
  const d0 = dot(u[0], tr), d1 = dot(u[1], tr);
  const colAxis = Math.abs(d0) >= Math.abs(d1) ? 0 : 1;
  const rowAxis = 1 - colAxis;
  const colSign = dot(u[colAxis], tr) >= 0 ? 1 : -1;
  const rowSign = dot(u[rowAxis], tc) >= 0 ? 1 : -1;
  return { colAxis, colSign, rowAxis, rowSign };
}

/**
 * Try to map the NIfTI grid onto a reference DICOM series grid exactly (same voxels, same positions).
 * reference: { rows, columns, iop[6], pixelSpacing[2], positions: [[x,y,z]...] sorted along the normal }
 * Returns the choice (with .reference) or null.
 */
export const POS_TOL_MM = 0.01;
export const DIR_TOL = 1e-4;
function matchReference(u, s, dims, M, ref) {
  const rRow = ref.iop.slice(0, 3), rCol = ref.iop.slice(3, 6);
  for (const colAxis of [0, 1]) {
    const rowAxis = 1 - colAxis;
    for (const colSign of [1, -1]) {
      for (const rowSign of [1, -1]) {
        const rowDir = scale(u[colAxis], colSign), colDir = scale(u[rowAxis], rowSign);
        if (norm(sub(rowDir, rRow)) > DIR_TOL || norm(sub(colDir, rCol)) > DIR_TOL) continue;
        if (dims[colAxis] !== ref.columns || dims[rowAxis] !== ref.rows || dims[2] !== ref.positions.length) continue;
        if (Math.abs(s[rowAxis] - ref.pixelSpacing[0]) > 1e-4 * Math.max(1, ref.pixelSpacing[0]) ||
            Math.abs(s[colAxis] - ref.pixelSpacing[1]) > 1e-4 * Math.max(1, ref.pixelSpacing[1])) continue;
        const toIndex = (r, c, k) => {
          const idx = [0, 0, k];
          idx[colAxis] = colSign > 0 ? c : dims[colAxis] - 1 - c;
          idx[rowAxis] = rowSign > 0 ? r : dims[rowAxis] - 1 - r;
          return idx;
        };
        // compare positions slice-by-slice, allowing reversed slice order
        const ours = [];
        for (let k = 0; k < dims[2]; k++) ours.push(applyAffine(M, toIndex(0, 0, k)));
        const tryOrder = (rev) => {
          let maxErr = 0;
          for (let k = 0; k < ours.length; k++) {
            const rp = ref.positions[rev ? ours.length - 1 - k : k];
            maxErr = Math.max(maxErr, norm(sub(ours[k], rp)));
          }
          return maxErr;
        };
        const e0 = tryOrder(false), e1 = tryOrder(true);
        const err = Math.min(e0, e1);
        if (err <= POS_TOL_MM) {
          return { colAxis, colSign, rowAxis, rowSign, reference: true, reversed: e1 < e0, maxPositionError: err };
        }
      }
    }
  }
  return null;
}

/** Geometry of a set of parsed classic DICOM instances (for reference matching / verification). */
export function seriesGeometry(instances) {
  // instances: [{ipp:[3], iop:[6], ps:[2], rows, cols, ...}]
  if (!instances.length) return null;
  const iop = instances[0].iop;
  const n = unit(cross(iop.slice(0, 3), iop.slice(3, 6)));
  const sorted = instances.slice().sort((a, b) => dot(a.ipp, n) - dot(b.ipp, n));
  return {
    rows: sorted[0].rows, columns: sorted[0].cols, iop, pixelSpacing: sorted[0].ps,
    positions: sorted.map((i) => i.ipp), instances: sorted, normal: n,
    consistent: sorted.every((i) => i.rows === sorted[0].rows && i.cols === sorted[0].cols &&
      i.iop.every((v, j) => Math.abs(v - iop[j]) < DIR_TOL) &&
      Math.abs(i.ps[0] - sorted[0].ps[0]) < 1e-4 && Math.abs(i.ps[1] - sorted[0].ps[1]) < 1e-4),
  };
}

/**
 * Spacing analysis along the normal for positions already sorted along it.
 * Returns { spacings, uniform, runs } where runs partition the slices (each slice in exactly one run)
 * into maximal blocks of uniform spacing: [[first, last], ...] (inclusive indices).
 */
export function spacingRuns(positions, normal, tolMm = 0.01, tolRel = 1e-3) {
  const d = positions.map((p) => dot(p, normal));
  const sp = [];
  for (let i = 1; i < d.length; i++) sp.push(d[i] - d[i - 1]);
  const same = (a, b) => Math.abs(a - b) <= Math.max(tolMm, tolRel * Math.abs(b));
  const runs = [];
  let first = 0, step = null;
  for (let i = 1; i < d.length; i++) {
    const s = d[i] - d[i - 1];
    if (step === null) { step = s; continue; }
    if (same(s, step)) continue;
    runs.push([first, i - 1]);
    first = i; step = null;
  }
  if (d.length) runs.push([first, d.length - 1]);
  const duplicates = sp.filter((x) => Math.abs(x) < tolMm).length;
  return { spacings: sp, uniform: runs.length === 1 && duplicates === 0, runs, duplicates };
}
