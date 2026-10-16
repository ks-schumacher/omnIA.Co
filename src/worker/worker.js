// OMNIA processing worker: runs entirely inside the browser tab (no network access is needed or used
// for exam data). One exam at a time; the identity context (pseudonyms, UID map) spans the batch.
import Dcm2niixModule from '../../node_modules/@niivue/dcm2niix/dist/dcm2niix.jpeg.js';
import { Archive } from 'libarchive.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { Dcm2niixRunner } from '../engine/dcm2niix.js';
import { setLibarchiveAdapter, makeLibarchiveAdapter } from '../engine/archive.js';
import { processExam } from '../engine/exam.js';
import { IdentityContext } from '../engine/anon.js';
import { ZipWriter } from '../engine/zip.js';
import { OMNIA_VERSION } from '../engine/uid.js';

let runner = null;
let idctx = null;
let csvIndex = null;

async function init(base) {
  if (runner) return;
  const wasm = new Uint8Array(await (await fetch(new URL('vendor/dcm2niix/dcm2niix.jpeg.wasm', base))).arrayBuffer());
  runner = new Dcm2niixRunner(Dcm2niixModule, wasm);
  Archive.init({ workerUrl: new URL('vendor/libarchive/worker-bundle.js', base).href });
  setLibarchiveAdapter(makeLibarchiveAdapter(Archive));
}

async function hashBlob(blob, onPct) {
  const h = sha256.create();
  const step = 8 * 1024 * 1024;
  for (let o = 0; o < blob.size; o += step) {
    h.update(new Uint8Array(await blob.slice(o, o + step).arrayBuffer()));
    if (onPct) onPct(o / blob.size);
  }
  return toHex(h.digest());
}
function hashParts(parts) {
  const h = sha256.create();
  for (const p of parts) h.update(p);
  return toHex(h.digest());
}
const toHex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');

function parseCsv(text) {
  // simple RFC 4180 parser (quotes, commas or semicolons)
  const sep = (text.split('\n')[0].match(/;/g) || []).length > (text.split('\n')[0].match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; continue; }
    if (c === '"') q = true; else if (c === sep) { row.push(cur); cur = ''; } else if (c === '\n') { row.push(cur.replace(/\r$/, '')); rows.push(row); row = []; cur = ''; } else cur += c;
  }
  if (cur || row.length) { row.push(cur.replace(/\r$/, '')); rows.push(row); }
  const head = rows.shift().map((h) => h.trim());
  const idx = new Map();
  for (const r of rows) {
    if (!r.some((x) => x.trim())) continue;
    const o = {};
    head.forEach((h, i) => { o[h] = (r[i] || '').trim(); });
    const key = (o.exam || o.Exam || o.arquivo || o.file || '').replace(/\.(zip|rar|7z|tar|tgz|tar\.gz)$/i, '').toLowerCase();
    if (key) idx.set(key, o);
  }
  return idx;
}

self.onmessage = async (ev) => {
  const m = ev.data;
  try {
    if (m.type === 'init') { await init(m.base); self.postMessage({ type: 'ready', version: OMNIA_VERSION }); return; }
    if (m.type === 'batch') {
      idctx = new IdentityContext(m.settings);
      csvIndex = m.csvText ? parseCsv(m.csvText) : null;
      self.postMessage({ type: 'batch-ready', csvRows: csvIndex ? csvIndex.size : 0 });
      return;
    }
    if (m.type === 'mapping') { self.postMessage({ type: 'mapping', rows: idctx ? idctx.mappingRows() : [] }); return; }
    if (m.type === 'exam') {
      const { id, exam, settings } = m;
      const progress = (p) => self.postMessage({ type: 'progress', id, ...p });
      const t0 = performance.now();
      let sha256In = '';
      if (exam.input) sha256In = await hashBlob(exam.input, (f) => progress({ stage: 'reading', pct: 1 + f, message: 'SHA-256' }));
      const R = await processExam(exam, settings, { idctx, runner, csvIndex }, progress);
      let zip = null, zipName = null, sha256Out = '', zipSize = 0;
      if (R.outputs.length && R.status !== 'error') {
        progress({ stage: 'packaging', pct: 96 });
        const zw = new ZipWriter();
        for (const o of R.outputs) await zw.add(o.path, o.bytes, { compress: o.compress !== false });
        const { parts, size } = zw.finish();
        sha256Out = hashParts(parts);
        zip = new Blob(parts, { type: 'application/zip' });
        zipSize = size;
        zipName = `${R.outRoot || 'exam'}${settings.direction === 'dcm2nii' && settings.bids ? '_BIDS' : ''}.zip`;
      }
      const result = {
        name: R.name, status: R.status, direction: R.direction, outRoot: R.outRoot, patient: R.patient,
        series: R.series.map(({ _bidsGuess, ...s }) => s), warnings: R.warnings, errors: R.errors, ignored: R.ignored,
        containers: R.containers, files: R.outputs.length, ms: Math.round(performance.now() - t0), sha256In, sha256Out, zipName, zipSize,
      };
      const qc = R.qc;
      R.outputs.length = 0; // release memory
      self.postMessage({ type: 'result', id, result, zip, qc });
    }
  } catch (err) {
    self.postMessage({ type: 'fatal', id: m.id, message: err && err.message ? err.message : String(err) });
  }
};
