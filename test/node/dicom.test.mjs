// DICOM writer / reader round trip and value formatting.
import test from 'node:test';
import assert from 'node:assert/strict';
import { WDataset, writePart10, codeItem } from '../../src/engine/dicom/write.js';
import { parseDicom, looksLikeDicom } from '../../src/engine/dicom/read.js';
import { formatDS } from '../../src/engine/dicom/values.js';
import { newUID, isValidUID, IMPLEMENTATION_CLASS_UID, IMPLEMENTATION_VERSION_NAME } from '../../src/engine/uid.js';

const impl = { implementationClassUID: IMPLEMENTATION_CLASS_UID, implementationVersionName: IMPLEMENTATION_VERSION_NAME };

test('formatDS: at most 16 characters, maximum precision kept', () => {
  const cases = [1 / 3, -123456.789012345, 1e-20, 6.02214076e23, 0.1 + 0.2, -0, 42, 2 ** 53 - 1, -0.000123456789123];
  for (const x of cases) {
    const s = formatDS(x);
    assert.ok(s.length <= 16, `${s} longer than 16`);
    assert.match(s, /^[+-]?(\d+\.?\d*|\.\d+)(E[+-]?\d+)?$/i);
    const rel = x === 0 ? Math.abs(Number(s)) : Math.abs(Number(s) - x) / Math.abs(x);
    assert.ok(rel < 1e-10, `${x} -> ${s} (rel ${rel})`);
  }
  assert.throws(() => formatDS(NaN));
  assert.throws(() => formatDS(Infinity));
});

test('UIDs: 2.25 UUID form, valid syntax, unique', () => {
  const seen = new Set();
  for (let i = 0; i < 5000; i++) {
    const u = newUID();
    assert.ok(isValidUID(u) && u.startsWith('2.25.') && u.length <= 64, u);
    seen.add(u);
  }
  assert.equal(seen.size, 5000);
  assert.ok(isValidUID(IMPLEMENTATION_CLASS_UID));
  assert.equal(isValidUID('1.2.03'), false, 'leading zero in a component is invalid');
});

test('Part 10 round trip: meta header, text, numbers, sequences, UTF-8 names, pixel data', () => {
  const ds = new WDataset();
  const sop = newUID();
  ds.set('SOPClassUID', '1.2.840.10008.5.1.4.1.1.4');
  ds.set('SOPInstanceUID', sop);
  ds.set('PatientName', 'Müller^José');
  ds.set('Modality', 'MR');
  ds.set('ImageOrientationPatient', [1, 0, 0, 0, 0.7071067811865476, -0.7071067811865476]);
  ds.set('PixelSpacing', [0.9375, 0.9375]);
  ds.set('Rows', 2, 'US'); ds.set('Columns', 3, 'US');
  ds.set('InstanceNumber', 12);
  ds.seq('AnatomicRegionSequence', [codeItem('12738006', 'SCT', 'Brain')]);
  ds.set('PixelData', new Uint8Array(new Int16Array([-5, 0, 5, 1000, -1000, 32767]).buffer), 'OW');
  const bytes = writePart10(ds, impl);
  assert.ok(looksLikeDicom(bytes));
  assert.equal(String.fromCharCode(...bytes.subarray(128, 132)), 'DICM');
  const r = parseDicom(bytes);
  assert.equal(r.meta.string('TransferSyntaxUID'), '1.2.840.10008.1.2.1');
  assert.equal(r.meta.string('MediaStorageSOPInstanceUID'), sop);
  const d = r.dataset;
  assert.equal(d.string('SpecificCharacterSet'), 'ISO_IR 192', 'non-ASCII text forces UTF-8');
  assert.equal(d.string('PatientName'), 'Müller^José');
  assert.equal(d.string('SOPInstanceUID'), sop);
  assert.deepEqual(d.numbers('ImageOrientationPatient').map((x) => Number(x.toFixed(12))), [1, 0, 0, 0, 0.707106781187, -0.707106781187]);
  assert.deepEqual(d.numbers('PixelSpacing'), [0.9375, 0.9375]);
  assert.equal(d.number('Rows'), 2);
  assert.equal(d.number('InstanceNumber'), 12);
  assert.equal(d.seq('AnatomicRegionSequence')[0].string('CodeMeaning'), 'Brain');
  const px = d.get('PixelData');
  assert.deepEqual(Array.from(new Int16Array(px.bytes.slice().buffer)), [-5, 0, 5, 1000, -1000, 32767]);
  assert.equal(bytes.length % 2, 0, 'even length');
});

test('writer refuses invalid values instead of writing a non-conformant file', () => {
  const ds = new WDataset();
  assert.throws(() => ds.set('InstanceNumber', 1.5), /IS/);
  assert.throws(() => ds.set('SliceThickness', NaN), /DS/);
  assert.throws(() => ds.set('PixelData', new Uint8Array(2)), /Ambiguous VR/, 'OB/OW must be explicit');
});
