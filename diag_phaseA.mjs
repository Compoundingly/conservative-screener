// diag_phaseA.mjs — run with: node diag_phaseA.mjs
//// Phase A diagnostic — verification only, no application code changes.
// 1. Confirm Yahoo's assetProfile sector/industry fields populate, across both
//    our existing curated sectors AND a few names NOT in any current
//    SECTOR_TICKERS list — testing real all-market coverage, not just our
//    9 hand-picked buckets.
// 2. Pull the real NASDAQ Trader symbol directory and get an actual
//    active-ticker count (raw, then after a basic ETF/test-issue filter).
// 3. Tabulate Yahoo's raw sector strings against our existing SECTOR_CONFIG
//    keys to see the exact mapping gaps.

import YahooFinance from 'yahoo-finance2';

const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

// ── 1 & 3: Sector field check + raw-string tabulation ───────────────────────

const SAMPLE_TICKERS = [
  'AAPL', 'MSFT',   // Technology (curated)
  'O', 'PLD',       // Real Estate (curated)
  'JPM', 'SOFI',    // Financials — SOFI uncurated, fintech classification edge case
  'NEE', 'DUK',     // Utilities (curated)
  'XOM', 'CVX',     // Energy (curated)
  'KO', 'PG',       // Consumer Staples (curated)
  'WMT', 'CROX',    // Retail — CROX uncurated, apparel edge case
  'JNJ', 'DXCM',    // Healthcare — DXCM uncurated, medtech edge case
  'CAT', 'PLTR',    // Industrials — PLTR uncurated, ambiguous tech/defense classification
];

const EXISTING_SECTOR_KEYS = [
  'Real Estate', 'Retail', 'Technology', 'Utilities', 'Healthcare',
  'Consumer Staples', 'Energy', 'Financials', 'Industrials',
];

const sectorCounts = {};
const results = [];

console.log('=== 1 & 3: assetProfile sector/industry check ===\n');

for (const symbol of SAMPLE_TICKERS) {
  try {
    const r = await yf.quoteSummary(symbol, { modules: ['assetProfile'] });
    const ap = r.assetProfile ?? {};

    const row = {
      symbol,
      sector: ap.sector ?? null,
      sectorDisp: ap.sectorDisp ?? null,
      industry: ap.industry ?? null,
      industryDisp: ap.industryDisp ?? null,
    };
    results.push(row);

    const key = row.sectorDisp ?? row.sector ?? '(missing)';
    sectorCounts[key] = (sectorCounts[key] ?? 0) + 1;

    console.log(symbol.padEnd(6), JSON.stringify(row));
  } catch (err) {
    console.log(symbol.padEnd(6), 'ERROR:', err.message);
    results.push({ symbol, error: err.message });
  }
}

console.log('\n=== Raw sector string frequency (this sample) ===');
console.log(sectorCounts);

console.log('\n=== Mapping gap check vs. existing SECTOR_CONFIG keys ===');
const rawSectorStrings = [...new Set(results.map(r => r.sectorDisp ?? r.sector).filter(Boolean))];

for (const s of rawSectorStrings) {
  const matches = EXISTING_SECTOR_KEYS.includes(s);
  console.log(`"${s}"`.padEnd(30), matches ? '✓ exact match' : '✗ NO EXACT MATCH — needs mapping');
}

// ── 2: NASDAQ Trader symbol directory — real active-ticker count ───────────

console.log('\n=== 2: NASDAQ Trader symbol directory ===\n');

async function fetchSymbolFile(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.text();
}

function parsePipeDelimited(text) {
  const lines = text.trim().split('\n');
  const header = lines[0].split('|');
  const dataLines = lines.slice(1, -1);
  return dataLines.map(line => {
    const cols = line.split('|');
    const obj = {};
    header.forEach((h, i) => { obj[h.trim()] = cols[i]; });
    return obj;
  });
}

try {
  const [nasdaqRaw, otherRaw] = await Promise.all([
    fetchSymbolFile('https://www.nasdaqtrader.com/dynamic/symdir/nasdaqlisted.txt'),
    fetchSymbolFile('https://www.nasdaqtrader.com/dynamic/symdir/otherlisted.txt'),
  ]);

  const nasdaqRows = parsePipeDelimited(nasdaqRaw);
  const otherRows  = parsePipeDelimited(otherRaw);

  console.log('nasdaqlisted.txt — raw row count:', nasdaqRows.length);
  console.log('otherlisted.txt  — raw row count:', otherRows.length);
  console.log('Combined raw total:', nasdaqRows.length + otherRows.length);

  console.log('\nSample nasdaqlisted.txt row (verify column names against this):', nasdaqRows[0]);
  console.log('Sample otherlisted.txt row (verify column names against this):', otherRows[0]);

  const nasdaqFiltered = nasdaqRows.filter(r => r['Test Issue'] === 'N' && r['ETF'] === 'N');
  const otherFiltered  = otherRows.filter(r => r['Test Issue'] === 'N' && r['ETF'] === 'N');

  console.log('\nAfter Test Issue=N & ETF=N filter:');
  console.log('nasdaqlisted.txt filtered count:', nasdaqFiltered.length);
  console.log('otherlisted.txt filtered count:', otherFiltered.length);
  console.log('Combined filtered total:', nasdaqFiltered.length + otherFiltered.length);

} catch (err) {
  console.log('NASDAQ Trader fetch ERROR:', err.message);
  console.log('Fallback if this host blocks the request: ftp://ftp.nasdaqtrader.com/SymbolDirectory/');
}
