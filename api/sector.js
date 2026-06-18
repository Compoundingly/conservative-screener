/**
 * api/sector.js — Vercel Serverless: Bulk Sector Scan (Alpha Vantage)
 *
 * Flow:
 *   1. Check Vultr Redis cache — return immediately on hit (24h TTL)
 *   2. Cache miss: resolve curated ticker list for the requested sector
 *   3. Batch-fetch 3 AV endpoints per ticker (OVERVIEW, BALANCE_SHEET, INCOME_STATEMENT)
 *   4. Compute current_ratio, ltd_to_nwc, interest_coverage server-side
 *   5. Write result to Vultr cache
 *   6. Return enriched company array to frontend
 *
 * GET /api/sector?sector=Real+Estate
 *
 * Rate limits (Alpha Vantage free tier): 25 req/day · 5 req/min
 * ─────────────────────────────────────────────────────────────────────────────
 * A full sector scan (15 tickers × 3 calls = 45 requests) exceeds the free
 * tier daily limit. Options:
 *   • Upgrade to AV premium ($50/mo, 75 req/min, no daily cap).
 *   • Use the Vultr VPS cache to pre-warm data via a nightly cron job.
 *   • The `skipped` count in the response surfaces partial results gracefully.
 *
 * Response shape:
 * {
 *   sector:         string,
 *   cachedAt:       string | null,
 *   companies:      [{ symbol, companyName, observedValues }],
 *   totalRequested: number,
 *   totalReturned:  number,
 *   skipped:        number,
 * }
 */

const AV_BASE    = 'https://www.alphavantage.co/query';
const BATCH_SIZE = 3; // conservative batch size to reduce burst rate-limit hits

// ── Sector ticker registry ───────────────────────────────────────────────────
// Curated lists of large, established companies per sector.
// Appropriate for a conservative screener — stable universe, no dynamic screener call.

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
    { symbol: 'LOW',  companyName: "Lowe's Companies" },
    { symbol: 'KR',   companyName: 'Kroger' },
    { symbol: 'DG',   companyName: 'Dollar General' },
    { symbol: 'DLTR', companyName: 'Dollar Tree' },
    { symbol: 'TJX',  companyName: 'TJX Companies' },
    { symbol: 'ROST', companyName: 'Ross Stores' },
    { symbol: 'AZO',  companyName: 'AutoZone' },
    { symbol: 'ORLY', companyName: "O'Reilly Automotive" },
    { symbol: 'BBY',  companyName: 'Best Buy' },
    { symbol: 'M',    companyName: "Macy's" },
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

// ── Cache helpers ────────────────────────────────────────────────────────────
// VULTR_CACHE_URL and VULTR_CACHE_SECRET are fully optional. If absent or if
// the VPS is unreachable, the system falls back to direct AV calls.

async function readCache(cacheUrl, secret, key) {
  try {
    const res = await fetch(
      `${cacheUrl}/cache?key=${encodeURIComponent(key)}`,
      { headers: { 'X-Cache-Secret': secret }, signal: AbortSignal.timeout(3000) }
    );
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
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
    console.warn(`[cs-cache] write failed (${key}): ${err.message}`);
  }
}

// ── Alpha Vantage helpers ────────────────────────────────────────────────────

/** Coerces AV string numbers; "None" and missing values → null. */
function parseNum(val) {
  if (val === null || val === undefined || val === 'None' || val === '-') return null;
  const n = parseFloat(val);
  return isNaN(n) ? null : n;
}

/** Returns true if AV responded with a rate-limit or key-error envelope. */
function isAvRateLimited(data) {
  return !!(data?.Note || data?.Information);
}

/**
 * Derives the 5 observed values from parsed AV response objects.
 * Pure computation — no fetching or DOM access.
 */
