-- Crove kernel (issue #2611, ADR-0049 decision 10's screens): an owner invites someone with a department role, one pick
-- beside the base role, granted when the invite is accepted. Idempotent; applied files stay untouched.
--
-- crove_kernel.member_invite.role_key  NULL for an ordinary invite. Otherwise a role of the catalog with scope 'org'
--   (the composite foreign key to crove_kernel.role (key, role_scope) holds the scope: role_scope is 'org' exactly when a
--   role is named). The catalog is global (no org_id), so the key is not a tenant foreign key: it is not led by org_id
--   and needs no supporting index, as for role_assignment_role_fk. An invite names an entity scope (legal_entity_ids,
--   #1281, which is the external_accountant preset) or a department role, never both: an org-wide role given to a member
--   limited to some entities would lift them to every entity (ROLE_GRANT_WIDENS_SCOPE).
-- crove_kernel.role_assignment_check   the checks of role_assignment_grant, moved into one function so the invite
--   creation guard and invite_accept apply exactly the rules an owner's role.assign applies, never a copy: the role
--   exists, its scope fits the entity given, a viewer gets no role that grants a permission, an org-wide role never widens a
--   member limited to entities. Same refusal codes (P0001, the code as message). Called only from definers; callable by
--   nobody. role_assignment_grant is restated to call it and is otherwise unchanged.
-- member_invite_role_guard (BEFORE INSERT): a role invite is written only by an owner of the org in the sealed context,
--   as its inviter, and passes role_assignment_check for the base role it names. SECURITY DEFINER because the check
--   function has no grant for the tenant roles; search_path pinned; no EXECUTE for any login role.
-- member_invite_guard (restated): role_key never changes after insert, like everything else on an invite.
-- invite_accept (restated from 20261105140000): for an invite with a role, the invitee must be new (an invite never
--   changes an existing member's access: INVITE_ROLE_ALREADY_MEMBER), the inviter must still be an owner under the lock
--   invite_for_user holds on their row, and role_assignment_check must still pass; any failure refuses the whole accept
--   with INVITE_ROLE_STALE (never the base role alone). The assignment is written as the inviter, as in #1281. That a
--   module of the role is still installed is checked by the accept command (the database does not know the modules).
-- invite_peek (re-created with a role_key column, same arguments and grants): the invitee sees which role they get, never
--   what permissions it carries: the call is reachable before membership.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_kernel.member_invite ADD COLUMN IF NOT EXISTS role_key text;
ALTER TABLE crove_kernel.member_invite ADD COLUMN IF NOT EXISTS role_scope text
  GENERATED ALWAYS AS (CASE WHEN role_key IS NULL THEN NULL ELSE 'org' END) STORED;

DO $$
BEGIN
  ALTER TABLE crove_kernel.member_invite ADD CONSTRAINT member_invite_role_fk
    FOREIGN KEY (role_key, role_scope) REFERENCES crove_kernel.role (key, scope) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
ALTER TABLE crove_kernel.member_invite VALIDATE CONSTRAINT member_invite_role_fk;

DO $$
BEGIN
  ALTER TABLE crove_kernel.member_invite ADD CONSTRAINT member_invite_role_key_exclusive
    CHECK (role_key IS NULL OR legal_entity_ids IS NULL) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
ALTER TABLE crove_kernel.member_invite VALIDATE CONSTRAINT member_invite_role_key_exclusive;

-- ---------------------------------------------------------------------------
-- The checks of a role grant, in one place. p_member_role is the base role the grantee holds (or will hold);
-- p_user_id is NULL when there is no member yet (an invite being made).
-- ---------------------------------------------------------------------------
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
  IF p_member_role = 'viewer' AND EXISTS (SELECT 1 FROM crove_kernel.role_permission p WHERE p.role_key = p_role_key) THEN
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

-- Restated from 20261101060000_crove_kernel_roles.sql: the checks now come from role_assignment_check, the same order.
CREATE OR REPLACE FUNCTION crove_kernel.role_assignment_grant(p_user_id uuid, p_role_key text, p_legal_entity_id uuid)
RETURNS TABLE (assignment_id uuid, created boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_member_role text;
  v_id uuid;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  PERFORM crove_kernel.assert_role_manager();
  -- The member's row, locked as every membership change locks it: an approval reading their roles holds it FOR SHARE.
  SELECT m.role INTO v_member_role FROM crove_kernel.tenant_member m WHERE m.org_id = v_org AND m.user_id = p_user_id FOR UPDATE;
  IF v_member_role IS NULL THEN
    RAISE EXCEPTION 'ROLE_MEMBER_NOT_FOUND';
  END IF;
  PERFORM crove_kernel.role_assignment_check(v_org, p_user_id, v_member_role, p_role_key, p_legal_entity_id);
  INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by)
  VALUES (v_org, p_user_id, p_role_key, p_legal_entity_id, crove_kernel.ctx_user_id())
  ON CONFLICT ON CONSTRAINT role_assignment_uq DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NOT NULL THEN
    RETURN QUERY SELECT v_id, true;
    RETURN;
  END IF;
  RETURN QUERY
    SELECT a.id, false FROM crove_kernel.role_assignment a
    WHERE a.org_id = v_org AND a.user_id = p_user_id AND a.role_key = p_role_key
      AND a.legal_entity_id IS NOT DISTINCT FROM p_legal_entity_id;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.role_assignment_grant(uuid, text, uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.role_assignment_grant(uuid, text, uuid) TO crove_tenant;

-- ---------------------------------------------------------------------------
-- Who may write a role invite
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_kernel.member_invite_role_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.role_key IS NULL THEN
    RETURN NEW;
  END IF;
  IF crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user'
     OR crove_kernel.ctx_org_id() IS DISTINCT FROM NEW.org_id
     OR crove_kernel.ctx_user_id() IS DISTINCT FROM NEW.invited_by
     OR NOT EXISTS (
       SELECT 1 FROM crove_kernel.tenant_member m
       WHERE m.org_id = NEW.org_id AND m.user_id = NEW.invited_by AND m.role = 'owner'
     ) THEN
    RAISE EXCEPTION 'INVITE_ROLE_OWNER_ONLY' USING ERRCODE = '42501',
      DETAIL = 'only an owner of the org invites someone with a department role';
  END IF;
  PERFORM crove_kernel.role_assignment_check(NEW.org_id, NULL, NEW.role, NEW.role_key, NULL);
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS member_invite_role_guard ON crove_kernel.member_invite;
CREATE TRIGGER member_invite_role_guard BEFORE INSERT ON crove_kernel.member_invite
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.member_invite_role_guard();

-- Restated from 20261101231000_crove_kernel_scoped_invites.sql with the role added to what never changes.
CREATE OR REPLACE FUNCTION crove_kernel.member_invite_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF OLD.status <> 'pending'
     OR NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.email IS DISTINCT FROM OLD.email OR NEW.role IS DISTINCT FROM OLD.role
     OR NEW.token_sha256 IS DISTINCT FROM OLD.token_sha256 OR NEW.invited_by IS DISTINCT FROM OLD.invited_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.legal_entity_ids IS DISTINCT FROM OLD.legal_entity_ids
     OR NEW.role_key IS DISTINCT FROM OLD.role_key THEN
    RAISE EXCEPTION 'INVITE_IMMUTABLE' USING ERRCODE = '42501',
      DETAIL = 'an invite only moves once from pending to accepted or revoked';
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- Accepting: the role is granted by the rules of role.assign, or the accept is refused
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_kernel.invite_accept(p_user_id uuid, p_token text, p_upstream boolean)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_invite crove_kernel.member_invite := crove_kernel.invite_for_user(p_user_id, p_token, true, p_upstream);
  v_joined boolean := false;
BEGIN
  -- A purge of this user's items in the org (crove_notes.member_items_purge) either finished before this, or waits for
  -- it and then sees the membership.
  PERFORM crove_kernel.membership_lock(v_invite.org_id, p_user_id);
  INSERT INTO crove_kernel.tenant_member (org_id, user_id, role)
  VALUES (v_invite.org_id, p_user_id, v_invite.role)
  ON CONFLICT (org_id, user_id) DO NOTHING
  RETURNING true INTO v_joined;
  -- Removed from the org after the invite was made: it was revoked with the removal, or would have been (#1880).
  IF EXISTS (
    SELECT 1 FROM crove_kernel.audit_event a
    WHERE a.org_id = v_invite.org_id AND a.command = 'kernel.member.remove' AND a.outcome = 'ok'
      AND a.target_id = p_user_id AND a.occurred_at >= v_invite.created_at
  ) THEN
    RAISE EXCEPTION 'INVITE_REVOKED' USING ERRCODE = 'P0001';
  END IF;
  IF v_invite.legal_entity_ids IS NOT NULL AND NOT COALESCE(v_joined, false) THEN
    -- Already a member: a scope would change their access, which an invite never does. Nothing was written (the
    -- insert did nothing), and the exception rolls the statement back all the same.
    RAISE EXCEPTION 'INVITE_SCOPE_ALREADY_MEMBER' USING ERRCODE = 'P0001';
  END IF;
  IF v_invite.role_key IS NOT NULL AND NOT COALESCE(v_joined, false) THEN
    -- Likewise a department role: an invite never changes an existing member's access (#2611).
    RAISE EXCEPTION 'INVITE_ROLE_ALREADY_MEMBER' USING ERRCODE = 'P0001';
  END IF;
  IF v_invite.legal_entity_ids IS NOT NULL THEN
    -- invite_for_user holds the inviter's membership row FOR SHARE: a demotion that committed first is seen here.
    IF NOT EXISTS (
         SELECT 1 FROM crove_kernel.tenant_member m
         WHERE m.org_id = v_invite.org_id AND m.user_id = v_invite.invited_by AND m.role = 'owner')
       OR (SELECT pg_catalog.count(*) FROM crove_kernel.legal_entity e
           WHERE e.org_id = v_invite.org_id AND e.id = ANY (v_invite.legal_entity_ids)) <> pg_catalog.cardinality(v_invite.legal_entity_ids) THEN
      RAISE EXCEPTION 'INVITE_SCOPE_STALE' USING ERRCODE = 'P0001';
    END IF;
    INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by)
    SELECT v_invite.org_id, p_user_id, 'external_accountant', x, v_invite.invited_by
    FROM pg_catalog.unnest(v_invite.legal_entity_ids) x
    ON CONFLICT ON CONSTRAINT role_assignment_uq DO NOTHING;
  END IF;
  IF v_invite.role_key IS NOT NULL THEN
    -- The inviter must still own the org (their row is held FOR SHARE: a demotion that committed first is seen), and
    -- the role must still pass the rules of a grant. Otherwise the whole accept is refused: never the base role alone.
    IF NOT EXISTS (
      SELECT 1 FROM crove_kernel.tenant_member m
      WHERE m.org_id = v_invite.org_id AND m.user_id = v_invite.invited_by AND m.role = 'owner'
    ) THEN
      RAISE EXCEPTION 'INVITE_ROLE_STALE' USING ERRCODE = 'P0001';
    END IF;
    BEGIN
      PERFORM crove_kernel.role_assignment_check(v_invite.org_id, p_user_id, v_invite.role, v_invite.role_key, NULL);
    EXCEPTION WHEN SQLSTATE 'P0001' THEN
      RAISE EXCEPTION 'INVITE_ROLE_STALE' USING ERRCODE = 'P0001';
    END;
    INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by)
    VALUES (v_invite.org_id, p_user_id, v_invite.role_key, NULL, v_invite.invited_by)
    ON CONFLICT ON CONSTRAINT role_assignment_uq DO NOTHING;
  END IF;
  UPDATE crove_kernel.member_invite
  SET status = 'accepted', accepted_at = pg_catalog.now(), accepted_by = p_user_id
  WHERE org_id = v_invite.org_id AND id = v_invite.id;
  RETURN v_invite.org_id;
END $$;

-- ---------------------------------------------------------------------------
-- What the invitee sees: the role's key, never its permissions
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS crove_kernel.invite_peek(uuid, text, boolean);
CREATE FUNCTION crove_kernel.invite_peek(p_user_id uuid, p_token text, p_upstream boolean)
RETURNS TABLE (org_name text, role text, role_key text, invited_by_email text, invited_by_name text, expires_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_invite crove_kernel.member_invite := crove_kernel.invite_for_user(p_user_id, p_token, false, p_upstream);
BEGIN
  RETURN QUERY
  SELECT t.name, v_invite.role, v_invite.role_key, u.email, u.display_name, v_invite.expires_at
  FROM crove_kernel.tenant t
  JOIN crove_kernel.user_account u ON u.id = v_invite.invited_by
  WHERE t.org_id = v_invite.org_id;
END $$;

-- ---------------------------------------------------------------------------
-- EXECUTE matrix: the guards and the check callable by nobody; invite_accept and invite_peek only by the API login role.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION crove_kernel.member_invite_role_guard(), crove_kernel.member_invite_guard()
FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
REVOKE ALL ON FUNCTION crove_kernel.invite_accept(uuid, text, boolean), crove_kernel.invite_peek(uuid, text, boolean)
FROM PUBLIC, crove_tenant, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.invite_accept(uuid, text, boolean), crove_kernel.invite_peek(uuid, text, boolean) TO crove_app;
