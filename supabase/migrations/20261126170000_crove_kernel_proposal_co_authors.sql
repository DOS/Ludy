-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove kernel (issue #2736, findings F3 of the security review of #2731 and F1 to F6 of the security review of #2744): a proposal's preparer can declare co-authors, who are held back in
-- four-eyes (P10) like an author but never grant anything. Idempotent; applied files stay untouched.
--
-- Why: the person who approved and froze a pay run should not also approve its posting while somebody else may. A proposal's authors are the requester alone, and the insert guard
-- (proposal_status_guard, 20261105030000) refuses any other author on a user's new pending proposal, so that rule stays as it is. The people a proposal rests on besides its requester go in
-- a column of their own instead, and they only ever restrict:
--   * the owner override and the one-person path are judged on the written authors alone, so a co-author list (declared, or forged in raw SQL in the caller's own context) cannot unlock them;
--   * a co-author who wrote nothing may approve only when no eligible approver exists who is neither an author nor a co-author (so an org of an owner and one admin keeps working: the admin
--     who approved the run approves the posting the owner asked for), and never under a preset that reserves the ledger to the chief accountant (an author is held to the same there: if the
--     only holder of the approval permission froze the run, nobody can approve its posting; reject it, add a second approver and ask again).
--
-- crove_kernel.proposal.co_authors   user ids, set when kernel.proposal.request inserts the proposal from what the command's preparer declares (never from the client). Null for every proposal
--                                    but the ones below. Frozen once the row exists (a new proposal gets its own).
-- proposal_co_authors_guard          only a user's new pending proposal of a command in the list below may carry co-authors: a one-dimensional array of one to ten RFC 9562 uuids (the pattern
--                                    proposal_approval_decide holds authors to), none null. The system context (the worker, an agent's proposal) and every other command may not. Any change of the
--                                    column later is refused. Staff roles (the table owner, a superuser) pass, as in proposal_status_guard. The list: finance.payroll_posting.record, kept equal to
--                                    PROPOSAL_CO_AUTHOR_COMMANDS in packages/kernel/src/approval.ts by the invariant proposal-co-authors.
-- proposal_approval_decide           the body of 20261121130000 (the newest definition) with the co-authors read as 'co_author' entries of the authors it is given: well-formed like a user entry,
--                                    never counted as a written author, and judged as above. Kept equal to decideApproval by the invariant proposal-co-authors, case by case.
-- proposal_approve                   the body of 20261104150000 (the newest definition) with the proposal's co_authors added to the authors it hands to proposal_approval_decide as 'co_author' entries.
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
       OR pg_catalog.array_ndims(NEW.co_authors) IS DISTINCT FROM 1
       OR pg_catalog.cardinality(NEW.co_authors) NOT BETWEEN 1 AND 10
       OR pg_catalog.array_position(NEW.co_authors, NULL) IS NOT NULL
       -- An id zod's z.uuid() refuses (not RFC 9562) is refused here too, as proposal_approval_decide reads authors; a null one is refused above.
       OR EXISTS (SELECT 1 FROM pg_catalog.unnest(NEW.co_authors) AS c WHERE c::text !~ '^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$') THEN
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

CREATE OR REPLACE FUNCTION crove_kernel.proposal_approval_decide(
  p_org uuid, p_command text, p_status text, p_snapshot uuid[], p_authors jsonb, p_user uuid, p_lock boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_policy record;
  v_roles text[];
  v_preset text;
  v_version integer;
  v_ledger_only boolean;
  -- The user authors' ids as written, compared as text the way approval.ts compares them (an id in capitals is not
  -- its lower-case user).
  v_authors text[];
  v_co_authors text[];
  v_eligible uuid[];
  v_role text;
  -- The ads commands that open the way to spend are judged on the members of the org now, not on the snapshot taken when
  -- the proposal was made (approval.ts, CommandPolicy.live).
  v_live boolean := crove_kernel.approval_command_live(p_command);
BEGIN
  SELECT t.approval_preset, t.approval_policy_version, ap.ledger_chief_accountant_only INTO v_preset, v_version, v_ledger_only
  FROM crove_kernel.tenant t JOIN crove_kernel.approval_preset ap ON ap.key = t.approval_preset
  WHERE t.org_id = p_org;
  -- No tenant row: read as the strictest preset (approval.ts orgApprovalPolicy).
  IF NOT FOUND THEN
    v_preset := 'accountant';
    v_version := 0;
    v_ledger_only := true;
  END IF;
  IF p_status IS DISTINCT FROM 'pending' THEN
    RETURN pg_catalog.jsonb_build_object('reason', 'not_pending', 'eligibleCount', 0, 'selfApproved', false, 'fourEyes', 'pass', 'preset', v_preset, 'version', v_version);
  END IF;
  -- A pending proposal without a recorded snapshot or well-formed authors (as parseAuthors) cannot be judged.
  IF p_user IS NULL OR (NOT v_live AND pg_catalog.cardinality(coalesce(p_snapshot, ARRAY[]::uuid[])) = 0) OR p_authors IS NULL
     OR pg_catalog.jsonb_typeof(p_authors) <> 'array'
     OR EXISTS (
       SELECT 1 FROM pg_catalog.jsonb_array_elements(p_authors) a
       -- IS NOT TRUE: a missing field makes the test NULL, which counts as malformed (zod's z.uuid() pattern, case as it).
       WHERE (pg_catalog.jsonb_typeof(a) = 'object' AND (
         (a ->> 'type' = 'user' AND pg_catalog.jsonb_typeof(a -> 'id') = 'string' AND a ->> 'id' ~ '^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$')
         OR (a ->> 'type' = 'co_author' AND pg_catalog.jsonb_typeof(a -> 'id') = 'string' AND a ->> 'id' ~ '^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$')
         OR (a ->> 'type' = 'system' AND pg_catalog.jsonb_typeof(a -> 'component') = 'string')
         OR (a ->> 'type' = 'agent' AND pg_catalog.jsonb_typeof(a -> 'id') = 'string' AND a ->> 'id' ~ '^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$'
             AND pg_catalog.jsonb_typeof(a -> 'run') = 'string' AND a ->> 'run' ~ '^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$'))) IS NOT TRUE) THEN
    RETURN pg_catalog.jsonb_build_object('reason', 'not_eligible', 'eligibleCount', 0, 'selfApproved', false, 'fourEyes', 'pass', 'preset', v_preset, 'version', v_version);
  END IF;
  -- The preset in force now (P09): a preset that reserves the ledger to the chief accountant leaves only the permission.
  SELECT * INTO v_policy FROM crove_kernel.approval_command_policy(p_command);
  v_roles := CASE WHEN v_policy.ledger AND v_ledger_only THEN ARRAY[]::text[] ELSE v_policy.roles END;
  IF pg_catalog.cardinality(v_roles) = 0 AND v_policy.permission IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('reason', 'not_eligible', 'eligibleCount', 0, 'selfApproved', false, 'fourEyes', 'pass', 'preset', v_preset, 'version', v_version);
  END IF;
  -- P12: the snapshot members still holding an approving base role or the permission org-wide (a viewer holds none),
  -- their rows locked first when asked.
  IF p_lock THEN
    PERFORM 1 FROM crove_kernel.tenant_member m WHERE m.org_id = p_org AND (v_live OR m.user_id = ANY (p_snapshot)) ORDER BY m.user_id FOR SHARE;
  END IF;
  v_eligible := ARRAY(
    SELECT m.user_id FROM crove_kernel.tenant_member m
    WHERE m.org_id = p_org AND (v_live OR m.user_id = ANY (p_snapshot))
      AND (m.role = ANY (v_roles)
           OR (v_policy.permission = 'finance.proposal.approve' AND m.role <> 'viewer' AND EXISTS (
                 SELECT 1 FROM crove_kernel.role_assignment a JOIN crove_kernel.role_permission rp ON rp.role_key = a.role_key
                 WHERE a.org_id = m.org_id AND a.user_id = m.user_id AND a.legal_entity_id IS NULL AND rp.permission = 'finance.proposal.approve')))
    ORDER BY m.user_id);
  IF NOT (p_user = ANY (v_eligible)) THEN
    RETURN pg_catalog.jsonb_build_object('reason', 'not_eligible', 'eligibleCount', pg_catalog.cardinality(v_eligible), 'selfApproved', false, 'fourEyes', 'pass', 'preset', v_preset, 'version', v_version);
  END IF;
  -- P10 (and P09 with it). The written authors are the 'user' entries; the co-authors (#2736) are the 'co_author' entries proposal_approve adds from the proposal's co_authors column.
  v_authors := ARRAY(SELECT a ->> 'id' FROM pg_catalog.jsonb_array_elements(p_authors) a WHERE a ->> 'type' = 'user');
  v_co_authors := ARRAY(SELECT a ->> 'id' FROM pg_catalog.jsonb_array_elements(p_authors) a WHERE a ->> 'type' = 'co_author');
  IF NOT (p_user::text = ANY (v_authors)) THEN
    -- A co-author who wrote nothing is held back only while another eligible approver exists who is neither an author nor a co-author. Co-authors never grant: the owner override and the one-person
    -- path below are judged on the written authors alone, so a co-author list (declared, or forged in raw SQL) can only make approval harder for the people on it, never easier for anybody else.
    IF p_user::text = ANY (v_co_authors) THEN
      -- The accountant preset reserves the ledger to the chief accountant, and an author never approves a ledger proposal there; a co-author is held to the same: if the only holder of the approval
      -- permission froze the run, nobody can approve its posting (it is rejected and asked for again once a second approver exists).
      IF v_policy.ledger AND v_ledger_only THEN
        RETURN pg_catalog.jsonb_build_object('reason', 'four_eyes', 'eligibleCount', pg_catalog.cardinality(v_eligible), 'selfApproved', false, 'fourEyes', 'pass', 'preset', v_preset, 'version', v_version);
      END IF;
      IF v_policy.four_eyes AND EXISTS (SELECT 1 FROM pg_catalog.unnest(v_eligible) e WHERE e::text <> ALL (v_authors) AND e::text <> ALL (v_co_authors)) THEN
        RETURN pg_catalog.jsonb_build_object('reason', 'four_eyes', 'eligibleCount', pg_catalog.cardinality(v_eligible), 'selfApproved', false, 'fourEyes', 'pass', 'preset', v_preset, 'version', v_version);
      END IF;
    END IF;
    RETURN pg_catalog.jsonb_build_object('reason', 'ok', 'eligibleCount', pg_catalog.cardinality(v_eligible), 'selfApproved', false, 'fourEyes', 'pass', 'preset', v_preset, 'version', v_version);
  END IF;
  IF v_policy.ledger AND v_ledger_only THEN
    RETURN pg_catalog.jsonb_build_object('reason', 'four_eyes', 'eligibleCount', pg_catalog.cardinality(v_eligible), 'selfApproved', false, 'fourEyes', 'pass', 'preset', v_preset, 'version', v_version);
  END IF;
  IF NOT v_policy.four_eyes OR pg_catalog.cardinality(v_eligible) < 2 THEN
    RETURN pg_catalog.jsonb_build_object('reason', 'ok', 'eligibleCount', pg_catalog.cardinality(v_eligible), 'selfApproved', true, 'fourEyes', 'self_approved', 'preset', v_preset, 'version', v_version);
  END IF;
  SELECT m.role INTO v_role FROM crove_kernel.tenant_member m WHERE m.org_id = p_org AND m.user_id = p_user;
  IF v_role = 'owner' AND ARRAY(SELECT e::text FROM pg_catalog.unnest(v_eligible) e) <@ v_authors THEN
    RETURN pg_catalog.jsonb_build_object('reason', 'ok', 'eligibleCount', pg_catalog.cardinality(v_eligible), 'selfApproved', true, 'fourEyes', 'owner_override', 'preset', v_preset, 'version', v_version);
  END IF;
  RETURN pg_catalog.jsonb_build_object('reason', 'four_eyes', 'eligibleCount', pg_catalog.cardinality(v_eligible), 'selfApproved', false, 'fourEyes', 'pass', 'preset', v_preset, 'version', v_version);
END $$;
REVOKE ALL ON FUNCTION crove_kernel.proposal_approval_decide(uuid, text, text, uuid[], jsonb, uuid, boolean) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

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
  -- The co-authors go to the decision as 'co_author' entries: held back like an author, never granting (see proposal_approval_decide). Authors that are not an array stay as they are, which the decision reads as malformed.
  v_authors := v_p.authors;
  IF v_p.co_authors IS NOT NULL AND pg_catalog.jsonb_typeof(v_p.authors) = 'array' THEN
    v_authors := v_p.authors || coalesce(
      (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('type', 'co_author', 'id', c::text)) FROM pg_catalog.unnest(v_p.co_authors) AS c),
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
