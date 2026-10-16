// NIfTI -> DICOM: classic single-frame CT/MR Image Storage series (3D and 4D, incl. DWI)
// and DICOM Segmentation (SEG, binary) for label maps.
import { WDataset, writePart10, codeItem } from './dicom/write.js';
import { newUID, IMPLEMENTATION_CLASS_UID, IMPLEMENTATION_VERSION_NAME, OMNIA_VERSION } from './uid.js';
import { planSlices, dot, unit, cross } from './geometry.js';
import { planEncoding } from './pixels.js';
import { effectiveScaling } from './nifti.js';
import { DEID_CODES } from './anon.js';

export const SOP = {
  CT: '1.2.840.10008.5.1.4.1.1.2',
  MR: '1.2.840.10008.5.1.4.1.1.4',
  SEG: '1.2.840.10008.5.1.4.1.1.66.4',
};
// Body parts that are paired structures (PS3.16 Annex L defined terms with laterality).
export const PAIRED_BODY_PARTS = new Set(['ADRENAL', 'ANKLE', 'ARM', 'AXILLA', 'BREAST', 'BUTTOCK', 'CALCANEUS', 'CALF', 'CAROTID',
  'CHEEK', 'CLAVICLE', 'CORNEA', 'EAR', 'ELBOW', 'EXTREMITY', 'EYE', 'EYELID', 'FEMUR', 'FIBULA', 'FINGER', 'FOOT', 'FOREARM',
  'HAND', 'HIP', 'HUMERUS', 'IAC', 'ILIUM', 'KIDNEY', 'KNEE', 'LEG', 'LOWER LIMB', 'LOWER_LIMB', 'LUNG', 'ORBIT', 'OVARY',
  'PAROTID', 'PATELLA', 'RADIUS', 'RIB', 'SCAPULA', 'SCLERA', 'SHOULDER', 'SUBMANDIBULAR', 'TESTIS', 'THIGH', 'THUMB', 'TIBIA',
  'TMJ', 'TOE', 'ULNA', 'UPPER LIMB', 'UPPER_LIMB', 'URETER', 'WRIST', 'ZYGOMA', 'JOINT']);
const IMPL = { implementationClassUID: IMPLEMENTATION_CLASS_UID, implementationVersionName: IMPLEMENTATION_VERSION_NAME };

function nowStamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return {
    date: `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`,
    time: `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`,
  };
}

/** Resolve the (possibly de-identified) patient/study identity for one exam. */
export function resolveIdentity(meta, idctx, examKey, examState) {
  const anon = idctx.anonymize;
  const pat = idctx.patient(meta.patientKey, meta.original);
  if (!pat.exams.includes(examKey)) pat.exams.push(examKey);
  const P = meta.patient, S = meta.study;
  const keepChars = !anon || idctx.s.retainPatientCharacteristics;
  const patient = {
    PatientName: anon ? pat.pseudo : P.PatientName,
    PatientID: anon ? pat.pseudo : (P.PatientID || examState.fallbackPatientID),
    PatientBirthDate: anon ? '' : P.PatientBirthDate,
    PatientSex: keepChars ? P.PatientSex : '',
    PatientAge: keepChars ? P.PatientAge : '',
    PatientSize: keepChars ? P.PatientSize : '',
    PatientWeight: keepChars ? P.PatientWeight : '',
  };
  if (!examState.studyUID) examState.studyUID = S.StudyInstanceUID ? idctx.uid(S.StudyInstanceUID) : newUID();
  const study = {
    StudyInstanceUID: examState.studyUID,
    StudyDate: idctx.date(S.StudyDate, pat),
    StudyTime: idctx.time(S.StudyTime),
    StudyID: anon ? '' : S.StudyID,
    AccessionNumber: anon ? '' : S.AccessionNumber,
    StudyDescription: idctx.descriptor(S.StudyDescription, meta.original),
    ReferringPhysicianName: anon ? '' : S.ReferringPhysicianName,
  };
  const methods = [];
  if (anon) {
    methods.push(DEID_CODES.BASIC);
    if (idctx.s.keepDescriptions) methods.push(DEID_CODES.CLEAN_DESCRIPTORS);
    if (idctx.s.retainPatientCharacteristics) methods.push(DEID_CODES.RETAIN_PATIENT_CHARACTERISTICS);
    if (idctx.s.dates === 'shift') methods.push(DEID_CODES.RETAIN_MODIFIED_DATES);
    if (idctx.s.dates === 'keep') methods.push(DEID_CODES.RETAIN_FULL_DATES);
  }
  return { patient, study, pseudo: pat, methods, anon };
}

