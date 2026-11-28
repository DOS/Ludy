-- SPDX-License-Identifier: AGPL-3.0-only
-- Ludy finance (issue #5285, plan docs/plan/stock-and-marketplaces.md section 8.5): the annual PIT finalization of a household on the income method, form 02/CNKD-TNCN-QTT, as law data.
-- Idempotent; applied files stay untouched.
--
-- 1. ludy_finance.household_income_rate   the PIT rate of the income method by the band of the year's revenue (Luật Thuế thu nhập cá nhân 109/2025/QH15 Art. 7(2): 15% up to 3 billion VND,
--                                         17% above 3 and up to 50 billion, 20% above 50 billion). A dated row of the law like the other household law tables: global, no org_id, read-only for every
--                                         org, edited only by a migration. A band applies when the year's revenue is above `revenue_over`; the band in force is the one with the highest `revenue_over` below the
--                                         revenue, taken from the rows in force on the year's last day.
-- 2. ludy_finance.household_return_form_version   its `form` list now also names 02/CNKD-TNCN-QTT, with the row of the form in the layout of Circular 89/2026/TT-BTC Phụ lục I.
-- 3. The source text of the 01/CNKD row said 01/TKN-CNKD is the yearly settlement; it is the revenue notice of a household at or under the threshold (ND 68/2026 Art. 8(1)(a), Circular 18/2026
--    Art. 4(1)(a)); the yearly settlement is 02/CNKD-TNCN-QTT. Only the text changes.
-- The rows are `confirmed` on the basis of two independent readings of the official texts on 2026-11-28 (signed PDFs; the accountant of #61 has not checked them against the primary text, as for #3710).
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. The rate of the income method by revenue band
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ludy_finance.household_income_rate (
  -- The band applies when the year's revenue is above this amount (VND). 0 is the lowest band (above the tax-free threshold of household_threshold).
  revenue_over numeric(20, 4) NOT NULL CHECK (revenue_over >= 0),
  effective_from date NOT NULL,
  -- The PIT rate on taxable income (revenue less deductible costs), in percent.
  percent numeric(7, 4) NOT NULL CHECK (percent BETWEEN 0 AND 100),
  source text NOT NULL CHECK (char_length(source) BETWEEN 1 AND 500),
  status text NOT NULL CHECK (status IN ('commentary', 'confirmed')),
  PRIMARY KEY (revenue_over, effective_from)
);
REVOKE ALL ON ludy_finance.household_income_rate FROM PUBLIC, ludy_tenant;
GRANT SELECT ON ludy_finance.household_income_rate TO ludy_tenant;
SELECT ludy_kernel.agent_write_guard_install('ludy_finance.household_income_rate');

INSERT INTO ludy_finance.household_income_rate (revenue_over, effective_from, percent, source, status) VALUES
  (0, DATE '2026-01-01', 15, 'Luật Thuế thu nhập cá nhân 109/2025/QH15 Art. 7(2) (Công báo số 37, 22/01/2026), applied from tax year 2026 (Art. 29(2)): revenue above the threshold up to 3 billion VND, 15% of income. Two independent readings of the official text, 2026-11-28 (#5285)', 'confirmed'),
  (3000000000, DATE '2026-01-01', 17, 'Luật Thuế thu nhập cá nhân 109/2025/QH15 Art. 7(2): revenue above 3 billion and up to 50 billion VND, 17% of income. Two independent readings of the official text, 2026-11-28 (#5285)', 'confirmed'),
  (50000000000, DATE '2026-01-01', 20, 'Luật Thuế thu nhập cá nhân 109/2025/QH15 Art. 7(2): revenue above 50 billion VND, 20% of income. Two independent readings of the official text, 2026-11-28 (#5285)', 'confirmed')
ON CONFLICT (revenue_over, effective_from) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. The return form list names the annual finalization
-- ---------------------------------------------------------------------------
ALTER TABLE ludy_finance.household_return_form_version DROP CONSTRAINT IF EXISTS household_return_form_version_form_check;
ALTER TABLE ludy_finance.household_return_form_version ADD CONSTRAINT household_return_form_version_form_check
  CHECK (form IN ('01/CNKD', '02/CNKD-TNCN-QTT')) NOT VALID;
ALTER TABLE ludy_finance.household_return_form_version VALIDATE CONSTRAINT household_return_form_version_form_check;

INSERT INTO ludy_finance.household_return_form_version (form, version, effective_from, name, pit_methods, source, status) VALUES
  ('02/CNKD-TNCN-QTT', '2026.1', DATE '2026-07-01', 'Tờ khai quyết toán thuế thu nhập cá nhân (02/CNKD-TNCN-QTT)', ARRAY['income']::text[],
   'Form 02/CNKD-TNCN-QTT, Circular 89/2026/TT-BTC Phụ lục I (Art. 99(5): the same code in a new layout, in force 2026-07-01; Art. 100(1)); basis Circular 18/2026/TT-BTC Art. 4(1)(c); due by 31 March of the next year (ND 68/2026 Art. 8(3)(c)). Two independent readings of the signed PDFs, 2026-11-28 (#5285); that a year-2026 return uses this layout is our reading of Art. 100(1)', 'confirmed')
ON CONFLICT (form, version) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. The corrected source text of the 01/CNKD row
-- ---------------------------------------------------------------------------
UPDATE ludy_finance.household_return_form_version
SET source = 'Form 01/CNKD under Circular 50/2026/TT-BTC (13/05/2026), which replaced the form of Circular 18/2026. 01/TKN-CNKD (Circular 89/2026) is the revenue notice of a household at or under the threshold, not the yearly settlement; the yearly settlement of the income method is 02/CNKD-TNCN-QTT. Research 2026-11-18, cross-checked; accountant delegated (#3710); text corrected 2026-11-28 (#5285)'
WHERE form = '01/CNKD' AND source LIKE '%01/TKN-CNKD of Circular 89/2026 is the yearly settlement%';
