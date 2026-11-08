-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #2532, docs/plan/payroll.md section 6.4, ADR-0046): the payment vouchers of an approved pay run, one for its net pay and one for each remittance (insurance, union fee, tax).
-- Idempotent; applied files stay untouched.
--
-- crove_finance.cash_voucher.payroll_run_id, payroll_payment_kind  the voucher that pays a pay run's obligation names the run (the id of a crove_hr.payroll_run; no foreign key crosses the
--                                               schemas) and what it pays; one per run and kind: a unique index makes "approving the proposal pays once" a fact of the database, not only of the command.
--                                               Both or neither, and a voucher that names a run names the proposal that approved it.
-- crove_finance.effect_proposal_check          the cash voucher's trigger lists the new command, so a voucher may name a proposal only when that proposal is executing one of the commands that record vouchers.
-- crove_finance.ledger_effect_recorded         the body of 20261126120000 with the branch for the new command: its effect is a voucher naming the run, with its entry, stored in this transaction.
-- The approval policy of the new command is in 20261201032500 (the kernel's own migration: a finance migration touches no crove_kernel object).
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_finance.cash_voucher ADD COLUMN IF NOT EXISTS payroll_run_id uuid;
ALTER TABLE crove_finance.cash_voucher ADD COLUMN IF NOT EXISTS payroll_payment_kind text;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cash_voucher_payroll_payment' AND conrelid = 'crove_finance.cash_voucher'::regclass) THEN
    ALTER TABLE crove_finance.cash_voucher
      ADD CONSTRAINT cash_voucher_payroll_payment CHECK (
        (payroll_run_id IS NULL AND payroll_payment_kind IS NULL)
        OR (payroll_run_id IS NOT NULL AND payroll_payment_kind IS NOT NULL AND payroll_payment_kind IN ('net_pay', 'insurance', 'union', 'tax') AND proposal_id IS NOT NULL AND voucher_type IN ('cash_payment', 'bank_debit')));
  END IF;
END
$$;
CREATE UNIQUE INDEX IF NOT EXISTS cash_voucher_payroll_payment_uq ON crove_finance.cash_voucher (org_id, payroll_run_id, payroll_payment_kind) WHERE payroll_run_id IS NOT NULL;

DROP TRIGGER IF EXISTS a_effect_proposal ON crove_finance.cash_voucher;
CREATE TRIGGER a_effect_proposal BEFORE INSERT ON crove_finance.cash_voucher
  FOR EACH ROW EXECUTE FUNCTION crove_finance.effect_proposal_check('finance.voucher.record', 'finance.payroll_payment.record');

-- A ledger proposal moves to 'executed' only when its effect was posted in this transaction (20261105020000). Redefined as it was, with the payment of a pay run's obligation added.
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
    -- A voucher that names a pay run is the effect of the payment command only: an untagged voucher proposal's effect is an untagged voucher.
    WHEN p_command = 'finance.voucher.record' THEN EXISTS (
      SELECT 1 FROM crove_finance.cash_voucher v
      JOIN crove_finance.journal_entry e ON e.org_id = v.org_id AND e.source_type = 'finance.cash_voucher' AND e.source_id = v.id
      WHERE v.org_id = p_org AND v.proposal_id = p_proposal AND v.payroll_run_id IS NULL AND e.created_xact_id = v_xact AND e.created_xact_start = pg_catalog.now())
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
    -- The payment of a pay run's net pay or a remittance (#2532): the effect is a voucher that names the run and the kind of payment and the proposal, with its entry, stored in this transaction. An untagged voucher is not the effect.
    WHEN p_command = 'finance.payroll_payment.record' THEN EXISTS (
      SELECT 1 FROM crove_finance.cash_voucher v
      JOIN crove_finance.journal_entry e ON e.org_id = v.org_id AND e.source_type = 'finance.cash_voucher' AND e.source_id = v.id
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
