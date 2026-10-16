// POST /api/verify-code {email, code} -> {ok:true, token} | {ok:false}
import crypto from 'node:crypto';
import { json, store, normEmail, validEmail, sha, secret, hmac, upsertLead } from '../lib/shared.mjs';

export default async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  let body;
  try { body = await req.json(); } catch { return json(400, { error: 'bad_request' }); }
  const email = normEmail(body.email);
  const code = String(body.code || '').trim();
  if (!validEmail(email) || !/^\d{6}$/.test(code)) return json(400, { ok: false });
  const st = store();
  const key = await secret(st);
  const rec = await st.get(`code:${sha(email)}`, { type: 'json' });
  if (!rec || rec.exp < Date.now() || rec.tries >= 5) return json(200, { ok: false });
  const good = crypto.timingSafeEqual(Buffer.from(rec.h, 'hex'), Buffer.from(hmac(key, `${email}:${code}`), 'hex'));
  if (!good) { rec.tries += 1; await st.setJSON(`code:${sha(email)}`, rec); return json(200, { ok: false }); }
  await st.delete(`code:${sha(email)}`);
  await upsertLead(st, email, { verified: true, verifiedAt: new Date().toISOString() });
  return json(200, { ok: true, token: hmac(key, `session:${email}`) });
};

export const config = { path: '/api/verify-code' };
