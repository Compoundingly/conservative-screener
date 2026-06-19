/**
 * api/ratios.js — Vercel Serverless Proxy (yahoo-finance2)
 *
 * No API key required. yahoo-finance2 proxies public Yahoo Finance endpoints.
 *
 * Modules used → fields extracted
 * ─────────────────────────────────────────────────────────────────────────────
 * financialData        → currentRatio, debtToEquity (% format, e.g. 79.5 = 0.795x)
 * defaultKeyStatistics → priceToBook, forwardPE (P/E fallback)
 * summaryDetail        → trailingPE (preferred P/E; not available in defaultKeyStatistics)
 *
 * P/E fallback chain: summaryDetail.trailingPE (positive) →
 *                     defaultKeyStatistics.forwardPE (positive) → null
 *
 * GET /api/ratios?ticker=AAPL
 */

import YahooFinance from 'yahoo-finance2';

const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

const MODULES = ['defaultKeyStatistics', 'financialData', 'summaryDetail'];

const TAX = 0.21; // US corporate tax rate — shared by computeReinvestmentRate and computeROIC

// ── Helpers ──────────────────────────────────────────────────────────────────

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
 * Using EBITDA (not operating income) as the numerator so depreciation on real assets
 * does not artificially depress results for capital-intensive sectors (REITs, utilities).
 * This aligns with Mauboussin's "cash earnings" definition in his Capital Allocation paper.
 *
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
    equity = td / (de / 100);              // standard: D/E known and positive
  } else if (td === 0) {
    // Zero-debt: back out equity via ROE = netIncome / equity
    const roe = fd.returnOnEquity ?? null;
    const pm  = fd.profitMargins  ?? null;
    const rev = fd.totalRevenue   ?? null;
    if (roe && roe !== 0 && pm !== null && rev !== null) {
      equity = (pm * rev) / roe;
    }
  }

  if (equity === null || equity <= 0) return null;

  const investedCapital = equity + td - cash;
  if (investedCapital <= 0) return null;   // net-cash company or bad data

  return (ebitda * (1 - TAX)) / investedCapital;  // as decimal: 0.18 = 18% ROIC
}

/**
 * Approximate WACC via CAPM + after-tax cost of debt.
 *
 * Cost of equity  Ke = rf + β × MRP   (CAPM)
 * Cost of debt    Kd = 5% pre-tax  →  3.95% after-tax at 21% corporate rate
 * WACC            = (E/V) × Ke + (D/V) × Kd_after_tax
 *
 * Constants (June 2026):
 *   rf  = 4.5%   (10-year US Treasury)
 *   MRP = 5.5%   (long-run equity risk premium)
 *   Kd  = 5.0%   (assumed investment-grade borrowing rate)
 *   t   = 21%    (US corporate tax)
 *
 * Beta defaults to 1.0 (market beta) when unavailable or negative.
 * For zero-debt companies WACC = Ke.
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

  if (td === 0 || de === null || de <= 0) return ke;  // all-equity financing

  const equity       = td / (de / 100);
  const totalCapital = equity + td;

  return (equity / totalCapital) * ke + (td / totalCapital) * KD * (1 - TAX);
}

/**
 * Robust P/E extraction.
 * Prefers trailing P/E; negative P/E (loss-making companies) is treated as
 * unusable data and falls back to forward P/E. Returns null if both are absent.
 */
function extractPE(ks, sd) {
  const trailing = (sd?.trailingPE  != null && sd.trailingPE  > 0) ? sd.trailingPE  : null;
  const forward  = (ks?.forwardPE   != null && ks.forwardPE   > 0) ? ks.forwardPE   : null;
  return trailing ?? forward ?? null;
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
  const ebit     = ts.EBIT                       ?? null;
  const da       = ts.depreciationAndAmortization ?? null;
  const wcChange = ts.changeInWorkingCapital      ?? null;
  const capexRaw = ts.capitalExpenditure          ?? ts.purchaseOfInvestmentProperties ?? null;

  if (ebit === null || da === null || wcChange === null || capexRaw === null) return null;

  const nopat = ebit * (1 - TAX);
  if (nopat <= 0) return null;

  const capexSpent     = -capexRaw;  // flip outflow-negative to positive magnitude
  const wcConsumed     = -wcChange;  // flip cash-effect sign to positive magnitude consumed
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

// ── Handler ──────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  const { ticker } = req.query;

  if (!ticker || !/^[A-Za-z]{1,6}$/.test(ticker)) {
    return res.status(400).json({
      error: 'Invalid ticker symbol. Use 1–6 letters (e.g. AAPL).',
    });
  }

  const symbol = ticker.toUpperCase();

  const [qsOutcome, tsOutcome] = await Promise.allSettled([
    yahooFinance.quoteSummary(symbol, { modules: MODULES }),
    fetchTimeSeries(symbol),
  ]);

  let result;
  if (qsOutcome.status === 'fulfilled') {
    result = qsOutcome.value;
  } else if (qsOutcome.reason?.result) {
    result = qsOutcome.reason.result; // FailedYahooValidation — partial result is still usable
  } else {
    const msg = qsOutcome.reason?.message ?? '';
    const status = msg.toLowerCase().includes('no fundamentals') ? 404 : 502;
    return res.status(status).json({
      error: status === 404
        ? `No data found for "${symbol}". Verify the ticker symbol and try again.`
        : `Data retrieval failed: ${msg}`,
    });
  }

  const timeSeries = tsOutcome.status === 'fulfilled' ? tsOutcome.value : null;

  const ks = result.defaultKeyStatistics ?? {};
  const fd = result.financialData        ?? {};
  const sd = result.summaryDetail        ?? {};

  return res.status(200).json({
    ticker:           symbol,
    fiscalDateEnding: null,
    observedValues: {
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
    },
  });
}
