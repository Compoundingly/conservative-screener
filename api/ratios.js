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
      current_ratio:     fd.currentRatio  ?? null,
      debt_to_equity:    fd.debtToEquity  ?? null,
      price_to_book:     ks.priceToBook   ?? null,
      price_to_earnings: extractPE(ks, sd),
    },
  });
}
