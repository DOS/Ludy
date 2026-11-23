-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove approval policy for a payment to a supplier (#3113 S2, #3699): finance.supplier_payment.record is an R3 proposal command that posts nothing to the ledger (Ludy moves no money; the ledger posts
-- when the bank line matches, S3): an owner or an admin approves, with four-eyes and the one-person path (P10), judged on the members now (like the e-invoice and the ads commands, so a member who
-- left or was demoted since the request cannot be the one approving), and no ledger effect is required before the proposal moves to 'executed'. Kept equal to approval.ts (POLICIES,
-- APPROVAL_POLICY_VERSION 15) by apps/kernel/test/invariant/proposal-approve-gate.db.test.ts.
--
-- crove_kernel.approval_command_policy  the policy table, with the new command in the e-invoice list: the body of 20270101000000 with the command added (the signature and OUT columns are unchanged).
-- crove_kernel.approval_command_live    which commands are judged on the members now: the body of 20261123060000 with the command added.
-- Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.approval_command_policy(p_command text, OUT roles text[], OUT permission text, OUT four_eyes boolean, OUT ledger boolean)
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  WITH kind AS (
    SELECT p_command IN ('finance.purchase.record', 'finance.journal.reverse', 'finance.voucher.record',
                         'finance.journal_voucher.record', 'finance.closing.record', 'finance.depreciation.record', 'finance.stock.close_period',
                         'finance.stock.count_confirm', 'finance.payroll_posting.record', 'finance.payroll_payment.record',
                         'finance.marketplace_settlement.record', 'finance.marketplace_payout.record', 'finance.marketplace_fee_clearing.record') AS is_ledger,
           p_command IN ('ads.write.enable', 'ads.account.enable_write', 'ads.cap.set', 'ads.launches.unblock', 'ads.campaign.launch') AS is_ads,
           p_command IN ('finance.einvoice.issue', 'finance.supplier_payment.record') AS is_einvoice
  )
  SELECT CASE WHEN k.is_ledger OR k.is_ads OR k.is_einvoice THEN ARRAY['owner', 'admin']::text[] ELSE ARRAY[]::text[] END,
         CASE WHEN k.is_ledger THEN 'finance.proposal.approve' END,
         true,
         k.is_ledger
  FROM kind k
$$;
REVOKE ALL ON FUNCTION crove_kernel.approval_command_policy(text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

CREATE OR REPLACE FUNCTION crove_kernel.approval_command_live(p_command text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT p_command IN ('ads.write.enable', 'ads.account.enable_write', 'ads.cap.set', 'ads.launches.unblock', 'ads.campaign.launch', 'finance.einvoice.issue', 'finance.supplier_payment.record')
$$;
REVOKE ALL ON FUNCTION crove_kernel.approval_command_live(text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
