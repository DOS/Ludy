-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #2517, ADR-0045, plan stock-and-marketplaces.md section 8.5): the household business kind. A household business (hộ kinh doanh) keeps TT133 books underneath and the
-- books of Circular 152/2025/TT-BTC (S1a to S2e) are views over them, so the only new data is what the household chose (its profile) and what the law sets (thresholds, percentages,
-- the expense groups, the forms), which changed four times in 2026 alone and so is DATA with an effective date, never a constant in code. Idempotent; applied files stay untouched.
--
-- crove_finance.household_profile   per legal entity of kind household and effective date: the tax group (1 to 4), the PIT method, the trades it sells in, whether it is registered for
--                                   e-invoices, the representative's name for the signature of the books. A change is a new row from its date, never an edit of an earlier one (the books of a
--                                   closed period keep the profile they were made under). Tenant roles read and insert; nothing updates or deletes a row.
-- crove_finance.household_threshold, household_trade_rate, household_expense_group_map, household_form_version
--                                   the law as data, global like crove_finance.chart (no org_id, read-only for every org, edited only by a migration). Each row has its effective date, where
--                                   it comes from and a status: `commentary` until the accountant has checked it against the primary text (#2520), then `confirmed` by a later migration.
--                                   A function reading a `commentary` row says so; nothing that files or computes a tax may use one before it is confirmed.
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. The profile
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_finance.household_profile (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  legal_entity_id uuid NOT NULL,
  effective_from date NOT NULL CHECK (effective_from >= DATE '2000-01-01'),
  -- Circular 152 Art. 6: group 1 (no VAT, no PIT); group 2 (VAT and PIT as a percentage of revenue); group 3 (VAT on revenue, PIT on income); group 4 (other taxes, besides one of those).
  tax_group smallint NOT NULL CHECK (tax_group BETWEEN 1 AND 4),
  -- How the PIT is worked out: a percentage of revenue or on income; a group 1 household pays none. The command checks the pair; the books a household keeps follow its method (household_form_version).
  pit_method text CHECK (pit_method IN ('percentage', 'income')),
  CONSTRAINT household_profile_method_ck CHECK (tax_group <> 1 OR pit_method IS NULL),
  -- The trades it sells in (the percentages are by trade): goods, services, catering (with construction including materials), other.
  trades text[] NOT NULL DEFAULT ARRAY['goods']::text[] CHECK (cardinality(trades) BETWEEN 1 AND 4 AND trades <@ ARRAY['goods', 'services', 'catering', 'other']::text[]),
  einvoice_registered boolean NOT NULL DEFAULT false,
  -- The name printed with the signature place of each book; a household's is usually its owner's.
  representative_name text CHECK (representative_name IS NULL OR char_length(representative_name) BETWEEN 1 AND 200),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT household_profile_entity_date_uq UNIQUE (org_id, legal_entity_id, effective_from),
  CONSTRAINT household_profile_entity_fk FOREIGN KEY (org_id, legal_entity_id) REFERENCES crove_kernel.legal_entity (org_id, id),
  CONSTRAINT household_profile_member_fk FOREIGN KEY (org_id, created_by) REFERENCES crove_kernel.tenant_member (org_id, user_id) ON DELETE SET NULL (created_by)
);
CREATE INDEX IF NOT EXISTS household_profile_entity_idx ON crove_finance.household_profile (legal_entity_id, org_id);
CREATE INDEX IF NOT EXISTS household_profile_created_by_idx ON crove_finance.household_profile (org_id, created_by) WHERE created_by IS NOT NULL;
SELECT crove_kernel.apply_tenant_rls('crove_finance.household_profile');
REVOKE UPDATE, DELETE ON crove_finance.household_profile FROM crove_tenant;
DROP TRIGGER IF EXISTS b_legal_entity ON crove_finance.household_profile;
CREATE TRIGGER b_legal_entity BEFORE INSERT OR UPDATE OF legal_entity_id ON crove_finance.household_profile
  FOR EACH ROW EXECUTE FUNCTION crove_finance.legal_entity_fill();
ALTER TABLE crove_finance.household_profile ENABLE ALWAYS TRIGGER b_legal_entity;
DROP POLICY IF EXISTS le_scope ON crove_finance.household_profile;
CREATE POLICY le_scope ON crove_finance.household_profile AS RESTRICTIVE FOR ALL TO crove_tenant
  USING ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]))
  WITH CHECK ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]));

