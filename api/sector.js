/**
 * api/sector.js — Vercel Serverless: Bulk Sector Scan (yahoo-finance2)
 *
 * No API key required. yahoo-finance2 proxies public Yahoo Finance endpoints.
 *
 * Flow:
 *   1. Check Vultr Redis cache — return immediately on hit (24h TTL)
 *   2. Cache miss: resolve curated ticker list for the requested sector
 *   3. Fetch all tickers concurrently with Promise.allSettled
 *   4. Write result to Vultr cache
 *   5. Return enriched company array to frontend
 *
 * GET /api/sector?sector=Real+Estate
 *
 * Response shape:
 * {
 *   sector:         string,
 *   cachedAt:       string | null,
 *   companies:      [{ symbol, companyName, observedValues }],
 *   totalRequested: number,
 *   totalReturned:  number,
 *   skipped:        number,
 * }
 */

import YahooFinance from 'yahoo-finance2';

const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

// summaryDetail is included solely for trailingPE, which is absent from defaultKeyStatistics.
// P/E fallback chain: summaryDetail.trailingPE (positive) →
//                     defaultKeyStatistics.forwardPE (positive) → null
const MODULES = ['defaultKeyStatistics', 'financialData', 'summaryDetail'];

const TAX = 0.21; // US corporate tax rate — shared by computeReinvestmentRate and computeROIC

function extractPE(ks, sd) {
  const trailing = (sd?.trailingPE != null && sd.trailingPE > 0) ? sd.trailingPE : null;
  const forward  = (ks?.forwardPE  != null && ks.forwardPE  > 0) ? ks.forwardPE  : null;
  return trailing ?? forward ?? null;
}

/**
 * EBITDA-based interest coverage proxy.
 *
 * Direct interestExpense has been unavailable from Yahoo Finance since Nov 2024
 * (income statement submodules were removed). This proxy computes:
 *
 *   impliedInterest = totalDebt × 0.05   (conservative 5 % assumed borrowing rate)
 *   coverage        = ebitda / impliedInterest
 *
 * EBITDA is used (not operatingMargins × revenue) because depreciation on real
 * assets heavily depresses GAAP operating income for capital-intensive sectors
 * such as REITs, utilities and infrastructure — EBITDA gives a fair cross-sector
 * comparison.  The threshold is 3.0× (investment-grade credit-analyst standard).
 *
 * Returns:
 *   null           — no debt (not applicable; caller treats as pass)
 *   null           — ebitda unavailable (unknown; benefit of the doubt)
 *   0              — negative EBITDA (definitively fails)
 *   positive float — computed EBITDA coverage ratio
 */
function computeInterestCoverage(fd) {
  const totalDebt = fd.totalDebt ?? null;
  if (totalDebt === null || totalDebt <= 0) return null; // no debt → no interest risk

  const ebitda = fd.ebitda ?? null;
  if (ebitda === null) return null; // insufficient data

  if (ebitda <= 0) return 0; // negative EBITDA → fails any coverage threshold

  return ebitda / (totalDebt * 0.05); // EBITDA / implied annual interest at 5%
}

/**
 * Cash ROIC (Return on Invested Capital) — Mauboussin cash-earnings approach.
 *
 * Formula:
 *   Cash NOPAT    = EBITDA × (1 − 0.21)           [EBITDA ≈ cash operating earnings]
 *   Stockholders' Equity derived from D/E ratio:   equity = totalDebt / (debtToEquity/100)
 *   Fallback (zero-debt companies):                equity = netIncome / returnOnEquity
 *   Invested Capital = equity + totalDebt − totalCash
 *   ROIC             = Cash NOPAT / Invested Capital
 *
 * Using EBITDA so depreciation on real assets does not distort results for
 * capital-intensive sectors. Aligns with Mauboussin's "cash earnings" definition.
 * Assumptions: US corporate tax = 21%. Returns null when inputs are insufficient.
 */
function computeROIC(fd) {
  const ebitda = fd.ebitda       ?? null;
  const td     = fd.totalDebt    ?? 0;
  const de     = fd.debtToEquity ?? null;   // Yahoo Finance % format: 100 = 1.0×
  const cash   = fd.totalCash    ?? 0;

  if (ebitda === null) return null;

  // Derive stockholders' equity
  let equity = null;
  if (de !== null && de > 0 && td > 0) {
    equity = td / (de / 100);
  } else if (td === 0) {
    const roe = fd.returnOnEquity ?? null;
    const pm  = fd.profitMargins  ?? null;
    const rev = fd.totalRevenue   ?? null;
    if (roe && roe !== 0 && pm !== null && rev !== null) {
      equity = (pm * rev) / roe;
    }
  }

  if (equity === null || equity <= 0) return null;

  const investedCapital = equity + td - cash;
  if (investedCapital <= 0) return null;

  return (ebitda * (1 - TAX)) / investedCapital;  // decimal: 0.18 = 18%
}

