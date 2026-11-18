-- SPDX-License-Identifier: AGPL-3.0-only
-- eSign Slice 2b A4 (#3553, docs/plan/esign.md, owner decisions 2026-11-08 and 2026-11-17):
-- strict owner / admin / created_by confidentiality on source_kind = 'hr_contract' envelopes across
-- PostgreSQL RLS policies, signing token/template SECURITY DEFINER helpers, and sign file reads.

SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. Restrictive RLS policies for source_kind = 'hr_contract' on crove_sign
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS hr_contract_select ON crove_sign.envelope;
CREATE POLICY hr_contract_select ON crove_sign.envelope AS RESTRICTIVE FOR SELECT TO crove_tenant
  USING (
    source_kind <> 'hr_contract'
    OR (SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR (
      (SELECT crove_kernel.ctx_actor_type()) = 'user'
      AND EXISTS (
        SELECT 1 FROM crove_kernel.tenant_member m
        WHERE m.org_id = envelope.org_id
          AND m.user_id = (SELECT crove_kernel.ctx_user_id())
          AND (m.role IN ('owner', 'admin') OR m.user_id = envelope.created_by)
      )
    )
  );

DROP POLICY IF EXISTS hr_contract_insert ON crove_sign.envelope;
CREATE POLICY hr_contract_insert ON crove_sign.envelope AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK (
    source_kind <> 'hr_contract'
    OR (SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR (
      (SELECT crove_kernel.ctx_actor_type()) = 'user'
      AND created_by = (SELECT crove_kernel.ctx_user_id())
      AND EXISTS (
        SELECT 1 FROM crove_kernel.tenant_member m
        WHERE m.org_id = envelope.org_id
          AND m.user_id = (SELECT crove_kernel.ctx_user_id())
          AND m.role IN ('owner', 'admin')
      )
    )
  );

DROP POLICY IF EXISTS hr_contract_update ON crove_sign.envelope;
CREATE POLICY hr_contract_update ON crove_sign.envelope AS RESTRICTIVE FOR UPDATE TO crove_tenant
  USING (
    source_kind <> 'hr_contract'
    OR (SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR (
      (SELECT crove_kernel.ctx_actor_type()) = 'user'
      AND EXISTS (
        SELECT 1 FROM crove_kernel.tenant_member m
        WHERE m.org_id = envelope.org_id
          AND m.user_id = (SELECT crove_kernel.ctx_user_id())
          AND (m.role IN ('owner', 'admin') OR m.user_id = envelope.created_by)
      )
    )
  )
  WITH CHECK (
    source_kind <> 'hr_contract'
    OR (SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR (
      (SELECT crove_kernel.ctx_actor_type()) = 'user'
      AND EXISTS (
        SELECT 1 FROM crove_kernel.tenant_member m
        WHERE m.org_id = envelope.org_id
          AND m.user_id = (SELECT crove_kernel.ctx_user_id())
          AND (m.role IN ('owner', 'admin') OR m.user_id = envelope.created_by)
      )
    )
  );

DROP POLICY IF EXISTS hr_contract_delete ON crove_sign.envelope;
CREATE POLICY hr_contract_delete ON crove_sign.envelope AS RESTRICTIVE FOR DELETE TO crove_tenant
  USING (
    source_kind <> 'hr_contract'
    OR (SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR (
      (SELECT crove_kernel.ctx_actor_type()) = 'user'
      AND EXISTS (
        SELECT 1 FROM crove_kernel.tenant_member m
        WHERE m.org_id = envelope.org_id
          AND m.user_id = (SELECT crove_kernel.ctx_user_id())
          AND (m.role IN ('owner', 'admin') OR m.user_id = envelope.created_by)
      )
    )
  );

DROP POLICY IF EXISTS hr_contract_envelope_access ON crove_sign.signer;
CREATE POLICY hr_contract_envelope_access ON crove_sign.signer AS RESTRICTIVE FOR ALL TO crove_tenant
  USING (
    EXISTS (
      SELECT 1 FROM crove_sign.envelope e
      WHERE e.org_id = signer.org_id AND e.id = signer.envelope_id
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM crove_sign.envelope e
      WHERE e.org_id = signer.org_id AND e.id = signer.envelope_id
    )
  );

DROP POLICY IF EXISTS hr_contract_envelope_access ON crove_sign.field;
CREATE POLICY hr_contract_envelope_access ON crove_sign.field AS RESTRICTIVE FOR ALL TO crove_tenant
  USING (
    EXISTS (
      SELECT 1 FROM crove_sign.envelope e
      WHERE e.org_id = field.org_id AND e.id = field.envelope_id
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM crove_sign.envelope e
      WHERE e.org_id = field.org_id AND e.id = field.envelope_id
    )
  );

DROP POLICY IF EXISTS hr_contract_envelope_access ON crove_sign.ai_analysis;
CREATE POLICY hr_contract_envelope_access ON crove_sign.ai_analysis AS RESTRICTIVE FOR ALL TO crove_tenant
  USING (
    EXISTS (
      SELECT 1 FROM crove_sign.envelope e
      WHERE e.org_id = ai_analysis.org_id AND e.id = ai_analysis.envelope_id
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM crove_sign.envelope e
      WHERE e.org_id = ai_analysis.org_id AND e.id = ai_analysis.envelope_id
    )
  );

DROP POLICY IF EXISTS hr_contract_envelope_select ON crove_sign.signing_event;
CREATE POLICY hr_contract_envelope_select ON crove_sign.signing_event AS RESTRICTIVE FOR SELECT TO crove_tenant
  USING (
    EXISTS (
      SELECT 1 FROM crove_sign.envelope e
      WHERE e.org_id = signing_event.org_id AND e.id = signing_event.envelope_id
    )
  );

DROP POLICY IF EXISTS hr_contract_envelope_insert ON crove_sign.signing_event;
CREATE POLICY hr_contract_envelope_insert ON crove_sign.signing_event AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM crove_sign.envelope e
      WHERE e.org_id = signing_event.org_id AND e.id = signing_event.envelope_id
    )
  );

-- ---------------------------------------------------------------------------
-- 2. Sign file read authorization helper for kernel.file.get and source checks
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

  -- Creator of an hr_contract envelope retains access to its source, sealed, and certificate files.
  IF EXISTS (
    SELECT 1 FROM crove_sign.envelope e
    WHERE e.org_id = v_org
      AND e.source_kind = 'hr_contract'
      AND e.created_by = v_user
      AND (e.source_file_id = p_file_id OR e.sealed_file_id = p_file_id OR e.certificate_file_id = p_file_id)
  ) THEN
    RETURN true;
  END IF;

  -- Sealed PDFs and certificates of hr_contract envelopes created by another user are strictly confidential.
  IF EXISTS (
    SELECT 1 FROM crove_sign.envelope e
    WHERE e.org_id = v_org
      AND e.source_kind = 'hr_contract'
      AND (e.sealed_file_id = p_file_id OR e.certificate_file_id = p_file_id)
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
      AND (e.source_file_id = p_file_id OR e.sealed_file_id = p_file_id OR e.certificate_file_id = p_file_id)
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
-- 3. Harden crove_tenant SECURITY DEFINER helpers for hr_contract envelopes
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION crove_sign.mint_signing_token(
  p_envelope_id uuid,
  p_signer_id uuid,
  p_token_sha256 text,
  p_expires_at timestamptz
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_actor text := crove_kernel.ctx_actor_type();
  v_user uuid := crove_kernel.ctx_user_id();
  v_now timestamptz := pg_catalog.now();
  v_role text;
  v_env_status text;
  v_env_creator uuid;
  v_env_source_kind text;
  v_signer_status text;
  v_token_id uuid;
BEGIN
  IF v_org IS NULL OR v_actor IS NULL THEN
    RAISE EXCEPTION 'SIGN_CONTEXT_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF v_actor NOT IN ('user', 'system') THEN
    RAISE EXCEPTION 'SIGN_FORBIDDEN_ACTOR' USING ERRCODE = '42501';
  END IF;
  IF v_actor = 'user' THEN
    IF v_user IS NULL THEN
      RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    SELECT m.role INTO v_role
    FROM crove_kernel.tenant_member m
    WHERE m.org_id = v_org AND m.user_id = v_user AND m.role IN ('owner', 'admin', 'member');
    IF NOT FOUND THEN
      RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF p_token_sha256 IS NULL OR p_token_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'SIGN_INVALID_TOKEN_HASH' USING ERRCODE = '22023';
  END IF;
  IF p_expires_at IS NULL OR p_expires_at <= v_now THEN
    RAISE EXCEPTION 'SIGN_INVALID_EXPIRY' USING ERRCODE = '22023';
  END IF;

  SELECT e.status, e.created_by, e.source_kind
  INTO v_env_status, v_env_creator, v_env_source_kind
  FROM crove_sign.envelope e
  WHERE e.org_id = v_org AND e.id = p_envelope_id
  FOR SHARE;
  IF v_env_status IS NULL OR v_env_status NOT IN ('sent', 'in_progress') THEN
    RAISE EXCEPTION 'ENVELOPE_NOT_ACTIVE' USING ERRCODE = '42501';
  END IF;
  IF v_actor = 'user'
     AND v_env_source_kind = 'hr_contract'
     AND v_user IS DISTINCT FROM v_env_creator
     AND v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'ENVELOPE_NOT_ACTIVE' USING ERRCODE = '42501';
  END IF;

  SELECT s.status INTO v_signer_status
  FROM crove_sign.signer s
  WHERE s.org_id = v_org AND s.id = p_signer_id AND s.envelope_id = p_envelope_id
  FOR UPDATE;
  IF v_signer_status IS NULL OR v_signer_status NOT IN ('pending', 'viewed') THEN
    RAISE EXCEPTION 'SIGNER_NOT_LIVE' USING ERRCODE = '42501';
  END IF;

  UPDATE crove_sign.signing_token t
  SET revoked_at = v_now,
      revoked_by = COALESCE(v_user, v_env_creator)
  WHERE t.org_id = v_org
    AND t.signer_id = p_signer_id
    AND t.revoked_at IS NULL
    AND t.used_at IS NULL;

  UPDATE crove_sign.signing_otp o
  SET invalidated_at = v_now
  WHERE o.org_id = v_org
    AND o.signer_id = p_signer_id
    AND o.invalidated_at IS NULL
    AND o.verified_at IS NULL;

  INSERT INTO crove_sign.signing_token (org_id, envelope_id, signer_id, token_sha256, expires_at, created_by)
  VALUES (v_org, p_envelope_id, p_signer_id, p_token_sha256, p_expires_at, COALESCE(v_user, v_env_creator))
  RETURNING id INTO v_token_id;

  RETURN v_token_id;
END $$;

REVOKE ALL ON FUNCTION crove_sign.mint_signing_token(uuid, uuid, text, timestamptz)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.mint_signing_token(uuid, uuid, text, timestamptz) TO crove_tenant;

CREATE OR REPLACE FUNCTION crove_sign.revoke_envelope_tokens(p_envelope_id uuid) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_actor text := crove_kernel.ctx_actor_type();
  v_user uuid := crove_kernel.ctx_user_id();
  v_now timestamptz := pg_catalog.now();
  v_role text;
  v_env_creator uuid;
  v_env_source_kind text;
  v_count integer := 0;
BEGIN
  IF v_org IS NULL OR v_actor IS NULL THEN
    RAISE EXCEPTION 'SIGN_CONTEXT_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF v_actor NOT IN ('user', 'system') THEN
    RAISE EXCEPTION 'SIGN_FORBIDDEN_ACTOR' USING ERRCODE = '42501';
  END IF;
  IF v_actor = 'user' THEN
    IF v_user IS NULL THEN
      RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    SELECT m.role INTO v_role
    FROM crove_kernel.tenant_member m
    WHERE m.org_id = v_org AND m.user_id = v_user AND m.role IN ('owner', 'admin', 'member');
    IF NOT FOUND THEN
      RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501';
    END IF;

    SELECT e.created_by, e.source_kind
    INTO v_env_creator, v_env_source_kind
    FROM crove_sign.envelope e
    WHERE e.org_id = v_org AND e.id = p_envelope_id
    FOR SHARE;
    IF NOT FOUND THEN
      RETURN 0;
    END IF;
    IF v_env_source_kind = 'hr_contract'
       AND v_user IS DISTINCT FROM v_env_creator
       AND v_role NOT IN ('owner', 'admin') THEN
      RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
  END IF;

  WITH revoked AS (
    UPDATE crove_sign.signing_token t
    SET revoked_at = v_now,
        revoked_by = v_user
    WHERE t.org_id = v_org
      AND t.envelope_id = p_envelope_id
      AND t.revoked_at IS NULL
      AND t.used_at IS NULL
    RETURNING t.id
  )
  SELECT pg_catalog.count(*)::integer INTO v_count FROM revoked;

  UPDATE crove_sign.signing_otp o
  SET invalidated_at = v_now
  FROM crove_sign.signing_token t
  WHERE o.org_id = v_org
    AND t.org_id = o.org_id
    AND t.id = o.signing_token_id
    AND t.envelope_id = p_envelope_id
    AND o.invalidated_at IS NULL
    AND o.verified_at IS NULL;

  RETURN v_count;
END $$;

REVOKE ALL ON FUNCTION crove_sign.revoke_envelope_tokens(uuid)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.revoke_envelope_tokens(uuid) TO crove_tenant;

CREATE OR REPLACE FUNCTION crove_sign.template_inherit_inspect(
  p_template_id uuid,
  p_envelope_id uuid
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_actor text := crove_kernel.ctx_actor_type();
  v_user uuid := crove_kernel.ctx_user_id();
  v_role text;
  v_tpl record;
  v_env record;
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
    IF v_user IS NULL THEN
      RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    SELECT m.role INTO v_role
    FROM crove_kernel.tenant_member m
    WHERE m.org_id = v_org AND m.user_id = v_user AND m.role IN ('owner', 'admin', 'member');
    IF NOT FOUND THEN
      RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
  END IF;

  SELECT t.id, t.status, t.inspect_status, t.page_count, t.page_dimensions_json, t.detected_tags_json,
         t.source_file_id, t.source_storage_key, t.source_generation, t.source_sha256
  INTO v_tpl
  FROM crove_sign.template t
  WHERE t.org_id = v_org AND t.id = p_template_id
  FOR SHARE;

  IF NOT FOUND OR v_tpl.status NOT IN ('draft', 'active') OR v_tpl.inspect_status <> 'passed' OR v_tpl.page_count IS NULL THEN
    RETURN false;
  END IF;

  SELECT e.id, e.status, e.inspect_status, e.source_kind, e.created_by,
         e.source_file_id, e.source_storage_key, e.source_generation, e.source_sha256
  INTO v_env
  FROM crove_sign.envelope e
  WHERE e.org_id = v_org AND e.id = p_envelope_id
  FOR UPDATE;

  IF NOT FOUND OR v_env.status <> 'draft' OR v_env.inspect_status <> 'pending' THEN
    RETURN false;
  END IF;
  IF v_actor = 'user'
     AND v_env.source_kind = 'hr_contract'
     AND v_user IS DISTINCT FROM v_env.created_by
     AND v_role NOT IN ('owner', 'admin') THEN
    RETURN false;
  END IF;
  IF v_env.source_file_id IS DISTINCT FROM v_tpl.source_file_id
     OR v_env.source_storage_key IS DISTINCT FROM v_tpl.source_storage_key
     OR v_env.source_generation IS DISTINCT FROM v_tpl.source_generation
     OR v_env.source_sha256 IS DISTINCT FROM v_tpl.source_sha256 THEN
    RAISE EXCEPTION 'SIGN_TEMPLATE_SOURCE_MISMATCH' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_catalog.set_config('crove.sign_template_inherit', p_envelope_id::text, true);

  UPDATE crove_sign.envelope
  SET inspect_status = 'passed',
      inspect_error = NULL,
      page_count = v_tpl.page_count,
      page_dimensions_json = v_tpl.page_dimensions_json,
      detected_tags_json = v_tpl.detected_tags_json,
      updated_at = pg_catalog.now()
  WHERE org_id = v_org AND id = p_envelope_id;

  PERFORM pg_catalog.set_config('crove.sign_template_inherit', '', true);

  RETURN true;
END $$;

REVOKE ALL ON FUNCTION crove_sign.template_inherit_inspect(uuid, uuid)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.template_inherit_inspect(uuid, uuid) TO crove_tenant;
