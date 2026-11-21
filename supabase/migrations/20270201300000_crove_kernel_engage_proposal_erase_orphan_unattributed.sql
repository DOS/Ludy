-- SPDX-License-Identifier: AGPL-3.0-only
-- The orphan sweep of crove_kernel.engage_proposal_erase_gone() no longer names a person as the decider of a proposal it rejects (issue #4234, item 1, from the independent review of #4233).
-- The sweep takes no ids, so it also rejects a pending twin proposal whose payload names a conversation or a message the org never had (a coworker may name any id; such a proposal could never be approved). It set
-- `decided_by` to whoever ran the erasure, and the next person to erase any customer was recorded as the decider of a proposal about a thread they never touched. The database cannot tell, without ids, which orphan
-- this erasure deleted and which never had a target, so none of the swept proposals names a decider: `decided_by` stays NULL (a rejected proposal needs none; the retention purge already left it NULL). Who ran the
-- erasure stays in the audit row (`kernel.engage.proposal_erased`, `actor_id`), one per proposal blanked, as before. The body is otherwise the one of 20270128500000 (it is its newest definition on main): the
-- single changed statement is the `decided_by` assignment. Signature, owner, privileges and the id-taking stub are unchanged.
-- Idempotent (create or replace); applied files untouched.
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
