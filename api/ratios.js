/**
 * api/ratios.js — Vercel Serverless Proxy (yahoo-finance2)
 *
 * No API key required. yahoo-finance2 proxies public Yahoo Finance endpoints.
 *
 * Modules used → fields extracted
 * ─────────────────────────────────────────────────────────────────────────────
 * financialData      → currentRatio, debtToEquity (as %, e.g. 79.5 = 79.5% D/E)
 * defaultKeyStatistics → priceToBook, forwardPE (fallback for P/E)
 * summaryDetail      → trailingPE (preferred P/E)
 *
 * GET /api/ratios?ticker=AAPL
 */

import YahooFinance from 'yahoo-finance2';

const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

const MODULES = ['defaultKeyStatistics', 'financialData', 'summaryDetail'];

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  // ── Input validation ────────────────────────────────────────────────────────
  const { ticker } = req.query;

  if (!ticker || !/^[A-Za-z]{1,6}$/.test(ticker)) {
    return res.status(400).json({
      error: 'Invalid ticker symbol. Use 1–6 letters (e.g. AAPL).',
    });
  }

  const symbol = ticker.toUpperCase();

  // ── Fetch from Yahoo Finance ─────────────────────────────────────────────────
  let result;

  try {
    result = await yahooFinance.quoteSummary(symbol, { modules: MODULES });
  } catch (err) {
    // FailedYahooValidation still carries a partial result — use it
    if (err.result) {
      result = err.result;
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
    ticker,
    fiscalDateEnding: null,
    observedValues: {
      current_ratio:     fd.currentRatio  ?? null,
      debt_to_equity:    fd.debtToEquity  ?? null,   // Yahoo Finance % format (79.5 = 0.795x D/E)
      price_to_book:     ks.priceToBook   ?? null,
      price_to_earnings: sd.trailingPE    ?? ks.forwardPE ?? null,
    },
  });
}
