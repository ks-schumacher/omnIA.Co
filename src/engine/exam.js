// One exam (one archive) end to end, in either direction, with per-series verification and reporting.
import { expandArchive, classifyEntry } from './archive.js';
import { looksLikeDicom } from './dicom/read.js';
import { summarizeInstance, groupSeries, filterSeries, analyzeStack, SOP_NAMES } from './dicomscan.js';
import { readNifti, chooseAffine, rewriteNifti, sformAffine, XFORM, gunzipAll } from './nifti.js';
import { assembleMeta } from './meta.js';
import { cleanSidecar, cleanNiftiDescrip } from './anon.js';
import { buildImageSeries, buildSegmentation, resolveIdentity, bvecToPatient, SOP } from './nii2dcm.js';
import { verifyImageSeries, verifySegmentation, verifyRunAgainstDicom } from './verify.js';
import { planSlices, seriesGeometry, dot, sub, lpsFromRas } from './geometry.js';
import { defaceCT, anteriorRender } from './deface.js';
import { isLabelMap, parseLabelTable, buildSegments } from './labels.js';
import { renderOrtho } from './qc.js';
import { gzipAsync, safeName, bidsLabel, stemOf, baseName, textDecoder, fmtNum } from './util.js';
import { newUID, OMNIA_VERSION } from './uid.js';
import { DEFAULT_SETTINGS } from './settings.js';

export { DEFAULT_SETTINGS };

const TILT_MIN_DEG = 0.05;
// dcm2niix messages that describe the input but do not change the converted voxels or geometry
const DCM2NIIX_BENIGN = [
  /Instance Number \(0020,0013\) order is not spatial/i,
  /Philips enhanced DICOMs \(hint: export as classic DICOM\)/i,
  /Note these images have gantry tilt/i, // OMNIA handles tilt explicitly (see the gantry tilt note)
  /Empty protocol name/i,
];

function newResult(exam, settings) {
  return {
    name: exam.name, direction: settings.direction, status: 'ok', outputs: [], series: [], warnings: [], errors: [],
    ignored: [], containers: [], qc: [], patient: null, outRoot: '', startedAt: new Date().toISOString(), ms: 0,
  };
}

function finalizeStatus(R) {
  const conv = R.series.filter((s) => s.status === 'ok' || s.status === 'warning');
  if (R.errors.length && !conv.length) R.status = 'error';
  else if (!conv.length) R.status = R.series.length ? 'skipped' : 'error';
  // series skipped by an explicit filter chosen in the settings do not turn the exam into a warning
  else if (R.errors.length || R.series.some((s) => s.status !== 'ok' && !(s.status === 'skipped' && s.policySkip)) || R.warnings.length) R.status = 'warning';
  else R.status = 'ok';
  if (!conv.length && !R.errors.length && !R.series.length) R.errors.push('No convertible content found in this archive');
}

/** Expand and classify all entries of an exam archive. */
async function inventory(exam, settings, progress, R, wantDicomHeaders) {
  let entries = [], warnings = [], containers = [];
  if (exam.files) {
    // a dropped folder: every file (or nested archive) belongs to this exam
    for (const f of exam.files) {
      const r = await expandArchive(f.blob, f.path, { password: settings.password });
      entries.push(...r.entries.map((e) => ({ ...e, path: `${exam.name}/${e.path}` })));
      warnings.push(...r.warnings); containers.push(...r.containers);
    }
  } else {
    ({ entries, warnings, containers } = await expandArchive(exam.input, exam.name, { password: settings.password }));
  }
  R.warnings.push(...warnings);
  R.containers = containers;
  const inv = { dicom: [], nifti: [], hdr: [], img: [], json: new Map(), bval: new Map(), bvec: new Map(), text: new Map(), dicomdir: 0 };
  let n = 0;
  for (const e of entries) {
    n++;
    if (n % 25 === 0) progress({ stage: 'scanning', pct: 3 + 22 * (n / entries.length), message: `${n}/${entries.length}` });
    let kind = classifyEntry(e.path, null);
    if (kind === 'other' || kind === 'dicom?') {
      let bytes = await e.getBytes();
      if (bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
        // individually gzip-compressed file (e.g. *.dcm.gz)
        try {
          const inner = gunzipAll(bytes);
          if (looksLikeDicom(inner)) { const get = e.getBytes; e.getBytes = async () => gunzipAll(await get()); bytes = inner; }
        } catch { /* not gzip after all */ }
      }
      if (looksLikeDicom(bytes)) {
        kind = 'dicom';
        if (wantDicomHeaders) {
          try {
            const inst = summarizeInstance(bytes, e.path);
            if (inst.sopClass === '1.2.840.10008.1.3.10') inv.dicomdir++; else inv.dicom.push({ entry: e, inst });
          } catch (err) { R.ignored.push(`${e.path}: unreadable DICOM (${err.message})`); }
        }
        continue;
      }
      R.ignored.push(`${e.path}: not recognised`);
      continue;
    }
    const st = stemOf(e.path);
    switch (kind) {
      case 'dicomdir': inv.dicomdir++; break;
      case 'nifti': inv.nifti.push(e); break;
      case 'nifti-hdr': inv.hdr.push(e); break;
      case 'nifti-img': inv.img.push(e); break;
      case 'json': inv.json.set(st, e); break;
      case 'bval': inv.bval.set(st, e); break;
      case 'bvec': inv.bvec.set(st, e); break;
      case 'text': inv.text.set(st, e); break;
      case 'dicom': {
        if (!wantDicomHeaders) break;
        try {
          const bytes = await e.getBytes();
          const inst = summarizeInstance(bytes, e.path);
          if (inst.sopClass === '1.2.840.10008.1.3.10') inv.dicomdir++; else inv.dicom.push({ entry: e, inst });
        } catch (err) { R.ignored.push(`${e.path}: unreadable DICOM (${err.message})`); }
        break;
      }
      default: R.ignored.push(`${e.path}`);
    }
  }
  if (inv.dicomdir) R.ignored.push(`${inv.dicomdir} DICOMDIR index file(s) (not needed: every file is read directly)`);
  return inv;
}