-- Only an entity of kind household has a profile. AFTER the row is let in: a BEFORE trigger reading the entity would answer a write for another org or an entity the writer cannot
-- see with its own error instead of the row policy's. Runs as the writer: an entity it cannot see is left to the foreign key and the row policies.
CREATE OR REPLACE FUNCTION crove_finance.household_profile_kind() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM crove_kernel.legal_entity e WHERE e.org_id = NEW.org_id AND e.id = NEW.legal_entity_id AND e.kind <> 'household') THEN
    RAISE EXCEPTION 'HOUSEHOLD_PROFILE_KIND' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION crove_finance.household_profile_kind() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
DROP TRIGGER IF EXISTS household_profile_kind ON crove_finance.household_profile;
CREATE TRIGGER household_profile_kind AFTER INSERT ON crove_finance.household_profile
  FOR EACH ROW EXECUTE FUNCTION crove_finance.household_profile_kind();
ALTER TABLE crove_finance.household_profile ENABLE ALWAYS TRIGGER household_profile_kind;

-- ---------------------------------------------------------------------------
-- 2. The law as data (global, read-only for every org)
-- ---------------------------------------------------------------------------
-- A row holds its effective date, where it comes from and whether the accountant has checked it. `commentary` is the state of every row below until #2520.
CREATE TABLE IF NOT EXISTS crove_finance.household_threshold (
  code text NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]{2,60}$'),
  effective_from date NOT NULL,
  -- A yearly revenue in VND.
  amount numeric(20, 4) NOT NULL CHECK (amount >= 0),
  source text NOT NULL CHECK (char_length(source) BETWEEN 1 AND 500),
  status text NOT NULL CHECK (status IN ('commentary', 'confirmed')),
  PRIMARY KEY (code, effective_from)
);
CREATE TABLE IF NOT EXISTS crove_finance.household_trade_rate (
  trade text NOT NULL CHECK (trade IN ('goods', 'services', 'catering', 'other')),
  effective_from date NOT NULL,
  -- Percentages of the revenue of that trade (VAT on revenue; PIT on revenue for the percentage method).
  vat_percent numeric(7, 4) NOT NULL CHECK (vat_percent BETWEEN 0 AND 100),
  pit_percent numeric(7, 4) NOT NULL CHECK (pit_percent BETWEEN 0 AND 100),
  source text NOT NULL CHECK (char_length(source) BETWEEN 1 AND 500),
  status text NOT NULL CHECK (status IN ('commentary', 'confirmed')),
  PRIMARY KEY (trade, effective_from)
);
CREATE TABLE IF NOT EXISTS crove_finance.household_expense_group_map (
  -- The group of S2c (revenue and expense detail): materials and goods, wages and insurance, depreciation, outside services, interest, other.
  expense_group text NOT NULL CHECK (expense_group IN ('materials_goods', 'wages_insurance', 'depreciation', 'outside_services', 'interest', 'other')),
  -- An account code of the chart; a sub-account follows its parent's row.
  account_prefix text NOT NULL CHECK (account_prefix ~ '^[0-9]{3,6}$'),
  effective_from date NOT NULL,
  source text NOT NULL CHECK (char_length(source) BETWEEN 1 AND 500),
  status text NOT NULL CHECK (status IN ('commentary', 'confirmed')),
  PRIMARY KEY (account_prefix, effective_from)
);
CREATE TABLE IF NOT EXISTS crove_finance.household_form_version (
  -- The book as Circular 152 names it (S1a, S2a, ...), the version of its layout and the PIT methods whose households keep it: `none` (group 1, no VAT and no PIT), `percentage`
  -- (a percentage of revenue) and `income` (on income). A household keeps the books of its method, not of a group number, because a household in the middle band may choose its method.
  book text NOT NULL CHECK (book IN ('S1a', 'S2a', 'S2b', 'S2c', 'S2d', 'S2e', 'S3a')),
  version text NOT NULL CHECK (version ~ '^[0-9]{4}\.[0-9]+$'),
  effective_from date NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  -- An empty list retires the book from that date: no method keeps it any more.
  pit_methods text[] NOT NULL CHECK (pit_methods <@ ARRAY['none', 'percentage', 'income']::text[]),
  source text NOT NULL CHECK (char_length(source) BETWEEN 1 AND 500),
  status text NOT NULL CHECK (status IN ('commentary', 'confirmed')),
  PRIMARY KEY (book, version)
);
CREATE INDEX IF NOT EXISTS household_form_version_date_idx ON crove_finance.household_form_version (book, effective_from);
REVOKE ALL ON crove_finance.household_threshold, crove_finance.household_trade_rate, crove_finance.household_expense_group_map, crove_finance.household_form_version FROM PUBLIC, crove_tenant;
GRANT SELECT ON crove_finance.household_threshold, crove_finance.household_trade_rate, crove_finance.household_expense_group_map, crove_finance.household_form_version TO crove_tenant;
SELECT crove_kernel.agent_write_guard_install('crove_finance.household_threshold');
SELECT crove_kernel.agent_write_guard_install('crove_finance.household_trade_rate');
SELECT crove_kernel.agent_write_guard_install('crove_finance.household_expense_group_map');
SELECT crove_kernel.agent_write_guard_install('crove_finance.household_form_version');

