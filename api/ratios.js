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

  // ── Parallel fetch (3 AV calls) ─────────────────────────────────────────────
  let overviewRes, balanceRes, incomeRes;

  try {
    [overviewRes, balanceRes, incomeRes] = await Promise.all([
      fetch(`${AV_BASE}?function=OVERVIEW&symbol=${symbol}&apikey=${key}`),
      fetch(`${AV_BASE}?function=BALANCE_SHEET&symbol=${symbol}&apikey=${key}`),
      fetch(`${AV_BASE}?function=INCOME_STATEMENT&symbol=${symbol}&apikey=${key}`),
    ]);
  } catch {
    return res.status(502).json({
      error: 'Could not reach the data provider. Please try again shortly.',
    });
  }

  if (!overviewRes.ok || !balanceRes.ok || !incomeRes.ok) {
    return res.status(502).json({
      error: `Data provider returned an error (HTTP ${overviewRes.status} / ${balanceRes.status} / ${incomeRes.status}).`,
    });
  }

  let overview, balance, income;

  try {
    [overview, balance, income] = await Promise.all([
      overviewRes.json(),
      balanceRes.json(),
      incomeRes.json(),
    ]);

    assertNotRateLimited(overview, 'OVERVIEW');
    assertNotRateLimited(balance,  'BALANCE_SHEET');
    assertNotRateLimited(income,   'INCOME_STATEMENT');
  } catch (err) {
    return res.status(429).json({ error: err.message });
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
