// DICOM header scanning, series grouping, series filtering and stack geometry analysis.
import { parseDicom } from './dicom/read.js';
import { dot, cross, unit, norm, sub, spacingRuns } from './geometry.js';

export const SOP_NAMES = {
  '1.2.840.10008.5.1.4.1.1.2': 'CT Image',
  '1.2.840.10008.5.1.4.1.1.2.1': 'Enhanced CT Image',
  '1.2.840.10008.5.1.4.1.1.2.2': 'Legacy Converted Enhanced CT Image',
  '1.2.840.10008.5.1.4.1.1.4': 'MR Image',
  '1.2.840.10008.5.1.4.1.1.4.1': 'Enhanced MR Image',
  '1.2.840.10008.5.1.4.1.1.4.4': 'Legacy Converted Enhanced MR Image',
};
export const IMAGE_SOPS = new Set(Object.keys(SOP_NAMES));
const ENHANCED = new Set(['1.2.840.10008.5.1.4.1.1.2.1', '1.2.840.10008.5.1.4.1.1.2.2', '1.2.840.10008.5.1.4.1.1.4.1', '1.2.840.10008.5.1.4.1.1.4.4']);

const LOCALIZER_RE = /(^|[^a-z])(localizer|localiser|locali[sz]ador|scout|survey|surview|topogram|tripilot|3[-_ ]?plane|3pl|aahead_scout|loc|planning)([^a-z]|$)/i;

/** Parse the header of one DICOM file into a compact instance summary. */
export function summarizeInstance(bytes, path) {
  const f = parseDicom(bytes, { untilTag: 0x7FE00010, allowTruncated: true });
  const ds = f.dataset;
  if (!ds) throw new Error('No dataset');
  const nums = (k) => ds.numbers(k);
  const inst = {
    path,
    ts: f.transferSyntax,
    sopClass: ds.string('SOPClassUID') || f.meta.string(0x00020002),
    sopInstance: ds.string('SOPInstanceUID'),
    studyUID: ds.string('StudyInstanceUID'),
    seriesUID: ds.string('SeriesInstanceUID'),
    seriesNumber: ds.number('SeriesNumber'),
    modality: ds.string('Modality').toUpperCase(),
    seriesDescription: ds.string('SeriesDescription'),
    protocolName: ds.string('ProtocolName'),
    imageType: ds.strings('ImageType').map((s) => s.toUpperCase()),
    instanceNumber: ds.number('InstanceNumber'),
    acquisitionNumber: ds.number('AcquisitionNumber'),
    echoNumber: ds.number('EchoNumbers'),
    ipp: nums('ImagePositionPatient'),
    iop: nums('ImageOrientationPatient'),
    ps: nums('PixelSpacing'),
    rows: ds.number('Rows'),
    cols: ds.number('Columns'),
    frames: ds.number('NumberOfFrames') || 1,
    patientID: ds.string('PatientID'),
    patientName: ds.string('PatientName'),
    birthDate: ds.string('PatientBirthDate'),
    accession: ds.string('AccessionNumber'),
    forUID: ds.string('FrameOfReferenceUID'),
    manufacturer: ds.string('Manufacturer'),
    bodyPart: ds.string('BodyPartExamined'),
    bitsAllocated: ds.number('BitsAllocated'),
    samplesPerPixel: ds.number('SamplesPerPixel') ?? 1,
    // a mosaic file holds a whole volume as a grid of slices: Siemens (ImageType MOSAIC) or United Imaging
    // (private 'Image Private Header' block, element (0065,xx50) = number of images in the grid)
    mosaic: ds.strings('ImageType').some((s) => s.toUpperCase() === 'MOSAIC') || uihGridCount(ds) > 1,
    ds,
  };
  if (ENHANCED.has(inst.sopClass)) {
    // per-frame geometry from the functional groups (per-frame values override shared ones)
    const shared = ds.seq('SharedFunctionalGroupsSequence')[0];
    const pf = ds.seq('PerFrameFunctionalGroupsSequence');
    const fromFG = (fg, seqName, attr) => {
      if (!fg) return null;
      const it = fg.seq(seqName)[0];
      const v = it ? it.numbers(attr) : [];
      return v.length ? v : null;
    };
    const sIop = fromFG(shared, 'PlaneOrientationSequence', 'ImageOrientationPatient');
    const sPs = fromFG(shared, 'PixelMeasuresSequence', 'PixelSpacing');
    inst.frameGeom = pf.map((fg) => ({
      ipp: fromFG(fg, 'PlanePositionSequence', 'ImagePositionPatient'),
      iop: fromFG(fg, 'PlaneOrientationSequence', 'ImageOrientationPatient') || sIop,
      ps: fromFG(fg, 'PixelMeasuresSequence', 'PixelSpacing') || sPs,
    }));
    const g0 = inst.frameGeom[0] || {};
    inst.iop = g0.iop || [];
    inst.ps = g0.ps || [];
    inst.ipp = g0.ipp || [];
    inst.enhanced = true;
  }
  return inst;
}

/** Group instance summaries by SeriesInstanceUID. */
export function groupSeries(instances) {
  const map = new Map();
  for (const i of instances) {
    const key = i.seriesUID || `nouid:${i.seriesNumber}:${i.sopClass}`;
    let s = map.get(key);
    if (!s) { s = { uid: key, instances: [], first: i }; map.set(key, s); }
    s.instances.push(i);
  }
  return [...map.values()];
}

