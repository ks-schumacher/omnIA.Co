// De-identification following the intent of DICOM PS3.15 Annex E (Basic Application Level
// Confidentiality Profile) with the Retain Patient Characteristics, Retain Longitudinal Temporal
// Information (Modified Dates) and Clean Descriptors options, plus consistent batch pseudonyms.
import { newUID } from './uid.js';

export const DEID_CODES = {
  BASIC: ['113100', 'DCM', 'Basic Application Confidentiality Profile'],
  CLEAN_RECOGNIZABLE_VISUAL: ['113102', 'DCM', 'Clean Recognizable Visual Features Option'],
  CLEAN_DESCRIPTORS: ['113105', 'DCM', 'Clean Descriptors Option'],
  RETAIN_FULL_DATES: ['113106', 'DCM', 'Retain Longitudinal Temporal Information Full Dates Option'],
  RETAIN_MODIFIED_DATES: ['113107', 'DCM', 'Retain Longitudinal Temporal Information Modified Dates Option'],
  RETAIN_PATIENT_CHARACTERISTICS: ['113108', 'DCM', 'Retain Patient Characteristics Option'],
};

function normalizeText(s) {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
}

export class IdentityContext {
  /**
   * @param {{anonymize:boolean, pseudonymPrefix:string, dates:'remove'|'shift'|'keep',
   *          retainPatientCharacteristics:boolean, keepDescriptions:boolean}} settings
   */
  constructor(settings) {
    this.s = settings;
    this.patients = new Map(); // key -> { pseudo, offsetDays, original }
    this.uidMap = new Map();
    this.n = 0;
  }
  get anonymize() { return !!this.s.anonymize; }

  /** Get (or create) the pseudonymous identity for an original patient key. */
  patient(key, original = {}) {
    const k = key || '__unknown__';
    let p = this.patients.get(k);
    if (!p) {
      this.n += 1;
      const pseudo = `${this.s.pseudonymPrefix || 'OMNIA'}-${String(this.n).padStart(4, '0')}`;
      let offsetDays = 0;
      if (this.s.dates === 'shift') {
        const r = new Uint32Array(1);
        globalThis.crypto.getRandomValues(r);
        offsetDays = -(365 + (r[0] % 3286)); // shift 1 to 10 years into the past, per patient
      }
      p = { pseudo, offsetDays, original: { ...original }, exams: [] };
      this.patients.set(k, p);
    }
    return p;
  }

  uid(original) {
    if (!this.anonymize || !original) return original || newUID();
    let u = this.uidMap.get(original);
    if (!u) { u = newUID(); this.uidMap.set(original, u); }
    return u;
  }

  /** Transform a DA value ('YYYYMMDD') for a patient. Returns '' when removed. */
  date(da, patient) {
    if (!da) return '';
    if (!this.anonymize || this.s.dates === 'keep') return da;
    if (this.s.dates === 'remove') return '';
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(da);
    if (!m) return '';
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    d.setUTCDate(d.getUTCDate() + patient.offsetDays);
    return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  }
  time(tm) {
    if (!tm) return '';
    if (!this.anonymize || this.s.dates !== 'remove') return tm;
    return '';
  }
  /** ISO date-time (BIDS 'YYYY-MM-DDThh:mm:ss') transform. */
  isoDateTime(s, patient) {
    if (!s) return undefined;
    if (!this.anonymize || this.s.dates === 'keep') return s;
    if (this.s.dates === 'remove') return undefined;
    const m = /^(\d{4})-(\d{2})-(\d{2})(.*)$/.exec(s);
    if (!m) return undefined;
    const da = this.date(`${m[1]}${m[2]}${m[3]}`, patient);
    return `${da.slice(0, 4)}-${da.slice(4, 6)}-${da.slice(6, 8)}${m[4]}`;
  }

  /** Identifier tokens used to scrub free-text descriptors. */
  identifierTokens(original) {
    const toks = new Set();
    const add = (s, min = 3) => {
      for (const t of normalizeText(s).split(/[^A-Z0-9]+/)) if (t.length >= min) toks.add(t);
    };
    // every identity present in the exam (an archive may mix patients): descriptors are scrubbed against all of them
    for (const o of [original, ...(original.others || [])]) {
      if (o.PatientName) add(o.PatientName.replace(/\^/g, ' '));
      if (o.PatientID) add(o.PatientID, 4);
      if (o.AccessionNumber) add(o.AccessionNumber, 4);
      if (o.PatientBirthDate) toks.add(o.PatientBirthDate);
    }
    return toks;
  }

  /** Clean a descriptor: '' if removed, the text otherwise. */
  descriptor(text, original) {
    if (!text) return '';
    if (!this.anonymize) return text;
    if (!this.s.keepDescriptions) return '';
    const toks = this.identifierTokens(original || {});
    const words = new Set(normalizeText(text).split(/[^A-Z0-9]+/).filter(Boolean));
    for (const t of toks) {
      if (words.has(t)) return '';
      if (/^\d{8}$/.test(t) && normalizeText(text).includes(t)) return '';
    }
    return text;
  }

