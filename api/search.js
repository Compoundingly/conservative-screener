/**
 * api/search.js — Stock symbol autocomplete
 *
 * GET /api/search?q=micron
 *
 * Returns up to 8 equity matches in { symbol, companyName } format.
 * Uses Yahoo Finance search; results are informational lookup only.
 */

import YahooFinance from 'yahoo-finance2';

const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=3600');

  const q = (req.query.q ?? '').trim();
  if (!q || q.length < 1) {
    return res.status(200).json({ results: [] });
  }

  try {
    const search = await yahooFinance.search(q, { quotesCount: 12, newsCount: 0 });
    const quotes = search?.quotes ?? [];

    const results = quotes
      .filter(item => {
        const type = (item.quoteType ?? '').toUpperCase();
        return type === 'EQUITY' && item.symbol && /^[A-Z]{1,6}$/.test(item.symbol);
      })
      .slice(0, 8)
      .map(item => ({
        symbol:      item.symbol,
        companyName: item.shortname ?? item.longname ?? item.symbol,
      }));

    return res.status(200).json({ results });
  } catch (err) {
    console.error('[search]', err.message);
    return res.status(502).json({ error: 'Search unavailable. Please try again.' });
  }
}
