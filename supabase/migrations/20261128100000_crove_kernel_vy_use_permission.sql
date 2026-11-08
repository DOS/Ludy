-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove kernel (issue #2781, ADR-0049 decision 10, slice 2 of 4 of #2755): the permission vy.use, "Làm việc với Vy" / "Work with Vy",
-- in the role model. Idempotent; applied files stay untouched.
--   permission_catalog           which permissions a viewer may hold (grantable_to_viewer); vy.use is the only one.
--   permission_default           what a base role holds by default: owner, admin and member hold vy.use, a viewer does not.
--   role_permission              the presets of the role catalog that grant it: finance.chief_accountant, finance.accountant,
--                                external_accountant, crm.sales, desk.agent, hr.manager (not finance.viewer).
--   member_permission_override   one person's exception, allowed or denied (behind "Nang cao" on the member row); written only
--                                through member_permission_set, which the command kernel.member.permission.set calls.
--   member_has_permission        the one resolution; ctx_has_permission calls it for a user context.
--   role_assignment_check        a viewer may be given a role whose permissions are all grantable to a viewer.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_kernel.permission_catalog (
  permission text PRIMARY KEY CHECK (permission ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  grantable_to_viewer boolean NOT NULL DEFAULT false,
  -- Whether a role assignment for one legal entity counts for it (the permission has no entity meaning).
  entity_roles_count boolean NOT NULL DEFAULT false
);
REVOKE ALL ON crove_kernel.permission_catalog FROM PUBLIC;
GRANT SELECT ON crove_kernel.permission_catalog TO crove_tenant;
SELECT crove_kernel.agent_write_guard_install('crove_kernel.permission_catalog');
INSERT INTO crove_kernel.permission_catalog (permission, grantable_to_viewer, entity_roles_count) VALUES ('vy.use', true, true) ON CONFLICT (permission) DO NOTHING;

CREATE TABLE IF NOT EXISTS crove_kernel.permission_default (
  base_role text NOT NULL CHECK (base_role IN ('owner', 'admin', 'member', 'viewer')),
  permission text NOT NULL REFERENCES crove_kernel.permission_catalog (permission),
  PRIMARY KEY (base_role, permission)
);
REVOKE ALL ON crove_kernel.permission_default FROM PUBLIC;
GRANT SELECT ON crove_kernel.permission_default TO crove_tenant;
SELECT crove_kernel.agent_write_guard_install('crove_kernel.permission_default');
INSERT INTO crove_kernel.permission_default (base_role, permission) VALUES ('owner', 'vy.use'), ('admin', 'vy.use'), ('member', 'vy.use') ON CONFLICT DO NOTHING;

INSERT INTO crove_kernel.role_permission (role_key, permission) VALUES
  ('finance.chief_accountant', 'vy.use'), ('finance.accountant', 'vy.use'), ('external_accountant', 'vy.use'),
  ('crm.sales', 'vy.use'), ('desk.agent', 'vy.use'), ('hr.manager', 'vy.use')
ON CONFLICT (role_key, permission) DO NOTHING;

-- The check of a role grant, with the viewer rule narrowed (restated from 20261123010000; every other line is as it was).
CREATE OR REPLACE FUNCTION crove_kernel.role_assignment_check(p_org uuid, p_user_id uuid, p_member_role text, p_role_key text, p_legal_entity_id uuid)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_scope text;
BEGIN
  SELECT r.scope INTO v_scope FROM crove_kernel.role r WHERE r.key = p_role_key;
  IF v_scope IS NULL THEN
    RAISE EXCEPTION 'ROLE_NOT_FOUND';
  END IF;
  IF v_scope = 'legal_entity' AND p_legal_entity_id IS NULL THEN
    RAISE EXCEPTION 'ROLE_SCOPE_REQUIRED';
  END IF;
  IF v_scope = 'org' AND p_legal_entity_id IS NOT NULL THEN
    RAISE EXCEPTION 'ROLE_SCOPE_NOT_ALLOWED';
  END IF;
  IF p_legal_entity_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM crove_kernel.legal_entity e WHERE e.org_id = p_org AND e.id = p_legal_entity_id) THEN
      RAISE EXCEPTION 'ROLE_LEGAL_ENTITY_NOT_FOUND';
    END IF;
    IF p_member_role IN ('owner', 'admin') THEN
      RAISE EXCEPTION 'ROLE_SCOPE_NOT_FOR_ADMINS';
    END IF;
  END IF;
  -- A viewer gets no role that grants a permission, unless every permission it grants is marked grantable_to_viewer
  -- (vy.use, ADR-0049 decision 10): otherwise every preset, each of which now grants vy.use, could not be given to one.
  IF p_member_role = 'viewer' AND EXISTS (
    SELECT 1 FROM crove_kernel.role_permission p
    LEFT JOIN crove_kernel.permission_catalog c ON c.permission = p.permission
    WHERE p.role_key = p_role_key AND COALESCE(c.grantable_to_viewer, false) = false) THEN
    RAISE EXCEPTION 'ROLE_PRIVILEGED_FOR_VIEWER';
  END IF;
  IF p_legal_entity_id IS NULL AND p_member_role NOT IN ('owner', 'admin')
     AND EXISTS (SELECT 1 FROM crove_kernel.role_assignment a
                 WHERE a.org_id = p_org AND a.user_id = p_user_id AND a.legal_entity_id IS NOT NULL)
     AND NOT EXISTS (SELECT 1 FROM crove_kernel.role_assignment a
                     WHERE a.org_id = p_org AND a.user_id = p_user_id AND a.legal_entity_id IS NULL) THEN
    RAISE EXCEPTION 'ROLE_GRANT_WIDENS_SCOPE';
  END IF;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.role_assignment_check(uuid, uuid, text, text, uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- One person's exception. Only vy.use may be set: a grant of any other permission is not a thing the screens offer.
CREATE TABLE IF NOT EXISTS crove_kernel.member_permission_override (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  user_id uuid NOT NULL,
  permission text NOT NULL CHECK (permission = 'vy.use'),
  allowed boolean NOT NULL,
  set_by uuid NOT NULL,
  -- Whether the setter was an owner when they wrote it: the protection from an admin outlives a later demotion or removal of that owner.
  set_by_owner boolean NOT NULL DEFAULT false,
  set_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT member_permission_override_uq UNIQUE (org_id, user_id, permission),
  FOREIGN KEY (org_id, user_id) REFERENCES crove_kernel.tenant_member (org_id, user_id) ON DELETE CASCADE
);
SELECT crove_kernel.apply_tenant_rls('crove_kernel.member_permission_override');
-- Tenant roles only read the table; member_permission_set writes it.
REVOKE INSERT, UPDATE, DELETE ON crove_kernel.member_permission_override FROM crove_tenant;
-- Read by the person it names, by owners and admins, and by the system context (the export, a sweep): flags, not text.
-- An org-chart agent context reads none.
DROP POLICY IF EXISTS own_or_manager ON crove_kernel.member_permission_override;
CREATE POLICY own_or_manager ON crove_kernel.member_permission_override AS RESTRICTIVE FOR SELECT TO crove_tenant
  USING (
    (SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR ((SELECT crove_kernel.ctx_actor_type()) = 'user'
        AND (user_id = (SELECT crove_kernel.ctx_user_id())
             OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m
                        WHERE m.org_id = member_permission_override.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin')))));

-- The one resolution (ADR-0049 decision 10): a deny wins; a grant, a base-role default or a role the person holds says yes. A
-- viewer honours a grant or a role only for a permission marked grantable_to_viewer. A role assignment counts, org-wide or for
-- one legal entity, only for such a permission (vy.use has no entity meaning); every other permission counts org-wide
-- assignments only, as before. SECURITY INVOKER: a tenant role reads its own org's rows through RLS; a definer that calls it
-- reads as its owner, filtered by the arguments.
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
  IF current_user = session_user
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

-- ctx_has_permission: a user context asks the one resolution about itself; every other actor, and no context, holds none.
CREATE OR REPLACE FUNCTION crove_kernel.ctx_has_permission(p_permission text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE WHEN crove_kernel.ctx_actor_type() = 'user'
              THEN COALESCE(crove_kernel.member_has_permission(crove_kernel.ctx_org_id(), crove_kernel.ctx_user_id(), p_permission), false)
              ELSE false END
$$;
REVOKE ALL ON FUNCTION crove_kernel.ctx_has_permission(text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.ctx_has_permission(text) TO crove_tenant;

-- Whether the user of the context may work with Vy: the gate the run commands and the buttons ask (ADR-0049 decision 10).
CREATE OR REPLACE FUNCTION crove_kernel.ctx_vy_use() RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT crove_kernel.ctx_has_permission('vy.use')
$$;
REVOKE ALL ON FUNCTION crove_kernel.ctx_vy_use() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.ctx_vy_use() TO crove_tenant;

-- Sets (p_allowed true or false) or clears (NULL) the exception of p_user in the org in context. Who may: an owner for anyone;
-- an admin for other admins, members and viewers, never for an owner, themselves, or a row an owner set; nobody else, and nobody who is not a member of the org.
-- Refusals (P0001): PERMISSION_UNKNOWN, PERMISSION_MANAGE_FORBIDDEN, PERMISSION_MEMBER_NOT_FOUND. Returns whether anything changed.
CREATE OR REPLACE FUNCTION crove_kernel.member_permission_set(p_user uuid, p_permission text, p_allowed boolean) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_actor uuid := crove_kernel.ctx_user_id();
  v_actor_role text;
  v_target_role text;
  v_old boolean;
  v_set_by uuid;
  v_set_by_owner boolean;
  v_n integer;
BEGIN
  IF v_org IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  IF p_permission IS DISTINCT FROM 'vy.use' THEN
    RAISE EXCEPTION 'PERMISSION_UNKNOWN';
  END IF;
  -- Refused before any lock when the actor is no manager, so a plain member cannot hold locks on others' rows even for a moment.
  SELECT m.role INTO v_actor_role FROM crove_kernel.tenant_member m WHERE m.org_id = v_org AND m.user_id = v_actor;
  IF v_actor_role IS NULL OR v_actor_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'PERMISSION_MANAGE_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  -- Both rows are locked in one statement, in user id order, FOR NO KEY UPDATE: a demotion of the actor that runs meanwhile waits (so
  -- the role read below is the role at commit), and two setters of one person's exception run one after the other (an admin's
  -- write never replaces an owner's deny it did not see) without deadlocking on each other's rows. The foreign key's own share lock
  -- of the target's row stays compatible.
  PERFORM 1 FROM crove_kernel.tenant_member m WHERE m.org_id = v_org AND m.user_id IN (v_actor, p_user) ORDER BY m.user_id FOR NO KEY UPDATE;
  SELECT m.role INTO v_target_role FROM crove_kernel.tenant_member m WHERE m.org_id = v_org AND m.user_id = p_user;
  SELECT m.role INTO v_actor_role FROM crove_kernel.tenant_member m WHERE m.org_id = v_org AND m.user_id = v_actor;
  IF v_actor_role IS NULL OR v_actor_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'PERMISSION_MANAGE_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF v_target_role IS NULL THEN
    RAISE EXCEPTION 'PERMISSION_MEMBER_NOT_FOUND';
  END IF;
  -- An admin never changes an owner's exception, nor their own, nor one an owner set.
  IF v_actor_role = 'admin' AND (v_target_role = 'owner' OR p_user = v_actor) THEN
    RAISE EXCEPTION 'PERMISSION_MANAGE_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  SELECT o.allowed, o.set_by, o.set_by_owner INTO v_old, v_set_by, v_set_by_owner FROM crove_kernel.member_permission_override o WHERE o.org_id = v_org AND o.user_id = p_user AND o.permission = p_permission;
  IF v_actor_role = 'admin' AND COALESCE(v_set_by_owner, false) THEN
    RAISE EXCEPTION 'PERMISSION_MANAGE_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_allowed IS NULL THEN
    DELETE FROM crove_kernel.member_permission_override o WHERE o.org_id = v_org AND o.user_id = p_user AND o.permission = p_permission;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RETURN v_n > 0;
  END IF;
  INSERT INTO crove_kernel.member_permission_override (org_id, user_id, permission, allowed, set_by, set_by_owner)
  VALUES (v_org, p_user, p_permission, p_allowed, v_actor, v_actor_role = 'owner')
  ON CONFLICT ON CONSTRAINT member_permission_override_uq DO UPDATE
    SET allowed = EXCLUDED.allowed, set_by = EXCLUDED.set_by, set_by_owner = EXCLUDED.set_by_owner, set_at = pg_catalog.now();
  -- A change is the value, or whose exception it is (an owner repeating an admin's grant takes it over).
  RETURN v_old IS DISTINCT FROM p_allowed OR v_set_by IS DISTINCT FROM v_actor;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.member_permission_set(uuid, text, boolean) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.member_permission_set(uuid, text, boolean) TO crove_tenant;