function computeObservedValues(overview, bs, is_) {
  const tca    = parseNum(bs.totalCurrentAssets);
  const tcl    = parseNum(bs.totalCurrentLiabilities);
  const ltd    = parseNum(bs.longTermDebt);
  const ebit   = parseNum(is_.ebit);
  const intExp = parseNum(is_.interestAndDebtExpense)
              ?? parseNum(is_.interestExpense); // fallback field name

  const currentRatio = (tca !== null && tcl !== null && tcl !== 0)
    ? tca / tcl : null;

  const nwc      = (tca !== null && tcl !== null) ? tca - tcl : null;
  const ltdToNwc = (ltd !== null && nwc !== null && nwc !== 0)
    ? ltd / nwc : null;

  const interestCoverage = (ebit !== null && intExp !== null && intExp !== 0)
    ? ebit / intExp : null;

  return {
    current_ratio:     currentRatio,
    ltd_to_nwc:        ltdToNwc,
    interest_coverage: interestCoverage,
    price_to_book:     parseNum(overview.PriceToBookRatio),
    price_to_earnings: parseNum(overview.PERatio),
  };
}

/**
 * Fetches all three AV endpoints for one ticker.
 * Returns null (ticker is skipped) on any failure or rate-limit response.
 */
async function fetchOneTicker(symbol, key) {
  let overviewRes, balanceRes, incomeRes;

  try {
    [overviewRes, balanceRes, incomeRes] = await Promise.all([
      fetch(`${AV_BASE}?function=OVERVIEW&symbol=${symbol}&apikey=${key}`),
      fetch(`${AV_BASE}?function=BALANCE_SHEET&symbol=${symbol}&apikey=${key}`),
      fetch(`${AV_BASE}?function=INCOME_STATEMENT&symbol=${symbol}&apikey=${key}`),
    ]);
  } catch {
    return null;
  }

  if (!overviewRes.ok || !balanceRes.ok || !incomeRes.ok) return null;

  const [overview, balance, income] = await Promise.all([
    overviewRes.json(),
    balanceRes.json(),
    incomeRes.json(),
  ]);

  // Rate-limited or key error → skip ticker, do not abort the whole batch
  if (isAvRateLimited(overview) || isAvRateLimited(balance) || isAvRateLimited(income)) {
    console.warn(`[av] rate-limited on ${symbol}`);
    return null;
  }

  // AV returns an empty object {} for unknown symbols
  if (!overview.Symbol) return null;

  const bs  = balance.annualReports?.[0]  ?? {};
  const is_ = income.annualReports?.[0]   ?? {};

  return computeObservedValues(overview, bs, is_);
}

/**
 * Processes tickers in sequential batches of BATCH_SIZE.
 * Promise.allSettled prevents one failed ticker from aborting the batch.
 * Returns { results, skipped } for partial-result surfacing in the response.
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

  const key         = process.env.ALPHA_VANTAGE_API_KEY;
  const cacheUrl    = process.env.VULTR_CACHE_URL;
  const cacheSecret = process.env.VULTR_CACHE_SECRET;

  if (!key) {
    return res.status(500).json({
      error: 'Data provider API key is not configured.',
    });
  }

  const cacheKey = `av:sector:${sector}`;

  // ── 1. Check Vultr cache ────────────────────────────────────────────────────
  if (cacheUrl && cacheSecret) {
    const cached = await readCache(cacheUrl, cacheSecret, cacheKey);
    if (cached) return res.status(200).json(cached);
  }

  // ── 2. Resolve curated ticker list ─────────────────────────────────────────
  const tickerList = SECTOR_TICKERS[sector] ?? SECTOR_TICKERS.default;

  if (!tickerList.length) {
    return res.status(404).json({
      error: `No companies configured for sector "${sector}". Try a different sector.`,
    });
  }

  // ── 3. Batch-fetch from Alpha Vantage ──────────────────────────────────────
  const { results: companies, skipped } = await batchFetchRatios(tickerList, key);

  if (!companies.length) {
    return res.status(429).json({
      error:
        `Retrieved ${tickerList.length} tickers for this sector but could not obtain ` +
        'ratio data for any of them. The Alpha Vantage free tier allows 25 requests/day ' +
        'and 5/min. Wait a minute and try again, or upgrade your API plan.',
    });
  }

  // ── 4. Build and cache payload ─────────────────────────────────────────────
  const payload = {
    sector,
    cachedAt:       null,
    companies,
    totalRequested: tickerList.length,
    totalReturned:  companies.length,
    skipped,
  };

  if (cacheUrl && cacheSecret) {
    await writeCache(cacheUrl, cacheSecret, cacheKey, {
      ...payload,
      cachedAt: new Date().toISOString(),
    });
  }

  return res.status(200).json(payload);
}
