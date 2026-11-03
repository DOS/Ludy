-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove approval policy for issuing a sales e-invoice (issue #2502, ADR-0044 point 3): finance.einvoice.issue is an R3 legal proposal command: an owner or an admin approves, no
-- approval permission, four-eyes with the one-person path (P10), the approver judged on the members of the org now (live), and no ledger (issuing posts nothing: the sale is
-- posted later, from the signed XML, through the intake). Kept equal to approval.ts (POLICIES, APPROVAL_POLICY_VERSION 5) by
-- apps/kernel/test/invariant/proposal-approve-gate.db.test.ts.
--
-- crove_kernel.approval_command_policy  the policy table, with the new command in its own list (the signature and OUT columns are unchanged).
-- crove_kernel.approval_command_live    which commands are judged on the members now (approval.ts, CommandPolicy.live): the new command joins the ads ones.
-- Idempotent; applied files stay untouched. The finance part (the definer that runs under the approval) is in 20261122180000_crove_finance_einvoice_issue.sql.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.approval_command_policy(p_command text, OUT roles text[], OUT permission text, OUT four_eyes boolean, OUT ledger boolean)
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  WITH kind AS (
    SELECT p_command IN ('finance.purchase.record', 'finance.journal.reverse', 'finance.voucher.record',
                         'finance.journal_voucher.record', 'finance.closing.record', 'finance.depreciation.record') AS is_ledger,
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

CREATE OR REPLACE FUNCTION crove_kernel.approval_command_live(p_command text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT p_command IN ('ads.write.enable', 'ads.account.enable_write', 'ads.cap.set', 'ads.launches.unblock', 'ads.campaign.launch', 'finance.einvoice.issue')
$$;
REVOKE ALL ON FUNCTION crove_kernel.approval_command_live(text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
