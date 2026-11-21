-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove eSign Slice 2c (docs/plan/esign.md, issue #3554): Vietnam CA provider connection machinery
-- (crove_sign.ca_connection) and reconcile_only PAdES signing requests (crove_sign.ca_signing_request).
-- Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. Machinery table: crove_sign.ca_connection (definer-only, zero runtime grants)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_sign.ca_connection (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  provider text NOT NULL CHECK (provider IN ('sandbox', 'vnpt_smartca', 'viettel_mysign', 'misa_wesign')),
  label text NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(label)) BETWEEN 1 AND 200),
  cert_ref text NOT NULL DEFAULT 'sandbox-default' CHECK (pg_catalog.length(pg_catalog.btrim(cert_ref)) BETWEEN 1 AND 300),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  key_id text NOT NULL CHECK (pg_catalog.length(key_id) BETWEEN 1 AND 128),
  secret_envelope text NOT NULL CHECK (pg_catalog.length(secret_envelope) BETWEEN 1 AND 16384),
  last_test_state text CHECK (
    last_test_state IS NULL OR last_test_state IN (
      'works',
      'wrong_credentials',
      'api_not_enabled',
      'ip_not_allowed',
      'unreachable',
      'signing_needs_person',
      'usb_token_unsupported'
    )
  ),
  last_tested_at timestamptz,
  created_by uuid REFERENCES crove_kernel.user_account (id),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT ca_connection_test_ck CHECK ((last_test_state IS NULL) = (last_tested_at IS NULL))
);

CREATE INDEX IF NOT EXISTS ca_connection_org_provider_idx
  ON crove_sign.ca_connection (org_id, provider, created_at DESC);

ALTER TABLE crove_sign.ca_connection ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON crove_sign.ca_connection FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
SELECT crove_kernel.agent_write_guard_install('crove_sign.ca_connection');

