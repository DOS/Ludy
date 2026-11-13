-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #2931, docs/plan/payroll.md section 6.4, ADR-0046; follows #2854): the posting of a pay run that was reversed frees the run, so the run can be posted again.
-- 20261126120000 made "one posting voucher per pay run" a unique index. The ledger is append-only, so a reversed voucher stays, and with it the index entry: a month whose posting was reversed
-- by mistake could never be posted again, and (since #2854) could not be paid either. An index cannot look at another table, and the database already knows a voucher is reversed (its journal
-- entry has a reversal entry pointing at it), so the rule moves into a trigger that says the same thing about LIVE postings: at most one posting voucher of a run that is not reversed.
-- A voucher is reversed when it has an original entry (source finance.journal_voucher, reverses nothing) and every original entry of it has a reversal; a voucher whose entry is not yet visible, or with
-- no entry, counts as live (the safe side: the slot stays taken).
-- The trigger takes a transaction-level advisory lock on (org, run) before it looks, so two inserts for one run take turns: the second waits for the first to commit, then sees it. This relies on
-- READ COMMITTED (the runtime's isolation for commands), as the reversal request lock does (finance/reversal.ts) and as 20261212114500 does for the payment vouchers.
-- The function is owned by the migration runner, like the ledger checks (20261018150000), so it sees every voucher and entry of the org whatever the writer can see: the index it replaces was blind to row
-- security too. It raises the unique violation with the old index's name, so every caller that knew the rule by its error keeps working.
-- The lookup index (not unique) is created before the unique one goes, so the rule never lapses. Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

CREATE INDEX IF NOT EXISTS journal_voucher_payroll_run_ix ON crove_finance.journal_voucher (org_id, payroll_run_id) WHERE payroll_run_id IS NOT NULL;

CREATE OR REPLACE FUNCTION crove_finance.journal_voucher_payroll_slot() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('crove_finance.journal_voucher_payroll_slot:' || NEW.org_id::pg_catalog.text || ':' || NEW.payroll_run_id::pg_catalog.text, 0));
  IF EXISTS (
    SELECT 1
    FROM crove_finance.journal_voucher v
    WHERE v.org_id = NEW.org_id AND v.payroll_run_id = NEW.payroll_run_id AND v.id <> NEW.id
      -- live: not reversed. Reversed = has an original entry and every original entry has a reversal.
      AND NOT (
        EXISTS (
          SELECT 1 FROM crove_finance.journal_entry o
          WHERE o.org_id = v.org_id AND o.source_type = 'finance.journal_voucher' AND o.source_id = v.id AND o.reverses_entry_id IS NULL)
        AND NOT EXISTS (
          SELECT 1 FROM crove_finance.journal_entry o
          WHERE o.org_id = v.org_id AND o.source_type = 'finance.journal_voucher' AND o.source_id = v.id AND o.reverses_entry_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM crove_finance.journal_entry r WHERE r.org_id = o.org_id AND r.reverses_entry_id = o.id)))
  ) THEN
    RAISE EXCEPTION 'pay run % already has a posting voucher that is not reversed', NEW.payroll_run_id
      USING ERRCODE = '23505', CONSTRAINT = 'journal_voucher_payroll_run_uq';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS journal_voucher_payroll_slot ON crove_finance.journal_voucher;
CREATE TRIGGER journal_voucher_payroll_slot
  BEFORE INSERT ON crove_finance.journal_voucher
  FOR EACH ROW WHEN (NEW.payroll_run_id IS NOT NULL)
  EXECUTE FUNCTION crove_finance.journal_voucher_payroll_slot();

-- A trigger function only; nobody calls it directly.
REVOKE ALL ON FUNCTION crove_finance.journal_voucher_payroll_slot() FROM PUBLIC, crove_tenant, crove_definer_tenant;

-- Drift guard (as in 20261018150000): the check must run as a role that row security does not filter on the tables it reads, or it would miss a voucher or an entry the writer cannot see.
DO $$
DECLARE
  v_table text;
BEGIN
  SELECT pg_catalog.string_agg(c.oid::pg_catalog.regclass::text, ', ') INTO v_table
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
  CROSS JOIN pg_catalog.pg_class c
  WHERE p.oid = 'crove_finance.journal_voucher_payroll_slot()'::pg_catalog.regprocedure
    AND c.oid IN ('crove_finance.journal_voucher'::pg_catalog.regclass, 'crove_finance.journal_entry'::pg_catalog.regclass)
    AND NOT (r.rolsuper OR r.rolbypassrls OR (c.relowner = p.proowner AND NOT c.relforcerowsecurity));
  IF v_table IS NOT NULL THEN
    RAISE EXCEPTION 'crove_finance.journal_voucher_payroll_slot() must be owned by the owner of % (row security not forced), a superuser or a BYPASSRLS role', v_table;
  END IF;
END $$;

-- The unique index is replaced by the trigger above: a reversed posting no longer holds its run.
DROP INDEX IF EXISTS crove_finance.journal_voucher_payroll_run_uq;
