// CT head defacing by a shear plane fitted to the intracranial volume.
//
// Method (OMNIA's own implementation of the "shear-plane" idea published as Quickshear,
// Schimke & Hale 2011):
//  1. Work on a ~2 mm subsampled grid. Classify voxels in Hounsfield units: bone (>= 300 HU),
//     brain/CSF-like soft tissue (-20..100 HU), barrier (< -50 HU: air, fat).
//  2. Intracranial candidates are soft-tissue voxels enclosed by bone towards the left, right,
//     anterior, posterior and superior directions (ray test: the first non-soft-tissue voxel met in
//     each direction must be bone). Face, scalp and neck tissues fail at least one direction.
//  3. The largest 6-connected component is the intracranial mask; implausible volumes abort.
//  4. The mask is projected onto the sagittal plane (anterior/superior world coordinates); the line
//     tangent to its convex hull with an outward normal pointing 45 degrees anterior-inferior defines
//     the cutting plane, which is then moved 4 mm away from the brain (safety buffer).
//  5. Every voxel denser than air on the anterior-inferior side of that plane (all sagittal positions)
//     is set to air (-1000 HU); voxels already at or below -1000 HU are left untouched. By convexity the
//     plane never intersects the intracranial mask.
import { effectiveScaling } from './nifti.js';

const BONE = 300, SOFT_LO = -20, SOFT_HI = 100, BARRIER = -50;
export const DEFACE_BUFFER_MM = 4;

function axisInfo(A) {
  // for each voxel axis: dominant RAS axis and sign
  return [0, 1, 2].map((c) => {
    const v = [A[0][c], A[1][c], A[2][c]];
    let best = 0;
    for (let r = 1; r < 3; r++) if (Math.abs(v[r]) > Math.abs(v[best])) best = r;
    return { ras: best, sign: Math.sign(v[best]), len: Math.hypot(v[0], v[1], v[2]) };
  });
}

/**
 * Deface a CT volume in place.
 * @param {{dims:number[], data:TypedArray, header:object, dtype:string}} vol (3D)
 * @param {number[][]} A voxel->RAS affine
 * @returns {{status:'defaced'|'no-face-in-fov'|'failed', reason?:string, removedVoxels:number,
 *   intracranialML:number, plane?:{n:number[], c:number}, removedTissueML:number}}
 */
