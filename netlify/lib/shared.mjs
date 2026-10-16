// Shared helpers for the access functions (Netlify Functions v2, Node 22).
import { getStore } from '@netlify/blobs';
import crypto from 'node:crypto';

export const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
export const store = () => getStore({ name: 'omnia-access', consistency: 'strong' });
export const normEmail = (e) => String(e || '').trim().toLowerCase();
export const validEmail = (e) => /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,24}$/i.test(e) && e.length <= 254;
export const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

export async function secret(st) {
  if (process.env.CODE_SECRET) return process.env.CODE_SECRET;
  let s = await st.get('meta:secret');
  if (!s) { s = crypto.randomBytes(32).toString('hex'); await st.set('meta:secret', s); }
  return s;
}
export const hmac = (key, msg) => crypto.createHmac('sha256', key).update(msg).digest('hex');

/** Fixed-window rate limit stored in Blobs. Returns true when allowed. */
export async function allow(st, key, limit, windowMs) {
  const now = Date.now();
  const rec = (await st.get(`rl:${key}`, { type: 'json' })) || { start: now, n: 0 };
  if (now - rec.start > windowMs) { rec.start = now; rec.n = 0; }
  rec.n += 1;
  await st.setJSON(`rl:${key}`, rec);
  return rec.n <= limit;
}

/** Record or update the qualified contact (the only personal data OMNIA ever stores). */
export async function upsertLead(st, email, patch) {
  const key = `lead:${sha(email)}`;
  const cur = (await st.get(key, { type: 'json' })) || { email, firstSeen: new Date().toISOString(), requests: 0, verified: false };
  const next = { ...cur, ...patch, email, lastSeen: new Date().toISOString() };
  await st.setJSON(key, next);
  return next;
}

export function mailConfigured() {
  return !!(process.env.RESEND_API_KEY || (process.env.SMTP_USER && process.env.SMTP_PASS));
}

export async function sendMail(to, subject, text) {
  const from = process.env.MAIL_FROM || process.env.SMTP_USER;
  if (process.env.RESEND_API_KEY) {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from, to, subject, text }),
    });
    if (!r.ok) throw new Error(`resend ${r.status}`);
    return;
  }
  const nodemailer = (await import('nodemailer')).default;
  const tr = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com', port: Number(process.env.SMTP_PORT || 465), secure: Number(process.env.SMTP_PORT || 465) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  await tr.sendMail({ from, to, subject, text });
}