function examOutName(exam, idctx, patient) {
  if (idctx.anonymize) {
    const idx = patient.exams.indexOf(exam.name) + 1;
    return `${patient.pseudo}_E${String(idx).padStart(2, '0')}`;
  }
  return safeName(exam.name.replace(/\.(zip|rar|7z|tar|tgz|tar\.gz|tar\.bz2|tar\.xz)$/i, ''), 80);
}

// =============================================================================================
// DICOM -> NIfTI
// =============================================================================================

function dcm2niixArgs(settings, idctx) {
  const ba = !idctx.anonymize ? 'n' : settings.dates === 'remove' ? 'y' : 'o';
  const a = ['-b', 'y', '-ba', ba, '-z', 'n', '-f', 'omnia', '-i', 'n', '-w', '2', '-m', '2'];
  if (idctx.anonymize) a.push('-c', '');
  return a;
}

const BIDS_ORDER = ['task', 'acq', 'ce', 'rec', 'dir', 'run', 'mod', 'echo', 'flip', 'inv', 'mt', 'part', 'chunk'];

/** Build a BIDS-like file stem from dcm2niix's BidsGuess plus OMNIA/dcm2niix post-fixes. */
export function bidsStem(subLabel, sesLabel, guess, modality, seriesNumber, suffix) {
  const dtype = guess ? (String(guess[0]).replace(/[^A-Za-z0-9]/g, '') || 'other') : modality === 'CT' ? 'ct' : 'other';
  const tokens = guess ? String(guess[1]).split('_').filter(Boolean) : [];
  let suffixTok = tokens.length && !tokens[tokens.length - 1].includes('-') ? tokens.pop() : (modality === 'CT' ? 'ct' : 'unknown');
  suffixTok = suffixTok.replace(/[^A-Za-z0-9]/g, '') || 'unknown';
  const ent = new Map();
  for (const t of tokens) {
    const m = /^([A-Za-z0-9]+)-(.+)$/.exec(t);
    if (m && m[1] !== 'sub' && m[1] !== 'ses') ent.set(m[1], m[2].replace(/[^A-Za-z0-9]/g, '') || 'x');
  }
  let s = suffix;
  const e = /_e(\d+)/.exec(s); if (e) { if (!ent.has('echo')) ent.set('echo', e[1]); s = s.replace(e[0], ''); }
  if (/_ph(?![a-z])/i.test(s)) { ent.set('part', 'phase'); s = s.replace(/_ph(?![a-z])/i, ''); }
  if (/_real/i.test(s)) { ent.set('part', 'real'); s = s.replace(/_real/i, ''); }
  if (/_imaginary/i.test(s)) { ent.set('part', 'imag'); s = s.replace(/_imaginary/i, ''); }
  const pm = /_part(\d+)/.exec(s); if (pm) { ent.set('chunk', pm[1]); s = s.replace(pm[0], ''); }
  const rest = s.replace(/^_+/, '').replace(/[^A-Za-z0-9]+/g, '');
  if (rest) ent.set('rec', (ent.get('rec') || '') + rest);
  if (!ent.has('run')) ent.set('run', String(seriesNumber ?? 0));
  const keys = [...ent.keys()].sort((a, b) => (BIDS_ORDER.indexOf(a) + 100 * (BIDS_ORDER.indexOf(a) < 0)) - (BIDS_ORDER.indexOf(b) + 100 * (BIDS_ORDER.indexOf(b) < 0)));
  const parts = [`sub-${subLabel}`, `ses-${sesLabel}`, ...keys.map((k) => `${k}-${ent.get(k)}`), suffixTok];
  return `sub-${subLabel}/ses-${sesLabel}/${dtype}/${parts.join('_')}`;
}

