// Node CLI running the same exam pipeline as the browser worker (for validation).
// usage: node test/cli/exam.mjs <archive-or-file> <outdir> [--direction dcm2nii|nii2dcm] [--set key=value ...]
import fs from 'node:fs'; import path from 'node:path';
import Module from '../../node_modules/@niivue/dcm2niix/dist/dcm2niix.jpeg.js';
import { Archive } from '../../node_modules/libarchive.js/dist/libarchive-node.mjs';
import { Dcm2niixRunner } from '../../src/engine/dcm2niix.js';
import { setLibarchiveAdapter, makeLibarchiveAdapter } from '../../src/engine/archive.js';
import { processExam, DEFAULT_SETTINGS } from '../../src/engine/exam.js';
import { IdentityContext } from '../../src/engine/anon.js';

const args = process.argv.slice(2);
const input = args[0], outDir = args[1];
const settings = structuredClone(DEFAULT_SETTINGS);
for (let i = 2; i < args.length; i++) {
  if (args[i] === '--direction') settings.direction = args[++i];
  if (args[i] === '--set') {
    const [k, v] = args[++i].split('=');
    const val = v === 'true' ? true : v === 'false' ? false : /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
    if (k.includes('.')) { const [a, b] = k.split('.'); settings[a][b] = val; } else settings[k] = val;
  }
}
setLibarchiveAdapter(makeLibarchiveAdapter(Archive));
const wasm = fs.readFileSync(new URL('../../node_modules/@niivue/dcm2niix/dist/dcm2niix.jpeg.wasm', import.meta.url));
const runner = new Dcm2niixRunner(Module, wasm);
const idctx = new IdentityContext(settings);
const t0 = Date.now();
const res = await processExam({ name: path.basename(input), input: new Uint8Array(fs.readFileSync(input)) }, settings, { idctx, runner }, (p) => { if (process.env.VERBOSE) console.error(p.stage, Math.round(p.pct), p.message || ''); });
for (const o of res.outputs) { const p = path.join(outDir, o.path); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, o.bytes); }
const summary = { status: res.status, outRoot: res.outRoot, outputs: res.outputs.length, errors: res.errors, warnings: res.warnings, ignored: res.ignored.slice(0, 5), ms: Date.now() - t0,
  series: res.series.map((s) => ({ input: s.input, status: s.status, verification: s.verification, outputs: s.outputs, notes: s.notes, warnings: s.warnings.slice(0, 3) })),
  mapping: idctx.mappingRows(), qc: res.qc.map((q) => q.kind + ':' + q.label) };
console.log(JSON.stringify(summary, null, 1));
