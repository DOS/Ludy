-- SPDX-License-Identifier: AGPL-3.0-only
-- Ludy finance (issue #1403, TT99 books phase B, slice A): the opening entry of an entity follows the chart of the day
-- AFTER its date. Idempotent; applied files stay untouched.
--
-- An opening entry (source_type 'finance.opening_balance') is the trial balance "as at the end of the day" of its date,
-- and every other entry is dated later (BEFORE_OPENING_BALANCE). An entity that starts keeping TT99 books on 1 January
-- therefore opens its balances as at 31 December, and those lines must name TT99 accounts: they are the first thing the
-- TT99 books carry. 20261103020000_crove_finance_books_regime.sql checks a journal line against the chart of its entry's
-- own date, 31 December, which is still TT133 for such an entity, so a TT99-only account (212, 213, 3386 as
-- unemployment insurance) could not be opened and a TT133-only one (2112, 3385) could.
--
-- From now on, for an opening entry, and for the reversal of one (it is dated the same day and mirrors the lines), the
-- date that picks the chart is the day after the entry's date (a reversal only when it is dated on its opening entry's own date, as the period guard and reversal.ts already require; one dated otherwise is checked
-- against its own date like any entry). Every other entry is unchanged: its own date. For an
-- opening entry dated on any other day both days are under the same chart, so nothing changes there either.
--
-- ludy_finance.check_account_ref()         the body of 20261103020000_crove_finance_books_regime.sql (names as renamed by
--                                          20270316140000), with that one change in the journal line branch.
-- ludy_finance.legal_entity_books_guard()  the same body, with the same date rule where it looks for entries a books row
--                                          would put under another chart: an opening entry dated the day before a row's
--                                          start is under that row's chart now, so the row cannot be written, changed or
--                                          removed while it stands (BOOKS_REGIME_IN_USE), as for any other entry.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION ludy_finance.legal_entity_books_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_row ludy_finance.legal_entity_books := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  v_end_month smallint;
  v_regime text := 'tt133';
  v_version text := '2026.1';
  v_from date;
  v_to date;
  v_first date;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.effective_from = OLD.effective_from AND NEW.regime = OLD.regime AND NEW.chart_version = OLD.chart_version THEN
    RETURN NEW;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    SELECT t.fiscal_year_end_month INTO v_end_month FROM ludy_kernel.tax_profile t WHERE t.org_id = NEW.org_id;
    IF pg_catalog.date_part('month', NEW.effective_from) <> (coalesce(v_end_month, 12) % 12) + 1 THEN
      RAISE EXCEPTION 'BOOKS_NOT_FISCAL_YEAR_START' USING ERRCODE = '23514',
        DETAIL = pg_catalog.json_build_object('effectiveFrom', NEW.effective_from, 'fiscalYearEndMonth', coalesce(v_end_month, 12))::text;
    END IF;
  END IF;
  -- Hold back postings and other books writes of the entity until this commits: the row every entry reads before it is
  -- written.
  INSERT INTO ludy_finance.period_lock (org_id, legal_entity_id) VALUES (v_row.org_id, v_row.legal_entity_id)
    ON CONFLICT (org_id, legal_entity_id) DO NOTHING;
  PERFORM 1 FROM ludy_finance.period_lock p WHERE p.org_id = v_row.org_id AND p.legal_entity_id = v_row.legal_entity_id FOR UPDATE;
  IF TG_OP = 'UPDATE' THEN
    v_from := least(OLD.effective_from, NEW.effective_from);
    SELECT min(b.effective_from) INTO v_to FROM ludy_finance.legal_entity_books b
    WHERE b.org_id = v_row.org_id AND b.legal_entity_id = v_row.legal_entity_id AND b.id <> OLD.id
      AND b.effective_from > greatest(OLD.effective_from, NEW.effective_from);
  ELSE
    v_from := v_row.effective_from;
    SELECT b.regime, b.chart_version INTO v_regime, v_version FROM ludy_finance.legal_entity_books b
    WHERE b.org_id = v_row.org_id AND b.legal_entity_id = v_row.legal_entity_id AND b.effective_from < v_row.effective_from
    ORDER BY b.effective_from DESC LIMIT 1;
    IF NOT FOUND THEN
      v_regime := 'tt133';
      v_version := '2026.1';
    END IF;
    IF v_regime = v_row.regime AND v_version = v_row.chart_version THEN
      RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;
    SELECT min(b.effective_from) INTO v_to FROM ludy_finance.legal_entity_books b
    WHERE b.org_id = v_row.org_id AND b.legal_entity_id = v_row.legal_entity_id AND b.effective_from > v_row.effective_from;
  END IF;
  -- The entries between v_from and v_to by the date that picks their chart: the entry's date, or the day after it for an
  -- opening entry and for the reversal of one.
  SELECT min(e.entry_date) INTO v_first FROM ludy_finance.journal_entry e
  WHERE e.org_id = v_row.org_id AND e.legal_entity_id = v_row.legal_entity_id
    AND e.entry_date + (CASE WHEN e.source_type = 'finance.opening_balance'
                               OR EXISTS (SELECT 1 FROM ludy_finance.journal_entry o
                                          WHERE o.org_id = e.org_id AND o.id = e.reverses_entry_id AND o.source_type = 'finance.opening_balance' AND o.entry_date = e.entry_date)
                             THEN 1 ELSE 0 END) >= v_from
    AND (v_to IS NULL OR e.entry_date + (CASE WHEN e.source_type = 'finance.opening_balance'
                                                OR EXISTS (SELECT 1 FROM ludy_finance.journal_entry o
                                                           WHERE o.org_id = e.org_id AND o.id = e.reverses_entry_id AND o.source_type = 'finance.opening_balance' AND o.entry_date = e.entry_date)
                                              THEN 1 ELSE 0 END) < v_to);
  IF v_first IS NOT NULL THEN
    RAISE EXCEPTION 'BOOKS_REGIME_IN_USE' USING ERRCODE = '23514',
      DETAIL = pg_catalog.json_build_object('legalEntityId', v_row.legal_entity_id, 'from', v_from, 'firstEntry', v_first)::text;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
