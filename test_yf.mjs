import YahooFinance from 'yahoo-finance2';
const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

const MODULES = ['defaultKeyStatistics','financialData','summaryDetail','cashflowStatementHistory','incomeStatementHistory','balanceSheetHistory'];

try {
  const r = await yf.quoteSummary('AAPL', { modules: MODULES });
  console.log('=== financialData keys ===');
  console.log(Object.keys(r.financialData || {}));
  console.log('=== defaultKeyStatistics keys ===');
  console.log(Object.keys(r.defaultKeyStatistics || {}));
  console.log('=== summaryDetail keys (marketCap?) ===');
  console.log('marketCap' in (r.summaryDetail||{}), 'marketCap' in (r.defaultKeyStatistics||{}), 'marketCap' in (r.financialData||{}));
  console.log('=== cashflowStatementHistory ===');
  console.log(JSON.stringify(r.cashflowStatementHistory, null, 2)?.slice(0, 2000));
  console.log('=== incomeStatementHistory ===');
  console.log(JSON.stringify(r.incomeStatementHistory, null, 2)?.slice(0, 1500));
} catch (err) {
  console.error('ERROR:', err.message);
  if (err.result) {
    console.log('--- partial result available ---');
    console.log('financialData:', Object.keys(err.result.financialData || {}));
    console.log('cashflowStatementHistory:', JSON.stringify(err.result.cashflowStatementHistory, null,2)?.slice(0,2000));
    console.log('incomeStatementHistory:', JSON.stringify(err.result.incomeStatementHistory, null,2)?.slice(0,1500));
  }
}
