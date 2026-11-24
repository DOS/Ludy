-- SPDX-License-Identifier: AGPL-3.0-only
-- The db session check accepts the one OAuth client a deployment names (issue #4704, ADR-0028 amendment 2026-11-24).
-- Idempotent; applied files stay untouched.
--
-- Until now session_check and identity_resolve refused every session Supabase Auth's OAuth server bound to a client
-- (auth.sessions.oauth_client_id, issue #276). A deployment whose people sign in through its identity provider's OAuth
-- App (AUTH_OAUTH_CLIENT_ID) needs exactly that client's sessions to pass, and no other client's.
--
-- auth_session_oauth_refused(session, accepted)  new Supabase Auth reader, owned by ludy_auth_reader like the others:
--                             true when the session row names an OAuth client other than `accepted`; with `accepted`
--                             NULL it is true for every bound session, as auth_session_oauth_bound(). Same column
--                             guard: an older Supabase Auth without the OAuth server has no such session.
-- session_check(..., accepted)    the check with one more argument; the argument is the kernel's AUTH_OAUTH_CLIENT_ID
-- identity_resolve(..., accepted) (lower-case UUID text) or NULL. NULL is today's behaviour exactly.
-- session_check(5 arguments)      the old signatures stay, as thin calls with NULL, so nothing that calls them changes.
-- identity_resolve(6 arguments)
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION ludy_kernel.auth_session_oauth_refused(p_session_id uuid, p_accepted_client text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = pg_catalog.to_regclass('auth.sessions') AND a.attname = 'oauth_client_id'
      AND a.attnum > 0 AND NOT a.attisdropped
  ) THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM auth.sessions s
    WHERE s.id = p_session_id AND s.oauth_client_id IS NOT NULL
      AND (p_accepted_client IS NULL OR s.oauth_client_id::text <> p_accepted_client)
  );
END $$;

DO $$
BEGIN
  IF NOT (SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user) THEN
    EXECUTE pg_catalog.format('GRANT ludy_auth_reader TO %I WITH INHERIT TRUE, SET TRUE', current_user);
  END IF;
END $$;
GRANT CREATE ON SCHEMA ludy_kernel TO ludy_auth_reader;
ALTER FUNCTION ludy_kernel.auth_session_oauth_refused(uuid, text) OWNER TO ludy_auth_reader;
REVOKE CREATE ON SCHEMA ludy_kernel FROM ludy_auth_reader;

-- ---------------------------------------------------------------------------
-- Per-request check: as before, but the OAuth rule refuses a bound session only when it is not the accepted client's.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ludy_kernel.session_check(
  p_user_id uuid, p_session_id uuid, p_upstream boolean, p_org_id uuid, p_aal text, p_oauth_client text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_subject text;
  v_disabled timestamptz;
  v_status text;
  v_seen timestamptz;
  v_org_status text;
  v_org_seen timestamptz;
BEGIN
  IF p_user_id IS NULL OR p_session_id IS NULL OR p_upstream IS NULL OR p_aal IS NULL THEN
    RAISE EXCEPTION 'SESSION_INVALID' USING ERRCODE = '28000';
  END IF;
  SELECT u.subject, u.disabled_at INTO v_subject, v_disabled FROM ludy_kernel.user_account u WHERE u.id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SESSION_INVALID' USING ERRCODE = '28000';
  END IF;
  IF v_disabled IS NOT NULL THEN
    RAISE EXCEPTION 'USER_DISABLED' USING ERRCODE = '42501';
  END IF;
  SELECT s.status, s.last_seen_at INTO v_status, v_seen
  FROM ludy_kernel.auth_session s WHERE s.user_id = p_user_id AND s.session_id = p_session_id;
  IF v_status = 'revoked' THEN
    RAISE EXCEPTION 'SESSION_REVOKED' USING ERRCODE = '28000';
  END IF;
  IF p_org_id IS NOT NULL THEN
    SELECT o.status, o.last_seen_at INTO v_org_status, v_org_seen
    FROM ludy_kernel.auth_session_org o
    WHERE o.org_id = p_org_id AND o.user_id = p_user_id AND o.session_id = p_session_id;
    IF v_org_status = 'revoked' THEN
      RAISE EXCEPTION 'SESSION_REVOKED_IN_ORG' USING ERRCODE = '28000';
    END IF;
  END IF;
  IF p_upstream THEN
    IF NOT ludy_kernel.auth_grants_ready() THEN
      RAISE EXCEPTION 'AUTH_GRANTS_MISSING' USING ERRCODE = '55000';
    END IF;
    IF v_subject !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
       OR NOT ludy_kernel.auth_session_valid(p_session_id, v_subject::uuid) THEN
      RAISE EXCEPTION 'SESSION_INVALID' USING ERRCODE = '28000';
    END IF;
    -- A session Supabase Auth's OAuth server bound to a client, whatever claims its token carries (issue #276), unless
    -- it is the one client the deployment accepts (issue #4704). Before the MFA rule, so the SPA signs out instead of
    -- asking for MFA.
    IF ludy_kernel.auth_session_oauth_refused(p_session_id, p_oauth_client) THEN
      RAISE EXCEPTION 'OAUTH_CLIENT_SESSION' USING ERRCODE = '28000';
    END IF;
    -- A live session that has not passed MFA, for a user who has a second factor: finish signing in first.
    IF p_aal <> 'aal2' AND ludy_kernel.auth_user_has_verified_factor(v_subject::uuid) THEN
      RAISE EXCEPTION 'MFA_REQUIRED' USING ERRCODE = '28000';
    END IF;
  END IF;
  IF v_status IS NULL THEN
    INSERT INTO ludy_kernel.auth_session (user_id, session_id) VALUES (p_user_id, p_session_id)
    ON CONFLICT (user_id, session_id) DO NOTHING;
  ELSIF v_seen < pg_catalog.now() - interval '1 minute' THEN
    UPDATE ludy_kernel.auth_session s SET last_seen_at = pg_catalog.now()
    WHERE s.user_id = p_user_id AND s.session_id = p_session_id AND s.status = 'active';
  END IF;
  IF p_org_id IS NOT NULL THEN
    IF v_org_status IS NULL THEN
      -- Only for a member: enter_context refuses everyone else right after this.
      IF EXISTS (SELECT 1 FROM ludy_kernel.tenant_member m WHERE m.org_id = p_org_id AND m.user_id = p_user_id) THEN
        INSERT INTO ludy_kernel.auth_session_org (org_id, user_id, session_id) VALUES (p_org_id, p_user_id, p_session_id)
        ON CONFLICT (org_id, user_id, session_id) DO NOTHING;
      END IF;
    ELSIF v_org_seen < pg_catalog.now() - interval '1 minute' THEN
      UPDATE ludy_kernel.auth_session_org o SET last_seen_at = pg_catalog.now()
      WHERE o.org_id = p_org_id AND o.user_id = p_user_id AND o.session_id = p_session_id AND o.status = 'active';
    END IF;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION ludy_kernel.session_check(
  p_user_id uuid, p_session_id uuid, p_upstream boolean, p_org_id uuid, p_aal text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM ludy_kernel.session_check(p_user_id, p_session_id, p_upstream, p_org_id, p_aal, NULL::text);
END $$;

-- ---------------------------------------------------------------------------
-- Maps a verified access token to its Crove user, after the same checks as session_check (minus the org).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ludy_kernel.identity_resolve(
  p_issuer text, p_subject text, p_email text, p_name text, p_session_id uuid, p_upstream boolean, p_oauth_client text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_id uuid;
  v_disabled timestamptz;
BEGIN
  IF p_session_id IS NULL OR p_upstream IS NULL THEN
    RAISE EXCEPTION 'SESSION_INVALID' USING ERRCODE = '28000';
  END IF;
  SELECT u.id, u.disabled_at INTO v_id, v_disabled
  FROM ludy_kernel.user_account u WHERE u.issuer = p_issuer AND u.subject = p_subject;
  IF FOUND THEN
    IF v_disabled IS NOT NULL THEN
      RAISE EXCEPTION 'USER_DISABLED' USING ERRCODE = '42501';
    END IF;
    IF EXISTS (
      SELECT 1 FROM ludy_kernel.auth_session s
      WHERE s.user_id = v_id AND s.session_id = p_session_id AND s.status = 'revoked'
    ) THEN
      RAISE EXCEPTION 'SESSION_REVOKED' USING ERRCODE = '28000';
    END IF;
  END IF;
  IF p_upstream THEN
    IF NOT ludy_kernel.auth_grants_ready() THEN
      RAISE EXCEPTION 'AUTH_GRANTS_MISSING' USING ERRCODE = '55000';
    END IF;
    IF p_subject !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
       OR NOT ludy_kernel.auth_session_valid(p_session_id, p_subject::uuid) THEN
      RAISE EXCEPTION 'SESSION_INVALID' USING ERRCODE = '28000';
    END IF;
    IF ludy_kernel.auth_session_oauth_refused(p_session_id, p_oauth_client) THEN
      RAISE EXCEPTION 'OAUTH_CLIENT_SESSION' USING ERRCODE = '28000';
    END IF;
  END IF;
  RETURN ludy_kernel.identity_upsert(p_issuer, p_subject, p_email, p_name);
END $$;

CREATE OR REPLACE FUNCTION ludy_kernel.identity_resolve(
  p_issuer text, p_subject text, p_email text, p_name text, p_session_id uuid, p_upstream boolean)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RETURN ludy_kernel.identity_resolve(p_issuer, p_subject, p_email, p_name, p_session_id, p_upstream, NULL::text);
END $$;

-- ---------------------------------------------------------------------------
-- EXECUTE matrix: only the API login role runs the checks; the reader is reachable only through them.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION
  ludy_kernel.auth_session_oauth_refused(uuid, text),
  ludy_kernel.session_check(uuid, uuid, boolean, uuid, text, text),
  ludy_kernel.session_check(uuid, uuid, boolean, uuid, text),
  ludy_kernel.identity_resolve(text, text, text, text, uuid, boolean, text),
  ludy_kernel.identity_resolve(text, text, text, text, uuid, boolean)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  ludy_kernel.session_check(uuid, uuid, boolean, uuid, text, text),
  ludy_kernel.session_check(uuid, uuid, boolean, uuid, text),
  ludy_kernel.identity_resolve(text, text, text, text, uuid, boolean, text),
  ludy_kernel.identity_resolve(text, text, text, text, uuid, boolean)
TO ludy_app;
