// OMNIA user interface: settings, queue, worker orchestration, writing results, reports.
import { STRINGS } from './i18n.js';
import { DEFAULT_SETTINGS } from '../engine/settings.js';
import { ZipWriter } from '../engine/zip.js';
import { OMNIA_VERSION } from '../engine/uid.js';
import { METHOD } from './method.js';

const MAX_EXAMS = 100;
const $ = (s, el = document) => el.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) n.append(c.nodeType ? c : document.createTextNode(String(c)));
  return n;
};
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

const state = {
  lang: store.get('omnia.lang', navigator.language && navigator.language.toLowerCase().startsWith('pt') ? 'pt' : 'en'),
  settings: Object.assign(structuredClone(DEFAULT_SETTINGS), store.get('omnia.settings', {}), { password: '' }),
  exams: [], nextId: 1, running: false, paused: false, cancel: false, dir: null, csvText: null, csvName: null,
  worker: null, engineReady: false, batchStamp: null, batchSettings: null, lastBatchExams: [],
};
state.settings.filters = Object.assign(structuredClone(DEFAULT_SETTINGS.filters), state.settings.filters || {});
const t = (k) => STRINGS[state.lang][k] ?? k;

// ------------------------------------------------------------------ i18n + theme
function applyI18n() {
  document.documentElement.lang = state.lang === 'pt' ? 'pt-BR' : 'en';
  for (const n of document.querySelectorAll('[data-i18n]')) n.textContent = t(n.dataset.i18n);
  $('#langBtn').textContent = t('langSwitch');
  $('#version').textContent = `v${OMNIA_VERSION}.`;
  renderDirHelp(); renderSettings(); renderDest(); renderQueue(); renderSummary(); renderMethod(); renderControls(); renderResults();
}
$('#langBtn').addEventListener('click', () => { state.lang = state.lang === 'pt' ? 'en' : 'pt'; store.set('omnia.lang', state.lang); applyI18n(); });
function applyTheme(th) {
  if (th) document.documentElement.dataset.theme = th; else delete document.documentElement.dataset.theme;
}
applyTheme(store.get('omnia.theme', null));
$('#themeBtn').addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  const next = dark ? 'light' : 'dark';
  applyTheme(next); store.set('omnia.theme', next);
});

// ------------------------------------------------------------------ direction switch + slab
const SLICES = 9;
function buildSlab() {
  const g = $('#slices');
  g.textContent = '';
  for (let i = 0; i < SLICES; i++) {
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    p.setAttribute('points', '0,30 42,8 42,92 0,114');
    p.setAttribute('class', `slice${i === 0 ? ' edge-ax' : i === SLICES - 1 ? ' edge-cor' : ''}`);
    g.append(p);
  }
}
function slabPositions(spread) { return [...Array(SLICES).keys()].map((i) => (spread ? 10 + i * 25 : 100 + i * 5)); }
function setSlab(spread, animate) {
  const xs = slabPositions(spread);
  [...$('#slices').children].forEach((p, i) => {
    if (!animate) p.style.transition = 'none';
    p.style.transform = `translateX(${xs[i]}px)`;
    if (!animate) { p.getBoundingClientRect(); p.style.transition = ''; }
  });
}
function playDirection() {
  // DICOM -> NIfTI: separate slices gather into one volume; NIfTI -> DICOM: the volume fans out into slices
  const toNifti = state.settings.direction === 'dcm2nii';
  setSlab(toNifti, false);
  requestAnimationFrame(() => requestAnimationFrame(() => setSlab(!toNifti, true)));
}
function renderDirHelp() {
  for (const b of document.querySelectorAll('.dir')) b.setAttribute('aria-checked', String(b.dataset.dir === state.settings.direction));
  $('#dirHelp').textContent = state.settings.direction === 'dcm2nii' ? t('dirDcm2niiHelp') : t('dirNii2dcmHelp');
}
for (const b of document.querySelectorAll('.dir')) {
  b.addEventListener('click', () => {
    if (state.running || state.settings.direction === b.dataset.dir) return;
    state.settings.direction = b.dataset.dir; saveSettings(); renderDirHelp(); renderSettings(); playDirection();
  });
  b.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { const o = [...document.querySelectorAll('.dir')].find((x) => x !== b); o.focus(); o.click(); }
  });
}