export function defaceCT(vol, A) {
  const [nx, ny, nz] = vol.dims;
  if (vol.dims.length > 3 && vol.dims.slice(3).some((d) => d > 1)) return { status: 'failed', reason: '4D volumes are not defaced', removedVoxels: 0, intracranialML: 0, removedTissueML: 0 };
  const { slope, inter } = effectiveScaling(vol.header);
  const d = vol.data;
  const big = d instanceof BigInt64Array || d instanceof BigUint64Array;
  const hu = (L) => (big ? Number(d[L]) : d[L]) * slope + inter;
  const ax = axisInfo(A);
  const rasAxes = ax.map((a) => a.ras).sort();
  if (rasAxes[0] !== 0 || rasAxes[1] !== 1 || rasAxes[2] !== 2) return { status: 'failed', reason: 'volume too oblique for defacing', removedVoxels: 0, intracranialML: 0, removedTissueML: 0 };
  // subsample to ~2 mm
  const step = ax.map((a) => Math.max(1, Math.round(2 / a.len)));
  const m = [Math.ceil(nx / step[0]), Math.ceil(ny / step[1]), Math.ceil(nz / step[2])];
  const M = m[0] * m[1] * m[2];
  const cls = new Uint8Array(M); // 0 transparent/neutral, 1 soft, 2 bone, 3 barrier
  for (let k = 0; k < m[2]; k++) for (let j = 0; j < m[1]; j++) for (let i = 0; i < m[0]; i++) {
    const v = hu(i * step[0] + nx * (j * step[1] + ny * (k * step[2])));
    cls[i + m[0] * (j + m[1] * k)] = v >= BONE ? 2 : v < BARRIER ? 3 : v >= SOFT_LO && v <= SOFT_HI ? 1 : 0;
  }
  // enclosure counts
  const cnt = new Uint8Array(M);
  const strides = [1, m[0], m[0] * m[1]];
  const sweep = (axis, towardHigh, edgeIsBone) => {
    // state = first non-transparent class found looking toward increasing (towardHigh) index of `axis`
    const others = [0, 1, 2].filter((a) => a !== axis);
    for (let b = 0; b < m[others[1]]; b++) for (let a = 0; a < m[others[0]]; a++) {
      const base = a * strides[others[0]] + b * strides[others[1]];
      let state = edgeIsBone ? 2 : 3;
      const n = m[axis];
      for (let t = 0; t < n; t++) {
        const idx = towardHigh ? n - 1 - t : t;
        const L = base + idx * strides[axis];
        const c = cls[L];
        if (c === 1) { if (state === 2) cnt[L]++; }
        else if (c === 2 || c === 3) state = c;
      }
    }
  };
  for (let a = 0; a < 3; a++) {
    const { ras, sign } = ax[a];
    if (ras === 0) { sweep(a, true, false); sweep(a, false, false); } // both lateral directions
    else if (ras === 1) { sweep(a, true, false); sweep(a, false, false); } // anterior and posterior
    else sweep(a, sign > 0, true); // superior only; a cut-off vertex counts as enclosed
  }
  const cand = new Uint8Array(M);
  for (let L = 0; L < M; L++) cand[L] = cls[L] === 1 && cnt[L] === 5 ? 1 : 0;
  // largest 6-connected component
  const visited = new Uint8Array(M);
  let bestSeed = -1, bestSize = 0;
  const queue = new Int32Array(M);
  const ijk = (L) => [L % m[0], Math.floor(L / m[0]) % m[1], Math.floor(L / (m[0] * m[1]))];
  const flood = (seed, mark) => {
    let h = 0, t = 0;
    queue[t++] = seed; visited[seed] = 1;
    while (h < t) {
      const L = queue[h++];
      if (mark) mark[L] = 1;
      const [i, j, k] = ijk(L);
      const nb = [];
      if (i > 0) nb.push(L - 1); if (i < m[0] - 1) nb.push(L + 1);
      if (j > 0) nb.push(L - m[0]); if (j < m[1] - 1) nb.push(L + m[0]);
      if (k > 0) nb.push(L - m[0] * m[1]); if (k < m[2] - 1) nb.push(L + m[0] * m[1]);
      for (const q of nb) if (cand[q] && !visited[q]) { visited[q] = 1; queue[t++] = q; }
    }
    return t;
  };
  for (let L = 0; L < M; L++) {
    if (cand[L] && !visited[L]) {
      const size = flood(L, null);
      if (size > bestSize) { bestSize = size; bestSeed = L; }
    }
  }
  const voxML = (ax[0].len * step[0]) * (ax[1].len * step[1]) * (ax[2].len * step[2]) / 1000;
  const icv = bestSize * voxML;
  if (bestSeed < 0 || icv < 300 || icv > 2600) {
    return { status: 'failed', reason: `intracranial volume not detected (${icv.toFixed(0)} mL)`, removedVoxels: 0, intracranialML: icv, removedTissueML: 0 };
  }
  visited.fill(0);
  const mask = new Uint8Array(M);
  flood(bestSeed, mask);
  // world coordinates (RAS) of subsampled voxel centres -> sagittal projection (anterior y, superior z)
  const world = (i, j, k) => [0, 1, 2].map((r) => A[r][0] * i + A[r][1] * j + A[r][2] * k + A[r][3]);
  const pts = new Map(); // key: rounded z (1 mm bins) -> [minY, maxY]
  for (let L = 0; L < M; L++) {
    if (!mask[L]) continue;
    const [i, j, k] = ijk(L);
    const w = world(i * step[0], j * step[1], k * step[2]);
    const key = Math.round(w[2]);
    const e = pts.get(key);
    if (!e) pts.set(key, [w[1], w[1], w[2]]);
    else { if (w[1] < e[0]) e[0] = w[1]; if (w[1] > e[1]) e[1] = w[1]; }
  }
  const P = [];
  for (const [, [lo, hi, z]] of pts) { P.push([lo, z]); P.push([hi, z]); }
  const hull = convexHull(P); // counter-clockwise
  if (hull.length < 3) return { status: 'failed', reason: 'degenerate intracranial projection', removedVoxels: 0, intracranialML: icv, removedTissueML: 0 };
  // support line of the intracranial projection in the anterior-inferior direction (45 degrees):
  // n.p <= c for every intracranial point, with equality at the tangent vertex.
  const n45 = [Math.SQRT1_2, -Math.SQRT1_2];
  let cMax = -Infinity, tangent = null;
  for (const p of hull) { const v = n45[0] * p[0] + n45[1] * p[1]; if (v > cMax) { cMax = v; tangent = p; } }
  const best = { n: n45, c: cMax, edge: [tangent, tangent] };
  // safety: no mask point beyond the plane (convexity guarantee, re-checked numerically)
  for (const p of P) if (best.n[0] * p[0] + best.n[1] * p[1] > best.c + 1e-6) return { status: 'failed', reason: 'internal hull check failed', removedVoxels: 0, intracranialML: icv, removedTissueML: 0 };
  const cut = best.c + DEFACE_BUFFER_MM;
  // apply to full resolution
  const airRaw = (() => {
    let r = Math.round((-1000 - inter) / slope);
    const lim = { int8: [-128, 127], uint8: [0, 255], int16: [-32768, 32767], uint16: [0, 65535], int32: [-2147483648, 2147483647], uint32: [0, 4294967295] }[vol.dtype];
    if (lim) r = Math.min(lim[1], Math.max(lim[0], r));
    return r;
  })();
  let removed = 0, tissue = 0;
  const vox = ax[0].len * ax[1].len * ax[2].len / 1000;
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) {
    const w0 = world(0, j, k);
    const dy = A[1][0], dz = A[2][0];
    let L = nx * (j + ny * k);
    for (let i = 0; i < nx; i++, L++) {
      const y = w0[1] + dy * i, z = w0[2] + dz * i;
      if (best.n[0] * y + best.n[1] * z > cut) {
        const v = hu(L);
        // only voxels denser than air are replaced: background that is already air keeps its original value
        if (!(v > -1000)) continue;
        if (v > -300) tissue++;
        if (big) d[L] = BigInt(airRaw); else d[L] = vol.dtype.startsWith('float') ? (-1000 - inter) / slope : airRaw;
        removed++;
      }
    }
  }
  const removedTissueML = tissue * vox;
  return {
    status: removedTissueML < 5 ? 'no-face-in-fov' : 'defaced', removedVoxels: removed, intracranialML: icv, removedTissueML,
    plane: { n: best.n, c: cut, edge: best.edge },
    hull,
  };
}

