/**
 * api/ratios.js — Vercel Serverless Proxy
 *
 * Sits between the frontend and Financial Modeling Prep (FMP).
 * The FMP_API_KEY env var never leaves the server.
 *
 * Returns only the 5 observed values consumed by FILTER_CONFIG.
 * All ratio calculation (ltd_to_nwc) is done here, not in the browser.
 *
 * GET /api/ratios?ticker=AAPL
 */
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
  const key = process.env.FMP_API_KEY;

  if (!key) {
    return res.status(500).json({
      error: 'Data provider API key is not configured. Contact the site administrator.',
    });
  }

  // ── Parallel fetch from FMP ─────────────────────────────────────────────────
  const BASE = 'https://financialmodelingprep.com/api/v3';

  let ratiosRes, balanceRes;

  try {
    [ratiosRes, balanceRes] = await Promise.all([
      fetch(`${BASE}/ratios/${symbol}?limit=1&apikey=${key}`),
      fetch(`${BASE}/balance-sheet-statement/${symbol}?limit=1&apikey=${key}`),
    ]);
  } catch {
    return res.status(502).json({
      error: 'Could not reach the data provider. Please try again shortly.',
    });
  }

  if (!ratiosRes.ok || !balanceRes.ok) {
    return res.status(502).json({
      error: `Data provider returned an error (HTTP ${ratiosRes.status} / ${balanceRes.status}).`,
    });
  }

  const [ratiosData, balanceData] = await Promise.all([
    ratiosRes.json(),
    balanceRes.json(),
  ]);

  // ── Validate FMP response shape ─────────────────────────────────────────────
  if (!Array.isArray(ratiosData) || ratiosData.length === 0) {
    return res.status(404).json({
      error: `No ratio data found for "${symbol}". Verify the ticker symbol and try again.`,
    });
  }

  if (!Array.isArray(balanceData) || balanceData.length === 0) {
    return res.status(404).json({
      error: `No balance sheet data found for "${symbol}".`,
    });
  }

  // ── Extract fields ──────────────────────────────────────────────────────────
  const r = ratiosData[0];
  const b = balanceData[0];

  // LTD to Net Working Capital: longTermDebt ÷ (totalCurrentAssets − totalCurrentLiabilities)
  // Returns null if NWC is zero (division by zero guard) or data is missing.
  const totalCurrentAssets      = b.totalCurrentAssets      ?? null;
  const totalCurrentLiabilities = b.totalCurrentLiabilities ?? null;
  const longTermDebt             = b.longTermDebt            ?? null;

  let ltdToNwc = null;
  if (
    totalCurrentAssets !== null &&
    totalCurrentLiabilities !== null &&
    longTermDebt !== null
  ) {
    const nwc = totalCurrentAssets - totalCurrentLiabilities;
    ltdToNwc = nwc !== 0 ? longTermDebt / nwc : null;
  }

  // ── Return stripped payload (no raw FMP fields exposed) ────────────────────
  return res.status(200).json({
    ticker:           symbol,
    fiscalDateEnding: r.date ?? b.date ?? null,
    observedValues: {
      current_ratio:     r.currentRatio        ?? null,
      ltd_to_nwc:        ltdToNwc,
      interest_coverage: r.interestCoverage    ?? null,
      price_to_book:     r.priceToBookRatio    ?? null,
      price_to_earnings: r.priceEarningsRatio  ?? null,
    },
  });
}
