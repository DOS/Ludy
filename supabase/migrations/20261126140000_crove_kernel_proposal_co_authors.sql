-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove kernel (issue #2736, finding F3 of the security review of #2731): a proposal's preparer can declare co-authors, who count as authors in four-eyes (P10). Idempotent; applied files stay untouched.
--
-- Why: the person who approved and froze a pay run must not also approve its posting while somebody else may. A proposal's authors are the requester alone, and the insert guard
-- (proposal_status_guard, 20261105030000) refuses any other author on a user's new pending proposal, so that rule stays as it is. The people a proposal rests on besides its requester go in
-- a column of their own instead.
--
-- crove_kernel.proposal.co_authors   user ids, set when kernel.proposal.request inserts the proposal from what the command's preparer declares (never from the client). Null for every proposal
--                                    but the ones below. Frozen once the row exists (a new proposal gets its own).
-- proposal_co_authors_guard          only a user's new pending proposal of a command in the list below may carry co-authors (one to ten ids, none null); the system context (the worker, an
--                                    agent's proposal) and every other command may not. Any change of the column later is refused. Staff roles (the table owner, a superuser) pass, as in proposal_status_guard.
--                                    The list: finance.payroll_posting.record, kept equal to PROPOSAL_CO_AUTHOR_COMMANDS in packages/kernel/src/approval.ts by the invariant proposal-co-authors.
-- proposal_approve                   the body of 20261104150000 (the newest definition) with the co-authors added to the authors it hands to proposal_approval_decide, so the database gate counts them as
--                                    authors exactly as approval.ts does: none of them approves while another eligible approver exists; the one-person and owner-override paths behave as for the requester.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_kernel.proposal ADD COLUMN IF NOT EXISTS co_authors uuid[];

CREATE OR REPLACE FUNCTION crove_kernel.proposal_co_authors_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_staff boolean;
BEGIN
  SELECT r.rolsuper
         OR pg_catalog.pg_has_role(r.oid, (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID), 'USAGE')
         OR pg_catalog.pg_has_role(CURRENT_USER, (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID), 'USAGE')
    INTO v_staff
  FROM pg_catalog.pg_roles r WHERE r.rolname = SESSION_USER;
  IF COALESCE(v_staff, false) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.co_authors IS NULL THEN
      RETURN NEW;
    END IF;
    IF NEW.status IS DISTINCT FROM 'pending'
       OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user'
       OR NEW.command <> ALL (ARRAY['finance.payroll_posting.record'])
       OR pg_catalog.cardinality(NEW.co_authors) NOT BETWEEN 1 AND 10
       OR pg_catalog.array_position(NEW.co_authors, NULL) IS NOT NULL THEN
      RAISE EXCEPTION 'PROPOSAL_STATUS_TRANSITION' USING ERRCODE = '23514',
        DETAIL = pg_catalog.json_build_object('to', NEW.status, 'frozen', 'co_authors')::text;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.co_authors IS DISTINCT FROM OLD.co_authors THEN
    RAISE EXCEPTION 'PROPOSAL_STATUS_TRANSITION' USING ERRCODE = '23514',
      DETAIL = pg_catalog.json_build_object('from', OLD.status, 'frozen', 'co_authors')::text;
  END IF;
  RETURN NEW;
END $$;
-- A trigger function only; nobody calls it directly.
REVOKE ALL ON FUNCTION crove_kernel.proposal_co_authors_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- It fires before proposal_status_guard (by name); neither depends on the other.
DROP TRIGGER IF EXISTS proposal_co_authors_guard ON crove_kernel.proposal;
CREATE TRIGGER proposal_co_authors_guard BEFORE INSERT OR UPDATE ON crove_kernel.proposal
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.proposal_co_authors_guard();
-- Also in replica mode, where ordinary triggers stay silent.
ALTER TABLE crove_kernel.proposal ENABLE ALWAYS TRIGGER proposal_co_authors_guard;

CREATE OR REPLACE FUNCTION crove_kernel.proposal_approve(p_proposal_id uuid, p_revision integer, p_executed_command_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_user uuid := crove_kernel.ctx_user_id();
  v_scope text[] := crove_kernel.ctx_le_scope();
  v_p record;
  v_authors jsonb;
  v_decision jsonb;
BEGIN
  -- Only a user's context, and the user only from it (never a parameter).
  IF crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' OR v_user IS NULL OR v_org IS NULL OR p_executed_command_id IS NULL THEN
    RAISE EXCEPTION 'NOT_ELIGIBLE' USING ERRCODE = '42501';
  END IF;
  -- One of another org, none, or one of an entity outside the caller's scope: the same answer, and no lock on it.
  SELECT p.status, p.revision, p.command, p.eligible_approvers, p.authors, p.co_authors INTO v_p
  FROM crove_kernel.proposal p
  WHERE p.org_id = v_org AND p.id = p_proposal_id
    AND coalesce('*' = ANY (v_scope) OR p.legal_entity_id::text = ANY (v_scope), false)
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = '42501';
  END IF;
  IF v_p.status <> 'pending' THEN
    RAISE EXCEPTION 'PROPOSAL_DECIDED' USING ERRCODE = '42501';
  END IF;
  IF v_p.revision IS DISTINCT FROM p_revision THEN
    RAISE EXCEPTION 'STALE_REVISION' USING ERRCODE = '42501';
  END IF;
  -- The co-authors count as authors (P10): the same list approval.ts judges. Authors that are not an array stay as they are, which the decision reads as malformed.
  v_authors := v_p.authors;
  IF v_p.co_authors IS NOT NULL AND pg_catalog.jsonb_typeof(v_p.authors) = 'array' THEN
    v_authors := v_p.authors || coalesce(
      (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('type', 'user', 'id', c::text)) FROM pg_catalog.unnest(v_p.co_authors) AS c),
      '[]'::jsonb);
  END IF;
  v_decision := crove_kernel.proposal_approval_decide(v_org, v_p.command, v_p.status, v_p.eligible_approvers, v_authors, v_user, true);
  IF v_decision ->> 'reason' = 'four_eyes' THEN
    RAISE EXCEPTION 'FOUR_EYES_REQUIRED' USING ERRCODE = '42501';
  ELSIF v_decision ->> 'reason' <> 'ok' THEN
    RAISE EXCEPTION 'NOT_ELIGIBLE' USING ERRCODE = '42501';
  END IF;
  UPDATE crove_kernel.proposal
  SET status = 'approved', decided_by = v_user, decided_at = pg_catalog.now(), executed_command_id = p_executed_command_id
  WHERE org_id = v_org AND id = p_proposal_id;
  RETURN v_decision - 'reason';
END $$;
-- The API's login role only: the worker approves nothing as a user (an agent's approval runs as the system).
REVOKE ALL ON FUNCTION crove_kernel.proposal_approve(uuid, integer, uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.proposal_approve(uuid, integer, uuid) TO crove_app;
