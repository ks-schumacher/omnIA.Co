// Pixel value encoding: map NIfTI physical values onto 16-bit DICOM stored values with
// Rescale Slope/Intercept, exactly whenever possible. Lossy quantisation only on explicit request.
import { effectiveScaling } from './nifti.js';
import { formatDS } from './dicom/values.js';

// Slope/intercept are written as Decimal Strings (16 chars): compute with the exact values a reader will see.
const dsRound = (x) => Number(formatDS(x));

export class NotExactError extends Error {
  constructor(message, stats) { super(message); this.stats = stats; }
}

const INT_TYPES = new Set(['uint8', 'int8', 'int16', 'uint16', 'int32', 'uint32', 'int64', 'uint64']);

function gcd(a, b) { while (b) { const t = a % b; a = b; b = t; } return a; }

/** Size of one unit in the last place of a float32 value. */
export function ulp32(x) {
  const a = Math.abs(Math.fround(x));
  if (a === 0) return 2 ** -149;
  const e = Math.floor(Math.log2(a));
  return 2 ** (Math.max(e, -126) - 23);
}

/**
 * Plan the encoding of one volume (all 3D/4D voxels).
 * @returns {{mode:'direct'|'lattice'|'quantized', signed:boolean, slope:number, inter:number,
 *   store:(i:number)=>number, maxAbsError:number, rmsError:number, nonFinite:number,
 *   physMin:number, physMax:number, description:string}}
 */
export function planEncoding(vol, { allowQuantize = false } = {}) {
  if (!INT_TYPES.has(vol.dtype) && vol.dtype !== 'float32' && vol.dtype !== 'float64') {
    throw new NotExactError(`NIfTI datatype ${vol.dtype} is not supported for DICOM conversion`, {});
  }
  const d = vol.data, n = d.length;
  const { slope: s, inter: b } = effectiveScaling(vol.header);
  const big = d instanceof BigInt64Array || d instanceof BigUint64Array;

  if (INT_TYPES.has(vol.dtype)) {
    let rmin = Infinity, rmax = -Infinity;
    for (let i = 0; i < n; i++) {
      const v = big ? Number(d[i]) : d[i];
      if (v < rmin) rmin = v;
      if (v > rmax) rmax = v;
    }
    if (big && (rmin < Number.MIN_SAFE_INTEGER || rmax > Number.MAX_SAFE_INTEGER)) {
      throw new NotExactError('64-bit integers beyond 2^53 cannot be represented', { rmin, rmax });
    }
    return integerPlan(d, n, big, rmin, rmax, s, b, allowQuantize, vol.dtype);
  }

  // Floating point: physical value v = x*s + b (or x when unscaled)
  const scaled = !(s === 1 && b === 0);
  let vmin = Infinity, vmax = -Infinity, nonFinite = 0, allInt = true;
  for (let i = 0; i < n; i++) {
    const x = d[i];
    if (!Number.isFinite(x)) { nonFinite++; continue; }
    const v = scaled ? x * s + b : x;
    if (v < vmin) vmin = v;
    if (v > vmax) vmax = v;
    if (allInt && !Number.isInteger(v)) allInt = false;
  }
  if (nonFinite === n) throw new NotExactError('Volume contains no finite values', { nonFinite });
  if (nonFinite > 0 && !allowQuantize) {
    throw new NotExactError(`Volume contains ${nonFinite} NaN/Inf voxels, which DICOM integer pixels cannot represent`, { nonFinite });
  }
  if (allInt && nonFinite === 0) {
    // integer-valued floats: treat like integers (values are exact in float32/64)
    const view = { length: n };
    return integerPlan(scaled ? { get: (i) => d[i] * s + b } : d, n, false, vmin, vmax, 1, 0, allowQuantize, vol.dtype, scaled);
  }
  if (nonFinite === 0) {
    const lat = floatLattice(d, n, s, b, scaled, vmin, vmax, vol.dtype);
    if (lat) return lat;
  }
  if (!allowQuantize) {
    throw new NotExactError(
      `Floating-point values (range ${fmt(vmin)} .. ${fmt(vmax)}) cannot be stored losslessly as 16-bit integers`,
      { vmin, vmax, nonFinite });
  }
  return quantizePlan(d, n, s, b, scaled, vmin, vmax, nonFinite);
}

function fmt(x) { return Number.isFinite(x) ? Number(x.toPrecision(6)).toString() : String(x); }

function integerPlan(d, n, big, rmin, rmax, s, b, allowQuantize, dtype, viaGetter = false) {
  const get = viaGetter ? (i) => d.get(i) : big ? (i) => Number(d[i]) : (i) => d[i];
  if (rmin >= 0 && rmax <= 65535) {
    return { mode: 'direct', signed: false, slope: s, inter: b, store: get, maxAbsError: 0, rmsError: 0, nonFinite: 0,
      physMin: rmin * s + b, physMax: rmax * s + b, description: `lossless (${dtype} stored directly)` };
  }
  if (rmin >= -32768 && rmax <= 32767) {
    return { mode: 'direct', signed: true, slope: s, inter: b, store: get, maxAbsError: 0, rmsError: 0, nonFinite: 0,
      physMin: rmin * s + b, physMax: rmax * s + b, description: `lossless (${dtype} stored directly)` };
  }
  // integer lattice: values = rmin + g*k
  let g = 0;
  for (let i = 0; i < n && g !== 1; i++) g = gcd(g, Math.abs(get(i) - rmin));
  if (g === 0) g = 1;
  const steps = (rmax - rmin) / g;
  if (steps <= 65535) {
    return { mode: 'lattice', signed: false, slope: dsRound(s * g), inter: dsRound(b + s * rmin), store: (i) => (get(i) - rmin) / g,
      maxAbsError: 0, rmsError: 0, nonFinite: 0, physMin: rmin * s + b, physMax: rmax * s + b,
      description: `lossless (integer lattice, step ${g}, offset ${rmin})` };
  }
  if (!allowQuantize) {
    throw new NotExactError(`Integer values span ${rmax - rmin + 1} levels (> 65536) and cannot be stored losslessly in 16 bits`, { rmin, rmax });
  }
  const T = Float64Array.from({ length: n }, (_, i) => get(i) * s + b);
  return quantizePlan(T, n, 1, 0, false, rmin * s + b, rmax * s + b, 0);
}

