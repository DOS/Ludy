-- SPDX-License-Identifier: AGPL-3.0-only
-- Ludy finance (issue #1403, TT99 books phase B, slice A2): the account of a purchase or sale document line follows the
-- chart of its document's entity on the invoice date. Idempotent; applied files stay untouched.
--
-- ludy_finance.check_account_ref()  the body of 20270403010000_ludy_finance_books_opening_rule.sql with one more branch:
--                                   a purchase_line (a purchase's expense or asset line, a sale's revenue line) of a
--                                   document whose entity keeps books other than TT133 2026.1 on the invoice date must
--                                   name an account of that chart (ludy_finance.chart_account), and nothing else is
--                                   accepted, as for a journal line. The sub-accounts of the org all roll up to TT133
--                                   accounts, so they are refused there too. Vendor defaults and learned rules keep
--                                   their checks against the org's TT133 chart: they are org-wide, and the app offers
--                                   them to an entity under another chart only when its chart has the account and means
--                                   the same by it.
SET LOCAL lock_timeout = '2s';

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
                                                                  WHERE o.org_id = e.org_id AND o.id = e.reverses_entry_id AND o.source_type = 'finance.opening_balance')
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
    -- A line of a document of an entity whose books on the document's date are not TT133 2026.1 names an account of that chart, like a journal line (the document's entity and invoice date; the entry of a late
    -- posting is dated later and checked on its own date). No row for the document or no books row: as before.
    SELECT d.legal_entity_id, b.regime, b.chart_version INTO v_entity, v_regime, v_version
    FROM ludy_finance.purchase_document d
    LEFT JOIN LATERAL (
      SELECT b.regime, b.chart_version FROM ludy_finance.legal_entity_books b
      WHERE b.org_id = d.org_id AND b.legal_entity_id = d.legal_entity_id AND b.effective_from <= d.invoice_date
      ORDER BY b.effective_from DESC LIMIT 1) b ON true
    WHERE d.org_id = NEW.org_id AND d.id = NEW.document_id;
    IF v_regime IS NOT NULL AND (v_regime, v_version) <> ('tt133', '2026.1') THEN
      IF EXISTS (SELECT 1 FROM ludy_finance.chart_account a WHERE a.regime = v_regime AND a.version = v_version AND a.code = v_code) THEN
        RETURN NULL;
      END IF;
      RAISE EXCEPTION 'insert or update on table "%" violates foreign key check: account % is not in the % % chart of accounts of legal entity %',
        TG_TABLE_NAME, v_code, v_regime, v_version, v_entity USING ERRCODE = '23503';
    END IF;
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
