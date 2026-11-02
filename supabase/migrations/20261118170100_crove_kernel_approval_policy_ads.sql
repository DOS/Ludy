-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove approval policy for running ads (issue #2294, ADR-0043 point 1): crove_kernel.approval_command_policy gains the four ads
-- commands that open the way to spend, `ads.write.enable`, `ads.account.enable_write`, `ads.cap.set` and `ads.launches.unblock`:
-- an owner or an admin approves (Q2), no approval permission, four-eyes with the one-person path (P10), and none of them posts to
-- the ledger (`ledger` false). Kept equal to approval.ts (POLICIES) by apps/kernel/test/invariant/proposal-approve-gate.db.test.ts.
-- Idempotent; applied files stay untouched. The ads module's own part (the marker the guards read) is in
-- 20261118170000_crove_ads_write_proposals.sql.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.approval_command_policy(p_command text, OUT roles text[], OUT permission text, OUT four_eyes boolean, OUT ledger boolean)
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  WITH kind AS (
    SELECT p_command IN ('finance.purchase.record', 'finance.journal.reverse', 'finance.voucher.record',
                         'finance.journal_voucher.record', 'finance.closing.record', 'finance.depreciation.record') AS is_ledger,
           p_command IN ('ads.write.enable', 'ads.account.enable_write', 'ads.cap.set', 'ads.launches.unblock') AS is_ads
  )
  SELECT CASE WHEN k.is_ledger OR k.is_ads THEN ARRAY['owner', 'admin']::text[] ELSE ARRAY[]::text[] END,
         CASE WHEN k.is_ledger THEN 'finance.proposal.approve' END,
         true,
         k.is_ledger
  FROM kind k
$$;
REVOKE ALL ON FUNCTION crove_kernel.approval_command_policy(text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