function addPatientStudy(ds, id, defacedNote) {
  const p = id.patient, st = id.study;
  ds.set('PatientName', p.PatientName || '', 'PN');
  ds.set('PatientID', p.PatientID || '', 'LO');
  ds.set('PatientBirthDate', p.PatientBirthDate || '', 'DA');
  ds.set('PatientSex', p.PatientSex || '', 'CS');
  if (p.PatientAge) ds.set('PatientAge', p.PatientAge, 'AS');
  if (p.PatientSize) ds.set('PatientSize', p.PatientSize, 'DS');
  if (p.PatientWeight) ds.set('PatientWeight', p.PatientWeight, 'DS');
  if (id.anon) {
    ds.set('PatientIdentityRemoved', 'YES', 'CS');
    const methods = id.methods.slice();
    if (defacedNote) methods.push(DEID_CODES.CLEAN_RECOGNIZABLE_VISUAL);
    ds.set('DeidentificationMethod', `OMNIA ${OMNIA_VERSION}: PS3.15 Basic Profile` + (defacedNote ? ' + CT defacing' : ''), 'LO');
    ds.seq('DeidentificationMethodCodeSequence', methods.map(([v, sch, m]) => codeItem(v, sch, m)));
  }
  ds.set('StudyInstanceUID', st.StudyInstanceUID, 'UI');
  ds.set('StudyDate', st.StudyDate || '', 'DA');
  ds.set('StudyTime', st.StudyTime || '', 'TM');
  ds.set('ReferringPhysicianName', st.ReferringPhysicianName || '', 'PN');
  ds.set('StudyID', st.StudyID || '', 'SH');
  ds.set('AccessionNumber', st.AccessionNumber || '', 'SH');
  if (st.StudyDescription) ds.set('StudyDescription', st.StudyDescription, 'LO');
}

function contributingEquipment(meta, id) {
  const items = [];
  const src = meta.sourceEquipment;
  if (src.Manufacturer || src.ManufacturerModelName) {
    const it = new WDataset();
    it.set('Manufacturer', src.Manufacturer || '', 'LO');
    if (src.ManufacturerModelName) it.set('ManufacturerModelName', src.ManufacturerModelName, 'LO');
    if (src.SoftwareVersions) it.set('SoftwareVersions', src.SoftwareVersions, 'LO');
    if (!id.anon) {
      if (src.InstitutionName) it.set('InstitutionName', src.InstitutionName, 'LO');
      if (src.StationName) it.set('StationName', src.StationName, 'SH');
      if (src.DeviceSerialNumber) it.set('DeviceSerialNumber', src.DeviceSerialNumber, 'LO');
    }
    it.seq('PurposeOfReferenceCodeSequence', [codeItem('109101', 'DCM', 'Acquisition Equipment')]);
    items.push(it);
  }
  const me = new WDataset();
  me.set('Manufacturer', 'OMNIA', 'LO');
  me.set('ManufacturerModelName', 'OMNIA NIfTI-DICOM Converter', 'LO');
  me.set('SoftwareVersions', OMNIA_VERSION, 'LO');
  me.seq('PurposeOfReferenceCodeSequence', [codeItem('109102', 'DCM', 'Processing Equipment')]);
  items.push(me);
  if (id.anon) {
    const de = new WDataset();
    de.set('Manufacturer', 'OMNIA', 'LO');
    de.set('ManufacturerModelName', 'OMNIA NIfTI-DICOM Converter', 'LO');
    de.set('SoftwareVersions', OMNIA_VERSION, 'LO');
    de.seq('PurposeOfReferenceCodeSequence', [codeItem('109104', 'DCM', 'De-identifying Equipment')]);
    items.push(de);
  }
  return items;
}