-- ---------------------------------------------------------------------------
-- 2. Tenant table: crove_sign.ca_signing_request (reconcile_only PAdES requests)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_sign.ca_signing_request (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  envelope_id uuid NOT NULL,
  signer_id uuid,
  ca_connection_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('sandbox', 'vnpt_smartca', 'viettel_mysign', 'misa_wesign')),
  idempotency_key uuid NOT NULL,
  digest_sha256 text NOT NULL CHECK (digest_sha256 ~ '^[0-9a-f]{64}$'),
  cert_ref text NOT NULL DEFAULT 'sandbox-default' CHECK (pg_catalog.length(pg_catalog.btrim(cert_ref)) BETWEEN 1 AND 300),
  external_tx_id text CHECK (external_tx_id IS NULL OR pg_catalog.length(pg_catalog.btrim(external_tx_id)) BETWEEN 1 AND 256),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'signed', 'rejected', 'expired', 'failed')),
  retry_safety text NOT NULL DEFAULT 'reconcile_only' CHECK (retry_safety IN ('reconcile_only')),
  challenge_code text CHECK (challenge_code IS NULL OR pg_catalog.length(challenge_code) <= 64),
  error_code text CHECK (error_code IS NULL OR pg_catalog.length(error_code) <= 128),
  sub_filter text CHECK (sub_filter IS NULL OR sub_filter IN ('ETSI.CAdES.detached', 'adbe.pkcs7.detached')),
  pades_file_id uuid,
  pades_storage_key text CHECK (pades_storage_key IS NULL OR pg_catalog.length(pades_storage_key) BETWEEN 1 AND 512),
  pades_generation text CHECK (pades_generation IS NULL OR pg_catalog.length(pades_generation) BETWEEN 1 AND 1028),
  pades_sha256 text CHECK (pades_sha256 IS NULL OR pades_sha256 ~ '^[0-9a-f]{64}$'),
  poll_attempts integer NOT NULL DEFAULT 0 CHECK (poll_attempts >= 0 AND poll_attempts <= 1000),
  next_poll_at timestamptz,
  signed_at timestamptz,
  created_by uuid REFERENCES crove_kernel.user_account (id),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT ca_signing_request_idempotency_uq UNIQUE (org_id, idempotency_key),
  CONSTRAINT ca_signing_request_envelope_fk FOREIGN KEY (org_id, envelope_id) REFERENCES crove_sign.envelope (org_id, id) ON DELETE CASCADE,
  CONSTRAINT ca_signing_request_signer_fk FOREIGN KEY (org_id, signer_id) REFERENCES crove_sign.signer (org_id, id) ON DELETE CASCADE,
  CONSTRAINT ca_signing_request_connection_fk FOREIGN KEY (org_id, ca_connection_id) REFERENCES crove_sign.ca_connection (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT ca_signing_request_pades_file_fk FOREIGN KEY (org_id, pades_file_id) REFERENCES crove_kernel.file (org_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS ca_signing_request_envelope_idx
  ON crove_sign.ca_signing_request (org_id, envelope_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ca_signing_request_signer_idx
  ON crove_sign.ca_signing_request (org_id, signer_id)
  WHERE signer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ca_signing_request_connection_idx
  ON crove_sign.ca_signing_request (org_id, ca_connection_id);
CREATE INDEX IF NOT EXISTS ca_signing_request_pades_file_idx
  ON crove_sign.ca_signing_request (org_id, pades_file_id)
  WHERE pades_file_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ca_signing_request_pending_due_idx
  ON crove_sign.ca_signing_request (org_id, updated_at, id)
  WHERE status = 'pending' OR (status = 'signed' AND pades_file_id IS NULL);

-- ---------------------------------------------------------------------------
-- 3. RLS, writer policies, and guard trigger on crove_sign.ca_signing_request
-- ---------------------------------------------------------------------------
SELECT crove_kernel.apply_tenant_rls('crove_sign.ca_signing_request');

DO $$
DECLARE
  v_write_check text := '((SELECT crove_kernel.ctx_actor_type()) IN (''system'', ''agent'') OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = ca_signing_request.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN (''owner'', ''admin'')))';
BEGIN
  EXECUTE 'DROP POLICY IF EXISTS writer_insert ON crove_sign.ca_signing_request';
  EXECUTE 'CREATE POLICY writer_insert ON crove_sign.ca_signing_request AS RESTRICTIVE FOR INSERT TO crove_tenant WITH CHECK ' || v_write_check;
  EXECUTE 'DROP POLICY IF EXISTS writer_update ON crove_sign.ca_signing_request';
  EXECUTE 'CREATE POLICY writer_update ON crove_sign.ca_signing_request AS RESTRICTIVE FOR UPDATE TO crove_tenant USING ' || v_write_check || ' WITH CHECK ' || v_write_check;
  EXECUTE 'DROP POLICY IF EXISTS writer_delete ON crove_sign.ca_signing_request';
  EXECUTE 'CREATE POLICY writer_delete ON crove_sign.ca_signing_request AS RESTRICTIVE FOR DELETE TO crove_tenant USING ' || v_write_check;
END $$;

DROP POLICY IF EXISTS hr_contract_envelope_access ON crove_sign.ca_signing_request;
CREATE POLICY hr_contract_envelope_access ON crove_sign.ca_signing_request AS RESTRICTIVE FOR ALL TO crove_tenant
  USING (
    EXISTS (
      SELECT 1 FROM crove_sign.envelope e
      WHERE e.org_id = ca_signing_request.org_id AND e.id = ca_signing_request.envelope_id
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM crove_sign.envelope e
      WHERE e.org_id = ca_signing_request.org_id AND e.id = ca_signing_request.envelope_id
    )
  );

CREATE OR REPLACE FUNCTION crove_sign.ca_signing_request_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_actor text := crove_kernel.ctx_actor_type();
BEGIN
  IF v_actor IS NULL OR v_actor = 'system' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'pending' OR OLD.external_tx_id IS NOT NULL OR OLD.poll_attempts <> 0 OR OLD.signed_at IS NOT NULL THEN
      RAISE EXCEPTION 'CA_SIGNING_REQUEST_FROZEN'
        USING ERRCODE = '42501', DETAIL = 'submitted or completed CA signing requests cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.org_id IS DISTINCT FROM crove_kernel.ctx_org_id() THEN
      RETURN NEW;
    END IF;
    IF NEW.status <> 'pending'
       OR NEW.retry_safety <> 'reconcile_only'
       OR NEW.external_tx_id IS NOT NULL
       OR NEW.challenge_code IS NOT NULL
       OR NEW.error_code IS NOT NULL
       OR NEW.sub_filter IS NOT NULL
       OR NEW.pades_file_id IS NOT NULL
       OR NEW.pades_storage_key IS NOT NULL
       OR NEW.pades_generation IS NOT NULL
       OR NEW.pades_sha256 IS NOT NULL
       OR NEW.poll_attempts <> 0
       OR NEW.signed_at IS NOT NULL THEN
      RAISE EXCEPTION 'CA_SIGNING_REQUEST_FORBIDDEN'
        USING ERRCODE = '42501', DETAIL = 'a CA signing request starts as pending reconcile_only without provider output';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE by tenant user: allow no-op updates only; reconciliation fields are system-managed.
  IF NEW.org_id IS DISTINCT FROM crove_kernel.ctx_org_id() THEN
    RETURN NEW;
  END IF;
  IF (pg_catalog.to_jsonb(OLD) - ARRAY['updated_at']) IS NOT DISTINCT FROM (pg_catalog.to_jsonb(NEW) - ARRAY['updated_at']) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'CA_SIGNING_REQUEST_SYSTEM_ONLY'
    USING ERRCODE = '42501', DETAIL = 'CA signing request reconciliation state is system-managed';
END $$;

DROP TRIGGER IF EXISTS ca_signing_request_guard ON crove_sign.ca_signing_request;
CREATE TRIGGER ca_signing_request_guard
  BEFORE INSERT OR UPDATE OR DELETE ON crove_sign.ca_signing_request
  FOR EACH ROW EXECUTE FUNCTION crove_sign.ca_signing_request_guard();

REVOKE ALL ON FUNCTION crove_sign.ca_signing_request_guard()
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- ---------------------------------------------------------------------------
-- 4. SECURITY DEFINER helpers for crove_sign.ca_connection
-- ---------------------------------------------------------------------------

-- Non-secret metadata list for workspace members (never reads or exposes key_id or secret_envelope).
CREATE OR REPLACE FUNCTION crove_sign.ca_connection_list()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_actor text := crove_kernel.ctx_actor_type();
  v_user uuid := crove_kernel.ctx_user_id();
  v_out jsonb;
BEGIN
  IF v_org IS NULL OR v_actor IS NULL THEN
    RAISE EXCEPTION 'SIGN_CONTEXT_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF v_actor NOT IN ('user', 'system') THEN
    RAISE EXCEPTION 'SIGN_FORBIDDEN_ACTOR' USING ERRCODE = '42501';
  END IF;
  IF NOT crove_kernel.org_app_on(v_org, 'sign') THEN
    RAISE EXCEPTION 'SIGN_APP_DISABLED' USING ERRCODE = '42501';
  END IF;
  IF v_actor = 'user' THEN
    IF v_user IS NULL OR NOT EXISTS (
      SELECT 1 FROM crove_kernel.tenant_member m
      WHERE m.org_id = v_org AND m.user_id = v_user
    ) THEN
      RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
  END IF;

  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', c.id,
        'provider', c.provider,
        'label', c.label,
        'certRef', c.cert_ref,
        'status', c.status,
        'lastTestState', c.last_test_state,
        'lastTestedAt', c.last_tested_at,
        'createdBy', c.created_by,
        'createdAt', c.created_at,
        'updatedAt', c.updated_at
      )
      ORDER BY c.provider ASC, c.created_at DESC, c.id DESC
    ),
    '[]'::jsonb
  )
  INTO v_out
  FROM crove_sign.ca_connection c
  WHERE c.org_id = v_org;

  RETURN v_out;
