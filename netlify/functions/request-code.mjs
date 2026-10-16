// POST /api/request-code {email, lang} -> {status:'sent'} | {status:'preview', token}
import crypto from 'node:crypto';
import { json, store, normEmail, validEmail, sha, secret, hmac, allow, upsertLead, mailConfigured, sendMail } from '../lib/shared.mjs';

export default async (req, context) => {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  let body;
  try { body = await req.json(); } catch { return json(400, { error: 'bad_request' }); }
  const email = normEmail(body.email);
  if (!validEmail(email)) return json(400, { error: 'invalid_email' });
  const st = store();
  const ip = context.ip || req.headers.get('x-nf-client-connection-ip') || 'unknown';
  if (!(await allow(st, `ip:${sha(ip)}`, 20, 3600e3)) || !(await allow(st, `em:${sha(email)}`, 5, 3600e3))) return json(429, { error: 'rate_limited' });
  const lead = await upsertLead(st, email, {});
  await upsertLead(st, email, { requests: (lead.requests || 0) + 1, lang: body.lang === 'en' ? 'en' : 'pt' });
  const key = await secret(st);
  if (!mailConfigured()) {
    // Preview mode: e-mail sending not configured yet; the contact is kept (unverified) and access is granted.
    return json(200, { status: 'preview', token: hmac(key, `preview:${email}`) });
  }
  const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
  await st.setJSON(`code:${sha(email)}`, { h: hmac(key, `${email}:${code}`), exp: Date.now() + 10 * 60e3, tries: 0 });
  const pt = body.lang !== 'en';
  await sendMail(email, pt ? 'Seu código de acesso ao OMNIA' : 'Your OMNIA access code',
    pt ? `Seu código de acesso ao OMNIA é ${code}.\nEle vale por 10 minutos.\n\nAs imagens que você converte no OMNIA nunca saem do seu computador.`
      : `Your OMNIA access code is ${code}.\nIt is valid for 10 minutes.\n\nThe images you convert with OMNIA never leave your computer.`);
  return json(200, { status: 'sent' });
};

export const config = { path: '/api/request-code' };