-- The seeds. Where each comes from is in the plan (stock-and-marketplaces.md section 5, rows 5 to 9); the sources conflict on the percentages and on the date of Decree 141, so every row is
-- `commentary` and the accountant (#2520) confirms or corrects it by a later dated row, never by editing one.
INSERT INTO crove_finance.household_threshold (code, effective_from, amount, source, status) VALUES
  ('no_tax_revenue', DATE '2026-01-01', 1000000000, 'Decree 141/2026 raised the 500 million threshold to 1 billion a year; whether from 2026-01-01 or from 2026-04-29 is unverified (plan section 5 row 7)', 'commentary'),
  ('income_method_revenue', DATE '2026-01-01', 3000000000, 'Above 3 billion a year the income method applies (Decree 68/2026 as quoted; plan section 5 row 7)', 'commentary'),
  ('einvoice_mandatory_revenue', DATE '2026-07-01', 1000000000, 'Decree 254/2026 and Circular 91/2026, from 2026-07-01: e-invoices mandatory above 1 billion a year (plan section 5 row 8)', 'commentary')
ON CONFLICT (code, effective_from) DO NOTHING;

INSERT INTO crove_finance.household_trade_rate (trade, effective_from, vat_percent, pit_percent, source, status) VALUES
  ('goods', DATE '2026-01-01', 1, 0.5, 'Percentages by trade as quoted in Decree 117/2025 and Circular 152; the table is unverified and sources conflict (plan section 5 rows 7 and 9)', 'commentary'),
  ('services', DATE '2026-01-01', 5, 2, 'Percentages by trade as quoted in Decree 117/2025 and Circular 152; the table is unverified and sources conflict (plan section 5 rows 7 and 9)', 'commentary'),
  ('catering', DATE '2026-01-01', 3, 1.5, 'Catering and construction with materials, as quoted (plan section 5 rows 7 and 9); unverified', 'commentary'),
  ('other', DATE '2026-01-01', 2, 1, 'Other trades, as quoted (plan section 5 row 7); unverified', 'commentary')
ON CONFLICT (trade, effective_from) DO NOTHING;

-- A household keeps TT133 books, so only accounts of that chart are mapped, and only those whose name says the group. TT133 has no account for wages, depreciation or outside services of its own
-- (they sit in the sub-accounts 6421 and 6422 and in the org's own sub-accounts), and 154 is left out: the slice that builds S2c settles those with the accountant (#2520).
INSERT INTO crove_finance.household_expense_group_map (expense_group, account_prefix, effective_from, source, status) VALUES
  ('materials_goods', '611', DATE '2026-01-01', 'Purchases (TT133 account 611); the mapping is a proposal for the accountant (#2520)', 'commentary'),
  ('materials_goods', '631', DATE '2026-01-01', 'Cost of production (TT133 account 631); a proposal for the accountant (#2520)', 'commentary'),
  ('materials_goods', '632', DATE '2026-01-01', 'Cost of goods sold (TT133 account 632); a proposal for the accountant (#2520)', 'commentary'),
  ('interest', '635', DATE '2026-01-01', 'Financial expenses (TT133 account 635); a proposal for the accountant (#2520)', 'commentary'),
  ('other', '642', DATE '2026-01-01', 'Selling and administrative expenses (TT133 account 642, 6421 and 6422) until the accountant splits them by group (#2520)', 'commentary'),
  ('other', '811', DATE '2026-01-01', 'Other expenses (TT133 account 811) (#2520)', 'commentary')
ON CONFLICT (account_prefix, effective_from) DO NOTHING;


-- The titles are as the forms are commonly published; the accountant checks them and the columns against the appendix of the circular (#2520). S3a (other taxes) has no method to hang on and
-- comes with the slice that builds it.
INSERT INTO crove_finance.household_form_version (book, version, effective_from, name, pit_methods, source, status) VALUES
  ('S1a', '2026.1', DATE '2026-01-01', 'Sổ doanh thu bán hàng hóa, dịch vụ (S1a-HKD)', ARRAY['none']::text[], 'Circular 152/2025/TT-BTC Art. 6 (group 1: no VAT, no PIT); the accountant confirms (#2520)', 'commentary'),
  ('S2a', '2026.1', DATE '2026-01-01', 'Sổ doanh thu bán hàng hóa, dịch vụ (S2a-HKD)', ARRAY['percentage']::text[], 'Circular 152/2025/TT-BTC Art. 6 (VAT and PIT as a percentage of revenue); the accountant confirms (#2520)', 'commentary'),
  ('S2b', '2026.1', DATE '2026-01-01', 'Sổ doanh thu bán hàng hóa, dịch vụ (S2b-HKD)', ARRAY['income']::text[], 'Circular 152/2025/TT-BTC Art. 6 (PIT on income); the accountant confirms (#2520)', 'commentary'),
  ('S2c', '2026.1', DATE '2026-01-01', 'Sổ chi tiết doanh thu, chi phí (S2c-HKD)', ARRAY['income']::text[], 'Circular 152/2025/TT-BTC Art. 6 (PIT on income); the accountant confirms (#2520)', 'commentary'),
  ('S2d', '2026.1', DATE '2026-01-01', 'Sổ chi tiết vật liệu, dụng cụ, sản phẩm, hàng hóa (S2d-HKD)', ARRAY['income']::text[], 'Circular 152/2025/TT-BTC Art. 6 (PIT on income); the accountant confirms (#2520)', 'commentary'),
  ('S2e', '2026.1', DATE '2026-01-01', 'Sổ chi tiết tiền (S2e-HKD)', ARRAY['income']::text[], 'Circular 152/2025/TT-BTC Art. 6 (PIT on income); the accountant confirms (#2520)', 'commentary')
ON CONFLICT (book, version) DO NOTHING;
