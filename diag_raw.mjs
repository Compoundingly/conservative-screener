// diag_raw.mjs — run with: node diag_raw.mjs
import YahooFinance from 'yahoo-finance2';
const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

for (const symbol of ['AAPL', 'O']) { // O = capital-intensive REIT control case
  console.log(`\n=== ${symbol} ===`);
  const ks = await yf.quoteSummary(symbol, { modules: ['defaultKeyStatistics'] });
  console.log('enterpriseValue:', ks.defaultKeyStatistics?.enterpriseValue);
  console.log('enterpriseToEbitda:', ks.defaultKeyStatistics?.enterpriseToEbitda);

  const ts = await yf.fundamentalsTimeSeries(symbol, {
    period1: '2023-01-01',
    type: 'annual',
    module: 'all',
  });
  console.log('fundamentalsTimeSeries last period:', JSON.stringify(ts[ts.length - 1], null, 2));
}
