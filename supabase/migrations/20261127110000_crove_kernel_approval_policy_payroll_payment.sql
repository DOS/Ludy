-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove approval policy for the payment of a pay run's obligation (issue #2532, ADR-0046): finance.payroll_payment.record is an R3 ledger proposal command, a payment voucher built from the frozen run
-- (the net pay or a remittance): the roles that post approve (owner, admin) and a member holding finance.proposal.approve through an org-wide assignment, four-eyes with the one-person
-- path (P10), and a ledger effect required before the proposal moves to 'executed' (crove_finance.ledger_effect_recorded, 20261127100000). Kept equal to approval.ts (POLICIES,
-- APPROVAL_POLICY_VERSION 10) by apps/kernel/test/invariant/proposal-approve-gate.db.test.ts.
--
-- crove_kernel.approval_command_policy  the policy table, with the new command in the ledger list: the body of 20261126130000 with the command added (the signature and OUT columns are unchanged).
-- Idempotent; applied files stay untouched. approval_command_live is unchanged: the posting is judged on the snapshot of the members at the request, like every other ledger command.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.approval_command_policy(p_command text, OUT roles text[], OUT permission text, OUT four_eyes boolean, OUT ledger boolean)
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  WITH kind AS (
    SELECT p_command IN ('finance.purchase.record', 'finance.journal.reverse', 'finance.voucher.record',
                         'finance.journal_voucher.record', 'finance.closing.record', 'finance.depreciation.record', 'finance.stock.close_period',
                         'finance.stock.count_confirm', 'finance.payroll_posting.record', 'finance.payroll_payment.record') AS is_ledger,
           p_command IN ('ads.write.enable', 'ads.account.enable_write', 'ads.cap.set', 'ads.launches.unblock', 'ads.campaign.launch') AS is_ads,
           p_command IN ('finance.einvoice.issue') AS is_einvoice
  )
  SELECT CASE WHEN k.is_ledger OR k.is_ads OR k.is_einvoice THEN ARRAY['owner', 'admin']::text[] ELSE ARRAY[]::text[] END,
         CASE WHEN k.is_ledger THEN 'finance.proposal.approve' END,
         true,
         k.is_ledger
  FROM kind k
$$;
REVOKE ALL ON FUNCTION crove_kernel.approval_command_policy(text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
