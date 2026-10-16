// Independent verification: re-parse the DICOM bytes that were written (separate code path from the
// writer), reconstruct every voxel's world position from IPP/IOP/PixelSpacing and compare against the
// source NIfTI voxel located through the inverse affine. Any mismatch fails the exam.
import { parseDicom, nativePixelFrames } from './dicom/read.js';
import { lpsFromRas, inv4, applyAffine } from './geometry.js';
import { effectiveScaling } from './nifti.js';
import { ulp32 } from './pixels.js';

const INT_TOL = 1e-2; // voxel-index tolerance: positions must agree to within 1% of a voxel

function vecAt(ipp, row, col, ps, r, c) {
  return [0, 1, 2].map((a) => ipp[a] + c * ps[1] * row[a] + r * ps[0] * col[a]);
}

function asIndexMapping(Minv, ipp, iop, ps) {
  const row = iop.slice(0, 3), col = iop.slice(3, 6);
  const v00 = applyAffine(Minv, vecAt(ipp, row, col, ps, 0, 0));
  const v01 = applyAffine(Minv, vecAt(ipp, row, col, ps, 0, 1)).map((x, i) => x - v00[i]);
  const v10 = applyAffine(Minv, vecAt(ipp, row, col, ps, 1, 0)).map((x, i) => x - v00[i]);
  const errs = [];
  const roundv = (v) => v.map((x) => { const rx = Math.round(x); errs.push(Math.abs(x - rx)); return rx; });
  const o = roundv(v00), dc = roundv(v01), dr = roundv(v10);
  const maxErr = Math.max(...errs);
  const isAxisStep = (d) => d.filter((x) => x !== 0).length === 1 && d.every((x) => Math.abs(x) <= 1);
  const steps = maxErr <= INT_TOL && isAxisStep(dc) && isAxisStep(dr);
  const axC = steps ? dc.findIndex((x) => x !== 0) : -1, axR = steps ? dr.findIndex((x) => x !== 0) : -1;
  // axis of the NIfTI grid that is constant over the DICOM plane (the slice axis), or -1
  const axis = steps && axC !== axR ? 3 - axC - axR : -1;
  return { o, dc, dr, maxErr, axis, okAny: axis >= 0, ok: axis === 2 };
}

/**
 * Verify a classic image series against its source volume.
 * @param {{bytes:Uint8Array}[]} files
 * @param {object} vol NIfTI volume ({dims, data, header, dtype})
 * @param {number[][]} rasAffine the affine used for conversion
 * @param {{mode:string, maxAbsError:number}} enc encoding plan (for tolerance only)
 */
