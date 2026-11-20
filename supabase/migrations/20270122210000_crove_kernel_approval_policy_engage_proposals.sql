-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove approval policy and MCP catalog rows for the proposal-only twins of the Engage commands (epic #3857, E4 #3863; ADR-0051 decision 10; owner decision 2026-11-19, "Cho làm, việc lớn chờ duyệt").
-- An AI coworker that holds ludy.engage.write or ludy.ads.draft calls a twin (`kernel.conversation.reply_approved`, `crm.quote.send_approved`, `ads.pause_all_approved` and the rest of
-- ENGAGE_PROPOSALS in packages/kernel-contract/src/engage-proposals.ts); the call becomes a pending, tainted proposal, and an owner or an admin approves it in Ludy. Kept equal to approval.ts
-- (POLICIES, APPROVAL_POLICY_VERSION 18) by apps/kernel/test/invariant/proposal-approve-gate.db.test.ts.
--
-- crove_kernel.approval_command_policy  the body of 20270118140000 (the newest) with the twins added as one more group of owners and admins, four-eyes with the one-person path, no permission, no ledger
--                                       (the signature and OUT columns are unchanged).
-- crove_kernel.approval_command_live    the body of 20270118140000 (the newest) with the twins added: who may approve is judged on the members of the org now, as for the ads commands.
-- crove_kernel.mcp_proposal_command     one row per twin: the one write scope it needs and the kind of its proposals (the guard takes the kind from here, never from the caller).
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
                         'ads.budget.lower_approved', 'ads.schedule.shorten_approved') AS is_engage
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
                       'ads.budget.lower_approved', 'ads.schedule.shorten_approved')
$$;
REVOKE ALL ON FUNCTION crove_kernel.approval_command_live(text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- The catalog of the commands an MCP proposal may name (20270119150000): one row per twin, with the scope a grant needs and the kind of its proposals.
INSERT INTO crove_kernel.mcp_proposal_command (command, scope, kind, adr) VALUES
  ('kernel.conversation.reply_approved', 'ludy.engage.write', 'kernel.conversation_reply', 'ADR-0051'),
  ('kernel.conversation.reply_privately_approved', 'ludy.engage.write', 'kernel.conversation_reply_privately', 'ADR-0051'),
  ('kernel.conversation.hide_approved', 'ludy.engage.write', 'kernel.conversation_hide', 'ADR-0051'),
  ('crm.quote.send_approved', 'ludy.engage.write', 'crm.quote_send', 'ADR-0051'),
  ('crm.booking.move_approved', 'ludy.engage.write', 'crm.booking_move', 'ADR-0051'),
  ('crm.booking.cancel_approved', 'ludy.engage.write', 'crm.booking_cancel', 'ADR-0051'),
  ('social.post.submit_approved', 'ludy.engage.write', 'social.post_submit', 'ADR-0051'),
  ('social.variant.schedule_approved', 'ludy.engage.write', 'social.variant_schedule', 'ADR-0051'),
  ('ads.launch.stop_approved', 'ludy.ads.draft', 'ads.launch_stop', 'ADR-0051'),
  ('ads.pause_all_approved', 'ludy.ads.draft', 'ads.pause_all', 'ADR-0051'),
  ('ads.object.pause_approved', 'ludy.ads.draft', 'ads.object_pause', 'ADR-0051'),
  ('ads.object.archive_approved', 'ludy.ads.draft', 'ads.object_archive', 'ADR-0051'),
  ('ads.budget.lower_approved', 'ludy.ads.draft', 'ads.budget_lower', 'ADR-0051'),
  ('ads.schedule.shorten_approved', 'ludy.ads.draft', 'ads.schedule_shorten', 'ADR-0051')
ON CONFLICT (command) DO UPDATE SET scope = EXCLUDED.scope, kind = EXCLUDED.kind, adr = EXCLUDED.adr;
