// De-identification: pseudonyms, dates, descriptor scrubbing, sidecar cleaning.
import test from 'node:test';
import assert from 'node:assert/strict';
import { IdentityContext, cleanSidecar, cleanNiftiDescrip } from '../../src/engine/anon.js';

const base = { anonymize: true, pseudonymPrefix: 'STUDY', dates: 'remove', retainPatientCharacteristics: true, keepDescriptions: true };

test('pseudonyms are sequential and consistent per patient across the batch', () => {
  const id = new IdentityContext(base);
  const a = id.patient('id:123', { PatientID: '123' });
  const b = id.patient('id:456', { PatientID: '456' });
  const a2 = id.patient('id:123', { PatientID: '123' });
  assert.equal(a.pseudo, 'STUDY-0001'); assert.equal(b.pseudo, 'STUDY-0002'); assert.equal(a2, a);
});

test('UIDs are replaced consistently (same original -> same new UID)', () => {
  const id = new IdentityContext(base);
  const u = id.uid('1.2.3.4'); assert.equal(id.uid('1.2.3.4'), u); assert.notEqual(u, '1.2.3.4');
  assert.notEqual(id.uid('1.2.3.5'), u);
});

test('date shift is per patient, stays within 1-10 years in the past, and is reversible from the map', () => {
  const id = new IdentityContext({ ...base, dates: 'shift' });
  const p = id.patient('id:1', { PatientID: '1' });
  assert.ok(p.offsetDays <= -365 && p.offsetDays >= -3650);
  const d = id.date('20200229', p);
  const back = new Date(Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8)));
  back.setUTCDate(back.getUTCDate() - p.offsetDays);
  assert.equal(back.toISOString().slice(0, 10), '2020-02-29');
  assert.equal(id.date('20200229', p), d, 'deterministic for the same patient');
  const iso = id.isoDateTime('2020-02-29T10:11:12.5', p);
  assert.equal(iso.slice(0, 10), `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`); assert.ok(iso.endsWith('T10:11:12.5'));
});

test('dates removed by default', () => {
  const id = new IdentityContext(base);
  const p = id.patient('x');
  assert.equal(id.date('20200101', p), ''); assert.equal(id.isoDateTime('2020-01-01T00:00:00', p), undefined);
});

test('descriptors containing a name, ID or birth date are dropped; every identity in the archive counts', () => {
  const id = new IdentityContext(base);
  const original = { PatientName: 'SILVA^MARIA', PatientID: 'HC778899', PatientBirthDate: '19800101',
    others: [{ PatientName: 'fMRI', PatientID: 'fMRI' }] };
  assert.equal(id.descriptor('T1 MPRAGE', original), 'T1 MPRAGE');
  assert.equal(id.descriptor('maria silva T1', original), '');
  assert.equal(id.descriptor('Exam HC778899', original), '');
  assert.equal(id.descriptor('born 19800101', original), '');
  assert.equal(id.descriptor('fMRI Multiphase', original), '', 'name of a second patient in the same archive');
  assert.equal(id.descriptor('DWI', original), 'DWI', 'tokens shorter than 3 characters are not used');
  const noDesc = new IdentityContext({ ...base, keepDescriptions: false });
  assert.equal(noDesc.descriptor('T1 MPRAGE', original), '');
});

test('sidecar cleaning removes identifiers, keeps acquisition parameters', () => {
  const id = new IdentityContext(base);
  const p = id.patient('k');
  const original = { PatientName: 'DOE^JOHN', PatientID: 'X1' };
  const j = { PatientName: 'DOE^JOHN', PatientID: 'X1', InstitutionName: 'General Hospital', StationName: 'MR1', DeviceSerialNumber: '42',
    AcquisitionDateTime: '2021-03-04T10:00:00', AcquisitionTime: '10:00:00', SeriesDescription: 'T2 john', ProtocolName: 'T2 TSE',
    RepetitionTime: 3.2, EchoTime: 0.08, SequenceName: '*tse2d1', ManufacturersModelName: 'Prisma', PatientSex: 'F', PatientWeight: 60,
    ReferringPhysicianName: 'Dr X', MyPrivateInstitutionAddress: 'street', StudyInstanceUID: '1.2.3' };
  const { json, removed } = cleanSidecar(j, id, p, original);
  for (const k of ['PatientName', 'PatientID', 'InstitutionName', 'StationName', 'DeviceSerialNumber', 'AcquisitionDateTime', 'AcquisitionTime',
    'SeriesDescription', 'ReferringPhysicianName', 'MyPrivateInstitutionAddress', 'StudyInstanceUID']) {
    assert.ok(!(k in json), `${k} should be removed`); assert.ok(removed.includes(k));
  }
  for (const k of ['ProtocolName', 'RepetitionTime', 'EchoTime', 'SequenceName', 'ManufacturersModelName', 'PatientSex', 'PatientWeight']) assert.ok(k in json, `${k} kept`);
  const noChar = new IdentityContext({ ...base, retainPatientCharacteristics: false });
  const c2 = cleanSidecar(j, noChar, noChar.patient('k'), original).json;
  assert.ok(!('PatientSex' in c2) && !('PatientWeight' in c2));
});

test('anonymisation off leaves the sidecar untouched', () => {
  const id = new IdentityContext({ ...base, anonymize: false });
  const j = { PatientName: 'A' };
  assert.deepEqual(cleanSidecar(j, id, id.patient('k'), {}).json, j);
});

test('acquisition time is removed from the NIfTI descrip when dates are removed', () => {
  const id = new IdentityContext(base);
  assert.equal(cleanNiftiDescrip('TE=30;Time=101112.500;phase=1', id), 'TE=30;phase=1');
});

test('the pseudonym map lists other patients found in the same archive', () => {
  const id = new IdentityContext(base);
  id.patient('id:A', { PatientID: 'A', others: [{ PatientID: 'A' }, { PatientID: 'B' }] });
  const rows = id.mappingRows();
  assert.equal(rows[0].original_patient_id, 'A'); assert.equal(rows[0].other_patient_ids_in_same_archive, 'B');
});
