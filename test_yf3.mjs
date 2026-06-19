import YahooFinance from 'yahoo-finance2';
const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
try {
  const rows = await yf.historical('AAPL', { period1: new Date(Date.now()-30*86400000), period2: new Date() });
  console.log('historical rows:', rows.length, rows[0]);
} catch (err) {
  console.error('historical ERROR:', err.message);
}
try {
  const q = await yf.quoteSummary('AAPL', { modules: ['financialData'] });
  console.log('financialData ok:', Object.keys(q.financialData||{}).length, 'keys');
} catch (err) {
  console.error('quoteSummary ERROR:', err.message);
}
