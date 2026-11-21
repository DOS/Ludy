-- SPDX-License-Identifier: AGPL-3.0-only
-- Erasing a thread blanks what an AI coworker proposed about it (epic #3857, E4 #3863), and now only after the thread is gone (review follow-ups of #4159, issue #4160: L3, L5 and the note on its definer).
-- 20270123510000 gave crove_kernel.engage_proposal_erase(conversations, messages): it took the ids the caller passed, so an owner or an admin could blank the proposals of a live thread by naming it, it wrote no
-- audit row, it left the `decision_note` of a decided proposal (a person typed it when rejecting, and it may quote the text), and the caller built both id arrays from the filter of a purge (large on a big one).
--   crove_kernel.engage_proposal_erase_gone()   for the org in context only, called by an owner or an admin (the erasing command) or the system (the retention purge), AFTER the thread and its messages were deleted.
--                        It takes no ids: it finds the proposals of the three twins (reply, private reply, hide) whose payload names a conversation or a message that no longer exists in the org (one NOT EXISTS
--                        each, no arrays), so it can only blank what has already lost its target; a live thread's proposals are never reachable by it. Each one found gets the payload `{"erased": true}`; a pending
--                        one is rejected (its thread is gone, so nothing could be sent) with a note and, for a person's erasure, who decided; the `decision_note` of a decided one is replaced by `erased` (the note a
--                        person typed may quote the text); nothing else of the row changes (its authors and approvers stay as evidence). One audit row per proposal blanked (`kernel.engage.proposal_erased`, the
--                        proposal's id, its state before and nothing of its content). Answers how many it blanked. A proposal that names an id the org never had is blanked too: it could never be approved anyway.
-- The old function with ids stays as a stub that refuses (a drop is a contract change for a later migration): the erasing code in the same release calls the new one after its deletes, and an old process calling the stub during the deploy fails and rolls its erasure back, to be run again.
-- Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

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
      AND p.command IN ('kernel.conversation.reply_approved', 'kernel.conversation.reply_privately_approved', 'kernel.conversation.hide_approved')
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
        decided_by = CASE WHEN p.status = 'pending' THEN v_user ELSE p.decided_by END,
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

-- The old function keeps its signature (dropping it is a contract change for a later migration, once no code calls it) but does nothing now: it refuses, so a process of the previous release that still calls it
-- fails its erasure and rolls it back, to be run again by the new code. It never blanks a proposal on the ids a caller passes.
CREATE OR REPLACE FUNCTION crove_kernel.engage_proposal_erase(p_conversations uuid[], p_messages uuid[]) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'ENGAGE_ERASE_MOVED' USING ERRCODE = '0A000', HINT = 'call crove_kernel.engage_proposal_erase_gone() after the delete';
END $$;
REVOKE ALL ON FUNCTION crove_kernel.engage_proposal_erase(uuid[], uuid[]) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.engage_proposal_erase(uuid[], uuid[]) TO crove_tenant;