  /** Rows of the (sensitive) correspondence table, written only to the user's local folder. */
  mappingRows() {
    const rows = [];
    for (const [key, p] of this.patients) {
      rows.push({ pseudonym: p.pseudo, original_patient_id: p.original.PatientID || '', original_patient_name: p.original.PatientName || '',
        source_key: key.startsWith('exam:') ? key.slice(5) : '', date_shift_days: this.s.dates === 'shift' ? p.offsetDays : '',
        exams: p.exams.join(' | '),
        other_patient_ids_in_same_archive: [...new Set((p.original.others || []).map((o) => o.PatientID || o.PatientName || '').filter((x) => x && x !== (p.original.PatientID || p.original.PatientName)))].join(' | ') });
    }
    return rows;
  }
}

// --- BIDS sidecar (dcm2niix JSON) cleaning -------------------------------------------------

const REMOVE_ALWAYS = new Set([
  'PatientName', 'PatientID', 'PatientBirthDate', 'OtherPatientIDs', 'OtherPatientNames', 'PatientComments', 'PatientAddress',
  'PatientTelephoneNumbers', 'PatientMotherBirthName', 'MilitaryRank', 'EthnicGroup', 'PatientReligiousPreference',
  'AccessionNumber', 'StudyID', 'ReferringPhysicianName', 'PerformingPhysicianName', 'NameOfPhysiciansReadingStudy',
  'OperatorsName', 'RequestingPhysician', 'PhysiciansOfRecord', 'InstitutionName', 'InstitutionalDepartmentName',
  'InstitutionAddress', 'StationName', 'DeviceSerialNumber', 'ProcedureStepDescription', 'PerformedProcedureStepDescription',
  'RequestedProcedureDescription', 'ImageComments', 'StudyComments', 'AdditionalPatientHistory', 'RequestAttributesSequence',
  'StudyInstanceUID', 'SeriesInstanceUID', 'FrameOfReferenceUID', 'SOPInstanceUID', 'ReferencedSOPInstanceUID',
  'DeidentificationMethod', 'DeidentificationMethodCodeSequence', 'PatientIdentityRemoved', 'IssuerOfPatientID',
  'ResponsiblePerson', 'ResponsibleOrganization', 'DetectorID', 'GantryID', 'PlateID', 'CassetteID', 'UniqueDeviceIdentifier',
  'WipMemBlock',
]);
const PATIENT_CHARACTERISTICS = new Set(['PatientSex', 'PatientAge', 'PatientWeight', 'PatientSize']);
const DATE_KEYS = new Set(['AcquisitionDateTime', 'AcquisitionDate', 'StudyDate', 'SeriesDate', 'ContentDate', 'InstanceCreationDate', 'PatientBirthDate']);
const TIME_KEYS = new Set(['AcquisitionTime', 'StudyTime', 'SeriesTime', 'ContentTime', 'InstanceCreationTime']);
const DESCRIPTOR_KEYS = new Set(['StudyDescription', 'SeriesDescription', 'ProtocolName']);
// technical keys that contain suspicious substrings but are not identifying
const TECHNICAL_ALLOW = new Set([
  'ManufacturersModelName', 'SequenceName', 'ReceiveCoilName', 'TransmitCoilName', 'CoilString', 'ConversionSoftware',
  'ConversionSoftwareVersion', 'SoftwareVersions', 'PulseSequenceName', 'ScanningSequence', 'BodyPartExamined', 'BodyPart',
  'ProtocolName', 'SeriesDescription', 'StudyDescription', 'ImageType', 'AcquisitionTime', 'AcquisitionDateTime',
  'NonlinearGradientCorrection', 'CoilCombinationMethod',
]);
const SUSPICIOUS = /(Name|Address|Birth|Physician|Operator|Institution|Station|Serial|Accession|Comment|Date|PatientID|UID|Telephone|Identifier)/i;

/**
 * Clean a dcm2niix BIDS sidecar object in place according to the identity settings.
 * Returns { json, removed: string[] }.
 */
export function cleanSidecar(json, idctx, patient, original) {
  if (!idctx.anonymize) return { json, removed: [] };
  const removed = [];
  const out = {};
  for (const [k, v] of Object.entries(json)) {
    if (REMOVE_ALWAYS.has(k)) { removed.push(k); continue; }
    if (PATIENT_CHARACTERISTICS.has(k)) {
      if (idctx.s.retainPatientCharacteristics) out[k] = v; else removed.push(k);
      continue;
    }
    if (DATE_KEYS.has(k)) {
      if (k === 'PatientBirthDate') { removed.push(k); continue; }
      const t = typeof v === 'string' && v.includes('-') ? idctx.isoDateTime(v, patient) : idctx.date(String(v), patient);
      if (t) out[k] = t; else removed.push(k);
      continue;
    }
    if (TIME_KEYS.has(k)) {
      if (idctx.s.dates === 'remove') removed.push(k); else out[k] = v;
      continue;
    }
    if (DESCRIPTOR_KEYS.has(k)) {
      const c = idctx.descriptor(String(v), original);
      if (c) out[k] = c; else removed.push(k);
      continue;
    }
    if (SUSPICIOUS.test(k) && !TECHNICAL_ALLOW.has(k)) { removed.push(k); continue; }
    out[k] = v;
  }
  return { json: out, removed };
}

/** Remove the acquisition time-of-day token from a dcm2niix NIfTI descrip ('TE=..;Time=hhmmss;...'). */
export function cleanNiftiDescrip(descrip, idctx) {
  if (!idctx.anonymize || idctx.s.dates !== 'remove') return descrip;
  return descrip.split(';').filter((t) => !/^\s*Time=/i.test(t)).join(';');
}
