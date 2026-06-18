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
const BATCH_SIZE = 5; // concurrent FMP requests per batch

// ── Cache helpers ────────────────────────────────────────────────────────────
// Both functions are completely optional. VULTR_CACHE_URL / VULTR_CACHE_SECRET
// are only read by the handler; if absent or if the VPS is unreachable, the
// system falls back to direct FMP calls without interrupting the response.

async function readCache(cacheUrl, secret, key) {
  try {
    const res = await fetch(
      `${cacheUrl}/cache?key=${encodeURIComponent(key)}`,
      { headers: { 'X-Cache-Secret': secret }, signal: AbortSignal.timeout(3000) }
    );
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    // VPS unreachable or timed out — degrade gracefully, log for Vercel function logs
    console.warn(`[cs-cache] read miss (${key}): ${err.message}`);
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
  } catch (err) {
    // Non-fatal: write failures degrade gracefully — fresh data is still returned
    console.warn(`[cs-cache] write failed (${key}): ${err.message}`);
  }
}

// ── Sector ticker registry ───────────────────────────────────────────────────
// FMP's /stock-screener endpoint requires a paid subscription (returns HTTP 403
// on the free tier). Instead we use a curated list of large, established
// companies per sector — appropriate for a conservative screening tool.
// Each entry matches the companyName shape returned by FMP /ratios so the
// rest of the pipeline is unchanged.

const SECTOR_TICKERS = {
  'Real Estate': [
    { symbol: 'O',    companyName: 'Realty Income' },
    { symbol: 'SPG',  companyName: 'Simon Property Group' },
    { symbol: 'PLD',  companyName: 'Prologis' },
    { symbol: 'AMT',  companyName: 'American Tower' },
    { symbol: 'CCI',  companyName: 'Crown Castle' },
    { symbol: 'WELL', companyName: 'Welltower' },
    { symbol: 'AVB',  companyName: 'AvalonBay Communities' },
    { symbol: 'EQR',  companyName: 'Equity Residential' },
    { symbol: 'PSA',  companyName: 'Public Storage' },
    { symbol: 'DLR',  companyName: 'Digital Realty' },
    { symbol: 'VTR',  companyName: 'Ventas' },
    { symbol: 'NNN',  companyName: 'NNN REIT' },
    { symbol: 'ARE',  companyName: 'Alexandria Real Estate' },
    { symbol: 'SBA',  companyName: 'SBA Communications' },
    { symbol: 'CBRE', companyName: 'CBRE Group' },
  ],
  'Retail': [
    { symbol: 'WMT',  companyName: 'Walmart' },
    { symbol: 'TGT',  companyName: 'Target' },
    { symbol: 'COST', companyName: 'Costco Wholesale' },
    { symbol: 'HD',   companyName: 'Home Depot' },
    { symbol: 'LOW',  companyName: 'Lowe\'s Companies' },
    { symbol: 'KR',   companyName: 'Kroger' },
    { symbol: 'DG',   companyName: 'Dollar General' },
    { symbol: 'DLTR', companyName: 'Dollar Tree' },
    { symbol: 'TJX',  companyName: 'TJX Companies' },
    { symbol: 'ROST', companyName: 'Ross Stores' },
    { symbol: 'AZO',  companyName: 'AutoZone' },
    { symbol: 'ORLY', companyName: 'O\'Reilly Automotive' },
    { symbol: 'BBY',  companyName: 'Best Buy' },
    { symbol: 'M',    companyName: 'Macy\'s' },
    { symbol: 'GPS',  companyName: 'Gap' },
  ],
  'Technology': [
    { symbol: 'AAPL',  companyName: 'Apple' },
    { symbol: 'MSFT',  companyName: 'Microsoft' },
    { symbol: 'ORCL',  companyName: 'Oracle' },
    { symbol: 'IBM',   companyName: 'IBM' },
    { symbol: 'CSCO',  companyName: 'Cisco Systems' },
    { symbol: 'TXN',   companyName: 'Texas Instruments' },
    { symbol: 'QCOM',  companyName: 'Qualcomm' },
    { symbol: 'AVGO',  companyName: 'Broadcom' },
    { symbol: 'ADI',   companyName: 'Analog Devices' },
    { symbol: 'AMAT',  companyName: 'Applied Materials' },
    { symbol: 'KLAC',  companyName: 'KLA Corporation' },
    { symbol: 'MSI',   companyName: 'Motorola Solutions' },
    { symbol: 'JNPR',  companyName: 'Juniper Networks' },
    { symbol: 'HPQ',   companyName: 'HP Inc.' },
    { symbol: 'NTAP',  companyName: 'NetApp' },
  ],
  'Utilities': [
    { symbol: 'NEE',  companyName: 'NextEra Energy' },
    { symbol: 'DUK',  companyName: 'Duke Energy' },
    { symbol: 'SO',   companyName: 'Southern Company' },
    { symbol: 'AEP',  companyName: 'American Electric Power' },
    { symbol: 'EXC',  companyName: 'Exelon' },
    { symbol: 'XEL',  companyName: 'Xcel Energy' },
    { symbol: 'SRE',  companyName: 'Sempra' },
    { symbol: 'PEG',  companyName: 'Public Service Enterprise' },
    { symbol: 'ED',   companyName: 'Consolidated Edison' },
    { symbol: 'WEC',  companyName: 'WEC Energy Group' },
    { symbol: 'ETR',  companyName: 'Entergy' },
    { symbol: 'FE',   companyName: 'FirstEnergy' },
    { symbol: 'CNP',  companyName: 'CenterPoint Energy' },
    { symbol: 'PPL',  companyName: 'PPL Corporation' },
    { symbol: 'AES',  companyName: 'AES Corporation' },
  ],
  default: [
    { symbol: 'AAPL', companyName: 'Apple' },
    { symbol: 'MSFT', companyName: 'Microsoft' },
    { symbol: 'JNJ',  companyName: 'Johnson & Johnson' },
    { symbol: 'PG',   companyName: 'Procter & Gamble' },
    { symbol: 'KO',   companyName: 'Coca-Cola' },
    { symbol: 'WMT',  companyName: 'Walmart' },
    { symbol: 'JPM',  companyName: 'JPMorgan Chase' },
    { symbol: 'XOM',  companyName: 'ExxonMobil' },
    { symbol: 'CVX',  companyName: 'Chevron' },
    { symbol: 'HD',   companyName: 'Home Depot' },
    { symbol: 'UNH',  companyName: 'UnitedHealth Group' },
    { symbol: 'PFE',  companyName: 'Pfizer' },
    { symbol: 'ABT',  companyName: 'Abbott Laboratories' },
    { symbol: 'TMO',  companyName: 'Thermo Fisher Scientific' },
    { symbol: 'NEE',  companyName: 'NextEra Energy' },
  ],
};