async function dcm2niiExam(exam, settings, env, progress, R) {
  const { idctx, runner } = env;
  const inv = await inventory(exam, settings, progress, R, true);
  if (inv.nifti.length || inv.hdr.length) R.ignored.push(`${inv.nifti.length + inv.hdr.length} NIfTI file(s) ignored (direction DICOM → NIfTI)`);
  if (!inv.dicom.length) { R.errors.push('No DICOM files found'); return; }
  const all = groupSeries(inv.dicom.map((d) => d.inst));
  const entryOf = new Map(inv.dicom.map((d) => [d.inst, d.entry]));
  const first = inv.dicom[0].inst;
  const original = { PatientName: first.patientName, PatientID: first.patientID, PatientBirthDate: first.birthDate, AccessionNumber: first.accession };
  {
    const seen = new Set(), others = [];
    for (const { inst } of inv.dicom) {
      const o = { PatientName: inst.patientName, PatientID: inst.patientID, PatientBirthDate: inst.birthDate, AccessionNumber: inst.accession };
      const key = JSON.stringify(o);
      if (!seen.has(key)) { seen.add(key); others.push(o); }
    }
    original.others = others;
  }
  const patKey = first.patientID ? `id:${first.patientID}` : first.patientName ? `name:${first.patientName}` : `exam:${exam.name}`;
  const patient = idctx.patient(patKey, original);
  if (!patient.exams.includes(exam.name)) patient.exams.push(exam.name);
  R.patient = idctx.anonymize ? patient.pseudo : (first.patientID || '');
  R.outRoot = examOutName(exam, idctx, patient);
  const subLabel = bidsLabel(idctx.anonymize ? patient.pseudo : (first.patientID || R.outRoot));
  const sesLabel = String(patient.exams.indexOf(exam.name) + 1).padStart(2, '0');
  if (new Set(inv.dicom.map((d) => d.inst.patientID)).size > 1) R.warnings.push('Archive contains more than one PatientID; the first one names the outputs');
  const ext = settings.outputFormat === 'nii' ? '.nii' : '.nii.gz';
  if (settings.bids) {
    R.outputs.push({ path: 'dataset_description.json', bytes: new TextEncoder().encode(JSON.stringify({ Name: 'OMNIA export', BIDSVersion: '1.10.0', DatasetType: 'raw', GeneratedBy: [{ Name: 'OMNIA', Version: OMNIA_VERSION }, { Name: 'dcm2niix' }] }, null, 2)), compress: true });
  }
  const args = dcm2niixArgs(settings, idctx);
  const usedNames = new Set();
  let si = 0;
  for (const s of all) {
    si++;
    const f = s.first;
    const label = `${f.seriesNumber ?? '?'} ${f.seriesDescription || ''}`.trim();
    const row = { exam: exam.name, direction: 'DICOM→NIfTI', input: label, modality: f.modality, sop: SOP_NAMES[f.sopClass] || f.sopClass, images: s.instances.length, outputs: [], status: 'ok', verification: '', notes: [], warnings: [] };
    const filt = filterSeries(s, settings.filters);
    if (!filt.keep) { row.status = 'skipped'; row.policySkip = true; row.notes.push(...filt.reasons); R.series.push(row); continue; }
    progress({ stage: 'converting', pct: 25 + 65 * ((si - 1) / all.length), message: label });
    try {
      const st = s.first.enhanced ? { ok: true, enhanced: true } : analyzeStack(s);
      if (!st.ok) { row.status = 'skipped'; row.notes.push(...st.issues); R.series.push(row); continue; }
      if (st.issues && st.issues.length) row.notes.push(...st.issues);
      let subsets = [{ insts: s.instances, tag: '', positions: st.positions }];
      let expectEq = false;
      const variable = st.uniquePositions && !st.mosaic && !st.mixedOrientation && st.consistentRepeats && !st.spacingUniform;
      if (variable) {
        const sp = st.spacings.map((x) => fmtNum(x, 3)).filter((v, i, a) => a.indexOf(v) === i).slice(0, 6).join(', ');
        if (settings.variableSpacing === 'skip') { row.status = 'skipped'; row.policySkip = true; row.notes.push(`variable slice spacing (${sp} mm): skipped by policy`); R.series.push(row); continue; }
        if (settings.variableSpacing === 'split') {
          subsets = st.runs.map(([a, b], idx) => ({ insts: st.uniquePositions.slice(a, b + 1).flatMap((u) => u.items), tag: `_part${idx + 1}`, positions: st.positions.slice(a, b + 1) }));
          row.notes.push(`variable slice spacing (${sp} mm): split losslessly into ${subsets.length} uniform block(s)`);
        } else { expectEq = true; row.notes.push(`variable slice spacing (${sp} mm): equidistant volume INTERPOLATED by dcm2niix`); }
      }
      const tilted = st.tiltDeg !== undefined && st.tiltDeg > TILT_MIN_DEG && !st.mosaic;
      if (tilted) row.notes.push(`gantry tilt ${fmtNum(st.tiltDeg, 3)}°: ` + (settings.gantryTilt === 'exact' ? 'exact sheared geometry (lossless, sform only)' : 'resampled to an orthogonal grid by dcm2niix (INTERPOLATED)'));
      for (const subset of subsets) {
        const items = [];
        for (const inst of subset.insts) items.push({ inst, bytes: await entryOf.get(inst).getBytes() });
        const res = await runner.run(items.map((it, i) => ({ name: `f${i}.dcm`, bytes: it.bytes })), args);
        const warn = [...new Set(res.log.filter((l) => /^Warning/i.test(l.trim())).map((l) => l.trim()))];
        // dcm2niix hints that do not affect the image (OMNIA verifies every voxel independently) are kept as notes
        const benign = (w) => DCM2NIIX_BENIGN.some((re) => re.test(w));
        row.notes.push(...warn.filter(benign).map((w) => `dcm2niix: ${w.replace(/^Warning:\s*/i, '')}`).filter((n) => !row.notes.includes(n)));
        row.warnings.push(...warn.filter((w) => !benign(w)).slice(0, 8));
        if (res.exitCode !== 0 && !res.outputs.length) throw new Error(`dcm2niix exit code ${res.exitCode}: ${res.log.filter((l) => /error/i.test(l)).slice(0, 2).join(' | ')}`);
        const byBase = new Map();
        for (const o of res.outputs) {
          const m = /^(.*?)\.(nii|json|bval|bvec)$/.exec(o.name);
          if (!m) continue;
          if (!byBase.has(m[1])) byBase.set(m[1], {});
          byBase.get(m[1])[m[2]] = o.bytes;
        }
        const bases = [...byBase.keys()].filter((b) => byBase.get(b).nii).sort();
        const kept = [];
        for (const base of bases) {
          const isTilt = /_Tilt_\d+/.test(base), isEq = /_Eq_\d+/.test(base);
          if (tilted) {
            if (settings.gantryTilt === 'exact' && isTilt) continue;
            if (settings.gantryTilt === 'resampled' && !isTilt) continue;
          }
          if (expectEq && !isEq) continue;
          if (!expectEq && isEq) { row.warnings.push(`dcm2niix produced an interpolated volume (${base}) that was discarded`); continue; }
          const mainBase = base.replace(/_Tilt_\d+|_Eq_\d+/g, '');
          const outSet = byBase.get(base);
          const prep = prepareNifti({ outSet, tilted, interpolated: isTilt || isEq, settings, positions: subset.positions });
          kept.push({ base, outSet, json: outSet.json || (byBase.get(mainBase) || {}).json, interpolated: isTilt || isEq,
            suffix: base.slice('omnia'.length).replace(/_Tilt_\d+|_Eq_\d+/g, '') + subset.tag, ...prep });
        }
        // independent verification of every non-interpolated output of this run against the DICOM images
        const exact = kept.filter((k) => !k.interpolated);
        let ver = { ok: true, perOutput: [], unmatched: 0, issues: [] };
        if (exact.length) ver = verifyRunAgainstDicom(exact.map((k) => ({ vol: k.vol, affine: k.affine, name: k.base })), items);
        if (ver.unmatched) row.warnings.push(`${ver.unmatched} DICOM image(s) were not found in any output (dcm2niix may exclude derived images or mis-assemble incomplete series)`);
        exact.forEach((k, i) => { k.verification = ver.perOutput[i]; });
        kept.filter((k) => k.interpolated).forEach((k) => { k.verification = 'not applicable (interpolated by dcm2niix)'; });
        for (const k of kept) {
          if (k.verification === 'FAILED') {
            row.status = 'error';
            row.notes.push(`verification failed (${k.base}): ${ver.issues.filter((x) => x.startsWith(k.base)).join('; ')}`);
            continue;
          }
          await emitNifti({ R, row, s, k, exam, settings, env, patient, original, subLabel, sesLabel, ext, usedNames });
        }
      }
      if (!row.outputs.length && row.status === 'ok') { row.status = 'error'; row.notes.push('dcm2niix produced no output'); }
    } catch (err) {
      row.status = 'error';
      row.notes.push(err.message);
    }
    if (row.status === 'error') R.errors.push(`${label}: ${row.notes[row.notes.length - 1]}`);
    R.series.push(row);
  }
}