END $$;

REVOKE ALL ON FUNCTION crove_sign.ca_connection_list()
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.ca_connection_list() TO crove_tenant;

-- Looks up the existing connection id for (org, provider) before the API seals fresh credentials bound to that id.
CREATE OR REPLACE FUNCTION crove_sign.ca_connection_lookup_id(p_provider text)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_actor text := crove_kernel.ctx_actor_type();
  v_user uuid := crove_kernel.ctx_user_id();
  v_id uuid;
BEGIN
  IF v_org IS NULL OR v_actor IS DISTINCT FROM 'user' OR crove_kernel.ctx_agent_id() IS NOT NULL OR v_user IS NULL THEN
    RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF NOT crove_kernel.org_app_on(v_org, 'sign') THEN
    RAISE EXCEPTION 'SIGN_APP_DISABLED' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m
    WHERE m.org_id = v_org AND m.user_id = v_user AND m.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  SELECT c.id INTO v_id
  FROM crove_sign.ca_connection c
  WHERE c.org_id = v_org AND c.provider = p_provider
  ORDER BY c.created_at DESC, c.id DESC
  LIMIT 1;

  RETURN v_id;
END $$;

REVOKE ALL ON FUNCTION crove_sign.ca_connection_lookup_id(text)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.ca_connection_lookup_id(text) TO crove_app, crove_worker;