/**
 * Approximate WACC via CAPM + after-tax cost of debt.
 *
 * Ke = rf + β × MRP  (CAPM);  Kd_after_tax = 5% × (1 − 0.21) = 3.95%
 * WACC = (E/V) × Ke + (D/V) × Kd_after_tax
 *
 * Constants (June 2026): rf = 4.5%, MRP = 5.5%, Kd = 5.0%, t = 21%.
 * Beta defaults to 1.0 when unavailable. For zero-debt companies WACC = Ke.
 */
function computeWACC(fd, ks) {
  const RF  = 0.045;
  const MRP = 0.055;
  const KD  = 0.05;

  const rawBeta = ks.beta ?? null;
  const beta    = (rawBeta !== null && rawBeta > 0) ? rawBeta : 1.0;
  const ke      = RF + beta * MRP;

  const td = fd.totalDebt    ?? 0;
  const de = fd.debtToEquity ?? null;

  if (td === 0 || de === null || de <= 0) return ke;

  const equity       = td / (de / 100);
  const totalCapital = equity + td;

  return (equity / totalCapital) * ke + (td / totalCapital) * KD * (1 - TAX);
}

/**
 * Reinvestment Rate = Net Reinvestment ÷ NOPAT, pre-scaled ×100 (e.g. 24.75 = 24.75 %).
 *
 * Net Reinvestment = (CapEx − D&A) + ΔWorking Capital
 * NOPAT            = EBIT × (1 − TAX)
 *
 * capitalExpenditure and changeInWorkingCapital are signed cash-flow-effect values
 * (negative = cash outflow) — confirmed via FCF = OCF + CapEx identity on live AAPL data.
 * REITs report property purchases under purchaseOfInvestmentProperties instead of
 * capitalExpenditure; that field's sign is unverified for live non-null REIT values.
 *
 * Returns null on any missing input or non-positive NOPAT.
 */
function computeReinvestmentRate(ts) {
  if (!ts) return null;
  const ebit     = ts.ebit                       ?? null;
  const da       = ts.depreciationAndAmortization ?? null;
  const wcChange = ts.changeInWorkingCapital      ?? null;
  const capexRaw = ts.capitalExpenditure          ?? ts.purchaseOfInvestmentProperties ?? null;

  if (ebit === null || da === null || wcChange === null || capexRaw === null) return null;

  const nopat = ebit * (1 - TAX);
  if (nopat <= 0) return null;

  const capexSpent      = -capexRaw;  // flip outflow-negative to positive magnitude
  const wcConsumed      = -wcChange;  // flip cash-effect sign to positive magnitude consumed
  const netReinvestment = (capexSpent - da) + wcConsumed;

  return (netReinvestment / nopat) * 100;
}

/**
 * Fetches the most recent annual fundamentalsTimeSeries period for a symbol.
 * Returns the last period object, or null if unavailable.
 */
async function fetchTimeSeries(symbol) {
  try {
    const period1 = new Date();
    period1.setFullYear(period1.getFullYear() - 2);
    const ts = await yahooFinance.fundamentalsTimeSeries(symbol, {
      period1,
      type: 'annual',
      module: 'all',
    });
    return ts?.length ? ts[ts.length - 1] : null;
  } catch (err) {
    console.warn(`[yf-ts] ${symbol}: ${err.message}`);
    return null;
  }
}

// ── Sector ticker registry ───────────────────────────────────────────────────
// All symbols verified as active on Yahoo Finance (June 2026).
// Delisted / acquired tickers excluded: JNPR (→HPE), ANSS (→SNPS), K/Kellanova
// (→Mars), WBA (→private), DFS (→COF), MRO/PXD/HES (→COP/XOM), KLG, SJW.