function tiltFixedSrow(vol, pos) {
  // Replace dcm2niix's approximate slice vector by the true slice step (from ImagePositionPatient).
  const S = sformAffine(vol.header);
  const n = pos.length;
  if (n < 2) return null;
  const stepL = sub(pos[n - 1], pos[0]).map((x) => x / (n - 1));
  const stepR = [-stepL[0], -stepL[1], stepL[2]];
  const c2 = [S[0][2], S[1][2], S[2][2]];
  const sign = dot(stepR, c2) >= 0 ? 1 : -1;
  return [0, 1, 2].map((r) => [S[r][0], S[r][1], sign * stepR[r], S[r][3]]);
}

function prepareNifti({ outSet, tilted, interpolated, settings, positions }) {
  const vol = readNifti(outSet.nii);
  let affine = chooseAffine(vol.header, 'sform').affine;
  const patch = {};
  if (tilted && !interpolated && settings.gantryTilt === 'exact') {
    const srow = positions ? tiltFixedSrow(vol, positions) : null;
    if (!srow) throw new Error('cannot compute exact tilt geometry');
    patch.srow = srow; patch.sform_code = Math.max(1, vol.header.sform_code); patch.qform_code = 0;
    affine = [...srow.map((r) => r.slice()), [0, 0, 0, 1]];
  }
  return { vol, affine, patch };
}