// ── FMP helpers ──────────────────────────────────────────────────────────────

/**
 * FMP occasionally returns HTTP 200 with an error object instead of an array
 * e.g. { "Error Message": "Invalid API KEY." }
 * This guard normalises both failure modes into a thrown Error.
 */
function assertFmpArray(data, label) {
  if (data && typeof data === 'object' && !Array.isArray(data) && data['Error Message']) {
    throw new Error(`Data provider error (${label}): ${data['Error Message']}`);
  }
  if (!Array.isArray(data)) {
    throw new Error(`Unexpected response format from data provider (${label}).`);
  }
}

function getTickerList(sector) {
  const list = SECTOR_TICKERS[sector] ?? SECTOR_TICKERS.default;
  return list;
}

async function fetchOneTicker(symbol, key) {
  const [ratiosRes, balanceRes] = await Promise.all([
    fetch(`${FMP_BASE}/ratios/${symbol}?limit=1&apikey=${key}`),
    fetch(`${FMP_BASE}/balance-sheet-statement/${symbol}?limit=1&apikey=${key}`),
  ]);

  // Individual HTTP failures are silently skipped — the ticker is excluded from results
  if (!ratiosRes.ok || !balanceRes.ok) return null;

  const [ratiosData, balanceData] = await Promise.all([
    ratiosRes.json(),
    balanceRes.json(),
  ]);

  // FMP error objects or empty arrays → skip this ticker
  if (!Array.isArray(ratiosData)  || !ratiosData.length)  return null;
  if (!Array.isArray(balanceData) || !balanceData.length) return null;
  if (ratiosData['Error Message'] || balanceData['Error Message']) return null;

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
 * Processes tickers in sequential batches of BATCH_SIZE.
 * Promise.allSettled ensures one failed ticker never aborts the batch.
 * Returns both the enriched companies array and a count of skipped tickers.
 */
async function batchFetchRatios(tickers, key) {
  const results = [];
  let   skipped = 0;

  for (let i = 0; i < tickers.length; i += BATCH_SIZE) {
    const batch   = tickers.slice(i, i + BATCH_SIZE);
    const settled = await Promise.allSettled(
      batch.map(t => fetchOneTicker(t.symbol, key))
    );
    for (let j = 0; j < batch.length; j++) {
      const outcome = settled[j];
      if (outcome.status === 'fulfilled' && outcome.value !== null) {
        results.push({
          symbol:         batch[j].symbol,
          companyName:    batch[j].companyName ?? batch[j].symbol,
          observedValues: outcome.value,
        });
      } else {
        skipped++;
      }
    }
  }

  return { results, skipped };
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

  // ── 2. Resolve ticker list from curated registry ───────────────────────────
  const tickerList = getTickerList(sector);

  if (!tickerList.length) {
    return res.status(404).json({
      error: `No companies configured for sector "${sector}". Try a different sector.`,
    });
  }

  // ── 3. Batch-fetch ratios for each ticker ──────────────────────────────────
  const { results: companies, skipped } = await batchFetchRatios(tickerList, key);

  if (!companies.length) {
    return res.status(502).json({
      error: `Retrieved the sector ticker list (${tickerList.length} companies) but could not obtain ratio data for any of them. The data provider may be rate-limiting requests — try again in a few minutes.`,
    });
  }

  // ── 4. Build payload ────────────────────────────────────────────────────────
  const payload = {
    sector,
    cachedAt:       null,
    companies,
    // Surfaces partial-result context to the UI (informational only)
    totalRequested: tickerList.length,
    totalReturned:  companies.length,
    skipped,
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
