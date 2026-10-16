// Browser test of the administrator contacts page (contatos.html) with /api/leads simulated:
// wrong key -> refused; right key -> table + Excel-friendly CSV download; the key is never stored.
// usage: node test/e2e/contatos.mjs <output_dir>   (after npm run build)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
const port = 8600 + Math.floor(Math.random() * 300);
const srv = spawn(process.execPath, ['serve.mjs', String(port)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
const browser = await puppeteer.launch({ executablePath: await chromium.executablePath(), args: chromium.args, headless: true });
const page = await browser.newPage();
const errors = []; page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.setRequestInterception(true);
page.on('request', (req) => {
  if (req.url().includes('/api/leads')) {
    const ok = req.headers()['x-admin-key'] === 'chave-certa';
    return req.respond(ok ? { status: 200, contentType: 'text/csv', body: 'email,verified,firstSeen,lastSeen,verifiedAt,requests,lang\nschumacher.kls@gmail.com,true,2026-10-16T12:50:00.000Z,2026-10-16T12:52:00.000Z,2026-10-16T12:52:00.000Z,2,pt\n"teste,virgula@x.org",false,2026-10-16T12:00:00.000Z,,,1,en\n' } : { status: 403, body: 'forbidden' });
  }
  req.continue();
});
const outDir = process.argv[2] || 'contatos-test-output'; const dlDir = outDir + '/dl'; fs.rmSync(dlDir, { recursive: true, force: true }); fs.mkdirSync(dlDir, { recursive: true });
const cdp = await page.createCDPSession(); await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir });
await page.goto(`http://localhost:${port}/contatos.html`, { waitUntil: 'networkidle0' });
await page.type('#adminKey', 'errada'); await page.click('#loadBtn');
await page.waitForFunction(() => /incorreta/.test(document.querySelector('#msg').textContent));
const wrong = await page.$eval('#msg', (e) => e.textContent);
await page.$eval('#adminKey', (e) => { e.value = ''; }); await page.type('#adminKey', 'chave-certa'); await page.click('#loadBtn');
await page.waitForFunction(() => /contato/.test(document.querySelector('#msg').textContent));
const right = await page.$eval('#msg', (e) => e.textContent);
const rows = await page.$$eval('#table tbody tr', (trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent)));
await page.setViewport({ width: 1200, height: 700 });
await page.screenshot({ path: outDir + '/contatos.png' });
await page.click('#downloadBtn');
await new Promise((r) => setTimeout(r, 1500));
const files = fs.readdirSync(dlDir);
const content = files.length ? fs.readFileSync(`${dlDir}/${files[0]}`, 'utf8') : null;
const stored = await page.evaluate(() => ({ ls: Object.keys(localStorage), ss: Object.keys(sessionStorage) }));
console.log(JSON.stringify({ wrong, right, rows, files, content, stored, errors }, null, 1));
await browser.close(); srv.kill();
