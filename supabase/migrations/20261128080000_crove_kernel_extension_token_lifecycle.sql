-- SPDX-License-Identifier: AGPL-3.0-only
-- The Ludy extension token lifecycle (issue #2740, follow-up of #2582 / #2730). Idempotent; applied files stay untouched.
-- Step 2 of 2: step 1 (#2764) relaxed the invariant in extension-tokens.db.test.ts to accept both behaviours.
--
-- 1. A token is void for good, not suspended, when its member drops below member or the user is disabled:
--    triggers on tenant_member (role) and user_account (disabled_at) set revoked_at on the live tokens, so restoring the
--    role or re-enabling the user does not revive them. Removal already voided them (verify reads the membership live).
--    Each auto-revoke writes one audit row (command kernel.extension.token.auto_revoked), ids only: the token, its member
--    and the reason. Never the token, its hash or the device name. The row is written as the system; audit_event_stamp then
--    keeps that for a session with no org context (the operator's user-disable) and stamps the acting member when a member's
--    session in that org changes the role, so the row names who caused the revoke.
-- 2. Owner and admin revoke: revoke_extension_token_as_admin revokes any device in the org, except that an admin cannot
--    cut off an owner's; list_extension_tokens_for_org lists the org's devices (never a hash) for them. A member and a
--    viewer get EXTENSION_FORBIDDEN from both; revoke_extension_token still acts on the caller's own devices only.
-- 3. void_undelivered_extension_token: the exchange hands the token to the client only after its audit row is written; when
--    that fails, the API voids the row it just made (by the token's hash, while it was never used), so no usable token
--    row is left that nobody holds.
-- 4. exchange_extension_auth_code takes a row lock on the member and the user while it checks them, so a demotion or a
--    disable that runs at the same time cannot slip between the check and the new token: either the exchange sees the
--    demotion and refuses, or the demotion's trigger sees the new token and voids it.
-- 5. Removing a member voids their tokens too (an AFTER DELETE trigger), so removed members' devices show as revoked.
-- 6. One-time backfill (ext_device_backfill_suspended, run at the end of this file): until now a demotion or a disable only
--    suspended a member's tokens (revoked_at stayed null and verify read the role and the account live). The triggers fire
--    only on changes made from now on, so a token whose member is already a viewer or already disabled when this migration
--    runs is voided here, with its audit row, and does not come back when the role or the account is restored. Idempotent:
--    a second run finds nothing live to void. Removed members are not affected (a token older than the membership stays dead).
-- ext_device_system_revoke is the one routine that revokes and audits on the system's own behalf; the two triggers
-- call it. The ext_device_* routines and the trigger functions are callable by nobody (their names avoid
-- extension_token, which the invariant suite reads as "a function the API's login runs").
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- The audit row of a system revoke
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_kernel.ext_device_audit_revoke(p_org uuid, p_token uuid, p_user uuid, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  INSERT INTO crove_kernel.audit_event (org_id, actor_type, actor_id, command, command_id, outcome, target_type, target_id, input_sha256, detail)
  VALUES (p_org, 'system', NULL, 'kernel.extension.token.auto_revoked', crove_kernel.uuid_v7(), 'ok', 'extension_token', p_token,
          pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_token::text, 'UTF8')), 'hex'),
          pg_catalog.jsonb_build_object('tokenId', p_token, 'userId', p_user, 'reason', p_reason));
END $$;

-- Revokes the live tokens of a member (in one org, or in every org when p_org is null) and audits each one. Returns how many.
CREATE OR REPLACE FUNCTION crove_kernel.ext_device_system_revoke(p_org uuid, p_user uuid, p_reason text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  r record;
  v_n integer := 0;
BEGIN
  IF p_user IS NULL OR p_reason NOT IN ('role_change', 'user_disabled', 'member_removed') THEN
    RAISE EXCEPTION 'EXTENSION_INVALID' USING ERRCODE = '22023';
  END IF;
  FOR r IN
    WITH u AS (
      UPDATE crove_kernel.extension_token x SET revoked_at = pg_catalog.clock_timestamp()
      WHERE (p_org IS NULL OR x.org_id = p_org) AND x.user_id = p_user
        AND x.revoked_at IS NULL AND x.expires_at > pg_catalog.clock_timestamp()
        -- Only the tokens of an active org: those of an org that is offboarding or closed are refused already and the purge deletes
        -- them, and an audit row of such an org has no place to stand (the removal trigger skips it the same way).
        AND EXISTS (SELECT 1 FROM crove_kernel.tenant t WHERE t.org_id = x.org_id AND t.status = 'active')
      RETURNING x.org_id, x.id
    )
    SELECT u.org_id, u.id FROM u
  LOOP
    PERFORM crove_kernel.ext_device_audit_revoke(r.org_id, r.id, p_user, p_reason);
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END $$;

CREATE OR REPLACE FUNCTION crove_kernel.ext_device_member_demoted()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM crove_kernel.ext_device_system_revoke(NEW.org_id, NEW.user_id, 'role_change');
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS tenant_member_voids_extension_tokens ON crove_kernel.tenant_member;
CREATE TRIGGER tenant_member_voids_extension_tokens AFTER UPDATE OF role ON crove_kernel.tenant_member
  FOR EACH ROW WHEN (OLD.role IN ('owner', 'admin', 'member') AND NEW.role NOT IN ('owner', 'admin', 'member'))
  EXECUTE FUNCTION crove_kernel.ext_device_member_demoted();

CREATE OR REPLACE FUNCTION crove_kernel.ext_device_user_disabled()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM crove_kernel.ext_device_system_revoke(NULL, NEW.id, 'user_disabled');
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS user_account_voids_extension_tokens ON crove_kernel.user_account;
CREATE TRIGGER user_account_voids_extension_tokens AFTER UPDATE OF disabled_at ON crove_kernel.user_account
  FOR EACH ROW WHEN (OLD.disabled_at IS NULL AND NEW.disabled_at IS NOT NULL)
  EXECUTE FUNCTION crove_kernel.ext_device_user_disabled();

CREATE OR REPLACE FUNCTION crove_kernel.ext_device_member_removed()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  -- Nothing to do for an org that is gone (the delete cascades from the tenant) or no longer active (offboarding, closed:
  -- its tokens are refused already and the purge deletes them): an audit row of such an org has no place to stand.
  IF EXISTS (SELECT 1 FROM crove_kernel.tenant t WHERE t.org_id = OLD.org_id AND t.status = 'active') THEN
    PERFORM crove_kernel.ext_device_system_revoke(OLD.org_id, OLD.user_id, 'member_removed');
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS tenant_member_voids_extension_tokens_on_delete ON crove_kernel.tenant_member;
CREATE TRIGGER tenant_member_voids_extension_tokens_on_delete AFTER DELETE ON crove_kernel.tenant_member
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.ext_device_member_removed();

-- ---------------------------------------------------------------------------
-- Owner and admin: list and revoke a member's devices
-- ---------------------------------------------------------------------------
-- The caller must be an owner or admin of the org in context (EXTENSION_FORBIDDEN otherwise; NO_CONTEXT without a user context).
CREATE OR REPLACE FUNCTION crove_kernel.ext_device_caller_role()
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_user uuid := crove_kernel.ctx_user_id();
  v_role text;
BEGIN
  IF v_org IS NULL OR v_user IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  SELECT m.role INTO v_role
  FROM crove_kernel.tenant_member m
  JOIN crove_kernel.user_account u ON u.id = m.user_id AND u.disabled_at IS NULL
  WHERE m.org_id = v_org AND m.user_id = v_user AND m.role IN ('owner', 'admin');
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'EXTENSION_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN v_role;
END $$;

CREATE OR REPLACE FUNCTION crove_kernel.list_extension_tokens_for_org()
RETURNS TABLE (id uuid, user_id uuid, device_name text, scopes text[], created_at timestamptz, expires_at timestamptz, last_used_at timestamptz, revoked_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
BEGIN
  PERFORM crove_kernel.ext_device_caller_role();
  RETURN QUERY
  SELECT x.id, x.user_id, x.device_name, x.scopes, x.created_at, x.expires_at, x.last_used_at, x.revoked_at
  FROM crove_kernel.extension_token x
  WHERE x.org_id = v_org
    AND x.expires_at > pg_catalog.now() - interval '30 days'
    AND (x.revoked_at IS NULL OR x.revoked_at > pg_catalog.now() - interval '30 days')
  ORDER BY x.created_at DESC, x.id DESC
  LIMIT 200;
END $$;

-- Revokes one device of any member of the org in context. Answers the member's user id when it was live and is now revoked,
-- and null for any other case alike (unknown id, another org's device, already revoked, an owner's device when the caller is
-- an admin), so nothing tells them apart.
CREATE OR REPLACE FUNCTION crove_kernel.revoke_extension_token_as_admin(p_token_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_role text := crove_kernel.ext_device_caller_role();
  v_member uuid;
BEGIN
  UPDATE crove_kernel.extension_token x SET revoked_at = pg_catalog.clock_timestamp()
  WHERE x.org_id = v_org AND x.id = p_token_id AND x.revoked_at IS NULL
    AND (v_role = 'owner' OR NOT EXISTS (
      SELECT 1 FROM crove_kernel.tenant_member o WHERE o.org_id = x.org_id AND o.user_id = x.user_id AND o.role = 'owner'))
  RETURNING x.user_id INTO v_member;
  RETURN v_member;
END $$;

-- ---------------------------------------------------------------------------
-- An exchange whose audit failed leaves no usable token
-- ---------------------------------------------------------------------------
-- No member context: the caller proves it holds the token by its hash. Revokes that token while it has never been used (the
-- client only holds it from the exchange's answer, so an unused token is an undelivered or just delivered one) and tries to
-- audit it as a system revoke; a failed audit does not undo the revoke. true when a row was revoked.
CREATE OR REPLACE FUNCTION crove_kernel.void_undelivered_extension_token(p_token_hash bytea)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_org uuid;
  v_id uuid;
  v_user uuid;
BEGIN
  IF p_token_hash IS NULL OR pg_catalog.octet_length(p_token_hash) <> 32 THEN
    RETURN false;
  END IF;
  UPDATE crove_kernel.extension_token x SET revoked_at = pg_catalog.clock_timestamp()
  WHERE x.token_hash = p_token_hash AND x.revoked_at IS NULL AND x.last_used_at IS NULL
  RETURNING x.org_id, x.id, x.user_id INTO v_org, v_id, v_user;
  IF v_id IS NULL THEN
    RETURN false;
  END IF;
  BEGIN
    PERFORM crove_kernel.ext_device_audit_revoke(v_org, v_id, v_user, 'exchange_failed');
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  RETURN true;
END $$;

-- ---------------------------------------------------------------------------
-- The exchange checks the member under a row lock
-- ---------------------------------------------------------------------------
-- The body of the function of 20261126140000 with one change: the eligibility check locks the member and user rows (FOR SHARE).
-- Its signature, result columns, owner and grants are as they were.
CREATE OR REPLACE FUNCTION crove_kernel.exchange_extension_auth_code(p_code_hash bytea, p_code_verifier text, p_token_hash bytea)
RETURNS TABLE (token_id uuid, org_id uuid, user_id uuid, scopes text[], expires_at timestamptz, code_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_code crove_kernel.extension_auth_code%ROWTYPE;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_challenge text;
  v_id uuid;
BEGIN
  IF p_code_hash IS NULL OR pg_catalog.octet_length(p_code_hash) <> 32
     OR p_token_hash IS NULL OR pg_catalog.octet_length(p_token_hash) <> 32
     OR p_code_verifier IS NULL OR p_code_verifier !~ '^[A-Za-z0-9._~-]{43,128}$' THEN
    RETURN;
  END IF;
  SELECT c.* INTO v_code FROM crove_kernel.extension_auth_code c WHERE c.code_hash = p_code_hash FOR UPDATE;
  IF NOT FOUND OR v_code.consumed_at IS NOT NULL OR v_code.expires_at <= v_now OR v_code.failed_attempts >= 5 THEN
    RETURN;
  END IF;
  v_challenge := pg_catalog.translate(
    pg_catalog.rtrim(pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_code_verifier, 'UTF8')), 'base64'), '='), '+/', '-_');
  IF v_challenge <> v_code.code_challenge THEN
    UPDATE crove_kernel.extension_auth_code c
    SET failed_attempts = c.failed_attempts + 1,
        consumed_at = CASE WHEN c.failed_attempts + 1 >= 5 THEN v_now ELSE NULL END
    WHERE c.org_id = v_code.org_id AND c.id = v_code.id;
    RETURN;
  END IF;
  -- FOR SHARE on the member and the user: a demotion or disable in flight holds these rows, so this waits for it and then
  -- sees its result; one that starts after this holds the share lock until the token exists, and its trigger then voids it.
  PERFORM 1
  FROM crove_kernel.tenant_member m
  JOIN crove_kernel.tenant t ON t.org_id = m.org_id AND t.status = 'active'
  JOIN crove_kernel.user_account u ON u.id = m.user_id AND u.disabled_at IS NULL
  WHERE m.org_id = v_code.org_id AND m.user_id = v_code.user_id AND m.role IN ('owner', 'admin', 'member')
    AND m.created_at <= v_code.created_at
  FOR SHARE OF m, u;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  UPDATE crove_kernel.extension_auth_code c SET consumed_at = v_now WHERE c.org_id = v_code.org_id AND c.id = v_code.id;
  UPDATE crove_kernel.extension_token t SET revoked_at = v_now
  WHERE t.org_id = v_code.org_id AND t.id IN (
    SELECT o.id FROM crove_kernel.extension_token o
    WHERE o.org_id = v_code.org_id AND o.user_id = v_code.user_id AND o.revoked_at IS NULL AND o.expires_at > v_now
    ORDER BY o.created_at DESC OFFSET 19);
  INSERT INTO crove_kernel.extension_token (org_id, user_id, token_hash, device_name, scopes, created_at, expires_at, created_by)
  VALUES (v_code.org_id, v_code.user_id, p_token_hash, v_code.device_name, v_code.scopes, v_now, v_now + interval '2160 hours', v_code.user_id)
  RETURNING id INTO v_id;
  RETURN QUERY SELECT v_id, v_code.org_id, v_code.user_id, v_code.scopes, v_now + interval '2160 hours', v_code.id;
END $$;

-- ---------------------------------------------------------------------------
-- Backfill: tokens already suspended when this migration runs
-- ---------------------------------------------------------------------------
-- Voids, with its audit row, every live token of a member who is already disabled or already below member in an active org
-- (see 6. above). Returns how many it voided. Callable by nobody but the owner of the schema (the migration runs it once).
CREATE OR REPLACE FUNCTION crove_kernel.ext_device_backfill_suspended()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  r record;
  v_n integer := 0;
BEGIN
  FOR r IN
    SELECT DISTINCT x.org_id, x.user_id,
           CASE WHEN u.disabled_at IS NOT NULL THEN 'user_disabled' ELSE 'role_change' END AS reason
    FROM crove_kernel.extension_token x
    JOIN crove_kernel.tenant t ON t.org_id = x.org_id AND t.status = 'active'
    JOIN crove_kernel.user_account u ON u.id = x.user_id
    LEFT JOIN crove_kernel.tenant_member m ON m.org_id = x.org_id AND m.user_id = x.user_id
    WHERE x.revoked_at IS NULL AND x.expires_at > pg_catalog.clock_timestamp()
      AND (u.disabled_at IS NOT NULL OR m.role NOT IN ('owner', 'admin', 'member'))
  LOOP
    v_n := v_n + crove_kernel.ext_device_system_revoke(r.org_id, r.user_id, r.reason);
  END LOOP;
  RETURN v_n;
END $$;

-- ---------------------------------------------------------------------------
-- Grants: the internal routines and the trigger functions are callable by nobody; the API's login alone runs the rest.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION
  crove_kernel.ext_device_audit_revoke(uuid, uuid, uuid, text),
  crove_kernel.ext_device_system_revoke(uuid, uuid, text),
  crove_kernel.ext_device_member_demoted(),
  crove_kernel.ext_device_user_disabled(),
  crove_kernel.ext_device_member_removed(),
  crove_kernel.ext_device_caller_role(),
  crove_kernel.ext_device_backfill_suspended(),
  crove_kernel.list_extension_tokens_for_org(),
  crove_kernel.revoke_extension_token_as_admin(uuid),
  crove_kernel.void_undelivered_extension_token(bytea)
FROM PUBLIC;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE 'crove\_%' AND rolname <> current_user LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON FUNCTION crove_kernel.ext_device_audit_revoke(uuid, uuid, uuid, text), '
      'crove_kernel.ext_device_system_revoke(uuid, uuid, text), crove_kernel.ext_device_member_demoted(), '
      'crove_kernel.ext_device_user_disabled(), crove_kernel.ext_device_member_removed(), crove_kernel.ext_device_caller_role(), crove_kernel.ext_device_backfill_suspended(), '
      'crove_kernel.list_extension_tokens_for_org(), crove_kernel.revoke_extension_token_as_admin(uuid), '
      'crove_kernel.void_undelivered_extension_token(bytea) FROM %I',
      r.rolname);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION
  crove_kernel.list_extension_tokens_for_org(),
  crove_kernel.revoke_extension_token_as_admin(uuid),
  crove_kernel.void_undelivered_extension_token(bytea)
TO crove_app;

-- Run the backfill once, now that the triggers and the routines exist.
SELECT crove_kernel.ext_device_backfill_suspended();
