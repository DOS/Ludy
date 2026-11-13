-- SPDX-License-Identifier: AGPL-3.0-only
-- ADR-0049 clean-up, part 1 (#2822): two database rules the chain left open. Idempotent; applied files stay untouched.
--   ai_run_member_vy_bind   the 4-hour bound of a member_vy run now also holds when expires_at or started_at is updated (the trigger fired
--                           only on agent_id, so an UPDATE of expires_at could stretch a run past it). Restated from 20261128090000.
--   member_has_permission   the guard that limits a tenant login to answers about itself (or as a manager or the system) now also applies
--                           after SET ROLE crove_tenant, where current_user is crove_tenant but session_user is still the login: it
--                           was skipped there, and RLS then hid an owner-set deny, so the answer about another member read as the default.
--                           A definer (its owner is another role) and a superuser stay unaffected. Restated from 20261128100000.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.ai_run_member_vy_bind() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_member uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.agent_id IS DISTINCT FROM OLD.agent_id THEN
      RAISE EXCEPTION 'MEMBER_VY_RUN_BINDING' USING ERRCODE = '42501';
    END IF;
    -- A member_vy run keeps the 4-hour bound counted from its ORIGINAL start: the start never moves, and the expiry never goes past it plus 4
    -- hours (moving both timestamps forward would otherwise stretch the run).
    IF (NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.started_at IS DISTINCT FROM OLD.started_at)
       AND EXISTS (SELECT 1 FROM crove_kernel.agent a WHERE a.org_id = NEW.org_id AND a.id = NEW.agent_id AND a.kind = 'member_vy')
       AND (NEW.started_at IS DISTINCT FROM OLD.started_at OR NEW.expires_at > OLD.started_at + interval '4 hours') THEN
      RAISE EXCEPTION 'MEMBER_VY_RUN_EXPIRY' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT a.member_user_id INTO v_member FROM crove_kernel.agent a
  WHERE a.org_id = NEW.org_id AND a.id = NEW.agent_id AND a.kind = 'member_vy';
  IF v_member IS NOT NULL THEN
    IF crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' OR crove_kernel.ctx_org_id() IS DISTINCT FROM NEW.org_id
       OR v_member IS DISTINCT FROM crove_kernel.ctx_user_id() THEN
      RAISE EXCEPTION 'MEMBER_VY_RUN_BINDING' USING ERRCODE = '42501';
    END IF;
    IF NEW.expires_at > NEW.started_at + interval '4 hours' THEN
      RAISE EXCEPTION 'MEMBER_VY_RUN_EXPIRY' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.ai_run_member_vy_bind() FROM PUBLIC;

DROP TRIGGER IF EXISTS member_vy_bind ON crove_kernel.ai_run;
CREATE TRIGGER member_vy_bind BEFORE INSERT OR UPDATE OF agent_id, started_at, expires_at ON crove_kernel.ai_run
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.ai_run_member_vy_bind();

CREATE OR REPLACE FUNCTION crove_kernel.member_has_permission(p_org uuid, p_user uuid, p_permission text) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_role text;
  v_grantable boolean;
  v_entity_roles boolean;
  v_override boolean;
BEGIN
  -- Row-level security hides some override and assignment rows from some callers, so a tenant login asking about someone
  -- else would get another answer than the definer or the system gets. A tenant login that calls this directly therefore
  -- gets an answer only about itself, as an owner or admin, or as the system context; a definer (its owner is not the
  -- session user) and a superuser read every row and are unaffected.
  IF (current_user = session_user OR current_user = 'crove_tenant')
     AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = current_user AND r.rolsuper)
     AND pg_catalog.pg_has_role(current_user, 'crove_tenant', 'MEMBER') THEN
    IF NOT COALESCE(
      crove_kernel.ctx_actor_type() = 'system'
      OR (crove_kernel.ctx_actor_type() = 'user' AND crove_kernel.ctx_org_id() IS NOT DISTINCT FROM p_org
          AND (p_user IS NOT DISTINCT FROM crove_kernel.ctx_user_id()
               OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m
                          WHERE m.org_id = p_org AND m.user_id = crove_kernel.ctx_user_id() AND m.role IN ('owner', 'admin'))))
    , false) THEN
      RAISE EXCEPTION 'PERMISSION_QUERY_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
  END IF;
  SELECT m.role INTO v_role FROM crove_kernel.tenant_member m WHERE m.org_id = p_org AND m.user_id = p_user;
  IF v_role IS NULL THEN
    RETURN false;
  END IF;
  SELECT COALESCE(c.grantable_to_viewer, false), COALESCE(c.entity_roles_count, false) INTO v_grantable, v_entity_roles
  FROM (SELECT 1) x LEFT JOIN crove_kernel.permission_catalog c ON c.permission = p_permission;
  SELECT o.allowed INTO v_override FROM crove_kernel.member_permission_override o
  WHERE o.org_id = p_org AND o.user_id = p_user AND o.permission = p_permission;
  IF v_override IS NOT NULL AND NOT v_override THEN
    RETURN false;
  END IF;
  -- A viewer holds no permission but one marked grantable_to_viewer, and only through a grant or a role.
  IF v_role = 'viewer' AND NOT v_grantable THEN
    RETURN false;
  END IF;
  IF v_override THEN
    RETURN true;
  END IF;
  IF v_role <> 'viewer' AND EXISTS (SELECT 1 FROM crove_kernel.permission_default d WHERE d.base_role = v_role AND d.permission = p_permission) THEN
    RETURN true;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM crove_kernel.role_assignment a
    JOIN crove_kernel.role_permission p ON p.role_key = a.role_key
    WHERE a.org_id = p_org AND a.user_id = p_user AND p.permission = p_permission
      AND (a.legal_entity_id IS NULL OR v_entity_roles));
END $$;
REVOKE ALL ON FUNCTION crove_kernel.member_has_permission(uuid, uuid, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.member_has_permission(uuid, uuid, text) TO crove_tenant;
