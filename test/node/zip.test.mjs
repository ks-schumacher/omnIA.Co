// ZIP writer / reader and archive detection.
import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32, ZipWriter, readZip, sourceFromBytes } from '../../src/engine/zip.js';
import { sniffArchive, classifyEntry, expandArchive } from '../../src/engine/archive.js';

const concat = (parts) => { const n = parts.reduce((a, p) => a + p.length, 0); const o = new Uint8Array(n); let k = 0; for (const p of parts) { o.set(p, k); k += p.length; } return o; };

test('CRC-32 check value', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')) >>> 0, 0xCBF43926);
});

test('ZipWriter -> readZip round trip (stored and deflated, UTF-8 names), CRC verified', async () => {
  const z = new ZipWriter();
  const files = {
    'a/readme.txt': new TextEncoder().encode('hello'),
    'série/ç.bin': Uint8Array.from({ length: 10000 }, (_, i) => i % 7),
    'big.raw': Uint8Array.from({ length: 200000 }, (_, i) => (i * 2654435761) >>> 24),
  };
  for (const [p, b] of Object.entries(files)) await z.add(p, b, { compress: p !== 'big.raw' });
  const { parts } = z.finish();
  const bytes = concat(parts.map((p) => (p instanceof Uint8Array ? p : new Uint8Array(p))));
  assert.equal(sniffArchive(bytes.subarray(0, 512), 'x.zip'), 'zip');
  const entries = await readZip(sourceFromBytes(bytes));
  assert.deepEqual(entries.map((e) => e.path).sort(), Object.keys(files).sort());
  for (const e of entries) assert.deepEqual(await e.getBytes(), files[e.path]);
  // corrupt one byte of stored data: the CRC check must fail
  const bad = bytes.slice();
  const stored = entries.find((e) => e.path === 'big.raw');
  bad[bad.length - 1000 - stored.size + 5000] ^= 0xff;
  const e2 = (await readZip(sourceFromBytes(bad))).find((e) => e.path === 'big.raw');
  await assert.rejects(() => e2.getBytes(), /CRC-32 mismatch/);
});

test('nested archives are expanded and junk entries dropped', async () => {
  const inner = new ZipWriter();
  await inner.add('s1/IM0001.dcm', new Uint8Array(200));
  const innerBytes = concat(inner.finish().parts.map((p) => new Uint8Array(p)));
  const outer = new ZipWriter();
  await outer.add('exam/inner.zip', innerBytes);
  await outer.add('__MACOSX/._x', new Uint8Array(4));
  await outer.add('exam/.DS_Store', new Uint8Array(4));
  const outerBytes = concat(outer.finish().parts.map((p) => new Uint8Array(p)));
  const r = await expandArchive(outerBytes, 'exam.zip');
  assert.deepEqual(r.entries.map((e) => e.path), ['exam.zip/exam/inner.zip/s1/IM0001.dcm']);
  assert.equal(r.containers.length, 2);
});

test('archive sniffing by magic number, gzipped NIfTI is not an archive', () => {
  const pad = (a) => { const u = new Uint8Array(512); u.set(a); return u; };
  assert.equal(sniffArchive(pad([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]), 'a.rar'), 'rar');
  assert.equal(sniffArchive(pad([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]), 'a.7z'), '7z');
  assert.equal(sniffArchive(pad([0x1f, 0x8b, 8]), 'brain.nii.gz'), null);
  assert.equal(sniffArchive(pad([0x1f, 0x8b, 8]), 'exam.tar.gz'), 'tar.gz');
});

test('entry classification', () => {
  assert.equal(classifyEntry('x/DICOMDIR', null), 'dicomdir');
  assert.equal(classifyEntry('x/t1.nii.gz', null), 'nifti');
  assert.equal(classifyEntry('x/dwi.bvec', null), 'bvec');
  const dcm = new Uint8Array(200); dcm.set([0x44, 0x49, 0x43, 0x4d], 128);
  assert.equal(classifyEntry('x/IM0001', dcm), 'dicom');
});