// ------------------------------------------------------------------ settings form
function saveSettings() { const { password, ...rest } = state.settings; store.set('omnia.settings', rest); }
const get = (path) => path.split('.').reduce((o, k) => o[k], state.settings);
const setv = (path, v) => { const ks = path.split('.'); const last = ks.pop(); ks.reduce((o, k) => o[k], state.settings)[last] = v; saveSettings(); };

function seg(path, label, options) {
  const name = `f-${path}`;
  return el('div', { class: 'row' }, el('span', { class: 'lab', id: `${name}-l`, text: label }),
    el('div', { class: 'seg', role: 'radiogroup', 'aria-labelledby': `${name}-l` }, options.map(([v, l]) => el('label', {},
      el('input', { type: 'radio', name, value: v, checked: String(get(path)) === String(v), disabled: state.running, onchange: () => { setv(path, v); renderSettings(); } }),
      el('span', { text: l })))));
}
function toggle(path, label, help) {
  return el('label', { class: 'row toggle' }, el('input', { type: 'checkbox', checked: !!get(path), disabled: state.running, onchange: (e) => { setv(path, e.target.checked); renderSettings(); } }),
    el('span', {}, label, help ? el('small', { text: help }) : null));
}
function text(path, label, type = 'text', attrs = {}) {
  return el('label', { class: 'field' }, el('span', { text: label }), el('input', { type, value: get(path) ?? '', disabled: state.running, ...attrs,
    onchange: (e) => { setv(path, type === 'number' ? Math.max(1, parseInt(e.target.value, 10) || 1) : e.target.value); } }));
}
function renderSettings() {
  const f = $('#settingsForm');
  f.textContent = '';
  const S = state.settings;
  const privacy = el('fieldset', {}, el('legend', { text: t('groupPrivacy') }), toggle('anonymize', t('anonymize'), t('anonymizeHelp')));
  if (S.anonymize) {
    privacy.append(text('pseudonymPrefix', t('prefix'), 'text', { maxlength: 12, pattern: '[A-Za-z0-9]+' }),
      seg('dates', t('dates'), [['remove', t('datesRemove')], ['shift', t('datesShift')], ['keep', t('datesKeep')]]),
      toggle('retainPatientCharacteristics', t('keepChars')), toggle('keepDescriptions', t('keepDesc')));
  }
  privacy.append(toggle('deface', t('deface'), t('defaceHelp')));
  if (S.deface) privacy.append(seg('defaceFailure', t('defaceFailure'), [['exclude', t('defaceExclude')], ['include', t('defaceInclude')]]));
  f.append(privacy);
  if (S.direction === 'dcm2nii') {
    f.append(el('fieldset', {}, el('legend', { text: t('groupDcm2nii') }),
      seg('outputFormat', t('format'), [['nii.gz', '.nii.gz'], ['nii', '.nii']]),
      toggle('bids', t('bids')),
      toggle('filters.localizers', t('filterLoc')),
      toggle('filters.derivedSecondary', t('filterDerived')),
      text('filters.minImages', t('minImages'), 'number', { min: 1, max: 999 }),
      seg('variableSpacing', t('spacing'), [['split', t('spacingSplit')], ['interpolate', t('spacingInterp')], ['skip', t('spacingSkip')]]),
      seg('gantryTilt', t('tilt'), [['exact', t('tiltExact')], ['resampled', t('tiltResampled')]])));
  } else {
    const fs = el('fieldset', {}, el('legend', { text: t('groupNii2dcm') }),
      seg('defaultModality', t('modality'), [['MR', 'RM / MR'], ['CT', 'TC / CT']]),
      seg('geometryPriority', t('geometry'), [['sform', 'sform'], ['qform', 'qform']]),
      seg('valuePolicy', t('valuePolicy'), [['lossless', t('valueLossless')], ['quantize', t('valueQuantize')]]),
      seg('maskHandling', t('masks'), [['auto', t('masksAuto')], ['image', t('masksImage')], ['seg', t('masksSeg')]]));
    if (S.maskHandling !== 'image') {
      fs.append(seg('segAlgorithmType', t('segAlg'), [['AUTOMATIC', t('segAuto')], ['SEMIAUTOMATIC', t('segSemi')], ['MANUAL', t('segManual')]]));
      if (S.segAlgorithmType !== 'MANUAL') fs.append(text('segAlgorithmName', t('segName'), 'text', { maxlength: 64 }));
    }
    const csvInput = el('input', { type: 'file', accept: '.csv,.tsv,.txt', onchange: async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      state.csvText = await file.text(); state.csvName = file.name; renderSettings();
    } });
    fs.append(el('div', { class: 'row' }, el('span', { class: 'lab', text: t('csvMeta') }),
      el('div', { class: 'csvline' }, el('label', { class: 'link' }, csvInput, el('span', { text: t('csvChoose') })),
        state.csvName ? el('span', { class: 'mono', text: `${state.csvName}: ${Math.max(0, state.csvText.trim().split(/\r?\n/).length - 1)} ${t('csvLoaded')}` }) : null,
        state.csvName ? el('button', { type: 'button', class: 'ghost', text: t('csvClear'), onclick: () => { state.csvText = null; state.csvName = null; renderSettings(); } }) : null),
      el('small', { class: 'help', text: t('csvHelp') })));
    f.append(fs);
  }
  const pw = el('input', { type: 'password', value: S.password || '', disabled: state.running, autocomplete: 'off', onchange: (e) => { S.password = e.target.value; } });
  f.append(el('fieldset', {}, el('legend', { text: t('groupArchives') }), el('label', { class: 'field' }, el('span', { text: t('password') }), pw)));
}

