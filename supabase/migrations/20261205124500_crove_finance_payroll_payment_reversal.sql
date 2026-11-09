-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #2854, docs/plan/payroll.md section 6.4, ADR-0046): a payment voucher of a pay run that was reversed frees its (run, kind), so the payment can be recorded again.
-- 20261201031500 made "one payment voucher per run and kind" a unique index. The ledger is append-only, so a reversed voucher stays, and with it the index entry: the payment of that run and kind could
-- never be recorded again. An index cannot look at another table, and the database already knows a voucher is reversed (its journal entry has a reversal entry pointing at it), so the rule moves
-- into a trigger that says the same thing about LIVE vouchers: at most one voucher of a (run, kind) that is not reversed.
-- A voucher is reversed when it has an original entry (source finance.cash_voucher, reverses nothing) and every original entry of it has a reversal; a voucher whose entry is not yet visible, or with
-- no entry, counts as live (the safe side: the slot stays taken).
-- The trigger takes a transaction-level advisory lock on (org, run, kind) before it looks, so two inserts of one (run, kind) take turns: the second waits for the first to commit, then sees it. This relies on
-- READ COMMITTED (the runtime's isolation for commands), as the reversal request lock does (finance/reversal.ts); a statement under REPEATABLE READ would not see a voucher committed while it waited.
-- The function is owned by the migration runner, like the ledger checks (20261018150000), so it sees every voucher and entry of the org whatever the writer can see: the index it replaces was blind to row
-- security too. It raises the unique violation with the old index's name, so every caller that knew the rule by its error keeps working.
-- The lookup index stays (not unique), created before the unique one goes, so the rule never lapses. Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

CREATE INDEX IF NOT EXISTS cash_voucher_payroll_payment_ix ON crove_finance.cash_voucher (org_id, payroll_run_id, payroll_payment_kind) WHERE payroll_run_id IS NOT NULL;

CREATE OR REPLACE FUNCTION crove_finance.cash_voucher_payroll_slot() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('crove_finance.cash_voucher_payroll_slot:' || NEW.org_id::pg_catalog.text || ':' || NEW.payroll_run_id::pg_catalog.text || ':' || NEW.payroll_payment_kind, 0));
  IF EXISTS (
    SELECT 1
    FROM crove_finance.cash_voucher v
    WHERE v.org_id = NEW.org_id AND v.payroll_run_id = NEW.payroll_run_id AND v.payroll_payment_kind = NEW.payroll_payment_kind AND v.id <> NEW.id
      -- live: not reversed. Reversed = has an original entry and every original entry has a reversal.
      AND NOT (
        EXISTS (
          SELECT 1 FROM crove_finance.journal_entry o
          WHERE o.org_id = v.org_id AND o.source_type = 'finance.cash_voucher' AND o.source_id = v.id AND o.reverses_entry_id IS NULL)
        AND NOT EXISTS (
          SELECT 1 FROM crove_finance.journal_entry o
          WHERE o.org_id = v.org_id AND o.source_type = 'finance.cash_voucher' AND o.source_id = v.id AND o.reverses_entry_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM crove_finance.journal_entry r WHERE r.org_id = o.org_id AND r.reverses_entry_id = o.id)))
  ) THEN
    RAISE EXCEPTION 'pay run % already has a payment voucher of kind % that is not reversed', NEW.payroll_run_id, NEW.payroll_payment_kind
      USING ERRCODE = '23505', CONSTRAINT = 'cash_voucher_payroll_payment_uq';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS cash_voucher_payroll_slot ON crove_finance.cash_voucher;
CREATE TRIGGER cash_voucher_payroll_slot
  BEFORE INSERT ON crove_finance.cash_voucher
  FOR EACH ROW WHEN (NEW.payroll_run_id IS NOT NULL)
  EXECUTE FUNCTION crove_finance.cash_voucher_payroll_slot();

-- A trigger function only; nobody calls it directly.
REVOKE ALL ON FUNCTION crove_finance.cash_voucher_payroll_slot() FROM PUBLIC, crove_tenant, crove_definer_tenant;

-- Drift guard (as in 20261018150000): the check must run as a role that row security does not filter on the tables it reads, or it would miss a voucher or an entry the writer cannot see.
DO $$
DECLARE
  v_table text;
BEGIN
  SELECT pg_catalog.string_agg(c.oid::pg_catalog.regclass::text, ', ') INTO v_table
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
  CROSS JOIN pg_catalog.pg_class c
  WHERE p.oid = 'crove_finance.cash_voucher_payroll_slot()'::pg_catalog.regprocedure
    AND c.oid IN ('crove_finance.cash_voucher'::pg_catalog.regclass, 'crove_finance.journal_entry'::pg_catalog.regclass)
    AND NOT (r.rolsuper OR r.rolbypassrls OR (c.relowner = p.proowner AND NOT c.relforcerowsecurity));
  IF v_table IS NOT NULL THEN
    RAISE EXCEPTION 'crove_finance.cash_voucher_payroll_slot() must be owned by the owner of % (row security not forced), a superuser or a BYPASSRLS role', v_table;
  END IF;
END $$;

-- The unique index is replaced by the trigger above: a reversed voucher no longer holds its (run, kind).
DROP INDEX IF EXISTS crove_finance.cash_voucher_payroll_payment_uq;