/** Robust display window from physical values (0.5-99.5 percentile of volume 0). */
function autoWindow(vol, enc, modality) {
  if (modality === 'CT') return [40, 400];
  const n = vol.dims[0] * vol.dims[1] * vol.dims[2];
  const stride = Math.max(1, Math.floor(n / 400000));
  const vals = [];
  for (let i = 0; i < n; i += stride) {
    const v = enc.store(i) * enc.slope + enc.inter;
    if (Number.isFinite(v)) vals.push(v);
  }
  vals.sort((a, b) => a - b);
  if (!vals.length) return [0, 1];
  const lo = vals[Math.floor(vals.length * 0.005)], hi = vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.995))];
  const w = Math.max(hi - lo, 1e-6);
  return [lo + w / 2, w];
}

/** Convert FSL-convention bvecs (voxel frame) to DICOM patient (LPS) gradient directions. */
export function bvecToPatient(bvec, rasAffine) {
  const R = [0, 1, 2].map((c) => unit([rasAffine[0][c], rasAffine[1][c], rasAffine[2][c]]));
  const M3 = [[rasAffine[0][0], rasAffine[0][1], rasAffine[0][2]], [rasAffine[1][0], rasAffine[1][1], rasAffine[1][2]], [rasAffine[2][0], rasAffine[2][1], rasAffine[2][2]]];
  const det = M3[0][0] * (M3[1][1] * M3[2][2] - M3[1][2] * M3[2][1]) - M3[0][1] * (M3[1][0] * M3[2][2] - M3[1][2] * M3[2][0]) + M3[0][2] * (M3[1][0] * M3[2][1] - M3[1][1] * M3[2][0]);
  const g = bvec.slice();
  if (det > 0) g[0] = -g[0]; // FSL: x flipped for positive-determinant (neurological) storage
  const ras = [0, 1, 2].map((r) => R[0][r] * g[0] + R[1][r] * g[1] + R[2][r] * g[2]);
  return [-ras[0], -ras[1], ras[2]];
}

/**
 * Build a classic single-frame CT/MR series from a NIfTI volume.
 * @returns {{files:{name:string,bytes:Uint8Array}[], seriesUID:string, sopUIDs:string[][], plan:object, enc:object, frameOfReferenceUID:string}}
 */
