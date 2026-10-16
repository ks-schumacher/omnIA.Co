// Metadata assembly for NIfTI -> DICOM, with explicit provenance of every group of attributes.
// Priority: A) reference DICOM of the same exam, B) BIDS sidecar (dcm2niix JSON), C) user CSV, D) defaults.

const s = (v) => (v === undefined || v === null ? '' : String(v));

export function toCS(v) {
  const t = s(v).toUpperCase().replace(/[^A-Z0-9 _]/g, '_').trim();
  return t.slice(0, 16);
}
export function toLO(v) { return s(v).replace(/\\/g, '/').replace(/[\x00-\x1F]/g, ' ').trim().slice(0, 64); }
export function toSH(v) { return s(v).replace(/\\/g, '/').replace(/[\x00-\x1F]/g, ' ').trim().slice(0, 16); }
export function toPN(v) { return s(v).replace(/\\/g, ' ').replace(/[\x00-\x1F]/g, ' ').trim().slice(0, 64); }
export function toDA(v) {
  const t = s(v).replace(/-/g, '');
  return /^\d{8}$/.test(t) ? t : '';
}
export function toTM(v) {
  const t = s(v).replace(/:/g, '');
  return /^\d{2}(\d{2}(\d{2}(\.\d{1,6})?)?)?$/.test(t) ? t : '';
}
export function toAS(v) {
  const t = s(v).toUpperCase();
  if (/^\d{3}[DWMY]$/.test(t)) return t;
  if (/^\d{1,3}$/.test(t)) return `${t.padStart(3, '0')}Y`;
  return '';
}
export function toSex(v) {
  const t = s(v).toUpperCase();
  return t === 'M' || t === 'F' || t === 'O' ? t : '';
}
function num(v) { const x = typeof v === 'number' ? v : parseFloat(v); return Number.isFinite(x) ? x : undefined; }
function multiCS(v) {
  if (v === undefined || v === null || v === '') return [];
  const arr = Array.isArray(v) ? v : String(v).split('\\');
  return arr.map(toCS).filter(Boolean);
}

const PATIENT_KEYS = ['PatientName', 'PatientID', 'PatientBirthDate', 'PatientSex', 'PatientAge', 'PatientSize', 'PatientWeight'];

/**
 * @param {object} p
 * @param {import('./dicom/read.js').Dataset} [p.refDs] reference dataset (any instance of the exam)
 * @param {object} [p.refSeriesDs] dataset of the grid-matched reference series (for acquisition params)
 * @param {object} [p.sidecar] parsed BIDS JSON
 * @param {object} [p.csvRow] user metadata row
 * @param {object} p.settings batch settings
 * @param {string} p.examKey archive name
 * @param {string} p.stem NIfTI filename stem
 */
