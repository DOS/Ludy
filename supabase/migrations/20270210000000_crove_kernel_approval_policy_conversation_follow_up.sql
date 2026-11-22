-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove approval policy, MCP catalog row and erasure sweep for the proposal-only twin that creates a team task linked to a thread (epic #3857, E4 #3863, issue #4148; ADR-0051 decision 10; owner decision
-- 2026-11-19, "Cho làm, việc lớn chờ duyệt"). An AI coworker that holds ludy.engage.write calls `kernel.conversation.follow_up_approved`; the call becomes a pending, tainted proposal, and an owner or an admin
-- approves it in Ludy, which runs kernel.conversation.follow_up as the approver. The task, its `kernel.task.created` outbox row and the wake-up of the assignee's agent therefore happen in the approver's context,
-- never in the sealed write context of a grant (which still allows no outbox or wake-up row: this file does not touch agent_write_guard or mcp_write_row_ok). Kept equal to approval.ts (POLICIES,
-- APPROVAL_POLICY_VERSION 20) by apps/kernel/test/invariant/proposal-approve-gate.db.test.ts.
--
-- crove_kernel.approval_command_policy        the body of 20270204000000 (the newest) with the twin added to the Engage group of owners and admins (signature and OUT columns unchanged).
-- crove_kernel.approval_command_live          the body of 20270204000000 (the newest) with the twin added: who may approve is judged on the members of the org now, as for the other twins.
-- crove_kernel.mcp_proposal_command           one more row: the one write scope it needs and the kind of its proposals (the guard takes the kind from here, never from the caller).
-- crove_kernel.engage_proposal_erase_gone()   the body of 20270201300000 (the newest) with the twin added to the commands it sweeps: its payload names a conversation, and a proposal whose thread is gone could
--                                             never be approved and holds text an AI wrote about a customer's thread. Nothing else changes.
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
                         'kernel.conversation.follow_up_approved',
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
                       'kernel.conversation.follow_up_approved',
                       'crm.quote.send_approved', 'crm.booking.move_approved', 'crm.booking.cancel_approved',
                       'social.post.submit_approved', 'social.variant.schedule_approved',
                       'ads.launch.stop_approved', 'ads.pause_all_approved', 'ads.object.pause_approved', 'ads.object.archive_approved',
                       'ads.budget.lower_approved', 'ads.schedule.shorten_approved', 'ads.manage.cancel_approved')
$$;
REVOKE ALL ON FUNCTION crove_kernel.approval_command_live(text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- The catalog of the commands an MCP proposal may name (20270119150000): one row for the twin, with the scope a grant needs and the kind of its proposals.
INSERT INTO crove_kernel.mcp_proposal_command (command, scope, kind, adr) VALUES
  ('kernel.conversation.follow_up_approved', 'ludy.engage.write', 'kernel.conversation_follow_up', 'ADR-0051')
ON CONFLICT (command) DO UPDATE SET scope = EXCLUDED.scope, kind = EXCLUDED.kind, adr = EXCLUDED.adr;

CREATE OR REPLACE FUNCTION crove_kernel.engage_proposal_erase_gone() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_actor text := crove_kernel.ctx_actor_type();
  v_user uuid := CASE WHEN crove_kernel.ctx_actor_type() = 'user' THEN crove_kernel.ctx_user_id() END;
  v_n integer;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'ENGAGE_ERASE_NO_ORG' USING ERRCODE = '42501';
  END IF;
  -- An owner or an admin (the erasure of a customer is theirs), or the system (the retention purge): nobody else. An MCP grant and an agent have the actor type 'agent', so they are refused here without reading the sealed member key (the set of its readers is pinned exactly).
  IF NOT (v_actor = 'system'
          OR (v_actor = 'user' AND v_user IS NOT NULL
              AND EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = v_org AND m.user_id = v_user AND m.role IN ('owner', 'admin')))) THEN
    RAISE EXCEPTION 'ENGAGE_ERASE_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  WITH orphan AS (
    SELECT p.id, p.status AS was
    FROM crove_kernel.proposal p
    WHERE p.org_id = v_org
      AND p.command IN ('kernel.conversation.reply_approved', 'kernel.conversation.reply_privately_approved', 'kernel.conversation.hide_approved', 'kernel.conversation.follow_up_approved')
      AND p.payload IS DISTINCT FROM pg_catalog.jsonb_build_object('erased', true)
      -- An id is compared as the uuid it is (a client's capitals are the same id, and the twins store ids lower-cased); text that is no uuid names nothing, so the CASE never casts it.
      AND (CASE WHEN pg_catalog.lower(p.payload ->> 'conversationId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                THEN NOT EXISTS (SELECT 1 FROM crove_kernel.conversation c WHERE c.org_id = v_org AND c.id = (pg_catalog.lower(p.payload ->> 'conversationId'))::uuid)
                ELSE false END
        OR CASE WHEN pg_catalog.lower(p.payload ->> 'messageId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                THEN NOT EXISTS (SELECT 1 FROM crove_kernel.conversation_message m WHERE m.org_id = v_org AND m.id = (pg_catalog.lower(p.payload ->> 'messageId'))::uuid)
                ELSE false END)
    FOR UPDATE OF p
  ), blanked AS (
    UPDATE crove_kernel.proposal p
    SET payload = pg_catalog.jsonb_build_object('erased', true),
        status = CASE WHEN p.status = 'pending' THEN 'rejected' ELSE p.status END,
        decided_at = CASE WHEN p.status = 'pending' THEN pg_catalog.now() ELSE p.decided_at END,
        decided_by = CASE WHEN p.status = 'pending' THEN NULL ELSE p.decided_by END,
        decision_note = CASE WHEN p.status = 'pending' THEN 'conversation erased' WHEN p.decision_note IS NOT NULL THEN 'erased' ELSE NULL END
    FROM orphan o
    WHERE p.org_id = v_org AND p.id = o.id
    RETURNING p.id, o.was
  ), logged AS (
    INSERT INTO crove_kernel.audit_event (org_id, actor_type, actor_id, command, command_id, outcome, target_type, target_id, input_sha256, detail)
    SELECT v_org, v_actor, v_user, 'kernel.engage.proposal_erased', crove_kernel.uuid_v7(), 'ok', 'kernel.proposal', b.id,
           pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(b.id::text, 'UTF8')), 'hex'),
           pg_catalog.jsonb_build_object('proposalId', b.id, 'was', b.was)
    FROM blanked b
    RETURNING 1
  )
  SELECT pg_catalog.count(*)::integer INTO v_n FROM logged;
  RETURN v_n;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.engage_proposal_erase_gone() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.engage_proposal_erase_gone() TO crove_tenant;
