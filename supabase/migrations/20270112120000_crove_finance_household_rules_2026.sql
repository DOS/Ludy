-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #3710, plan stock-and-marketplaces.md section 8.5, research docs/plan/accounting-rules-research-2026-11-18.md): the household law of 2026 as data, slice 1. Idempotent; applied
-- files stay untouched.
--
--   1. The digital content trade (games, digital film, photos, music, digital ads: PIT 5%, PIT Law 109/2025 Art. 7.3). The trade list is one list for stock items, the household profile and the
--      rate table, so the three CHECK constraints take the new key together. No row changes.
--   2. crove_finance.household_tax_reduction: the 2026 reductions as dated rows applied to the TAX, never constants. `kind` is vat or pit, `cut_percent` the share of the tax that is cut,
--      `revenue_ceiling` the yearly revenue (VND) up to which the cut applies (NULL: no ceiling). A cut ends with a later row of 0, the way every other law row is superseded. Global like the
--      other law tables: no org_id, read-only for every org, edited only by a migration.
--   3. The rows the research of 2026-11-18 confirmed (B1 to B5, high confidence after the cross-check) move from `commentary` to `confirmed`, values unchanged, with that provenance in `source`.
--      "confirmed" here means high confidence from the research and its cross-check, the accountant of #2520 having delegated it; it is not a check by a person against the primary text. An
--      UPDATE and not a later dated row, because the rows were right from their own date (Decree 141 is retroactive to 2026-01-01) and a row dated later would leave the earlier 2026 books
--      labelled provisional. The catering group (3% and 1.5%) and the digital content row stay `commentary`.
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. The digital content trade
-- ---------------------------------------------------------------------------
-- Drop each CHECK that lists the old trades (its name is the column's default one, but the catalog is the source of truth), then add the new one under an explicit name. A second run finds no
-- old constraint, drops the named one if it is there and adds it again.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT con.conrelid::regclass::text AS tbl, con.conname
    FROM pg_catalog.pg_constraint con
    WHERE con.contype = 'c'
      AND con.conrelid IN ('crove_finance.stock_item'::regclass, 'crove_finance.household_profile'::regclass, 'crove_finance.household_trade_rate'::regclass)
      AND pg_catalog.pg_get_constraintdef(con.oid) LIKE '%''catering''%'
      AND pg_catalog.pg_get_constraintdef(con.oid) NOT LIKE '%digital_content%'
  LOOP
    EXECUTE pg_catalog.format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
  END LOOP;
END $$;

ALTER TABLE crove_finance.stock_item DROP CONSTRAINT IF EXISTS stock_item_trade_check;
ALTER TABLE crove_finance.stock_item ADD CONSTRAINT stock_item_trade_check
  CHECK (trade IN ('goods', 'services', 'catering', 'digital_content', 'other')) NOT VALID;
ALTER TABLE crove_finance.stock_item VALIDATE CONSTRAINT stock_item_trade_check;

ALTER TABLE crove_finance.household_profile DROP CONSTRAINT IF EXISTS household_profile_trades_check;
ALTER TABLE crove_finance.household_profile ADD CONSTRAINT household_profile_trades_check
  CHECK (cardinality(trades) BETWEEN 1 AND 5 AND trades <@ ARRAY['goods', 'services', 'catering', 'digital_content', 'other']::text[]) NOT VALID;
ALTER TABLE crove_finance.household_profile VALIDATE CONSTRAINT household_profile_trades_check;

ALTER TABLE crove_finance.household_trade_rate DROP CONSTRAINT IF EXISTS household_trade_rate_trade_check;
ALTER TABLE crove_finance.household_trade_rate ADD CONSTRAINT household_trade_rate_trade_check
  CHECK (trade IN ('goods', 'services', 'catering', 'digital_content', 'other'));

-- ---------------------------------------------------------------------------
-- 2. The reductions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_finance.household_tax_reduction (
  kind text NOT NULL CHECK (kind IN ('vat', 'pit')),
  effective_from date NOT NULL,
  -- The share of the tax that is cut, in percent (20 cuts a fifth of the VAT; 0 ends the cut).
  cut_percent numeric(7, 4) NOT NULL CHECK (cut_percent BETWEEN 0 AND 100),
  -- A yearly revenue in VND; the cut applies up to and including it. NULL: no ceiling.
  revenue_ceiling numeric(20, 4) CHECK (revenue_ceiling IS NULL OR revenue_ceiling >= 0),
  source text NOT NULL CHECK (char_length(source) BETWEEN 1 AND 500),
  status text NOT NULL CHECK (status IN ('commentary', 'confirmed')),
  PRIMARY KEY (kind, effective_from)
);
REVOKE ALL ON crove_finance.household_tax_reduction FROM PUBLIC, crove_tenant;
GRANT SELECT ON crove_finance.household_tax_reduction TO crove_tenant;
SELECT crove_kernel.agent_write_guard_install('crove_finance.household_tax_reduction');

INSERT INTO crove_finance.household_tax_reduction (kind, effective_from, cut_percent, revenue_ceiling, source, status) VALUES
  ('vat', DATE '2026-01-01', 20, NULL, 'Decree 174/2025/ND-CP Art. 2.1 (signed scan): the VAT percentage is cut by 20% from 2025-07-01 to 2026-12-31 for goods and services not excluded; applied to the tax, not the rate. Research 2026-11-18, cross-checked; accountant delegated (#3710)', 'confirmed'),
  ('vat', DATE '2027-01-01', 0, NULL, 'The VAT cut ends on 2026-12-31 (Decree 174/2025/ND-CP Art. 2.1); no extension found, re-check in December 2026. Research 2026-11-18, cross-checked; accountant delegated (#3710)', 'confirmed'),
  ('pit', DATE '2026-01-01', 30, 10000000000, 'Decree 398/2026/ND-CP (in force 2026-10-29): the PIT payable of a resident business individual with yearly revenue up to 10 billion VND is cut by 30% for tax years 2026 and 2027; applied to the tax. Research 2026-11-18, cross-checked; accountant delegated (#3710)', 'confirmed'),
  ('pit', DATE '2028-01-01', 0, NULL, 'The PIT cut covers tax years 2026 and 2027 only (Decree 398/2026/ND-CP). Research 2026-11-18, cross-checked; accountant delegated (#3710)', 'confirmed')
ON CONFLICT (kind, effective_from) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. The digital content rate and the rows the research confirmed
-- ---------------------------------------------------------------------------
-- The PIT percentage is read in the PIT Law; the research names no VAT group for digital content, so VAT 5% (services) is an assumption and the row stays `commentary`.
INSERT INTO crove_finance.household_trade_rate (trade, effective_from, vat_percent, pit_percent, source, status) VALUES
  ('digital_content', DATE '2026-01-01', 5, 5, 'PIT Law 109/2025 Art. 7.3: digital content (games, digital film, photos, music, digital ads) 5% (research 2026-11-18, high). VAT 5% is assumed as a service: the research names no VAT group for it, so the row stays commentary (#3710)', 'commentary')
ON CONFLICT (trade, effective_from) DO NOTHING;

UPDATE crove_finance.household_threshold
SET status = 'confirmed',
    source = CASE code
      WHEN 'no_tax_revenue' THEN 'Decree 141/2026 Art. 1.1 and 3: 1 billion VND a year from 2026-01-01 (retroactive). Research 2026-11-18, cross-checked; accountant delegated (#3710)'
      WHEN 'income_method_revenue' THEN 'Decree 68/2026 Art. 4.5 and the PIT Law: the income method is mandatory above 3 billion VND a year. Research 2026-11-18, cross-checked; accountant delegated (#3710)'
      ELSE 'Decree 68/2026 Art. 8.5 as amended, Decree 254/2026 and Circular 91/2026 from 2026-07-01: e-invoices mandatory above 1 billion VND a year. Research 2026-11-18, cross-checked; accountant delegated (#3710)'
    END
WHERE status = 'commentary' AND code IN ('no_tax_revenue', 'income_method_revenue', 'einvoice_mandatory_revenue');

UPDATE crove_finance.household_trade_rate
SET status = 'confirmed',
    source = 'PIT Law 109/2025 Art. 7.3 (PIT percentage by trade) and the VAT percentage by trade of the direct method. Research 2026-11-18, cross-checked; accountant delegated (#3710)'
WHERE status = 'commentary' AND trade IN ('goods', 'services', 'other');

UPDATE crove_finance.household_trade_rate
SET source = 'Catering and construction with materials (3% VAT, 1.5% PIT): not read in a primary text, medium-high in the research of 2026-11-18, so the row stays commentary (#3710)'
WHERE status = 'commentary' AND trade = 'catering';

UPDATE crove_finance.household_form_version
SET status = 'confirmed',
    source = 'Circular 152/2025/TT-BTC Art. 6: the books a household keeps follow its tax method. Research 2026-11-18, cross-checked; accountant delegated (#3710). The layout titles are as commonly published'
WHERE status = 'commentary' AND book IN ('S1a', 'S2a', 'S2b', 'S2c', 'S2d', 'S2e');

UPDATE crove_finance.household_return_form_version
SET status = 'confirmed',
    source = 'Form 01/CNKD under Circular 50/2026/TT-BTC (13/05/2026), which replaced the form of Circular 18/2026; 01/TKN-CNKD of Circular 89/2026 is the yearly settlement. Research 2026-11-18, cross-checked; accountant delegated (#3710)'
WHERE status = 'commentary' AND form = '01/CNKD';