-- Configures or updates an org CA connection (owners and admins only, never agents). Returns non-secret metadata only.
CREATE OR REPLACE FUNCTION crove_sign.ca_connection_upsert(
  p_id uuid,
  p_provider text,
  p_label text,
  p_cert_ref text,
  p_status text,
  p_key_id text,
  p_secret_envelope text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_actor text := crove_kernel.ctx_actor_type();
  v_user uuid := crove_kernel.ctx_user_id();
  v_now timestamptz := pg_catalog.now();
  v_existing_id uuid;
  v_target_id uuid;
  v_key text;
  v_env text;
  v_row crove_sign.ca_connection%ROWTYPE;
BEGIN
  IF v_org IS NULL OR v_actor IS DISTINCT FROM 'user' OR crove_kernel.ctx_agent_id() IS NOT NULL OR v_user IS NULL THEN
    RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF NOT crove_kernel.org_app_on(v_org, 'sign') THEN
    RAISE EXCEPTION 'SIGN_APP_DISABLED' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m
    WHERE m.org_id = v_org AND m.user_id = v_user AND m.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_provider IS NULL OR p_provider NOT IN ('sandbox', 'vnpt_smartca', 'viettel_mysign', 'misa_wesign') THEN
    RAISE EXCEPTION 'CA_INVALID_PROVIDER' USING ERRCODE = '22023';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('active', 'disabled') THEN
    RAISE EXCEPTION 'CA_INVALID_STATUS' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('sign.ca_connection:' || v_org::text || ':' || p_provider, 0)
  );

  v_key := CASE WHEN p_status = 'disabled' THEN 'disabled' ELSE p_key_id END;
  v_env := CASE WHEN p_status = 'disabled' THEN 'disabled' ELSE p_secret_envelope END;

  SELECT c.id INTO v_existing_id
  FROM crove_sign.ca_connection c
  WHERE c.org_id = v_org AND c.provider = p_provider
  ORDER BY c.created_at DESC, c.id DESC
  LIMIT 1
  FOR UPDATE;

  IF v_existing_id IS NOT NULL THEN
    IF p_id IS NOT NULL AND p_id <> v_existing_id THEN
      RAISE EXCEPTION 'CA_CONNECTION_ID_CONFLICT' USING ERRCODE = '40001';
    END IF;
    UPDATE crove_sign.ca_connection
    SET label = pg_catalog.btrim(p_label),
        cert_ref = pg_catalog.btrim(p_cert_ref),
        status = p_status,
        key_id = v_key,
        secret_envelope = v_env,
        last_test_state = NULL,
        last_tested_at = NULL,
        created_by = v_user,
        updated_at = v_now
    WHERE org_id = v_org AND id = v_existing_id
    RETURNING * INTO v_row;

    -- Wipe any older duplicate rows for the same provider if present.
    UPDATE crove_sign.ca_connection
    SET status = 'disabled',
        key_id = 'disabled',
        secret_envelope = 'disabled',
        last_test_state = NULL,
        last_tested_at = NULL,
        updated_at = v_now
    WHERE org_id = v_org AND provider = p_provider AND id <> v_existing_id AND status <> 'disabled';
  ELSE
    v_target_id := COALESCE(p_id, crove_kernel.uuid_v7());
    INSERT INTO crove_sign.ca_connection (
      org_id, id, provider, label, cert_ref, status, key_id, secret_envelope, created_by, created_at, updated_at
    )
    VALUES (
      v_org,
      v_target_id,
      p_provider,
      pg_catalog.btrim(p_label),
      pg_catalog.btrim(p_cert_ref),
      p_status,
      v_key,
      v_env,
      v_user,
      v_now,
      v_now
    )
    RETURNING * INTO v_row;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'id', v_row.id,
    'provider', v_row.provider,
    'label', v_row.label,
    'certRef', v_row.cert_ref,
    'status', v_row.status,
    'lastTestState', v_row.last_test_state,
    'lastTestedAt', v_row.last_tested_at,
    'createdBy', v_row.created_by,
    'createdAt', v_row.created_at,
    'updatedAt', v_row.updated_at
  );
