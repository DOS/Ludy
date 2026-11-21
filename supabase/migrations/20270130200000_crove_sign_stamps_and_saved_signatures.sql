-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove eSign Slice 4a (#3817):
--   1. Widen field_type CHECK constraints on crove_sign.field and crove_sign.template_field
--      to include 'stamp' ('signature', 'initials', 'stamp', 'date', 'text', 'checkbox').
--   2. Create crove_sign.member_signature (member-private saved signature and initials PNGs,
--      PRIMARY KEY (org_id, id), UNIQUE (org_id, user_id, kind), author-only RLS).
--   3. Create crove_sign.org_stamp (corporate and title stamp PNGs, PRIMARY KEY (org_id, id),
--      owner/admin mutations, readable by SIGN_WRITERS and the system export context).
--   4. Update crove_sign.public_submit and crove_sign.public_direct_start so 'stamp' fields
--      validate PNG magic bytes (<= 256 KB) and satisfy signer execution-mark readiness.

SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. Widen field_type CHECK constraints for company/title stamp fields
-- ---------------------------------------------------------------------------

ALTER TABLE crove_sign.field
  DROP CONSTRAINT IF EXISTS field_field_type_check;
ALTER TABLE crove_sign.field
  ADD CONSTRAINT field_field_type_check
  CHECK (field_type IN ('signature', 'initials', 'stamp', 'date', 'text', 'checkbox'));

ALTER TABLE crove_sign.template_field
  DROP CONSTRAINT IF EXISTS template_field_field_type_check;
ALTER TABLE crove_sign.template_field
  ADD CONSTRAINT template_field_field_type_check
  CHECK (field_type IN ('signature', 'initials', 'stamp', 'date', 'text', 'checkbox'));

-- ---------------------------------------------------------------------------
-- 2. Saved member signature and initials profile (author-only RLS)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS crove_sign.member_signature (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  user_id uuid NOT NULL REFERENCES crove_kernel.user_account (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('signature', 'initials')),
  signature_kind text NOT NULL CHECK (signature_kind IN ('draw', 'type')),
  signature_typed_text text CHECK (signature_typed_text IS NULL OR pg_catalog.length(pg_catalog.btrim(signature_typed_text)) BETWEEN 1 AND 200),
  signature_png_base64 text NOT NULL CHECK (pg_catalog.length(signature_png_base64) BETWEEN 60 AND 360000),
  image_sha256 text NOT NULL CHECK (image_sha256 ~ '^[0-9a-f]{64}$'),
  width_px integer NOT NULL CHECK (width_px BETWEEN 1 AND 2000),
  height_px integer NOT NULL CHECK (height_px BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT member_signature_user_kind_uq UNIQUE (org_id, user_id, kind),
  CONSTRAINT member_signature_member_fk FOREIGN KEY (org_id, user_id) REFERENCES crove_kernel.tenant_member (org_id, user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS member_signature_user_idx
  ON crove_sign.member_signature (user_id);

SELECT crove_kernel.apply_tenant_rls('crove_sign.member_signature');

DROP POLICY IF EXISTS member_signature_owner_only ON crove_sign.member_signature;
CREATE POLICY member_signature_owner_only ON crove_sign.member_signature
  AS RESTRICTIVE FOR ALL TO crove_tenant
  USING (
    (SELECT crove_kernel.ctx_actor_type()) = 'user'
    AND user_id = (SELECT crove_kernel.ctx_user_id())
    AND EXISTS (
      SELECT 1
      FROM crove_kernel.tenant_member m
      WHERE m.org_id = member_signature.org_id
        AND m.user_id = (SELECT crove_kernel.ctx_user_id())
        AND m.role IN ('owner', 'admin', 'member')
    )
  )
  WITH CHECK (
    (SELECT crove_kernel.ctx_actor_type()) = 'user'
    AND user_id = (SELECT crove_kernel.ctx_user_id())
    AND EXISTS (
      SELECT 1
      FROM crove_kernel.tenant_member m
      WHERE m.org_id = member_signature.org_id
        AND m.user_id = (SELECT crove_kernel.ctx_user_id())
        AND m.role IN ('owner', 'admin', 'member')
    )
  );

-- ---------------------------------------------------------------------------
-- 3. Corporate and title stamp profile (owner/admin write, SIGN_WRITERS read)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS crove_sign.org_stamp (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  name text NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(name)) BETWEEN 1 AND 120),
  stamp_kind text NOT NULL DEFAULT 'company' CHECK (stamp_kind IN ('company', 'title', 'custom')),
  file_id uuid,
  stamp_png_base64 text NOT NULL CHECK (pg_catalog.length(stamp_png_base64) BETWEEN 60 AND 360000),
  image_sha256 text NOT NULL CHECK (image_sha256 ~ '^[0-9a-f]{64}$'),
  width_px integer NOT NULL CHECK (width_px BETWEEN 1 AND 2000),
  height_px integer NOT NULL CHECK (height_px BETWEEN 1 AND 1000),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  archived_at timestamptz,
  archived_by uuid REFERENCES crove_kernel.user_account (id),
  created_by uuid NOT NULL REFERENCES crove_kernel.user_account (id),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT org_stamp_file_fk FOREIGN KEY (org_id, file_id) REFERENCES crove_kernel.file (org_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS org_stamp_active_name_uq
  ON crove_sign.org_stamp (org_id, name)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS org_stamp_org_status_created_idx
  ON crove_sign.org_stamp (org_id, status, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS org_stamp_file_idx
  ON crove_sign.org_stamp (org_id, file_id);
CREATE INDEX IF NOT EXISTS org_stamp_created_by_idx
  ON crove_sign.org_stamp (created_by);
CREATE INDEX IF NOT EXISTS org_stamp_archived_by_idx
  ON crove_sign.org_stamp (archived_by);

SELECT crove_kernel.apply_tenant_rls('crove_sign.org_stamp');

DROP POLICY IF EXISTS org_stamp_select ON crove_sign.org_stamp;
CREATE POLICY org_stamp_select ON crove_sign.org_stamp
  AS RESTRICTIVE FOR SELECT TO crove_tenant
  USING (
    (SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (
      SELECT 1
      FROM crove_kernel.tenant_member m
      WHERE m.org_id = org_stamp.org_id
        AND m.user_id = (SELECT crove_kernel.ctx_user_id())
        AND m.role IN ('owner', 'admin', 'member')
    )
  );

DROP POLICY IF EXISTS org_stamp_insert ON crove_sign.org_stamp;
CREATE POLICY org_stamp_insert ON crove_sign.org_stamp
  AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK (
    (SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (
      SELECT 1
      FROM crove_kernel.tenant_member m
      WHERE m.org_id = org_stamp.org_id
        AND m.user_id = (SELECT crove_kernel.ctx_user_id())
        AND m.role IN ('owner', 'admin')
    )
  );

DROP POLICY IF EXISTS org_stamp_update ON crove_sign.org_stamp;
CREATE POLICY org_stamp_update ON crove_sign.org_stamp
  AS RESTRICTIVE FOR UPDATE TO crove_tenant
  USING (
    (SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (
      SELECT 1
      FROM crove_kernel.tenant_member m
      WHERE m.org_id = org_stamp.org_id
        AND m.user_id = (SELECT crove_kernel.ctx_user_id())
        AND m.role IN ('owner', 'admin')
    )
  )
  WITH CHECK (
    (SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (
      SELECT 1
      FROM crove_kernel.tenant_member m
      WHERE m.org_id = org_stamp.org_id
        AND m.user_id = (SELECT crove_kernel.ctx_user_id())
        AND m.role IN ('owner', 'admin')
    )
  );

DROP POLICY IF EXISTS org_stamp_delete ON crove_sign.org_stamp;
CREATE POLICY org_stamp_delete ON crove_sign.org_stamp
  AS RESTRICTIVE FOR DELETE TO crove_tenant
  USING (
    (SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (
      SELECT 1
      FROM crove_kernel.tenant_member m
      WHERE m.org_id = org_stamp.org_id
        AND m.user_id = (SELECT crove_kernel.ctx_user_id())
        AND m.role IN ('owner', 'admin')
    )
  );

-- ---------------------------------------------------------------------------
-- 4. Update public signing submission and direct-link start for 'stamp' fields
-- ---------------------------------------------------------------------------

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
  FROM crove_kernel.tenant t
  WHERE t.org_id = v_lookup.org_id;

  IF v_tenant.status IS DISTINCT FROM 'active'
     OR NOT crove_kernel.org_app_on(v_lookup.org_id, 'sign')
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

  -- Lock signer fields in id order and validate all required values and PNG magic headers before any mutation.
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
    ELSIF v_field.field_type IN ('date', 'text') THEN
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
    ELSIF v_field.field_type IN ('date', 'text') THEN
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

    INSERT INTO crove_kernel.outbox_event (org_id, type, payload, actor_type)
    VALUES (
      v_lookup.org_id,
      'sign.envelope.seal_queued',
      pg_catalog.jsonb_build_object('envelopeId', v_env.id::text),
      'system'
    )
    RETURNING id INTO v_outbox_id;

    INSERT INTO crove_kernel.outbox_pending (org_id, event_id)
    VALUES (v_lookup.org_id, v_outbox_id);

    PERFORM pg_catalog.pg_notify('crove_outbox', '');
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
            v_to_hash := crove_kernel.mail_address_hash(v_to_email);
            IF v_to_hash IS NOT NULL THEN
              SELECT EXISTS (
                SELECT 1
                FROM crove_kernel.mail_suppression ms
                WHERE ms.org_id = v_lookup.org_id
                  AND ms.to_hash = v_to_hash
                  AND ms.scope = 'all'
                  AND ms.lifted_at IS NULL
              )
              INTO v_suppressed;

              INSERT INTO crove_kernel.mail_message (
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
    'signedAt', pg_catalog.to_char(v_now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
END $$;

REVOKE ALL ON FUNCTION crove_sign.public_submit(text, boolean, text, text, jsonb, text, text, text)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.public_submit(text, boolean, text, text, jsonb, text, text, text) TO crove_app;

CREATE OR REPLACE FUNCTION crove_sign.public_direct_start(
  p_token_sha256 text,
  p_name text,
  p_email text,
  p_claim_sha256 text,
  p_signing_token_sha256 text,
  p_ip_hash text DEFAULT NULL,
  p_user_agent text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_now timestamptz := pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp());
  v_ctx_org uuid := crove_kernel.ctx_org_id();
  v_lookup record;
  v_tpl record;
  v_link record;
  v_tenant record;
  v_non_cc_count integer := 0;
  v_role record;
  v_cc_role record;
  v_effective_otp boolean := false;
  v_name text := pg_catalog.btrim(pg_catalog.regexp_replace(COALESCE(p_name, ''), '[[:cntrl:]]+', ' ', 'g'));
  v_email text := NULLIF(pg_catalog.lower(pg_catalog.btrim(COALESCE(p_email, ''))), '');
  v_otp record;
  v_otp_verified_at timestamptz := NULL;
  v_delivery_mode text := 'link';
  v_recent_link_starts integer := 0;
  v_recent_email_starts integer := 0;
  v_sig_field_count integer := 0;
  v_oob_field_count integer := 0;
  v_env_expires_at timestamptz;
  v_token_expires_at timestamptz;
  v_env_id uuid;
  v_signer_id uuid;
  v_signing_token_id uuid;
  v_ip_hash text;
  v_ua text := pg_catalog.left(NULLIF(pg_catalog.btrim(pg_catalog.regexp_replace(COALESCE(p_user_agent, ''), '[[:cntrl:]]+', ' ', 'g')), ''), 500);
  v_actor_label text;
BEGIN
  IF p_token_sha256 IS NULL OR p_token_sha256 !~ '^[0-9a-f]{64}$' THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  SELECT l.id AS direct_link_id, l.org_id, l.template_id
  INTO v_lookup
  FROM crove_sign.template_direct_link l
  WHERE l.token_sha256 = p_token_sha256;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  IF v_ctx_org IS NOT NULL AND (crove_kernel.ctx_actor_type() IS DISTINCT FROM 'system' OR v_ctx_org IS DISTINCT FROM v_lookup.org_id) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  SELECT tpl.*
  INTO v_tpl
  FROM crove_sign.template tpl
  WHERE tpl.org_id = v_lookup.org_id
    AND tpl.id = v_lookup.template_id
  FOR SHARE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  SELECT l.*
  INTO v_link
  FROM crove_sign.template_direct_link l
  WHERE l.org_id = v_lookup.org_id
    AND l.id = v_lookup.direct_link_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  SELECT t.name, t.status
  INTO v_tenant
  FROM crove_kernel.tenant t
  WHERE t.org_id = v_lookup.org_id;

  IF NOT FOUND
     OR v_tenant.status IS DISTINCT FROM 'active'
     OR NOT crove_kernel.org_app_on(v_lookup.org_id, 'sign')
     OR NOT v_link.enabled
     OR v_link.revoked_at IS NOT NULL
     OR (v_link.expires_at IS NOT NULL AND v_link.expires_at <= v_now)
     OR (v_link.max_uses IS NOT NULL AND v_link.uses_count >= v_link.max_uses)
     OR v_tpl.status <> 'active'
     OR v_tpl.inspect_status <> 'passed'
     OR v_tpl.page_count IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  SELECT pg_catalog.count(*)::integer
  INTO v_non_cc_count
  FROM crove_sign.template_role r
  WHERE r.org_id = v_lookup.org_id
    AND r.template_id = v_lookup.template_id
    AND r.signer_role <> 'cc';

  IF v_non_cc_count <> 1 THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  SELECT r.id, r.role_key, r.signer_role, r.role_label, r.routing_order, r.delivery_mode, r.require_email_otp
  INTO v_role
  FROM crove_sign.template_role r
  WHERE r.org_id = v_lookup.org_id
    AND r.template_id = v_lookup.template_id
    AND r.signer_role <> 'cc'
  LIMIT 1;

  IF p_signing_token_sha256 IS NULL OR p_signing_token_sha256 !~ '^[0-9a-f]{64}$' THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'VALIDATION',
      'httpStatus', 422,
      'message', 'Invalid signing token digest'
    );
  END IF;

  IF pg_catalog.length(v_name) < 1 OR pg_catalog.length(v_name) > 200 THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'VALIDATION',
      'httpStatus', 422,
      'message', 'Recipient name must be between 1 and 200 characters'
    );
  END IF;

  IF v_email IS NOT NULL AND NOT crove_sign.is_single_mail_address(v_email) THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'VALIDATION',
      'httpStatus', 422,
      'message', 'Invalid recipient email address'
    );
  END IF;

  v_effective_otp := COALESCE(v_link.require_email_otp, false) OR COALESCE(v_role.require_email_otp, false);

  IF v_effective_otp THEN
    IF p_claim_sha256 IS NULL OR p_claim_sha256 !~ '^[0-9a-f]{64}$' THEN
      RETURN pg_catalog.jsonb_build_object(
        'status', 'error',
        'code', 'SIGN_OTP_REQUIRED',
        'httpStatus', 403,
        'message', 'Email OTP verification is required before starting signing'
      );
    END IF;

    SELECT o.id, o.email, o.otp_sha256, o.verified_at, o.expires_at, o.invalidated_at, o.claim_used_at
    INTO v_otp
    FROM crove_sign.signing_otp o
    WHERE o.org_id = v_lookup.org_id
      AND o.direct_link_id = v_link.id
      AND o.claim_sha256 = p_claim_sha256
    FOR UPDATE;

    IF NOT FOUND
       OR v_otp.verified_at IS NULL
       OR v_otp.invalidated_at IS NOT NULL
       OR v_otp.claim_used_at IS NOT NULL
       OR v_otp.expires_at <= v_now THEN
      RETURN pg_catalog.jsonb_build_object(
        'status', 'error',
        'code', 'SIGN_OTP_REQUIRED',
        'httpStatus', 403,
        'message', 'Email OTP verification is required or has expired'
      );
    END IF;

    IF v_email IS NOT NULL AND v_email <> pg_catalog.lower(v_otp.email) THEN
      RETURN pg_catalog.jsonb_build_object(
        'status', 'error',
        'code', 'SIGN_OTP_EMAIL_MISMATCH',
        'httpStatus', 403,
        'message', 'Submitted email must match the OTP-verified email address'
      );
    END IF;

    v_email := pg_catalog.lower(v_otp.email);
    v_otp_verified_at := v_otp.verified_at;
    v_delivery_mode := 'email';
  ELSIF v_role.delivery_mode = 'email' AND v_email IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'SIGN_EMAIL_REQUIRED',
      'httpStatus', 422,
      'message', 'Email address is required for this template'
    );
  END IF;

  SELECT pg_catalog.count(*)::integer
  INTO v_recent_link_starts
  FROM crove_sign.envelope e
  WHERE e.org_id = v_lookup.org_id
    AND e.direct_link_id = v_link.id
    AND e.created_at > v_now - interval '1 hour';

  IF v_recent_link_starts >= 30 THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'SIGN_DIRECT_START_RATE_LIMITED',
      'httpStatus', 429,
      'message', 'Too many signing sessions started for this link; wait before trying again'
    );
  END IF;

  IF v_email IS NOT NULL THEN
    SELECT pg_catalog.count(*)::integer
    INTO v_recent_email_starts
    FROM crove_sign.envelope e
    JOIN crove_sign.signer s
      ON s.org_id = e.org_id
     AND s.envelope_id = e.id
    WHERE e.org_id = v_lookup.org_id
      AND e.direct_link_id = v_link.id
      AND e.created_at > v_now - interval '1 hour'
      AND s.signer_role <> 'cc'
      AND pg_catalog.lower(s.email) = v_email;

    IF v_recent_email_starts >= 5 THEN
      RETURN pg_catalog.jsonb_build_object(
        'status', 'error',
        'code', 'SIGN_DIRECT_START_RATE_LIMITED',
        'httpStatus', 429,
        'message', 'Too many signing sessions started for this email address; wait before trying again'
      );
    END IF;
  END IF;

  SELECT
    pg_catalog.count(*) FILTER (WHERE f.field_type IN ('signature', 'stamp'))::integer,
    pg_catalog.count(*) FILTER (WHERE f.page_number > v_tpl.page_count)::integer
  INTO v_sig_field_count, v_oob_field_count
  FROM crove_sign.template_field f
  WHERE f.org_id = v_lookup.org_id
    AND f.template_id = v_tpl.id
    AND f.template_role_id = v_role.id;

  IF v_oob_field_count > 0 THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'SIGN_FIELD_OUT_OF_BOUNDS',
      'httpStatus', 409,
      'message', 'Template contains fields outside the inspected PDF page bounds'
    );
  END IF;

  IF v_role.signer_role = 'signer' AND v_sig_field_count < 1 THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'SIGN_SIGNATURE_FIELD_REQUIRED',
      'httpStatus', 409,
      'message', 'Template requires at least one signature or stamp field before signing'
    );
  END IF;

  UPDATE crove_sign.template_direct_link
  SET uses_count = uses_count + 1,
      updated_at = v_now
  WHERE org_id = v_lookup.org_id
    AND id = v_link.id
    AND enabled = true
    AND revoked_at IS NULL
    AND (max_uses IS NULL OR uses_count < max_uses);

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  IF v_effective_otp THEN
    UPDATE crove_sign.signing_otp
    SET claim_used_at = v_now
    WHERE org_id = v_lookup.org_id
      AND id = v_otp.id
      AND claim_used_at IS NULL;

    IF NOT FOUND THEN
      RETURN pg_catalog.jsonb_build_object(
        'status', 'error',
        'code', 'SIGN_OTP_REQUIRED',
        'httpStatus', 403,
        'message', 'Email OTP verification has already been used'
      );
    END IF;
  END IF;

  v_env_expires_at := CASE
    WHEN v_tpl.expires_in_hours IS NOT NULL THEN v_now + pg_catalog.make_interval(hours => v_tpl.expires_in_hours)
    ELSE NULL
  END;
  IF v_link.expires_at IS NOT NULL AND (v_env_expires_at IS NULL OR v_link.expires_at < v_env_expires_at) THEN
    v_env_expires_at := v_link.expires_at;
  END IF;

  v_token_expires_at := COALESCE(v_env_expires_at, v_now + interval '30 days');
  v_ip_hash := crove_sign.public_keyed_ip_hash(v_lookup.org_id, p_ip_hash);
  v_actor_label := pg_catalog.left(COALESCE(v_email, v_name), 254);

  INSERT INTO crove_sign.envelope (
    org_id, title, subject, message, status, routing_mode,
    source_kind, source_id, direct_link_id, source_file_id, source_storage_key, source_generation, source_sha256,
    inspect_status, page_count, page_dimensions_json, detected_tags_json,
    expires_at, sent_at, version, created_by, created_at, updated_at
  )
  VALUES (
    v_lookup.org_id, v_tpl.title, v_tpl.subject, v_tpl.message, 'sent', v_tpl.routing_mode,
    'standalone', NULL, v_link.id, v_tpl.source_file_id, v_tpl.source_storage_key, v_tpl.source_generation, v_tpl.source_sha256,
    'passed', v_tpl.page_count, v_tpl.page_dimensions_json, v_tpl.detected_tags_json,
    v_env_expires_at, v_now, 2, v_link.created_by, v_now, v_now
  )
  RETURNING id INTO v_env_id;

  INSERT INTO crove_sign.signer (
    org_id, envelope_id, role_key, routing_order, signer_role, role_label,
    name, email, phone, delivery_mode, require_email_otp,
    status, otp_verified_at, signer_ip_hash, signer_user_agent, created_at, updated_at
  )
  VALUES (
    v_lookup.org_id, v_env_id, v_role.role_key, v_role.routing_order, v_role.signer_role, v_role.role_label,
    v_name, v_email, NULL, v_delivery_mode, v_effective_otp,
    'pending', v_otp_verified_at, v_ip_hash, v_ua, v_now, v_now
  )
  RETURNING id INTO v_signer_id;

  FOR v_cc_role IN
    SELECT r.role_key, r.routing_order, r.role_label
    FROM crove_sign.template_role r
    WHERE r.org_id = v_lookup.org_id
      AND r.template_id = v_tpl.id
      AND r.signer_role = 'cc'
    ORDER BY r.routing_order ASC, r.created_at ASC, r.id ASC
  LOOP
    INSERT INTO crove_sign.signer (
      org_id, envelope_id, role_key, routing_order, signer_role, role_label,
      name, email, phone, delivery_mode, require_email_otp,
      status, created_at, updated_at
    )
    VALUES (
      v_lookup.org_id, v_env_id, v_cc_role.role_key, v_cc_role.routing_order, 'cc', v_cc_role.role_label,
      v_cc_role.role_label, NULL, NULL, 'link', false,
      'waiting', v_now, v_now
    );
  END LOOP;

  INSERT INTO crove_sign.field (
    org_id, envelope_id, signer_id, field_type, page_number,
    x_norm, y_norm, w_norm, h_norm, label, required, proposed_by_ai, font_size_pt,
    created_at, updated_at
  )
  SELECT
    v_lookup.org_id, v_env_id, v_signer_id, f.field_type, f.page_number,
    f.x_norm, f.y_norm, f.w_norm, f.h_norm, f.label, f.required, false, f.font_size_pt,
    v_now, v_now
  FROM crove_sign.template_field f
  WHERE f.org_id = v_lookup.org_id
    AND f.template_id = v_tpl.id
    AND f.template_role_id = v_role.id
  ORDER BY f.page_number ASC, f.id ASC;

  INSERT INTO crove_sign.signing_token (
    org_id, envelope_id, signer_id, token_sha256, expires_at, created_by, created_at
  )
  VALUES (
    v_lookup.org_id, v_env_id, v_signer_id, p_signing_token_sha256, v_token_expires_at, v_link.created_by, v_now
  )
  RETURNING id INTO v_signing_token_id;

  PERFORM crove_sign.public_append_event(
    v_lookup.org_id,
    v_env_id,
    NULL,
    'envelope_created',
    'system',
    'system:sign-direct-link',
    v_tpl.source_sha256,
    pg_catalog.jsonb_build_object(
      'templateId', v_tpl.id::text,
      'directLinkId', v_link.id::text,
      'routingMode', v_tpl.routing_mode,
      'sourceKind', 'standalone'
    ),
    v_ip_hash,
    v_ua,
    v_now
  );

  PERFORM crove_sign.public_append_event(
    v_lookup.org_id,
    v_env_id,
    v_signer_id,
    'envelope_sent',
    'system',
    'system:sign-direct-link',
    v_tpl.source_sha256,
    pg_catalog.jsonb_build_object(
      'templateId', v_tpl.id::text,
      'directLinkId', v_link.id::text,
      'activeSignerIds', pg_catalog.jsonb_build_array(v_signer_id::text)
    ),
    v_ip_hash,
    v_ua,
    v_now
  );

  IF v_effective_otp AND v_otp_verified_at IS NOT NULL THEN
    INSERT INTO crove_sign.signing_otp (
      org_id, signer_id, signing_token_id, direct_link_id, email, otp_sha256,
      expires_at, attempts, verified_at, created_at
    )
    VALUES (
      v_lookup.org_id, v_signer_id, v_signing_token_id, NULL, v_email, v_otp.otp_sha256,
      v_token_expires_at, 0, v_otp_verified_at, v_now
    );

    PERFORM crove_sign.public_append_event(
      v_lookup.org_id,
      v_env_id,
      v_signer_id,
      'signer_otp_verified',
      'signer',
      v_actor_label,
      v_tpl.source_sha256,
      pg_catalog.jsonb_build_object('otpId', v_otp.id::text, 'directLinkId', v_link.id::text),
      v_ip_hash,
      v_ua,
      v_now
    );
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'ok',
    'orgId', v_lookup.org_id,
    'templateId', v_tpl.id,
    'directLinkId', v_link.id,
    'envelopeId', v_env_id,
    'signerId', v_signer_id,
    'signingTokenId', v_signing_token_id,
    'expiresAt', pg_catalog.to_char(v_token_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
END $$;

REVOKE ALL ON FUNCTION crove_sign.public_direct_start(text, text, text, text, text, text, text)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.public_direct_start(text, text, text, text, text, text, text) TO crove_app;
