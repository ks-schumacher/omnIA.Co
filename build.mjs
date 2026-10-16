// Build the static site into dist/ (no server code; Netlify functions live in netlify/functions).
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const out = 'dist';
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const common = { bundle: true, format: 'esm', target: ['chrome110', 'edge110', 'firefox115', 'safari16'], minify: true, sourcemap: false, legalComments: 'linked', logLevel: 'warning' };
// Node-only branches of the Emscripten glue are never executed in the browser
const external = ['module', 'fs', 'path', 'crypto', 'url', 'worker_threads', 'node:*'];
await build({ ...common, entryPoints: ['src/app/app.js'], outfile: `${out}/app.js` });
await build({ ...common, entryPoints: ['src/worker/worker.js'], outfile: `${out}/worker.js`, external });

const copy = (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); };
let html = fs.readFileSync('src/app/index.html', 'utf8');
fs.writeFileSync(`${out}/index.html`, html);
copy('src/app/styles.css', `${out}/styles.css`);
copy('src/app/favicon.svg', `${out}/favicon.svg`);
const fonts = [
  ['@fontsource/unbounded', 'unbounded-latin-500-normal.woff2'], ['@fontsource/unbounded', 'unbounded-latin-700-normal.woff2'],
  ['@fontsource/atkinson-hyperlegible', 'atkinson-hyperlegible-latin-400-normal.woff2'], ['@fontsource/atkinson-hyperlegible', 'atkinson-hyperlegible-latin-700-normal.woff2'],
  ['@fontsource/atkinson-hyperlegible', 'atkinson-hyperlegible-latin-400-italic.woff2'], ['@fontsource/atkinson-hyperlegible-mono', 'atkinson-hyperlegible-mono-latin-400-normal.woff2'],
];
for (const [pkg, f] of fonts) copy(`node_modules/${pkg}/files/${f}`, `${out}/fonts/${f}`);
copy('node_modules/@fontsource/unbounded/LICENSE', `${out}/fonts/LICENSE-Unbounded-OFL.txt`);
copy('node_modules/@fontsource/atkinson-hyperlegible/LICENSE', `${out}/fonts/LICENSE-AtkinsonHyperlegible-OFL.txt`);
copy('node_modules/@niivue/dcm2niix/dist/dcm2niix.jpeg.wasm', `${out}/vendor/dcm2niix/dcm2niix.jpeg.wasm`);
copy('node_modules/libarchive.js/dist/worker-bundle.js', `${out}/vendor/libarchive/worker-bundle.js`);
copy('node_modules/libarchive.js/dist/libarchive.wasm', `${out}/vendor/libarchive/libarchive.wasm`);
copy('node_modules/libarchive.js/LICENSE', `${out}/vendor/libarchive/LICENSE`);
copy('THIRD_PARTY_NOTICES.md', `${out}/THIRD_PARTY_NOTICES.md`);
copy('LICENSE', `${out}/LICENSE.txt`);
const size = (d) => fs.readdirSync(d, { withFileTypes: true }).reduce((a, e) => a + (e.isDirectory() ? size(path.join(d, e.name)) : fs.statSync(path.join(d, e.name)).size), 0);
console.log(`dist/ built: ${(size(out) / 1048576).toFixed(2)} MB`);