export function buildImageSeries(o) {
  const { vol, affine, meta, id, seriesNumber, forUID, reference, dwi, settings, defaced, seriesDescription } = o;
  const modality = meta.series.Modality;
  const dims = vol.dims;
  const [nx, ny, nz] = dims;
  const nt = dims.length > 3 ? dims.slice(3).reduce((a, b) => a * b, 1) : 1;
  const plan = planSlices(affine, dims.slice(0, 3), { reference });
  const enc = planEncoding(vol, { allowQuantize: settings.valuePolicy === 'quantize' });
  const window = meta.window || autoWindow(vol, enc, modality);
  const seriesUID = newUID();
  const stamp = nowStamp();
  const { colAxis, colSign, rowAxis, rowSign } = plan.choice;
  const strideOf = (ax) => (ax === 0 ? 1 : nx);
  const cStride = strideOf(colAxis) * colSign;
  const rStride = strideOf(rowAxis) * rowSign;
  const c0 = colSign > 0 ? 0 : (dims[colAxis] - 1) * strideOf(colAxis);
  const r0 = rowSign > 0 ? 0 : (dims[rowAxis] - 1) * strideOf(rowAxis);
  const rows = plan.rows, cols = plan.columns;
  const sopUIDs = [];
  const files = [];
  const derivation = [
    `OMNIA ${OMNIA_VERSION}: converted from NIfTI`,
    `geometry: ${o.affineSource}${plan.matchedReference ? ' (matched to source DICOM grid)' : ''}`,
    `pixel values: ${enc.description}`,
    defaced ? 'face removed (CT defacing)' : '',
  ].filter(Boolean).join('; ').slice(0, 1024);

  const imageType = modality === 'CT' ? ['DERIVED', 'SECONDARY', 'AXIAL'] : ['DERIVED', 'SECONDARY', 'OTHER'];
  const sopClass = SOP[modality];
  const pixelArray = enc.signed ? Int16Array : Uint16Array;
  const lo = enc.signed ? -32768 : 0, hi = enc.signed ? 32767 : 65535;

  for (let t = 0; t < nt; t++) {
    sopUIDs.push([]);
    for (let k = 0; k < nz; k++) {
      const ds = new WDataset();
      const sopUID = newUID();
      sopUIDs[t].push(sopUID);
      ds.set('SOPClassUID', sopClass, 'UI');
      ds.set('SOPInstanceUID', sopUID, 'UI');
      ds.set('ImageType', imageType, 'CS');
      if (!id.anon) {
        ds.set('InstanceCreationDate', stamp.date, 'DA');
        ds.set('InstanceCreationTime', stamp.time, 'TM');
        ds.set('ContentDate', stamp.date, 'DA');
        ds.set('ContentTime', stamp.time, 'TM');
      }
      ds.set('Modality', modality, 'CS');
      ds.set('Manufacturer', 'OMNIA', 'LO');
      ds.set('ManufacturerModelName', 'OMNIA NIfTI-DICOM Converter', 'LO');
      ds.set('SoftwareVersions', OMNIA_VERSION, 'LO');
      ds.set('SeriesDescription', seriesDescription || 'OMNIA', 'LO');
      ds.set('DerivationDescription', derivation, 'ST');
      ds.seq('ContributingEquipmentSequence', contributingEquipment(meta, id));
      addPatientStudy(ds, id, defaced);
      if (meta.series.BodyPartExamined) ds.set('BodyPartExamined', meta.series.BodyPartExamined, 'CS');
      if (o.protocolName) ds.set('ProtocolName', o.protocolName, 'LO');
      ds.set('PatientPosition', meta.series.PatientPosition || '', 'CS');
      // Laterality (Type 2C): required (may be empty) when the body part is a paired structure or unknown
      if (!meta.series.BodyPartExamined || PAIRED_BODY_PARTS.has(meta.series.BodyPartExamined)) ds.set('Laterality', '', 'CS');
      ds.set('SeriesInstanceUID', seriesUID, 'UI');
      ds.set('SeriesNumber', seriesNumber, 'IS');
      ds.set('InstanceNumber', t * nz + k + 1, 'IS');
      ds.set('FrameOfReferenceUID', forUID, 'UI');
      ds.set('PositionReferenceIndicator', meta.positionReferenceIndicator || '', 'LO');
      // Image Plane
      ds.set('ImagePositionPatient', plan.positions[k], 'DS');
      ds.set('ImageOrientationPatient', plan.iop, 'DS');
      ds.set('PixelSpacing', plan.pixelSpacing, 'DS');
      ds.set('SliceThickness', meta.sliceThickness === '' ? '' : meta.sliceThickness, 'DS');
      ds.set('SliceLocation', plan.sliceLocation[k], 'DS');
      if (modality === 'MR') ds.set('SpacingBetweenSlices', plan.planeSpacing, 'DS');
      // Image Pixel
      ds.set('SamplesPerPixel', 1, 'US');
      ds.set('PhotometricInterpretation', 'MONOCHROME2', 'CS');
      ds.set('Rows', rows, 'US');
      ds.set('Columns', cols, 'US');
      ds.set('BitsAllocated', 16, 'US');
      ds.set('BitsStored', 16, 'US');
      ds.set('HighBit', 15, 'US');
      ds.set('PixelRepresentation', enc.signed ? 1 : 0, 'US');
      const identity = enc.slope === 1 && enc.inter === 0;
      if (modality === 'CT' || !identity) {
        ds.set('RescaleIntercept', enc.inter, 'DS');
        ds.set('RescaleSlope', enc.slope, 'DS');
        if (modality === 'MR') ds.set('RescaleType', 'US', 'LO');
      }
      ds.set('WindowCenter', window[0], 'DS');
      ds.set('WindowWidth', window[1], 'DS');
      if (window[1] < 1) ds.set('VOILUTFunction', 'LINEAR_EXACT', 'CS'); // widths < 1 require LINEAR_EXACT
      if (modality === 'CT') {
        ds.set('KVP', meta.ct.KVP ?? '', 'DS');
        ds.set('AcquisitionNumber', nt > 1 ? t + 1 : '', 'IS');
        if (meta.ct.ConvolutionKernel && meta.ct.ConvolutionKernel.length) ds.set('ConvolutionKernel', meta.ct.ConvolutionKernel, 'SH');
        if (Number.isFinite(meta.ct.XRayTubeCurrent)) ds.set('XRayTubeCurrent', Math.round(meta.ct.XRayTubeCurrent), 'IS');
        if (Number.isFinite(meta.ct.ExposureTime)) ds.set('ExposureTime', Math.round(meta.ct.ExposureTime), 'IS');
        if (Number.isFinite(meta.ct.Exposure)) ds.set('Exposure', Math.round(meta.ct.Exposure), 'IS');
        if (plan.tilted && plan.plane === 'AXIAL') ds.set('GantryDetectorTilt', plan.gantryTiltDeg, 'DS');
      } else {
        const mr = meta.mr;
        ds.set('ScanningSequence', mr.ScanningSequence, 'CS');
        ds.set('SequenceVariant', mr.SequenceVariant, 'CS');
        ds.set('ScanOptions', mr.ScanOptions && mr.ScanOptions.length ? mr.ScanOptions : '', 'CS');
        ds.set('MRAcquisitionType', mr.MRAcquisitionType || '', 'CS');
        if (mr.SequenceName) ds.set('SequenceName', mr.SequenceName, 'SH');
        ds.set('RepetitionTime', Number.isFinite(mr.RepetitionTime) ? mr.RepetitionTime : '', 'DS');
        ds.set('EchoTime', Number.isFinite(mr.EchoTime) ? mr.EchoTime : '', 'DS');
        ds.set('EchoTrainLength', Number.isFinite(mr.EchoTrainLength) ? Math.round(mr.EchoTrainLength) : '', 'IS');
        // Inversion Time is Type 2C: present only when Scanning Sequence includes IR
        if (mr.ScanningSequence.includes('IR')) ds.set('InversionTime', Number.isFinite(mr.InversionTime) ? mr.InversionTime : '', 'DS');
        if (Number.isFinite(mr.FlipAngle)) ds.set('FlipAngle', mr.FlipAngle, 'DS');
        if (Number.isFinite(mr.MagneticFieldStrength)) ds.set('MagneticFieldStrength', mr.MagneticFieldStrength, 'DS');
        if (Number.isFinite(mr.ImagingFrequency)) ds.set('ImagingFrequency', mr.ImagingFrequency, 'DS');
        if (Number.isFinite(mr.PixelBandwidth)) ds.set('PixelBandwidth', mr.PixelBandwidth, 'DS');
        if (nt > 1) {
          ds.set('AcquisitionNumber', t + 1, 'IS');
          ds.set('TemporalPositionIdentifier', t + 1, 'IS');
          ds.set('NumberOfTemporalPositions', nt, 'IS');
        }
        if (dwi) {
          const b = dwi.bvals[t];
          const g = dwi.gradients[t];
          ds.set('DiffusionBValue', b, 'FD');
          const gn = Math.hypot(g[0], g[1], g[2]);
          if (b > 0 && gn > 1e-6) {
            ds.set('DiffusionDirectionality', 'DIRECTIONAL', 'CS');
            ds.set('DiffusionGradientOrientation', g.map((x) => x / gn), 'FD');
          } else if (b > 0) ds.set('DiffusionDirectionality', 'ISOTROPIC', 'CS');
          else ds.set('DiffusionDirectionality', 'NONE', 'CS');
        }
      }
      // Pixel data
      const px = new pixelArray(rows * cols);
      const base = (t * nz + k) * nx * ny + c0 + r0;
      let o2 = 0;
      for (let r = 0; r < rows; r++) {
        let L = base + r * rStride;
        for (let c = 0; c < cols; c++, L += cStride) {
          const v = enc.store(L);
          if (!(v >= lo && v <= hi) || !Number.isInteger(v)) throw new Error(`Internal: stored value ${v} out of range at voxel ${L}`);
          px[o2++] = v;
        }
      }
      ds.set('PixelData', new Uint8Array(px.buffer), 'OW');
      files.push({ name: `IM_${String(t * nz + k + 1).padStart(5, '0')}.dcm`, bytes: writePart10(ds, IMPL), sliceIndex: k, volumeIndex: t });
    }
  }
  return { files, seriesUID, sopUIDs, plan, enc, sopClass, window };
}

