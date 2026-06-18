/**
 * vps/cache-server.js — Vultr VPS Redis Cache Server
 *
 * A lightweight Express server that fronts Redis.
 * Sits on port 3001 (configurable via PORT env var).
 * All requests must include the X-Cache-Secret header.
 *
 * Endpoints:
 *   GET  /cache?key={k}   → 200 JSON | 404
 *   PUT  /cache?key={k}   → 204 (stores body, 24h TTL)
 *   GET  /health          → 200 { status: "ok" }
 *
 * Deploy alongside your Polymarket bot using pm2:
 *   pm2 start cache-server.js --name cs-cache
 */

import express    from 'express';
import { createClient } from 'redis';
import 'dotenv/config';

const app    = express();
const PORT   = process.env.PORT   || 3001;
const SECRET = process.env.CACHE_SECRET;
const TTL_S  = 60 * 60 * 24; // 24 hours

if (!SECRET) {
  console.error('FATAL: CACHE_SECRET env var is not set. Refusing to start.');
  process.exit(1);
}

// ── Redis client ─────────────────────────────────────────────────────────────
const redis = createClient({
  url: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
});

redis.on('error', err => console.error('[Redis]', err.message));

await redis.connect();
console.log('[Redis] Connected');

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '2mb' }));

function requireSecret(req, res, next) {
  if (req.headers['x-cache-secret'] !== SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Health check (no auth — used by uptime monitors)
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

// Read from cache
app.get('/cache', requireSecret, async (req, res) => {
  const { key } = req.query;
  if (!key) return res.status(400).json({ error: 'key query param required' });

  const value = await redis.get(key);
  if (!value) return res.status(404).json({ error: 'Cache miss' });

  try {
    res.json(JSON.parse(value));
  } catch {
    res.status(500).json({ error: 'Stored value is not valid JSON' });
  }
});

// Write to cache
app.put('/cache', requireSecret, async (req, res) => {
  const { key } = req.query;
  if (!key) return res.status(400).json({ error: 'key query param required' });
  if (!req.body || typeof req.body !== 'object') {
    return res.status(400).json({ error: 'Request body must be JSON' });
  }

  await redis.set(key, JSON.stringify(req.body), { EX: TTL_S });
  res.status(204).end();
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[cs-cache] Listening on port ${PORT}`);
});
