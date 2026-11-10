-- SPDX-License-Identifier: AGPL-3.0-only
-- ADR-0049 clean-up (#2822, from the review of #2920): the sweeps purge a former member's Vy data only when their LATEST exit is recorded, and the definers enforce it,
-- not only the worker. Two functions restated in full (same signatures, owners and grants; the applied files are not edited):
--   member_vy_former_members_due(limit)   restated from 20261214000000: `recorded` now means the latest exit is recorded (below), not that some removal row exists.
--   member_vy_member_data_purge(org, user) restated from 20261128090000: it removes nothing unless the latest exit is recorded (before, it relied on the worker
--                                          skipping the unrecorded ones).
-- "The latest exit is recorded" = the user has a removal in the audit trail (kernel.member.remove, outcome ok, target the user) and the newest private Vy row of
-- theirs in the org (a result's created_at, a memory entry's created_at or updated_at) is not newer than the latest such removal. A user removed long ago, added
-- again and then gone without a recorded removal has Vy rows newer than their old removal: their latest exit is not recorded, so nothing is purged and the 30 days
-- have no date to count from. Rows older than the latest removal belong to the membership that removal ended, so the purge removes them. The check is inline in
-- both definers (no new function names the private rows, so the frozen list of the sinks invariant is unchanged). Idempotent.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.member_vy_former_members_due(p_limit integer)
RETURNS TABLE (org_id uuid, user_id uuid, recorded boolean) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') OR crove_kernel.ctx_actor_type() IS NOT NULL THEN
    RAISE EXCEPTION 'MEMBER_VY_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT f.org_id, f.user_id, f.recorded FROM (
      SELECT d.org_id, d.user_id,
        COALESCE((
          SELECT x.last_exit >= COALESCE((
              SELECT pg_catalog.max(n.t) FROM (
                SELECT pg_catalog.max(r.created_at) AS t FROM crove_kernel.member_vy_result r WHERE r.org_id = d.org_id AND r.member_user_id = d.user_id
                UNION ALL
                SELECT pg_catalog.max(GREATEST(m.created_at, m.updated_at)) FROM crove_kernel.member_vy_memory m WHERE m.org_id = d.org_id AND m.member_user_id = d.user_id) n),
              '-infinity'::timestamptz)
          FROM (
            SELECT pg_catalog.max(a.occurred_at) AS last_exit FROM crove_kernel.audit_event a
            WHERE a.org_id = d.org_id AND a.command = 'kernel.member.remove' AND a.outcome = 'ok' AND a.target_id = d.user_id) x
          WHERE x.last_exit IS NOT NULL), false) AS recorded
      FROM (
          SELECT x.org_id, x.member_user_id AS user_id FROM crove_kernel.member_vy_result x
          UNION
          SELECT y.org_id, y.member_user_id FROM crove_kernel.member_vy_memory y) AS d
      WHERE EXISTS (SELECT 1 FROM crove_kernel.tenant t WHERE t.org_id = d.org_id AND t.status IN ('active', 'offboarding'))
        AND NOT EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = d.org_id AND m.user_id = d.user_id)
        AND NOT EXISTS (
          SELECT 1 FROM crove_kernel.audit_event a
          WHERE a.org_id = d.org_id AND a.occurred_at > pg_catalog.now() - interval '30 days'
            AND a.command = 'kernel.member.remove' AND a.outcome = 'ok' AND a.target_id = d.user_id)) AS f
    ORDER BY f.recorded DESC, f.org_id, f.user_id LIMIT LEAST(GREATEST(p_limit, 1), 1000);
END $$;
REVOKE ALL ON FUNCTION crove_kernel.member_vy_former_members_due(integer) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.member_vy_former_members_due(integer) TO crove_worker;

CREATE OR REPLACE FUNCTION crove_kernel.member_vy_member_data_purge(p_org uuid, p_user uuid)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_last_exit timestamptz;
  v_newest timestamptz;
  v_n bigint;
  v_m bigint;
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'MEMBER_VY_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF v_org IS NULL OR v_org IS DISTINCT FROM p_org OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'system' THEN
    RAISE EXCEPTION 'MEMBER_VY_SYSTEM_CONTEXT' USING ERRCODE = '42501';
  END IF;
  -- A re-add of this user (crove_kernel.invite_accept) either committed before this and the check below sees it, or waits
  -- until this transaction ends.
  PERFORM crove_kernel.membership_lock(v_org, p_user);
  IF EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = v_org AND m.user_id = p_user) THEN
    RETURN 0;
  END IF;
  -- Nothing goes in the 30 days after the removal (the rule of crove_notes.member_items_purge).
  IF EXISTS (
    SELECT 1 FROM crove_kernel.audit_event a
    WHERE a.org_id = v_org AND a.occurred_at > pg_catalog.now() - interval '30 days'
      AND a.command = 'kernel.member.remove' AND a.outcome = 'ok' AND a.target_id = p_user
  ) THEN
    RETURN 0;
  END IF;
  -- The latest exit must be recorded: a removal in the audit trail, not older than the user's newest private Vy row. Otherwise the membership that made the
  -- rows ended with no record, there is no date to count the 30 days from, and nothing is removed.
  SELECT pg_catalog.max(a.occurred_at) INTO v_last_exit FROM crove_kernel.audit_event a
  WHERE a.org_id = v_org AND a.command = 'kernel.member.remove' AND a.outcome = 'ok' AND a.target_id = p_user;
  IF v_last_exit IS NULL THEN
    RETURN 0;
  END IF;
  SELECT pg_catalog.max(n.t) INTO v_newest FROM (
    SELECT pg_catalog.max(r.created_at) AS t FROM crove_kernel.member_vy_result r WHERE r.org_id = v_org AND r.member_user_id = p_user
    UNION ALL
    SELECT pg_catalog.max(GREATEST(m.created_at, m.updated_at)) FROM crove_kernel.member_vy_memory m WHERE m.org_id = v_org AND m.member_user_id = p_user) n;
  IF v_newest IS NOT NULL AND v_newest > v_last_exit THEN
    RETURN 0;
  END IF;
  DELETE FROM crove_kernel.member_vy_result r WHERE r.org_id = v_org AND r.member_user_id = p_user;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  DELETE FROM crove_kernel.member_vy_memory m WHERE m.org_id = v_org AND m.member_user_id = p_user;
  GET DIAGNOSTICS v_m = ROW_COUNT;
  RETURN v_n + v_m;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.member_vy_member_data_purge(uuid, uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.member_vy_member_data_purge(uuid, uuid) TO crove_worker;
