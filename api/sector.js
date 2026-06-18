/**
 * api/sector.js — Vercel Serverless: Bulk Sector Scan
 *
 * Flow:
 *   1. Check Vultr Redis cache (via VULTR_CACHE_URL) — return immediately on hit
 *   2. Cache miss: fetch sector ticker list from FMP /stock-screener
 *   3. Batch-fetch /ratios + /balance-sheet-statement for each ticker (5 concurrent)
 *   4. Compute ltd_to_nwc server-side (same logic as api/ratios.js)
 *   5. Store result in Vultr cache with 24h TTL
 *   6. Return enriched company array to frontend
 *
 * GET /api/sector?sector=Real+Estate
 *
 * Response shape:
 * {
 *   sector:    string,
 *   cachedAt:  string | null,
 *   companies: [{ symbol, companyName, observedValues: { current_ratio, ltd_to_nwc, ... } }]
 * }
 */

const FMP_BASE   = 'https://financialmodelingprep.com/api/v3';
const BATCH_SIZE = 5;   // concurrent FMP requests per batch
const TICKER_LIMIT = 30; // max companies per sector scan

// ── Cache helpers ────────────────────────────────────────────────────────────

async function readCache(cacheUrl, secret, key) {
  try {
    const res = await fetch(
      `${cacheUrl}/cache?key=${encodeURIComponent(key)}`,
      { headers: { 'X-Cache-Secret': secret }, signal: AbortSignal.timeout(3000) }
    );
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function writeCache(cacheUrl, secret, key, payload) {
  try {
    await fetch(
      `${cacheUrl}/cache?key=${encodeURIComponent(key)}`,
      {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Cache-Secret': secret },
        body:    JSON.stringify(payload),
        signal:  AbortSignal.timeout(5000),
      }
    );
  } catch {
    // Non-fatal: write failures degrade gracefully (fresh data is still returned)
  }
}

// ── FMP helpers ──────────────────────────────────────────────────────────────

async function fetchTickerList(sector, key) {
  const sectorParam = sector === 'default' ? '' : `&sector=${encodeURIComponent(sector)}`;
  const url = `${FMP_BASE}/stock-screener?exchange=NYSE,NASDAQ&limit=${TICKER_LIMIT}${sectorParam}&apikey=${key}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FMP stock-screener returned HTTP ${res.status}.`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error('Unexpected response from data provider.');
  return data;
}

async function fetchOneTicker(symbol, key) {
  const [ratiosRes, balanceRes] = await Promise.all([
    fetch(`${FMP_BASE}/ratios/${symbol}?limit=1&apikey=${key}`),
    fetch(`${FMP_BASE}/balance-sheet-statement/${symbol}?limit=1&apikey=${key}`),
  ]);

  if (!ratiosRes.ok || !balanceRes.ok) return null;

  const [ratiosData, balanceData] = await Promise.all([
    ratiosRes.json(),
    balanceRes.json(),
  ]);

  if (!Array.isArray(ratiosData) || !ratiosData.length) return null;
  if (!Array.isArray(balanceData) || !balanceData.length) return null;

  const r = ratiosData[0];
  const b = balanceData[0];

  const totalCurrentAssets      = b.totalCurrentAssets      ?? null;
  const totalCurrentLiabilities = b.totalCurrentLiabilities ?? null;
  const longTermDebt             = b.longTermDebt            ?? null;

  let ltdToNwc = null;
  if (totalCurrentAssets !== null && totalCurrentLiabilities !== null && longTermDebt !== null) {
    const nwc = totalCurrentAssets - totalCurrentLiabilities;
    ltdToNwc  = nwc !== 0 ? longTermDebt / nwc : null;
  }

  return {
    current_ratio:     r.currentRatio       ?? null,
    ltd_to_nwc:        ltdToNwc,
    interest_coverage: r.interestCoverage   ?? null,
    price_to_book:     r.priceToBookRatio   ?? null,
    price_to_earnings: r.priceEarningsRatio ?? null,
  };
}

/**
 * Processes an array of tickers in sequential batches of BATCH_SIZE.
 * Uses Promise.allSettled so individual failures don't abort the batch.
 */
async function batchFetchRatios(tickers, key) {
  const results = [];

  for (let i = 0; i < tickers.length; i += BATCH_SIZE) {
    const batch = tickers.slice(i, i + BATCH_SIZE);
    const settled = await Promise.allSettled(
      batch.map(t => fetchOneTicker(t.symbol, key))
    );
    for (let j = 0; j < batch.length; j++) {
      const outcome = settled[j];
      if (outcome.status === 'fulfilled' && outcome.value !== null) {
        results.push({
          symbol:      batch[j].symbol,
          companyName: batch[j].companyName ?? batch[j].symbol,
          observedValues: outcome.value,
        });
      }
    }
  }

  return results;
}

// ── Handler ──────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  const { sector = 'default' } = req.query;

  const key         = process.env.FMP_API_KEY;
  const cacheUrl    = process.env.VULTR_CACHE_URL;
  const cacheSecret = process.env.VULTR_CACHE_SECRET;

  if (!key) {
    return res.status(500).json({
      error: 'Data provider API key is not configured.',
    });
  }

  const cacheKey = `sector:${sector}`;

  // ── 1. Check Vultr cache ────────────────────────────────────────────────────
  if (cacheUrl && cacheSecret) {
    const cached = await readCache(cacheUrl, cacheSecret, cacheKey);
    if (cached) {
      return res.status(200).json(cached);
    }
  }

  // ── 2. Cache miss — fetch fresh from FMP ───────────────────────────────────
  let tickerList;
  try {
    tickerList = await fetchTickerList(sector, key);
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }

  if (!tickerList.length) {
    return res.status(404).json({
      error: `No companies found for sector "${sector}". Try a different sector.`,
    });
  }

  // ── 3. Batch-fetch ratios for each ticker ──────────────────────────────────
  const companies = await batchFetchRatios(tickerList, key);

  if (!companies.length) {
    return res.status(502).json({
      error: 'Could not retrieve ratio data for any companies in this sector.',
    });
  }

  // ── 4. Build payload ────────────────────────────────────────────────────────
  const payload = {
    sector,
    cachedAt:  null,
    companies,
  };

  // ── 5. Store in cache (non-blocking write, then set cachedAt for client) ───
  if (cacheUrl && cacheSecret) {
    await writeCache(cacheUrl, cacheSecret, cacheKey, {
      ...payload,
      cachedAt: new Date().toISOString(),
    });
  }

  return res.status(200).json(payload);
}
