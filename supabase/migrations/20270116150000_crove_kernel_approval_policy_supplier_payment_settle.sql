-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove approval policy for the settlement of a supplier payment (#3700 S3c): finance.supplier_payment.settle.record is an R3 ledger proposal (it records a bank voucher, Dr 331 / Cr the bank, and moves the
-- payment to paid): the same rule as every posting (owners and admins, and a member holding finance.proposal.approve org-wide; four-eyes and the one-person path, P10; only the chief accountant in an
-- accountant-preset org, P09), and its effect (a voucher that names the payment, with its entry) must be stored in the approving transaction (crove_finance.ledger_effect_recorded, 20270116140000). Kept equal to
-- approval.ts (POLICIES, APPROVAL_POLICY_VERSION 16) by apps/kernel/test/invariant/proposal-approve-gate.db.test.ts.
--
-- crove_kernel.approval_command_policy  the body of 20270115140000 (the newest) with the command added to the ledger list (the signature and OUT columns are unchanged).
-- Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.approval_command_policy(p_command text, OUT roles text[], OUT permission text, OUT four_eyes boolean, OUT ledger boolean)
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  WITH kind AS (
    SELECT p_command IN ('finance.purchase.record', 'finance.journal.reverse', 'finance.voucher.record',
                         'finance.journal_voucher.record', 'finance.closing.record', 'finance.depreciation.record', 'finance.stock.close_period',
                         'finance.stock.count_confirm', 'finance.payroll_posting.record', 'finance.payroll_payment.record',
                         'finance.marketplace_settlement.record', 'finance.marketplace_payout.record', 'finance.marketplace_fee_clearing.record',
                         'finance.supplier_payment.settle.record') AS is_ledger,
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
