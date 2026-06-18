/**
 * api/ratios.js — Vercel Serverless Proxy (yahoo-finance2)
 *
 * No API key required. yahoo-finance2 proxies public Yahoo Finance endpoints.
 *
 * Modules used → fields extracted
 * ─────────────────────────────────────────────────────────────────────────────
 * financialData        → currentRatio, debtToEquity (% format, e.g. 79.5 = 0.795x)
 * defaultKeyStatistics → priceToBook, forwardPE (P/E fallback)
 * summaryDetail        → trailingPE (preferred P/E; not available in defaultKeyStatistics)
 *
 * P/E fallback chain: summaryDetail.trailingPE (positive) →
 *                     defaultKeyStatistics.forwardPE (positive) → null
 *
 * GET /api/ratios?ticker=AAPL
 */

import YahooFinance from 'yahoo-finance2';

const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

const MODULES = ['defaultKeyStatistics', 'financialData', 'summaryDetail'];

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * EBITDA-based interest coverage proxy.
 *
 * Direct interestExpense has been unavailable from Yahoo Finance since Nov 2024
 * (income statement submodules were removed). This proxy computes:
 *
 *   impliedInterest = totalDebt × 0.05   (conservative 5 % assumed borrowing rate)
 *   coverage        = ebitda / impliedInterest
 *
 * EBITDA is used (not operatingMargins × revenue) because depreciation on real
 * assets heavily depresses GAAP operating income for capital-intensive sectors
 * such as REITs, utilities and infrastructure — EBITDA gives a fair cross-sector
 * comparison.  The threshold is 3.0× (investment-grade credit-analyst standard).
 *
 * Returns:
 *   null           — no debt (not applicable; caller treats as pass)
 *   null           — ebitda unavailable (unknown; benefit of the doubt)
 *   0              — negative EBITDA (definitively fails)
 *   positive float — computed EBITDA coverage ratio
 */
function computeInterestCoverage(fd) {
  const totalDebt = fd.totalDebt ?? null;
  if (totalDebt === null || totalDebt <= 0) return null; // no debt → no interest risk

  const ebitda = fd.ebitda ?? null;
  if (ebitda === null) return null; // insufficient data

  if (ebitda <= 0) return 0; // negative EBITDA → fails any coverage threshold

  return ebitda / (totalDebt * 0.05); // EBITDA / implied annual interest at 5%
}

/**
 * Robust P/E extraction.
 * Prefers trailing P/E; negative P/E (loss-making companies) is treated as
 * unusable data and falls back to forward P/E. Returns null if both are absent.
 */
function extractPE(ks, sd) {
  const trailing = (sd?.trailingPE  != null && sd.trailingPE  > 0) ? sd.trailingPE  : null;
  const forward  = (ks?.forwardPE   != null && ks.forwardPE   > 0) ? ks.forwardPE   : null;
  return trailing ?? forward ?? null;
}

// ── Handler ──────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  const { ticker } = req.query;

  if (!ticker || !/^[A-Za-z]{1,6}$/.test(ticker)) {
    return res.status(400).json({
      error: 'Invalid ticker symbol. Use 1–6 letters (e.g. AAPL).',
    });
  }

  const symbol = ticker.toUpperCase();

  let result;

  try {
    result = await yahooFinance.quoteSummary(symbol, { modules: MODULES });
  } catch (err) {
    if (err.result) {
      result = err.result; // FailedYahooValidation — partial result is still usable
    } else {
      const msg = err.message ?? '';
      const status = msg.toLowerCase().includes('no fundamentals') ? 404 : 502;
      return res.status(status).json({
        error: status === 404
          ? `No data found for "${symbol}". Verify the ticker symbol and try again.`
          : `Data retrieval failed: ${msg}`,
      });
    }
  }

  const ks = result.defaultKeyStatistics ?? {};
  const fd = result.financialData        ?? {};
  const sd = result.summaryDetail        ?? {};

  return res.status(200).json({
    ticker:           symbol,
    fiscalDateEnding: null,
    observedValues: {
      current_ratio:     fd.currentRatio   ?? null,
      debt_to_equity:    fd.debtToEquity   ?? null,
      price_to_book:     ks.priceToBook    ?? null,
      price_to_earnings: extractPE(ks, sd),
      // Structural Risk inputs — all decimal format
      revenue_growth:    fd.revenueGrowth  ?? null,  // 0.18 = 18% TTM growth
      return_on_equity:  fd.returnOnEquity ?? null,  // 0.34 = 34% TTM ROE
      payout_ratio:      sd.payoutRatio    ?? null,  // 0.40 = 40% payout; null/0 = no dividend
      interest_coverage: computeInterestCoverage(fd), // proxy: op.income / (totalDebt × 5%)
    },
  });
}
