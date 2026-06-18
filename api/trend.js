/**
 * api/trend.js — Vercel Serverless: Sector ETF Macro Trend
 *
 * No API key required. Uses yahoo-finance2 to proxy public Yahoo Finance data.
 *
 * GET /api/trend?ticker=XLK
 *
 * Response:
 * {
 *   ticker:       string,   // e.g. "XLK"
 *   currentPrice: number,
 *   sma200:       number,   // 200-day simple moving average
 *   aboveSMA200:  boolean,
 *   momentum3m:   number,   // % change over last ~90 calendar days
 * }
 */
const yahooFinance = require('yahoo-finance2').default;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  // Cache for 1 hour at the CDN edge, serve stale up to 24 h while revalidating
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');

  const { ticker } = req.query;
  if (!ticker || typeof ticker !== 'string') {
    return res.status(400).json({ error: 'ticker query param is required' });
  }

  const symbol = ticker.trim().toUpperCase();

  try {
    // Fetch ~14 months of daily closes — enough for SMA200 (200 trading days ≈ 280 cal days)
    // plus a 90-day look-back, with comfortable margin.
    const endDate   = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 420);

    const rows = await yahooFinance.historical(symbol, {
      period1:  startDate,
      period2:  endDate,
      interval: '1d',
    }, { validateResult: false });

    if (!rows || rows.length < 200) {
      return res.status(422).json({ error: `Insufficient historical data for ${symbol}` });
    }

    // Ensure ascending date order (Yahoo typically returns descending)
    rows.sort((a, b) => new Date(a.date) - new Date(b.date));

    // Prefer adjusted close to account for splits/dividends; fall back to close
    const closes       = rows.map(r => r.adjClose ?? r.close);
    const currentPrice = closes[closes.length - 1];

    // SMA200: arithmetic mean of the last 200 trading-day closes
    const sma200Slice = closes.slice(-200);
    const sma200      = sma200Slice.reduce((sum, v) => sum + v, 0) / sma200Slice.length;
    const aboveSMA200 = currentPrice > sma200;

    // 3-Month Momentum: last trading day on or before 90 calendar days ago
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 90);

    let price90dAgo = null;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (new Date(rows[i].date) <= cutoff) {
        price90dAgo = closes[i];
        break;
      }
    }

    if (price90dAgo === null) {
      return res.status(422).json({ error: `Could not determine 90-day prior price for ${symbol}` });
    }

    const momentum3m = ((currentPrice - price90dAgo) / price90dAgo) * 100;

    return res.status(200).json({
      ticker:       symbol,
      currentPrice: +currentPrice.toFixed(2),
      sma200:       +sma200.toFixed(2),
      aboveSMA200,
      momentum3m:   +momentum3m.toFixed(2),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Failed to fetch trend data' });
  }
};
