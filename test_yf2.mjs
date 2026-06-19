import YahooFinance from 'yahoo-finance2';
const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

try {
  const r = await yf.fundamentalsTimeSeries('AAPL', {
    period1: '2023-01-01',
    type: 'annual',
    module: 'all',
  });
  console.log('Got', r.length, 'periods');
  console.log(JSON.stringify(r[r.length-1], null, 2));
} catch (err) {
  console.error('ERROR:', err.message);
}
