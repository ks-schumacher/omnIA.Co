// Quality-control previews: three orthogonal mid-planes rendered in anatomical orientation
// (nearest-neighbour sampling in world space; for display only, never written to outputs).
import { effectiveScaling } from './nifti.js';
import { inv4, applyAffine } from './geometry.js';

export function renderOrtho(vol, A, modality, size = 192) {
  const [nx, ny, nz] = vol.dims;
  const nvox3 = nx * ny * nz;
  const { slope, inter } = effectiveScaling(vol.header);
  const d = vol.data;
  const big = d instanceof BigInt64Array || d instanceof BigUint64Array;
  const val = (L) => (big ? Number(d[L]) : d[L]) * slope + inter;
  const Ai = inv4(A);
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const i of [0, nx - 1]) for (const j of [0, ny - 1]) for (const k of [0, nz - 1]) {
    const w = applyAffine(A, [i, j, k]);
    for (let r = 0; r < 3; r++) { mn[r] = Math.min(mn[r], w[r]); mx[r] = Math.max(mx[r], w[r]); }
  }
  const c = mn.map((v, r) => (v + mx[r]) / 2);
  // window
  let lo, hi;
  if (modality === 'CT') { lo = -160; hi = 240; } else {
    const sample = [];
    const step = Math.max(1, Math.floor(nvox3 / 200000));
    for (let L = 0; L < nvox3; L += step) { const v = val(L); if (Number.isFinite(v)) sample.push(v); }
    sample.sort((a, b) => a - b);
    lo = sample[Math.floor(sample.length * 0.01)] ?? 0;
    hi = sample[Math.floor(sample.length * 0.995)] ?? 1;
    if (hi <= lo) hi = lo + 1;
  }
  const views = [];
  // axial: x (R->L on screen left->right is radiological: patient right on image left), y (A top)
  const defs = [
    { name: 'axial', u: [0, mn[0], mx[0], true], v: [1, mx[1], mn[1]], fixed: [2, c[2]] },
    { name: 'coronal', u: [0, mn[0], mx[0], true], v: [2, mx[2], mn[2]], fixed: [1, c[1]] },
    { name: 'sagittal', u: [1, mx[1], mn[1]], v: [2, mx[2], mn[2]], fixed: [0, c[0]] },
  ];
  for (const df of defs) {
    const [ua, u0, u1, flip] = df.u;
    const [va, v0, v1] = df.v;
    const ulen = Math.abs(u1 - u0), vlen = Math.abs(v1 - v0);
    const W = ulen >= vlen ? size : Math.max(8, Math.round(size * ulen / vlen));
    const H = vlen >= ulen ? size : Math.max(8, Math.round(size * vlen / ulen));
    const px = new Uint8ClampedArray(W * H);
    const w = [0, 0, 0];
    w[df.fixed[0]] = df.fixed[1];
    for (let y = 0; y < H; y++) {
      w[va] = v0 + (v1 - v0) * (y + 0.5) / H;
      for (let x = 0; x < W; x++) {
        // radiological convention: patient right on image left => u from R (mx x? ) handled by flip
        const t = (x + 0.5) / W;
        w[ua] = flip ? u1 - (u1 - u0) * t : u0 + (u1 - u0) * t;
        const idx = applyAffine(Ai, w).map(Math.round);
        let g = 0;
        if (idx[0] >= 0 && idx[0] < nx && idx[1] >= 0 && idx[1] < ny && idx[2] >= 0 && idx[2] < nz) {
          const v = val(idx[0] + nx * (idx[1] + ny * idx[2]));
          g = Number.isFinite(v) ? Math.round(255 * Math.max(0, Math.min(1, (v - lo) / (hi - lo)))) : 0;
        }
        px[y * W + x] = g;
      }
    }
    views.push({ name: df.name, w: W, h: H, pixels: px });
  }
  return views;
}