export function assembleMeta({ refDs, refSeriesDs, sidecar, csvRow, settings, examKey, stem }) {
  const sc = sidecar || {};
  const csv = csvRow || {};
  const prov = {};
  const pick = (group, ...cands) => {
    for (const [src, val] of cands) {
      if (val !== undefined && val !== null && val !== '') { prov[group] = prov[group] || src; return val; }
    }
    return '';
  };

  // ---- Patient
  const patient = {};
  const fromRef = (k) => (refDs ? refDs.string(k) : '');
  for (const k of PATIENT_KEYS) {
    patient[k] = pick('patient', ['reference', fromRef(k)], ['sidecar', sc[k]], ['csv', csv[k]]);
  }
  patient.PatientName = toPN(patient.PatientName);
  patient.PatientID = toLO(patient.PatientID);
  patient.PatientBirthDate = toDA(patient.PatientBirthDate);
  patient.PatientSex = toSex(patient.PatientSex);
  patient.PatientAge = toAS(patient.PatientAge);
  const size = num(patient.PatientSize), weight = num(patient.PatientWeight);
  patient.PatientSize = size !== undefined && size > 0 && size < 3 ? size : '';
  patient.PatientWeight = weight !== undefined && weight > 0 && weight < 500 ? weight : '';
  prov.patient = prov.patient || 'none';

  const original = {
    PatientName: patient.PatientName, PatientID: patient.PatientID, PatientBirthDate: patient.PatientBirthDate,
    AccessionNumber: refDs ? refDs.string('AccessionNumber') : '',
  };
  const patientKey = patient.PatientID ? `id:${patient.PatientID}` : patient.PatientName ? `name:${patient.PatientName}` : `exam:${examKey}`;

  // ---- Study
  const acqDate = sc.AcquisitionDateTime ? toDA(String(sc.AcquisitionDateTime).slice(0, 10)) : '';
  const study = {
    StudyInstanceUID: refDs ? refDs.string('StudyInstanceUID') : '',
    StudyDate: toDA(pick('studyDate', ['reference', fromRef('StudyDate')], ['csv', csv.StudyDate], ['sidecar', acqDate])),
    StudyTime: toTM(refDs ? refDs.string('StudyTime') : ''),
    StudyID: toSH(refDs ? refDs.string('StudyID') : ''),
    AccessionNumber: toSH(original.AccessionNumber),
    StudyDescription: toLO(pick('studyDescription', ['reference', fromRef('StudyDescription')], ['csv', csv.StudyDescription], ['sidecar', sc.StudyDescription])),
    ReferringPhysicianName: toPN(refDs ? refDs.string('ReferringPhysicianName') : ''),
  };
  prov.study = refDs ? 'reference' : csvRow ? 'csv' : sidecar ? 'sidecar' : 'generated';

  // ---- Series / modality
  const refSer = refSeriesDs || null;
  let modality = toCS(pick('modality',
    ['reference', refSer ? refSer.string('Modality') : ''],
    ['sidecar', sc.Modality], ['csv', csv.Modality],
    ['reference', refDs ? refDs.string('Modality') : ''],
    ['default', settings.defaultModality]));
  if (modality !== 'CT' && modality !== 'MR') {
    throw new Error(`Modality "${modality}" is outside OMNIA's scope (CT and MR only)`);
  }
  const series = {
    Modality: modality,
    SeriesDescription: toLO(sc.SeriesDescription || (refSer ? refSer.string('SeriesDescription') : '') || stem),
    BodyPartExamined: toCS(pick('bodyPart', ['reference', refSer ? refSer.string('BodyPartExamined') : ''], ['sidecar', sc.BodyPartExamined || sc.BodyPart], ['csv', csv.BodyPartExamined])),
    ProtocolName: toLO(sc.ProtocolName || (refSer ? refSer.string('ProtocolName') : '')),
    PatientPosition: toCS(pick('patientPosition', ['reference', refSer ? refSer.string('PatientPosition') : ''], ['sidecar', sc.PatientPosition])),
    OriginalSeriesNumber: num(sc.SeriesNumber) ?? (refSer ? refSer.number('SeriesNumber') : undefined),
  };

  // ---- Source (acquisition) equipment
  const srcEq = {
    Manufacturer: toLO(refSer ? refSer.string('Manufacturer') : sc.Manufacturer),
    ManufacturerModelName: toLO(refSer ? refSer.string('ManufacturerModelName') : sc.ManufacturersModelName),
    SoftwareVersions: toLO(refSer ? refSer.string('SoftwareVersions') : sc.SoftwareVersions),
    DeviceSerialNumber: toLO(refSer ? refSer.string('DeviceSerialNumber') : sc.DeviceSerialNumber),
    InstitutionName: toLO(refSer ? refSer.string('InstitutionName') : sc.InstitutionName),
    StationName: toSH(refSer ? refSer.string('StationName') : sc.StationName),
  };

  // ---- Acquisition parameters (units: DICOM ms; BIDS seconds)
  const mr = {}, ct = {};
  if (modality === 'MR') {
    if (refSer) {
      mr.ScanningSequence = refSer.strings('ScanningSequence').map(toCS).filter(Boolean);
      mr.SequenceVariant = refSer.strings('SequenceVariant').map(toCS).filter(Boolean);
      mr.ScanOptions = refSer.strings('ScanOptions').map(toCS).filter(Boolean);
      mr.MRAcquisitionType = toCS(refSer.string('MRAcquisitionType'));
      mr.SequenceName = toSH(refSer.string('SequenceName'));
      mr.RepetitionTime = refSer.number('RepetitionTime');
      mr.EchoTime = refSer.number('EchoTime');
      mr.InversionTime = refSer.number('InversionTime');
      mr.FlipAngle = refSer.number('FlipAngle');
      mr.EchoTrainLength = refSer.number('EchoTrainLength');
      mr.MagneticFieldStrength = refSer.number('MagneticFieldStrength');
      mr.ImagingFrequency = refSer.number('ImagingFrequency');
      mr.PixelBandwidth = refSer.number('PixelBandwidth');
      prov.acquisition = 'reference';
    } else if (sidecar) {
      mr.ScanningSequence = multiCS(sc.ScanningSequence);
      mr.SequenceVariant = multiCS(sc.SequenceVariant);
      mr.ScanOptions = multiCS(sc.ScanOptions);
      mr.MRAcquisitionType = toCS(sc.MRAcquisitionType);
      mr.SequenceName = toSH(sc.SequenceName);
      if (num(sc.RepetitionTime) !== undefined) mr.RepetitionTime = num(sc.RepetitionTime) * 1000;
      if (num(sc.EchoTime) !== undefined) mr.EchoTime = num(sc.EchoTime) * 1000;
      if (num(sc.InversionTime) !== undefined) mr.InversionTime = num(sc.InversionTime) * 1000;
      mr.FlipAngle = num(sc.FlipAngle);
      mr.EchoTrainLength = num(sc.EchoTrainLength);
      mr.MagneticFieldStrength = num(sc.MagneticFieldStrength);
      mr.ImagingFrequency = num(sc.ImagingFrequency);
      mr.PixelBandwidth = num(sc.PixelBandwidth);
      prov.acquisition = 'sidecar';
    } else prov.acquisition = 'none';
    if (!mr.ScanningSequence || !mr.ScanningSequence.length) mr.ScanningSequence = ['RM']; // Research Mode: unknown sequence
    if (!mr.SequenceVariant || !mr.SequenceVariant.length) mr.SequenceVariant = ['NONE'];
  } else {
    if (refSer) {
      ct.KVP = refSer.number('KVP');
      ct.ConvolutionKernel = refSer.strings('ConvolutionKernel').map(toSH).filter(Boolean);
      ct.XRayTubeCurrent = refSer.number('XRayTubeCurrent');
      ct.ExposureTime = refSer.number('ExposureTime');
      ct.Exposure = refSer.number('Exposure');
      prov.acquisition = 'reference';
    } else if (sidecar) {
      ct.ConvolutionKernel = sc.ConvolutionKernel ? [toSH(sc.ConvolutionKernel)] : [];
      ct.XRayTubeCurrent = num(sc.XRayTubeCurrent);
      if (num(sc.ExposureTime) !== undefined) ct.ExposureTime = Math.round(num(sc.ExposureTime) * 1000);
      ct.Exposure = num(sc.XRayExposure);
      prov.acquisition = 'sidecar';
    } else prov.acquisition = 'none';
  }

  let sliceThickness = '';
  if (refSer && refSer.number('SliceThickness') > 0) sliceThickness = refSer.number('SliceThickness');
  else if (num(sc.SliceThickness) > 0) sliceThickness = num(sc.SliceThickness);

  let window = null;
  if (refSer && refSer.has('WindowCenter') && refSer.has('WindowWidth')) {
    const c = refSer.numbers('WindowCenter')[0], w = refSer.numbers('WindowWidth')[0];
    if (Number.isFinite(c) && w > 0) window = [c, w];
  }

  return {
    original, patientKey, patient, study, series, sourceEquipment: srcEq, mr, ct, sliceThickness, window,
    frameOfReferenceUID: refSer ? refSer.string('FrameOfReferenceUID') : (refDs ? refDs.string('FrameOfReferenceUID') : ''),
    positionReferenceIndicator: refSer ? toLO(refSer.string('PositionReferenceIndicator')) : '',
    provenance: prov,
  };
}