/**
 * Decide whether a series is converted (DICOM->NIfTI) according to the batch filters.
 * filters: { localizers, derivedSecondary, minImages }
 */
export function filterSeries(s, filters) {
  const f = s.first;
  const reasons = [];
  if (!IMAGE_SOPS.has(f.sopClass)) {
    const sopName = f.sopClass ? f.sopClass : 'unknown';
    if (/^1\.2\.840\.10008\.5\.1\.4\.1\.1\.7/.test(sopName)) reasons.push('secondary capture (screenshot)');
    else if (/^1\.2\.840\.10008\.5\.1\.4\.1\.1\.88/.test(sopName)) reasons.push('structured report (e.g. dose report)');
    else if (/^1\.2\.840\.10008\.5\.1\.4\.1\.1\.11/.test(sopName)) reasons.push('presentation state');
    else if (f.modality && f.modality !== 'CT' && f.modality !== 'MR') reasons.push(`modality ${f.modality} outside scope (CT/MR)`);
    else reasons.push(`SOP class ${sopName} is not a CT/MR image`);
    return { keep: false, reasons };
  }
  if (f.samplesPerPixel !== 1) return { keep: false, reasons: ['colour images are not converted'] };
  const isLoc = s.instances.some((i) => i.imageType.includes('LOCALIZER')) || LOCALIZER_RE.test(f.seriesDescription || '') || LOCALIZER_RE.test(f.protocolName || '');
  if (filters.localizers && isLoc) reasons.push('localizer / scout');
  const derivedSecondary = f.imageType[0] === 'DERIVED' && f.imageType[1] === 'SECONDARY';
  if (filters.derivedSecondary && derivedSecondary) reasons.push('derived secondary reconstruction (MPR/MIP/3D)');
  const nImages = s.instances.reduce((a, i) => a + (i.frames || 1), 0);
  const mosaic = s.instances.some((i) => i.mosaic); // each mosaic file holds a whole volume
  if (!mosaic && nImages < (filters.minImages || 1)) reasons.push(`only ${nImages} image(s) (minimum ${filters.minImages})`);
  return { keep: reasons.length === 0, reasons, nImages };
}

function rawText(ds, tag) {
  const e = ds.get(tag);
  if (!e || !e.bytes || !e.length) return '';
  let out = '';
  for (const b of e.bytes) out += String.fromCharCode(b);
  return out.replace(/[\0 ]+$/, '').trim();
}

/** Number of images in a United Imaging (UIH) grid/mosaic image, 0 when not a UIH grid. */
export function uihGridCount(ds) {
  for (let block = 0x10; block <= 0xff; block++) {
    if (rawText(ds, (0x0065 << 16 | block) >>> 0) !== 'Image Private Header') continue;
    const n = parseFloat(rawText(ds, (0x0065 << 16 | (block << 8) | 0x50) >>> 0));
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/**
 * Analyse the stack geometry of a classic (single-frame) series.
 * Returns { ok, normal, uniquePositions, repeats, runs, uniform, tiltDeg, issues }
 */
export function analyzeStack(s) {
  if (s.instances.some((i) => i.mosaic)) return { ok: true, mosaic: true, issues: [] }; // geometry is decoded by dcm2niix
  const inst = s.instances.filter((i) => i.ipp.length === 3 && i.iop.length === 6);
  if (!inst.length) return { ok: false, issues: ['no geometry (ImagePositionPatient/ImageOrientationPatient missing)'] };
  const iop0 = inst[0].iop;
  const mixed = inst.some((i) => i.iop.some((v, j) => Math.abs(v - iop0[j]) > 1e-4));
  if (mixed) return { ok: true, mixedOrientation: true, issues: ['several orientations in one series (dcm2niix splits them)'] };
  const n = unit(cross(iop0.slice(0, 3), iop0.slice(3, 6)));
  const proj = inst.map((i) => ({ i, d: dot(i.ipp, n) }));
  proj.sort((a, b) => a.d - b.d);
  // unique positions (tolerance 0.01 mm)
  const uniq = [];
  for (const p of proj) {
    const last = uniq[uniq.length - 1];
    if (last && Math.abs(p.d - last.d) < 0.01 && norm(sub(p.i.ipp, last.items[0].ipp)) < 0.01) last.items.push(p.i);
    else uniq.push({ d: p.d, items: [p.i] });
  }
  const repeats = new Set(uniq.map((u) => u.items.length));
  const positions = uniq.map((u) => u.items[0].ipp);
  const sr = spacingRuns(positions, n);
  let tiltDeg = 0;
  if (positions.length >= 2) {
    const step = unit(sub(positions[positions.length - 1], positions[0]));
    tiltDeg = Math.acos(Math.min(1, Math.abs(dot(step, n)))) * 180 / Math.PI;
  }
  return {
    ok: true, normal: n, uniquePositions: uniq, positions, repeats: [...repeats], spacingUniform: sr.uniform,
    runs: sr.runs, spacings: sr.spacings, tiltDeg, issues: [],
    consistentRepeats: repeats.size === 1,
  };
}