export function verifyImageSeries(files, vol, rasAffine, enc) {
  const issues = [];
  const [nx, ny, nz] = vol.dims;
  const nt = vol.dims.length > 3 ? vol.dims.slice(3).reduce((a, b) => a * b, 1) : 1;
  const Minv = inv4(lpsFromRas(rasAffine));
  const { slope: s, inter: b } = effectiveScaling(vol.header);
  const d = vol.data;
  const big = d instanceof BigInt64Array || d instanceof BigUint64Array;
  const srcPhys = (L) => (big ? Number(d[L]) : d[L]) * s + b;
  const f32 = vol.dtype === 'float32';
  const visited = new Uint8Array(nx * ny * nz * nt);
  let maxAbsDiff = 0, maxIndexErr = 0, checked = 0;
  const seriesUIDs = new Set(), forUIDs = new Set(), studyUIDs = new Set();
  for (const f of files) {
    const p = parseDicom(f.bytes);
    const ds = p.dataset;
    seriesUIDs.add(ds.string('SeriesInstanceUID'));
    forUIDs.add(ds.string('FrameOfReferenceUID'));
    studyUIDs.add(ds.string('StudyInstanceUID'));
    const ipp = ds.numbers('ImagePositionPatient'), iop = ds.numbers('ImageOrientationPatient'), ps = ds.numbers('PixelSpacing');
    const rows = ds.number('Rows'), cols = ds.number('Columns');
    const S = ds.has('RescaleSlope') ? ds.number('RescaleSlope') : 1;
    const I = ds.has('RescaleIntercept') ? ds.number('RescaleIntercept') : 0;
    const t = ds.has('TemporalPositionIdentifier') ? ds.number('TemporalPositionIdentifier') - 1
      : ds.has('AcquisitionNumber') && nt > 1 ? ds.number('AcquisitionNumber') - 1 : 0;
    const map = asIndexMapping(Minv, ipp, iop, ps);
    maxIndexErr = Math.max(maxIndexErr, map.maxErr);
    if (!map.ok) { issues.push(`instance ${ds.number('InstanceNumber')}: geometry does not map onto the voxel grid (max index error ${map.maxErr.toExponential(2)})`); continue; }
    const k = map.o[2];
    if (k < 0 || k >= nz || t < 0 || t >= nt) { issues.push(`instance ${ds.number('InstanceNumber')}: slice ${k}/volume ${t} out of range`); continue; }
    const { frames } = nativePixelFrames(p);
    const px = frames[0];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = map.o[0] + r * map.dr[0] + c * map.dc[0];
        const j = map.o[1] + r * map.dr[1] + c * map.dc[1];
        if (i < 0 || i >= nx || j < 0 || j >= ny) { issues.push('pixel maps outside the volume'); r = rows; break; }
        const L = i + nx * (j + ny * (k + nz * t));
        if (visited[L]) { issues.push('voxel written twice'); r = rows; break; }
        visited[L] = 1;
        const v = px[r * cols + c] * S + I;
        const ref = srcPhys(L);
        let diff;
        if (!Number.isFinite(ref)) diff = enc.mode === 'quantized' ? 0 : Infinity;
        else diff = Math.abs(v - ref);
        if (enc.mode !== 'quantized') {
          let ok = diff <= 1e-9 * Math.max(1, Math.abs(ref));
          if (!ok && f32) {
            // float32 source: lossless means the original float32 sample is recovered exactly
            // (or within 1 ulp when the encoding plan declared it)
            const xr = s === 1 && b === 0 ? v : (v - b) / s;
            ok = Math.fround(xr) === d[L] || (enc.ulpTolerance && Math.abs(xr - d[L]) <= ulp32(d[L]));
            if (ok) diff = Math.abs(xr - d[L]) * Math.abs(s);
          }
          if (!ok) { issues.push(`value mismatch at voxel ${L}: dicom ${v} vs nifti ${ref}`); r = rows; break; }
        } else if (diff > enc.maxAbsError * (1 + 1e-9) + 1e-12) {
          issues.push(`quantisation error above bound at voxel ${L}`); r = rows; break;
        }
        if (diff > maxAbsDiff) maxAbsDiff = diff;
        checked++;
      }
      if (issues.length > 20) break;
    }
    if (issues.length > 20) break;
  }
  const expected = nx * ny * nz * nt;
  if (checked !== expected && issues.length === 0) issues.push(`only ${checked} of ${expected} voxels were covered`);
  if (seriesUIDs.size !== 1) issues.push('instances do not share one SeriesInstanceUID');
  if (forUIDs.size !== 1) issues.push('instances do not share one FrameOfReferenceUID');
  if (studyUIDs.size !== 1) issues.push('instances do not share one StudyInstanceUID');
  return { ok: issues.length === 0, checkedVoxels: checked, expectedVoxels: expected, maxAbsDiff, maxIndexErr, issues };
}

/** Verify a binary SEG instance against the label volume it was built from. */
export function verifySegmentation(segBytes, labelVol, rasAffine, segments) {
  const issues = [];
  const p = parseDicom(segBytes);
  const ds = p.dataset;
  const [nx, ny, nz] = labelVol.dims;
  const Minv = inv4(lpsFromRas(rasAffine));
  const rows = ds.number('Rows'), cols = ds.number('Columns');
  const shared = ds.seq('SharedFunctionalGroupsSequence')[0];
  const iop = shared.seq('PlaneOrientationSequence')[0].numbers('ImageOrientationPatient');
  const ps = shared.seq('PixelMeasuresSequence')[0].numbers('PixelSpacing');
  const perFrame = ds.seq('PerFrameFunctionalGroupsSequence');
  const { frames } = nativePixelFrames(p);
  if (frames.length !== perFrame.length) issues.push('frame count mismatch');
  const segNums = ds.seq('SegmentSequence').map((it) => it.number('SegmentNumber'));
  // reconstructed membership per segment
  const recon = segments.map(() => new Uint8Array(nx * ny * nz));
  perFrame.forEach((fg, fi) => {
    const ipp = fg.seq('PlanePositionSequence')[0].numbers('ImagePositionPatient');
    const segNo = fg.seq('SegmentIdentificationSequence')[0].number('ReferencedSegmentNumber');
    const si = segNums.indexOf(segNo);
    const map = asIndexMapping(Minv, ipp, iop, ps);
    if (!map.ok || si < 0) { issues.push(`frame ${fi + 1}: invalid geometry or segment`); return; }
    const k = map.o[2];
    const fr = frames[fi];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      if (!fr[r * cols + c]) continue;
      const i = map.o[0] + r * map.dr[0] + c * map.dc[0];
      const j = map.o[1] + r * map.dr[1] + c * map.dc[1];
      recon[si][i + nx * (j + ny * k)] = 1;
    }
  });
  const { slope, inter } = effectiveScaling(labelVol.header);
  const d = labelVol.data;
  let mismatches = 0, labelled = 0;
  for (let L = 0; L < nx * ny * nz; L++) {
    const lab = Math.round(Number(d[L]) * slope + inter);
    segments.forEach((seg, si) => {
      const want = lab === seg.value ? 1 : 0;
      if (want) labelled++;
      if (recon[si][L] !== want) mismatches++;
    });
  }
  if (mismatches) issues.push(`${mismatches} voxel/segment mismatches`);
  return { ok: issues.length === 0, labelledVoxels: labelled, mismatches, issues };
}