const SECTOR_TICKERS = {
  // ── Real Estate (REITs) ──────────────────────────────────────────────────
  'Real Estate': [
    { symbol: 'O',    companyName: 'Realty Income' },
    { symbol: 'SPG',  companyName: 'Simon Property Group' },
    { symbol: 'PLD',  companyName: 'Prologis' },
    { symbol: 'AMT',  companyName: 'American Tower' },
    { symbol: 'CCI',  companyName: 'Crown Castle' },
    { symbol: 'WELL', companyName: 'Welltower' },
    { symbol: 'AVB',  companyName: 'AvalonBay Communities' },
    { symbol: 'EQR',  companyName: 'Equity Residential' },
    { symbol: 'PSA',  companyName: 'Public Storage' },
    { symbol: 'DLR',  companyName: 'Digital Realty Trust' },
    { symbol: 'VTR',  companyName: 'Ventas' },
    { symbol: 'NNN',  companyName: 'NNN REIT' },
    { symbol: 'ARE',  companyName: 'Alexandria Real Estate' },
    { symbol: 'SBAC', companyName: 'SBA Communications' },
    { symbol: 'CBRE', companyName: 'CBRE Group' },
    { symbol: 'EXR',  companyName: 'Extra Space Storage' },
    { symbol: 'INVH', companyName: 'Invitation Homes' },
    { symbol: 'MAA',  companyName: 'Mid-America Apartment' },
    { symbol: 'UDR',  companyName: 'UDR Inc.' },
    { symbol: 'KIM',  companyName: 'Kimco Realty' },
    { symbol: 'REG',  companyName: 'Regency Centers' },
    { symbol: 'BXP',  companyName: 'Boston Properties' },
    { symbol: 'HST',  companyName: 'Host Hotels & Resorts' },
    { symbol: 'IRM',  companyName: 'Iron Mountain' },
    { symbol: 'GLPI', companyName: 'Gaming & Leisure Properties' },
    { symbol: 'VICI', companyName: 'VICI Properties' },
    { symbol: 'WPC',  companyName: 'W. P. Carey' },
    { symbol: 'STAG', companyName: 'STAG Industrial' },
    { symbol: 'CPT',  companyName: 'Camden Property Trust' },
    { symbol: 'LXP',  companyName: 'LXP Industrial Trust' },
  ],

  // ── Consumer Discretionary / Retail ─────────────────────────────────────
  'Retail': [
    { symbol: 'WMT',  companyName: 'Walmart' },
    { symbol: 'TGT',  companyName: 'Target' },
    { symbol: 'COST', companyName: 'Costco Wholesale' },
    { symbol: 'HD',   companyName: 'Home Depot' },
    { symbol: 'LOW',  companyName: "Lowe's Companies" },
    { symbol: 'KR',   companyName: 'Kroger' },
    { symbol: 'DG',   companyName: 'Dollar General' },
    { symbol: 'DLTR', companyName: 'Dollar Tree' },
    { symbol: 'TJX',  companyName: 'TJX Companies' },
    { symbol: 'ROST', companyName: 'Ross Stores' },
    { symbol: 'AZO',  companyName: 'AutoZone' },
    { symbol: 'ORLY', companyName: "O'Reilly Automotive" },
    { symbol: 'BBY',  companyName: 'Best Buy' },
    { symbol: 'M',    companyName: "Macy's" },
    { symbol: 'GPS',  companyName: 'Gap' },
    { symbol: 'NKE',  companyName: 'Nike' },
    { symbol: 'SBUX', companyName: 'Starbucks' },
    { symbol: 'MCD',  companyName: "McDonald's" },
    { symbol: 'YUM',  companyName: 'Yum! Brands' },
    { symbol: 'CMG',  companyName: 'Chipotle Mexican Grill' },
    { symbol: 'DRI',  companyName: 'Darden Restaurants' },
    { symbol: 'SYY',  companyName: 'Sysco' },
    { symbol: 'BJ',   companyName: "BJ's Wholesale" },
    { symbol: 'ULTA', companyName: 'Ulta Beauty' },
    { symbol: 'BBWI', companyName: 'Bath & Body Works' },
    { symbol: 'PVH',  companyName: 'PVH Corp.' },
    { symbol: 'RL',   companyName: 'Ralph Lauren' },
    { symbol: 'BURL', companyName: 'Burlington Stores' },
    { symbol: 'CASY', companyName: "Casey's General Stores" },
    { symbol: 'SFM',  companyName: 'Sprouts Farmers Market' },
  ],

  // ── Technology (established, profitable) ────────────────────────────────
  'Technology': [
    { symbol: 'AAPL', companyName: 'Apple' },
    { symbol: 'MSFT', companyName: 'Microsoft' },
    { symbol: 'ORCL', companyName: 'Oracle' },
    { symbol: 'IBM',  companyName: 'IBM' },
    { symbol: 'CSCO', companyName: 'Cisco Systems' },
    { symbol: 'TXN',  companyName: 'Texas Instruments' },
    { symbol: 'QCOM', companyName: 'Qualcomm' },
    { symbol: 'AVGO', companyName: 'Broadcom' },
    { symbol: 'ADI',  companyName: 'Analog Devices' },
    { symbol: 'AMAT', companyName: 'Applied Materials' },
    { symbol: 'KLAC', companyName: 'KLA Corporation' },
    { symbol: 'MSI',  companyName: 'Motorola Solutions' },
    { symbol: 'HPQ',  companyName: 'HP Inc.' },
    { symbol: 'NTAP', companyName: 'NetApp' },
    { symbol: 'INTC', companyName: 'Intel' },
    { symbol: 'MU',   companyName: 'Micron Technology' },
    { symbol: 'WDC',  companyName: 'Western Digital' },
    { symbol: 'STX',  companyName: 'Seagate Technology' },
    { symbol: 'LRCX', companyName: 'Lam Research' },
    { symbol: 'MCHP', companyName: 'Microchip Technology' },
    { symbol: 'SWKS', companyName: 'Skyworks Solutions' },
    { symbol: 'CDNS', companyName: 'Cadence Design Systems' },
    { symbol: 'SNPS', companyName: 'Synopsys' },
    { symbol: 'FFIV', companyName: 'F5 Networks' },
    { symbol: 'KEYS', companyName: 'Keysight Technologies' },
    { symbol: 'ACN',  companyName: 'Accenture' },
    { symbol: 'HPE',  companyName: 'Hewlett Packard Enterprise' },
    { symbol: 'CTSH', companyName: 'Cognizant Technology' },
    { symbol: 'VRSN', companyName: 'VeriSign' },
    { symbol: 'EPAM', companyName: 'EPAM Systems' },
  ],

  // ── Utilities ────────────────────────────────────────────────────────────
  'Utilities': [
    { symbol: 'NEE',  companyName: 'NextEra Energy' },
    { symbol: 'DUK',  companyName: 'Duke Energy' },
    { symbol: 'SO',   companyName: 'Southern Company' },
    { symbol: 'AEP',  companyName: 'American Electric Power' },
    { symbol: 'EXC',  companyName: 'Exelon' },
    { symbol: 'XEL',  companyName: 'Xcel Energy' },
    { symbol: 'SRE',  companyName: 'Sempra' },
    { symbol: 'PEG',  companyName: 'Public Service Enterprise' },
    { symbol: 'ED',   companyName: 'Consolidated Edison' },
    { symbol: 'WEC',  companyName: 'WEC Energy Group' },
    { symbol: 'ETR',  companyName: 'Entergy' },
    { symbol: 'FE',   companyName: 'FirstEnergy' },
    { symbol: 'CNP',  companyName: 'CenterPoint Energy' },
    { symbol: 'PPL',  companyName: 'PPL Corporation' },
    { symbol: 'AES',  companyName: 'AES Corporation' },
    { symbol: 'EIX',  companyName: 'Edison International' },
    { symbol: 'D',    companyName: 'Dominion Energy' },
    { symbol: 'AWK',  companyName: 'American Water Works' },
    { symbol: 'NI',   companyName: 'NiSource' },
    { symbol: 'EVRG', companyName: 'Evergy' },
    { symbol: 'LNT',  companyName: 'Alliant Energy' },
    { symbol: 'IDA',  companyName: 'IDACORP' },
    { symbol: 'BKH',  companyName: 'Black Hills Corporation' },
    { symbol: 'SR',   companyName: 'Spire Inc.' },
    { symbol: 'OGE',  companyName: 'OGE Energy' },
    { symbol: 'NWE',  companyName: 'NorthWestern Energy' },
    { symbol: 'AWR',  companyName: 'American States Water' },
    { symbol: 'CWT',  companyName: 'California Water Service' },
    { symbol: 'MSEX', companyName: 'Middlesex Water' },
    { symbol: 'WTRG', companyName: 'Essential Utilities' },
  ],

  // ── Healthcare ───────────────────────────────────────────────────────────
  'Healthcare': [
    { symbol: 'JNJ',  companyName: 'Johnson & Johnson' },
    { symbol: 'UNH',  companyName: 'UnitedHealth Group' },
    { symbol: 'PFE',  companyName: 'Pfizer' },
    { symbol: 'ABT',  companyName: 'Abbott Laboratories' },
    { symbol: 'TMO',  companyName: 'Thermo Fisher Scientific' },
    { symbol: 'MRK',  companyName: 'Merck' },
    { symbol: 'BMY',  companyName: 'Bristol-Myers Squibb' },
    { symbol: 'ABBV', companyName: 'AbbVie' },
    { symbol: 'LLY',  companyName: 'Eli Lilly' },
    { symbol: 'AMGN', companyName: 'Amgen' },
    { symbol: 'GILD', companyName: 'Gilead Sciences' },
    { symbol: 'MDT',  companyName: 'Medtronic' },
    { symbol: 'SYK',  companyName: 'Stryker' },
    { symbol: 'BSX',  companyName: 'Boston Scientific' },
    { symbol: 'EW',   companyName: 'Edwards Lifesciences' },
    { symbol: 'BDX',  companyName: 'Becton Dickinson' },
    { symbol: 'ZBH',  companyName: 'Zimmer Biomet' },
    { symbol: 'BAX',  companyName: 'Baxter International' },
    { symbol: 'CI',   companyName: 'Cigna' },
    { symbol: 'CVS',  companyName: 'CVS Health' },
    { symbol: 'HUM',  companyName: 'Humana' },
    { symbol: 'ELV',  companyName: 'Elevance Health' },
    { symbol: 'CNC',  companyName: 'Centene' },
    { symbol: 'HCA',  companyName: 'HCA Healthcare' },
    { symbol: 'DGX',  companyName: 'Quest Diagnostics' },
    { symbol: 'LH',   companyName: 'Labcorp' },
    { symbol: 'VRTX', companyName: 'Vertex Pharmaceuticals' },
    { symbol: 'HOLX', companyName: 'Hologic' },
    { symbol: 'MOH',  companyName: 'Molina Healthcare' },
    { symbol: 'THC',  companyName: 'Tenet Healthcare' },
  ],

  // ── Consumer Staples ─────────────────────────────────────────────────────
  'Consumer Staples': [
    { symbol: 'PG',   companyName: 'Procter & Gamble' },
    { symbol: 'KO',   companyName: 'Coca-Cola' },
    { symbol: 'PEP',  companyName: 'PepsiCo' },
    { symbol: 'MO',   companyName: 'Altria' },
    { symbol: 'PM',   companyName: 'Philip Morris' },
    { symbol: 'CL',   companyName: 'Colgate-Palmolive' },
    { symbol: 'KMB',  companyName: 'Kimberly-Clark' },
    { symbol: 'GIS',  companyName: 'General Mills' },
    { symbol: 'HRL',  companyName: 'Hormel Foods' },
    { symbol: 'SJM',  companyName: 'J.M. Smucker' },
    { symbol: 'MKC',  companyName: 'McCormick' },
    { symbol: 'CAG',  companyName: 'ConAgra Brands' },
    { symbol: 'CPB',  companyName: 'Campbell Soup' },
    { symbol: 'HSY',  companyName: 'Hershey' },
    { symbol: 'CHD',  companyName: 'Church & Dwight' },
    { symbol: 'CLX',  companyName: 'Clorox' },
    { symbol: 'EL',   companyName: 'Estée Lauder' },
    { symbol: 'TAP',  companyName: 'Molson Coors' },
    { symbol: 'STZ',  companyName: 'Constellation Brands' },
    { symbol: 'KHC',  companyName: 'Kraft Heinz' },
    { symbol: 'MDLZ', companyName: 'Mondelez International' },
    { symbol: 'POST', companyName: 'Post Holdings' },
    { symbol: 'TSN',  companyName: 'Tyson Foods' },
    { symbol: 'ADM',  companyName: 'Archer-Daniels-Midland' },
    { symbol: 'BG',   companyName: 'Bunge Global' },
    { symbol: 'INGR', companyName: 'Ingredion' },
    { symbol: 'SPB',  companyName: 'Spectrum Brands' },
    { symbol: 'SFM',  companyName: 'Sprouts Farmers Market' },
    { symbol: 'USFD', companyName: 'US Foods' },
    { symbol: 'PFGC', companyName: 'Performance Food Group' },
  ],

  // ── Energy ────────────────────────────────────────────────────────────────
  'Energy': [
    { symbol: 'XOM',  companyName: 'ExxonMobil' },
    { symbol: 'CVX',  companyName: 'Chevron' },
    { symbol: 'COP',  companyName: 'ConocoPhillips' },
    { symbol: 'EOG',  companyName: 'EOG Resources' },
    { symbol: 'SLB',  companyName: 'SLB' },
    { symbol: 'OXY',  companyName: 'Occidental Petroleum' },
    { symbol: 'MPC',  companyName: 'Marathon Petroleum' },
    { symbol: 'VLO',  companyName: 'Valero Energy' },
    { symbol: 'PSX',  companyName: 'Phillips 66' },
    { symbol: 'DVN',  companyName: 'Devon Energy' },
    { symbol: 'FANG', companyName: 'Diamondback Energy' },
    { symbol: 'BKR',  companyName: 'Baker Hughes' },
    { symbol: 'HAL',  companyName: 'Halliburton' },
    { symbol: 'KMI',  companyName: 'Kinder Morgan' },
    { symbol: 'WMB',  companyName: 'Williams Companies' },
    { symbol: 'OKE',  companyName: 'ONEOK' },
    { symbol: 'ET',   companyName: 'Energy Transfer' },
    { symbol: 'EPD',  companyName: 'Enterprise Products Partners' },
    { symbol: 'TRGP', companyName: 'Targa Resources' },
    { symbol: 'APA',  companyName: 'APA Corporation' },
    { symbol: 'EQT',  companyName: 'EQT Corporation' },
    { symbol: 'AR',   companyName: 'Antero Resources' },
    { symbol: 'CNX',  companyName: 'CNX Resources' },
    { symbol: 'RRC',  companyName: 'Range Resources' },
    { symbol: 'CTRA', companyName: 'Coterra Energy' },
    { symbol: 'PR',   companyName: 'Permian Resources' },
    { symbol: 'NOG',  companyName: 'Northern Oil & Gas' },
    { symbol: 'DK',   companyName: 'Delek US Holdings' },
    { symbol: 'PBF',  companyName: 'PBF Energy' },
    { symbol: 'TTE',  companyName: 'TotalEnergies' },
  ],

  // ── Financials ───────────────────────────────────────────────────────────
  // Note: D/E threshold is intentionally high for banks (leverage is core business).
  'Financials': [
    { symbol: 'JPM',  companyName: 'JPMorgan Chase' },
    { symbol: 'BAC',  companyName: 'Bank of America' },
    { symbol: 'WFC',  companyName: 'Wells Fargo' },
    { symbol: 'GS',   companyName: 'Goldman Sachs' },
    { symbol: 'MS',   companyName: 'Morgan Stanley' },
    { symbol: 'C',    companyName: 'Citigroup' },
    { symbol: 'BLK',  companyName: 'BlackRock' },
    { symbol: 'SCHW', companyName: 'Charles Schwab' },
    { symbol: 'AXP',  companyName: 'American Express' },
    { symbol: 'V',    companyName: 'Visa' },
    { symbol: 'MA',   companyName: 'Mastercard' },
    { symbol: 'COF',  companyName: 'Capital One' },
    { symbol: 'MCO',  companyName: "Moody's" },
    { symbol: 'SPGI', companyName: 'S&P Global' },
    { symbol: 'ICE',  companyName: 'Intercontinental Exchange' },
    { symbol: 'CME',  companyName: 'CME Group' },
    { symbol: 'CB',   companyName: 'Chubb' },
    { symbol: 'AIG',  companyName: 'AIG' },
    { symbol: 'PRU',  companyName: 'Prudential Financial' },
    { symbol: 'MET',  companyName: 'MetLife' },
    { symbol: 'AFL',  companyName: 'Aflac' },
    { symbol: 'TRV',  companyName: 'Travelers' },
    { symbol: 'ALL',  companyName: 'Allstate' },
    { symbol: 'PGR',  companyName: 'Progressive' },
    { symbol: 'USB',  companyName: 'U.S. Bancorp' },
    { symbol: 'TFC',  companyName: 'Truist Financial' },
    { symbol: 'PNC',  companyName: 'PNC Financial Services' },
    { symbol: 'FITB', companyName: 'Fifth Third Bancorp' },
    { symbol: 'KEY',  companyName: 'KeyCorp' },
    { symbol: 'BK',   companyName: 'Bank of New York Mellon' },
  ],

  // ── Industrials ──────────────────────────────────────────────────────────
  'Industrials': [
    { symbol: 'GE',   companyName: 'GE Aerospace' },
    { symbol: 'HON',  companyName: 'Honeywell' },
    { symbol: 'RTX',  companyName: 'RTX Corporation' },
    { symbol: 'LMT',  companyName: 'Lockheed Martin' },
    { symbol: 'GD',   companyName: 'General Dynamics' },
    { symbol: 'NOC',  companyName: 'Northrop Grumman' },
    { symbol: 'BA',   companyName: 'Boeing' },
    { symbol: 'CAT',  companyName: 'Caterpillar' },
    { symbol: 'DE',   companyName: 'Deere & Company' },
    { symbol: 'EMR',  companyName: 'Emerson Electric' },
    { symbol: 'ETN',  companyName: 'Eaton' },
    { symbol: 'ROK',  companyName: 'Rockwell Automation' },
    { symbol: 'PH',   companyName: 'Parker Hannifin' },
    { symbol: 'AME',  companyName: 'AMETEK' },
    { symbol: 'SWK',  companyName: 'Stanley Black & Decker' },
    { symbol: 'ITT',  companyName: 'ITT Inc.' },
    { symbol: 'IR',   companyName: 'Ingersoll Rand' },
    { symbol: 'XYL',  companyName: 'Xylem' },
    { symbol: 'ROP',  companyName: 'Roper Technologies' },
    { symbol: 'VRSK', companyName: 'Verisk Analytics' },
    { symbol: 'FAST', companyName: 'Fastenal' },
    { symbol: 'GWW',  companyName: 'W.W. Grainger' },
    { symbol: 'RSG',  companyName: 'Republic Services' },
    { symbol: 'WM',   companyName: 'Waste Management' },
    { symbol: 'CTAS', companyName: 'Cintas' },
    { symbol: 'CSX',  companyName: 'CSX Corporation' },
    { symbol: 'UNP',  companyName: 'Union Pacific' },
    { symbol: 'NSC',  companyName: 'Norfolk Southern' },
    { symbol: 'FDX',  companyName: 'FedEx' },
    { symbol: 'UPS',  companyName: 'United Parcel Service' },
  ],

  // ── Broad Market (default) ───────────────────────────────────────────────
  default: [
    { symbol: 'AAPL', companyName: 'Apple' },
    { symbol: 'MSFT', companyName: 'Microsoft' },
    { symbol: 'JNJ',  companyName: 'Johnson & Johnson' },
    { symbol: 'PG',   companyName: 'Procter & Gamble' },
    { symbol: 'KO',   companyName: 'Coca-Cola' },
    { symbol: 'WMT',  companyName: 'Walmart' },
    { symbol: 'JPM',  companyName: 'JPMorgan Chase' },
    { symbol: 'XOM',  companyName: 'ExxonMobil' },
    { symbol: 'CVX',  companyName: 'Chevron' },
    { symbol: 'HD',   companyName: 'Home Depot' },
    { symbol: 'UNH',  companyName: 'UnitedHealth Group' },
    { symbol: 'PFE',  companyName: 'Pfizer' },
    { symbol: 'ABT',  companyName: 'Abbott Laboratories' },
    { symbol: 'TMO',  companyName: 'Thermo Fisher Scientific' },
    { symbol: 'NEE',  companyName: 'NextEra Energy' },
    { symbol: 'DUK',  companyName: 'Duke Energy' },
    { symbol: 'MRK',  companyName: 'Merck' },
    { symbol: 'ABBV', companyName: 'AbbVie' },
    { symbol: 'TXN',  companyName: 'Texas Instruments' },
    { symbol: 'CSCO', companyName: 'Cisco Systems' },
    { symbol: 'IBM',  companyName: 'IBM' },
    { symbol: 'COP',  companyName: 'ConocoPhillips' },
    { symbol: 'SO',   companyName: 'Southern Company' },
    { symbol: 'MCD',  companyName: "McDonald's" },
    { symbol: 'COST', companyName: 'Costco Wholesale' },
    { symbol: 'V',    companyName: 'Visa' },
    { symbol: 'MA',   companyName: 'Mastercard' },
    { symbol: 'LMT',  companyName: 'Lockheed Martin' },
    { symbol: 'CAT',  companyName: 'Caterpillar' },
    { symbol: 'GE',   companyName: 'GE Aerospace' },
  ],
};