/** Detect whether float values lie exactly (to source precision) on a 16-bit lattice. */
function floatLattice(d, n, s, b, scaled, vmin, vmax, dtype) {
  const f32 = dtype === 'float32';
  const phys = scaled ? (i) => d[i] * s + b : (i) => d[i];
  // candidate step from a strided sample
  const stride = Math.max(1, Math.floor(n / 1_000_000));
  const sample = [];
  for (let i = 0; i < n; i += stride) sample.push(phys(i));
  sample.sort((x, y) => x - y);
  let minDiff = Infinity;
  for (let i = 1; i < sample.length; i++) {
    const df = sample[i] - sample[i - 1];
    if (df > 0 && df < minDiff) minDiff = df;
  }
  if (!Number.isFinite(minDiff)) return null;
  const range = vmax - vmin;
  // candidate steps: the smallest observed difference (and integer fractions of it), plus the
  // range-refined estimate; each candidate is verified exactly on every voxel
  const cands = [];
  // robust estimate (median of consecutive unique differences) refined by least squares on the sample
  const diffs = [];
  for (let i = 1; i < sample.length; i++) { const df = sample[i] - sample[i - 1]; if (df > 0) diffs.push(df); }
  diffs.sort((x, y) => x - y);
  if (diffs.length) {
    const med = diffs[Math.floor(diffs.length / 2)];
    const kmaxM = Math.round(range / med);
    if (kmaxM > 0 && kmaxM <= 65535) {
      let num = 0, den = 0;
      for (const v of sample) { const k = Math.round((v - vmin) / med); num += k * (v - vmin); den += k * k; }
      if (den > 0) cands.push(num / den);
      cands.push(range / kmaxM, med);
    }
  }
  for (let sub = 1; sub <= 16; sub++) {
    const s0 = minDiff / sub;
    const kmax = Math.round(range / s0);
    if (kmax > 65535 || kmax === 0) continue;
    cands.push(s0, range / kmax);
  }
  for (const S0 of cands) {
    const S = dsRound(S0);
    const I = dsRound(vmin);
    let ok = true, needUlp = false;
    for (let i = 0; i < n && ok; i++) {
      const v = phys(i);
      const k = Math.round((v - I) / S);
      if (k < 0 || k > 65535) { ok = false; break; }
      const rec = k * S + I;
      if (f32) {
        // recover the stored float32 sample exactly; a 1-ulp difference is tolerated only because the
        // 16-character Decimal String cannot carry every binary digit of the step (reported explicitly)
        const xr = scaled ? (rec - b) / s : rec;
        if (Math.fround(xr) !== d[i]) {
          if (Math.abs(xr - d[i]) <= ulp32(d[i])) needUlp = true; else ok = false;
        }
      } else {
        const x = scaled ? (rec - b) / s : rec;
        if (Math.abs(x - d[i]) > 4 * Number.EPSILON * Math.max(1, Math.abs(d[i]))) ok = false;
      }
    }
    if (ok) {
      return { mode: 'lattice', signed: false, slope: S, inter: I, store: (i) => Math.round((phys(i) - I) / S),
        maxAbsError: 0, rmsError: 0, nonFinite: 0, physMin: vmin, physMax: vmax, ulpTolerance: needUlp,
        description: needUlp
          ? `lossless to float32 precision (≤ 1 ulp; ${dtype} values on a regular lattice, step ${fmt(S)})`
          : `lossless (${dtype} values on a regular lattice, step ${fmt(S)})` };
    }
  }
  return null;
}

function quantizePlan(d, n, s, b, scaled, vmin, vmax, nonFinite) {
  const range = vmax - vmin;
  // slightly widened step so that DS rounding can never push the maximum beyond 65535
  const S = dsRound(range > 0 ? (range / 65535) * (1 + 1e-12) : 1);
  const I = dsRound(vmin);
  const phys = scaled ? (i) => d[i] * s + b : (i) => d[i];
  let maxErr = 0, sq = 0, cnt = 0;
  for (let i = 0; i < n; i++) {
    const v = phys(i);
    if (!Number.isFinite(v)) continue;
    const k = Math.min(65535, Math.max(0, Math.round((v - I) / S)));
    const e = Math.abs(k * S + I - v);
    if (e > maxErr) maxErr = e;
    sq += e * e; cnt++;
  }
  return {
    mode: 'quantized', signed: false, slope: S, inter: I,
    store: (i) => { const v = phys(i); return Number.isFinite(v) ? Math.min(65535, Math.max(0, Math.round((v - I) / S))) : 0; },
    maxAbsError: maxErr, rmsError: cnt ? Math.sqrt(sq / cnt) : 0, nonFinite, physMin: vmin, physMax: vmax,
    description: `QUANTIZED to 16 bits: max abs error ${fmt(maxErr)} (range ${fmt(vmin)}..${fmt(vmax)})` +
      (nonFinite ? `; ${nonFinite} NaN/Inf voxels stored as ${fmt(I)}` : ''),
  };
}