function convexHull(points) {
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  const upper = [];
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  upper.pop(); lower.pop();
  return lower.concat(upper); // counter-clockwise
}

/**
 * Frontal surface render for visual QC: rays cast in world space from anterior to posterior (1 mm steps,
 * nearest-neighbour sampling); the depth of the first voxel above the threshold is shaded.
 * Returns {w, h, pixels: Uint8ClampedArray} (grey levels), patient right on the viewer's left.
 */
export function anteriorRender(vol, A, threshold = -300, size = 256) {
  const [nx, ny, nz] = vol.dims;
  const { slope, inter } = effectiveScaling(vol.header);
  const d = vol.data;
  const big = d instanceof BigInt64Array || d instanceof BigUint64Array;
  const world = (i, j, k) => [0, 1, 2].map((r) => A[r][0] * i + A[r][1] * j + A[r][2] * k + A[r][3]);
  const Ai = invert4(A);
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const i of [0, nx - 1]) for (const j of [0, ny - 1]) for (const k of [0, nz - 1]) {
    const w = world(i, j, k);
    for (let r = 0; r < 3; r++) { mn[r] = Math.min(mn[r], w[r]); mx[r] = Math.max(mx[r], w[r]); }
  }
  const W = size, H = Math.max(16, Math.round(size * (mx[2] - mn[2]) / Math.max(1e-6, mx[0] - mn[0])));
  const depth = new Float32Array(W * H).fill(NaN);
  const stepY = 1;
  for (let py = 0; py < H; py++) {
    const z = mx[2] - (mx[2] - mn[2]) * (py + 0.5) / H;
    for (let px = 0; px < W; px++) {
      const x = mx[0] - (mx[0] - mn[0]) * (px + 0.5) / W; // patient right (max x) on the left
      for (let y = mx[1]; y >= mn[1]; y -= stepY) {
        const i = Math.round(Ai[0][0] * x + Ai[0][1] * y + Ai[0][2] * z + Ai[0][3]);
        const j = Math.round(Ai[1][0] * x + Ai[1][1] * y + Ai[1][2] * z + Ai[1][3]);
        const k = Math.round(Ai[2][0] * x + Ai[2][1] * y + Ai[2][2] * z + Ai[2][3]);
        if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) continue;
        const L = i + nx * (j + ny * k);
        const v = (big ? Number(d[L]) : d[L]) * slope + inter;
        if (v > threshold) { depth[py * W + px] = y; break; }
      }
    }
  }
  let dmin = Infinity, dmax = -Infinity;
  for (const v of depth) if (Number.isFinite(v)) { dmin = Math.min(dmin, v); dmax = Math.max(dmax, v); }
  const out = new Uint8ClampedArray(W * H);
  const pxmm = (mx[0] - mn[0]) / W;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const q = y * W + x;
    const v = depth[q];
    if (!Number.isFinite(v)) continue;
    // Lambert shading from the depth gradient (light from the viewer, slightly above)
    const vx = x + 1 < W && Number.isFinite(depth[q + 1]) ? (depth[q + 1] - v) / pxmm : 0;
    const vy = y + 1 < H && Number.isFinite(depth[q + W]) ? (depth[q + W] - v) / pxmm : 0;
    const nlen = Math.hypot(vx, vy, 1);
    const lambert = Math.max(0, (0.25 * vy + 1) / nlen / Math.hypot(0.25, 1));
    const base = 0.45 + 0.55 * ((v - dmin) / Math.max(1e-6, dmax - dmin));
    out[q] = Math.round(255 * Math.min(1, lambert * base * 1.1));
  }
  return { w: W, h: H, pixels: out };
}

function invert4(m) {
  const a = m.map((r) => r.slice()), inv = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  for (let c = 0; c < 4; c++) {
    let p = c;
    for (let r = c + 1; r < 4; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    [a[c], a[p]] = [a[p], a[c]]; [inv[c], inv[p]] = [inv[p], inv[c]];
    const dd = a[c][c];
    for (let k = 0; k < 4; k++) { a[c][k] /= dd; inv[c][k] /= dd; }
    for (let r = 0; r < 4; r++) { if (r === c) continue; const f = a[r][c]; for (let k = 0; k < 4; k++) { a[r][k] -= f * a[c][k]; inv[r][k] -= f * inv[c][k]; } }
  }
  return inv;
}
