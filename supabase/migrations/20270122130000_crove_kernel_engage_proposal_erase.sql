-- SPDX-License-Identifier: AGPL-3.0-only
-- What an AI coworker proposed to send into a customer's thread goes with the thread (epic #3857, E4 #3863; review finding of the change). The twins `kernel.conversation.reply_approved`, `reply_privately_approved` and
-- `hide_approved` keep the thread's or the message's id and, for a reply, the text in the proposal's payload. Erasing a customer or purging a thread past its retention (deleteThreads) deletes the thread, its messages and
-- the answer mails' text: the proposal's copy must go too, whether it still waits or was decided.
-- A decided proposal's row is frozen against the tenant (proposal_status_guard, 20261104070000), so the blanking is a definer owned by the table's owner, which that guard does not check:
--   crove_kernel.engage_proposal_erase(conversations, messages)  for the org in context only, called by an owner or an admin (the erasing command) or the system (the retention purge): every proposal of the three twins
--                        that names one of the threads or messages gets the payload `{"erased": true}`, and one still pending is rejected (its thread is gone, so nothing could be sent), with a note and, for a
--                        person's erasure, who decided. Nothing else of the row changes (its authors and approvers stay as evidence). Answers how many it blanked.
-- Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.engage_proposal_erase(p_conversations uuid[], p_messages uuid[]) RETURNS integer
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
  -- An owner or an admin (the erasure of a customer is theirs), or the system (the retention purge): nobody else, and never an MCP grant or an agent.
  IF NOT (v_actor = 'system'
          OR (v_actor = 'user' AND v_user IS NOT NULL AND crove_kernel.ctx_mcp_member_id() IS NULL
              AND EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = v_org AND m.user_id = v_user AND m.role IN ('owner', 'admin')))) THEN
    RAISE EXCEPTION 'ENGAGE_ERASE_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  UPDATE crove_kernel.proposal p
  SET payload = pg_catalog.jsonb_build_object('erased', true),
      status = CASE WHEN p.status = 'pending' THEN 'rejected' ELSE p.status END,
      decided_at = CASE WHEN p.status = 'pending' THEN pg_catalog.now() ELSE p.decided_at END,
      decided_by = CASE WHEN p.status = 'pending' THEN v_user ELSE p.decided_by END,
      decision_note = CASE WHEN p.status = 'pending' THEN 'conversation erased' ELSE p.decision_note END
  WHERE p.org_id = v_org
    AND p.command IN ('kernel.conversation.reply_approved', 'kernel.conversation.reply_privately_approved', 'kernel.conversation.hide_approved')
    AND p.payload IS DISTINCT FROM pg_catalog.jsonb_build_object('erased', true)
    AND (p.payload ->> 'conversationId' = ANY (SELECT x::text FROM pg_catalog.unnest(COALESCE(p_conversations, ARRAY[]::uuid[])) x)
      OR p.payload ->> 'messageId' = ANY (SELECT x::text FROM pg_catalog.unnest(COALESCE(p_messages, ARRAY[]::uuid[])) x));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.engage_proposal_erase(uuid[], uuid[]) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.engage_proposal_erase(uuid[], uuid[]) TO crove_tenant;
