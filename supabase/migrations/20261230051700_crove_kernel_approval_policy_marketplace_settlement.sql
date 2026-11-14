-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove approval policy for the posting of a marketplace settlement (issue #2516, ADR-0045 point 6): finance.marketplace_settlement.record is an R3 ledger proposal command, a general journal
-- voucher rebuilt from the stored settlement: the roles that post approve (owner, admin) and a member holding finance.proposal.approve through an org-wide assignment, four-eyes with the
-- one-person path (P10), and a ledger effect required before the proposal moves to 'executed' (crove_finance.ledger_effect_recorded, 20261230051600). Kept equal to approval.ts (POLICIES,
-- APPROVAL_POLICY_VERSION 12) by apps/kernel/test/invariant/proposal-approve-gate.db.test.ts.
--
-- crove_kernel.approval_command_policy  the policy table, with the new command in the ledger list: the body of 20261201032500 with the command added (the signature and OUT columns are unchanged).
-- approval_command_live and proposal_co_authors_guard are unchanged: the posting is judged on the snapshot of the members at the request, and a settlement has no approver of an earlier step to list.
-- Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.approval_command_policy(p_command text, OUT roles text[], OUT permission text, OUT four_eyes boolean, OUT ledger boolean)
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  WITH kind AS (
    SELECT p_command IN ('finance.purchase.record', 'finance.journal.reverse', 'finance.voucher.record',
                         'finance.journal_voucher.record', 'finance.closing.record', 'finance.depreciation.record', 'finance.stock.close_period',
                         'finance.stock.count_confirm', 'finance.payroll_posting.record', 'finance.payroll_payment.record',
                         'finance.marketplace_settlement.record') AS is_ledger,
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
