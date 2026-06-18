/**
 * api/ratios.js — Vercel Serverless Proxy (Alpha Vantage)
 *
 * Fetches three Alpha Vantage endpoints in parallel and returns the 5 observed
 * values consumed by FIELD_REGISTRY / SECTOR_CONFIG on the frontend.
 *
 * Endpoint → fields used
 * ─────────────────────────────────────────────────────────────────────────────
 * OVERVIEW          → PERatio, PriceToBookRatio
 * BALANCE_SHEET     → totalCurrentAssets, totalCurrentLiabilities, longTermDebt
 *                     → computes current_ratio, ltd_to_nwc
 * INCOME_STATEMENT  → ebit, interestAndDebtExpense
 *                     → computes interest_coverage
 *
 * GET /api/ratios?ticker=AAPL
 *
 * Rate limits (Alpha Vantage free tier): 25 req/day · 5 req/min
 * Single-ticker lookup costs 3 requests — comfortably within free limits.
 */

const AV_BASE = 'https://www.alphavantage.co/query';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * AV returns all numeric fields as strings. "None" means data unavailable.
 * Returns null for missing, "None", or NaN values.
 */
function parseNum(val) {
  if (val === null || val === undefined || val === 'None' || val === '-') return null;
  const n = parseFloat(val);
  return isNaN(n) ? null : n;
}

/**
 * Alpha Vantage sends rate-limit and key errors as HTTP 200 with a
 * Note or Information field instead of an error status code.
 */
function assertNotRateLimited(data, fn) {
  if (data?.Note) {
    throw new Error(
      `Alpha Vantage rate limit reached (${fn}). Free tier allows 25 requests/day and 5/min. ` +
      'Wait a minute and try again, or upgrade your API plan.'
    );
  }
  if (data?.Information) {
    throw new Error(`Alpha Vantage API key issue (${fn}): ${data.Information}`);
  }
}

/**
 * Derives the 5 observed values from parsed AV response objects.
 * Pure calculation — no fetching, no DOM, no side effects.
 */
function computeObservedValues(overview, bs, is_) {
  const tca  = parseNum(bs.totalCurrentAssets);
  const tcl  = parseNum(bs.totalCurrentLiabilities);
  const ltd  = parseNum(bs.longTermDebt);
  const ebit = parseNum(is_.ebit);
  // AV field name: interestAndDebtExpense; fall back to interestExpense
  const intExp = parseNum(is_.interestAndDebtExpense) ?? parseNum(is_.interestExpense);

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

// ── Handler ──────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  // ── Input validation ────────────────────────────────────────────────────────
  const { ticker } = req.query;

  if (!ticker || !/^[A-Za-z]{1,5}$/.test(ticker)) {
    return res.status(400).json({
      error: 'Invalid ticker symbol. Use 1–5 letters (e.g. AAPL).',
    });
  }

  const symbol = ticker.toUpperCase();

  // ── API key guard ───────────────────────────────────────────────────────────
  const key = process.env.ALPHA_VANTAGE_API_KEY;

  if (!key) {
    return res.status(500).json({
      error: 'Data provider API key is not configured. Contact the site administrator.',
    });
  }

  // ── Sequential fetch (3 AV calls, 1 per second) ─────────────────────────────
  // AV free tier enforces 1 request/second. Parallel calls trip the rate limiter
  // and return an Information envelope instead of data.
  const delay = ms => new Promise(r => setTimeout(r, ms));

  let overview, balance, income;

  try {
    const avFetch = async fn => {
      const r = await fetch(`${AV_BASE}?function=${fn}&symbol=${symbol}&apikey=${key}`);
      if (!r.ok) throw new Error(`Data provider returned HTTP ${r.status} for ${fn}.`);
      const d = await r.json();
      assertNotRateLimited(d, fn);
      return d;
    };

    overview = await avFetch('OVERVIEW');
    await delay(1100);
    balance  = await avFetch('BALANCE_SHEET');
    await delay(1100);
    income   = await avFetch('INCOME_STATEMENT');
  } catch (err) {
    const status = err.message.includes('rate limit') ? 429 : 502;
    return res.status(status).json({ error: err.message });
  }

  // ── Validate response ───────────────────────────────────────────────────────
  if (!overview.Symbol) {
    return res.status(404).json({
      error: `No data found for "${symbol}". Verify the ticker symbol and try again.`,
    });
  }

  // ── Extract, compute, return ────────────────────────────────────────────────
  const bs  = balance.annualReports?.[0]  ?? {};
  const is_ = income.annualReports?.[0]   ?? {};

  return res.status(200).json({
    ticker:           symbol,
    fiscalDateEnding: bs.fiscalDateEnding ?? null,
    observedValues:   computeObservedValues(overview, bs, is_),
  });
}
