// GET /api/leads (header "x-admin-key: <ADMIN_KEY>") -> CSV of access contacts (the qualified base).
import crypto from 'node:crypto';
import { store, sha } from '../lib/shared.mjs';

export default async (req) => {
  const admin = process.env.ADMIN_KEY;
  const given = req.headers.get('x-admin-key') || '';
  // constant-time comparison of the hashes (no early exit on the first different character)
  if (!admin || !crypto.timingSafeEqual(Buffer.from(sha(given), 'hex'), Buffer.from(sha(admin), 'hex'))) return new Response('forbidden', { status: 403 });
  const st = store();
  const { blobs } = await st.list({ prefix: 'lead:' });
  const rows = [];
  for (const b of blobs) { const r = await st.get(b.key, { type: 'json' }); if (r) rows.push(r); }
  rows.sort((a, b) => String(a.firstSeen).localeCompare(String(b.firstSeen)));
  const cols = ['email', 'verified', 'firstSeen', 'lastSeen', 'verifiedAt', 'requests', 'lang'];
  const cell = (v) => { const s = v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n');
  return new Response(csv, { headers: { 'content-type': 'text/csv; charset=utf-8', 'cache-control': 'no-store' } });
};

export const config = { path: '/api/leads' };