/**
 * Independent check of the NIfTI volumes produced by one dcm2niix run against the DICOM instances
 * given to it.
 *  - 'voxel' level (uncompressed classic DICOM): each DICOM image is located through IPP/IOP/PixelSpacing
 *    and the inverse affine of a candidate volume and its stored values must be identical to the NIfTI
 *    slice; every NIfTI slice of every volume must be matched by exactly one DICOM image.
 *  - 'geometry' level (compressed pixels or enhanced multi-frame): every DICOM plane must fall exactly
 *    on a NIfTI slice and every NIfTI slice must be hit by at least one plane.
 * DICOM images that match no output are reported (dcm2niix may exclude e.g. derived isotropic images).
 * @param {{vol:object, affine:number[][], name:string}[]} outs
 * @param {{bytes:Uint8Array, inst:object}[]} items
 */
export function verifyRunAgainstDicom(outs, items) {
  const issues = [];
  if (items.some((it) => it.inst.mosaic)) {
    return { ok: true, level: 'dcm2niix only (mosaic: no independent check)', perOutput: outs.map(() => 'dcm2niix only'), unmatched: 0, issues };
  }
  const compressed = items.some((it) => !['1.2.840.10008.1.2', '1.2.840.10008.1.2.1'].includes(it.inst.ts));
  const enhanced = items.some((it) => it.inst.enhanced);
  const ctx = outs.map((o) => {
    const [nx, ny, nz] = o.vol.dims;
    const nt = o.vol.dims.length > 3 ? o.vol.dims.slice(3).reduce((a, b) => a * b, 1) : 1;
    // c.axis: NIfTI axis along which the DICOM planes are stacked (2 normally; dcm2niix may reorient some data)
    return { ...o, nx, ny, nz, nt, dims3: [nx, ny, nz], Minv: inv4(lpsFromRas(o.affine)), axis: undefined, hitK: new Uint8Array(nz), slotUsed: null, sums: null, matched: 0 };
  });
  let maxIndexErr = 0, unmatched = 0;
  const planesOf = (inst) => (inst.enhanced ? inst.frameGeom || [] : [{ ipp: inst.ipp, iop: inst.iop, ps: inst.ps }]);
  if (compressed || enhanced) {
    for (const it of items) {
      for (const g of planesOf(it.inst)) {
        if (!g.ipp || g.ipp.length !== 3 || !g.iop || g.iop.length !== 6 || !g.ps || g.ps.length !== 2) { unmatched++; continue; }
        let hit = false;
        for (const c of ctx) {
          const map = asIndexMapping(c.Minv, g.ipp, g.iop, g.ps);
          if (!map.okAny) continue;
          if (c.axis === undefined) { c.axis = map.axis; c.hitK = new Uint8Array(c.dims3[map.axis]); }
          if (map.axis !== c.axis) continue;
          const k = map.o[c.axis];
          if (k >= 0 && k < c.hitK.length) { c.hitK[k] = 1; maxIndexErr = Math.max(maxIndexErr, map.maxErr); hit = true; }
        }
        if (!hit) unmatched++;
      }
    }
    const perOutput = ctx.map((c) => {
      const missing = c.hitK.length - c.hitK.reduce((a, b) => a + b, 0);
      if (missing) issues.push(`${c.name}: ${missing} NIfTI slice(s) correspond to no DICOM plane`);
      return missing ? 'FAILED' : `geometry-exact (${enhanced ? 'enhanced multi-frame' : 'compressed pixels'})`;
    });
    return { ok: issues.length === 0, level: perOutput[0] || 'geometry', perOutput, unmatched, maxIndexErr, issues };
  }
  // voxel level
  for (const c of ctx) {
    const d = c.vol.data;
    const big = d instanceof BigInt64Array || d instanceof BigUint64Array;
    c.rawAt = big ? (L) => Number(d[L]) : (L) => d[L];
    const sc = effectiveScaling(c.vol.header);
    c.ns = sc.slope; c.ni = sc.inter;
  }
  // plane sums along the slice axis, used to pick the candidate volume (t) of a 4D output quickly
  const planeSums = (c) => {
    const n = c.dims3[c.axis], m = new Map();
    const acc = new Float64Array(n * c.nt);
    let L = 0;
    for (let t = 0; t < c.nt; t++) for (let k = 0; k < c.nz; k++) for (let j = 0; j < c.ny; j++) for (let i = 0; i < c.nx; i++, L++) {
      acc[t * n + (c.axis === 0 ? i : c.axis === 1 ? j : k)] += c.rawAt(L);
    }
    for (let t = 0; t < c.nt; t++) for (let p = 0; p < n; p++) {
      const key = `${p}:${acc[t * n + p]}`;
      if (!m.has(key)) m.set(key, []);
      m.get(key).push(t);
    }
    return m;
  };
  for (const it of items) {
    const g = { ipp: it.inst.ipp, iop: it.inst.iop, ps: it.inst.ps };
    if (g.ipp.length !== 3 || g.iop.length !== 6 || g.ps.length !== 2) { unmatched++; continue; }
    const f = parseDicom(it.bytes);
    const ds = f.dataset;
    let px;
    try { px = nativePixelFrames(f).frames[0]; } catch { unmatched++; continue; }
    const S = ds.has('RescaleSlope') ? ds.number('RescaleSlope') : 1;
    const I = ds.has('RescaleIntercept') ? ds.number('RescaleIntercept') : 0;
    const rows = ds.number('Rows'), cols = ds.number('Columns');
    let s = 0;
    for (let q = 0; q < rows * cols; q++) s += px[q];
    let found = false;
    // an image may legitimately appear in several outputs (e.g. dcm2niix writes a full series and a
    // subset without derived volumes): mark one free matching slot in every output
    for (const c of ctx) {
      const map = asIndexMapping(c.Minv, g.ipp, g.iop, g.ps);
      if (!map.okAny) continue;
      if (c.axis === undefined) { c.axis = map.axis; c.slotUsed = new Uint8Array(c.dims3[c.axis] * c.nt); c.sums = planeSums(c); }
      if (map.axis !== c.axis) continue;
      const nPlanes = c.dims3[c.axis];
      const k = map.o[c.axis];
      if (k < 0 || k >= nPlanes) continue;
      let cands = c.sums.get(`${k}:${s}`) || [];
      let mode = 'raw';
      if (!cands.length) { cands = [...Array(c.nt).keys()]; mode = 'physical'; }
      for (const t of cands) {
        if (c.slotUsed[t * nPlanes + k]) continue;
        let ok = true;
        const vbase = t * c.nz * c.nx * c.ny;
        for (let r = 0; r < rows && ok; r++) for (let cc = 0; cc < cols; cc++) {
          const i = map.o[0] + r * map.dr[0] + cc * map.dc[0];
          const j = map.o[1] + r * map.dr[1] + cc * map.dc[1];
          const kk = map.o[2] + r * map.dr[2] + cc * map.dc[2];
          if (i < 0 || j < 0 || kk < 0 || i >= c.nx || j >= c.ny || kk >= c.nz) { ok = false; break; }
          const nv = c.rawAt(vbase + i + c.nx * (j + c.ny * kk));
          const dv = px[r * cols + cc];
          if (mode === 'raw' ? nv !== dv : Math.abs(nv * c.ns + c.ni - (dv * S + I)) > 1e-6 * Math.max(1, Math.abs(dv * S + I))) { ok = false; break; }
        }
        if (ok) { c.slotUsed[t * nPlanes + k] = 1; c.matched++; found = true; maxIndexErr = Math.max(maxIndexErr, map.maxErr); break; }
      }
    }
    if (!found) unmatched++;
  }
  const perOutput = ctx.map((c) => {
    const slots = c.dims3[c.axis === undefined ? 2 : c.axis] * c.nt;
    if (c.matched !== slots) { issues.push(`${c.name}: ${slots - c.matched} of ${slots} NIfTI slices not matched by a DICOM image`); return 'FAILED'; }
    return `voxel-exact (${c.matched} images)`;
  });
  return { ok: issues.length === 0, level: 'voxel', perOutput, unmatched, maxIndexErr, issues };
}