async function emitNifti(o) {
  const { R, row, s, k, settings, env, patient, original, subLabel, sesLabel, ext, usedNames } = o;
  const { idctx } = env;
  const { vol, affine, patch, outSet, suffix, interpolated } = k;
  const tilted = !!patch.srow;
  row.verification = row.verification ? `${row.verification}; ${k.verification}` : k.verification;
  if (interpolated && row.status === 'ok') row.status = 'warning';
  // defacing (CT, 3D)
  let defaced = false;
  const f = s.first;
  if (settings.deface && f.modality === 'CT') {
    const before = R.qc.length < 12 ? anteriorRender(vol, affine) : null;
    const dres = defaceCT(vol, affine);
    if (dres.status === 'defaced') {
      defaced = true;
      row.notes.push(`face removed (intracranial ${fmtNum(dres.intracranialML, 4)} mL preserved, ${fmtNum(dres.removedTissueML, 3)} mL removed)`);
      if (before) R.qc.push({ kind: 'deface', label: `${row.input}${suffix}`, before, after: anteriorRender(vol, affine) });
    } else if (dres.status === 'no-face-in-fov') {
      row.notes.push('defacing: no facial tissue within the field of view');
    } else {
      const msg = `defacing not possible: ${dres.reason}`;
      if (settings.defaceFailure === 'exclude') { row.status = 'error'; row.notes.push(`${msg} — excluded by policy`); return; }
      row.status = 'warning'; row.notes.push(`${msg} — included WITHOUT defacing by policy`);
    }
  }
  // header anonymisation
  const descrip = cleanNiftiDescrip(vol.header.descrip, idctx);
  if (descrip !== vol.header.descrip) patch.descrip = descrip;
  if (idctx.anonymize && vol.header.aux_file) patch.aux_file = '';
  let niiBytes = (Object.keys(patch).length || defaced) ? rewriteNifti(vol.headerBytes, vol.data, patch) : outSet.nii;
  if (ext === '.nii.gz') niiBytes = await gzipAsync(niiBytes);
  // sidecar
  let sidecar = null;
  if (k.json) {
    try {
      const j = JSON.parse(textDecoder.decode(k.json));
      const c = cleanSidecar(j, idctx, patient, original);
      sidecar = c.json;
      sidecar.OMNIAVersion = OMNIA_VERSION;
      sidecar.OMNIAVerification = k.verification;
      if (idctx.anonymize) sidecar.OMNIADeidentification = 'DICOM PS3.15 Basic Profile' + (idctx.s.retainPatientCharacteristics ? ' + Retain Patient Characteristics' : '') + (idctx.s.dates === 'shift' ? ' + Modified Dates' : idctx.s.dates === 'keep' ? ' + Full Dates' : '') + (idctx.s.keepDescriptions ? ' + Clean Descriptors' : '');
      if (defaced) sidecar.OMNIADefaced = true;
      if (interpolated) sidecar.OMNIAInterpolated = true;
      if (tilted) sidecar.OMNIAGeometryNote = 'Gantry tilt: exact sheared sform built from ImagePositionPatient; qform disabled';
      row._bidsGuess = j.BidsGuess;
    } catch (err) { row.warnings.push(`sidecar JSON unreadable: ${err.message}`); }
  }
  // naming
  const sn = f.seriesNumber ?? 0;
  let stem;
  if (settings.bids) {
    let guess = Array.isArray(row._bidsGuess) && row._bidsGuess.length >= 2 ? row._bidsGuess : null;
    // dcm2niix gives no BIDS guess for some vendors: a volume written with gradient tables is diffusion data
    if (!guess && k.outSet.bval && k.outSet.bvec) guess = ['dwi', 'dwi'];
    stem = bidsStem(subLabel, sesLabel, guess, f.modality, sn, suffix);
  } else {
    const desc = idctx.descriptor(f.seriesDescription, original) || 'series';
    stem = `${R.outRoot}/${String(sn).padStart(3, '0')}_${safeName(desc, 40)}${safeName(suffix, 30) === 'x' ? '' : safeName(suffix, 30)}`;
  }
  let unique = stem, dupN = 2;
  while (usedNames.has(unique)) unique = `${stem}_dup${dupN++}`;
  usedNames.add(unique);
  R.outputs.push({ path: `${unique}${ext}`, bytes: niiBytes, compress: ext === '.nii' });
  row.outputs.push(`${unique}${ext}`);
  if (sidecar) R.outputs.push({ path: `${unique}.json`, bytes: new TextEncoder().encode(JSON.stringify(sidecar, null, 2)), compress: true });
  if (outSet.bval) R.outputs.push({ path: `${unique}.bval`, bytes: outSet.bval, compress: true });
  if (outSet.bvec) R.outputs.push({ path: `${unique}.bvec`, bytes: outSet.bvec, compress: true });
  if (R.qc.length < 12) {
    try { R.qc.push({ kind: 'ortho', label: `${row.input}${suffix}`, views: renderOrtho(vol, affine, f.modality) }); } catch { /* QC is best effort */ }
  }
}