END $$;

REVOKE ALL ON FUNCTION crove_sign.ca_connection_upsert(uuid, text, text, text, text, text, text)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.ca_connection_upsert(uuid, text, text, text, text, text, text) TO crove_app, crove_worker;

-- Disables a CA connection and wipes its stored secret ciphertext.
CREATE OR REPLACE FUNCTION crove_sign.ca_connection_disable(p_connection_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_actor text := crove_kernel.ctx_actor_type();
  v_user uuid := crove_kernel.ctx_user_id();
  v_row crove_sign.ca_connection%ROWTYPE;
BEGIN
  IF v_org IS NULL OR p_connection_id IS NULL OR v_actor IS DISTINCT FROM 'user' OR crove_kernel.ctx_agent_id() IS NOT NULL OR v_user IS NULL THEN
    RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF NOT crove_kernel.org_app_on(v_org, 'sign') THEN
    RAISE EXCEPTION 'SIGN_APP_DISABLED' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m
    WHERE m.org_id = v_org AND m.user_id = v_user AND m.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  UPDATE crove_sign.ca_connection
  SET status = 'disabled',
      key_id = 'disabled',
      secret_envelope = 'disabled',
      last_test_state = NULL,
      last_tested_at = NULL,
      updated_at = pg_catalog.now()
  WHERE org_id = v_org AND id = p_connection_id
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CA_CONNECTION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'id', v_row.id,
    'provider', v_row.provider,
    'label', v_row.label,
    'certRef', v_row.cert_ref,
    'status', v_row.status,
    'lastTestState', v_row.last_test_state,
    'lastTestedAt', v_row.last_tested_at,
    'createdBy', v_row.created_by,
    'createdAt', v_row.created_at,
    'updatedAt', v_row.updated_at
  );
END $$;

REVOKE ALL ON FUNCTION crove_sign.ca_connection_disable(uuid)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.ca_connection_disable(uuid) TO crove_app, crove_worker;

-- Records the categorical result of a connection test (never raw provider text).
CREATE OR REPLACE FUNCTION crove_sign.ca_connection_record_test(
  p_connection_id uuid,
  p_state text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_actor text := crove_kernel.ctx_actor_type();
  v_user uuid := crove_kernel.ctx_user_id();
  v_now timestamptz := pg_catalog.now();
  v_row crove_sign.ca_connection%ROWTYPE;
BEGIN
  IF v_org IS NULL OR p_connection_id IS NULL OR v_actor IS NULL THEN
    RAISE EXCEPTION 'SIGN_CONTEXT_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF NOT crove_kernel.org_app_on(v_org, 'sign') THEN
    RAISE EXCEPTION 'SIGN_APP_DISABLED' USING ERRCODE = '42501';
  END IF;
  IF v_actor = 'user' THEN
    IF crove_kernel.ctx_agent_id() IS NOT NULL OR v_user IS NULL OR NOT EXISTS (
      SELECT 1 FROM crove_kernel.tenant_member m
      WHERE m.org_id = v_org AND m.user_id = v_user AND m.role IN ('owner', 'admin')
    ) THEN
      RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
  ELSIF v_actor <> 'system' THEN
    RAISE EXCEPTION 'SIGN_FORBIDDEN_ACTOR' USING ERRCODE = '42501';
  END IF;

  IF p_state IS NULL OR p_state NOT IN (
    'works',
    'wrong_credentials',
    'api_not_enabled',
    'ip_not_allowed',
    'unreachable',
    'signing_needs_person',
    'usb_token_unsupported'
  ) THEN
    RAISE EXCEPTION 'CA_INVALID_TEST_STATE' USING ERRCODE = '22023';
  END IF;

  UPDATE crove_sign.ca_connection
  SET last_test_state = p_state,
      last_tested_at = v_now,
      updated_at = v_now
  WHERE org_id = v_org AND id = p_connection_id
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CA_CONNECTION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'id', v_row.id,
    'provider', v_row.provider,
    'label', v_row.label,
    'certRef', v_row.cert_ref,
    'status', v_row.status,
    'lastTestState', v_row.last_test_state,
    'lastTestedAt', v_row.last_tested_at,
    'createdBy', v_row.created_by,
    'createdAt', v_row.created_at,
    'updatedAt', v_row.updated_at
  );