REVOKE ALL ON FUNCTION ludy_finance.legal_entity_books_guard() FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;

CREATE OR REPLACE FUNCTION ludy_finance.check_account_ref() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_code text;
  v_active boolean;
  v_entity uuid;
  v_regime text;
  v_version text;
BEGIN
  -- Separate statements: an expression naming a column the table does not have fails even in a branch not taken.
  IF TG_TABLE_NAME = 'journal_line' THEN
    v_code := NEW.account_code;
    -- The chart of the entry's entity on the date that picks it: the entry's date, or the day after it for an opening
    -- entry and for the reversal of one (see the header).
    SELECT e.legal_entity_id, b.regime, b.chart_version INTO v_entity, v_regime, v_version
    FROM ludy_finance.journal_entry e
    LEFT JOIN LATERAL (
      SELECT b.regime, b.chart_version FROM ludy_finance.legal_entity_books b
      WHERE b.org_id = e.org_id AND b.legal_entity_id = e.legal_entity_id
        AND b.effective_from <= e.entry_date + (CASE WHEN e.source_type = 'finance.opening_balance'
                                                       OR EXISTS (SELECT 1 FROM ludy_finance.journal_entry o
                                                                  WHERE o.org_id = e.org_id AND o.id = e.reverses_entry_id AND o.source_type = 'finance.opening_balance' AND o.entry_date = e.entry_date)
                                                     THEN 1 ELSE 0 END)
      ORDER BY b.effective_from DESC LIMIT 1) b ON true
    WHERE e.org_id = NEW.org_id AND e.id = NEW.entry_id;
    IF v_regime IS NOT NULL AND (v_regime, v_version) <> ('tt133', '2026.1') THEN
      IF EXISTS (SELECT 1 FROM ludy_finance.chart_account a WHERE a.regime = v_regime AND a.version = v_version AND a.code = v_code) THEN
        RETURN NULL;
      END IF;
      RAISE EXCEPTION 'insert or update on table "%" violates foreign key check: account % is not in the % % chart of accounts of legal entity %',
        TG_TABLE_NAME, v_code, v_regime, v_version, v_entity USING ERRCODE = '23503';
    END IF;
  ELSIF TG_TABLE_NAME = 'purchase_line' THEN
    v_code := COALESCE(NEW.debit_account, NEW.credit_account);
  ELSE
    v_code := NEW.debit_account;
  END IF;
  IF EXISTS (SELECT 1 FROM ludy_finance.account a WHERE a.code = v_code) THEN
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'vendor_account_rule' THEN
    SELECT o.active INTO v_active FROM ludy_finance.org_account o WHERE o.org_id = NEW.org_id AND o.code = v_code FOR SHARE;
  ELSE
    SELECT o.active INTO v_active FROM ludy_finance.org_account o WHERE o.org_id = NEW.org_id AND o.code = v_code;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'insert or update on table "%" violates foreign key check: account % is not in the chart of accounts of org %',
      TG_TABLE_NAME, v_code, NEW.org_id USING ERRCODE = '23503';
  END IF;
  IF TG_TABLE_NAME = 'vendor_account_rule' AND NOT v_active THEN
    RAISE EXCEPTION 'sub-account % is inactive and cannot be a vendor default', v_code USING ERRCODE = '23503';
  END IF;
  RETURN NULL;
END $$;
-- Trigger function only; nobody calls it directly (the same revoke as 20261019150100_crove_finance_sales_documents.sql).
REVOKE ALL ON FUNCTION ludy_finance.check_account_ref() FROM PUBLIC, ludy_tenant, ludy_definer_tenant;