// ------------------------------------------------------------------ destination
const canPickDir = typeof window.showDirectoryPicker === 'function';
function renderDest() {
  const d = $('#dest');
  d.textContent = '';
  if (!canPickDir) { d.append(el('span', { text: t('destNoApi') })); return; }
  d.append(el('button', { type: 'button', text: t('destChoose'), disabled: state.running, onclick: async () => {
    try { state.dir = await window.showDirectoryPicker({ mode: 'readwrite', id: 'omnia-out' }); renderDest(); } catch { /* user cancelled */ }
  } }), state.dir ? el('span', {}, `${t('dest')}: `, el('strong', { text: state.dir.name })) : el('span', { text: t('destNone') }));
}

// ------------------------------------------------------------------ adding exams
function fmtSize(b) {
  if (b < 1024) return `${b} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { b /= 1024; i++; } while (b >= 1024 && i < u.length - 1);
  return `${b.toFixed(b < 10 ? 1 : 0)} ${u[i]}`;
}
function addExam(ex) {
  if (state.exams.filter((e) => e.status !== 'done-removed').length >= MAX_EXAMS) return false;
  state.exams.push({ id: state.nextId++, status: 'queued', pct: 0, stage: '', message: '', ...ex });
  return true;
}
function addFiles(files) {
  let rejected = 0;
  for (const f of files) {
    if (!addExam({ name: f.name, size: f.size, input: f })) rejected++;
  }
  if (rejected) alert(t('tooMany'));
  renderQueue(); renderSummary(); renderControls();
}
async function readEntryTree(entry, prefix = '') {
  const out = [];
  if (entry.isFile) {
    const file = await new Promise((res, rej) => entry.file(res, rej));
    out.push({ path: prefix + file.name, blob: file });
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    let batch;
    do {
      batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      for (const e of batch) out.push(...await readEntryTree(e, `${prefix}${entry.name}/`));
    } while (batch.length);
  }
  return out;
}
const drop = $('#drop');
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', async (e) => {
  e.preventDefault(); drop.classList.remove('over');
  if (state.running) return;
  const items = [...(e.dataTransfer.items || [])].map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null));
  if (items.length && items.every(Boolean)) {
    const files = [];
    for (const entry of items) {
      if (entry.isDirectory) {
        const list = await readEntryTree(entry);
        const strip = `${entry.name}/`;
        const size = list.reduce((a, f) => a + f.blob.size, 0);
        if (!addExam({ name: entry.name, size, files: list.map((f) => ({ path: f.path.startsWith(strip) ? f.path.slice(strip.length) : f.path, blob: f.blob })) })) alert(t('tooMany'));
      } else files.push(await new Promise((res, rej) => entry.file(res, rej)));
    }
    if (files.length) addFiles(files); else { renderQueue(); renderSummary(); renderControls(); }
  } else addFiles([...e.dataTransfer.files]);
});
drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#pickFiles').click(); } });
$('#pickFiles').addEventListener('change', (e) => { addFiles([...e.target.files]); e.target.value = ''; });
$('#pickFolder').addEventListener('change', (e) => {
  const files = [...e.target.files];
  if (!files.length) return;
  const root = files[0].webkitRelativePath.split('/')[0];
  addExam({ name: root, size: files.reduce((a, f) => a + f.size, 0), files: files.map((f) => ({ path: f.webkitRelativePath.split('/').slice(1).join('/'), blob: f })) });
  e.target.value = '';
  renderQueue(); renderSummary(); renderControls();
});
$('#clearBtn').addEventListener('click', () => { if (state.running) return; state.exams = []; renderQueue(); renderSummary(); renderControls(); renderResults(); });

// ------------------------------------------------------------------ queue rendering
const STAGES = ['reading', 'scanning', 'converting', 'packaging', 'done'];
function examRow(ex, idx) {
  const li = el('li', { class: 'exam', 'data-status': ex.status, id: `ex-${ex.id}` });
  const head = el('div', { class: 'exam-head' },
    el('span', { class: 'exam-idx', text: String(idx + 1).padStart(2, '0') }),
    el('div', {}, el('div', { class: 'exam-name', text: ex.name }),
      el('div', { class: 'exam-meta', text: `${fmtSize(ex.size)}${ex.files ? ` · ${ex.files.length} ${t('files')}` : ''}` })),
    el('span', { class: `pill ${ex.status}`, text: t(ex.status) }));
  li.append(head);
  const track = el('div', { class: 'track', 'aria-hidden': 'true' });
  for (let i = 0; i < 5; i++) { const b = el('b'); b.style.width = `${segFill(ex, i)}%`; track.append(el('i', {}, b)); }
  li.append(track, el('div', { class: 'track-labels', 'aria-hidden': 'true' }, STAGES.map((s) => el('span', { text: t('stages')[s] }))));
  li.append(el('p', { class: 'exam-msg', text: examMessage(ex) }));
  if (ex.result) {
    const acts = el('div', { class: 'exam-actions' });
    acts.append(el('button', { type: 'button', text: ex.open ? t('hideDetails') : t('details'), 'aria-expanded': String(!!ex.open), onclick: () => { ex.open = !ex.open; replaceRow(ex); } }));
    if (ex.blob) acts.append(el('button', { type: 'button', text: `${ex.result.zipName}`, onclick: () => download(ex.blob, ex.result.zipName) }));
    li.append(acts);
    if (ex.open) li.append(detail(ex));
  }
  return li;
}
function segFill(ex, i) {
  if (ex.status === 'ok' || ex.status === 'warning') return 100;
  const p = ex.pct || 0;
  return Math.max(0, Math.min(100, (p - i * 20) * 5));
}
function examMessage(ex) {
  if (ex.status === 'running') return `${t('stages')[ex.stage] || ''}${ex.message ? `: ${ex.message}` : ''}`;
  if (!ex.result) return ex.error || '';
  const r = ex.result;
  const conv = r.series.filter((s) => s.status === 'ok' || s.status === 'warning').length;
  const skip = r.series.filter((s) => s.status === 'skipped').length;
  const err = r.series.filter((s) => s.status === 'error').length;
  const where = ex.writtenTo ? `${t('written')} ${ex.writtenTo}` : ex.blob ? t('ready') : '';
  const parts = [`${r.series.length} ${t('series')}: ${conv} ${t('converted')}, ${skip} ${t('skippedN')}, ${err} ${t('errorsN')}`];
  if (where) parts.push(where);
  if (r.errors.length && !conv) parts.push(r.errors[0]);
  return parts.join('. ');
}
function detail(ex) {
  const r = ex.result;
  const box = el('div', { class: 'detail' });
  const list = el('ol', { class: 'series-list' });
  for (const s of r.series) {
    const li = el('li', { class: 'series', 'data-status': s.status },
      el('div', { class: 'series-head' },
        el('span', { class: 'series-input mono', text: s.input }),
        el('span', { class: `series-status s-${s.status}`, text: t(s.status) })));
    if (s.verification) li.append(el('p', { class: 'series-ver', text: s.verification }));
    const notes = [...s.notes, ...(s.encoding && !s.notes.includes(s.encoding) ? [s.encoding] : [])];
    if (notes.length || s.warnings.length) {
      li.append(el('ul', { class: 'series-notes' },
        notes.map((n) => el('li', { text: n })),
        s.warnings.map((w) => el('li', { class: 'warn', text: `⚠ ${w}` }))));
    }
    if (s.outputs.length) {
      li.append(el('details', { class: 'series-out' },
        el('summary', { text: `${t('outputsLabel')} (${s.outputs.length})` }),
        el('ul', {}, s.outputs.map((o) => el('li', { class: 'mono', text: o })))));
    }
    list.append(li);
  }
  box.append(list);
  const misc = [...r.warnings.map((w) => ['warn', `⚠ ${w}`]), ...r.errors.map((w) => ['err', `✖ ${w}`]), ...r.ignored.slice(0, 20).map((w) => ['', w])];
  if (misc.length) box.append(el('ul', { class: 'exam-notes' }, misc.map(([c, m]) => el('li', { class: c, text: m }))));
  const hashes = [];
  if (r.sha256In) hashes.push(el('dt', { text: `SHA-256 ${t('input').toLowerCase()}` }), el('dd', { class: 'mono', text: r.sha256In }));
  if (r.sha256Out) hashes.push(el('dt', { text: `SHA-256 ${t('outputs').toLowerCase()}` }), el('dd', { class: 'mono', text: r.sha256Out }));
  if (hashes.length) box.append(el('dl', { class: 'hashes' }, hashes));
  if (ex.qc && ex.qc.length) {
    box.append(el('h3', { text: t('qc') }));
    const films = el('div', { class: 'films' });
    for (const q of ex.qc) {
      const g = el('div', { class: 'film-group' }, el('p', { text: q.label }));
      const row = el('div', { class: 'films-row' });
      if (q.kind === 'ortho') for (const v of q.views) row.append(film(v, v.name, t(v.name)));
      else { row.append(film(q.before, 'face', t('before'))); row.append(film(q.after, 'face', t('after'))); }
      g.append(row); films.append(g);
    }
    box.append(films);
  }
  return box;
}
function film(img, kind, label) {
  const c = el('canvas', { width: img.w, height: img.h, role: 'img', 'aria-label': label });
  const ctx = c.getContext('2d');
  const id = ctx.createImageData(img.w, img.h);
  for (let i = 0; i < img.pixels.length; i++) { const g = img.pixels[i]; id.data[4 * i] = g; id.data[4 * i + 1] = g; id.data[4 * i + 2] = g; id.data[4 * i + 3] = 255; }
  ctx.putImageData(id, 0, 0);
  return el('figure', { class: `film ${kind}` }, c, el('figcaption', { text: label }));
}
function renderQueue() {
  const q = $('#queue');
  q.textContent = '';
  state.exams.forEach((ex, i) => q.append(examRow(ex, i)));
}
function replaceRow(ex) {
  const old = document.getElementById(`ex-${ex.id}`);
  const idx = state.exams.indexOf(ex);
  if (old) old.replaceWith(examRow(ex, idx)); else renderQueue();
}
function updateProgress(ex) {
  const li = document.getElementById(`ex-${ex.id}`);
  if (!li) return;
  li.dataset.status = ex.status;
  const bs = li.querySelectorAll('.track b');
  bs.forEach((b, i) => { b.style.width = `${segFill(ex, i)}%`; });
  const pill = li.querySelector('.pill');
  pill.className = `pill ${ex.status}`; pill.textContent = t(ex.status);
  li.querySelector('.exam-msg').textContent = examMessage(ex);
}
function counts() {
  const c = { ok: 0, warning: 0, error: 0, left: 0 };
  for (const e of state.exams) {
    if (e.status === 'ok') c.ok++;
    else if (e.status === 'warning') c.warning++;
    else if (e.status === 'error' || e.status === 'skipped' || e.status === 'cancelled') c.error++;
    else c.left++;
  }
  return c;
}
function renderSummary() {
  const s = $('#summary');
  s.textContent = '';
  if (!state.exams.length) return;
  const c = counts();
  const done = state.exams.length - c.left;
  const bar = el('div', { class: 'bar-total' }, el('i'));
  bar.firstChild.style.width = `${(100 * done) / state.exams.length}%`;
  s.append(el('div', { text: t('summary')(c).replace(/ · /g, ', ') }), bar);
}
function renderControls() {
  const start = $('#startBtn'), pause = $('#pauseBtn'), cancel = $('#cancelBtn'), retry = $('#retryBtn');
  start.hidden = state.running;
  start.disabled = !state.engineReady || !state.exams.some((e) => e.status === 'queued');
  pause.hidden = !state.running; pause.textContent = state.paused ? t('resume') : t('pause');
  cancel.hidden = !state.running;
  retry.hidden = state.running || !state.exams.some((e) => e.status === 'error' || e.status === 'cancelled' || e.status === 'skipped');
  $('#clearBtn').disabled = state.running;
}

// ------------------------------------------------------------------ worker
let pending = null;
function startWorker() {
  if (state.worker) state.worker.terminate();
  state.engineReady = false;
  $('#engine').textContent = t('engineLoading');
  const w = new Worker(new URL('worker.js', import.meta.url), { type: 'module' });
  state.worker = w;
  w.onmessage = (ev) => onWorker(ev.data);
  w.onerror = (e) => { $('#engine').textContent = `${t('engineError')} ${e.message || ''}`; if (pending) { pending.reject(new Error(e.message || 'worker error')); pending = null; } };
  w.postMessage({ type: 'init', base: new URL('./', location.href).href });
}
const waiters = {};
function waitFor(type) { return new Promise((res) => { waiters[type] = res; }); }
function onWorker(m) {
  if (m.type === 'ready') { state.engineReady = true; $('#engine').textContent = `${t('engineReady')} · OMNIA ${m.version}`.replace(' · ', ', '); renderControls(); return; }
  if (waiters[m.type]) { const f = waiters[m.type]; delete waiters[m.type]; f(m); return; }
  if (m.type === 'progress') {
    const ex = state.exams.find((e) => e.id === m.id);
    if (!ex) return;
    ex.stage = m.stage; ex.pct = Math.max(ex.pct || 0, m.pct || 0); ex.message = m.message || '';
    updateProgress(ex);
    return;
  }
  if ((m.type === 'result' || m.type === 'fatal') && pending && pending.id === m.id) { const p = pending; pending = null; p.resolve(m); }
}
function runExamInWorker(ex) {
  return new Promise((resolve, reject) => {
    pending = { id: ex.id, resolve, reject };
    const exam = ex.files ? { name: ex.name, files: ex.files } : { name: ex.name, input: ex.input };
    state.worker.postMessage({ type: 'exam', id: ex.id, exam, settings: state.batchSettings });
  });
}

// ------------------------------------------------------------------ batch
async function uniqueHandle(dir, name) {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 1; i < 1000; i++) {
    const candidate = i === 1 ? name : `${base}_${i}${ext}`;
    try { await dir.getFileHandle(candidate); } catch { return { handle: await dir.getFileHandle(candidate, { create: true }), name: candidate }; }
  }
  throw new Error('too many files with the same name');
}
async function writeToDir(name, blob) {
  const { handle, name: real } = await uniqueHandle(state.dir, name);
  const w = await handle.createWritable();
  await w.write(blob);
  await w.close();
  return real;
}
function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}
async function run(retry = false) {
  if (state.running || !state.engineReady) return;
  if (!state.exams.some((e) => e.status === 'queued') && !retry) { alert(t('noExams')); return; }
  if (state.dir && (await state.dir.queryPermission({ mode: 'readwrite' })) !== 'granted') {
    if ((await state.dir.requestPermission({ mode: 'readwrite' })) !== 'granted') state.dir = null;
  }
  if (retry) for (const e of state.exams) if (['error', 'cancelled', 'skipped'].includes(e.status)) Object.assign(e, { status: 'queued', pct: 0, result: null, error: '', blob: null, qc: null });
  state.running = true; state.paused = false; state.cancel = false;
  if (!retry || !state.batchSettings) {
    state.batchSettings = structuredClone(state.settings);
    state.batchStamp = stamp();
    state.worker.postMessage({ type: 'batch', settings: state.batchSettings, csvText: state.batchSettings.direction === 'nii2dcm' ? state.csvText : null });
    await waitFor('batch-ready');
  }
  renderSettings(); renderDest(); renderControls(); renderQueue();
  window.onbeforeunload = (e) => { e.preventDefault(); e.returnValue = t('confirmLeave'); return t('confirmLeave'); };
  for (const ex of state.exams) {
    if (ex.status !== 'queued') continue;
    while (state.paused && !state.cancel) await new Promise((r) => setTimeout(r, 200));
    if (state.cancel) break;
    ex.status = 'running'; ex.pct = 0; ex.stage = 'reading'; ex.message = '';
    replaceRow(ex); renderSummary();
    let m;
    try { m = await runExamInWorker(ex); } catch (err) { m = { type: 'fatal', message: err.message }; }
    if (state.cancel && !m) break;
    if (m.type === 'fatal') { ex.status = 'error'; ex.error = m.message; ex.result = null; }
    else {
      ex.result = m.result; ex.qc = m.qc; ex.status = m.result.status; ex.pct = 100;
      if (m.zip) {
        if (state.dir) {
          try { ex.writtenTo = `${state.dir.name}/${await writeToDir(m.result.zipName, m.zip)}`; } catch (err) { ex.blob = m.zip; ex.result.errors.push(`write failed: ${err.message}`); }
        } else ex.blob = m.zip;
      }
    }
    replaceRow(ex); renderSummary();
  }
  if (state.cancel) for (const e of state.exams) if (e.status === 'queued' || e.status === 'running') e.status = 'cancelled';
  state.running = false;
  window.onbeforeunload = null;
  await finishBatch();
  renderSettings(); renderDest(); renderControls(); renderQueue(); renderSummary();
}
$('#startBtn').addEventListener('click', () => run(false));
$('#retryBtn').addEventListener('click', () => run(true));
$('#pauseBtn').addEventListener('click', () => { state.paused = !state.paused; renderControls(); });
$('#cancelBtn').addEventListener('click', () => {
  state.cancel = true; state.paused = false;
  if (pending) { const p = pending; pending = null; p.resolve({ type: 'fatal', message: t('cancelled') }); }
  startWorker(); // terminates the running conversion immediately
});

// ------------------------------------------------------------------ reports
const csvCell = (v) => { const s = v === undefined || v === null ? '' : String(v); return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
function reportRows() {
  const rows = [];
  for (const ex of state.exams) {
    const r = ex.result;
    if (!r) { rows.push({ exam: ex.name, exam_status: ex.status, error: ex.error || '' }); continue; }
    if (!r.series.length) rows.push({ exam: ex.name, exam_status: r.status, output_zip: ex.writtenTo || r.zipName || '', sha256_input: r.sha256In, sha256_output: r.sha256Out, error: r.errors.join(' | ') });
    for (const s of r.series) {
      rows.push({
        exam: ex.name, exam_status: r.status, direction: s.direction, output_zip: ex.writtenTo || r.zipName || '', pseudonym_or_id: r.patient || '',
        series: s.input, series_status: s.status, verification: s.verification || '', encoding: s.encoding || '', outputs: s.outputs.join(' | '),
        notes: s.notes.join(' | '), warnings: s.warnings.join(' | '), sha256_input: r.sha256In, sha256_output: r.sha256Out, exam_ms: r.ms,
      });
    }
  }
  return rows;
}
function toCsv(rows) {
  const cols = [...rows.reduce((s, r) => { Object.keys(r).forEach((k) => s.add(k)); return s; }, new Set())];
  return '﻿' + [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\r\n');
}
async function finishBatch() {
  const batchExams = state.exams.filter((e) => e.result || e.status === 'error' || e.status === 'cancelled');
  if (!batchExams.length) return;
  state.worker.postMessage({ type: 'mapping' });
  const mapping = (await Promise.race([waitFor('mapping'), new Promise((r) => setTimeout(() => r({ rows: [] }), 5000))])).rows;
  const base = `OMNIA_${state.batchStamp}`;
  const csv = new Blob([toCsv(reportRows())], { type: 'text/csv' });
  const json = new Blob([JSON.stringify({
    software: `OMNIA ${OMNIA_VERSION}`, createdAt: new Date().toISOString(), userAgent: navigator.userAgent,
    settings: { ...state.batchSettings, password: state.batchSettings.password ? '(set)' : '' },
    exams: state.exams.map((ex) => ({ name: ex.name, size: ex.size, status: ex.status, error: ex.error || undefined, writtenTo: ex.writtenTo, result: ex.result })),
  }, null, 2)], { type: 'application/json' });
  const map = state.batchSettings.anonymize && mapping.length ? new Blob([toCsv(mapping)], { type: 'text/csv' }) : null;
  state.reports = { csv: [`${base}_${t('reportFile')}.csv`, csv], json: [`${base}_${t('reportFile')}.json`, json], map: map ? [`${base}_${t('mapFile')}.csv`, map] : null };
  if (state.dir) {
    for (const k of ['csv', 'json', 'map']) {
      const r = state.reports[k];
      if (r) { try { r[2] = await writeToDir(r[0], r[1]); } catch { /* keep download */ } }
    }
  }
  renderResults();
}
function download(blob, name) {
  const a = el('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
function renderResults() {
  const box = $('#results'), acts = $('#resultActions');
  acts.textContent = '';
  if (!state.reports) { box.hidden = true; return; }
  box.hidden = false;
  const R = state.reports;
  acts.append(el('button', { type: 'button', class: 'primary', text: t('reportCsv'), onclick: () => download(R.csv[1], R.csv[0]) }));
  acts.append(el('button', { type: 'button', text: t('reportJson'), onclick: () => download(R.json[1], R.json[0]) }));
  if (R.map) acts.append(el('button', { type: 'button', text: t('mapCsv'), onclick: () => download(R.map[1], R.map[0]) }));
  const blobs = state.exams.filter((e) => e.blob);
  if (blobs.length) {
    acts.append(el('button', { type: 'button', text: t('downloadAll'), onclick: async () => {
      const z = new ZipWriter();
      for (const e of blobs) await z.add(e.result.zipName, new Uint8Array(await e.blob.arrayBuffer()), { compress: false });
      await z.add(R.csv[0], new Uint8Array(await R.csv[1].arrayBuffer()));
      await z.add(R.json[0], new Uint8Array(await R.json[1].arrayBuffer()));
      const { parts } = z.finish();
      download(new Blob(parts, { type: 'application/zip' }), `OMNIA_${state.batchStamp}.zip`);
    } }));
  }
  if (state.dir) acts.append(el('p', { class: 'help', text: `${t('written')} ${state.dir.name}/` }));
}

// ------------------------------------------------------------------ method
function renderMethod() {
  const b = $('#methodBody');
  b.textContent = '';
  const M = METHOD[state.lang];
  b.append(el('div', { class: 'numbers' }, M.numbers.map(([n, l]) => el('div', {}, el('b', { text: n }), el('span', { text: l })))));
  for (const [h, p] of M.items) b.append(el('article', {}, el('h3', { text: h }), el('p', { text: p })));
}

// ------------------------------------------------------------------ access gate (email)
const ACCESS_KEY = 'omnia.access.v1';
function hasAccess() { const a = store.get(ACCESS_KEY, null); return a && a.exp > Date.now(); }
function grant(email, token, days = 30) { store.set(ACCESS_KEY, { email, token, exp: Date.now() + days * 864e5 }); }
async function api(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (r.status === 404) return { status: 'local' };
  let j = {};
  try { j = await r.json(); } catch { /* not json */ }
  if (!r.ok) throw Object.assign(new Error(j.error || `HTTP ${r.status}`), { code: j.error });
  return j;
}
function gate() {
  return new Promise((resolve) => {
    if (hasAccess()) { resolve(); return; }
    const dlg = $('#gate');
    const msg = $('#gateMsg');
    const done = (text) => { msg.textContent = text; setTimeout(() => { dlg.close(); resolve(); }, text ? 900 : 0); };
    dlg.addEventListener('cancel', (e) => e.preventDefault());
    $('#gateSend').onclick = async () => {
      const email = $('#gateEmail').value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { msg.textContent = t('gateInvalid'); return; }
      $('#gateSend').disabled = true;
      try {
        const r = await api('/api/request-code', { email, lang: state.lang });
        if (r.status === 'sent') { $('#gateCodeWrap').hidden = false; $('#gateVerify').hidden = false; $('#gateSend').hidden = true; msg.textContent = t('gateSent'); $('#gateCode').focus(); }
        else if (r.status === 'preview') { grant(email, r.token || '', 30); done(t('gatePreview')); }
        else { grant(email, '', 1); done(t('gateLocal')); }
      } catch (err) {
        if (err.code === 'invalid_email') msg.textContent = t('gateInvalid');
        else { grant(email, '', 1); done(t('gateLocal')); }
      } finally { $('#gateSend').disabled = false; }
    };
    $('#gateVerify').onclick = async () => {
      const email = $('#gateEmail').value.trim(), code = $('#gateCode').value.trim();
      try {
        const r = await api('/api/verify-code', { email, code });
        if (r.ok) { grant(email, r.token, 30); done(''); } else msg.textContent = t('gateBad');
      } catch { msg.textContent = t('gateBad'); }
    };
    applyI18n();
    dlg.showModal();
    $('#gateEmail').focus();
  });
}

// ------------------------------------------------------------------ boot
if (new URLSearchParams(location.search).has('e2e')) window.__omnia = state; // test hook (end-to-end tests only)
buildSlab();
applyI18n();
playDirection();
gate().then(() => startWorker());
