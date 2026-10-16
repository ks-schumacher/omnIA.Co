// Administrator page: reads the access contacts from /api/leads (protected by the ADMIN_KEY set in
// Netlify) and offers them as a table and as an Excel-friendly CSV. The key is kept only in memory.

/** Minimal RFC 4180 CSV parser (quoted fields, doubled quotes, CR/LF). */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1 || r[0] !== '');
}

const pad = (n) => String(n).padStart(2, '0');
/** ISO date-time -> local 'dd/mm/aaaa hh:mm' (empty stays empty). */
export function localDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Rows of objects -> CSV for Excel in Portuguese locale: UTF-8 BOM, ';' separator, CRLF. */
export function excelCsv(header, rows) {
  const cell = (v) => {
    const s = v === undefined || v === null ? '' : String(v);
    return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + [header, ...rows].map((r) => r.map(cell).join(';')).join('\r\n') + '\r\n';
}

function init() {
  const $ = (s) => document.querySelector(s);
  const form = $('#keyForm'), keyInput = $('#adminKey'), msg = $('#msg'), dl = $('#downloadBtn');
  const tbody = $('#table tbody'), wrap = $('#tableWrap'), loadBtn = $('#loadBtn');
  let records = [];

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const key = keyInput.value.trim();
    if (!key) return;
    loadBtn.disabled = true; dl.disabled = true; msg.textContent = 'Carregando…';
    try {
      const r = await fetch('/api/leads', { headers: { 'x-admin-key': key }, cache: 'no-store' });
      if (r.status === 403) { msg.textContent = 'Chave incorreta. Confira se é exatamente a senha do ADMIN_KEY no Netlify (maiúsculas e minúsculas contam).'; wrap.hidden = true; return; }
      if (!r.ok) { msg.textContent = `O servidor respondeu com erro ${r.status}. Tente de novo em instantes.`; return; }
      const rows = parseCsv(await r.text());
      const head = rows.shift() || [];
      const col = (name) => head.indexOf(name);
      records = rows.map((r_) => ({
        email: r_[col('email')] || '', verified: r_[col('verified')] === 'true',
        firstSeen: r_[col('firstSeen')] || '', lastSeen: r_[col('lastSeen')] || '',
        verifiedAt: r_[col('verifiedAt')] || '', requests: r_[col('requests')] || '', lang: r_[col('lang')] || '',
      }));
      tbody.textContent = '';
      for (const x of records) {
        const tr = document.createElement('tr');
        for (const v of [x.email, x.verified ? 'Sim' : 'Não', localDate(x.firstSeen), localDate(x.lastSeen), x.requests, x.lang === 'en' ? 'Inglês' : 'Português']) {
          const td = document.createElement('td'); td.textContent = v; tr.append(td);
        }
        tbody.append(tr);
      }
      wrap.hidden = records.length === 0;
      const ver = records.filter((x) => x.verified).length;
      msg.textContent = records.length
        ? `${records.length} contato(s), ${ver} com e-mail verificado.`
        : 'Ainda não há contatos.';
      dl.disabled = records.length === 0;
    } catch {
      msg.textContent = 'Sem conexão com o servidor. Verifique a internet e tente de novo.';
    } finally {
      loadBtn.disabled = false;
    }
  });

  dl.addEventListener('click', () => {
    const header = ['E-mail', 'Verificado', 'Primeiro acesso', 'Último acesso', 'Verificado em', 'Pedidos de código', 'Idioma'];
    const rows = records.map((x) => [x.email, x.verified ? 'Sim' : 'Não', localDate(x.firstSeen), localDate(x.lastSeen), localDate(x.verifiedAt), x.requests, x.lang === 'en' ? 'Inglês' : 'Português']);
    const blob = new Blob([excelCsv(header, rows)], { type: 'text/csv;charset=utf-8' });
    const d = new Date();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `contatos_omnia_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.csv`;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  });
}

if (typeof document !== 'undefined') init();
