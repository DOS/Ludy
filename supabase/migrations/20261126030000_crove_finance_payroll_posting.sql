-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #2532, docs/plan/payroll.md section 6.4, ADR-0046): the posting proposal of an approved pay run. Idempotent; applied files stay untouched.
--
-- crove_finance.journal_voucher.payroll_run_id  the voucher that posts a pay run names the run (the id of a crove_hr.payroll_run; no foreign key crosses the schemas, the run is the voucher's
--                                               source), one per run: a unique index makes "approving the proposal posts once" a fact of the database, not only of the command. Such a
--                                               voucher is no year closing, no close of a month of stock and no count, and it names the proposal that approved it.
-- crove_finance.effect_proposal_check          the trigger lists the new command, so a voucher may name a proposal only when that proposal is executing one of the commands that post vouchers.
-- The approval policy of the new command is in 20261126040000 (the kernel's own migration: a finance migration touches no crove_kernel object).
-- crove_finance.ledger_effect_recorded          the body of 20261124040000 with the branch for the new command: its effect is a voucher naming the run, stored in this transaction.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_finance.journal_voucher ADD COLUMN IF NOT EXISTS payroll_run_id uuid;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'journal_voucher_payroll_run' AND conrelid = 'crove_finance.journal_voucher'::regclass) THEN
    ALTER TABLE crove_finance.journal_voucher
      ADD CONSTRAINT journal_voucher_payroll_run CHECK (payroll_run_id IS NULL OR (closing_year IS NULL AND stock_closing_month IS NULL AND stock_count_id IS NULL AND proposal_id IS NOT NULL));
  END IF;
END
$$;
CREATE UNIQUE INDEX IF NOT EXISTS journal_voucher_payroll_run_uq ON crove_finance.journal_voucher (org_id, payroll_run_id) WHERE payroll_run_id IS NOT NULL;

DROP TRIGGER IF EXISTS a_effect_proposal ON crove_finance.journal_voucher;
CREATE TRIGGER a_effect_proposal BEFORE INSERT ON crove_finance.journal_voucher
  FOR EACH ROW EXECUTE FUNCTION crove_finance.effect_proposal_check('finance.journal_voucher.record', 'finance.closing.record', 'finance.depreciation.record', 'finance.stock.close_period', 'finance.stock.count_confirm', 'finance.payroll_posting.record');

-- A ledger proposal moves to 'executed' only when its effect was posted in this transaction (20261105020000). Redefined as it was, with the pay run's posting added.
CREATE OR REPLACE FUNCTION crove_finance.ledger_effect_recorded(p_org uuid, p_proposal uuid, p_command text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_xact xid8;
BEGIN
  IF p_org IS NULL OR p_org IS DISTINCT FROM crove_kernel.ctx_org_id() THEN
    RETURN false;
  END IF;
  IF NOT coalesce((crove_kernel.approval_command_policy(p_command)).ledger, false) THEN
    RETURN true;
  END IF;
  -- Assigned already: the update this answers for has written.
  v_xact := pg_catalog.pg_current_xact_id_if_assigned();
  IF v_xact IS NULL THEN
    RETURN false;
  END IF;
  RETURN CASE
    WHEN p_command = 'finance.journal.reverse' THEN EXISTS (
      SELECT 1 FROM crove_finance.journal_entry e
      WHERE e.org_id = p_org AND e.source_type = 'kernel.proposal' AND e.source_id = p_proposal AND e.reverses_entry_id IS NOT NULL
        AND e.created_xact_id = v_xact AND e.created_xact_start = pg_catalog.now())
    WHEN p_command = 'finance.purchase.record' THEN EXISTS (
      SELECT 1 FROM crove_finance.purchase_document d
      JOIN crove_finance.journal_entry e ON e.org_id = d.org_id AND e.source_type = 'finance.purchase_document' AND e.source_id = d.id
      WHERE d.org_id = p_org AND d.proposal_id = p_proposal AND e.created_xact_id = v_xact AND e.created_xact_start = pg_catalog.now())
    WHEN p_command = 'finance.voucher.record' THEN EXISTS (
      SELECT 1 FROM crove_finance.cash_voucher v
      JOIN crove_finance.journal_entry e ON e.org_id = v.org_id AND e.source_type = 'finance.cash_voucher' AND e.source_id = v.id
      WHERE v.org_id = p_org AND v.proposal_id = p_proposal AND e.created_xact_id = v_xact AND e.created_xact_start = pg_catalog.now())
    -- The close's effect is its voucher and the month it closed, and the count's its voucher and the count it confirmed, stored in this transaction: an untagged voucher is not the effect.
    WHEN p_command = 'finance.stock.close_period' THEN EXISTS (
      SELECT 1 FROM crove_finance.journal_voucher v
      JOIN crove_finance.journal_entry e ON e.org_id = v.org_id AND e.source_type = 'finance.journal_voucher' AND e.source_id = v.id
      JOIN crove_finance.stock_period p ON p.org_id = v.org_id AND p.voucher_id = v.id
      WHERE v.org_id = p_org AND v.proposal_id = p_proposal AND v.stock_closing_month IS NOT NULL AND e.created_xact_id = v_xact AND e.created_xact_start = pg_catalog.now())
    WHEN p_command = 'finance.stock.count_confirm' THEN EXISTS (
      SELECT 1 FROM crove_finance.journal_voucher v
      JOIN crove_finance.journal_entry e ON e.org_id = v.org_id AND e.source_type = 'finance.journal_voucher' AND e.source_id = v.id
      JOIN crove_finance.stock_count c ON c.org_id = v.org_id AND c.voucher_id = v.id AND c.status = 'confirmed'
      WHERE v.org_id = p_org AND v.proposal_id = p_proposal AND v.stock_count_id IS NOT NULL AND e.created_xact_id = v_xact AND e.created_xact_start = pg_catalog.now())
    -- The posting of a pay run (#2532): the effect is a voucher that names the run it posts and the proposal, stored in this transaction. An untagged voucher is not the effect.
    WHEN p_command = 'finance.payroll_posting.record' THEN EXISTS (
      SELECT 1 FROM crove_finance.journal_voucher v
      JOIN crove_finance.journal_entry e ON e.org_id = v.org_id AND e.source_type = 'finance.journal_voucher' AND e.source_id = v.id
      WHERE v.org_id = p_org AND v.proposal_id = p_proposal AND v.payroll_run_id IS NOT NULL AND e.created_xact_id = v_xact AND e.created_xact_start = pg_catalog.now())
    WHEN p_command IN ('finance.journal_voucher.record', 'finance.closing.record', 'finance.depreciation.record') THEN EXISTS (
      SELECT 1 FROM crove_finance.journal_voucher v
      JOIN crove_finance.journal_entry e ON e.org_id = v.org_id AND e.source_type = 'finance.journal_voucher' AND e.source_id = v.id
      WHERE v.org_id = p_org AND v.proposal_id = p_proposal AND e.created_xact_id = v_xact AND e.created_xact_start = pg_catalog.now())
    ELSE false
  END;
END $$;
REVOKE ALL ON FUNCTION crove_finance.ledger_effect_recorded(uuid, uuid, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_finance.ledger_effect_recorded(uuid, uuid, text) TO crove_tenant;