END $$;

REVOKE ALL ON FUNCTION crove_sign.ca_connection_record_test(uuid, text)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.ca_connection_record_test(uuid, text) TO crove_app, crove_worker;

-- Worker-only secret reader: opens sealed CA credentials in the org's system context only when the connection is active
-- and the owner/admin who configured it is still an active owner/admin in the org.
CREATE OR REPLACE FUNCTION crove_sign.ca_connection_secret_get(p_connection_id uuid)
RETURNS TABLE(id uuid, provider text, cert_ref text, key_id text, secret_envelope text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_conn crove_sign.ca_connection%ROWTYPE;
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'CA_SECRET_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF v_org IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'system' THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  IF NOT crove_kernel.org_app_on(v_org, 'sign') THEN
    RAISE EXCEPTION 'SIGN_APP_DISABLED' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_conn
  FROM crove_sign.ca_connection c
  WHERE c.org_id = v_org AND c.id = p_connection_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CA_CONNECTION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_conn.status <> 'active' THEN
    RAISE EXCEPTION 'CA_CONNECTION_DISABLED' USING ERRCODE = '55000';
  END IF;
  IF v_conn.created_by IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM crove_kernel.tenant_member m
    JOIN crove_kernel.user_account u ON u.id = m.user_id
    WHERE m.org_id = v_org
      AND m.user_id = v_conn.created_by
      AND m.role IN ('owner', 'admin')
      AND u.disabled_at IS NULL
  ) THEN
    RAISE EXCEPTION 'CA_CONNECTION_OWNER_LEFT' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT v_conn.id, v_conn.provider, v_conn.cert_ref, v_conn.key_id, v_conn.secret_envelope;
END $$;

REVOKE ALL ON FUNCTION crove_sign.ca_connection_secret_get(uuid)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.ca_connection_secret_get(uuid) TO crove_worker;

-- Worker recovery & due-poll candidate lookup for pending CA signing requests while Sign is on.
CREATE OR REPLACE FUNCTION crove_sign.ca_work_recovery_candidates(
  p_older_than timestamptz,
  p_limit integer DEFAULT 100,
  p_org_id uuid DEFAULT NULL,
  p_after_due_at timestamptz DEFAULT NULL,
  p_after_org_id uuid DEFAULT NULL,
  p_after_request_id uuid DEFAULT NULL
)
RETURNS TABLE(org_id uuid, request_id uuid, due_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500);
  v_has_cursor boolean := p_after_due_at IS NOT NULL
    AND p_after_org_id IS NOT NULL
    AND p_after_request_id IS NOT NULL;
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'SIGN_RECOVERY_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF (p_after_due_at IS NULL) <> (p_after_org_id IS NULL)
     OR (p_after_due_at IS NULL) <> (p_after_request_id IS NULL) THEN
    RAISE EXCEPTION 'SIGN_RECOVERY_INVALID_CURSOR' USING ERRCODE = '22023';
  END IF;
  IF p_older_than IS NULL THEN
    RAISE EXCEPTION 'SIGN_CUTOFF_REQUIRED' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT q.org_id, q.request_id, q.due_at
  FROM (
    SELECT r.org_id, r.id AS request_id, COALESCE(r.next_poll_at, r.updated_at) AS due_at
    FROM crove_sign.ca_signing_request r
    JOIN crove_kernel.tenant tn ON tn.org_id = r.org_id
    WHERE tn.status = 'active'
      AND (p_org_id IS NULL OR r.org_id = p_org_id)
      AND crove_kernel.org_app_on(r.org_id, 'sign')
      AND (r.status = 'pending' OR (r.status = 'signed' AND r.pades_file_id IS NULL))
      AND COALESCE(r.next_poll_at, r.updated_at) <= p_older_than
  ) q
  WHERE (NOT v_has_cursor OR (q.due_at, q.org_id, q.request_id) > (p_after_due_at, p_after_org_id, p_after_request_id))
  ORDER BY q.due_at ASC, q.org_id ASC, q.request_id ASC
  LIMIT v_limit;
END $$;

REVOKE ALL ON FUNCTION crove_sign.ca_work_recovery_candidates(timestamptz, integer, uuid, timestamptz, uuid, uuid)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.ca_work_recovery_candidates(timestamptz, integer, uuid, timestamptz, uuid, uuid) TO crove_worker;

