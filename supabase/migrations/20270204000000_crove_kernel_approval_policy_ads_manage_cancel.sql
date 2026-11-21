-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove approval policy and MCP catalog row for the proposal-only twin that cancels a queued change of a running ad (epic #3857, E4 #3863, issue #4181; ADR-0051 decision 10; owner decision 2026-11-19,
-- "Cho làm, việc lớn chờ duyệt"). An AI coworker that holds ludy.ads.draft calls `ads.manage.cancel_approved`; the call becomes a pending, tainted proposal, and an owner or an admin approves it in Ludy, which
-- runs ads.manage.cancel as the approver (only for a change that would start or raise spend; the twin refuses the cancel of a reducing change). Kept equal to approval.ts (POLICIES, APPROVAL_POLICY_VERSION 19)
-- by apps/kernel/test/invariant/proposal-approve-gate.db.test.ts.
--
-- crove_kernel.approval_command_policy  the body of 20270123500000 (the newest) with the twin added to the Engage group of owners and admins (the signature and OUT columns are unchanged).
-- crove_kernel.approval_command_live    the body of 20270123500000 (the newest) with the twin added: who may approve is judged on the members of the org now, as for the other twins.
-- crove_kernel.mcp_proposal_command     one more row: the one write scope it needs and the kind of its proposals (the guard takes the kind from here, never from the caller).
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
           p_command IN ('ads.write.enable', 'ads.account.enable_write', 'ads.cap.set', 'ads.launches.unblock', 'ads.campaign.launch',
                         'ads.object.resume', 'ads.budget.raise', 'ads.schedule.extend') AS is_ads,
           p_command IN ('finance.einvoice.issue', 'finance.supplier_payment.record') AS is_einvoice,
           p_command IN ('kernel.conversation.reply_approved', 'kernel.conversation.reply_privately_approved', 'kernel.conversation.hide_approved',
                         'crm.quote.send_approved', 'crm.booking.move_approved', 'crm.booking.cancel_approved',
                         'social.post.submit_approved', 'social.variant.schedule_approved',
                         'ads.launch.stop_approved', 'ads.pause_all_approved', 'ads.object.pause_approved', 'ads.object.archive_approved',
                         'ads.budget.lower_approved', 'ads.schedule.shorten_approved', 'ads.manage.cancel_approved') AS is_engage
  )
  SELECT CASE WHEN k.is_ledger OR k.is_ads OR k.is_einvoice OR k.is_engage THEN ARRAY['owner', 'admin']::text[] ELSE ARRAY[]::text[] END,
         CASE WHEN k.is_ledger THEN 'finance.proposal.approve' END,
         true,
         k.is_ledger
  FROM kind k
$$;
REVOKE ALL ON FUNCTION crove_kernel.approval_command_policy(text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

CREATE OR REPLACE FUNCTION crove_kernel.approval_command_live(p_command text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT p_command IN ('ads.write.enable', 'ads.account.enable_write', 'ads.cap.set', 'ads.launches.unblock', 'ads.campaign.launch', 'ads.object.resume', 'ads.budget.raise',
                       'ads.schedule.extend', 'finance.einvoice.issue', 'finance.supplier_payment.record',
                       'kernel.conversation.reply_approved', 'kernel.conversation.reply_privately_approved', 'kernel.conversation.hide_approved',
                       'crm.quote.send_approved', 'crm.booking.move_approved', 'crm.booking.cancel_approved',
                       'social.post.submit_approved', 'social.variant.schedule_approved',
                       'ads.launch.stop_approved', 'ads.pause_all_approved', 'ads.object.pause_approved', 'ads.object.archive_approved',
                       'ads.budget.lower_approved', 'ads.schedule.shorten_approved', 'ads.manage.cancel_approved')
$$;
REVOKE ALL ON FUNCTION crove_kernel.approval_command_live(text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- The catalog of the commands an MCP proposal may name (20270119150000): one row for the twin, with the scope a grant needs and the kind of its proposals.
INSERT INTO crove_kernel.mcp_proposal_command (command, scope, kind, adr) VALUES
  ('ads.manage.cancel_approved', 'ludy.ads.draft', 'ads.manage_cancel', 'ADR-0051')
ON CONFLICT (command) DO UPDATE SET scope = EXCLUDED.scope, kind = EXCLUDED.kind, adr = EXCLUDED.adr;
