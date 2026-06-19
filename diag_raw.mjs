// diag_raw.mjs — run with: node diag_raw.mjs
import YahooFinance from 'yahoo-finance2';
const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

const FIELDS = [
  'EBIT',
  'freeCashFlow',
  'operatingCashFlow',
  'capitalExpenditure',
  'depreciationAndAmortization',
  'changeInWorkingCapital',
];

for (const symbol of ['AAPL', 'O']) {
  console.log(`\n=== ${symbol} ===`);

  const ts = await yf.fundamentalsTimeSeries(symbol, {
    period1: '2023-01-01',
    type: 'annual',
    module: 'all',
  });

  const last = ts[ts.length - 1];
  console.log('period:', last?.date);
  for (const field of FIELDS) {
    console.log(`  ${field}:`, last?.[field] ?? 'N/A');
  }
}
