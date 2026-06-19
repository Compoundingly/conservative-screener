import YahooFinance from 'yahoo-finance2';
const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

for (const symbol of ['AAPL', 'O']) {
  const ts = await yf.fundamentalsTimeSeries(symbol, {
    period1: '2025-01-01',
    type: 'annual',
    module: 'all'
  });
  if (ts && ts.length > 0) {
    const last = ts[ts.length - 1];
    console.log(`\n--- ${symbol} EBIT Key Casing ---`);
    console.log(Object.keys(last).filter(k => k.toLowerCase() === 'ebit'));
  }
}