// ── Cache helpers ────────────────────────────────────────────────────────────
// VULTR_CACHE_URL and VULTR_CACHE_SECRET are fully optional.

async function readCache(cacheUrl, secret, key) {
  try {
    const res = await fetch(
      `${cacheUrl}/cache?key=${encodeURIComponent(key)}`,
      { headers: { 'X-Cache-Secret': secret }, signal: AbortSignal.timeout(3000) }
    );
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.warn(`[cs-cache] read miss (${key}): ${err.message}`);
    return null;
  }
}

async function writeCache(cacheUrl, secret, key, payload) {
  try {
    await fetch(
      `${cacheUrl}/cache?key=${encodeURIComponent(key)}`,
      {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Cache-Secret': secret },
        body:    JSON.stringify(payload),
        signal:  AbortSignal.timeout(5000),
      }
    );
  } catch (err) {
    console.warn(`[cs-cache] write failed (${key}): ${err.message}`);
  }
}

// ── Data fetching ────────────────────────────────────────────────────────────

/**
 * Fetches Yahoo Finance data for one ticker.
 * Returns the observedValues object, or null if the ticker should be skipped.
 * FailedYahooValidation errors are handled gracefully via err.result.
 */
async function fetchOneTicker(symbol) {
  const [qsOutcome, tsOutcome] = await Promise.allSettled([
    yahooFinance.quoteSummary(symbol, { modules: MODULES }),
    fetchTimeSeries(symbol),
  ]);

  let result;
  if (qsOutcome.status === 'fulfilled') {
    result = qsOutcome.value;
  } else if (qsOutcome.reason?.result) {
    result = qsOutcome.reason.result; // FailedYahooValidation — partial result usable
  } else {
    console.warn(`[yf] skipping ${symbol}: ${qsOutcome.reason?.message}`);
    return null;
  }

  const timeSeries = tsOutcome.status === 'fulfilled' ? tsOutcome.value : null;

  const ks = result.defaultKeyStatistics ?? {};
  const fd = result.financialData        ?? {};
  const sd = result.summaryDetail        ?? {};

  return {
    current_ratio:     fd.currentRatio   ?? null,
    debt_to_equity:    fd.debtToEquity   ?? null,
    price_to_book:     ks.priceToBook    ?? null,
    price_to_earnings: extractPE(ks, sd),
    // Structural Risk inputs — all decimal format
    revenue_growth:    fd.revenueGrowth  ?? null,  // 0.18 = 18% TTM growth
    return_on_equity:  fd.returnOnEquity ?? null,  // 0.34 = 34% TTM ROE
    payout_ratio:      sd.payoutRatio    ?? null,  // 0.40 = 40% payout; null/0 = no dividend
    interest_coverage: computeInterestCoverage(fd), // proxy: ebitda / (totalDebt × 5%)
    // Capital allocation efficiency (Mauboussin framework)
    roic:              computeROIC(fd),             // cash NOPAT / invested capital (decimal)
    wacc:              computeWACC(fd, ks),         // CAPM + after-tax cost of debt (decimal)
    // New: firm-level valuation and capital consumption
    ev_to_ebitda:      ks.enterpriseToEbitda          ?? null,
    reinvestment_rate: computeReinvestmentRate(timeSeries),
  };
}

