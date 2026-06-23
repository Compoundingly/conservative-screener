/**
 * api/beta.js — Beta access code validation
 *
 * POST /api/beta  { "code": "..." }
 *
 * Valid codes are configured via BETA_ACCESS_CODES env var (comma-separated).
 * Falls back to COMPOUND2026 when unset (local development only).
 */

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }

  const code = (body?.code ?? '').trim().toUpperCase();
  if (!code) {
    return res.status(400).json({ error: 'Beta code is required.' });
  }

  const envCodes = process.env.BETA_ACCESS_CODES ?? 'COMPOUND2026';
  const validCodes = envCodes.split(',').map(c => c.trim().toUpperCase()).filter(Boolean);

  if (validCodes.includes(code)) {
    return res.status(200).json({ valid: true });
  }

  return res.status(401).json({ valid: false, error: 'Invalid beta access code.' });
}