-- ---------------------------------------------------------------------------
-- 5. Sign file read authorization helper (restated from 20270115180000 to cover pades_file_id)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_sign.can_read_sign_file(p_file_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_actor text := crove_kernel.ctx_actor_type();
  v_user uuid := crove_kernel.ctx_user_id();
  v_role text;
BEGIN
  IF v_org IS NULL OR v_actor IS NULL OR p_file_id IS NULL THEN
    RETURN false;
  END IF;
  IF v_actor = 'system' THEN
    RETURN true;
  END IF;
  IF v_actor <> 'user' OR v_user IS NULL THEN
    RETURN false;
  END IF;

  SELECT m.role INTO v_role
  FROM crove_kernel.tenant_member m
  WHERE m.org_id = v_org AND m.user_id = v_user;

  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF v_role IN ('owner', 'admin') THEN
    RETURN true;
  END IF;

  -- Creator of an hr_contract envelope retains access to its source, sealed, PAdES, and certificate files.
  IF EXISTS (
    SELECT 1 FROM crove_sign.envelope e
    WHERE e.org_id = v_org
      AND e.source_kind = 'hr_contract'
      AND e.created_by = v_user
      AND (
        e.source_file_id = p_file_id
        OR e.sealed_file_id = p_file_id
        OR e.certificate_file_id = p_file_id
        OR EXISTS (
          SELECT 1 FROM crove_sign.ca_signing_request r
          WHERE r.org_id = e.org_id
            AND r.envelope_id = e.id
            AND r.pades_file_id = p_file_id
        )
      )
  ) THEN
    RETURN true;
  END IF;

  -- Sealed PDFs, PAdES PDFs, and certificates of hr_contract envelopes created by another user are strictly confidential.
  IF EXISTS (
    SELECT 1 FROM crove_sign.envelope e
    WHERE e.org_id = v_org
      AND e.source_kind = 'hr_contract'
      AND (
        e.sealed_file_id = p_file_id
        OR e.certificate_file_id = p_file_id
        OR EXISTS (
          SELECT 1 FROM crove_sign.ca_signing_request r
          WHERE r.org_id = e.org_id
            AND r.envelope_id = e.id
            AND r.pades_file_id = p_file_id
        )
      )
  ) THEN
    RETURN false;
  END IF;

  -- Blank organization-wide template PDFs stay readable by workspace members even after an owner/admin
  -- instantiates an hr_contract envelope from that template (template.create forbids using confidential HR PDFs).
  IF EXISTS (
    SELECT 1 FROM crove_sign.template t
    WHERE t.org_id = v_org
      AND t.source_file_id = p_file_id
  ) THEN
    RETURN true;
  END IF;

  -- Dedicated source PDFs of hr_contract envelopes created by another user block ordinary members and viewers.
  IF EXISTS (
    SELECT 1 FROM crove_sign.envelope e
    WHERE e.org_id = v_org
      AND e.source_kind = 'hr_contract'
      AND e.source_file_id = p_file_id
  ) THEN
    RETURN false;
  END IF;

  -- Non-HR sign files are readable once attached to a non-HR envelope, or by their uploader while unattached.
  RETURN EXISTS (
    SELECT 1 FROM crove_sign.envelope e
    WHERE e.org_id = v_org
      AND e.source_kind <> 'hr_contract'
      AND (
        e.source_file_id = p_file_id
        OR e.sealed_file_id = p_file_id
        OR e.certificate_file_id = p_file_id
        OR EXISTS (
          SELECT 1 FROM crove_sign.ca_signing_request r
          WHERE r.org_id = e.org_id
            AND r.envelope_id = e.id
            AND r.pades_file_id = p_file_id
        )
      )
  ) OR EXISTS (
    SELECT 1 FROM crove_kernel.file f
    WHERE f.org_id = v_org
      AND f.id = p_file_id
      AND f.created_by = v_user
  );
END $$;

REVOKE ALL ON FUNCTION crove_sign.can_read_sign_file(uuid)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.can_read_sign_file(uuid) TO crove_tenant;

-- ---------------------------------------------------------------------------
-- 6. Queue for CA PAdES initiation & reconcile_only polling
-- ---------------------------------------------------------------------------
SELECT crove_jobs.create_queue('sign-ca-reconcile', '{"policy":"exclusive","deadLetter":"kernel-job.dlq"}'::jsonb);