// =============================================================================================
// NIfTI -> DICOM
// =============================================================================================

function sameGrid(a, b) {
  if (a.dims.slice(0, 3).join() !== b.dims.slice(0, 3).join()) return false;
  for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) if (Math.abs(a.affine[r][c] - b.affine[r][c]) > 1e-4) return false;
  return true;
}

async function nii2dcmExam(exam, settings, env, progress, R) {
  const { idctx } = env;
  const inv = await inventory(exam, settings, progress, R, true);
  // NIfTI items (single-file + hdr/img pairs)
  const niis = inv.nifti.map((e) => ({ path: e.path, get: async () => readNifti(await e.getBytes()) }));
  for (const h of inv.hdr) {
    const st = stemOf(h.path);
    const img = inv.img.find((e) => stemOf(e.path) === st);
    if (!img) { R.warnings.push(`${h.path}: .img companion missing`); continue; }
    niis.push({ path: h.path, get: async () => readNifti(await h.getBytes(), await img.getBytes()) });
  }
  if (!niis.length) { R.errors.push('No NIfTI files found'); return; }
  // reference DICOM (same exam)
  const refSeries = groupSeries(inv.dicom.map((d) => d.inst)).filter((s) => !s.first.enhanced && s.first.iop.length === 6);
  const refGeoms = refSeries.map((s) => ({ s, g: seriesGeometry(s.instances.filter((i) => i.ipp.length === 3)) })).filter((x) => x.g && x.g.consistent);
  const refDs = inv.dicom.length ? inv.dicom[0].inst.ds : null;
  const refFoRs = [...new Set(inv.dicom.map((d) => d.inst.forUID).filter(Boolean))];
  const csvRow = env.csvIndex ? env.csvIndex.get(exam.name.replace(/\.(zip|rar|7z|tar|tgz|tar\.gz)$/i, '').toLowerCase()) || env.csvIndex.get(exam.name.toLowerCase()) : null;
  const examState = { studyUID: null, forByCode: {}, fallbackPatientID: safeName(exam.name, 60) };
  // read all volumes (headers + data), classify image vs label map
  const items = [];
  for (const n of niis) {
    try {
      const vol = await n.get();
      const aff = chooseAffine(vol.header, settings.geometryPriority);
      const stem = stemOf(n.path);
      const name = baseName(stem);
      items.push({ ...n, vol, aff, stem, name, lab: aff.affine ? isLabelMap(vol, name, settings.maskHandling) : { label: false } });
    } catch (err) {
      R.series.push({ exam: exam.name, direction: 'NIfTI→DICOM', input: n.path, outputs: [], status: 'error', notes: [err.message], warnings: [] });
      R.errors.push(`${n.path}: ${err.message}`);
    }
  }
  items.sort((a, b) => Number(a.lab.label) - Number(b.lab.label) || a.path.localeCompare(b.path));
  const converted = []; // image series produced here (for SEG references)
  let seriesNumber = 0;
  let idx = 0;
  for (const it of items) {
    idx++;
    progress({ stage: 'converting', pct: 25 + 65 * ((idx - 1) / items.length), message: it.name });
    const row = { exam: exam.name, direction: 'NIfTI→DICOM', input: it.path, outputs: [], status: 'ok', verification: '', notes: [], warnings: [] };
    try {
      if (!it.aff.affine) throw new Error('NIfTI has no orientation (qform_code = sform_code = 0); geometry cannot be determined');
      if (it.aff.divergence !== null && it.aff.divergence > 1e-3) row.warnings.push(`qform and sform differ by up to ${fmtNum(it.aff.divergence, 3)} mm; ${it.aff.source} used (setting)`);
      row.notes.push(`geometry: ${it.aff.source} (${XFORM[it.aff.code] || it.aff.code})`);
      const vol = it.vol;
      const sidecar = inv.json.has(it.stem) ? JSON.parse(textDecoder.decode(await inv.json.get(it.stem).getBytes())) : null;
      // reference grid match
      let matched = null;
      for (const { s, g } of refGeoms) {
        try {
          const plan = planSlices(it.aff.affine, vol.dims.slice(0, 3), { reference: g });
          if (plan.matchedReference) { matched = { s, g }; break; }
        } catch { /* not this one */ }
      }
      const meta = assembleMeta({ refDs, refSeriesDs: matched ? matched.s.first.ds : null, sidecar, csvRow, settings, examKey: exam.name, stem: it.name });
      const id = resolveIdentity(meta, idctx, exam.name, examState);
      if (!R.outRoot) { R.outRoot = examOutName(exam, idctx, id.pseudo); R.patient = id.patient.PatientID; }
      // Frame of Reference
      let forUID;
      if (matched) { forUID = idctx.uid(matched.s.first.forUID) || newUID(); row.notes.push('voxel grid identical to a source DICOM series (same Frame of Reference)'); }
      else if (it.aff.code === 1 && refFoRs.length === 1) { forUID = idctx.uid(refFoRs[0]); row.notes.push('scanner coordinates: Frame of Reference of the exam DICOM'); }
      else {
        const key = `code${it.aff.code}`;
        if (!examState.forByCode[key]) examState.forByCode[key] = newUID();
        forUID = examState.forByCode[key];
      }
      const descriptor = (t) => (idctx.anonymize ? idctx.descriptor(t, meta.original) : t);
      const desc = descriptor(meta.series.SeriesDescription) || `OMNIA ${seriesNumber + 1}`;
      if (it.lab.label) {
        // ---- segmentation
        const src = converted.find((c) => sameGrid(c, { dims: vol.dims, affine: it.aff.affine }));
        let source = null;
        if (src) source = { plan: src.plan, sopClass: src.sopClass, sopUIDs: src.sopUIDs[0], seriesUID: src.seriesUID, forUID: src.forUID };
        else if (matched && !idctx.anonymize) {
          const plan = planSlices(it.aff.affine, vol.dims.slice(0, 3), { reference: matched.g });
          const byPos = plan.positions.map((p) => matched.g.instances.find((ins) => Math.hypot(...sub(ins.ipp, p)) < 0.01));
          if (byPos.every(Boolean)) source = { plan, sopClass: matched.s.first.sopClass, sopUIDs: byPos.map((ins) => ins.sopInstance), seriesUID: matched.s.first.seriesUID, forUID };
        }
        if (!source) {
          row.warnings.push('no image series on the same voxel grid in this exam: label map converted as an image series instead of SEG');
        } else {
          const table = (() => {
            for (const key of [it.stem, `${it.stem}_labels`, `${it.stem}.labels`]) if (inv.text.has(key) || inv.json.has(`${key}`)) return key;
            return null;
          })();
          let tbl = null;
          if (table) {
            const e = inv.text.get(table) || inv.json.get(table);
            try { tbl = parseLabelTable(textDecoder.decode(await e.getBytes()), e.path); row.notes.push(`label names from ${baseName(e.path)}`); } catch (err) { row.warnings.push(`label table unreadable: ${err.message}`); }
          }
          const segments = buildSegments(it.lab.labels, tbl);
          seriesNumber++;
          const seg = buildSegmentation({ labelVol: vol, segments, source, meta, id, seriesNumber, forUID: source.forUID, settings, seriesDescription: desc });
          const v = verifySegmentation(seg.files[0].bytes, vol, it.aff.affine, segments);
          if (!v.ok) throw new Error(`SEG verification failed: ${v.issues.join('; ')}`);
          row.verification = `voxel-exact (${v.labelledVoxels} labelled voxels, ${segments.length} segment(s))`;
          row.kind = 'SEG';
          row.notes.push(`DICOM SEG: ${segments.length} segment(s), ${seg.frames} frame(s), references ${src ? 'the image series converted here' : 'the source DICOM series'}`);
          const folder = `${R.outRoot}/${String(seriesNumber).padStart(3, '0')}_SEG_${safeName(desc, 32)}`;
          for (const f of seg.files) { R.outputs.push({ path: `${folder}/${f.name}`, bytes: f.bytes, compress: true }); }
          row.outputs.push(folder + '/');
          R.series.push(row);
          continue;
        }
      }
      // ---- image series
      let defaced = false;
      if (settings.deface && meta.series.Modality === 'CT') {
        const before = R.qc.length < 12 ? anteriorRender(vol, it.aff.affine) : null;
        const dres = defaceCT(vol, it.aff.affine);
        if (dres.status === 'defaced') {
          defaced = true;
          row.notes.push(`face removed (intracranial ${fmtNum(dres.intracranialML, 4)} mL preserved)`);
          if (before) R.qc.push({ kind: 'deface', label: it.name, before, after: anteriorRender(vol, it.aff.affine) });
        } else if (dres.status === 'no-face-in-fov') row.notes.push('defacing: no facial tissue within the field of view');
        else if (settings.defaceFailure === 'exclude') throw new Error(`defacing not possible (${dres.reason}) — excluded by policy`);
        else { row.status = 'warning'; row.notes.push(`defacing not possible (${dres.reason}) — included WITHOUT defacing by policy`); }
      }
      let dwi = null;
      const nt = vol.dims.length > 3 ? vol.dims.slice(3).reduce((a, b) => a * b, 1) : 1;
      if (inv.bval.has(it.stem) && inv.bvec.has(it.stem)) {
        const bvals = textDecoder.decode(await inv.bval.get(it.stem).getBytes()).trim().split(/\s+/).map(Number);
        const rowsB = textDecoder.decode(await inv.bvec.get(it.stem).getBytes()).trim().split(/\r?\n/).map((l) => l.trim().split(/\s+/).map(Number));
        if (bvals.length === nt && rowsB.length === 3 && rowsB.every((r) => r.length === nt) && meta.series.Modality === 'MR') {
          dwi = { bvals, gradients: bvals.map((_, t) => bvecToPatient([rowsB[0][t], rowsB[1][t], rowsB[2][t]], it.aff.affine)) };
          row.notes.push(`diffusion: ${nt} volumes, b = ${[...new Set(bvals)].sort((a, b) => a - b).join('/')} s/mm²`);
        } else row.warnings.push('bval/bvec present but inconsistent with the volume count: diffusion tags not written');
      }
      seriesNumber++;
      const res = buildImageSeries({
        vol, affine: it.aff.affine, affineSource: it.aff.source, meta, id, seriesNumber, forUID,
        reference: matched ? matched.g : undefined, dwi, settings, defaced, seriesDescription: desc,
        protocolName: descriptor(meta.series.ProtocolName),
      });
      const v = verifyImageSeries(res.files, vol, it.aff.affine, res.enc);
      if (!v.ok) throw new Error(`verification failed: ${v.issues.slice(0, 3).join('; ')}`);
      row.verification = res.enc.mode === 'quantized' ? `within quantisation bound (${v.checkedVoxels} voxels)` : `voxel-exact (${v.checkedVoxels} voxels)`;
      row.encoding = res.enc.description;
      if (res.enc.mode === 'quantized') row.status = 'warning';
      row.kind = meta.series.Modality;
      row.notes.push(`${res.files.length} instance(s), ${res.plan.plane.toLowerCase()} ${res.plan.rows}×${res.plan.columns}, ${nt > 1 ? `${nt} volumes, ` : ''}${res.enc.description}`);
      row.notes.push(`metadata: patient ${meta.provenance.patient}, acquisition ${meta.provenance.acquisition || 'none'}`);
      if (res.plan.tilted) row.notes.push(`sheared slice stack (tilt ${fmtNum(res.plan.gantryTiltDeg, 3)}°) encoded exactly with per-slice positions`);
      const folder = `${R.outRoot}/${String(seriesNumber).padStart(3, '0')}_${safeName(desc, 40)}`;
      for (const f of res.files) R.outputs.push({ path: `${folder}/${f.name}`, bytes: f.bytes, compress: true });
      row.outputs.push(`${folder}/ (${res.files.length} files)`);
      converted.push({ dims: vol.dims, affine: it.aff.affine, plan: res.plan, sopClass: res.sopClass, sopUIDs: res.sopUIDs, seriesUID: res.seriesUID, forUID });
      if (R.qc.length < 12) { try { R.qc.push({ kind: 'ortho', label: it.name, views: renderOrtho(vol, it.aff.affine, meta.series.Modality) }); } catch { /* best effort */ } }
    } catch (err) {
      row.status = 'error';
      row.notes.push(err.message);
      R.errors.push(`${baseName(it.path)}: ${err.message}`);
    }
    R.series.push(row);
  }
  if (inv.dicom.length) R.ignored.push(`${inv.dicom.length} DICOM file(s) used only as metadata/geometry reference`);
}

/**
 * Process one exam.
 * @param {{name:string, input:Blob|Uint8Array}} exam
 * @param {object} settings
 * @param {{idctx:object, runner?:object, csvIndex?:Map}} env
 */
export async function processExam(exam, settings, env, progress = () => {}) {
  const R = newResult(exam, settings);
  const t0 = Date.now();
  try {
    progress({ stage: 'reading', pct: 2 });
    if (settings.direction === 'nii2dcm') await nii2dcmExam(exam, settings, env, progress, R);
    else await dcm2niiExam(exam, settings, env, progress, R);
  } catch (err) {
    R.errors.push(err.message || String(err));
  }
  if (!R.outRoot) R.outRoot = safeName(exam.name, 80);
  finalizeStatus(R);
  R.ms = Date.now() - t0;
  progress({ stage: 'done', pct: 100, status: R.status });
  return R;
}
