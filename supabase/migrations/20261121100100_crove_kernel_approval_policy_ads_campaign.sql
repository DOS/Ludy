-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove approval policy for the launch of a drafted campaign (issue #2295, ads W1, ADR-0043 point 1): ads.campaign.launch is an R3 financial proposal
-- command like the four that open the way to spend (20261118170100, 20261118170200): an owner or an admin approves, no approval permission,
-- four-eyes with the one-person path (P10), the approver judged on the members of the org now (live), and no ledger. Kept equal to approval.ts
-- (POLICIES, APPROVAL_POLICY_VERSION 4) by apps/kernel/test/invariant/proposal-approve-gate.db.test.ts.
--
-- crove_kernel.approval_command_policy  the policy table, with the new command in its ads list (the signature and OUT columns are unchanged).
-- crove_kernel.approval_command_live    which commands are judged on the members now (approval.ts, CommandPolicy.live): the ads commands that open
--                                       the way to spend and the launch of a drafted campaign. A later ads command is one line here.
-- crove_kernel.proposal_approval_decide the body of 20261118170200 (the newest) with the live list read from approval_command_live instead of
--                                       spelled out, and nothing else changed: its signature, owner, grants and every step it had.
-- Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.approval_command_policy(p_command text, OUT roles text[], OUT permission text, OUT four_eyes boolean, OUT ledger boolean)
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  WITH kind AS (
    SELECT p_command IN ('finance.purchase.record', 'finance.journal.reverse', 'finance.voucher.record',
                         'finance.journal_voucher.record', 'finance.closing.record', 'finance.depreciation.record') AS is_ledger,
           p_command IN ('ads.write.enable', 'ads.account.enable_write', 'ads.cap.set', 'ads.launches.unblock', 'ads.campaign.launch') AS is_ads
  )
  SELECT CASE WHEN k.is_ledger OR k.is_ads THEN ARRAY['owner', 'admin']::text[] ELSE ARRAY[]::text[] END,
         CASE WHEN k.is_ledger THEN 'finance.proposal.approve' END,
         true,
         k.is_ledger
  FROM kind k
$$;
REVOKE ALL ON FUNCTION crove_kernel.approval_command_policy(text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

CREATE OR REPLACE FUNCTION crove_kernel.approval_command_live(p_command text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT p_command IN ('ads.write.enable', 'ads.account.enable_write', 'ads.cap.set', 'ads.launches.unblock', 'ads.campaign.launch')
$$;
REVOKE ALL ON FUNCTION crove_kernel.approval_command_live(text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;


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
  -- P10 (and P09 with it).
  v_authors := ARRAY(SELECT a ->> 'id' FROM pg_catalog.jsonb_array_elements(p_authors) a WHERE a ->> 'type' = 'user');
  IF NOT (p_user::text = ANY (v_authors)) THEN
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
