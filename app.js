    /**
     * FIELD_REGISTRY — Stable field definitions (no thresholds).
     * Thresholds are sector-specific and live in SECTOR_CONFIG below.
     *
     * Fields:
     *   id        — machine identifier (matches API observedValues keys)
     *   label     — display name (no advice language)
     *   filter    — parent filter group for single-ticker card view
     *   operator  — default comparison operator
     *   unit      — display suffix
     *   rankDir   — 'asc' (lower is more conservative) | 'desc' (higher is more conservative)
     */
    const FIELD_REGISTRY = [
      { id: 'current_ratio',     label: 'Current Ratio',     filter: 'Liquidity Stress Test',    operator: '>=', unit: 'x',  rankDir: 'desc' },
      { id: 'debt_to_equity',    label: 'Debt/Equity',       filter: 'Capital Structure Filter',  operator: '<=', unit: '%',  rankDir: 'asc'  },
      { id: 'price_to_book',     label: 'Price-to-Book',     filter: 'Valuation Ratio Filter',    operator: '<=', unit: 'x',  rankDir: 'asc'  },
      { id: 'price_to_earnings', label: 'Price-to-Earnings', filter: 'Valuation Ratio Filter',    operator: '<=', unit: 'x',  rankDir: 'asc'  },
      // Firm-level valuation, capital-structure neutral. Excluded for Financials —
      // EV/EBITDA is not coherent when debt is the product, not the capital structure.
      { id: 'ev_to_ebitda',      label: 'EV/EBITDA',         filter: 'Valuation Ratio Filter',    operator: '<=', unit: 'x',  rankDir: 'asc',  excludedSectors: ['Financials'] },
      // Companion check — validates that a low EV/EBITDA is not masking heavy capital
      // consumption. Stored pre-scaled ×100 to match debt_to_equity's % convention.
      // Excluded for Real Estate and Utilities: both sectors fund growth structurally
      // through external capital (REITs must distribute ≥90% of taxable income; utilities
      // are perpetually capital-intensive by regulatory design), so a NOPAT-based
      // reinvestment ceiling doesn't measure what it's meant to for either sector.
      { id: 'reinvestment_rate', label: 'Reinvestment Rate', filter: 'Cash Reinvestment Test',    operator: '<=', unit: '%',  rankDir: 'asc',  excludedSectors: ['Financials', 'Real Estate', 'Utilities'] },
    ];

    // ── TOOLTIP DEFINITIONS ───────────────────────────────────────────────────
    /**
     * Academic definition + benchmark guideline for each metric.
     * Rendered by the global floating tooltip; keyed by field id or a named key.
     */
    const TOOLTIP_DEFINITIONS = {
      current_ratio: {
        definition: 'Current assets ÷ current liabilities. Measures short-term liquidity — the firm\'s ability to meet obligations due within one year from assets expected to convert to cash in the same period.',
        benchmark:  'Classical liquidity criteria require ≥ 2.0× for industrial companies, treating any ratio below 1.5× as a working-capital stress signal. Sector thresholds in this screener are adjusted for capital-intensive industries.',
      },
      debt_to_equity: {
        definition: 'Total financial debt ÷ total stockholders\' equity. Displayed in Yahoo Finance\'s percentage format: 100 = 1.0× ratio. Quantifies financial leverage and the reliance on creditor versus owner financing.',
        benchmark:  'Conservative capital-structure criteria: long-term debt ≤ 50 % of net tangible assets (≤ 100 in this format for most sectors). Capital-intensive sectors — REITs, Utilities, Financials — structurally carry higher leverage by design and have sector-adjusted ceilings.',
      },
      price_to_book: {
        definition: 'Market price per share ÷ book value per share (net assets per share). Compares market capitalisation to the accounting value of net assets. A ratio below 1.0× implies the market prices the business below its theoretical liquidation value.',
        benchmark:  'Classic defensive-investor ceiling: ≤ 1.5× (or combined P/E × P/B ≤ 22.5). Intangible-intensive sectors (Technology, Healthcare, Consumer Brands) legitimately trade above book because valuable assets — patents, software, brand equity — are expensed rather than capitalised.',
      },
      price_to_earnings: {
        definition: 'Current share price ÷ trailing-twelve-month earnings per share. Represents the price paid per dollar of current earnings. Its inverse (E/P) is the "earnings yield." Negative P/E (loss-making companies) is treated as N/A and sinks to the bottom when sorting.',
        benchmark:  'Defensive-investor ceiling: ≤ 15× trailing earnings (or combined P/E × P/B ≤ 22.5). Growth-premium sectors warrant higher multiples reflecting durable reinvestment opportunities above the cost of capital. Forward P/E is used as a fallback when trailing is unavailable.',
      },
      roic: {
        definition: 'Cash ROIC = EBITDA × (1 − 0.21) ÷ Invested Capital, where Invested Capital = Equity + Debt − Cash. WACC (Weighted Average Cost of Capital) is estimated via CAPM: Ke = rf + β × MRP, blended with after-tax cost of debt. Spread = ROIC − WACC.',
        benchmark:  'Mauboussin (Capital Allocation Framework): a firm creates intrinsic value only when ROIC > WACC. A sustained +10 to +15 pp spread is characteristic of high-quality compounders. This screener uses EBITDA-based cash ROIC; WACC assumes rf = 4.5 %, MRP = 5.5 %, Kd = 5.0 %. Single-period TTM approximation — not a rolling 3-year ROIIC.',
      },
      // Structural Risk sub-checks
      vitality: {
        definition: 'Composite check on top-line momentum and capital efficiency: Revenue Growth ≥ 2 % TTM (outpacing baseline stagnation) AND Return on Equity ≥ 10 % TTM (adequate capital efficiency).',
        benchmark:  'Designed to flag potential value traps — businesses with eroding competitive positioning despite adequate balance sheets. Both conditions must hold; failure of either triggers the check.',
      },
      dividend_trap: {
        definition: 'Payout Ratio = dividends paid ÷ net income. A high payout ratio signals that a disproportionate share of earnings is being returned rather than reinvested, leaving little buffer for debt service or capex during downturns.',
        benchmark:  'Empirical earnings-sustainability threshold: payout > 80 % of earnings is generally unsustainable — a potential dividend trap. Companies paying no dividend (payout ratio null or zero) are excluded from this check.',
      },
      debt_load: {
        definition: 'Evaluates whether total financial leverage — measured via Debt/Equity in Yahoo Finance\'s percentage format — is within structurally sound bounds. Negative equity (de < 0) indicates a technically insolvent balance sheet.',
        benchmark:  'Trigger threshold: D/E > 100 (i.e. debt exceeds equity) or negative equity. Applies the classical 50 % capitalisation rule. Sector-specific D/E ceilings in SECTOR_CONFIG override the Structural Risk baseline.',
      },
      coverage: {
        definition: 'Interest Coverage = EBITDA ÷ Interest Expense. Approximates how many times operating cash earnings cover the annual interest burden. Uses the directly reported interest expense from annual financial statements when available; falls back to an EBITDA-proxy (EBITDA ÷ Total Debt × 5 % assumed borrowing rate) for tickers where no direct interest-expense line is reported.',
        benchmark:  'Investment-grade credit floor: ≥ 3.0× EBITDA coverage. EBITDA is used (not GAAP operating income) so depreciation on real assets does not distort capital-intensive sector results. A null value (no debt and no reported interest expense) is treated as a pass by default.',
      },
      ev_to_ebitda: {
        definition: 'Enterprise Value ÷ EBITDA. EV = Market Cap + Total Debt − Cash, representing the total acquisition cost of the business independent of capital structure. Dividing by EBITDA normalises for depreciation and financing choices, enabling cross-sector comparison of operating value.',
        benchmark:  'General ceiling: ≤ 10× for conservatively valued businesses. Sector-specific thresholds reflect structural norms: Technology ≤ 26.5×, Consumer Staples ≤ 23.5×, Healthcare ≤ 23.5×, Real Estate ≤ 16.5×, Retail ≤ 16.5×, Industrials ≤ 16.5×, Utilities ≤ 13.5×, Energy ≤ 11.5×. Excluded for Financials — EV/EBITDA is not a coherent concept when debt is the product rather than the capital structure.',
      },
      reinvestment_rate: {
        definition: 'Net Reinvestment ÷ NOPAT, expressed as a percentage (pre-scaled ×100). Net Reinvestment = (CapEx − D&A) + ΔWorking Capital. NOPAT = EBIT × (1 − 21 % tax). Measures what fraction of after-tax operating profit is consumed by the business to sustain or grow its asset base. A rate below 50 % implies the firm generates more than half of NOPAT as distributable free cash flow.',
        benchmark:  'Screening ceiling: ≤ 50 % (flat threshold, not sector-tiered). Excluded for Real Estate and Utilities — both sectors structurally fund growth through external capital rather than retained operating earnings, so this ceiling does not apply. Excluded for Financials for the same reason as EV/EBITDA. A reinvestment rate above 50 % elsewhere signals heavy capital consumption relative to operating earnings — not necessarily negative, but warrants scrutiny alongside ROIC. Returns N/A when EBIT is non-positive or any required input is missing.',
      },
    };

    /**
     * Builds the inner HTML of the floating tooltip panel for a given key.
     */
    function buildTooltipHTML(key) {
      const def = TOOLTIP_DEFINITIONS[key];
      if (!def) return '';
      return `
        <div class="tp-section">
          <p class="tp-label tp-def">Definition</p>
          <p class="tp-defb">${def.definition}</p>
        </div>
        <div class="tp-divider"></div>
        <div class="tp-section">
          <p class="tp-label tp-bm">Benchmark Guideline</p>
          <p class="tp-bmb">${def.benchmark}</p>
        </div>`;
    }

    // ── Global floating tooltip engine ────────────────────────────────────────
    // Uses position:fixed so the panel is never clipped by overflow:auto containers.
    // Event delegation handles dynamically re-rendered table headers and card labels.
    (function initTooltipEngine() {
      const panel = document.getElementById('cs-tooltip');
      let hideTimer = null;
      let currentTarget = null;

      function positionAndShow(el) {
        const key  = el.getAttribute('data-tooltip-key');
        const html = buildTooltipHTML(key);
        if (!html) return;

        panel.innerHTML = html;
        panel.style.display = 'block';

        const rect = el.getBoundingClientRect();
        const pw   = panel.offsetWidth;
        const ph   = panel.offsetHeight;

        // Prefer above the element; flip below if too close to viewport top
        let top  = rect.top - ph - 10;
        let left = rect.left + rect.width / 2 - pw / 2;

        if (top < 8)  top  = rect.bottom + 10;
        // Clamp horizontally within viewport
        left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));

        panel.style.top  = top  + 'px';
        panel.style.left = left + 'px';
      }

      document.addEventListener('mouseover', function(e) {
        const el = e.target.closest('[data-tooltip-key]');
        if (!el) return;
        clearTimeout(hideTimer);
        currentTarget = el;
        positionAndShow(el);
      });

      document.addEventListener('mouseout', function(e) {
        const el = e.target.closest('[data-tooltip-key]');
        if (!el) return;
        hideTimer = setTimeout(function() {
          panel.style.display = 'none';
          currentTarget = null;
        }, 120);
      });

      // Re-position on scroll (table can scroll horizontally)
      window.addEventListener('scroll', function() {
        if (currentTarget && panel.style.display !== 'none') {
          positionAndShow(currentTarget);
        }
      }, { passive: true });
    })();

    /**
     * SECTOR_CONFIG — Per-sector threshold overrides.
     * Each key maps to an object of { fieldId: thresholdNumber }.
     * Operators and field definitions are inherited from FIELD_REGISTRY.
     * 'default' is used when no sector-specific config exists.
     */
    // debt_to_equity thresholds are in Yahoo Finance % format (100 = 1.0× D/E ratio).
    // ev_to_ebitda ceilings are extrapolated via proportional multiplier from the existing
    // P/E and P/B overrides — validated against live data: Technology ceiling (26.5×) vs.
    // AAPL actual (27.57×); Real Estate ceiling (16.5×) vs. O actual (17.20×) — both fail
    // by a narrow margin, consistent with this screener's existing strictness.
    // reinvestment_rate is flat at 50 (= 50 %, pre-scaled) across all included sectors.
    const SECTOR_CONFIG = {
      // Conservative base thresholds (classical value-screening criteria)
      default:             { current_ratio: 2.0, debt_to_equity:  150, price_to_book: 1.5,  price_to_earnings: 15.0, ev_to_ebitda: 10.0, reinvestment_rate: 50 },

      // Sectors with real-asset backing — higher D/E and P/B are structurally normal
      'Real Estate':       { current_ratio: 1.2, debt_to_equity:  400, price_to_book: 2.5,  price_to_earnings: 25.0, ev_to_ebitda: 16.5 },
      'Utilities':         { current_ratio: 1.0, debt_to_equity:  300, price_to_book: 2.0,  price_to_earnings: 20.0, ev_to_ebitda: 13.5 },
      'Energy':            { current_ratio: 1.2, debt_to_equity:  100, price_to_book: 2.0,  price_to_earnings: 15.0, ev_to_ebitda: 11.5, reinvestment_rate: 50 },

      // Consumer sectors — moderate leverage, some brand premium in P/B
      'Retail':            { current_ratio: 1.5, debt_to_equity:  250, price_to_book: 3.0,  price_to_earnings: 20.0, ev_to_ebitda: 16.5, reinvestment_rate: 50 },
      'Consumer Staples':  { current_ratio: 1.2, debt_to_equity:  200, price_to_book: 5.0,  price_to_earnings: 20.0, ev_to_ebitda: 23.5, reinvestment_rate: 50 },

      // Knowledge / IP sectors — lower leverage expected, premium P/B acceptable
      'Technology':        { current_ratio: 1.5, debt_to_equity:  100, price_to_book: 5.0,  price_to_earnings: 30.0, ev_to_ebitda: 26.5, reinvestment_rate: 50 },
      'Healthcare':        { current_ratio: 1.5, debt_to_equity:  150, price_to_book: 5.0,  price_to_earnings: 20.0, ev_to_ebitda: 23.5, reinvestment_rate: 50 },
      'Industrials':       { current_ratio: 1.5, debt_to_equity:  150, price_to_book: 3.0,  price_to_earnings: 20.0, ev_to_ebitda: 16.5, reinvestment_rate: 50 },

      // Financials: no ev_to_ebitda / reinvestment_rate keys — excludedSectors in
      // FIELD_REGISTRY filters these out before threshold lookup, so omission is safe.
      // D/E is structurally high for banks (deposits = liabilities); P/B and P/E are primary.
      'Financials':        { current_ratio: 1.0, debt_to_equity: 1200, price_to_book: 2.0,  price_to_earnings: 15.0 },
    };

    // Maps each sector dropdown value to its representative SPDR Select Sector ETF ticker.
    // Used by the Sector Macro Trend banner (api/trend.js).
    const SECTOR_ETF_MAP = {
      'Consumer Staples': 'XLP',
      'Energy':           'XLE',
      'Financials':       'XLF',
      'Healthcare':       'XLV',
      'Industrials':      'XLI',
      'Real Estate':      'XLRE',
      'Retail':           'XRT',
      'Technology':       'XLK',
      'Utilities':        'XLU',
      'default':          'SPY',
    };

    const SECTOR_OPTIONS = [
      { value: 'Consumer Staples', label: 'Consumer Staples' },
      { value: 'Energy',           label: 'Energy' },
      { value: 'Financials',       label: 'Financials' },
      { value: 'Healthcare',       label: 'Healthcare' },
      { value: 'Industrials',      label: 'Industrials' },
      { value: 'Real Estate',      label: 'Real Estate' },
      { value: 'Retail',           label: 'Retail' },
      { value: 'Technology',       label: 'Technology' },
      { value: 'Utilities',        label: 'Utilities' },
      { value: 'default',          label: 'Broad Market' },
    ];

    let sectorComboboxOpen = false;

    function initSectorCombobox() {
      const wrap   = document.getElementById('sector-combobox-wrap');
      const input  = document.getElementById('sector-combobox-input');
      const list   = document.getElementById('sector-combobox-list');
      const hidden = document.getElementById('sector-select');
      if (!wrap || !input || !list || !hidden) return;

      list.innerHTML = SECTOR_OPTIONS.map(opt => `
        <li
          role="option"
          class="sector-combobox-item px-4 py-2.5 text-sm text-slate-300 hover:bg-slate-800"
          data-value="${opt.value}"
          data-label="${opt.label}"
          aria-selected="${opt.value === hidden.value}"
        >${opt.label}</li>
      `).join('');

      input.addEventListener('focus', () => {
        input.select(); // Highlight the text so the user can type immediately
        openSectorCombobox();
        filterSectorOptions(''); // Pass an empty string to ensure all sectors are visible
      });

      input.addEventListener('input', () => {
        if (!sectorComboboxOpen) openSectorCombobox();
        filterSectorOptions(input.value);
      });

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          closeSectorCombobox(true);
        } else if (e.key === 'Enter') {
          e.preventDefault();
          const first = list.querySelector('.sector-combobox-item:not(.hidden-by-filter)');
          if (first) selectSectorOption(first.dataset.value, first.dataset.label);
        }
      });

      list.addEventListener('mousedown', (e) => {
        const item = e.target.closest('.sector-combobox-item');
        if (!item || item.classList.contains('hidden-by-filter')) return;
        e.preventDefault();
        selectSectorOption(item.dataset.value, item.dataset.label);
      });

      document.addEventListener('click', (e) => {
        if (!wrap.contains(e.target)) closeSectorCombobox(true);
      });
    }

    function filterSectorOptions(query) {
      const list = document.getElementById('sector-combobox-list');
      if (!list) return;
      const q = query.trim().toLowerCase();
      let visibleCount = 0;

      list.querySelectorAll('.sector-combobox-item').forEach(item => {
        const label = (item.dataset.label || item.textContent || '').toLowerCase();
        const match = !q || label.includes(q);
        item.classList.toggle('hidden-by-filter', !match);
        item.setAttribute('aria-hidden', String(!match));
        if (match) visibleCount++;
      });

      if (visibleCount === 0) {
        let empty = list.querySelector('.sector-combobox-empty');
        if (!empty) {
          empty = document.createElement('li');
          empty.className = 'sector-combobox-empty px-4 py-3 text-sm text-slate-500 pointer-events-none';
          empty.textContent = 'No matching sectors';
          list.appendChild(empty);
        }
        empty.classList.remove('hidden-by-filter');
      } else {
        const empty = list.querySelector('.sector-combobox-empty');
        if (empty) empty.classList.add('hidden-by-filter');
      }
    }

    function openSectorCombobox() {
      const input = document.getElementById('sector-combobox-input');
      const list  = document.getElementById('sector-combobox-list');
      if (!input || !list) return;
      list.classList.remove('hidden');
      input.setAttribute('aria-expanded', 'true');
      sectorComboboxOpen = true;
    }

    function closeSectorCombobox(restoreLabel) {
      const input  = document.getElementById('sector-combobox-input');
      const list   = document.getElementById('sector-combobox-list');
      const hidden = document.getElementById('sector-select');
      if (!input || !list) return;

      list.classList.add('hidden');
      input.setAttribute('aria-expanded', 'false');
      sectorComboboxOpen = false;

      if (restoreLabel && hidden) {
        const selected = SECTOR_OPTIONS.find(o => o.value === hidden.value);
        if (selected) input.value = selected.label;
      }
    }

    function selectSectorOption(value, label) {
      const input  = document.getElementById('sector-combobox-input');
      const hidden = document.getElementById('sector-select');
      if (!input || !hidden) return;

      hidden.value = value;
      input.value  = label;

      document.querySelectorAll('.sector-combobox-item').forEach(el => {
        el.setAttribute('aria-selected', String(el.dataset.value === value));
      });

      closeSectorCombobox(false);
    }

    // ── IN-SECTOR TABLE FILTER ───────────────────────────────────────────────────
    /**
     * Instantly shows/hides <tr> rows in the rendered sector table based on
     * whether the row's text content contains the query string.
     * Matches against the full row text (ticker, company name, and numeric cells),
     * so users can type 'AAPL', 'Apple', or even a ratio value like '12.5'.
     * Pure DOM operation — no re-fetch, no re-rank, no state mutation.
     */
    function filterSectorTable(query) {
      const tbody = document.querySelector('#sector-table-container tbody');
      if (!tbody) return;

      const q = query.trim().toLowerCase();
      let visibleCount = 0;

      Array.from(tbody.rows).forEach(row => {
        const match = !q || row.textContent.toLowerCase().includes(q);
        row.style.display = match ? '' : 'none';
        if (match) visibleCount++;
      });

      // Surface a no-match message inside the existing container so layout stays intact
      let emptyMsg = document.getElementById('sector-filter-empty');
      if (visibleCount === 0 && q) {
        if (!emptyMsg) {
          emptyMsg = document.createElement('tr');
          emptyMsg.id = 'sector-filter-empty';
          emptyMsg.innerHTML = `<td colspan="99" class="px-6 py-8 text-center text-sm text-slate-500">
            No results for <span class="font-mono text-slate-400">${q.toUpperCase()}</span> in this sector.
          </td>`;
          tbody.appendChild(emptyMsg);
        }
        emptyMsg.style.display = '';
      } else if (emptyMsg) {
        emptyMsg.style.display = 'none';
      }
    }

    /**
     * Attaches the input event listener to #sector-filter-input.
     * Called once from the init IIFE; safe to call if the element is absent.
     */
    function initSectorFilter() {
      const input = document.getElementById('sector-filter-input');
      if (!input) return;
      input.addEventListener('input', () => filterSectorTable(input.value));
      // Clear filter on Escape
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          input.value = '';
          filterSectorTable('');
          input.blur();
        }
      });
    }

    /**
     * Tightens each threshold by the Margin of Safety fraction.
     * Operators with upper bounds (<=) are reduced; lower bounds (>=) are raised.
     * A 10% MoS on P/E ≤ 15 → P/E ≤ 13.50.
     */
    function applyMoS(config, mos) {
      if (!mos) return config;
      return config.map(c => ({
        ...c,
        threshold: c.operator === '<=' ? +(c.threshold * (1 - mos)).toFixed(4)
                 : c.operator === '>=' ? +(c.threshold * (1 + mos)).toFixed(4)
                 : c.threshold,
      }));
    }

    /**
     * Merges FIELD_REGISTRY with sector thresholds, then applies the
     * Margin of Safety tightening if mosFraction > 0.
     */
    function getActiveConfig(sector, mosFraction) {
      const thresholds = SECTOR_CONFIG[sector] ?? SECTOR_CONFIG.default;
      const base = FIELD_REGISTRY
        .filter(f => !f.excludedSectors || !f.excludedSectors.includes(sector))
        .map(f => ({ ...f, threshold: thresholds[f.id] }));
      return applyMoS(base, mosFraction ?? 0);
    }

    /** Reads the current Margin of Safety value from the UI select. */
    function getMoS() {
      return parseFloat(document.getElementById('mos-select')?.value ?? '0') || 0;
    }

    // ── DATA LAYER ──────────────────────────────────────────────────────────────
    /**
     * ─────────────────────────────────────────────────────────────────────────
     * INSTITUTIONAL DATA ARCHITECTURE — SEC EDGAR / XBRL INTEGRATION ROADMAP
     * ─────────────────────────────────────────────────────────────────────────
     *
     * CURRENT STATE (v1 — Yahoo Finance proxy):
     *   The Vercel serverless function at /api/ratios fetches pre-computed
     *   ratio fields from a third-party data vendor (Yahoo Finance-compatible
     *   endpoint). This is fast and zero-cost for prototyping, but introduces
     *   vendor risk, inconsistent GAAP normalisation, and no audit trail.
     *
     * TARGET STATE (v2 — Primary-source XBRL pipeline):
     *   Replace the vendor dependency with direct primary-source ingestion from
     *   one of the two authoritative XBRL pipelines below.
     *
     *   ── Option A: SEC EDGAR XBRL REST API (free, official) ─────────────────
     *   Endpoint:  https://data.sec.gov/api/xbrl/companyfacts/{CIK}.json
     *   10-Q/10-K: https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany
     *              &CIK={TICKER}&type=10-Q&dateb=&owner=include&count=4
     *   Fields:    us-gaap/Assets, Liabilities, StockholdersEquity,
     *              Revenues, NetIncomeLoss, EarningsPerShareBasic,
     *              LongTermDebt, CashAndCashEquivalentsAtCarryingValue,
     *              CommonStockSharesOutstanding
     *   Notes:     Rate-limited to 10 req/s. Requires CIK lookup via
     *              /submissions/{CIK}.json. No pre-computed ratios —
     *              all arithmetic must be done in the serverless function.
     *              EDGAR data lags filings by ~48 h after EDGAR acceptance.
     *
     *   ── Option B: Financial Modeling Prep (FMP) API (paid, normalised) ─────
     *   Endpoint:  https://financialmodelingprep.com/api/v3/
     *   Useful routes:
     *     /income-statement/{TICKER}?period=quarter&limit=4&apikey={KEY}
     *     /balance-sheet-statement/{TICKER}?period=quarter&limit=4&apikey={KEY}
     *     /cash-flow-statement/{TICKER}?period=quarter&limit=4&apikey={KEY}
     *     /financial-ratios/{TICKER}?period=quarter&apikey={KEY}
     *   Notes:     Pre-normalised GAAP mapping across 10-K/10-Q filings.
     *              Handles fiscal year misalignment, TTM rolling windows,
     *              and restatements automatically. Paid tier required for
     *              real-time and bulk sector pulls. Best drop-in replacement
     *              path — API shape maps cleanly onto observedValues keys.
     *
     *   ── Vercel serverless migration path (api/ratios.js) ───────────────────
     *   1. Add env vars: FMP_API_KEY or EDGAR_USER_AGENT (SEC requires UA header)
     *   2. In api/ratios.js:
     *      a. Resolve ticker → CIK via SEC EDGAR /submissions endpoint (or FMP)
     *      b. Fetch the latest 10-Q + 10-K XBRL facts for the target CIK
     *      c. Extract raw GAAP line items from the XBRL fact array
     *      d. Compute observedValues in-function using the same arithmetic
     *         logic already documented in FIELD_REGISTRY / TOOLTIP_DEFINITIONS
     *      e. Return the same { ticker, fiscalDateEnding, observedValues } shape
     *         so zero changes are needed in the front-end calculation or
     *         presentation layers.
     *   3. Add a Redis/Upstash edge-cache layer (TTL 6 h) to avoid redundant
     *      EDGAR polling and respect rate limits.
     *
     * ─────────────────────────────────────────────────────────────────────────
     */

    /**
     * Calls the Vercel serverless proxy at /api/ratios.
     * Returns { ticker, fiscalDateEnding, observedValues } or throws on error.
     *
     * v2 INTEGRATION POINT: swap the fetch URL to /api/ratios-edgar or
     * /api/ratios-fmp once the XBRL pipeline (see architecture block above)
     * is deployed. The response contract is identical.
     */
    async function fetchRatios(ticker) {
      const res = await fetch(`/api/ratios?ticker=${encodeURIComponent(ticker)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to retrieve data. Please try again.');
      return data;
    }

    // ── CALCULATION LAYER ────────────────────────────────────────────────────────
    /**
     * Pure function. No DOM access.
     * Applies each criterion's operator/threshold comparison against the observed value.
     * Returns null for `passed` when the observed value is unavailable.
     */
    function evaluate(observed, operator, threshold) {
      if (observed === null || observed === undefined) return null;
      switch (operator) {
        case '>=':  return observed >= threshold;
        case '<=':  return observed <= threshold;
        case '>':   return observed >  threshold;
        case '<':   return observed <  threshold;
        case '===': return observed === threshold;
        default:    return null;
      }
    }

    /**
     * Pure Calculation Layer. Accepts an explicit config (from getActiveConfig)
     * so sector-specific thresholds flow in without any DOM or side-effect access.
     */
    function runCalculationLayer(observedValues, config) {
      const activeConfig = config ?? getActiveConfig('default');
      return activeConfig.map(criterion => ({
        ...criterion,
        observedValue: observedValues[criterion.id] ?? null,
        passed:        evaluate(
                         observedValues[criterion.id] ?? null,
                         criterion.operator,
                         criterion.threshold
                       ),
      }));
    }

    // ── PRESENTATION LAYER ───────────────────────────────────────────────────────
    /**
     * Consumes only: passed, observedValue, threshold, operator, label, filter, unit.
     * Never performs arithmetic. Groups results by `filter`, then rebuilds the DOM.
     */
    function operatorSymbol(op) {
      return { '>=': '≥', '<=': '≤', '>': '>', '<': '<', '===': '=' }[op] ?? op;
    }

    function formatValue(val, unit) {
      if (val === null || val === undefined) return 'N/A';
      const str = Number.isInteger(val) ? String(val) : Number(val).toFixed(2);
      return unit ? `${str}${unit}` : str;
    }

    function criteriaBadgeClass(statusLabel) {
      const base = 'inline-flex items-center text-xs font-medium font-mono rounded-full px-2.5 py-0.5 border';
      if (statusLabel === 'Criteria Satisfied') {
        return `${base} bg-emerald-500/10 text-emerald-400 border-emerald-500/20`;
      }
      if (statusLabel === 'Criteria Unmet') {
        return `${base} bg-rose-500/10 text-rose-400 border-rose-500/20`;
      }
      return `${base} bg-slate-800/60 text-slate-400 border-slate-600/30`;
    }

    function statusBadgeClass(kind) {
      const base = 'inline-flex items-center text-xs font-medium font-mono rounded-full px-2.5 py-0.5 border';
      if (kind === 'satisfied') {
        return `${base} bg-emerald-500/10 text-emerald-400 border-emerald-500/20`;
      }
      if (kind === 'unmet') {
        return `${base} bg-rose-500/10 text-rose-400 border-rose-500/20`;
      }
      return `${base} bg-slate-800/60 text-slate-400 border-slate-600/30`;
    }

    function metricValueClass(hasValue) {
      return hasValue ? 'text-cyan-400 font-semibold' : 'text-slate-600 font-normal';
    }

    function formatPrice(price) {
      if (price === null || price === undefined) return null;
      return '$' + Number(price).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    function formatChangePercent(pct) {
      if (pct === null || pct === undefined) return null;
      const sign = pct >= 0 ? '+' : '';
      return sign + Number(pct).toFixed(2) + '%';
    }

    function renderStockHeader(ticker, companyName, currentPrice, changePercent) {
      const headerEl  = document.getElementById('stock-header');
      const tickerEl  = document.getElementById('stock-ticker');
      const sepEl     = document.getElementById('stock-sep');
      const companyEl = document.getElementById('stock-company');
      const priceRow  = document.getElementById('stock-price-row');
      const priceEl   = document.getElementById('stock-price');
      const changeEl  = document.getElementById('stock-change');

      if (!headerEl || !tickerEl) return;

      tickerEl.textContent = ticker;

      if (companyName) {
        companyEl.textContent = companyName;
        companyEl.classList.remove('hidden');
        sepEl.classList.remove('hidden');
      } else {
        companyEl.textContent = '';
        companyEl.classList.add('hidden');
        sepEl.classList.add('hidden');
      }

      headerEl.classList.remove('hidden');

      if (currentPrice !== null && currentPrice !== undefined) {
        priceEl.textContent = formatPrice(currentPrice);
        priceRow.classList.remove('hidden');

        if (changePercent !== null && changePercent !== undefined) {
          const isUp = changePercent >= 0;
          changeEl.textContent = formatChangePercent(changePercent);
          changeEl.className = 'change-pill ' + (isUp ? 'change-pill-up' : 'change-pill-down');
          changeEl.setAttribute('aria-label', `Daily change ${formatChangePercent(changePercent)}`);
        } else {
          changeEl.textContent = '';
          changeEl.className = 'change-pill hidden';
          changeEl.removeAttribute('aria-label');
        }
      } else {
        priceRow.classList.add('hidden');
      }
    }

    function hideStockHeader() {
      const headerEl = document.getElementById('stock-header');
      if (headerEl) headerEl.classList.add('hidden');
    }

    function renderDashboard(results, ticker, fiscalDate, observedValues, meta = {}) {
      renderStockHeader(
        ticker,
        meta.companyName ?? null,
        meta.currentPrice ?? null,
        meta.changePercent ?? null
      );

      if (fiscalDate) {
        const dateEl = document.getElementById('heading-date');
        dateEl.textContent = `Data as of ${fiscalDate}`;
        dateEl.classList.remove('hidden');
      }

      // ── Ratio filter cards ────────────────────────────────────────────────────
      const groups = results.reduce((acc, r) => {
        (acc[r.filter] = acc[r.filter] || []).push(r);
        return acc;
      }, {});

      const ratioCards = Object.entries(groups).map(([groupName, items]) => {
        const total     = items.length;
        const satisfied = items.filter(i => i.passed === true).length;
        const hasNull   = items.some(i => i.passed === null);
        const allPass   = satisfied === total && !hasNull;
        const statusLabel = hasNull
          ? 'Data Unavailable'
          : (allPass ? 'Criteria Satisfied' : 'Criteria Unmet');

        const rows = items.map((item, idx) => {
          const observed  = formatValue(item.observedValue, item.unit);
          const threshold = `${operatorSymbol(item.operator)}\u00a0${item.threshold}${item.unit}`;
          const divider   = idx < items.length - 1
            ? `<div class="w-full h-px bg-slate-700/50"></div>`
            : '';
          const valCls = metricValueClass(
            item.observedValue !== null && item.observedValue !== undefined
          );
          const hasTip = item.id in TOOLTIP_DEFINITIONS;
          return `
            <div class="flex justify-between items-center text-sm gap-4">
              <span class="text-slate-400 text-sm${hasTip ? ' cursor-help' : ''}"${hasTip ? ` data-tooltip-key="${item.id}"` : ''}>${item.label}${hasTip ? '<span class="tip-dot">ⓘ</span>' : ''}</span>
              <span class="font-mono text-right ${valCls}">${observed} <span class="text-slate-600 font-normal text-xs">${threshold}</span></span>
            </div>${divider}`;
        }).join('');

        return `
          <div class="bg-brand-800 border border-slate-700/60 rounded-xl p-5 space-y-3">
            <div class="flex items-center justify-between">
              <span class="text-xs font-semibold uppercase tracking-widest text-slate-500">${groupName}</span>
              <span class="${criteriaBadgeClass(statusLabel)}">${statusLabel}</span>
            </div>
            <div class="space-y-2">${rows}</div>
            <div class="pt-1 text-xs text-slate-500">${satisfied} / ${total} criteria met</div>
          </div>`;
      }).join('');

      // ── Structural Risk card ──────────────────────────────────────────────────
      // Compute individual check states so the single-ticker view shows full detail,
      // not just the aggregate flag that the sector scan table shows.
      let structuralRiskCard = '';
      if (observedValues) {
        const ov = observedValues;

        // 1. Vitality
        const vitStatus = calculateVitalityCheck(ov);
        const vitRow = buildSRRow(
          'Vitality',
          'Revenue Growth ≥ 2% &amp; ROE ≥ 10%',
          vitStatus === 'met'     ? 'pass'
        : vitStatus === 'unmet'   ? 'fail'
        : 'unknown',
          vitStatus === 'met'     ? 'Met'
        : vitStatus === 'unmet'   ? 'Below threshold'
        : '— No data',
          'vitality'
        );

        // 2. Dividend Trap
        const pr = ov.payout_ratio ?? null;
        const hasDividend = pr !== null && pr > 0;
        const divRow = buildSRRow(
          'Dividend Trap',
          'Payout Ratio ≤ 80%',
          pr === null             ? 'unknown'
        : !hasDividend            ? 'pass'
        : pr > STRUCTURAL_THRESHOLDS.payoutRatio ? 'fail' : 'pass',
          pr === null             ? '— No data'
        : !hasDividend            ? 'No dividend'
        : pr > STRUCTURAL_THRESHOLDS.payoutRatio
            ? `${(pr * 100).toFixed(0)}% payout`
            : `${(pr * 100).toFixed(0)}% payout`,
          'dividend_trap'
        );

        // 3. Debt Load
        const de = ov.debt_to_equity ?? null;
        const debtTriggered = de !== null && (de > STRUCTURAL_THRESHOLDS.debtToEquity || de < 0);
        const deRow = buildSRRow(
          'Debt Load',
          'D/E ≤ 1.0× (100 in YF format)',
          de === null ? 'unknown' : debtTriggered ? 'fail' : 'pass',
          de === null ? '— No data'
        : debtTriggered
            ? `${de.toFixed(1)} (>${STRUCTURAL_THRESHOLDS.debtToEquity})`
            : `${de.toFixed(1)}`,
          'debt_load'
        );

        // 4. Interest Coverage
        const ic = ov.interest_coverage ?? null;
        const covTriggered = ic !== null && ic < STRUCTURAL_THRESHOLDS.interestCoverage;
        const covRow = buildSRRow(
          'Coverage',
          `EBITDA Coverage ≥ ${STRUCTURAL_THRESHOLDS.interestCoverage}×`,
          ic === null ? 'unknown' : covTriggered ? 'fail' : 'pass',
          ic === null ? '— No debt / no data'
        : covTriggered
            ? `${ic.toFixed(2)}× (below ${STRUCTURAL_THRESHOLDS.interestCoverage}×)`
            : `${ic.toFixed(2)}×`,
          'coverage'
        );

        const { level: srLevel, triggers: srTriggers } = calculateStructuralRisk(ov);
        const srBadgeLabel = srLevel === 'clear'     ? '✓ No Triggers'
                           : srLevel === 'triggered' ? `✗ ${srTriggers.join(', ')}`
                           : '— Insufficient Data';
        const srBadgeCls   = srLevel === 'clear'     ? statusBadgeClass('satisfied')
                           : srLevel === 'triggered' ? statusBadgeClass('unmet')
                           : statusBadgeClass('neutral');
        const triggerCount = srTriggers.length;

        structuralRiskCard = `
          <div class="bg-brand-800 border border-slate-700/60 rounded-xl p-5 space-y-3">
            <div class="flex items-center justify-between">
              <span class="text-xs font-semibold uppercase tracking-widest text-slate-500">Structural Risk</span>
              <span class="${srBadgeCls}">${srBadgeLabel}</span>
            </div>
            <div class="space-y-2">
              ${vitRow}
              <div class="w-full h-px bg-slate-700/50"></div>
              ${divRow}
              <div class="w-full h-px bg-slate-700/50"></div>
              ${deRow}
              <div class="w-full h-px bg-slate-700/50"></div>
              ${covRow}
            </div>
            <div class="pt-1 text-xs text-slate-500">${triggerCount} / 4 trigger${triggerCount !== 1 ? 's' : ''} active</div>
          </div>`;
      }

      // ── Capital Efficiency card (ROIC vs WACC) ────────────────────────────────
      let capitalCard = '';
      if (observedValues) {
        const roic = observedValues.roic ?? null;
        const wacc = observedValues.wacc ?? null;
        const beta = null; // beta not in observedValues; shown as N/A

        if (roic !== null && wacc !== null) {
          const spread      = roic - wacc;
          const aboveWacc   = spread >= 0;
          const spreadSign  = spread >= 0 ? '+' : '−';
          const roicPct     = (roic * 100).toFixed(1);
          const waccPct     = (wacc * 100).toFixed(1);
          const spreadPct   = (Math.abs(spread) * 100).toFixed(1);
          const badgeCls    = aboveWacc ? statusBadgeClass('satisfied') : statusBadgeClass('unmet');
          const badgeLabel  = aboveWacc
            ? `✓ ROIC > WACC (+${spreadPct} pp)`
            : `✗ ROIC < WACC (−${spreadPct} pp)`;
          const valueCls    = 'text-cyan-400 font-semibold';

          capitalCard = `
            <div class="bg-brand-800 border border-slate-700/60 rounded-xl p-5 space-y-3">
              <div class="flex items-center justify-between gap-3">
                <span class="text-xs font-semibold uppercase tracking-widest text-slate-500" data-tooltip-key="roic">Capital Efficiency<span class="tip-dot">ⓘ</span></span>
                <span class="${badgeCls}">${badgeLabel}</span>
              </div>
              <div class="space-y-2">
                <div class="flex justify-between items-center text-sm gap-4">
                  <span class="text-slate-400">Cash ROIC (approx.)</span>
                  <span class="font-mono ${valueCls}">${roicPct}%</span>
                </div>
                <div class="w-full h-px bg-slate-700/50"></div>
                <div class="flex justify-between items-center text-sm gap-4">
                  <span class="text-slate-400">WACC (approx.)</span>
                  <span class="font-mono ${valueCls}">${waccPct}%</span>
                </div>
                <div class="w-full h-px bg-slate-700/50"></div>
                <div class="flex justify-between items-center text-sm gap-4">
                  <span class="text-slate-400">Spread vs WACC</span>
                  <span class="font-mono ${valueCls}">${spreadSign}${spreadPct} pp</span>
                </div>
              </div>
              <div class="pt-1 text-xs text-slate-500">
                EBITDA-based cash NOPAT &middot; CAPM WACC (rf&thinsp;=&thinsp;4.5%, MRP&thinsp;=&thinsp;5.5%) &middot; Not financial advice.
              </div>
            </div>`;
        } else {
          capitalCard = `
            <div class="bg-brand-800 border border-slate-700/60 rounded-xl p-5 space-y-3">
              <div class="flex items-center justify-between">
                <span class="text-xs font-semibold uppercase tracking-widest text-slate-500">Capital Efficiency</span>
                <span class="${statusBadgeClass('neutral')}">— Insufficient Data</span>
              </div>
              <p class="text-sm text-slate-700 py-2">ROIC cannot be computed — required fields (EBITDA, D/E, or equity) are unavailable for this ticker.</p>
            </div>`;
        }
      }

      const container = document.getElementById('filter-cards-container');
      container.innerHTML = ratioCards + structuralRiskCard + capitalCard;

      // ── Completion rate summary ───────────────────────────────────────────────
      const total     = results.length;
      const satisfied = results.filter(r => r.passed === true).length;
      const pct       = total > 0 ? Math.round((satisfied / total) * 100) : 0;

      document.getElementById('summary-fraction').innerHTML =
        `${satisfied} <span class="text-slate-600 text-lg">/</span> ${total}`;
      document.getElementById('summary-pct').textContent  = `${pct}% criteria met`;
      document.getElementById('summary-bar').style.width  = `${pct}%`;
      document.getElementById('completion-summary').classList.remove('hidden');

      // ── TickerInsights panel ──────────────────────────────────────────────────
      TickerInsights(ticker, observedValues, results);
    }

    /**
     * Builds one row for the Structural Risk detail card.
     * status: 'pass' | 'fail' | 'unknown'
     */
    function buildSRRow(label, description, status, detail, tooltipKey) {
      const icon    = status === 'pass' ? '✓' : status === 'fail' ? '✗' : '—';
      const valCls  = status === 'unknown' ? 'text-slate-600 font-normal' : 'text-cyan-400 font-semibold';
      const tipAttr = tooltipKey ? ` data-tooltip-key="${tooltipKey}"` : '';
      const tipDot  = tooltipKey ? '<span class="tip-dot">ⓘ</span>' : '';
      return `
        <div class="flex justify-between items-start text-sm gap-3">
          <div>
            <span class="text-slate-400 cursor-help"${tipAttr}>${label}${tipDot}</span>
            <span class="block text-xs text-slate-600 mt-0.5">${description}</span>
          </div>
          <span class="font-mono whitespace-nowrap ${valCls} flex-shrink-0">${icon} ${detail}</span>
        </div>`;
    }

    // ── TICKER INSIGHTS MODULE ───────────────────────────────────────────────────
    /**
     * TickerInsights — generates a neutral, terminal-grade prose report
     * for a single ticker from its observed values and calculation results.
     *
     * Implemented as a plain-JS module (not React) consistent with this
     * codebase, but follows the same props-driven, side-effect-free pattern.
     * The user-facing name "TickerInsights" is honoured in the public API.
     */

    /**
     * Wraps a numeric string in a styled <span> for inline highlighting.
     * status: 'pass' | 'fail' | 'neutral'
     */
    function _val(text, status) {
      const cls = status === 'pass'    ? 'pass'
                : status === 'fail'    ? 'fail'
                : '';
      return `<span class="insights-val ${cls}">${text}</span>`;
    }

    /**
     * Pure function: converts observedValues + calcResults into an object
     * { p1: string, p2: string } — two prose paragraphs for the report.
     *
     * Uses sector-default thresholds from calcResults so MoS is automatically
     * reflected if the single-ticker view ever applies it in the future.
     *
     * No DOM access, no advice language — arithmetic statements only.
     */
    function generateInsightsText(ov, calcResults) {
      function res(id) { return calcResults.find(r => r.id === id) ?? null; }

      const sentences1 = [];   // Para 1: liquidity, debt, vitality
      const sentences2 = [];   // Para 2: valuation, capital efficiency

      // ── 1. Liquidity (Current Ratio) ─────────────────────────────────────────
      const crRes = res('current_ratio');
      const cr    = ov.current_ratio ?? null;
      if (cr !== null && crRes) {
        const thr = crRes.threshold;
        if (cr >= thr) {
          sentences1.push(
            `The Current Ratio of ${_val(cr.toFixed(2) + 'x', 'pass')} satisfies the ${thr}x requirement, indicating strong short-term liquidity.`
          );
        } else {
          sentences1.push(
            `Short-term liquidity is mathematically insufficient, with a Current Ratio of ${_val(cr.toFixed(2) + 'x', 'fail')} falling below the ${thr}x requirement.`
          );
        }
      }

      // ── 2. Debt Load (Debt/Equity) ───────────────────────────────────────────
      const deRes = res('debt_to_equity');
      const de    = ov.debt_to_equity ?? null;
      if (de !== null && deRes) {
        const thr = deRes.threshold;
        if (de <= thr) {
          sentences1.push(
            `The Debt-to-Equity ratio of ${_val(de.toFixed(1) + '%', 'pass')} is well within the ${thr}% limit, showing a resilient capital structure.`
          );
        } else {
          sentences1.push(
            `The capital structure shows a Debt-to-Equity ratio of ${_val(de.toFixed(1) + '%', 'fail')}, exceeding the conservative maximum limit of ${thr}% and indicating structural reliance on debt.`
          );
        }
      }

      // ── 3. Vitality (Revenue Growth + ROE) ───────────────────────────────────
      const rg  = ov.revenue_growth   ?? null;
      const roe = ov.return_on_equity ?? null;
      const rgPct  = rg  !== null ? (rg  * 100).toFixed(1) : null;
      const roePct = roe !== null ? (roe * 100).toFixed(1) : null;
      const rgPass  = rg  !== null ? rg  >= VITALITY_THRESHOLDS.revenue_growth  : null;
      const roePass = roe !== null ? roe >= VITALITY_THRESHOLDS.return_on_equity : null;

      if (rgPass !== null || roePass !== null) {
        if (rgPass !== false && roePass !== false) {
          // Both present and both passing (or one null)
          const parts = [
            rgPct  !== null ? `Revenue Growth at ${_val(rgPct + '%', 'pass')}`  : null,
            roePct !== null ? `Return on Equity at ${_val(roePct + '%', 'pass')}` : null,
          ].filter(Boolean).join(' and ');
          sentences1.push(`Vitality metrics satisfy baseline operational thresholds — ${parts}.`);
        } else {
          const failing = [
            rgPass  === false ? `Revenue Growth at ${_val(rgPct + '%', 'fail')}`  : null,
            roePass === false ? `Return on Equity at ${_val(roePct + '%', 'fail')}` : null,
          ].filter(Boolean).join(' and ');
          sentences1.push(
            `The enterprise's vitality metrics fall below baseline operational thresholds. Currently, ${failing} is below the required minimum.`
          );
        }
      }

      // ── 4. Valuation (F/K and P/B) ───────────────────────────────────────────
      // "F/K" is the user-designated neutral label for Price-to-Earnings.
      const peRes = res('price_to_earnings');
      const pbRes = res('price_to_book');
      const pe    = ov.price_to_earnings ?? null;
      const pb    = ov.price_to_book     ?? null;
      const pePass = peRes && pe !== null ? pe <= peRes.threshold : null;
      const pbPass = pbRes && pb !== null ? pb <= pbRes.threshold : null;

      if (pe !== null || pb !== null) {
        const fkStr = pe !== null ? `F/K is ${_val(pe.toFixed(1) + 'x', pePass ? 'pass' : 'fail')}` : null;
        const pbStr = pb !== null ? `P/B is ${_val(pb.toFixed(2) + 'x', pbPass ? 'pass' : 'fail')}` : null;
        const vals  = [fkStr, pbStr].filter(Boolean).join(' and ');

        if (pePass === false || pbPass === false) {
          sentences2.push(`Market pricing exceeds predefined defensive ceilings. ${vals}.`);
        } else {
          sentences2.push(`Valuation multiples are within defensive margins (${vals}).`);
        }
      }

      // ── 5. Capital Efficiency (ROIC vs WACC) ─────────────────────────────────
      const roic = ov.roic ?? null;
      const wacc = ov.wacc ?? null;
      if (roic !== null && wacc !== null) {
        const roicPct   = (roic * 100).toFixed(1);
        const waccPct   = (wacc * 100).toFixed(1);
        const spread    = (roic - wacc) * 100;
        const spreadStr = (spread >= 0 ? '+' : '') + spread.toFixed(1);
        const aboveWacc = spread >= 0;
        sentences2.push(
          `The firm generates a cash return on invested capital of ${_val(roicPct + '%', aboveWacc ? 'pass' : 'fail')} against a cost of capital of ${_val(waccPct + '%', 'neutral')}, resulting in a spread of ${_val(spreadStr + ' pp', aboveWacc ? 'pass' : 'fail')}.`
        );
      }

      return {
        p1: sentences1.join(' '),
        p2: sentences2.join(' '),
      };
    }

    /**
     * TickerInsights — renders the terminal analysis panel into #insights-panel.
     * Called by renderDashboard after every successful fetch.
     */
    function TickerInsights(ticker, observedValues, calcResults) {
      const panel      = document.getElementById('insights-panel');
      const toggleRow  = document.getElementById('insights-toggle-row');
      if (!panel || !toggleRow) return;

      const { p1, p2 } = generateInsightsText(observedValues, calcResults);
      if (!p1 && !p2) return;   // no sentences generated — nothing to show

      // ISO timestamp without milliseconds
      const ts = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

      panel.innerHTML = `
        <div class="bg-brand-900 border border-slate-700/40 rounded-xl p-6
                    shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">

          <!-- Terminal header row -->
          <div class="flex flex-wrap items-center justify-between gap-2
                      text-xs font-mono text-slate-600
                      border-b border-slate-800/80 pb-3 mb-5">
            <span>
              <span class="text-slate-400 font-semibold tracking-widest">${ticker}</span>
              <span class="mx-2 opacity-30">|</span>METRIC ANALYSIS
            </span>
            <span class="opacity-60">GENERATED:&thinsp;${ts}</span>
          </div>

          <!-- Prose paragraphs -->
          <div class="space-y-4 text-sm text-slate-400 leading-[1.85]">
            ${p1 ? `<p>${p1}</p>` : ''}
            ${p2 ? `<p>${p2}</p>` : ''}
          </div>

          <!-- Terminal footer -->
          <div class="mt-5 pt-3 border-t border-slate-800/60
                      text-[11px] font-mono text-slate-700 flex items-center gap-1">
            <span>Outputs are arithmetic comparisons only. Not financial advice.</span>
            <span class="cs-cursor"></span>
          </div>
        </div>`;

      toggleRow.classList.remove('hidden');

      // Reset toggle state so it starts collapsed on each new ticker
      const btn = document.getElementById('insights-toggle-btn');
      panel.classList.add('hidden');
      btn.setAttribute('aria-expanded', 'false');
    }

    /** Called by the toggle button in panel-ticker. */
    function toggleInsights() {
      const btn   = document.getElementById('insights-toggle-btn');
      const panel = document.getElementById('insights-panel');
      const open  = btn.getAttribute('aria-expanded') === 'true';

      btn.setAttribute('aria-expanded', String(!open));
      panel.classList.toggle('hidden', open);
    }

    // ── ORCHESTRATOR ─────────────────────────────────────────────────────────────
    /**
     * Triggered by the Run Filters button.
     * Validates input → fetches → calculates → renders.
     */
    async function runScreener() {
      const input     = document.getElementById('ticker-input');
      const errorEl   = document.getElementById('ticker-error');
      const container = document.getElementById('filter-cards-container');
      const runBtn    = document.getElementById('run-btn');

      const ticker = input.value.trim().toUpperCase();
      errorEl.classList.add('hidden');
      errorEl.textContent = '';

      if (!/^[A-Za-z]{1,5}$/.test(ticker)) {
        errorEl.textContent = 'Enter a valid ticker symbol (1–5 letters, e.g. AAPL).';
        errorEl.classList.remove('hidden');
        return;
      }

      // Guard against re-entrant calls (e.g. rapid Enter key presses)
      if (runBtn.disabled) return;

      // Loading state
      runBtn.disabled   = true;
      runBtn.innerHTML  = `<svg class="animate-spin inline-block w-3.5 h-3.5 mr-1.5 -mt-0.5 opacity-70" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"></path></svg>Fetching…`;
      document.getElementById('completion-summary').classList.add('hidden');
      hideStockHeader();
      document.getElementById('heading-date').classList.add('hidden');
      // Hide the insights toggle and panel when starting a fresh fetch
      document.getElementById('insights-toggle-row').classList.add('hidden');
      document.getElementById('insights-panel').classList.add('hidden');

      container.innerHTML = `
        <div class="col-span-full flex items-center justify-center py-20 text-slate-500 text-sm">
          <svg class="animate-spin w-4 h-4 mr-2.5 text-slate-500" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"></path>
          </svg>
          Retrieving data for <span class="font-mono ml-1 text-slate-400">${ticker}</span>…
        </div>`;

      try {
        const data    = await fetchRatios(ticker);
        const results = runCalculationLayer(data.observedValues, getActiveConfig('default'));
        renderDashboard(results, ticker, data.fiscalDateEnding, data.observedValues, {
          companyName:   data.companyName,
          currentPrice:  data.currentPrice,
          changePercent: data.changePercent,
        });
      } catch (err) {
        container.innerHTML = `
          <div class="col-span-full bg-brand-800 border border-slate-700/60 rounded-xl p-6 text-center">
            <p class="text-sm text-slate-500">${err.message || 'An unexpected error occurred. Please try again.'}</p>
          </div>`;
      } finally {
        runBtn.disabled   = false;
        runBtn.innerHTML  = 'Run Filters';
      }
    }

    // ── TAB SWITCHER ─────────────────────────────────────────────────────────────
    function switchTab(tab, opts = {}) {
      const isTickerTab = tab === 'ticker';

      document.getElementById('panel-ticker').classList.toggle('hidden', !isTickerTab);
      document.getElementById('panel-sector').classList.toggle('hidden',  isTickerTab);

      function setTabActive(btn, active) {
        if (active) {
          btn.classList.remove('text-slate-500', 'border-transparent');
          btn.classList.add('text-slate-300', 'border-slate-400');
        } else {
          btn.classList.remove('text-slate-300', 'border-slate-400');
          btn.classList.add('text-slate-500', 'border-transparent');
        }
      }

      setTabActive(document.getElementById('tab-ticker'), isTickerTab);
      setTabActive(document.getElementById('tab-sector'), !isTickerTab);

      if (!opts.preserveContext) {
        hideStockHeader();
        document.getElementById('heading-date').classList.add('hidden');
      }
    }

    // ── SECTOR DATA LAYER ────────────────────────────────────────────────────────
    /**
     * Calls /api/sector. Returns { sector, cachedAt, companies[] } or throws.
     * Each company: { symbol, companyName, observedValues }
     *
     * v2 INTEGRATION POINT (bulk sector pull via FMP or SEC EDGAR):
     *   The sector constituent list (array of tickers per sector) is currently
     *   hardcoded in api/sector.js. In v2, this should be replaced with:
     *
     *   ── FMP /stock-screener endpoint ────────────────────────────────────────
     *   GET https://financialmodelingprep.com/api/v3/stock-screener
     *       ?sector={SECTOR}&exchange=NYSE,NASDAQ&limit=50&apikey={KEY}
     *   Returns: [ { symbol, companyName, sector, industry, marketCap, ... } ]
     *   Then pipe each symbol through the /api/ratios-fmp route described above.
     *
     *   ── SEC EDGAR SIC-code bulk pull ────────────────────────────────────────
     *   Map GICS sector → SIC code ranges (e.g. Technology = 3570–3579, 7370–7379).
     *   GET https://data.sec.gov/submissions/{CIK}.json for each CIK in SIC range.
     *   This path is free but requires pre-built SIC→ticker mapping maintained
     *   as a Vercel KV (edge) lookup table and refreshed quarterly.
     *
     *   ── Caching strategy ────────────────────────────────────────────────────
     *   Sector bulk fetches are expensive (N tickers × 3 financial statement
     *   requests each). Cache the full sector payload in Upstash Redis with a
     *   6-hour TTL. The cachedAt field in the response is already surfaced in
     *   the UI via the heading-date element.
     */
    async function fetchSector(sector) {
      const res  = await fetch(`/api/sector?sector=${encodeURIComponent(sector)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to retrieve sector data. Please try again.');
      return data;
    }

    const TREND_DEBUG_EL_ID = 'sector-trend-debug';
    const TREND_FETCH_TIMEOUT_MS = 15000;

    function escapeHtml(value) {
      return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function showTrendDebug(html) {
      const el = document.getElementById(TREND_DEBUG_EL_ID);
      if (el) el.innerHTML = html;
    }

    /**
     * Fetches 3-month momentum and SMA200 status for a sector ETF from /api/trend.
     * Returns the JSON payload or throws with a descriptive message on failure.
     * On failure, writes the error directly into #sector-trend-debug for live Vercel debugging.
     */
    async function fetchSectorTrend(etfTicker) {
      const url = `/api/trend?ticker=${encodeURIComponent(etfTicker)}`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TREND_FETCH_TIMEOUT_MS);

      showTrendDebug(
        `<div class="px-4 py-3 rounded-lg border border-slate-600 bg-slate-900 font-mono text-sm text-slate-400">` +
        `Calling ${escapeHtml(url)}…` +
        `</div>`
      );

      try {
        const res = await fetch(url, { signal: controller.signal });
        let data;
        const rawBody = await res.text();
        try {
          data = rawBody ? JSON.parse(rawBody) : {};
        } catch (parseErr) {
          throw new Error(
            `HTTP ${res.status} — non-JSON response: ${rawBody.slice(0, 200) || '(empty)'}`
          );
        }
        if (!res.ok) {
          throw new Error(data.error ? `HTTP ${res.status}: ${data.error}` : `HTTP ${res.status}: Trend data unavailable`);
        }

        showTrendDebug(
          `<div class="px-4 py-3 rounded-lg border border-slate-600 bg-slate-900 font-mono text-sm text-slate-400">` +
          `Trend API OK (${escapeHtml(etfTicker)}): ${escapeHtml(JSON.stringify(data))}` +
          `</div>`
        );
        return data;
      } catch (err) {
        let message = err.message || String(err);
        if (err.name === 'AbortError') {
          message = `Request timed out after ${TREND_FETCH_TIMEOUT_MS / 1000}s (possible Vercel function timeout)`;
        } else if (err instanceof TypeError) {
          message = `Network error calling ${url}: ${err.message}`;
        }

        // Explicit live-site error — visible on Vercel without console/logs
        const debugEl = document.getElementById(TREND_DEBUG_EL_ID);
        if (debugEl) {
          debugEl.innerHTML =
            `<div class="px-4 py-4 rounded-lg border-2 border-slate-500 bg-slate-900 font-mono text-base text-slate-100">` +
            `<div class="text-xs uppercase tracking-widest text-slate-500 mb-2">Sector Macro Trend — Live Debug</div>` +
            `<div><span class="text-slate-500">URL:</span> ${escapeHtml(url)}</div>` +
            `<div class="mt-2 font-semibold">Error: ${escapeHtml(message)}</div>` +
            `</div>`;
        }

        throw new Error(message);
      } finally {
        clearTimeout(timeoutId);
      }
    }

    /**
     * Prepends a single-line terminal-style Sector Macro Trend banner to the
     * top of the sector results container. Called after renderSectorTable().
     *
     * @param {HTMLElement} container - The #sector-table-container element
     * @param {Object}      trend     - Response from /api/trend
     * @param {string}      etfTicker - e.g. "XLK"
     */
    function injectTrendBanner(container, trend, etfTicker) {
      showTrendDebug('');
      const mom       = trend.momentum3m;
      const sign      = mom >= 0 ? '+' : '';
      const flowColor = mom >= 0 ? 'text-emerald-400' : 'text-rose-400';
      const flowEmoji = mom >= 0 ? '🟢' : '🔴';
      const trendLabel = trend.aboveSMA200 ? 'ABOVE SMA200' : 'BELOW SMA200';
      const trendNote  = trend.aboveSMA200
        ? '(Current &gt; SMA200)'
        : '(Current &lt; SMA200)';

      const banner = `
        <div class="mb-4 flex items-center gap-2 px-4 py-2.5 rounded-lg border border-slate-700/60 bg-slate-900/60 font-mono text-xs text-slate-400 overflow-x-auto whitespace-nowrap">
          <span class="text-slate-500 tracking-widest uppercase">Sector Macro</span>
          <span class="text-slate-600">|</span>
          <span class="font-semibold text-slate-300">(${etfTicker})</span>
          <span class="text-slate-600">|</span>
          <span>3M Flow:</span>
          <span class="${flowColor} font-semibold">${sign}${mom.toFixed(2)}%</span>
          <span>${flowEmoji}</span>
          <span class="text-slate-600">|</span>
          <span>Trend:</span>
          <span class="font-semibold text-slate-300">${trendLabel}</span>
          <span class="text-slate-600 font-normal">${trendNote}</span>
        </div>`;

      container.insertAdjacentHTML('afterbegin', banner);
    }

    // ── VITALITY CHECK ENGINE ────────────────────────────────────────────────────
    /**
     * Evaluates top-line growth and capital efficiency against fixed thresholds.
     *
     * Thresholds (per user specification):
     *   revenueGrowth  >= 0.02  (≥ 2% TTM revenue growth)
     *   returnOnEquity >= 0.10  (≥ 10% TTM ROE)
     *
     * Returns:
     *   'met'     — both criteria satisfied
     *   'unmet'   — at least one criterion missed (or negative value)
     *   'unknown' — insufficient data to evaluate
     *
     * Pure function. No DOM access. No investment advice.
     */
    const VITALITY_THRESHOLDS = { revenue_growth: 0.02, return_on_equity: 0.10 };

    function calculateVitalityCheck(observedValues) {
      const rg  = observedValues.revenue_growth  ?? null;
      const roe = observedValues.return_on_equity ?? null;

      // Both fields missing → unknown
      if (rg === null && roe === null) return 'unknown';

      // Any present field that fails immediately → unmet
      if (rg  !== null && rg  < VITALITY_THRESHOLDS.revenue_growth)  return 'unmet';
      if (roe !== null && roe < VITALITY_THRESHOLDS.return_on_equity) return 'unmet';

      // Partial data where present field passes but the other is missing → unknown
      if (rg === null || roe === null) return 'unknown';

      return 'met';
    }

    // Numeric score used for sorting (higher = stronger vitality, used internally)
    const VITALITY_SCORE = { met: 2, unknown: 1, unmet: 0 };

    // ── STRUCTURAL RISK ENGINE ───────────────────────────────────────────────────
    /**
     * Combines Vitality (growth + ROE), Dividend Trap, Debt Load, and Coverage checks.
     *
     * Thresholds:
     *   payoutRatio > 0.80  → Dividend Trap flag  (ignored if 0 or null = no dividend)
     *   debtToEquity > 100  → Debt Load flag       (Yahoo Finance % format: 100 = 1.0x D/E)
     *   debtToEquity < 0    → Debt Load flag       (negative equity = extreme leverage)
     *
     * Returns { level: 'clear'|'triggered'|'unknown', triggers: string[] }
     * Pure function. No DOM access. No investment advice.
     */
    const STRUCTURAL_THRESHOLDS = {
      payoutRatio:      0.80,  // > 80 % of earnings paid out → Dividend trigger
      debtToEquity:     100,   // > 100 (Yahoo Finance % format, i.e. D/E > 1.0×) → Debt Load trigger
      // EBITDA / (totalDebt × 5%) proxy; 3.0× = investment-grade credit-analyst floor.
      // Traditional 5× is for direct interest expense data; this proxy uses EBITDA
      // to give REITs/utilities a fair comparison despite high real-asset depreciation.
      interestCoverage: 3.0,
    };

    function calculateStructuralRisk(observedValues) {
      const triggers = [];

      // 1. Vitality (revenue growth + ROE)
      if (calculateVitalityCheck(observedValues) === 'unmet') triggers.push('Vitality');

      // 2. Dividend Trap: payout > 80% of earnings (skip if null/zero = no dividend)
      const pr = observedValues.payout_ratio ?? null;
      if (pr !== null && pr > 0 && pr > STRUCTURAL_THRESHOLDS.payoutRatio) triggers.push('Dividend');

      // 3. Debt Load: D/E > 1.0× (> 100 in Yahoo Finance % format) or negative equity
      const de = observedValues.debt_to_equity ?? null;
      if (de !== null && (de > STRUCTURAL_THRESHOLDS.debtToEquity || de < 0)) triggers.push('Debt Load');

      // 4. Coverage: operating income / implied interest expense < 5×
      //    A null value means either no debt (auto-pass) or data unavailable (skip, benefit of the doubt).
      //    Only flag when we have a positive computed value that falls below the threshold.
      const ic = observedValues.interest_coverage ?? null;
      if (ic !== null && ic < STRUCTURAL_THRESHOLDS.interestCoverage) triggers.push('Coverage');

      if (triggers.length > 0) return { level: 'triggered', triggers };

      // No triggers — check if we have enough data to call it clear
      const hasAnyData = [
        observedValues.revenue_growth,
        observedValues.return_on_equity,
        pr,
        de,
      ].some(v => v !== null && v !== undefined);

      return hasAnyData
        ? { level: 'clear',   triggers: [] }
        : { level: 'unknown', triggers: [] };
    }

    // Score for sorting: clear = 10, unknown = 5, triggered sorts lower with more flags
    function structuralRiskScore(observedValues) {
      const { level, triggers } = calculateStructuralRisk(observedValues);
      if (level === 'clear')   return 10;
      if (level === 'unknown') return 5;
      return Math.max(0, 5 - triggers.length); // 1 flag=4, 2 flags=3, 3 flags=2, 4 flags=1
    }

    // ── RANKING ENGINE (pure — no DOM access) ────────────────────────────────────
    /**
     * Sorts companies by sortById using an explicit direction.
     * Handles string columns (companyName, symbol), computed columns
     * (criteria_met) and numeric ratio columns.
     * Null values always sink to the bottom regardless of sort direction.
     * Returns a new array with a `rank` integer appended.
     */
    function rankCompanies(companies, sortById, sortDir, activeConfig) {
      const field      = FIELD_REGISTRY.find(f => f.id === sortById);
      const defaultDir = sortById === 'criteria_met' ? 'desc'
                       : (field?.rankDir ?? 'asc');
      const dir = sortDir ?? defaultDir;

      return [...companies]
        .sort((a, b) => {
          if (sortById === 'companyName') {
            const va = a.companyName ?? '';
            const vb = b.companyName ?? '';
            return dir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
          }
          if (sortById === 'symbol') {
            const va = a.symbol ?? '';
            const vb = b.symbol ?? '';
            return dir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
          }
          if (sortById === 'criteria_met') {
            const calcA = activeConfig ? runCalculationLayer(a.observedValues, activeConfig) : [];
            const calcB = activeConfig ? runCalculationLayer(b.observedValues, activeConfig) : [];
            const va = calcA.filter(r => r.passed === true).length;
            const vb = calcB.filter(r => r.passed === true).length;
            return dir === 'asc' ? va - vb : vb - va;
          }
          if (sortById === 'structural_risk') {
            const va = structuralRiskScore(a.observedValues);
            const vb = structuralRiskScore(b.observedValues);
            return dir === 'asc' ? va - vb : vb - va;
          }
          // Numeric ratio column — null always sinks to bottom
          const va = a.observedValues?.[sortById] ?? null;
          const vb = b.observedValues?.[sortById] ?? null;
          if (va === null && vb === null) return 0;
          if (va === null) return 1;
          if (vb === null) return -1;
          return dir === 'asc' ? va - vb : vb - va;
        })
        .map((c, i) => ({ ...c, rank: i + 1 }));
    }

    // ── SECTOR PRESENTATION LAYER ────────────────────────────────────────────────
    // Module-level store for re-sorting without re-fetching.
    let _sectorCompanies = null;
    let _sectorName      = null;
    // Tracks the active column and direction so headers can toggle on re-click.
    let _sortState = { id: null, dir: 'asc' };

    /**
     * Renders the sector results table.
     * sortState = { id: string, dir: 'asc'|'desc' }
     * All column headers are clickable; active column shows ↑ or ↓.
     */
    function renderSectorTable(rankedCompanies, sortState, activeConfig) {
      const container = document.getElementById('sector-table-container');

      if (!rankedCompanies.length) {
        container.innerHTML = `<p class="text-sm text-slate-500 py-10 text-center">No companies returned for this sector.</p>`;
        return;
      }

      function thCls(id, align) {
        const active = id === sortState.id;
        const base   = `px-4 py-3 text-xs font-semibold uppercase tracking-widest cursor-pointer select-none whitespace-nowrap transition-colors ${align ?? ''}`;
        return `${base} ${active ? 'text-slate-300' : 'text-slate-400 hover:text-slate-300'}`;
      }
      function arrow(id) {
        if (id !== sortState.id) return ` <span class="opacity-25">⇅</span>`;
        return sortState.dir === 'asc' ? ' ↑' : ' ↓';
      }

      // Ratio column headers (right-aligned, numeric)
      // data-tooltip-key triggers the global floating tooltip engine.
      const colHeaders = FIELD_REGISTRY.map(f =>
        `<th scope="col" onclick="resortTable('${f.id}')" class="${thCls(f.id, 'text-right')}" data-tooltip-key="${f.id}">
           ${f.label}<span class="tip-dot">ⓘ</span>${arrow(f.id)}
         </th>`
      ).join('');

      // Data rows
      const rows = rankedCompanies.map(company => {
        const calcResults = runCalculationLayer(company.observedValues, activeConfig);
        const metCount    = calcResults.filter(r => r.passed === true).length;
        const total       = calcResults.length;

        const cells = FIELD_REGISTRY.map(f => {
          const rawVal    = company.observedValues[f.id] ?? null;
          const isNull    = rawVal === null;
          const valStr    = formatValue(rawVal, f.unit);
          const isActive  = f.id === sortState.id;
          const criterion = calcResults.find(r => r.id === f.id);
          const textCls = isNull ? 'text-slate-600 font-normal' : 'text-cyan-400 font-semibold';
          return `<td class="px-4 py-3 text-sm font-mono tabular-nums text-right whitespace-nowrap ${textCls}">${valStr}</td>`;
        }).join('');

        // Structural Risk cell (Vitality + Dividend Trap + Debt Load + Coverage)
        const { level: srLevel, triggers: srTriggers } = calculateStructuralRisk(company.observedValues);
        const srActive = 'structural_risk' === sortState.id;
        let srText, srCls;
        if (srLevel === 'clear') {
          srText = '✓ No Triggers';
          srCls  = 'text-emerald-400 font-medium';
        } else if (srLevel === 'triggered') {
          const label = srTriggers.length > 1 ? `${srTriggers.join(', ')}` : srTriggers[0];
          srText = `✗ ${label}`;
          srCls  = 'text-rose-400 font-medium';
        } else {
          srText = '— No Data';
          srCls  = 'text-slate-600';
        }

        const roic    = company.observedValues.roic ?? null;
        const wacc    = company.observedValues.wacc ?? null;
        const roicAct = 'roic' === sortState.id;
        let roicText, roicCls;
        if (roic === null || wacc === null) {
          roicText = '—';
          roicCls  = 'text-slate-600 font-normal';
        } else {
          const roicPct  = (roic * 100).toFixed(1);
          const spread   = roic - wacc;
          const spreadPct = (Math.abs(spread) * 100).toFixed(1);
          const sign     = spread >= 0 ? '+' : '−';
          roicText = `${roicPct}% <span class="text-xs text-slate-500 font-normal">(${sign}${spreadPct}pp)</span>`;
          roicCls  = roicAct ? 'text-cyan-300 font-semibold' : 'text-cyan-400 font-semibold';
        }

        // Ticker cell uses font-sans so letter O is unambiguous from digit 0
        return `
          <tr class="border-t border-slate-800/80 hover:bg-slate-800/30 transition-colors">
            <td class="px-4 py-3 text-sm font-mono text-slate-600 text-center w-12 sticky-col-rank">${company.rank}</td>
            <td class="px-4 py-3 text-sm text-slate-400 w-48 sticky-col-company">
              <div class="truncate max-w-[11rem]" title="${company.companyName}">${company.companyName}</div>
            </td>
            <td class="px-4 py-3 text-sm w-20 sticky-col-ticker">
              <button
                type="button"
                class="font-semibold font-mono text-slate-200 hover:text-cyan-300 transition-colors cursor-pointer"
                onclick="selectStockFromSearch('${company.symbol}')"
                title="View detailed analysis for ${escapeHtml(company.symbol)}"
              >${company.symbol}</button>
            </td>
            ${cells}
            <td class="px-4 py-3 text-sm font-mono tabular-nums text-cyan-400 font-semibold text-right whitespace-nowrap ${'criteria_met' === sortState.id ? '!text-cyan-300' : ''}">${metCount}&thinsp;/&thinsp;${total}</td>
            <td class="px-4 py-3 text-sm font-mono text-right whitespace-nowrap ${srCls}">${srText}</td>
            <td class="px-4 py-3 text-sm font-mono tabular-nums text-right whitespace-nowrap ${roicCls}">${roicText}</td>
          </tr>`;
      }).join('');

      container.innerHTML = `
        <div class="overflow-x-auto rounded-xl border border-slate-700/60">
          <table class="w-full min-w-[860px] border-collapse text-left bg-brand-800">
            <thead>
              <tr class="bg-brand-900 border-b border-slate-700/80">
                <th scope="col" class="px-4 py-3 text-xs font-semibold uppercase tracking-widest text-slate-400 text-center w-12 sticky-col-rank">Rank</th>
                <th scope="col" onclick="resortTable('companyName')" class="${thCls('companyName', 'w-48')} sticky-col-company">Company${arrow('companyName')}</th>
                <th scope="col" onclick="resortTable('symbol')" class="${thCls('symbol', 'w-20')} sticky-col-ticker">Ticker${arrow('symbol')}</th>
                ${colHeaders}
                <th scope="col" onclick="resortTable('criteria_met')" class="${thCls('criteria_met', 'text-right')}">Criteria Met${arrow('criteria_met')}</th>
                <th scope="col" onclick="resortTable('structural_risk')" class="${thCls('structural_risk', 'text-right')}">Structural Risk${arrow('structural_risk')}</th>
                <th scope="col" onclick="resortTable('roic')" class="${thCls('roic', 'text-right')}" data-tooltip-key="roic">ROIC <span class="font-normal opacity-50 normal-case tracking-normal">(vs WACC)</span><span class="tip-dot">ⓘ</span>${arrow('roic')}</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        <p class="mt-3 text-xs text-slate-500 text-right">
          Rank is an arithmetic sort position only. ROIC is an approximation (EBITDA-based cash NOPAT; WACC via CAPM). Not financial advice.
        </p>`;

      // Reveal the in-table filter and clear any previous query
      const filterWrap  = document.getElementById('sector-filter-wrap');
      const filterInput = document.getElementById('sector-filter-input');
      if (filterWrap)  filterWrap.classList.remove('hidden');
      if (filterInput) { filterInput.value = ''; filterSectorTable(''); }
    }

    /**
     * Called by all clickable column headers.
     * Same column → toggles direction. New column → resets to its natural direction.
     */
    function resortTable(colId) {
      if (!_sectorCompanies) return;

      if (_sortState.id === colId) {
        _sortState.dir = _sortState.dir === 'asc' ? 'desc' : 'asc';
      } else {
        _sortState.id  = colId;
        const field    = FIELD_REGISTRY.find(f => f.id === colId);
        _sortState.dir = colId === 'criteria_met'    ? 'desc'
                       : colId === 'structural_risk' ? 'desc'
                       : colId === 'roic'            ? 'desc'   // higher ROIC = better
                       : colId === 'companyName'     ? 'asc'
                       : colId === 'symbol'          ? 'asc'
                       : (field?.rankDir ?? 'asc');
      }


      const activeConfig = getActiveConfig(_sectorName ?? 'default', getMoS());
      const ranked       = rankCompanies(_sectorCompanies, _sortState.id, _sortState.dir, activeConfig);
      renderSectorTable(ranked, _sortState, activeConfig);
    }

    /**
     * Called instantly when the Margin of Safety selector changes.
     * Re-evaluates and re-renders the existing results without re-fetching.
     */
    function onMoSChange() {
      if (!_sectorCompanies || !_sectorName) return;
      const mos          = getMoS();
      const activeConfig = getActiveConfig(_sectorName, mos);
      // Refresh the threshold reference panel with tightened values
      const mosLabel = mos > 0 ? ` — <span class="text-slate-500">${(mos * 100).toFixed(0)}% MoS applied</span>` : '';
      document.getElementById('sector-threshold-name').innerHTML =
        (_sectorName === 'default' ? 'General' : _sectorName) + mosLabel;
      document.getElementById('sector-threshold-list').innerHTML = activeConfig.map(f =>
        `<span>${f.label}: <span class="text-slate-500">${f.operator} ${+f.threshold.toFixed(2)}${f.unit}</span></span>`
      ).join('');
      const ranked = rankCompanies(_sectorCompanies, _sortState.id, _sortState.dir, activeConfig);
      renderSectorTable(ranked, _sortState, activeConfig);
    }

    // ── SECTOR ORCHESTRATOR ──────────────────────────────────────────────────────
    async function runSectorScan() {
      const sector    = document.getElementById('sector-select').value;
      const sortBy    = 'price_to_earnings'; // default initial sort; user can click headers to change
      const scanBtn   = document.getElementById('scan-btn');
      const errorEl   = document.getElementById('sector-error');
      const container = document.getElementById('sector-table-container');

      // Guard against re-entrant calls during a long bulk fetch
      if (scanBtn.disabled) return;

      errorEl.classList.add('hidden');
      errorEl.textContent = '';
      showTrendDebug('');

      scanBtn.disabled  = true;
      scanBtn.innerHTML = `<svg class="animate-spin inline-block w-3.5 h-3.5 mr-1.5 -mt-0.5 opacity-70" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"></path></svg>Scanning…`;

      // Hide the in-table filter while a new scan is in flight
      const _filterWrap  = document.getElementById('sector-filter-wrap');
      const _filterInput = document.getElementById('sector-filter-input');
      if (_filterWrap)  _filterWrap.classList.add('hidden');
      if (_filterInput) { _filterInput.value = ''; }

      const sectorLabel = sector === 'default' ? 'General' : sector;
      hideStockHeader();
      document.getElementById('heading-date').classList.add('hidden');

      // Show threshold reference panel (with MoS applied)
      const mos          = getMoS();
      const activeConfig = getActiveConfig(sector, mos);
      const mosLabel     = mos > 0 ? ` — <span class="text-slate-500">${(mos * 100).toFixed(0)}% MoS applied</span>` : '';
      document.getElementById('sector-threshold-name').innerHTML = sectorLabel + mosLabel;
      document.getElementById('sector-threshold-list').innerHTML = activeConfig.map(f =>
        `<span>${f.label}: <span class="text-slate-500">${f.operator} ${+f.threshold.toFixed(2)}${f.unit}</span></span>`
      ).join('');
      document.getElementById('sector-thresholds').classList.remove('hidden');

      container.innerHTML = `
        <div class="flex items-center justify-center py-20 text-slate-500 text-sm">
          <svg class="animate-spin w-4 h-4 mr-2.5 text-slate-500" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"></path>
          </svg>
          Scanning <span class="font-mono ml-1 text-slate-400">${sectorLabel}</span>…
        </div>`;

      const etfTicker = SECTOR_ETF_MAP[sector] ?? 'SPY';

      try {
        // Fire sector data and ETF trend in parallel; a trend failure never blocks the scan
        const [sectorResult, trendResult] = await Promise.allSettled([
          fetchSector(sector),
          fetchSectorTrend(etfTicker),
        ]);

        if (sectorResult.status === 'rejected') throw sectorResult.reason;
        const data         = sectorResult.value;
        _sectorCompanies   = data.companies;
        _sectorName        = sector;

        // Initialise sort state from the dropdown selection (natural direction)
        const initField = FIELD_REGISTRY.find(f => f.id === sortBy);
        _sortState = { id: sortBy, dir: initField?.rankDir ?? 'asc' };

        const dateEl = document.getElementById('heading-date');
        if (data.cachedAt) {
          dateEl.textContent = `Cached ${new Date(data.cachedAt).toLocaleString()}`;
          dateEl.classList.remove('hidden');
        } else if (data.skipped > 0) {
          dateEl.textContent = `${data.totalReturned} of ${data.totalRequested} companies returned (${data.skipped} skipped — data unavailable)`;
          dateEl.classList.remove('hidden');
        }

        const ranked = rankCompanies(_sectorCompanies, _sortState.id, _sortState.dir, activeConfig);
        renderSectorTable(ranked, _sortState, activeConfig);

        // Prepend the Sector Macro Trend banner above the results table
        if (trendResult.status === 'fulfilled') {
          try {
            injectTrendBanner(container, trendResult.value, etfTicker);
          } catch (bannerErr) {
            document.getElementById(TREND_DEBUG_EL_ID).innerHTML =
              'Error: Banner render failed — ' + bannerErr.message +
              ' | Payload: ' + JSON.stringify(trendResult.value);
          }
        }
        // On rejection, fetchSectorTrend catch already wrote to #sector-trend-debug
      } catch (err) {
        _sectorCompanies = null;
        container.innerHTML = `
          <div class="bg-brand-800 border border-slate-700/60 rounded-xl p-6 text-center">
            <p class="text-sm text-slate-500">${err.message || 'An unexpected error occurred. Please try again.'}</p>
          </div>`;
      } finally {
        scanBtn.disabled  = false;
        scanBtn.innerHTML = 'Scan Sector';
      }
    }

    /**
     * Enables the CTA button when the acknowledgement checkbox is checked.
     * The button remains disabled (and visually locked) until the user
     * explicitly confirms they have read the disclaimer.
     */
    function handleCheckbox(checkbox) {
      const btn = document.getElementById('cta-btn');
      if (checkbox.checked) {
        btn.disabled = false;
        btn.classList.remove(
          'bg-slate-700', 'text-slate-500', 'cursor-not-allowed', 'border-slate-600/40'
        );
        btn.classList.add(
          'bg-slate-600', 'text-slate-100', 'cursor-pointer',
          'border-slate-500', 'hover:bg-slate-500', 'hover:border-slate-400',
          'unlocked'
        );
      } else {
        btn.disabled = true;
        btn.classList.add(
          'bg-slate-700', 'text-slate-500', 'cursor-not-allowed', 'border-slate-600/40'
        );
        btn.classList.remove(
          'bg-slate-600', 'text-slate-100', 'cursor-pointer',
          'border-slate-500', 'hover:bg-slate-500', 'hover:border-slate-400',
          'unlocked'
        );
      }
    }

    /**
     * Versioned disclaimer key — bump to 'cs.disclaimer.v2' if terms change
     * and a fresh acknowledgement is required from all returning users.
     * Stored in localStorage so the acceptance persists across sessions;
     * betaAccessGranted stays in sessionStorage (intentional — re-gates on
     * every new browser session while the beta is active).
     */
    const DISCLAIMER_KEY = 'cs.disclaimer.v1';

    /**
     * Dismisses the disclaimer overlay and reveals the main dashboard.
     * Only callable when the CTA button is enabled (checkbox checked).
     *
     * Records acknowledgement in localStorage (via DISCLAIMER_KEY) so
     * returning users are not re-prompted every session.
     */
    function dismissDisclaimer() {
      if (sessionStorage.getItem('betaAccessGranted') !== 'true') return;

      const overlay = document.getElementById('disclaimer-overlay');
      const dashboard = document.getElementById('main-dashboard');

      // Animate overlay out — skip transition for users who prefer reduced motion
      const noMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      overlay.style.transition = noMotion ? 'none' : 'opacity 0.3s ease, transform 0.3s ease';
      overlay.style.opacity = '0';
      overlay.style.transform = 'scale(1.02)';

      setTimeout(() => {
        overlay.style.display = 'none';
        overlay.setAttribute('aria-hidden', 'true');
        dashboard.classList.remove('hidden');
        localStorage.setItem(DISCLAIMER_KEY, 'true');
        focusGlobalSearch();
      }, noMotion ? 0 : 300);
    }

    /**
     * On page load: beta gate → disclaimer → dashboard.
     */
    (function init() {
      const betaGranted     = sessionStorage.getItem('betaAccessGranted') === 'true';
      const disclaimerAcked = localStorage.getItem(DISCLAIMER_KEY) === 'true';

      if (betaGranted && disclaimerAcked) {
        document.getElementById('beta-gate-overlay').style.display = 'none';
        document.getElementById('disclaimer-overlay').style.display = 'none';
        document.getElementById('main-dashboard').classList.remove('hidden');
        focusGlobalSearch();
      } else if (betaGranted) {
        document.getElementById('beta-gate-overlay').style.display = 'none';
        document.getElementById('disclaimer-overlay').style.display = 'flex';
      } else {
        document.getElementById('beta-gate-overlay').style.display = 'flex';
        document.getElementById('beta-gate-overlay').setAttribute('aria-hidden', 'false');
        document.getElementById('disclaimer-overlay').style.display = 'none';
      }

      initGlobalSearch();
      initSectorCombobox();
      initSectorFilter();
      initSearchShortcut();

      if (!betaGranted) {
        const betaInput = document.getElementById('beta-code-input');
        if (betaInput) setTimeout(() => betaInput.focus(), 100);
      }
    })();

    // ── BETA ACCESS GATE ─────────────────────────────────────────────────────────
    function dismissBetaGate() {
      const overlay = document.getElementById('beta-gate-overlay');
      if (!overlay) return;

      const noMotionBeta = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      overlay.style.transition = noMotionBeta ? 'none' : 'opacity 0.35s ease';
      overlay.style.opacity = '0';

      setTimeout(() => {
        overlay.style.display = 'none';
        overlay.setAttribute('aria-hidden', 'true');

        const disclaimerAcked = localStorage.getItem(DISCLAIMER_KEY) === 'true';
        if (disclaimerAcked) {
          document.getElementById('disclaimer-overlay').style.display = 'none';
          document.getElementById('main-dashboard').classList.remove('hidden');
        } else {
          const disclaimer = document.getElementById('disclaimer-overlay');
          disclaimer.style.display = 'flex';
          disclaimer.setAttribute('aria-hidden', 'false');
          const betaInput = document.getElementById('beta-code-input');
          if (betaInput) betaInput.blur();
        }
      }, noMotionBeta ? 0 : 350);
    }

    async function submitBetaCode() {
      const input   = document.getElementById('beta-code-input');
      const errorEl = document.getElementById('beta-error');
      const btn     = document.getElementById('beta-submit-btn');
      const code    = input.value.trim();

      errorEl.classList.add('hidden');
      errorEl.textContent = '';
      if (!code) {
        errorEl.textContent = 'Enter your beta access code.';
        errorEl.classList.remove('hidden');
        return;
      }

      btn.disabled = true;
      btn.textContent = 'Checking…';

      try {
        const res  = await fetch('/api/beta', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ code }),
        });
        const data = await res.json();
        if (!res.ok || !data.valid) {
          throw new Error(data.error || 'Invalid beta access code.');
        }

        sessionStorage.setItem('betaAccessGranted', 'true');
        dismissBetaGate();
      } catch (err) {
        errorEl.textContent = err.message || 'Unable to verify code. Please try again.';
        errorEl.classList.remove('hidden');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Enter';
      }
    }

    async function submitWaitlist() {
      const input   = document.getElementById('waitlist-email');
      const msgEl   = document.getElementById('waitlist-message');
      const btn     = document.getElementById('waitlist-submit-btn');
      const email   = input.value.trim();

      msgEl.classList.add('hidden');
      msgEl.textContent = '';
      if (!email) {
        msgEl.innerHTML = '<span class="text-rose-400">Enter your email address.</span>';
        msgEl.classList.remove('hidden');
        return;
      }

      btn.disabled = true;
      btn.textContent = 'Joining…';

      try {
        const res  = await fetch('/api/waitlist', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ email }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Unable to join waitlist.');

        const message = data.message || 'You are on the waitlist. We will notify you when access opens.';
        msgEl.innerHTML = `
          <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full
                       bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-xs font-medium">
            <svg class="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z" clip-rule="evenodd"/>
            </svg>
            ${escapeHtml(message)}
          </span>`;
        msgEl.classList.remove('hidden');
        input.value = '';
      } catch (err) {
        msgEl.innerHTML = `<span class="text-rose-400">${escapeHtml(err.message || 'Something went wrong. Please try again.')}</span>`;
        msgEl.classList.remove('hidden');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Join';
      }
    }

    // ── GLOBAL SEARCH SHORTCUT ───────────────────────────────────────────────────
    /**
     * Focuses #global-search-input when the user presses '/' while no other
     * input/textarea/select is active — the standard "jump to search" convention
     * used by Bloomberg Terminal, GitHub, Linear, and most institutional tools.
     * Additive listener; does not modify initGlobalSearch or any existing handler.
     */
    function initSearchShortcut() {
      document.addEventListener('keydown', function (e) {
        if (e.key !== '/') return;
        const tag = document.activeElement?.tagName?.toUpperCase();
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        e.preventDefault();
        const input = document.getElementById('global-search-input');
        if (input) input.focus();
      });
    }

    /** Focuses the global search after the dashboard is revealed. */
    function focusGlobalSearch() {
      setTimeout(function () {
        const input = document.getElementById('global-search-input');
        if (input) input.focus();
      }, 80);
    }

    // ── GLOBAL SEARCH ────────────────────────────────────────────────────────────
    let searchDebounceTimer = null;
    let searchActiveIndex   = -1;
    let searchResults       = [];
    let searchFetchId       = 0;

    function initGlobalSearch() {
      const wrap    = document.getElementById('global-search-wrap');
      const input   = document.getElementById('global-search-input');
      const results = document.getElementById('global-search-results');
      if (!wrap || !input || !results) return;

      input.addEventListener('input', () => {
        clearTimeout(searchDebounceTimer);
        const q = input.value.trim();
        if (q.length < 1) {
          hideSearchResults();
          return;
        }
        showSearchLoading();
        searchDebounceTimer = setTimeout(() => fetchSearchResults(q), 250);
      });

      input.addEventListener('focus', () => {
        const q = input.value.trim();
        if (q.length >= 1 && searchResults.length > 0) {
          results.classList.remove('hidden');
          input.setAttribute('aria-expanded', 'true');
        }
      });

      input.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          if (results.classList.contains('hidden') && input.value.trim()) {
            fetchSearchResults(input.value.trim());
          }
          moveSearchSelection(1);
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          moveSearchSelection(-1);
        } else if (e.key === 'Enter') {
          e.preventDefault();
          if (searchActiveIndex >= 0 && searchResults[searchActiveIndex]) {
            selectStockFromSearch(searchResults[searchActiveIndex].symbol);
          } else if (searchResults.length > 0) {
            selectStockFromSearch(searchResults[0].symbol);
          } else {
            const q = input.value.trim().toUpperCase();
            if (/^[A-Z]{1,6}$/.test(q)) selectStockFromSearch(q);
          }
        } else if (e.key === 'Escape') {
          hideSearchResults();
          input.blur();
        }
      });

      results.addEventListener('mousedown', (e) => {
        const item = e.target.closest('.search-result-item');
        if (!item) return;
        e.preventDefault();
        const idx = Number(item.dataset.index);
        if (searchResults[idx]) selectStockFromSearch(searchResults[idx].symbol);
      });

      document.addEventListener('click', (e) => {
        if (!wrap.contains(e.target)) hideSearchResults();
      });
    }

    function showSearchLoading() {
      const input  = document.getElementById('global-search-input');
      const listEl = document.getElementById('global-search-results');
      if (!listEl) return;
      listEl.innerHTML = `
        <div class="px-4 py-3 text-sm text-slate-500 flex items-center gap-2">
          <svg class="animate-spin w-3.5 h-3.5 text-slate-500" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"></path>
          </svg>
          Searching…
        </div>`;
      listEl.classList.remove('hidden');
      if (input) input.setAttribute('aria-expanded', 'true');
    }

    async function fetchSearchResults(q) {
      const input   = document.getElementById('global-search-input');
      const listEl  = document.getElementById('global-search-results');
      const fetchId = ++searchFetchId;

      try {
        const res  = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
        const data = await res.json();
        if (fetchId !== searchFetchId) return;
        if (!res.ok) throw new Error(data.error || 'Search failed');

        searchResults     = data.results ?? [];
        searchActiveIndex = -1;

        if (searchResults.length === 0) {
          listEl.innerHTML = `<div class="px-4 py-3 text-sm text-slate-500">No matches for “${escapeHtml(q)}”</div>`;
        } else {
          listEl.innerHTML = searchResults.map((item, i) => `
            <div
              role="option"
              aria-selected="false"
              data-index="${i}"
              class="search-result-item w-full text-left px-4 py-2.5 text-sm
                     border-b border-slate-800/60 last:border-0"
            >
              <span class="font-mono font-semibold text-slate-100">${escapeHtml(item.symbol)}</span>
              <span class="text-slate-600 mx-1.5" aria-hidden="true">—</span>
              <span class="text-slate-400">${escapeHtml(item.companyName)}</span>
            </div>
          `).join('');
        }

        listEl.classList.remove('hidden');
        input.setAttribute('aria-expanded', 'true');
      } catch {
        if (fetchId !== searchFetchId) return;
        listEl.innerHTML = `<div class="px-4 py-3 text-sm text-slate-500">Search unavailable. Please try again.</div>`;
        listEl.classList.remove('hidden');
      }
    }

    function moveSearchSelection(delta) {
      const items = document.querySelectorAll('.search-result-item');
      if (!items.length) return;

      searchActiveIndex = Math.max(-1, Math.min(items.length - 1, searchActiveIndex + delta));
      items.forEach((el, i) => {
        el.setAttribute('aria-selected', String(i === searchActiveIndex));
      });
      if (searchActiveIndex >= 0) items[searchActiveIndex].scrollIntoView({ block: 'nearest' });
    }

    function hideSearchResults() {
      const input  = document.getElementById('global-search-input');
      const listEl = document.getElementById('global-search-results');
      if (listEl) {
        listEl.classList.add('hidden');
        listEl.innerHTML = '';
      }
      if (input) input.setAttribute('aria-expanded', 'false');
      searchResults     = [];
      searchActiveIndex = -1;
      searchFetchId++;
    }

    /**
     * Unified routing: closes search, switches to Single Ticker tab, runs analysis.
     * Used by global search dropdown and sector scanner table tickers.
     */
    function selectStockFromSearch(symbol) {
      const searchInput = document.getElementById('global-search-input');
      const tickerInput = document.getElementById('ticker-input');
      const normalized  = String(symbol).trim().toUpperCase();

      if (!/^[A-Z]{1,6}$/.test(normalized)) return;

      hideSearchResults();
      if (searchInput) searchInput.value = '';

      switchTab('ticker', { preserveContext: false });
      if (tickerInput) tickerInput.value = normalized;

      window.scrollTo({ top: 0, behavior: 'smooth' });
      runScreener();
    }
