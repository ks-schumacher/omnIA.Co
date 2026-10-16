// End-to-end test in a real (headless) Chromium: the built site is served with the production
// security headers, the access gate is passed, exams are added through the file input, the batch is
// run, and every output ZIP plus the reports are saved for independent validation.
// usage: node test/e2e/e2e.mjs <inputs_dir> <outputs_dir>
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';

const [, , inDir, outDir] = process.argv;
fs.mkdirSync(outDir, { recursive: true });
const port = 8000 + Math.floor(Math.random() * 900);
const server = spawn(process.execPath, ['serve.mjs', String(port)], { stdio: 'inherit' });
await new Promise((r) => setTimeout(r, 800));
const browser = await puppeteer.launch({ executablePath: await chromium.executablePath(), args: [...chromium.args, '--disable-dev-shm-usage'], headless: true, protocolTimeout: 1_800_000 });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1000 });
const consoleErrors = [];
page.on('console', async (m) => { if (m.type() === 'error') { let a = ''; try { a = JSON.stringify(await Promise.all(m.args().map((x) => x.jsonValue()))).slice(0, 300); } catch { /* */ } consoleErrors.push(`${m.text()} ${a} @ ${(m.location() || {}).url || ''}`); } });
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
const report = { runs: [], consoleErrors };

async function shot(name) { await page.screenshot({ path: path.join(outDir, `${name}.png`), fullPage: true }); }

await page.goto(`http://localhost:${port}/?e2e=1`, { waitUntil: 'networkidle0' });
await shot('01_gate');
await page.type('#gateEmail', 'e2e-test@example.org');
await page.click('#gateSend');
await page.waitForFunction(() => !document.querySelector('#gate').open, { timeout: 15000 });
await page.waitForFunction(() => window.__omnia && window.__omnia.engineReady, { timeout: 60000 });
await shot('02_ready');

async function runBatch(name, files, setup) {
  await page.evaluate(() => document.querySelector('#clearBtn').click());
  if (setup) await setup();
  const input = await page.$('#pickFiles');
  await input.uploadFile(...files.map((f) => path.join(inDir, f)));
  await page.waitForFunction((n) => window.__omnia.exams.length === n, {}, files.length);
  await shot(`${name}_queued`);
  const t0 = Date.now();
  await page.click('#startBtn');
  await page.waitForFunction(() => window.__omnia.running === true, { timeout: 10000 });
  await page.waitForFunction(() => window.__omnia.running === false, { timeout: 1_800_000, polling: 1000 });
  const ms = Date.now() - t0;
  // open every exam's details for the screenshot
  await page.evaluate(() => { for (const b of document.querySelectorAll('.exam-actions button:first-child')) b.click(); });
  await shot(`${name}_done`);
  const exams = await page.evaluate(() => window.__omnia.exams.map((e) => ({ name: e.name, status: e.status, error: e.error, result: e.result })));
  const dir = path.join(outDir, name);
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < exams.length; i++) {
    const b64 = await page.evaluate(async (idx) => {
      const ex = window.__omnia.exams[idx];
      if (!ex.blob) return null;
      const u8 = new Uint8Array(await ex.blob.arrayBuffer());
      let s = '';
      for (let k = 0; k < u8.length; k += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(k, k + 0x8000));
      return btoa(s);
    }, i);
    if (b64) fs.writeFileSync(path.join(dir, exams[i].result.zipName), Buffer.from(b64, 'base64'));
  }
  for (const k of ['csv', 'json', 'map']) {
    const r = await page.evaluate(async (key) => {
      const rep = window.__omnia.reports && window.__omnia.reports[key];
      if (!rep) return null;
      return [rep[0], await rep[1].text()];
    }, k);
    if (r) fs.writeFileSync(path.join(dir, r[0]), r[1]);
  }
  report.runs.push({ name, ms, exams: exams.map((e) => ({ name: e.name, status: e.status, error: e.error, series: e.result ? e.result.series.map((s) => [s.input, s.status, s.verification]) : [] })) });
  console.log(name, `${(ms / 1000).toFixed(1)} s`, exams.map((e) => `${e.name}:${e.status}`).join(' '));
}

const have = (f) => fs.existsSync(path.join(inDir, f));
await runBatch('A_dicom_to_nifti', ['philips_exam.zip', 'ge_exam.rar', 'nested_exam.zip'].filter(have));
await runBatch('B_nifti_to_dicom', ['nifti_seg_exam.zip', 'ct_head_exam.zip'].filter(have), async () => {
  await page.click('.dir[data-dir="nii2dcm"]');
  await page.evaluate(() => {
    const set = (name, value) => { const el = document.querySelector(`input[name="${name}"][value="${value}"]`); el.click(); };
    set('f-defaultModality', 'CT');
    const def = [...document.querySelectorAll('.toggle')].find((l) => /face|face/i.test(l.textContent) && /TC|CT/.test(l.textContent));
    def.querySelector('input').click();
  });
});
await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
await new Promise((r) => setTimeout(r, 800)); // let colour transitions finish before capturing
await shot('03_dark_theme');
await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
await page.setViewport({ width: 390, height: 844, isMobile: true });
await new Promise((r) => setTimeout(r, 800));
await shot('04_mobile');
fs.writeFileSync(path.join(outDir, 'e2e_report.json'), JSON.stringify(report, null, 1));
console.log('console errors:', consoleErrors.length ? consoleErrors : 'none');
await browser.close();
server.kill();
