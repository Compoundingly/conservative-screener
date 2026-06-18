/**
 * api/sector.js — Vercel Serverless: Bulk Sector Scan (yahoo-finance2)
 *
 * No API key required. yahoo-finance2 proxies public Yahoo Finance endpoints.
 *
 * Flow:
 *   1. Check Vultr Redis cache — return immediately on hit (24h TTL)
 *   2. Cache miss: resolve curated ticker list for the requested sector
 *   3. Fetch all tickers concurrently with Promise.allSettled
 *   4. Write result to Vultr cache
 *   5. Return enriched company array to frontend
 *
 * GET /api/sector?sector=Real+Estate
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

import YahooFinance from 'yahoo-finance2';

const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

// summaryDetail is included solely for trailingPE, which is absent from defaultKeyStatistics.
// P/E fallback chain: summaryDetail.trailingPE (positive) →
//                     defaultKeyStatistics.forwardPE (positive) → null
const MODULES = ['defaultKeyStatistics', 'financialData', 'summaryDetail'];

function extractPE(ks, sd) {
  const trailing = (sd?.trailingPE != null && sd.trailingPE > 0) ? sd.trailingPE : null;
  const forward  = (ks?.forwardPE  != null && ks.forwardPE  > 0) ? ks.forwardPE  : null;
  return trailing ?? forward ?? null;
}

// ── Sector ticker registry ───────────────────────────────────────────────────

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
    { symbol: 'SBAC', companyName: 'SBA Communications' },
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
// VULTR_CACHE_URL and VULTR_CACHE_SECRET are fully optional.

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

// ── Data fetching ────────────────────────────────────────────────────────────

/**
 * Fetches Yahoo Finance data for one ticker.
 * Returns the observedValues object, or null if the ticker should be skipped.
 * FailedYahooValidation errors are handled gracefully via err.result.
 */
async function fetchOneTicker(symbol) {
  let result;

  try {
    result = await yahooFinance.quoteSummary(symbol, { modules: MODULES });
  } catch (err) {
    if (err.result) {
      result = err.result;
    } else {
      console.warn(`[yf] skipping ${symbol}: ${err.message}`);
      return null;
    }
  }

  const ks = result.defaultKeyStatistics ?? {};
  const fd = result.financialData        ?? {};
  const sd = result.summaryDetail        ?? {};

  return {
    current_ratio:     fd.currentRatio  ?? null,
    debt_to_equity:    fd.debtToEquity  ?? null,
    price_to_book:     ks.priceToBook   ?? null,
    price_to_earnings: extractPE(ks, sd),
  };
}

/**
 * Fetches all tickers concurrently. Promise.allSettled ensures one failed
 * ticker never aborts the batch. Returns { results, skipped }.
 */
async function fetchAllTickers(tickers) {
  const settled = await Promise.allSettled(
    tickers.map(t => fetchOneTicker(t.symbol))
  );

  const results = [];
  let   skipped = 0;

  for (let i = 0; i < tickers.length; i++) {
    const outcome = settled[i];
    if (outcome.status === 'fulfilled' && outcome.value !== null) {
      results.push({
        symbol:         tickers[i].symbol,
        companyName:    tickers[i].companyName ?? tickers[i].symbol,
        observedValues: outcome.value,
      });
    } else {
      skipped++;
    }
  }

  return { results, skipped };
}

// ── Handler ──────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  const { sector = 'default' } = req.query;

  const cacheUrl    = process.env.VULTR_CACHE_URL;
  const cacheSecret = process.env.VULTR_CACHE_SECRET;

  const cacheKey = `yf:sector:${sector}`;

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

  // ── 3. Fetch all tickers concurrently ──────────────────────────────────────
  const { results: companies, skipped } = await fetchAllTickers(tickerList);

  if (!companies.length) {
    return res.status(502).json({
      error: 'Could not retrieve data for any company in this sector. Yahoo Finance may be temporarily unavailable — try again in a moment.',
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
