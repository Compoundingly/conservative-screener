/**
 * api/waitlist.js — Waitlist email capture
 *
 * POST /api/waitlist  { "email": "user@example.com" }
 *
 * Optionally forwards to WAITLIST_WEBHOOK_URL (Slack, Zapier, etc.).
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }

  const email = (body?.email ?? '').trim().toLowerCase();
  if (!email || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }

  const webhook = process.env.WAITLIST_WEBHOOK_URL;
  if (webhook) {
    try {
      await fetch(webhook, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email, source: 'conservative-screener', ts: new Date().toISOString() }),
      });
    } catch (err) {
      console.error('[waitlist] webhook failed:', err.message);
    }
  } else {
    console.log('[waitlist] signup:', email);
  }

  return res.status(200).json({ ok: true, message: 'You are on the waitlist. We will notify you when access opens.' });
}
