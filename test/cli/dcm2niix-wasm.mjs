// Run the dcm2niix WebAssembly build (as used in the browser) on a folder, writing outputs to a folder.
// usage: node test/cli/dcm2niix-wasm.mjs <in_dir> <out_dir> [dcm2niix flags...]
import fs from 'node:fs'; import path from 'node:path';
import Module from '../../node_modules/@niivue/dcm2niix/dist/dcm2niix.jpeg.js';
import { Dcm2niixRunner } from '../../src/engine/dcm2niix.js';
const [, , inDir, outDir, ...flags] = process.argv;
const files = [];
const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else files.push({ name: path.relative(inDir, p).split(path.sep).join('_'), bytes: new Uint8Array(fs.readFileSync(p)) }); } };
walk(inDir);
const runner = new Dcm2niixRunner(Module, fs.readFileSync(new URL('../../node_modules/@niivue/dcm2niix/dist/dcm2niix.jpeg.wasm', import.meta.url)));
const res = await runner.run(files, flags);
fs.mkdirSync(outDir, { recursive: true });
for (const o of res.outputs) fs.writeFileSync(path.join(outDir, o.name), o.bytes);
console.log(JSON.stringify({ exitCode: res.exitCode, outputs: res.outputs.length }));
