-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove eSign Slice 5c (docs/plan/esign.md, issue #4441): scoped org API keys (crove_sign.api_key)
-- as definer-only machinery storing SHA-256 digests only, MCP direct-link boolean helper, and
-- orgless SECURITY DEFINER procedures for /api/v1/sign/* external REST endpoints.
-- Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. Machinery table: crove_sign.api_key (definer-only, zero runtime grants)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_sign.api_key (
  org_id uuid NOT NULL REFERENCES ludy_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT ludy_kernel.uuid_v7(),
  name text NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(name)) BETWEEN 1 AND 120),
  key_prefix text NOT NULL CHECK (key_prefix ~ '^ludy_sk_[A-Za-z0-9_-]{8,16}$'),
  key_sha256 text NOT NULL UNIQUE CHECK (key_sha256 ~ '^[0-9a-f]{64}$'),
  scopes text[] NOT NULL CHECK (
    pg_catalog.cardinality(scopes) >= 1
    AND scopes <@ ARRAY['sign:read', 'sign:draft']::text[]
  ),
  created_by uuid REFERENCES ludy_kernel.user_account (id) ON DELETE SET NULL,
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id)
);

CREATE INDEX IF NOT EXISTS api_key_org_created_idx
  ON crove_sign.api_key (org_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS api_key_created_by_idx
  ON crove_sign.api_key (created_by)
  WHERE created_by IS NOT NULL;

ALTER TABLE crove_sign.api_key ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON crove_sign.api_key FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
SELECT ludy_kernel.agent_write_guard_install('crove_sign.api_key');

-- ---------------------------------------------------------------------------
-- 2. Boolean direct-link helper for read-only MCP template projection
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_sign.template_direct_link_enabled(p_template_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_actor text := ludy_kernel.ctx_actor_type();
BEGIN
  IF v_org IS NULL OR v_actor IS NULL OR p_template_id IS NULL THEN
    RETURN false;
  END IF;
  IF v_actor NOT IN ('user', 'system', 'agent') THEN
    RETURN false;
  END IF;
  IF v_actor = 'agent' AND COALESCE(ludy_kernel.ctx_verified() ->> 'kind', '') = 'mcp_member' THEN
    RETURN false;
  END IF;
  IF NOT ludy_kernel.org_app_on(v_org, 'sign') THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM crove_sign.template_direct_link l
    WHERE l.org_id = v_org
      AND l.template_id = p_template_id
      AND l.enabled = true
      AND l.revoked_at IS NULL
      AND (l.expires_at IS NULL OR l.expires_at > pg_catalog.now())
  );
END $$;

REVOKE ALL ON FUNCTION crove_sign.template_direct_link_enabled(uuid)
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.template_direct_link_enabled(uuid) TO ludy_tenant;

-- ---------------------------------------------------------------------------
-- 3. Authenticated owner/admin management definers for crove_sign.api_key
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_sign.api_key_list()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_actor text := ludy_kernel.ctx_actor_type();
  v_user uuid := ludy_kernel.ctx_user_id();
  v_out jsonb;
BEGIN
  IF v_org IS NULL OR v_actor IS DISTINCT FROM 'user' OR ludy_kernel.ctx_agent_id() IS NOT NULL OR v_user IS NULL THEN
    RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF NOT ludy_kernel.org_app_on(v_org, 'sign') THEN
    RAISE EXCEPTION 'SIGN_APP_DISABLED' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM ludy_kernel.tenant_member m
    WHERE m.org_id = v_org AND m.user_id = v_user AND m.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', k.id,
        'name', k.name,
        'keyPrefix', k.key_prefix,
        'scopes', pg_catalog.to_jsonb(k.scopes),
        'createdBy', k.created_by,
        'expiresAt', k.expires_at,
        'revokedAt', k.revoked_at,
        'lastUsedAt', k.last_used_at,
        'createdAt', k.created_at,
        'updatedAt', k.updated_at
      )
      ORDER BY (k.revoked_at IS NOT NULL) ASC, k.created_at DESC, k.id DESC
    ),
    '[]'::jsonb
  )
  INTO v_out
  FROM crove_sign.api_key k
  WHERE k.org_id = v_org;

  RETURN v_out;
END $$;

REVOKE ALL ON FUNCTION crove_sign.api_key_list()
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.api_key_list() TO ludy_tenant;

CREATE OR REPLACE FUNCTION crove_sign.api_key_insert(
  p_id uuid,
  p_name text,
  p_key_prefix text,
  p_key_sha256 text,
  p_scopes text[],
  p_expires_at timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_actor text := ludy_kernel.ctx_actor_type();
  v_user uuid := ludy_kernel.ctx_user_id();
  v_now timestamptz := pg_catalog.now();
  v_name text := pg_catalog.btrim(pg_catalog.regexp_replace(COALESCE(p_name, ''), '[[:cntrl:]]+', ' ', 'g'));
  v_scopes text[];
  v_active_count integer := 0;
  v_row crove_sign.api_key%ROWTYPE;
BEGIN
  IF v_org IS NULL OR v_actor IS DISTINCT FROM 'user' OR ludy_kernel.ctx_agent_id() IS NOT NULL OR v_user IS NULL THEN
    RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF NOT ludy_kernel.org_app_on(v_org, 'sign') THEN
    RAISE EXCEPTION 'SIGN_APP_DISABLED' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM ludy_kernel.tenant_member m
    WHERE m.org_id = v_org AND m.user_id = v_user AND m.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  IF pg_catalog.length(v_name) < 1 OR pg_catalog.length(v_name) > 120 THEN
    RAISE EXCEPTION 'SIGN_API_KEY_INVALID_NAME' USING ERRCODE = '22023';
  END IF;
  IF p_key_prefix IS NULL OR p_key_prefix !~ '^ludy_sk_[A-Za-z0-9_-]{8,16}$' THEN
    RAISE EXCEPTION 'SIGN_API_KEY_INVALID_PREFIX' USING ERRCODE = '22023';
  END IF;
  IF p_key_sha256 IS NULL OR p_key_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'SIGN_API_KEY_INVALID_HASH' USING ERRCODE = '22023';
  END IF;

  SELECT ARRAY(
    SELECT DISTINCT s
    FROM pg_catalog.unnest(COALESCE(p_scopes, ARRAY[]::text[])) AS u(s)
    WHERE s IN ('sign:read', 'sign:draft')
    ORDER BY s ASC
  )
  INTO v_scopes;

  IF pg_catalog.cardinality(v_scopes) < 1
     OR NOT (COALESCE(p_scopes, ARRAY[]::text[]) <@ ARRAY['sign:read', 'sign:draft']::text[]) THEN
    RAISE EXCEPTION 'SIGN_API_KEY_INVALID_SCOPES' USING ERRCODE = '22023';
  END IF;

  IF p_expires_at IS NOT NULL AND p_expires_at <= v_now THEN
    RAISE EXCEPTION 'SIGN_API_KEY_INVALID_EXPIRY' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('sign.api_key:' || v_org::text, 0)
  );

  SELECT pg_catalog.count(*)::integer
  INTO v_active_count
  FROM crove_sign.api_key k
  WHERE k.org_id = v_org
    AND k.revoked_at IS NULL
    AND (k.expires_at IS NULL OR k.expires_at > v_now);

  IF v_active_count >= 50 THEN
    RAISE EXCEPTION 'SIGN_API_KEY_LIMIT_REACHED' USING ERRCODE = '22023';
  END IF;

  INSERT INTO crove_sign.api_key (
    org_id,
    id,
    name,
    key_prefix,
    key_sha256,
    scopes,
    created_by,
    expires_at,
    created_at,
    updated_at
  )
  VALUES (
    v_org,
    COALESCE(p_id, ludy_kernel.uuid_v7()),
    v_name,
    p_key_prefix,
    p_key_sha256,
    v_scopes,
    v_user,
    p_expires_at,
    v_now,
    v_now
  )
  RETURNING * INTO v_row;

  RETURN pg_catalog.jsonb_build_object(
    'id', v_row.id,
    'name', v_row.name,
    'keyPrefix', v_row.key_prefix,
    'scopes', pg_catalog.to_jsonb(v_row.scopes),
    'createdBy', v_row.created_by,
    'expiresAt', v_row.expires_at,
    'revokedAt', v_row.revoked_at,
    'lastUsedAt', v_row.last_used_at,
    'createdAt', v_row.created_at,
    'updatedAt', v_row.updated_at
  );
END $$;

REVOKE ALL ON FUNCTION crove_sign.api_key_insert(uuid, text, text, text, text[], timestamptz)
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.api_key_insert(uuid, text, text, text, text[], timestamptz)
  TO ludy_app, ludy_worker;

CREATE OR REPLACE FUNCTION crove_sign.api_key_revoke(p_key_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_actor text := ludy_kernel.ctx_actor_type();
  v_user uuid := ludy_kernel.ctx_user_id();
  v_now timestamptz := pg_catalog.now();
  v_row crove_sign.api_key%ROWTYPE;
BEGIN
  IF v_org IS NULL OR p_key_id IS NULL OR v_actor IS DISTINCT FROM 'user' OR ludy_kernel.ctx_agent_id() IS NOT NULL OR v_user IS NULL THEN
    RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF NOT ludy_kernel.org_app_on(v_org, 'sign') THEN
    RAISE EXCEPTION 'SIGN_APP_DISABLED' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM ludy_kernel.tenant_member m
    WHERE m.org_id = v_org AND m.user_id = v_user AND m.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  UPDATE crove_sign.api_key
  SET revoked_at = COALESCE(revoked_at, v_now),
      updated_at = v_now
  WHERE org_id = v_org AND id = p_key_id
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SIGN_API_KEY_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'id', v_row.id,
    'name', v_row.name,
    'keyPrefix', v_row.key_prefix,
    'scopes', pg_catalog.to_jsonb(v_row.scopes),
    'createdBy', v_row.created_by,
    'expiresAt', v_row.expires_at,
    'revokedAt', v_row.revoked_at,
    'lastUsedAt', v_row.last_used_at,
    'createdAt', v_row.created_at,
    'updatedAt', v_row.updated_at
  );
END $$;

REVOKE ALL ON FUNCTION crove_sign.api_key_revoke(uuid)
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.api_key_revoke(uuid)
  TO ludy_app, ludy_worker;

-- ---------------------------------------------------------------------------
-- 4. Orgless SECURITY DEFINER procedures for /api/v1/sign/* (ludy_app only)
--    Every orgless lookup checks ludy_kernel.org_app_on(ak.org_id, 'sign').
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_sign.api_key_authenticate(p_key_sha256 text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_now timestamptz := pg_catalog.now();
  v_ctx_org uuid := ludy_kernel.ctx_org_id();
  v_row record;
BEGIN
  IF p_key_sha256 IS NULL OR p_key_sha256 !~ '^[0-9a-f]{64}$' THEN
    RETURN pg_catalog.jsonb_build_object('status', 'unauthorized');
  END IF;

  SELECT
    ak.org_id,
    ak.id AS key_id,
    ak.key_prefix,
    ak.scopes,
    ak.created_by,
    t.slug AS org_slug,
    t.status AS tenant_status,
    ludy_kernel.org_app_on(ak.org_id, 'sign') AS app_on
  INTO v_row
  FROM crove_sign.api_key ak
  JOIN ludy_kernel.tenant t ON t.org_id = ak.org_id
  WHERE ak.key_sha256 = p_key_sha256
    AND ak.revoked_at IS NULL
    AND (ak.expires_at IS NULL OR ak.expires_at > v_now);

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'unauthorized');
  END IF;

  IF v_ctx_org IS NOT NULL AND (ludy_kernel.ctx_actor_type() IS DISTINCT FROM 'system' OR v_ctx_org IS DISTINCT FROM v_row.org_id) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  IF v_row.tenant_status IS DISTINCT FROM 'active' OR NOT v_row.app_on THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'ok',
    'orgId', v_row.org_id,
    'orgSlug', v_row.org_slug,
    'keyId', v_row.key_id,
    'keyPrefix', v_row.key_prefix,
    'scopes', pg_catalog.to_jsonb(v_row.scopes),
    'createdBy', v_row.created_by
  );
END $$;

REVOKE ALL ON FUNCTION crove_sign.api_key_authenticate(text)
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.api_key_authenticate(text) TO ludy_app;

CREATE OR REPLACE FUNCTION crove_sign.api_key_envelopes_list(
  p_key_sha256 text,
  p_status text DEFAULT NULL,
  p_limit integer DEFAULT 50
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_now timestamptz := pg_catalog.now();
  v_ctx_org uuid := ludy_kernel.ctx_org_id();
  v_ak record;
  v_limit integer := GREATEST(1, LEAST(COALESCE(p_limit, 50), 100));
  v_items jsonb;
BEGIN
  IF p_key_sha256 IS NULL OR p_key_sha256 !~ '^[0-9a-f]{64}$' THEN
    RETURN pg_catalog.jsonb_build_object('status', 'unauthorized');
  END IF;

  SELECT
    ak.org_id,
    ak.id AS key_id,
    ak.scopes,
    ak.last_used_at,
    t.status AS tenant_status,
    ludy_kernel.org_app_on(ak.org_id, 'sign') AS app_on
  INTO v_ak
  FROM crove_sign.api_key ak
  JOIN ludy_kernel.tenant t ON t.org_id = ak.org_id
  WHERE ak.key_sha256 = p_key_sha256
    AND ak.revoked_at IS NULL
    AND (ak.expires_at IS NULL OR ak.expires_at > v_now);

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'unauthorized');
  END IF;

  IF v_ctx_org IS NOT NULL AND (ludy_kernel.ctx_actor_type() IS DISTINCT FROM 'system' OR v_ctx_org IS DISTINCT FROM v_ak.org_id) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  IF v_ak.tenant_status IS DISTINCT FROM 'active' OR NOT v_ak.app_on THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  IF NOT ('sign:read' = ANY (v_ak.scopes)) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'forbidden');
  END IF;

  IF p_status IS NOT NULL AND p_status NOT IN ('draft', 'sent', 'in_progress', 'completed', 'declined', 'voided', 'expired') THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'VALIDATION',
      'httpStatus', 422,
      'message', 'Invalid envelope status filter'
    );
  END IF;

  IF v_ak.last_used_at IS NULL OR v_ak.last_used_at < v_now - interval '30 seconds' THEN
    UPDATE crove_sign.api_key
    SET last_used_at = v_now,
        updated_at = v_now
    WHERE org_id = v_ak.org_id AND id = v_ak.key_id;
  END IF;

  WITH page AS (
    SELECT
      e.id,
      e.title,
      e.status,
      e.routing_mode,
      e.source_kind,
      e.inspect_status,
      e.seal_status,
      e.certificate_code,
      e.page_count,
      e.expires_at,
      e.sent_at,
      e.completed_at,
      e.declined_at,
      e.voided_at,
      e.expired_at,
      e.created_at,
      e.updated_at
    FROM crove_sign.envelope e
    WHERE e.org_id = v_ak.org_id
      AND e.source_kind NOT IN ('hr_contract', 'meeting_minutes')
      AND (p_status IS NULL OR e.status = p_status)
    ORDER BY e.created_at DESC, e.id DESC
    LIMIT v_limit
  ),
  counts AS (
    SELECT
      s.envelope_id,
      pg_catalog.count(*)::integer AS total,
      pg_catalog.count(*) FILTER (WHERE s.status = 'signed')::integer AS signed,
      pg_catalog.count(*) FILTER (WHERE s.status = 'declined')::integer AS declined,
      pg_catalog.count(*) FILTER (WHERE s.status IN ('waiting', 'pending', 'viewed'))::integer AS pending
    FROM crove_sign.signer s
    JOIN page p ON p.id = s.envelope_id
    WHERE s.org_id = v_ak.org_id
      AND s.signer_role <> 'cc'
    GROUP BY s.envelope_id
  )
  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', p.id,
        'title', p.title,
        'status', p.status,
        'routingMode', p.routing_mode,
        'sourceKind', p.source_kind,
        'inspectStatus', p.inspect_status,
        'sealStatus', p.seal_status,
        'certificateCode', p.certificate_code,
        'pageCount', p.page_count,
        'expiresAt', CASE WHEN p.expires_at IS NOT NULL THEN pg_catalog.to_char(p.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') ELSE NULL END,
        'sentAt', CASE WHEN p.sent_at IS NOT NULL THEN pg_catalog.to_char(p.sent_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') ELSE NULL END,
        'completedAt', CASE WHEN p.completed_at IS NOT NULL THEN pg_catalog.to_char(p.completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') ELSE NULL END,
        'declinedAt', CASE WHEN p.declined_at IS NOT NULL THEN pg_catalog.to_char(p.declined_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') ELSE NULL END,
        'voidedAt', CASE WHEN p.voided_at IS NOT NULL THEN pg_catalog.to_char(p.voided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') ELSE NULL END,
        'expiredAt', CASE WHEN p.expired_at IS NOT NULL THEN pg_catalog.to_char(p.expired_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') ELSE NULL END,
        'createdAt', pg_catalog.to_char(p.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'updatedAt', pg_catalog.to_char(p.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'signerCounts', pg_catalog.jsonb_build_object(
          'total', COALESCE(c.total, 0),
          'signed', COALESCE(c.signed, 0),
          'declined', COALESCE(c.declined, 0),
          'pending', COALESCE(c.pending, 0)
        )
      )
      ORDER BY p.created_at DESC, p.id DESC
    ),
    '[]'::jsonb
  )
  INTO v_items
  FROM page p
  LEFT JOIN counts c ON c.envelope_id = p.id;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'ok',
    'items', v_items
  );
END $$;

REVOKE ALL ON FUNCTION crove_sign.api_key_envelopes_list(text, text, integer)
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.api_key_envelopes_list(text, text, integer) TO ludy_app;

CREATE OR REPLACE FUNCTION crove_sign.api_key_envelope_get(
  p_key_sha256 text,
  p_envelope_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_now timestamptz := pg_catalog.now();
  v_ctx_org uuid := ludy_kernel.ctx_org_id();
  v_ak record;
  v_env record;
  v_signers jsonb;
BEGIN
  IF p_key_sha256 IS NULL OR p_key_sha256 !~ '^[0-9a-f]{64}$' THEN
    RETURN pg_catalog.jsonb_build_object('status', 'unauthorized');
  END IF;

  SELECT
    ak.org_id,
    ak.id AS key_id,
    ak.scopes,
    ak.last_used_at,
    t.status AS tenant_status,
    ludy_kernel.org_app_on(ak.org_id, 'sign') AS app_on
  INTO v_ak
  FROM crove_sign.api_key ak
  JOIN ludy_kernel.tenant t ON t.org_id = ak.org_id
  WHERE ak.key_sha256 = p_key_sha256
    AND ak.revoked_at IS NULL
    AND (ak.expires_at IS NULL OR ak.expires_at > v_now);

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'unauthorized');
  END IF;

  IF v_ctx_org IS NOT NULL AND (ludy_kernel.ctx_actor_type() IS DISTINCT FROM 'system' OR v_ctx_org IS DISTINCT FROM v_ak.org_id) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  IF v_ak.tenant_status IS DISTINCT FROM 'active' OR NOT v_ak.app_on THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  IF NOT ('sign:read' = ANY (v_ak.scopes)) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'forbidden');
  END IF;

  IF v_ak.last_used_at IS NULL OR v_ak.last_used_at < v_now - interval '30 seconds' THEN
    UPDATE crove_sign.api_key
    SET last_used_at = v_now,
        updated_at = v_now
    WHERE org_id = v_ak.org_id AND id = v_ak.key_id;
  END IF;

  IF p_envelope_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('status', 'envelope_not_found');
  END IF;

  SELECT
    e.id,
    e.title,
    e.subject,
    e.status,
    e.routing_mode,
    e.source_kind,
    e.inspect_status,
    e.seal_status,
    e.certificate_code,
    e.page_count,
    e.source_sha256,
    e.sealed_sha256,
    e.certificate_sha256,
    e.expires_at,
    e.sent_at,
    e.completed_at,
    e.declined_at,
    e.voided_at,
    e.expired_at,
    e.created_at,
    e.updated_at
  INTO v_env
  FROM crove_sign.envelope e
  WHERE e.org_id = v_ak.org_id
    AND e.id = p_envelope_id
    AND e.source_kind NOT IN ('hr_contract', 'meeting_minutes');

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'envelope_not_found');
  END IF;

  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', s.id,
        'roleKey', s.role_key,
        'routingOrder', s.routing_order,
        'signerRole', s.signer_role,
        'roleLabel', s.role_label,
        'name', s.name,
        'deliveryMode', s.delivery_mode,
        'requireEmailOtp', s.require_email_otp,
        'status', s.status,
        'viewedAt', CASE WHEN s.viewed_at IS NOT NULL THEN pg_catalog.to_char(s.viewed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') ELSE NULL END,
        'signedAt', CASE WHEN s.signed_at IS NOT NULL THEN pg_catalog.to_char(s.signed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') ELSE NULL END,
        'declinedAt', CASE WHEN s.declined_at IS NOT NULL THEN pg_catalog.to_char(s.declined_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') ELSE NULL END
      )
      ORDER BY s.routing_order ASC, s.created_at ASC, s.id ASC
    ),
    '[]'::jsonb
  )
  INTO v_signers
  FROM crove_sign.signer s
  WHERE s.org_id = v_ak.org_id
    AND s.envelope_id = v_env.id;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'ok',
    'envelope', pg_catalog.jsonb_build_object(
      'id', v_env.id,
      'title', v_env.title,
      'subject', v_env.subject,
      'status', v_env.status,
      'routingMode', v_env.routing_mode,
      'sourceKind', v_env.source_kind,
      'inspectStatus', v_env.inspect_status,
      'sealStatus', v_env.seal_status,
      'certificateCode', v_env.certificate_code,
      'pageCount', v_env.page_count,
      'sourceSha256', v_env.source_sha256,
      'sealedSha256', v_env.sealed_sha256,
      'certificateSha256', v_env.certificate_sha256,
      'expiresAt', CASE WHEN v_env.expires_at IS NOT NULL THEN pg_catalog.to_char(v_env.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') ELSE NULL END,
      'sentAt', CASE WHEN v_env.sent_at IS NOT NULL THEN pg_catalog.to_char(v_env.sent_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') ELSE NULL END,
      'completedAt', CASE WHEN v_env.completed_at IS NOT NULL THEN pg_catalog.to_char(v_env.completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') ELSE NULL END,
      'declinedAt', CASE WHEN v_env.declined_at IS NOT NULL THEN pg_catalog.to_char(v_env.declined_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') ELSE NULL END,
      'voidedAt', CASE WHEN v_env.voided_at IS NOT NULL THEN pg_catalog.to_char(v_env.voided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') ELSE NULL END,
      'expiredAt', CASE WHEN v_env.expired_at IS NOT NULL THEN pg_catalog.to_char(v_env.expired_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') ELSE NULL END,
      'createdAt', pg_catalog.to_char(v_env.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'updatedAt', pg_catalog.to_char(v_env.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'signers', v_signers
    )
  );
END $$;

REVOKE ALL ON FUNCTION crove_sign.api_key_envelope_get(text, uuid)
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.api_key_envelope_get(text, uuid) TO ludy_app;

CREATE OR REPLACE FUNCTION crove_sign.api_key_envelope_file_source(
  p_key_sha256 text,
  p_envelope_id uuid,
  p_kind text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_now timestamptz := pg_catalog.now();
  v_ctx_org uuid := ludy_kernel.ctx_org_id();
  v_ak record;
  v_env record;
BEGIN
  IF p_key_sha256 IS NULL OR p_key_sha256 !~ '^[0-9a-f]{64}$' THEN
    RETURN pg_catalog.jsonb_build_object('status', 'unauthorized');
  END IF;

  SELECT
    ak.org_id,
    ak.id AS key_id,
    ak.scopes,
    ak.last_used_at,
    t.status AS tenant_status,
    ludy_kernel.org_app_on(ak.org_id, 'sign') AS app_on
  INTO v_ak
  FROM crove_sign.api_key ak
  JOIN ludy_kernel.tenant t ON t.org_id = ak.org_id
  WHERE ak.key_sha256 = p_key_sha256
    AND ak.revoked_at IS NULL
    AND (ak.expires_at IS NULL OR ak.expires_at > v_now);

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'unauthorized');
  END IF;

  IF v_ctx_org IS NOT NULL AND (ludy_kernel.ctx_actor_type() IS DISTINCT FROM 'system' OR v_ctx_org IS DISTINCT FROM v_ak.org_id) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  IF v_ak.tenant_status IS DISTINCT FROM 'active' OR NOT v_ak.app_on THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  IF NOT ('sign:read' = ANY (v_ak.scopes)) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'forbidden');
  END IF;

  IF p_kind IS NULL OR p_kind NOT IN ('sealed', 'certificate') THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'VALIDATION',
      'httpStatus', 422,
      'message', 'Invalid file artifact kind'
    );
  END IF;

  IF v_ak.last_used_at IS NULL OR v_ak.last_used_at < v_now - interval '30 seconds' THEN
    UPDATE crove_sign.api_key
    SET last_used_at = v_now,
        updated_at = v_now
    WHERE org_id = v_ak.org_id AND id = v_ak.key_id;
  END IF;

  IF p_envelope_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('status', 'envelope_not_found');
  END IF;

  SELECT
    e.id,
    e.status,
    e.seal_status,
    e.certificate_code,
    e.sealed_storage_key,
    e.sealed_generation,
    e.sealed_sha256,
    e.certificate_storage_key,
    e.certificate_generation,
    e.certificate_sha256
  INTO v_env
  FROM crove_sign.envelope e
  WHERE e.org_id = v_ak.org_id
    AND e.id = p_envelope_id
    AND e.source_kind NOT IN ('hr_contract', 'meeting_minutes');

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'envelope_not_found');
  END IF;

  IF v_env.status <> 'completed' OR v_env.seal_status <> 'sealed' THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'SIGN_ENVELOPE_NOT_SEALED',
      'httpStatus', 409,
      'message', 'Envelope is not completed and sealed yet'
    );
  END IF;

  IF p_kind = 'sealed' THEN
    IF v_env.sealed_storage_key IS NULL OR v_env.sealed_sha256 IS NULL THEN
      RETURN pg_catalog.jsonb_build_object(
        'status', 'error',
        'code', 'SIGN_ENVELOPE_NOT_SEALED',
        'httpStatus', 409,
        'message', 'Sealed PDF is not available yet'
      );
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'status', 'ok',
      'envelopeId', v_env.id,
      'certificateCode', v_env.certificate_code,
      'storageKey', v_env.sealed_storage_key,
      'generation', v_env.sealed_generation,
      'sha256', v_env.sealed_sha256
    );
  END IF;

  IF v_env.certificate_storage_key IS NULL OR v_env.certificate_sha256 IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'SIGN_ENVELOPE_NOT_SEALED',
      'httpStatus', 409,
      'message', 'Audit certificate is not available yet'
    );
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'ok',
    'envelopeId', v_env.id,
    'certificateCode', v_env.certificate_code,
    'storageKey', v_env.certificate_storage_key,
    'generation', v_env.certificate_generation,
    'sha256', v_env.certificate_sha256
  );
END $$;

REVOKE ALL ON FUNCTION crove_sign.api_key_envelope_file_source(text, uuid, text)
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.api_key_envelope_file_source(text, uuid, text) TO ludy_app;

CREATE OR REPLACE FUNCTION crove_sign.api_key_templates_list(
  p_key_sha256 text,
  p_limit integer DEFAULT 50
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_now timestamptz := pg_catalog.now();
  v_ctx_org uuid := ludy_kernel.ctx_org_id();
  v_ak record;
  v_limit integer := GREATEST(1, LEAST(COALESCE(p_limit, 50), 100));
  v_items jsonb;
BEGIN
  IF p_key_sha256 IS NULL OR p_key_sha256 !~ '^[0-9a-f]{64}$' THEN
    RETURN pg_catalog.jsonb_build_object('status', 'unauthorized');
  END IF;

  SELECT
    ak.org_id,
    ak.id AS key_id,
    ak.scopes,
    ak.last_used_at,
    t.status AS tenant_status,
    ludy_kernel.org_app_on(ak.org_id, 'sign') AS app_on
  INTO v_ak
  FROM crove_sign.api_key ak
  JOIN ludy_kernel.tenant t ON t.org_id = ak.org_id
  WHERE ak.key_sha256 = p_key_sha256
    AND ak.revoked_at IS NULL
    AND (ak.expires_at IS NULL OR ak.expires_at > v_now);

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'unauthorized');
  END IF;

  IF v_ctx_org IS NOT NULL AND (ludy_kernel.ctx_actor_type() IS DISTINCT FROM 'system' OR v_ctx_org IS DISTINCT FROM v_ak.org_id) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  IF v_ak.tenant_status IS DISTINCT FROM 'active' OR NOT v_ak.app_on THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  IF NOT ('sign:read' = ANY (v_ak.scopes)) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'forbidden');
  END IF;

  IF v_ak.last_used_at IS NULL OR v_ak.last_used_at < v_now - interval '30 seconds' THEN
    UPDATE crove_sign.api_key
    SET last_used_at = v_now,
        updated_at = v_now
    WHERE org_id = v_ak.org_id AND id = v_ak.key_id;
  END IF;

  WITH page AS (
    SELECT
      tpl.id,
      tpl.title,
      tpl.description,
      tpl.routing_mode,
      tpl.expires_in_hours,
      tpl.inspect_status,
      tpl.page_count,
      tpl.created_at,
      tpl.updated_at
    FROM crove_sign.template tpl
    WHERE tpl.org_id = v_ak.org_id
      AND tpl.status = 'active'
    ORDER BY tpl.updated_at DESC, tpl.id DESC
    LIMIT v_limit
  )
  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', p.id,
        'title', p.title,
        'description', p.description,
        'routingMode', p.routing_mode,
        'expiresInHours', p.expires_in_hours,
        'inspectStatus', p.inspect_status,
        'pageCount', p.page_count,
        'directLinkEnabled', EXISTS (
          SELECT 1
          FROM crove_sign.template_direct_link l
          WHERE l.org_id = v_ak.org_id
            AND l.template_id = p.id
            AND l.enabled = true
            AND l.revoked_at IS NULL
            AND (l.expires_at IS NULL OR l.expires_at > v_now)
        ),
        'roles', COALESCE((
          SELECT pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'roleKey', r.role_key,
              'signerRole', r.signer_role,
              'roleLabel', r.role_label,
              'routingOrder', r.routing_order,
              'deliveryMode', r.delivery_mode,
              'requireEmailOtp', r.require_email_otp
            )
            ORDER BY r.routing_order ASC, r.created_at ASC, r.id ASC
          )
          FROM crove_sign.template_role r
          WHERE r.org_id = v_ak.org_id AND r.template_id = p.id
        ), '[]'::jsonb),
        'textFieldLabels', COALESCE((
          SELECT pg_catalog.jsonb_agg(lbl ORDER BY lbl ASC)
          FROM (
            SELECT DISTINCT f.label AS lbl
            FROM crove_sign.template_field f
            WHERE f.org_id = v_ak.org_id
              AND f.template_id = p.id
              AND f.field_type = 'text'
              AND f.label IS NOT NULL
              AND pg_catalog.btrim(f.label) <> ''
          ) d
        ), '[]'::jsonb),
        'createdAt', pg_catalog.to_char(p.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'updatedAt', pg_catalog.to_char(p.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      )
      ORDER BY p.updated_at DESC, p.id DESC
    ),
    '[]'::jsonb
  )
  INTO v_items
  FROM page p;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'ok',
    'items', v_items
  );
END $$;

REVOKE ALL ON FUNCTION crove_sign.api_key_templates_list(text, integer)
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.api_key_templates_list(text, integer) TO ludy_app;

CREATE OR REPLACE FUNCTION crove_sign.api_key_create_draft_from_template(
  p_key_sha256 text,
  p_template_id uuid,
  p_title text DEFAULT NULL,
  p_subject text DEFAULT NULL,
  p_message text DEFAULT NULL,
  p_expires_at timestamptz DEFAULT NULL,
  p_allow_delegation boolean DEFAULT NULL,
  p_recipients jsonb DEFAULT '[]'::jsonb,
  p_text_defaults jsonb DEFAULT NULL,
  p_ip_hash text DEFAULT NULL,
  p_user_agent text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_now timestamptz := pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp());
  v_ctx_org uuid := ludy_kernel.ctx_org_id();
  v_ak record;
  v_tpl record;
  v_creator uuid;
  v_title text;
  v_subject text;
  v_message text;
  v_env_expires_at timestamptz;
  v_rec jsonb;
  v_rec_key text;
  v_seen_keys text[] := ARRAY[]::text[];
  v_role record;
  v_name text;
  v_email text;
  v_phone text;
  v_delivery_mode text;
  v_require_otp boolean;
  v_env_id uuid;
  v_signer_id uuid;
  v_field record;
  v_default_val text;
  v_ip_hash text;
  v_ua text := pg_catalog.left(NULLIF(pg_catalog.btrim(pg_catalog.regexp_replace(COALESCE(p_user_agent, ''), '[[:cntrl:]]+', ' ', 'g')), ''), 500);
BEGIN
  IF p_key_sha256 IS NULL OR p_key_sha256 !~ '^[0-9a-f]{64}$' THEN
    RETURN pg_catalog.jsonb_build_object('status', 'unauthorized');
  END IF;

  SELECT
    ak.org_id,
    ak.id AS key_id,
    ak.key_prefix,
    ak.scopes,
    ak.created_by,
    ak.last_used_at,
    t.slug AS org_slug,
    t.status AS tenant_status,
    t.created_by AS tenant_created_by,
    ludy_kernel.org_app_on(ak.org_id, 'sign') AS app_on
  INTO v_ak
  FROM crove_sign.api_key ak
  JOIN ludy_kernel.tenant t ON t.org_id = ak.org_id
  WHERE ak.key_sha256 = p_key_sha256
    AND ak.revoked_at IS NULL
    AND (ak.expires_at IS NULL OR ak.expires_at > v_now);

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'unauthorized');
  END IF;

  IF v_ctx_org IS NOT NULL AND (ludy_kernel.ctx_actor_type() IS DISTINCT FROM 'system' OR v_ctx_org IS DISTINCT FROM v_ak.org_id) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  IF v_ak.tenant_status IS DISTINCT FROM 'active' OR NOT v_ak.app_on THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  IF NOT ('sign:draft' = ANY (v_ak.scopes)) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'forbidden');
  END IF;

  IF v_ak.last_used_at IS NULL OR v_ak.last_used_at < v_now - interval '30 seconds' THEN
    UPDATE crove_sign.api_key
    SET last_used_at = v_now,
        updated_at = v_now
    WHERE org_id = v_ak.org_id AND id = v_ak.key_id;
  END IF;

  IF p_template_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('status', 'template_not_found');
  END IF;

  SELECT tpl.*
  INTO v_tpl
  FROM crove_sign.template tpl
  WHERE tpl.org_id = v_ak.org_id
    AND tpl.id = p_template_id
  FOR SHARE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'template_not_found');
  END IF;

  IF v_tpl.status = 'archived' THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'SIGN_TEMPLATE_ARCHIVED',
      'httpStatus', 409,
      'message', 'Archived templates cannot instantiate envelopes'
    );
  END IF;

  IF v_tpl.inspect_status = 'failed' THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'SIGN_INSPECT_FAILED',
      'httpStatus', 409,
      'message', 'Template PDF failed inspection and cannot create envelopes'
    );
  END IF;

  IF v_tpl.inspect_status <> 'passed' OR v_tpl.page_count IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'SIGN_DOCUMENT_NOT_INSPECTED',
      'httpStatus', 409,
      'message', 'Template PDF must pass inspection before creating envelopes'
    );
  END IF;

  IF p_expires_at IS NOT NULL THEN
    IF p_expires_at <= v_now OR p_expires_at > v_now + interval '720 hours' THEN
      RETURN pg_catalog.jsonb_build_object(
        'status', 'error',
        'code', 'SIGN_INVALID_EXPIRY',
        'httpStatus', 422,
        'message', 'Envelope expiry must be in the future and at most 30 days ahead'
      );
    END IF;
    v_env_expires_at := p_expires_at;
  ELSIF v_tpl.expires_in_hours IS NOT NULL THEN
    v_env_expires_at := v_now + pg_catalog.make_interval(hours => LEAST(v_tpl.expires_in_hours, 720));
  ELSE
    v_env_expires_at := NULL;
  END IF;

  IF p_recipients IS NULL OR pg_catalog.jsonb_typeof(p_recipients) <> 'array' OR pg_catalog.jsonb_array_length(p_recipients) > 20 THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'VALIDATION',
      'httpStatus', 422,
      'message', 'recipients must be an array of at most 20 items'
    );
  END IF;

  IF p_text_defaults IS NOT NULL AND pg_catalog.jsonb_typeof(p_text_defaults) <> 'object' THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'VALIDATION',
      'httpStatus', 422,
      'message', 'textDefaults must be an object mapping field labels to strings'
    );
  END IF;

  FOR v_rec IN SELECT elem FROM pg_catalog.jsonb_array_elements(p_recipients) AS elem
  LOOP
    IF pg_catalog.jsonb_typeof(v_rec) <> 'object' THEN
      RETURN pg_catalog.jsonb_build_object(
        'status', 'error',
        'code', 'VALIDATION',
        'httpStatus', 422,
        'message', 'Each recipient entry must be an object'
      );
    END IF;
    v_rec_key := pg_catalog.btrim(COALESCE(v_rec->>'roleKey', ''));
    IF v_rec_key = '' OR NOT EXISTS (
      SELECT 1 FROM crove_sign.template_role r
      WHERE r.org_id = v_ak.org_id AND r.template_id = v_tpl.id AND r.role_key = v_rec_key
    ) THEN
      RETURN pg_catalog.jsonb_build_object(
        'status', 'error',
        'code', 'SIGN_UNKNOWN_ROLE_KEY',
        'httpStatus', 422,
        'message', 'Unknown template roleKey'
      );
    END IF;
    IF v_rec_key = ANY (v_seen_keys) THEN
      RETURN pg_catalog.jsonb_build_object(
        'status', 'error',
        'code', 'SIGN_DUPLICATE_ROLE_KEY',
        'httpStatus', 422,
        'message', 'Duplicate recipient roleKey'
      );
    END IF;
    v_seen_keys := pg_catalog.array_append(v_seen_keys, v_rec_key);
  END LOOP;

  FOR v_role IN
    SELECT r.id, r.role_key, r.signer_role, r.role_label
    FROM crove_sign.template_role r
    WHERE r.org_id = v_ak.org_id AND r.template_id = v_tpl.id
    ORDER BY r.routing_order ASC, r.created_at ASC, r.id ASC
  LOOP
    IF v_role.signer_role <> 'cc' AND NOT (v_role.role_key = ANY (v_seen_keys)) THEN
      RETURN pg_catalog.jsonb_build_object(
        'status', 'error',
        'code', 'SIGN_RECIPIENT_REQUIRED',
        'httpStatus', 422,
        'message', 'Recipient is required for every signer and approver role'
      );
    END IF;
  END LOOP;

  v_title := COALESCE(
    NULLIF(pg_catalog.btrim(pg_catalog.regexp_replace(COALESCE(p_title, ''), '[[:cntrl:]]+', ' ', 'g')), ''),
    v_tpl.title
  );
  IF pg_catalog.length(v_title) < 1 OR pg_catalog.length(v_title) > 300 THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'VALIDATION',
      'httpStatus', 422,
      'message', 'Envelope title must be between 1 and 300 characters'
    );
  END IF;

  v_subject := CASE
    WHEN p_subject IS NOT NULL THEN NULLIF(pg_catalog.btrim(pg_catalog.regexp_replace(p_subject, '[[:cntrl:]]+', ' ', 'g')), '')
    ELSE v_tpl.subject
  END;
  IF v_subject IS NOT NULL AND pg_catalog.length(v_subject) > 300 THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'VALIDATION',
      'httpStatus', 422,
      'message', 'Envelope subject must be at most 300 characters'
    );
  END IF;

  v_message := CASE
    WHEN p_message IS NOT NULL THEN NULLIF(pg_catalog.btrim(p_message), '')
    ELSE v_tpl.message
  END;
  IF v_message IS NOT NULL AND pg_catalog.length(v_message) > 5000 THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'VALIDATION',
      'httpStatus', 422,
      'message', 'Envelope message must be at most 5000 characters'
    );
  END IF;

  v_creator := COALESCE(v_ak.created_by, v_tpl.created_by, v_ak.tenant_created_by);

  -- Always creates status = 'draft' and source_kind = 'standalone'; never auto-sends or mints signing tokens.
  INSERT INTO crove_sign.envelope (
    org_id,
    title,
    subject,
    message,
    status,
    routing_mode,
    allow_delegation,
    source_kind,
    source_id,
    source_file_id,
    source_storage_key,
    source_generation,
    source_sha256,
    inspect_status,
    page_count,
    page_dimensions_json,
    detected_tags_json,
    share_summary_with_signers,
    shared_summary_json,
    expires_at,
    sent_at,
    version,
    created_by,
    created_at,
    updated_at
  )
  VALUES (
    v_ak.org_id,
    v_title,
    v_subject,
    v_message,
    'draft',
    v_tpl.routing_mode,
    COALESCE(p_allow_delegation, v_tpl.allow_delegation),
    'standalone',
    NULL,
    v_tpl.source_file_id,
    v_tpl.source_storage_key,
    v_tpl.source_generation,
    v_tpl.source_sha256,
    'passed',
    v_tpl.page_count,
    v_tpl.page_dimensions_json,
    v_tpl.detected_tags_json,
    (v_tpl.share_summary_with_signers AND v_tpl.shared_summary_json IS NOT NULL),
    CASE WHEN v_tpl.share_summary_with_signers THEN v_tpl.shared_summary_json ELSE NULL END,
    v_env_expires_at,
    NULL,
    1,
    v_creator,
    v_now,
    v_now
  )
  RETURNING id INTO v_env_id;

  FOR v_role IN
    SELECT r.id, r.role_key, r.signer_role, r.role_label, r.routing_order, r.delivery_mode, r.require_email_otp
    FROM crove_sign.template_role r
    WHERE r.org_id = v_ak.org_id AND r.template_id = v_tpl.id
    ORDER BY r.routing_order ASC, r.created_at ASC, r.id ASC
  LOOP
    SELECT elem INTO v_rec
    FROM pg_catalog.jsonb_array_elements(p_recipients) AS elem
    WHERE pg_catalog.btrim(COALESCE(elem->>'roleKey', '')) = v_role.role_key
    LIMIT 1;

    IF v_rec IS NULL THEN
      CONTINUE;
    END IF;

    v_name := pg_catalog.btrim(pg_catalog.regexp_replace(COALESCE(v_rec->>'name', ''), '[[:cntrl:]]+', ' ', 'g'));
    IF pg_catalog.length(v_name) < 1 OR pg_catalog.length(v_name) > 200 THEN
      RAISE EXCEPTION 'SIGN_INVALID_SIGNER_NAME' USING ERRCODE = '22023';
    END IF;

    v_email := NULLIF(pg_catalog.lower(pg_catalog.btrim(COALESCE(v_rec->>'email', ''))), '');
    IF v_email IS NOT NULL AND NOT crove_sign.is_single_mail_address(v_email) THEN
      RAISE EXCEPTION 'SIGN_INVALID_SIGNER_EMAIL' USING ERRCODE = '22023';
    END IF;

    v_phone := NULLIF(pg_catalog.btrim(pg_catalog.regexp_replace(COALESCE(v_rec->>'phone', ''), '[[:cntrl:]]+', ' ', 'g')), '');
    IF v_phone IS NOT NULL AND NOT (pg_catalog.length(v_phone) BETWEEN 6 AND 32) THEN
      RAISE EXCEPTION 'SIGN_INVALID_SIGNER_PHONE' USING ERRCODE = '22023';
    END IF;

    v_delivery_mode := COALESCE(NULLIF(pg_catalog.btrim(COALESCE(v_rec->>'deliveryMode', '')), ''), v_role.delivery_mode);
    IF v_delivery_mode NOT IN ('email', 'link') THEN
      RAISE EXCEPTION 'SIGN_INVALID_DELIVERY_MODE' USING ERRCODE = '22023';
    END IF;

    v_require_otp := CASE
      WHEN v_rec ? 'requireEmailOtp' AND pg_catalog.jsonb_typeof(v_rec->'requireEmailOtp') = 'boolean'
        THEN (v_rec->>'requireEmailOtp')::boolean
      ELSE v_role.require_email_otp
    END;

    IF v_role.signer_role = 'cc' AND v_require_otp THEN
      RAISE EXCEPTION 'SIGN_INVALID_SIGNER_OTP' USING ERRCODE = '22023';
    END IF;

    IF (v_delivery_mode = 'email' OR v_require_otp) AND v_email IS NULL THEN
      RAISE EXCEPTION 'SIGN_EMAIL_REQUIRED' USING ERRCODE = '22023';
    END IF;

    INSERT INTO crove_sign.signer (
      org_id,
      envelope_id,
      role_key,
      routing_order,
      signer_role,
      role_label,
      name,
      email,
      phone,
      delivery_mode,
      require_email_otp,
      status,
      created_at,
      updated_at
    )
    VALUES (
      v_ak.org_id,
      v_env_id,
      v_role.role_key,
      v_role.routing_order,
      v_role.signer_role,
      v_role.role_label,
      v_name,
      v_email,
      v_phone,
      v_delivery_mode,
      v_require_otp,
      'waiting',
      v_now,
      v_now
    )
    RETURNING id INTO v_signer_id;

    FOR v_field IN
      SELECT
        f.id,
        f.field_type,
        f.page_number,
        f.x_norm,
        f.y_norm,
        f.w_norm,
        f.h_norm,
        f.label,
        f.required,
        f.font_size_pt,
        f.options_json
      FROM crove_sign.template_field f
      WHERE f.org_id = v_ak.org_id
        AND f.template_id = v_tpl.id
        AND f.template_role_id = v_role.id
      ORDER BY f.page_number ASC, f.id ASC
    LOOP
      v_default_val := NULL;
      IF v_field.field_type = 'text' AND p_text_defaults IS NOT NULL AND v_field.label IS NOT NULL THEN
        IF p_text_defaults ? (v_role.role_key || ':' || v_field.label)
           AND pg_catalog.jsonb_typeof(p_text_defaults->(v_role.role_key || ':' || v_field.label)) = 'string' THEN
          v_default_val := NULLIF(
            pg_catalog.btrim(pg_catalog.regexp_replace(p_text_defaults->>(v_role.role_key || ':' || v_field.label), '[[:cntrl:]]+', ' ', 'g')),
            ''
          );
        ELSIF p_text_defaults ? v_field.label
              AND pg_catalog.jsonb_typeof(p_text_defaults->v_field.label) = 'string' THEN
          v_default_val := NULLIF(
            pg_catalog.btrim(pg_catalog.regexp_replace(p_text_defaults->>v_field.label, '[[:cntrl:]]+', ' ', 'g')),
            ''
          );
        END IF;
        IF v_default_val IS NOT NULL AND pg_catalog.length(v_default_val) > 2000 THEN
          RAISE EXCEPTION 'SIGN_TEXT_DEFAULT_TOO_LONG' USING ERRCODE = '22023';
        END IF;
      END IF;

      INSERT INTO crove_sign.field (
        org_id,
        envelope_id,
        signer_id,
        field_type,
        page_number,
        x_norm,
        y_norm,
        w_norm,
        h_norm,
        label,
        required,
        proposed_by_ai,
        font_size_pt,
        options_json,
        value_text,
        created_at,
        updated_at
      )
      VALUES (
        v_ak.org_id,
        v_env_id,
        v_signer_id,
        v_field.field_type,
        v_field.page_number,
        v_field.x_norm,
        v_field.y_norm,
        v_field.w_norm,
        v_field.h_norm,
        v_field.label,
        v_field.required,
        false,
        v_field.font_size_pt,
        v_field.options_json,
        v_default_val,
        v_now,
        v_now
      );
    END LOOP;
  END LOOP;

  v_ip_hash := crove_sign.public_keyed_ip_hash(v_ak.org_id, p_ip_hash);

  PERFORM crove_sign.public_append_event(
    v_ak.org_id,
    v_env_id,
    NULL,
    'envelope_created',
    'system',
    'api_key:' || v_ak.key_prefix,
    v_tpl.source_sha256,
    pg_catalog.jsonb_build_object(
      'templateId', v_tpl.id::text,
      'apiKeyId', v_ak.key_id::text,
      'routingMode', v_tpl.routing_mode,
      'sourceKind', 'standalone'
    ),
    v_ip_hash,
    v_ua,
    v_now
  );

  RETURN pg_catalog.jsonb_build_object(
    'status', 'ok',
    'id', v_env_id,
    'orgSlug', v_ak.org_slug
  );
EXCEPTION
  WHEN SQLSTATE '22023' THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', SQLERRM,
      'httpStatus', 422,
      'message', 'Invalid draft envelope request: ' || SQLERRM
    );
END $$;

REVOKE ALL ON FUNCTION crove_sign.api_key_create_draft_from_template(text, uuid, text, text, text, timestamptz, boolean, jsonb, jsonb, text, text)
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.api_key_create_draft_from_template(text, uuid, text, text, text, timestamptz, boolean, jsonb, jsonb, text, text)
  TO ludy_app;

-- ---------------------------------------------------------------------------
-- 5. Carry prefilled `textDefaults` through draft edits, public ceremony view,
--    and public submission / PDF sealing (restated from 20270208100100 & 20270209130000)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_sign.preserve_draft_field_text_defaults(
  p_envelope_id uuid,
  p_defaults jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_actor text := ludy_kernel.ctx_actor_type();
  v_user uuid := ludy_kernel.ctx_user_id();
  v_role text;
  v_env record;
  v_item jsonb;
  v_signer_id uuid;
  v_label text;
  v_val text;
BEGIN
  IF v_org IS NULL OR p_envelope_id IS NULL OR v_actor IS DISTINCT FROM 'user' OR ludy_kernel.ctx_agent_id() IS NOT NULL OR v_user IS NULL THEN
    RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF NOT ludy_kernel.org_app_on(v_org, 'sign') THEN
    RAISE EXCEPTION 'SIGN_APP_DISABLED' USING ERRCODE = '42501';
  END IF;
  SELECT m.role INTO v_role
  FROM ludy_kernel.tenant_member m
  WHERE m.org_id = v_org AND m.user_id = v_user AND m.role IN ('owner', 'admin', 'member');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  SELECT e.id, e.status, e.source_kind, e.source_id, e.created_by
  INTO v_env
  FROM crove_sign.envelope e
  WHERE e.org_id = v_org AND e.id = p_envelope_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SIGN_ENVELOPE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_env.source_kind = 'hr_contract' AND v_role NOT IN ('owner', 'admin') AND v_env.created_by IS DISTINCT FROM v_user THEN
    RAISE EXCEPTION 'SIGN_ENVELOPE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_env.source_kind = 'meeting_minutes'
     AND (v_env.source_id IS NULL OR NOT crove_sign.is_meeting_minutes_reader(v_org, v_env.source_id)) THEN
    RAISE EXCEPTION 'SIGN_ENVELOPE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_env.status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'ENVELOPE_FROZEN' USING ERRCODE = '42501';
  END IF;
  IF p_defaults IS NULL OR pg_catalog.jsonb_typeof(p_defaults) <> 'array' THEN
    RETURN;
  END IF;

  PERFORM pg_catalog.set_config('ludy.sign_preserve_text_defaults', p_envelope_id::text, true);

  FOR v_item IN SELECT elem FROM pg_catalog.jsonb_array_elements(p_defaults) elem
  LOOP
    IF pg_catalog.jsonb_typeof(v_item) <> 'object' THEN
      CONTINUE;
    END IF;
    IF COALESCE(v_item->>'signerId', '') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
      CONTINUE;
    END IF;
    v_signer_id := (v_item->>'signerId')::uuid;
    v_label := NULLIF(pg_catalog.btrim(COALESCE(v_item->>'label', '')), '');
    v_val := NULLIF(pg_catalog.btrim(pg_catalog.regexp_replace(COALESCE(v_item->>'valueText', ''), '[[:cntrl:]]+', ' ', 'g')), '');
    IF v_label IS NULL OR v_val IS NULL OR pg_catalog.length(v_val) > 2000 THEN
      CONTINUE;
    END IF;

    UPDATE crove_sign.field
    SET value_text = v_val,
        updated_at = pg_catalog.now()
    WHERE org_id = v_org
      AND envelope_id = p_envelope_id
      AND signer_id = v_signer_id
      AND field_type = 'text'
      AND label = v_label
      AND filled_at IS NULL;
  END LOOP;

  PERFORM pg_catalog.set_config('ludy.sign_preserve_text_defaults', '', true);
END $$;

REVOKE ALL ON FUNCTION crove_sign.preserve_draft_field_text_defaults(uuid, jsonb)
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.preserve_draft_field_text_defaults(uuid, jsonb) TO ludy_tenant;

CREATE OR REPLACE FUNCTION crove_sign.field_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_actor text := ludy_kernel.ctx_actor_type();
  v_env_id uuid := COALESCE(OLD.envelope_id, NEW.envelope_id);
  v_org uuid := COALESCE(OLD.org_id, NEW.org_id);
  v_env_status text;
  v_env_sealed_file_id uuid;
  v_erase_owner oid := (SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.oid = 'crove_sign.personal_erase_unsealed_signers(text,text)'::pg_catalog.regprocedure);
  v_preserve_owner oid := (SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.oid = 'crove_sign.preserve_draft_field_text_defaults(uuid,jsonb)'::pg_catalog.regprocedure);
  v_cur_role oid := (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = CURRENT_USER);
BEGIN
  IF v_actor IS NULL OR v_actor = 'system' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.org_id IS DISTINCT FROM ludy_kernel.ctx_org_id() THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND (pg_catalog.to_jsonb(OLD) - ARRAY['updated_at']) IS NOT DISTINCT FROM (pg_catalog.to_jsonb(NEW) - ARRAY['updated_at']) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.org_id, NEW.id, NEW.envelope_id, NEW.created_at) IS DISTINCT FROM (OLD.org_id, OLD.id, OLD.envelope_id, OLD.created_at) THEN
    RAISE EXCEPTION 'FIELD_IMMUTABLE' USING ERRCODE = '42501';
  END IF;
  SELECT e.status, e.sealed_file_id INTO v_env_status, v_env_sealed_file_id
  FROM crove_sign.envelope e WHERE e.org_id = v_org AND e.id = v_env_id FOR SHARE;
  IF TG_OP = 'DELETE' THEN
    IF v_env_status = 'draft' THEN
      RETURN OLD;
    END IF;
    IF v_env_status IN ('voided', 'expired', 'declined')
       AND v_env_sealed_file_id IS NULL
       AND v_cur_role = v_erase_owner
       AND pg_catalog.current_setting('crove.sign_personal_erase', true) = OLD.org_id::text
       AND v_actor = 'user'
       AND ludy_kernel.ctx_agent_id() IS NULL
       AND ludy_kernel.ctx_org_id() = OLD.org_id
       AND EXISTS (
         SELECT 1 FROM ludy_kernel.tenant_member m
         WHERE m.org_id = OLD.org_id AND m.user_id = ludy_kernel.ctx_user_id() AND m.role = 'owner'
       ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'ENVELOPE_FROZEN' USING ERRCODE = '42501', DETAIL = 'fields cannot change after envelope is sent';
  END IF;
  IF v_env_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'ENVELOPE_FROZEN' USING ERRCODE = '42501', DETAIL = 'fields cannot change after envelope is sent';
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW.field_type = 'text'
     AND NEW.filled_at IS NULL
     AND NEW.value_checked IS NULL
     AND NEW.signature_png_base64 IS NULL
     AND NEW.attachment_file_id IS NULL
     AND v_cur_role = v_preserve_owner
     AND pg_catalog.current_setting('ludy.sign_preserve_text_defaults', true) = NEW.envelope_id::text THEN
    RETURN NEW;
  END IF;
  IF NEW.value_text IS NOT NULL
     OR NEW.value_checked IS NOT NULL
     OR NEW.signature_png_base64 IS NOT NULL
     OR NEW.attachment_file_id IS NOT NULL
     OR NEW.attachment_filename IS NOT NULL
     OR NEW.attachment_content_type IS NOT NULL
     OR NEW.attachment_size_bytes IS NOT NULL
     OR NEW.attachment_sha256 IS NOT NULL
     OR NEW.filled_at IS NOT NULL THEN
    RAISE EXCEPTION 'FIELD_SYSTEM_ONLY' USING ERRCODE = '42501', DETAIL = 'field values and attachments are filled only through public signing';
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION crove_sign.field_guard()
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;

CREATE OR REPLACE FUNCTION crove_sign.public_record_view(
  p_token_sha256 text,
  p_ip_hash text DEFAULT NULL,
  p_user_agent text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_now timestamptz := pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp());
  v_lookup record;
  v_env record;
  v_signer record;
  v_tok record;
  v_tenant record;
  v_otp_verified boolean := false;
  v_in_person boolean := false;
  v_ip_hash text;
  v_ua text := pg_catalog.left(NULLIF(pg_catalog.btrim(pg_catalog.regexp_replace(COALESCE(p_user_agent, ''), '[[:cntrl:]]+', ' ', 'g')), ''), 500);
  v_actor_label text;
  v_fields jsonb := '[]'::jsonb;
BEGIN
  IF p_token_sha256 IS NULL OR p_token_sha256 !~ '^[0-9a-f]{64}$' THEN
    RETURN NULL;
  END IF;

  SELECT tok.id AS token_id, tok.org_id, tok.envelope_id, tok.signer_id
  INTO v_lookup
  FROM crove_sign.signing_token tok
  WHERE tok.token_sha256 = p_token_sha256;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- Canonical lock order: envelope -> signer -> signing_token (public_append_event also holds envelope FOR UPDATE).
  SELECT e.*
  INTO v_env
  FROM crove_sign.envelope e
  WHERE e.org_id = v_lookup.org_id
    AND e.id = v_lookup.envelope_id
  FOR UPDATE;

  SELECT s.*
  INTO v_signer
  FROM crove_sign.signer s
  WHERE s.org_id = v_lookup.org_id
    AND s.envelope_id = v_lookup.envelope_id
    AND s.id = v_lookup.signer_id
  FOR UPDATE;

  SELECT tok.*
  INTO v_tok
  FROM crove_sign.signing_token tok
  WHERE tok.org_id = v_lookup.org_id
    AND tok.id = v_lookup.token_id
  FOR UPDATE;

  SELECT t.name, t.status
  INTO v_tenant
  FROM ludy_kernel.tenant t
  WHERE t.org_id = v_lookup.org_id;

  IF v_tenant.status IS DISTINCT FROM 'active'
     OR NOT ludy_kernel.org_app_on(v_lookup.org_id, 'sign')
     OR v_tok.revoked_at IS NOT NULL
     OR v_tok.used_at IS NOT NULL
     OR v_tok.expires_at <= v_now
     OR v_signer.signer_role = 'cc'
     OR v_signer.status NOT IN ('pending', 'viewed')
     OR v_env.status NOT IN ('sent', 'in_progress')
     OR (v_env.expires_at IS NOT NULL AND v_env.expires_at <= v_now) THEN
    RETURN NULL;
  END IF;

  v_in_person := v_tok.in_person_host_user_id IS NOT NULL;

  UPDATE crove_sign.signing_token
  SET last_viewed_at = v_now
  WHERE org_id = v_lookup.org_id
    AND id = v_tok.id;

  IF v_signer.status = 'pending' THEN
    v_ip_hash := crove_sign.public_keyed_ip_hash(v_lookup.org_id, p_ip_hash);
    v_actor_label := COALESCE(NULLIF(pg_catalog.btrim(pg_catalog.regexp_replace(COALESCE(v_signer.email, v_signer.name), '[[:cntrl:]]+', ' ', 'g')), ''), 'Signer');
    v_actor_label := pg_catalog.left(v_actor_label, 254);

    UPDATE crove_sign.signer
    SET status = 'viewed',
        viewed_at = COALESCE(v_signer.viewed_at, v_now),
        signer_ip_hash = COALESCE(v_ip_hash, v_signer.signer_ip_hash),
        signer_user_agent = COALESCE(v_ua, v_signer.signer_user_agent),
        updated_at = v_now
    WHERE org_id = v_lookup.org_id
      AND id = v_signer.id;

    PERFORM crove_sign.public_append_event(
      v_lookup.org_id,
      v_env.id,
      v_signer.id,
      'signer_viewed',
      'signer',
      v_actor_label,
      v_env.source_sha256,
      pg_catalog.jsonb_build_object('routingOrder', v_signer.routing_order),
      v_ip_hash,
      v_ua,
      v_now
    );
  END IF;

  v_otp_verified := crove_sign.public_otp_verified_at_for_token(v_lookup.org_id, v_signer.id, v_tok.id) IS NOT NULL;
  IF v_signer.require_email_otp AND NOT v_otp_verified THEN
    RETURN pg_catalog.jsonb_build_object(
      'state', 'otp_required',
      'orgName', v_tenant.name,
      'title', v_env.title,
      'maskedEmail', crove_sign.mask_email(v_signer.email),
      'inPerson', v_in_person
    );
  END IF;

  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', f.id,
        'fieldType', f.field_type,
        'pageNumber', f.page_number,
        'xNorm', f.x_norm::text,
        'yNorm', f.y_norm::text,
        'wNorm', f.w_norm::text,
        'hNorm', f.h_norm::text,
        'label', f.label,
        'required', f.required,
        'fontSizePt', f.font_size_pt,
        'valueText', f.value_text,
        'options', f.options_json,
        'attachment', CASE WHEN f.attachment_file_id IS NOT NULL THEN pg_catalog.jsonb_build_object(
          'fileId', f.attachment_file_id,
          'filename', f.attachment_filename,
          'contentType', f.attachment_content_type,
          'sizeBytes', f.attachment_size_bytes,
          'sha256', f.attachment_sha256,
          'uploadedAt', CASE WHEN f.filled_at IS NOT NULL
            THEN pg_catalog.to_char(f.filled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
            ELSE NULL END
        ) ELSE NULL END
      )
      ORDER BY f.page_number, f.y_norm, f.x_norm, f.id
    ),
    '[]'::jsonb
  )
  INTO v_fields
  FROM crove_sign.field f
  WHERE f.org_id = v_lookup.org_id
    AND f.envelope_id = v_env.id
    AND f.signer_id = v_signer.id;

  RETURN pg_catalog.jsonb_build_object(
    'state', 'ready',
    'orgName', v_tenant.name,
    'title', v_env.title,
    'message', v_env.message,
    'signerName', v_signer.name,
    'roleLabel', v_signer.role_label,
    'signerRole', CASE WHEN v_signer.signer_role = 'approver' THEN 'approver' ELSE 'signer' END,
    'expiresAt', pg_catalog.to_char(v_tok.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'pageCount', COALESCE(v_env.page_count, 1),
    'pageDimensions', COALESCE(v_env.page_dimensions_json, '[]'::jsonb),
    'requireEmailOtp', v_signer.require_email_otp,
    'otpVerified', v_otp_verified,
    'allowDelegation', (v_env.allow_delegation AND v_tok.in_person_host_user_id IS NULL AND v_signer.signer_role IN ('signer', 'approver') AND v_signer.delegation_count < 2),
    'delegationCount', v_signer.delegation_count,
    'delegatedFromName', v_signer.delegated_from_name,
    'inPerson', v_in_person,
    'fields', v_fields,
    'sharedSummary', CASE
      WHEN v_env.share_summary_with_signers AND v_env.shared_summary_json IS NOT NULL THEN v_env.shared_summary_json
      ELSE NULL
    END
  );
END $$;

REVOKE ALL ON FUNCTION crove_sign.public_record_view(text, text, text)
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.public_record_view(text, text, text) TO ludy_app;

CREATE OR REPLACE FUNCTION crove_sign.public_submit(
  p_token_sha256 text,
  p_consent_accepted boolean,
  p_signature_kind text,
  p_signature_typed_text text,
  p_fields jsonb,
  p_ip_hash text DEFAULT NULL,
  p_user_agent text DEFAULT NULL,
  p_message_id_domain text DEFAULT 'crove.invalid'
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_now timestamptz := pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp());
  v_lookup record;
  v_env record;
  v_signer record;
  v_tok record;
  v_tenant record;
  v_otp_verified boolean := false;
  v_field record;
  v_sub jsonb;
  v_sub_text text;
  v_sub_png text;
  v_raw_b64 text;
  v_png_bytes bytea;
  v_sub_checked boolean;
  v_saw_sig_png boolean := false;
  v_filled_count integer := 0;
  v_sig_kind text;
  v_typed_text text := pg_catalog.left(NULLIF(pg_catalog.btrim(COALESCE(p_signature_typed_text, '')), ''), 200);
  v_ip_hash text;
  v_ua text := pg_catalog.left(NULLIF(pg_catalog.btrim(pg_catalog.regexp_replace(COALESCE(p_user_agent, ''), '[[:cntrl:]]+', ' ', 'g')), ''), 500);
  v_actor_label text;
  v_total_signers integer := 0;
  v_remaining integer := 0;
  v_all_completed boolean := false;
  v_next_env_status text;
  v_next_order integer;
  v_outbox_id uuid;
  v_domain text := CASE WHEN p_message_id_domain IS NOT NULL AND pg_catalog.btrim(p_message_id_domain) ~ '^[A-Za-z0-9.-]{1,120}$'
    THEN pg_catalog.lower(pg_catalog.btrim(p_message_id_domain)) ELSE 'crove.invalid' END;
  v_org_name text;
  v_doc_title text;
  v_next_signer record;
  v_to_email text;
  v_to_hash text;
  v_suppressed boolean;
  v_invalid_field_count integer := 0;
  v_dup_field_count integer := 0;
BEGIN
  IF p_token_sha256 IS NULL OR p_token_sha256 !~ '^[0-9a-f]{64}$' THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  SELECT tok.id AS token_id, tok.org_id, tok.envelope_id, tok.signer_id
  INTO v_lookup
  FROM crove_sign.signing_token tok
  WHERE tok.token_sha256 = p_token_sha256;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  -- Canonical lock order: envelope -> signer (all envelope signers ORDER BY id) -> signing_token -> field (ORDER BY id).
  SELECT e.*
  INTO v_env
  FROM crove_sign.envelope e
  WHERE e.org_id = v_lookup.org_id
    AND e.id = v_lookup.envelope_id
  FOR UPDATE;

  PERFORM 1
  FROM crove_sign.signer s
  WHERE s.org_id = v_lookup.org_id
    AND s.envelope_id = v_lookup.envelope_id
  ORDER BY s.id
  FOR UPDATE;

  SELECT s.*
  INTO v_signer
  FROM crove_sign.signer s
  WHERE s.org_id = v_lookup.org_id
    AND s.id = v_lookup.signer_id;

  SELECT tok.*
  INTO v_tok
  FROM crove_sign.signing_token tok
  WHERE tok.org_id = v_lookup.org_id
    AND tok.id = v_lookup.token_id
  FOR UPDATE;

  SELECT t.name, t.status
  INTO v_tenant
  FROM ludy_kernel.tenant t
  WHERE t.org_id = v_lookup.org_id;

  IF v_tenant.status IS DISTINCT FROM 'active'
     OR NOT ludy_kernel.org_app_on(v_lookup.org_id, 'sign')
     OR v_tok.revoked_at IS NOT NULL
     OR v_tok.expires_at <= v_now
     OR v_signer.signer_role = 'cc'
     OR v_signer.status IN ('waiting', 'voided', 'expired')
     OR v_env.status IN ('draft', 'voided', 'expired')
     OR (v_tok.used_at IS NULL AND v_signer.status IN ('pending', 'viewed') AND v_env.expires_at IS NOT NULL AND v_env.expires_at <= v_now) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  IF v_tok.used_at IS NOT NULL OR v_signer.status IN ('signed', 'declined') OR v_env.status NOT IN ('sent', 'in_progress') THEN
    RETURN pg_catalog.jsonb_build_object('status', 'already_used');
  END IF;

  IF NOT COALESCE(p_consent_accepted, false) THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'SIGN_CONSENT_REQUIRED',
      'httpStatus', 422,
      'message', 'Electronic signature consent must be accepted before submitting'
    );
  END IF;

  v_otp_verified := crove_sign.public_otp_verified_at_for_token(v_lookup.org_id, v_signer.id, v_tok.id) IS NOT NULL;
  IF v_signer.require_email_otp AND NOT v_otp_verified THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'SIGN_OTP_REQUIRED',
      'httpStatus', 403,
      'message', 'Email OTP verification is required before signing'
    );
  END IF;

  IF p_signature_kind IS NOT NULL AND p_signature_kind NOT IN ('draw', 'type') THEN
    RETURN pg_catalog.jsonb_build_object('status', 'error', 'code', 'VALIDATION', 'httpStatus', 422, 'message', 'Invalid signature kind');
  END IF;

  IF p_fields IS NULL OR pg_catalog.jsonb_typeof(p_fields) <> 'array' THEN
    RETURN pg_catalog.jsonb_build_object('status', 'error', 'code', 'VALIDATION', 'httpStatus', 422, 'message', 'fields must be an array');
  END IF;

  SELECT pg_catalog.count(*)::integer
  INTO v_invalid_field_count
  FROM pg_catalog.jsonb_array_elements(p_fields) elem
  WHERE pg_catalog.jsonb_typeof(elem) <> 'object'
     OR COALESCE(elem->>'fieldId', '') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
     OR NOT EXISTS (
       SELECT 1
       FROM crove_sign.field f
       WHERE f.org_id = v_lookup.org_id
         AND f.envelope_id = v_env.id
         AND f.signer_id = v_signer.id
         AND f.id = (elem->>'fieldId')::uuid
     );

  IF v_invalid_field_count > 0 THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'SIGN_INVALID_FIELD',
      'httpStatus', 422,
      'message', 'Submitted field is not assigned to this signer'
    );
  END IF;

  SELECT pg_catalog.count(*)::integer
  INTO v_dup_field_count
  FROM (
    SELECT (elem->>'fieldId')::uuid AS fid
    FROM pg_catalog.jsonb_array_elements(p_fields) elem
    GROUP BY (elem->>'fieldId')::uuid
    HAVING pg_catalog.count(*) > 1
  ) dup;

  IF v_dup_field_count > 0 THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'SIGN_DUPLICATE_FIELD',
      'httpStatus', 422,
      'message', 'Duplicate submission for the same field'
    );
  END IF;

  -- Lock signer fields in id order and validate all required values, option choices, attachments, and PNG headers before any mutation.
  FOR v_field IN
    SELECT f.*
    FROM crove_sign.field f
    WHERE f.org_id = v_lookup.org_id
      AND f.envelope_id = v_env.id
      AND f.signer_id = v_signer.id
    ORDER BY f.id
    FOR UPDATE
  LOOP
    SELECT elem INTO v_sub
    FROM pg_catalog.jsonb_array_elements(p_fields) elem
    WHERE (elem->>'fieldId')::uuid = v_field.id
    LIMIT 1;

    IF v_field.field_type IN ('signature', 'stamp') THEN
      v_sub_png := NULLIF(v_sub->>'signaturePngBase64', '');
      v_sub_text := NULLIF(pg_catalog.btrim(COALESCE(v_sub->>'valueText', '')), '');
      IF v_sub_text IS NOT NULL AND pg_catalog.length(v_sub_text) > 2000 THEN
        RETURN pg_catalog.jsonb_build_object('status', 'error', 'code', 'VALIDATION', 'httpStatus', 422, 'message', 'Signature text exceeds maximum length');
      END IF;
      IF v_sub_png IS NOT NULL THEN
        v_raw_b64 := CASE
          WHEN v_sub_png LIKE 'data:image/png;base64,%' THEN pg_catalog.substr(v_sub_png, 23)
          WHEN v_sub_png LIKE 'data:%' THEN NULL
          ELSE v_sub_png
        END;
        IF v_raw_b64 IS NULL OR pg_catalog.length(v_raw_b64) > 360000 OR v_raw_b64 !~ '^[A-Za-z0-9+/]+={0,2}$' THEN
          RETURN pg_catalog.jsonb_build_object('status', 'error', 'code', 'SIGN_INVALID_SIGNATURE_PNG', 'httpStatus', 422, 'message', 'Signature or stamp PNG is malformed');
        END IF;
        BEGIN
          v_png_bytes := pg_catalog.decode(v_raw_b64, 'base64');
        EXCEPTION WHEN OTHERS THEN
          RETURN pg_catalog.jsonb_build_object('status', 'error', 'code', 'SIGN_INVALID_SIGNATURE_PNG', 'httpStatus', 422, 'message', 'Signature or stamp PNG base64 decode failed');
        END;
        IF pg_catalog.octet_length(v_png_bytes) < 45
           OR pg_catalog.octet_length(v_png_bytes) > 262144
           OR pg_catalog.substr(v_png_bytes, 1, 8) IS DISTINCT FROM '\x89504e470d0a1a0a'::bytea THEN
          RETURN pg_catalog.jsonb_build_object('status', 'error', 'code', 'SIGN_INVALID_SIGNATURE_PNG', 'httpStatus', 422, 'message', 'Signature or stamp payload does not contain a valid PNG image');
        END IF;
        v_saw_sig_png := true;
      ELSIF v_field.required THEN
        RETURN pg_catalog.jsonb_build_object(
          'status', 'error',
          'code', 'SIGN_FIELD_REQUIRED',
          'httpStatus', 422,
          'message', CASE WHEN v_field.field_type = 'stamp'
            THEN 'Required stamp field is missing a PNG stamp'
            ELSE 'Required signature field is missing a PNG signature' END
        );
      END IF;
    ELSIF v_field.field_type = 'initials' THEN
      v_sub_png := NULLIF(v_sub->>'signaturePngBase64', '');
      v_sub_text := NULLIF(pg_catalog.btrim(COALESCE(v_sub->>'valueText', '')), '');
      IF v_sub_text IS NOT NULL AND pg_catalog.length(v_sub_text) > 2000 THEN
        RETURN pg_catalog.jsonb_build_object('status', 'error', 'code', 'VALIDATION', 'httpStatus', 422, 'message', 'Initials text exceeds maximum length');
      END IF;
      IF v_sub_png IS NOT NULL THEN
        v_raw_b64 := CASE
          WHEN v_sub_png LIKE 'data:image/png;base64,%' THEN pg_catalog.substr(v_sub_png, 23)
          WHEN v_sub_png LIKE 'data:%' THEN NULL
          ELSE v_sub_png
        END;
        IF v_raw_b64 IS NULL OR pg_catalog.length(v_raw_b64) > 360000 OR v_raw_b64 !~ '^[A-Za-z0-9+/]+={0,2}$' THEN
          RETURN pg_catalog.jsonb_build_object('status', 'error', 'code', 'SIGN_INVALID_SIGNATURE_PNG', 'httpStatus', 422, 'message', 'Initials PNG is malformed');
        END IF;
        BEGIN
          v_png_bytes := pg_catalog.decode(v_raw_b64, 'base64');
        EXCEPTION WHEN OTHERS THEN
          RETURN pg_catalog.jsonb_build_object('status', 'error', 'code', 'SIGN_INVALID_SIGNATURE_PNG', 'httpStatus', 422, 'message', 'Initials PNG base64 decode failed');
        END;
        IF pg_catalog.octet_length(v_png_bytes) < 45
           OR pg_catalog.octet_length(v_png_bytes) > 262144
           OR pg_catalog.substr(v_png_bytes, 1, 8) IS DISTINCT FROM '\x89504e470d0a1a0a'::bytea THEN
          RETURN pg_catalog.jsonb_build_object('status', 'error', 'code', 'SIGN_INVALID_SIGNATURE_PNG', 'httpStatus', 422, 'message', 'Initials payload does not contain a valid PNG image');
        END IF;
      END IF;
      IF v_sub_png IS NULL AND v_sub_text IS NULL AND v_field.required THEN
        RETURN pg_catalog.jsonb_build_object('status', 'error', 'code', 'SIGN_FIELD_REQUIRED', 'httpStatus', 422, 'message', 'Required initials field must be provided');
      END IF;
    ELSIF v_field.field_type = 'text' THEN
      IF v_sub IS NOT NULL AND v_sub ? 'valueText' THEN
        v_sub_text := NULLIF(pg_catalog.btrim(COALESCE(v_sub->>'valueText', '')), '');
      ELSE
        v_sub_text := NULLIF(pg_catalog.btrim(COALESCE(v_field.value_text, '')), '');
      END IF;
      IF v_sub_text IS NOT NULL AND pg_catalog.length(v_sub_text) > 2000 THEN
        RETURN pg_catalog.jsonb_build_object('status', 'error', 'code', 'VALIDATION', 'httpStatus', 422, 'message', 'Field text exceeds maximum length');
      END IF;
      IF v_sub_text IS NULL AND v_field.required THEN
        RETURN pg_catalog.jsonb_build_object('status', 'error', 'code', 'SIGN_FIELD_REQUIRED', 'httpStatus', 422, 'message', 'Required text or date field must not be empty');
      END IF;
    ELSIF v_field.field_type = 'date' THEN
      v_sub_text := NULLIF(pg_catalog.btrim(COALESCE(v_sub->>'valueText', '')), '');
      IF v_sub_text IS NOT NULL AND pg_catalog.length(v_sub_text) > 2000 THEN
        RETURN pg_catalog.jsonb_build_object('status', 'error', 'code', 'VALIDATION', 'httpStatus', 422, 'message', 'Field text exceeds maximum length');
      END IF;
      IF v_sub_text IS NULL AND v_field.required THEN
        RETURN pg_catalog.jsonb_build_object('status', 'error', 'code', 'SIGN_FIELD_REQUIRED', 'httpStatus', 422, 'message', 'Required text or date field must not be empty');
      END IF;
    ELSIF v_field.field_type = 'checkbox' THEN
      IF v_sub IS NOT NULL AND v_sub ? 'valueChecked' THEN
        IF pg_catalog.jsonb_typeof(v_sub->'valueChecked') <> 'boolean' THEN
          RETURN pg_catalog.jsonb_build_object('status', 'error', 'code', 'VALIDATION', 'httpStatus', 422, 'message', 'Checkbox value must be a boolean');
        END IF;
        v_sub_checked := (v_sub->>'valueChecked')::boolean;
        IF v_field.required AND v_sub_checked IS DISTINCT FROM true THEN
          RETURN pg_catalog.jsonb_build_object('status', 'error', 'code', 'SIGN_FIELD_REQUIRED', 'httpStatus', 422, 'message', 'Required checkbox field must be checked');
        END IF;
      ELSIF v_field.required THEN
        RETURN pg_catalog.jsonb_build_object('status', 'error', 'code', 'SIGN_FIELD_REQUIRED', 'httpStatus', 422, 'message', 'Required checkbox field must be checked');
      END IF;
    ELSIF v_field.field_type IN ('dropdown', 'radio') THEN
      v_sub_text := NULLIF(pg_catalog.btrim(COALESCE(v_sub->>'valueText', '')), '');
      IF v_sub_text IS NOT NULL THEN
        IF v_field.options_json IS NULL OR NOT EXISTS (
          SELECT 1
          FROM pg_catalog.jsonb_array_elements_text(v_field.options_json) AS opt(val)
          WHERE opt.val = v_sub_text
        ) THEN
          RETURN pg_catalog.jsonb_build_object(
            'status', 'error',
            'code', 'SIGN_INVALID_FIELD_OPTION',
            'httpStatus', 422,
            'message', 'Submitted choice is not among the allowed options for this field'
          );
        END IF;
      ELSIF v_field.required THEN
        RETURN pg_catalog.jsonb_build_object(
          'status', 'error',
          'code', 'SIGN_FIELD_REQUIRED',
          'httpStatus', 422,
          'message', 'Required choice field must have a selected option'
        );
      END IF;
    ELSIF v_field.field_type = 'attachment' THEN
      IF v_field.required AND v_field.attachment_file_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object(
          'status', 'error',
          'code', 'SIGN_ATTACHMENT_REQUIRED',
          'httpStatus', 422,
          'message', 'Required supporting attachment must be uploaded before submitting'
        );
      END IF;
    END IF;
  END LOOP;

  -- Consume token atomically once all checks passed.
  UPDATE crove_sign.signing_token
  SET used_at = v_now
  WHERE org_id = v_lookup.org_id
    AND id = v_tok.id
    AND used_at IS NULL
    AND revoked_at IS NULL;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'already_used');
  END IF;

  -- Persist validated field values (strip any optional data:image/png;base64, prefix uniformly).
  FOR v_field IN
    SELECT f.*
    FROM crove_sign.field f
    WHERE f.org_id = v_lookup.org_id
      AND f.envelope_id = v_env.id
      AND f.signer_id = v_signer.id
    ORDER BY f.id
  LOOP
    SELECT elem INTO v_sub
    FROM pg_catalog.jsonb_array_elements(p_fields) elem
    WHERE (elem->>'fieldId')::uuid = v_field.id
    LIMIT 1;

    IF v_field.field_type = 'signature' THEN
      v_sub_png := NULLIF(v_sub->>'signaturePngBase64', '');
      IF v_sub_png IS NOT NULL THEN
        IF v_sub_png LIKE 'data:image/png;base64,%' THEN
          v_sub_png := pg_catalog.substr(v_sub_png, 23);
        END IF;
        v_filled_count := v_filled_count + 1;
        UPDATE crove_sign.field
        SET signature_png_base64 = v_sub_png,
            value_text = COALESCE(v_typed_text, NULLIF(pg_catalog.btrim(COALESCE(v_sub->>'valueText', '')), '')),
            filled_at = v_now,
            updated_at = v_now
        WHERE org_id = v_lookup.org_id AND id = v_field.id;
      END IF;
    ELSIF v_field.field_type = 'stamp' THEN
      v_sub_png := NULLIF(v_sub->>'signaturePngBase64', '');
      IF v_sub_png IS NOT NULL THEN
        IF v_sub_png LIKE 'data:image/png;base64,%' THEN
          v_sub_png := pg_catalog.substr(v_sub_png, 23);
        END IF;
        v_filled_count := v_filled_count + 1;
        UPDATE crove_sign.field
        SET signature_png_base64 = v_sub_png,
            value_text = NULLIF(pg_catalog.btrim(COALESCE(v_sub->>'valueText', '')), ''),
            filled_at = v_now,
            updated_at = v_now
        WHERE org_id = v_lookup.org_id AND id = v_field.id;
      END IF;
    ELSIF v_field.field_type = 'initials' THEN
      v_sub_png := NULLIF(v_sub->>'signaturePngBase64', '');
      IF v_sub_png IS NOT NULL AND v_sub_png LIKE 'data:image/png;base64,%' THEN
        v_sub_png := pg_catalog.substr(v_sub_png, 23);
      END IF;
      v_sub_text := NULLIF(pg_catalog.btrim(COALESCE(v_sub->>'valueText', '')), '');
      IF v_sub_png IS NOT NULL OR v_sub_text IS NOT NULL THEN
        v_filled_count := v_filled_count + 1;
        UPDATE crove_sign.field
        SET signature_png_base64 = v_sub_png,
            value_text = v_sub_text,
            filled_at = v_now,
            updated_at = v_now
        WHERE org_id = v_lookup.org_id AND id = v_field.id;
      END IF;
    ELSIF v_field.field_type = 'text' THEN
      IF v_sub IS NOT NULL AND v_sub ? 'valueText' THEN
        v_sub_text := NULLIF(pg_catalog.btrim(COALESCE(v_sub->>'valueText', '')), '');
      ELSE
        v_sub_text := NULLIF(pg_catalog.btrim(COALESCE(v_field.value_text, '')), '');
      END IF;
      IF v_sub_text IS NOT NULL THEN
        v_filled_count := v_filled_count + 1;
        UPDATE crove_sign.field
        SET value_text = v_sub_text,
            filled_at = v_now,
            updated_at = v_now
        WHERE org_id = v_lookup.org_id AND id = v_field.id;
      ELSIF v_field.value_text IS NOT NULL THEN
        UPDATE crove_sign.field
        SET value_text = NULL,
            filled_at = NULL,
            updated_at = v_now
        WHERE org_id = v_lookup.org_id AND id = v_field.id;
      END IF;
    ELSIF v_field.field_type IN ('date', 'dropdown', 'radio') THEN
      v_sub_text := NULLIF(pg_catalog.btrim(COALESCE(v_sub->>'valueText', '')), '');
      IF v_sub_text IS NOT NULL THEN
        v_filled_count := v_filled_count + 1;
        UPDATE crove_sign.field
        SET value_text = v_sub_text,
            filled_at = v_now,
            updated_at = v_now
        WHERE org_id = v_lookup.org_id AND id = v_field.id;
      END IF;
    ELSIF v_field.field_type = 'checkbox' THEN
      IF v_sub IS NOT NULL AND v_sub ? 'valueChecked' THEN
        v_filled_count := v_filled_count + 1;
        UPDATE crove_sign.field
        SET value_checked = (v_sub->>'valueChecked')::boolean,
            filled_at = v_now,
            updated_at = v_now
        WHERE org_id = v_lookup.org_id AND id = v_field.id;
      END IF;
    ELSIF v_field.field_type = 'attachment' THEN
      IF v_field.attachment_file_id IS NOT NULL THEN
        v_filled_count := v_filled_count + 1;
      END IF;
    END IF;
  END LOOP;

  v_ip_hash := crove_sign.public_keyed_ip_hash(v_lookup.org_id, p_ip_hash);
  v_sig_kind := COALESCE(p_signature_kind, CASE WHEN v_typed_text IS NOT NULL THEN 'type' WHEN v_saw_sig_png THEN 'draw' ELSE NULL END);

  UPDATE crove_sign.signer
  SET status = 'signed',
      signed_at = v_now,
      consent_accepted_at = COALESCE(v_signer.consent_accepted_at, v_now),
      signature_kind = v_sig_kind,
      signature_typed_text = v_typed_text,
      signer_ip_hash = COALESCE(v_ip_hash, v_signer.signer_ip_hash),
      signer_user_agent = COALESCE(v_ua, v_signer.signer_user_agent),
      updated_at = v_now
  WHERE org_id = v_lookup.org_id
    AND id = v_signer.id;

  SELECT
    pg_catalog.count(*) FILTER (WHERE s.signer_role <> 'cc')::integer,
    pg_catalog.count(*) FILTER (WHERE s.signer_role <> 'cc' AND s.status <> 'signed')::integer
  INTO v_total_signers, v_remaining
  FROM crove_sign.signer s
  WHERE s.org_id = v_lookup.org_id
    AND s.envelope_id = v_env.id;

  v_all_completed := v_remaining = 0;
  v_next_env_status := CASE WHEN v_all_completed THEN 'completed' ELSE 'in_progress' END;

  UPDATE crove_sign.envelope
  SET status = v_next_env_status,
      completed_at = CASE WHEN v_all_completed THEN v_now ELSE completed_at END,
      version = v_env.version + 1,
      updated_at = v_now
  WHERE org_id = v_lookup.org_id
    AND id = v_env.id;

  v_actor_label := COALESCE(NULLIF(pg_catalog.btrim(pg_catalog.regexp_replace(COALESCE(v_signer.email, v_signer.name), '[[:cntrl:]]+', ' ', 'g')), ''), 'Signer');
  v_actor_label := pg_catalog.left(v_actor_label, 254);

  IF v_tok.in_person_host_user_id IS NOT NULL THEN
    PERFORM crove_sign.public_append_event_with_host(
      v_lookup.org_id,
      v_env.id,
      v_signer.id,
      'in_person_signed',
      'signer',
      v_actor_label,
      v_env.source_sha256,
      pg_catalog.jsonb_build_object(
        'routingOrder', v_signer.routing_order,
        'signatureKind', v_sig_kind,
        'filledFields', v_filled_count,
        'hostUserId', v_tok.in_person_host_user_id::text
      ),
      v_ip_hash,
      v_ua,
      v_now,
      v_tok.in_person_host_user_id
    );
  ELSE
    PERFORM crove_sign.public_append_event(
      v_lookup.org_id,
      v_env.id,
      v_signer.id,
      'signer_signed',
      'signer',
      v_actor_label,
      v_env.source_sha256,
      pg_catalog.jsonb_build_object(
        'routingOrder', v_signer.routing_order,
        'signatureKind', v_sig_kind,
        'filledFields', v_filled_count
      ),
      v_ip_hash,
      v_ua,
      v_now
    );
  END IF;

  PERFORM crove_sign.webhook_enqueue_internal(
    v_lookup.org_id,
    v_env.id,
    'sign.signer.signed',
    v_next_env_status,
    v_now,
    v_signer.id,
    v_signer.signer_role,
    v_now,
    NULL,
    NULL,
    NULL
  );

  IF v_all_completed THEN
    PERFORM crove_sign.public_append_event(
      v_lookup.org_id,
      v_env.id,
      NULL,
      'envelope_completed',
      'system',
      'system:sign-public',
      v_env.source_sha256,
      pg_catalog.jsonb_build_object('completedSignerCount', v_total_signers),
      NULL,
      NULL,
      v_now
    );

    INSERT INTO ludy_kernel.outbox_event (org_id, type, payload, actor_type)
    VALUES (
      v_lookup.org_id,
      'sign.envelope.seal_queued',
      pg_catalog.jsonb_build_object('envelopeId', v_env.id::text),
      'system'
    )
    RETURNING id INTO v_outbox_id;

    INSERT INTO ludy_kernel.outbox_pending (org_id, event_id)
    VALUES (v_lookup.org_id, v_outbox_id);

    PERFORM pg_catalog.pg_notify('ludy_outbox', '');
  ELSIF v_env.routing_mode = 'sequential' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM crove_sign.signer s
      WHERE s.org_id = v_lookup.org_id
        AND s.envelope_id = v_env.id
        AND s.signer_role <> 'cc'
        AND s.status <> 'signed'
        AND s.routing_order <= v_signer.routing_order
    ) THEN
      SELECT pg_catalog.min(s.routing_order)
      INTO v_next_order
      FROM crove_sign.signer s
      WHERE s.org_id = v_lookup.org_id
        AND s.envelope_id = v_env.id
        AND s.signer_role <> 'cc'
        AND s.status = 'waiting';

      IF v_next_order IS NOT NULL THEN
        v_org_name := COALESCE(NULLIF(pg_catalog.left(pg_catalog.btrim(pg_catalog.regexp_replace(v_tenant.name, '[[:cntrl:]]+', ' ', 'g')), 200), ''), 'Ludy');
        v_doc_title := COALESCE(NULLIF(pg_catalog.left(pg_catalog.btrim(pg_catalog.regexp_replace(v_env.title, '[[:cntrl:]]+', ' ', 'g')), 300), ''), 'Tai lieu');

        FOR v_next_signer IN
          UPDATE crove_sign.signer s
          SET status = 'pending',
              updated_at = v_now
          WHERE s.org_id = v_lookup.org_id
            AND s.envelope_id = v_env.id
            AND s.signer_role <> 'cc'
            AND s.status = 'waiting'
            AND s.routing_order = v_next_order
          RETURNING s.id, s.delivery_mode, s.email, s.role_label
        LOOP
          IF v_next_signer.delivery_mode = 'email' AND v_next_signer.email IS NOT NULL THEN
            v_to_email := pg_catalog.lower(pg_catalog.btrim(v_next_signer.email));
            v_to_hash := ludy_kernel.mail_address_hash(v_to_email);
            IF v_to_hash IS NOT NULL THEN
              SELECT EXISTS (
                SELECT 1
                FROM ludy_kernel.mail_suppression ms
                WHERE ms.org_id = v_lookup.org_id
                  AND ms.to_hash = v_to_hash
                  AND ms.scope = 'all'
                  AND ms.lifted_at IS NULL
              )
              INTO v_suppressed;

              INSERT INTO ludy_kernel.mail_message (
                org_id, stream, source, source_id, template_key, to_address, to_hash,
                subject, payload, message_id_header, status, created_by
              )
              VALUES (
                v_lookup.org_id,
                'transactional',
                'sign.envelope.send',
                v_next_signer.id,
                'sign.invite',
                v_to_email,
                v_to_hash,
                pg_catalog.left('Moi ky: ' || v_doc_title, 300),
                pg_catalog.jsonb_build_object(
                  'lang', 'vi',
                  'orgName', v_org_name,
                  'envelopeId', v_env.id::text,
                  'signerId', v_next_signer.id::text,
                  'docTitle', v_doc_title,
                  'roleLabel', COALESCE(NULLIF(pg_catalog.left(pg_catalog.btrim(pg_catalog.regexp_replace(v_next_signer.role_label, '[[:cntrl:]]+', ' ', 'g')), 120), ''), 'Nguoi ky'),
                  'expiresAt', CASE WHEN v_env.expires_at IS NOT NULL
                    THEN pg_catalog.to_char(v_env.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
                    ELSE NULL END
                ),
                '<' || pg_catalog.gen_random_uuid()::text || '@' || v_domain || '>',
                CASE WHEN v_suppressed THEN 'suppressed' ELSE 'queued' END,
                NULL
              );
            END IF;
          END IF;
        END LOOP;
      END IF;
    END IF;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'ok',
    'signerId', v_signer.id,
    'signerStatus', 'signed',
    'envelopeStatus', v_next_env_status,
    'completed', v_all_completed,
    'inPerson', v_tok.in_person_host_user_id IS NOT NULL,
    'signedAt', pg_catalog.to_char(v_now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
END $$;

REVOKE ALL ON FUNCTION crove_sign.public_submit(text, boolean, text, text, jsonb, text, text, text)
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.public_submit(text, boolean, text, text, jsonb, text, text, text) TO ludy_app;