/**
 * Build a binary DICOM Segmentation (one multi-frame instance) for a label volume on the grid of a
 * referenced image series that OMNIA (or the source DICOM) provides slice by slice.
 * @param o.labels  integer label TypedArray (3D)
 * @param o.segments [{value, label, category:[v,s,m], type:[v,s,m]}]
 * @param o.source  { plan, sopClass, sopUIDs: string[] (per k), seriesUID }
 */
export function buildSegmentation(o) {
  const { labelVol, segments, source, meta, id, seriesNumber, forUID, settings, seriesDescription } = o;
  const plan = source.plan;
  const dims = labelVol.dims;
  const [nx, ny, nz] = dims;
  const { colAxis, colSign, rowAxis, rowSign } = plan.choice;
  const strideOf = (ax) => (ax === 0 ? 1 : nx);
  const cStride = strideOf(colAxis) * colSign;
  const rStride = strideOf(rowAxis) * rowSign;
  const c0 = colSign > 0 ? 0 : (dims[colAxis] - 1) * strideOf(colAxis);
  const r0 = rowSign > 0 ? 0 : (dims[rowAxis] - 1) * strideOf(rowAxis);
  const rows = plan.rows, cols = plan.columns, npx = rows * cols;
  const data = labelVol.data;
  const { slope, inter } = effectiveScaling(labelVol.header);
  const labelAt = (L) => Math.round(Number(data[L]) * slope + inter);

  // position index: order slices along the normal (DimensionIndexValues are 1-based ranks)
  const order = [...Array(nz).keys()].sort((a, b) => plan.sliceLocation[a] - plan.sliceLocation[b]);
  const rank = new Array(nz);
  order.forEach((k, i) => { rank[k] = i + 1; });

  const frames = []; // { segIndex, k, bits: Uint8Array(npx) }
  segments.forEach((seg, si) => {
    for (const k of order) {
      const bits = new Uint8Array(npx);
      let any = false;
      const base = k * nx * ny + c0 + r0;
      let o2 = 0;
      for (let r = 0; r < rows; r++) {
        let L = base + r * rStride;
        for (let c = 0; c < cols; c++, L += cStride) {
          if (labelAt(L) === seg.value) { bits[o2] = 1; any = true; }
          o2++;
        }
      }
      if (any) frames.push({ segNumber: si + 1, k, bits });
    }
  });
  if (!frames.length) throw new Error('Segmentation is empty (no labelled voxels)');

  const ds = new WDataset();
  const sopUID = newUID();
  const seriesUID = newUID();
  const stamp = nowStamp();
  ds.set('SOPClassUID', SOP.SEG, 'UI');
  ds.set('SOPInstanceUID', sopUID, 'UI');
  ds.set('ImageType', ['DERIVED', 'PRIMARY'], 'CS');
  ds.set('Modality', 'SEG', 'CS');
  ds.set('Manufacturer', 'OMNIA', 'LO');
  ds.set('ManufacturerModelName', 'OMNIA NIfTI-DICOM Converter', 'LO');
  ds.set('DeviceSerialNumber', 'OMNIA-WEB', 'LO');
  ds.set('SoftwareVersions', OMNIA_VERSION, 'LO');
  ds.set('SeriesDescription', seriesDescription || 'OMNIA SEG', 'LO');
  ds.seq('ContributingEquipmentSequence', contributingEquipment(meta, id));
  addPatientStudy(ds, id, false);
  ds.set('SeriesInstanceUID', seriesUID, 'UI');
  ds.set('SeriesNumber', seriesNumber, 'IS');
  ds.set('InstanceNumber', 1, 'IS');
  ds.set('FrameOfReferenceUID', forUID, 'UI');
  ds.set('PositionReferenceIndicator', meta.positionReferenceIndicator || '', 'LO');
  // Content Date/Time are Type 1 in the Multi-frame Functional Groups Module: the conversion
  // timestamp is used (it is not patient data).
  ds.set('ContentDate', stamp.date, 'DA');
  ds.set('ContentTime', stamp.time, 'TM');
  ds.set('ContentLabel', 'SEGMENTATION', 'CS');
  ds.set('ContentDescription', 'Converted from a NIfTI label map by OMNIA', 'LO');
  ds.set('ContentCreatorName', '', 'PN');
  ds.set('SegmentationType', 'BINARY', 'CS');
  ds.set('LossyImageCompression', '00', 'CS');
  // Image pixel (1 bit)
  ds.set('SamplesPerPixel', 1, 'US');
  ds.set('PhotometricInterpretation', 'MONOCHROME2', 'CS');
  ds.set('Rows', rows, 'US');
  ds.set('Columns', cols, 'US');
  ds.set('BitsAllocated', 1, 'US');
  ds.set('BitsStored', 1, 'US');
  ds.set('HighBit', 0, 'US');
  ds.set('PixelRepresentation', 0, 'US');
  ds.set('NumberOfFrames', frames.length, 'IS');
  // Segment Sequence
  ds.seq('SegmentSequence', segments.map((seg, si) => {
    const it = new WDataset();
    it.set('SegmentNumber', si + 1, 'US');
    it.set('SegmentLabel', seg.label.slice(0, 64), 'LO');
    it.set('SegmentAlgorithmType', settings.segAlgorithmType || 'AUTOMATIC', 'CS');
    if ((settings.segAlgorithmType || 'AUTOMATIC') !== 'MANUAL') it.set('SegmentAlgorithmName', (settings.segAlgorithmName || 'Unspecified').slice(0, 64), 'LO');
    it.seq('SegmentedPropertyCategoryCodeSequence', [codeItem(...seg.category)]);
    it.seq('SegmentedPropertyTypeCodeSequence', [codeItem(...seg.type)]);
    return it;
  }));
  // Multi-frame dimension module
  const dimOrgUID = newUID();
  const dorg = new WDataset(); dorg.set('DimensionOrganizationUID', dimOrgUID, 'UI');
  ds.seq('DimensionOrganizationSequence', [dorg]);
  ds.set('DimensionOrganizationType', '3D', 'CS');
  const d1 = new WDataset();
  d1.set('DimensionOrganizationUID', dimOrgUID, 'UI');
  d1.set('DimensionIndexPointer', 0x0062000B, 'AT');
  d1.set('FunctionalGroupPointer', 0x0062000A, 'AT');
  d1.set('DimensionDescriptionLabel', 'ReferencedSegmentNumber', 'LO');
  const d2 = new WDataset();
  d2.set('DimensionOrganizationUID', dimOrgUID, 'UI');
  d2.set('DimensionIndexPointer', 0x00200032, 'AT');
  d2.set('FunctionalGroupPointer', 0x00209113, 'AT');
  d2.set('DimensionDescriptionLabel', 'ImagePositionPatient', 'LO');
  ds.seq('DimensionIndexSequence', [d1, d2]);
  // Shared functional groups
  const shared = new WDataset();
  const pm = new WDataset();
  pm.set('PixelSpacing', plan.pixelSpacing, 'DS');
  pm.set('SliceThickness', plan.planeSpacing, 'DS');
  pm.set('SpacingBetweenSlices', plan.planeSpacing, 'DS');
  shared.seq('PixelMeasuresSequence', [pm]);
  const po = new WDataset();
  po.set('ImageOrientationPatient', plan.iop, 'DS');
  shared.seq('PlaneOrientationSequence', [po]);
  ds.seq('SharedFunctionalGroupsSequence', [shared]);
  // Per-frame functional groups
  ds.seq('PerFrameFunctionalGroupsSequence', frames.map((f) => {
    const it = new WDataset();
    const der = new WDataset();
    const srcImg = new WDataset();
    srcImg.set('ReferencedSOPClassUID', source.sopClass, 'UI');
    srcImg.set('ReferencedSOPInstanceUID', source.sopUIDs[f.k], 'UI');
    srcImg.seq('PurposeOfReferenceCodeSequence', [codeItem('121322', 'DCM', 'Source image for image processing operation')]);
    srcImg.set('SpatialLocationsPreserved', 'YES', 'CS'); // same voxel grid as the source image
    der.seq('SourceImageSequence', [srcImg]);
    der.seq('DerivationCodeSequence', [codeItem('113076', 'DCM', 'Segmentation')]);
    it.seq('DerivationImageSequence', [der]);
    const fc = new WDataset();
    fc.set('DimensionIndexValues', [f.segNumber, rank[f.k]], 'UL');
    it.seq('FrameContentSequence', [fc]);
    const pp = new WDataset();
    pp.set('ImagePositionPatient', plan.positions[f.k], 'DS');
    it.seq('PlanePositionSequence', [pp]);
    const si = new WDataset();
    si.set('ReferencedSegmentNumber', f.segNumber, 'US');
    it.seq('SegmentIdentificationSequence', [si]);
    return it;
  }));
  // Common Instance Reference
  const refSeries = new WDataset();
  refSeries.set('SeriesInstanceUID', source.seriesUID, 'UI');
  refSeries.seq('ReferencedInstanceSequence', source.sopUIDs.map((u) => {
    const r = new WDataset();
    r.set('ReferencedSOPClassUID', source.sopClass, 'UI');
    r.set('ReferencedSOPInstanceUID', u, 'UI');
    return r;
  }));
  ds.seq('ReferencedSeriesSequence', [refSeries]);
  // Pixel data: frames concatenated, bits packed little-endian within bytes, no padding between frames
  const totalBits = frames.length * npx;
  const packed = new Uint8Array(Math.ceil(totalBits / 8) + (Math.ceil(totalBits / 8) % 2));
  let bit = 0;
  for (const f of frames) {
    for (let i = 0; i < npx; i++, bit++) if (f.bits[i]) packed[bit >> 3] |= 1 << (bit & 7);
  }
  ds.set('PixelData', packed, 'OB');
  const bytes = writePart10(ds, IMPL);
  return { files: [{ name: 'SEG_00001.dcm', bytes }], seriesUID, sopUID, frames: frames.length,
    framesPerSegment: segments.map((_, si) => frames.filter((f) => f.segNumber === si + 1).length) };
}
