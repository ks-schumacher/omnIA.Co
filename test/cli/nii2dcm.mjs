// Minimal CLI around the engine for validation runs (Node).
import fs from 'node:fs'; import path from 'node:path';
import { readNifti, chooseAffine } from '../../src/engine/nifti.js';
import { assembleMeta } from '../../src/engine/meta.js';
import { IdentityContext } from '../../src/engine/anon.js';
import { buildImageSeries, resolveIdentity, bvecToPatient } from '../../src/engine/nii2dcm.js';
import { verifyImageSeries } from '../../src/engine/verify.js';
import { newUID } from '../../src/engine/uid.js';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const flag = (k) => args.includes(k);
const inFile = args[0], outDir = args[1];
const vol = readNifti(new Uint8Array(fs.readFileSync(inFile)));
const sidecarPath = opt('--json');
const sidecar = sidecarPath ? JSON.parse(fs.readFileSync(sidecarPath, 'utf8')) : null;
const settings = { anonymize: flag('--anon'), pseudonymPrefix: 'OMNIA', dates: opt('--dates', 'remove'), retainPatientCharacteristics: true,
  keepDescriptions: true, defaultModality: opt('--modality', 'MR'), valuePolicy: flag('--quantize') ? 'quantize' : 'lossless' };
const idctx = new IdentityContext(settings);
const stem = path.basename(inFile).replace(/\.nii(\.gz)?$/, '');
const meta = assembleMeta({ sidecar, settings, examKey: 'test', stem });
const id = resolveIdentity(meta, idctx, 'test', { fallbackPatientID: 'TEST' });
const aff = chooseAffine(vol.header, opt('--priority', 'sform'));
let dwi = null;
if (opt('--bval')) {
  const bvals = fs.readFileSync(opt('--bval'), 'utf8').trim().split(/\s+/).map(Number);
  const rowsB = fs.readFileSync(opt('--bvec'), 'utf8').trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number));
  const gradients = bvals.map((_, t) => bvecToPatient([rowsB[0][t], rowsB[1][t], rowsB[2][t]], aff.affine));
  dwi = { bvals, gradients };
}
const t0 = Date.now();
const res = buildImageSeries({ vol, affine: aff.affine, affineSource: aff.source, meta, id, seriesNumber: 1, forUID: newUID(), settings, dwi, seriesDescription: stem });
const t1 = Date.now();
fs.mkdirSync(outDir, { recursive: true });
for (const f of res.files) fs.writeFileSync(path.join(outDir, f.name), f.bytes);
const v = verifyImageSeries(res.files, vol, aff.affine, res.enc);
const t2 = Date.now();
console.log(JSON.stringify({ files: res.files.length, plane: res.plan.plane, matched: res.plan.matchedReference, tilted: res.plan.tilted,
  enc: res.enc.description, mode: res.enc.mode, verify: { ok: v.ok, checked: v.checkedVoxels, expected: v.expectedVoxels, maxAbsDiff: v.maxAbsDiff, maxIndexErr: v.maxIndexErr, issues: v.issues.slice(0, 5) },
  ms: { build: t1 - t0, verify: t2 - t1 } }));