/**
 * Fetches tickers in sequential batches to avoid Yahoo Finance 429 rate-limits.
 *
 * Within each batch, requests run concurrently (Promise.allSettled).
 * A short pause between batches keeps the aggregate request rate well below
 * Yahoo Finance's per-IP threshold without meaningfully increasing total latency.
 *
 * @param {Array}  tickers   - Array of { symbol, companyName } objects
 * @param {number} batchSize - Tickers fetched concurrently per batch (default 10)
 * @param {number} delayMs   - Pause between batches in ms (default 250)
 */
async function fetchAllTickers(tickers, batchSize = 10, delayMs = 250) {
  const results = [];
  let   skipped = 0;

  for (let i = 0; i < tickers.length; i += batchSize) {
    const chunk   = tickers.slice(i, i + batchSize);
    const settled = await Promise.allSettled(
      chunk.map(t => fetchOneTicker(t.symbol))
    );

    for (let j = 0; j < chunk.length; j++) {
      const outcome = settled[j];
      if (outcome.status === 'fulfilled' && outcome.value !== null) {
        results.push({
          symbol:         chunk[j].symbol,
          companyName:    chunk[j].companyName ?? chunk[j].symbol,
          observedValues: outcome.value,
        });
      } else {
        skipped++;
      }
    }

    // Pause between batches (skip delay after the final batch)
    if (i + batchSize < tickers.length) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  return { results, skipped };
}

// ── Handler ──────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  const { sector = 'default' } = req.query;

  const cacheUrl    = process.env.VULTR_CACHE_URL;
  const cacheSecret = process.env.VULTR_CACHE_SECRET;

  const cacheKey = `yf:sector:${sector}`;

  // ── 1. Check Vultr cache ────────────────────────────────────────────────────
  if (cacheUrl && cacheSecret) {
    const cached = await readCache(cacheUrl, cacheSecret, cacheKey);
    if (cached) return res.status(200).json(cached);
  }

  // ── 2. Resolve curated ticker list ─────────────────────────────────────────
  const tickerList = SECTOR_TICKERS[sector] ?? SECTOR_TICKERS.default;

  if (!tickerList.length) {
    return res.status(404).json({
      error: `No companies configured for sector "${sector}". Try a different sector.`,
    });
  }

  // ── 3. Fetch all tickers concurrently ──────────────────────────────────────
  const { results: companies, skipped } = await fetchAllTickers(tickerList);

  if (!companies.length) {
    return res.status(502).json({
      error: 'Could not retrieve data for any company in this sector. Yahoo Finance may be temporarily unavailable — try again in a moment.',
    });
  }

  // ── 4. Build and cache payload ─────────────────────────────────────────────
  const payload = {
    sector,
    cachedAt:       null,
    companies,
    totalRequested: tickerList.length,
    totalReturned:  companies.length,
    skipped,
  };

  if (cacheUrl && cacheSecret) {
    await writeCache(cacheUrl, cacheSecret, cacheKey, {
      ...payload,
      cachedAt: new Date().toISOString(),
    });
  }

  return res.status(200).json(payload);
}
