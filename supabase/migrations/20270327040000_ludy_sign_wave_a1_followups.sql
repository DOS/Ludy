-- SPDX-License-Identifier: AGPL-3.0-only
-- Consolidated Wave A1 non-blocking eSign SQL follow-ups (#4682 from #4616 and #4633):
--   1. ludy_sign.webhook_open: MATERIALIZED now_ts CTE so clock_timestamp() evaluates once per call.
--   2. ludy_sign.personal_data_erase_kyc_check_summary: lock parent envelope FOR SHARE before deleting kyc_check.
--   3. ludy_sign.public_attachment_preflight + public_record_attachment (P9NE): count post-delegation uploads by seq alone.

SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. ludy_sign.webhook_open (#4616 note 2): evaluate clock_timestamp() once via MATERIALIZED CTE
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ludy_sign.webhook_open(p_limit integer)
RETURNS TABLE (org_id uuid, id uuid, kind text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  WITH now_ts AS MATERIALIZED (
    SELECT pg_catalog.clock_timestamp() AS ts
  )
  SELECT d.org_id, d.id,
         CASE WHEN d.created_at <= now_ts.ts - interval '8 hours' THEN 'expire' ELSE 'send' END
  FROM now_ts
  CROSS JOIN ludy_sign.webhook_delivery d
  LEFT JOIN ludy_sign.envelope e
    ON e.org_id = d.org_id AND e.id = d.envelope_id
  WHERE d.status = 'queued'
    AND (
      d.created_at <= now_ts.ts - interval '8 hours'
      OR (
        ludy_kernel.org_app_on(d.org_id, 'sign')
        AND (
          d.handed_at IS NULL
          OR (d.attempts = 0 AND d.handed_at <= now_ts.ts - interval '3 minutes')
        )
      )
    )
    AND (
      d.created_at <= now_ts.ts - interval '8 hours'
      OR e.id IS NULL
      OR e.source_kind NOT IN ('hr_contract', 'meeting_minutes')
    )
  ORDER BY d.created_at, d.id
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 200), 500))
$$;

-- ---------------------------------------------------------------------------
-- 2. ludy_sign.personal_data_erase_kyc_check_summary (#4616 note 5): canonical lock order envelope -> kyc_check -> field
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ludy_sign.personal_data_erase_kyc_check_summary(p_kind text, p_value text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_locked_envelope_ids uuid[] := ARRAY[]::uuid[];
  v_field_ids uuid[];
  v_file_ids uuid[];
  v_rows integer := 0;
  v_attachments integer := 0;
  v_unsealed_attachments integer := 0;
BEGIN
  IF v_org IS NULL
     OR ludy_kernel.ctx_actor_type() IS DISTINCT FROM 'user'
     OR ludy_kernel.ctx_agent_id() IS NOT NULL
     OR (ludy_kernel.ctx_verified() ->> 'role') IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'PERSONAL_DATA_OWNER_ONLY' USING ERRCODE = '42501';
  END IF;
  PERFORM ludy_kernel.text_mention_pattern(p_kind, p_value);

  -- Canonical lock order: acquire FOR SHARE on matching parent envelopes before deleting kyc_check or updating field.
  SELECT COALESCE(pg_catalog.array_agg(locked.id ORDER BY locked.id ASC), ARRAY[]::uuid[])
  INTO v_locked_envelope_ids
  FROM (
    SELECT e.id
    FROM ludy_sign.envelope e
    WHERE e.org_id = v_org
      AND e.id IN (
        SELECT k.envelope_id
        FROM ludy_sign.kyc_check k
        WHERE k.org_id = v_org
          AND ludy_kernel.text_mentions(k.findings_json::text, p_kind, p_value)
      )
    ORDER BY e.id ASC
    FOR SHARE
  ) locked;

  IF pg_catalog.cardinality(v_locked_envelope_ids) = 0 THEN
    RETURN pg_catalog.jsonb_build_object(
      'rows', 0,
      'attachments', 0,
      'unsealedAttachments', 0
    );
  END IF;

  WITH gone AS (
    DELETE FROM ludy_sign.kyc_check k
     WHERE k.org_id = v_org
       AND k.envelope_id = ANY (v_locked_envelope_ids)
       AND ludy_kernel.text_mentions(k.findings_json::text, p_kind, p_value)
    RETURNING k.field_id, k.file_id
  )
  SELECT
    pg_catalog.count(*)::integer,
    pg_catalog.count(DISTINCT file_id)::integer,
    COALESCE(pg_catalog.array_agg(DISTINCT field_id), ARRAY[]::uuid[]),
    COALESCE(pg_catalog.array_agg(DISTINCT file_id), ARRAY[]::uuid[])
  INTO v_rows, v_attachments, v_field_ids, v_file_ids
  FROM gone;

  -- On unsealed envelopes (draft, voided, expired, or declined with sealed_file_id IS NULL), also unlink
  -- the erased check's attachment reference on field so can_read_sign_file immediately blocks further reads.
  IF pg_catalog.cardinality(v_field_ids) > 0 THEN
    PERFORM pg_catalog.set_config('ludy.sign_kyc_erase', v_org::text, true);

    WITH unlinked AS (
      UPDATE ludy_sign.field f
         SET attachment_file_id = NULL,
             attachment_filename = NULL,
             attachment_content_type = NULL,
             attachment_size_bytes = NULL,
             attachment_sha256 = NULL,
             filled_at = NULL,
             updated_at = pg_catalog.now()
        FROM ludy_sign.envelope e
       WHERE f.org_id = v_org
         AND f.envelope_id = ANY (v_locked_envelope_ids)
         AND f.id = ANY (v_field_ids)
         AND f.field_type = 'attachment'
         AND f.attachment_file_id = ANY (v_file_ids)
         AND e.org_id = f.org_id
         AND e.id = f.envelope_id
         AND e.status IN ('draft', 'voided', 'expired', 'declined')
         AND e.sealed_file_id IS NULL
      RETURNING f.id
    )
    SELECT pg_catalog.count(*)::integer
    INTO v_unsealed_attachments
    FROM unlinked;

    PERFORM pg_catalog.set_config('ludy.sign_kyc_erase', '', true);
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'rows', v_rows,
    'attachments', v_attachments,
    'unsealedAttachments', v_unsealed_attachments
  );
END $$;

-- ---------------------------------------------------------------------------
-- 3. P9NE (#4633): count post-delegation uploads strictly by seq > v_last_delegated_seq
-- ---------------------------------------------------------------------------
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ludy_sign.public_attachment_preflight(
  p_token_sha256 text,
  p_field_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_now timestamptz := pg_catalog.now();
  v_row record;
  v_otp_verified boolean := false;
  v_last_delegated_seq integer;
  v_recent_uploads integer := 0;
  v_hourly_uploads integer := 0;
BEGIN
  IF p_token_sha256 IS NULL OR p_token_sha256 !~ '^[0-9a-f]{64}$' THEN
    RETURN NULL;
  END IF;

  SELECT
    tok.id AS token_id,
    tok.org_id,
    tok.envelope_id,
    tok.signer_id,
    tok.expires_at AS token_expires_at,
    tok.used_at AS token_used_at,
    tok.revoked_at AS token_revoked_at,
    e.status AS envelope_status,
    e.expires_at AS envelope_expires_at,
    s.signer_role,
    s.require_email_otp,
    s.status AS signer_status,
    t.status AS tenant_status
  INTO v_row
  FROM ludy_sign.signing_token tok
  JOIN ludy_sign.envelope e
    ON e.org_id = tok.org_id
   AND e.id = tok.envelope_id
  JOIN ludy_sign.signer s
    ON s.org_id = tok.org_id
   AND s.id = tok.signer_id
   AND s.envelope_id = tok.envelope_id
  JOIN ludy_kernel.tenant t
    ON t.org_id = tok.org_id
  WHERE tok.token_sha256 = p_token_sha256;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF v_row.tenant_status IS DISTINCT FROM 'active'
     OR NOT ludy_kernel.org_app_on(v_row.org_id, 'sign')
     OR v_row.token_revoked_at IS NOT NULL
     OR v_row.token_expires_at <= v_now
     OR v_row.signer_role = 'cc'
     OR v_row.signer_status IN ('waiting', 'voided', 'expired')
     OR v_row.envelope_status IN ('draft', 'voided', 'expired')
     OR (v_row.token_used_at IS NULL AND v_row.signer_status IN ('pending', 'viewed') AND v_row.envelope_expires_at IS NOT NULL AND v_row.envelope_expires_at <= v_now) THEN
    RETURN NULL;
  END IF;

  IF v_row.token_used_at IS NOT NULL OR v_row.signer_status IN ('signed', 'declined') OR v_row.envelope_status NOT IN ('sent', 'in_progress') THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'already_used',
      'orgId', v_row.org_id
    );
  END IF;

  v_otp_verified := ludy_sign.public_otp_verified_at_for_token(v_row.org_id, v_row.signer_id, v_row.token_id) IS NOT NULL;
  IF v_row.require_email_otp AND NOT v_otp_verified THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'orgId', v_row.org_id,
      'code', 'SIGN_OTP_REQUIRED',
      'httpStatus', 403,
      'message', 'Email OTP verification is required before uploading attachments'
    );
  END IF;

  IF p_field_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM ludy_sign.field f
    WHERE f.org_id = v_row.org_id
      AND f.envelope_id = v_row.envelope_id
      AND f.signer_id = v_row.signer_id
      AND f.id = p_field_id
      AND f.field_type = 'attachment'
  ) THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'orgId', v_row.org_id,
      'code', 'SIGN_INVALID_FIELD',
      'httpStatus', 422,
      'message', 'Submitted field is not an attachment field assigned to this signer'
    );
  END IF;

  SELECT ev.seq
  INTO v_last_delegated_seq
  FROM ludy_sign.signing_event ev
  WHERE ev.org_id = v_row.org_id
    AND ev.envelope_id = v_row.envelope_id
    AND ev.signer_id = v_row.signer_id
    AND ev.event_type = 'signer_delegated'
  ORDER BY ev.seq DESC
  LIMIT 1;

  SELECT
    pg_catalog.count(*) FILTER (
      WHERE v_last_delegated_seq IS NULL OR ev.seq > v_last_delegated_seq
    )::integer,
    pg_catalog.count(*)::integer
  INTO v_recent_uploads, v_hourly_uploads
  FROM ludy_sign.signing_event ev
  WHERE ev.org_id = v_row.org_id
    AND ev.envelope_id = v_row.envelope_id
    AND ev.signer_id = v_row.signer_id
    AND ev.event_type = 'attachment_uploaded'
    AND ev.occurred_at > v_now - interval '1 hour';

  IF v_recent_uploads >= 20 OR v_hourly_uploads >= 60 THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'orgId', v_row.org_id,
      'code', 'SIGN_ATTACHMENT_RATE_LIMITED',
      'httpStatus', 429,
      'message', 'Too many attachment uploads; wait before trying again'
    );
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'ok',
    'orgId', v_row.org_id,
    'envelopeId', v_row.envelope_id,
    'signerId', v_row.signer_id,
    'fieldId', p_field_id
  );
END $$;

CREATE OR REPLACE FUNCTION ludy_sign.public_record_attachment(
  p_token_sha256 text,
  p_field_id uuid,
  p_filename text,
  p_content_type text,
  p_size_bytes integer,
  p_sha256 text,
  p_storage_key text,
  p_generation text,
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
  v_field record;
  v_existing_file record;
  v_file_id uuid;
  v_otp_verified boolean := false;
  v_last_delegated_seq integer;
  v_recent_uploads integer := 0;
  v_hourly_uploads integer := 0;
  v_clean_filename text := pg_catalog.left(NULLIF(pg_catalog.btrim(pg_catalog.regexp_replace(COALESCE(p_filename, ''), '[[:cntrl:]]+', ' ', 'g')), ''), 255);
  v_expected_key text;
  v_ip_hash text;
  v_ua text := pg_catalog.left(NULLIF(pg_catalog.btrim(pg_catalog.regexp_replace(COALESCE(p_user_agent, ''), '[[:cntrl:]]+', ' ', 'g')), ''), 500);
  v_actor_label text;
BEGIN
  IF p_token_sha256 IS NULL OR p_token_sha256 !~ '^[0-9a-f]{64}$' THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  SELECT tok.id AS token_id, tok.org_id, tok.envelope_id, tok.signer_id
  INTO v_lookup
  FROM ludy_sign.signing_token tok
  WHERE tok.token_sha256 = p_token_sha256;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  -- Canonical lock order: envelope -> signer -> signing_token -> field.
  SELECT e.*
  INTO v_env
  FROM ludy_sign.envelope e
  WHERE e.org_id = v_lookup.org_id
    AND e.id = v_lookup.envelope_id
  FOR UPDATE;

  SELECT s.*
  INTO v_signer
  FROM ludy_sign.signer s
  WHERE s.org_id = v_lookup.org_id
    AND s.envelope_id = v_lookup.envelope_id
    AND s.id = v_lookup.signer_id
  FOR UPDATE;

  SELECT tok.*
  INTO v_tok
  FROM ludy_sign.signing_token tok
  WHERE tok.org_id = v_lookup.org_id
    AND tok.id = v_lookup.token_id
  FOR UPDATE;

  SELECT t.status
  INTO v_tenant
  FROM ludy_kernel.tenant t
  WHERE t.org_id = v_lookup.org_id;

  v_now := pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp());

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

  v_otp_verified := ludy_sign.public_otp_verified_at_for_token(v_lookup.org_id, v_signer.id, v_tok.id) IS NOT NULL;
  IF v_signer.require_email_otp AND NOT v_otp_verified THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'SIGN_OTP_REQUIRED',
      'httpStatus', 403,
      'message', 'Email OTP verification is required before uploading attachments'
    );
  END IF;

  IF p_field_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'SIGN_INVALID_FIELD',
      'httpStatus', 422,
      'message', 'Attachment fieldId is required'
    );
  END IF;

  SELECT f.*
  INTO v_field
  FROM ludy_sign.field f
  WHERE f.org_id = v_lookup.org_id
    AND f.envelope_id = v_env.id
    AND f.signer_id = v_signer.id
    AND f.id = p_field_id
  FOR UPDATE;

  IF NOT FOUND OR v_field.field_type <> 'attachment' THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'SIGN_INVALID_FIELD',
      'httpStatus', 422,
      'message', 'Submitted field is not an attachment field assigned to this signer'
    );
  END IF;

  v_expected_key := 'org/' || v_lookup.org_id::text || '/' || COALESCE(p_sha256, '');
  IF v_clean_filename IS NULL
     OR p_content_type IS NULL
     OR p_content_type NOT IN ('application/pdf', 'image/png', 'image/jpeg')
     OR p_size_bytes IS NULL
     OR p_size_bytes < 1
     OR p_size_bytes > 10485760
     OR p_sha256 IS NULL
     OR p_sha256 !~ '^[0-9a-f]{64}$'
     OR p_storage_key IS DISTINCT FROM v_expected_key
     OR p_generation IS NULL
     OR pg_catalog.length(p_generation) > 1028
     OR p_generation !~ '^(?:s3|gcs):[!-~]+$|^content:[0-9a-f]{64}$'
     OR (p_generation LIKE 'content:%' AND p_generation <> ('content:' || p_sha256)) THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'VALIDATION',
      'httpStatus', 422,
      'message', 'Invalid attachment metadata'
    );
  END IF;

  SELECT ev.seq
  INTO v_last_delegated_seq
  FROM ludy_sign.signing_event ev
  WHERE ev.org_id = v_lookup.org_id
    AND ev.envelope_id = v_env.id
    AND ev.signer_id = v_signer.id
    AND ev.event_type = 'signer_delegated'
  ORDER BY ev.seq DESC
  LIMIT 1;

  SELECT
    pg_catalog.count(*) FILTER (
      WHERE v_last_delegated_seq IS NULL OR ev.seq > v_last_delegated_seq
    )::integer,
    pg_catalog.count(*)::integer
  INTO v_recent_uploads, v_hourly_uploads
  FROM ludy_sign.signing_event ev
  WHERE ev.org_id = v_lookup.org_id
    AND ev.envelope_id = v_env.id
    AND ev.signer_id = v_signer.id
    AND ev.event_type = 'attachment_uploaded'
    AND ev.occurred_at > v_now - interval '1 hour';

  IF v_recent_uploads >= 20 OR v_hourly_uploads >= 60 THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'SIGN_ATTACHMENT_RATE_LIMITED',
      'httpStatus', 429,
      'message', 'Too many attachment uploads; wait before trying again'
    );
  END IF;

  INSERT INTO ludy_kernel.file (
    org_id,
    sha256,
    storage_key,
    generation,
    filename,
    content_type,
    size_bytes,
    source,
    created_by,
    created_at
  )
  VALUES (
    v_lookup.org_id,
    p_sha256,
    p_storage_key,
    p_generation,
    v_clean_filename,
    p_content_type,
    p_size_bytes::bigint,
    'sign_attachment',
    NULL,
    v_now
  )
  ON CONFLICT (org_id, sha256) DO NOTHING
  RETURNING id INTO v_file_id;

  IF v_file_id IS NULL THEN
    SELECT fl.id, fl.source
    INTO v_existing_file
    FROM ludy_kernel.file fl
    WHERE fl.org_id = v_lookup.org_id
      AND fl.sha256 = p_sha256
    FOR UPDATE;

    IF NOT FOUND OR v_existing_file.source <> 'sign_attachment' THEN
      RETURN pg_catalog.jsonb_build_object(
        'status', 'error',
        'code', 'FILE_SOURCE_CONFLICT',
        'httpStatus', 409,
        'message', 'File already exists under a different source in this organization'
      );
    END IF;
    v_file_id := v_existing_file.id;
  END IF;

  UPDATE ludy_sign.field
  SET attachment_file_id = v_file_id,
      attachment_filename = v_clean_filename,
      attachment_content_type = p_content_type,
      attachment_size_bytes = p_size_bytes,
      attachment_sha256 = p_sha256,
      filled_at = v_now,
      updated_at = v_now
  WHERE org_id = v_lookup.org_id
    AND id = v_field.id;

  v_ip_hash := ludy_sign.public_keyed_ip_hash(v_lookup.org_id, p_ip_hash);
  v_actor_label := COALESCE(NULLIF(pg_catalog.btrim(pg_catalog.regexp_replace(COALESCE(v_signer.email, v_signer.name), '[[:cntrl:]]+', ' ', 'g')), ''), 'Signer');
  v_actor_label := pg_catalog.left(v_actor_label, 254);

  IF v_tok.in_person_host_user_id IS NOT NULL THEN
    PERFORM ludy_sign.public_append_event_with_host(
      v_lookup.org_id,
      v_env.id,
      v_signer.id,
      'attachment_uploaded',
      'signer',
      v_actor_label,
      v_env.source_sha256,
      pg_catalog.jsonb_build_object(
        'fieldId', v_field.id::text,
        'fileId', v_file_id::text,
        'filename', v_clean_filename,
        'contentType', p_content_type,
        'sizeBytes', p_size_bytes,
        'sha256', p_sha256,
        'hostUserId', v_tok.in_person_host_user_id::text
      ),
      v_ip_hash,
      v_ua,
      v_now,
      v_tok.in_person_host_user_id
    );
  ELSE
    PERFORM ludy_sign.public_append_event(
      v_lookup.org_id,
      v_env.id,
      v_signer.id,
      'attachment_uploaded',
      'signer',
      v_actor_label,
      v_env.source_sha256,
      pg_catalog.jsonb_build_object(
        'fieldId', v_field.id::text,
        'fileId', v_file_id::text,
        'filename', v_clean_filename,
        'contentType', p_content_type,
        'sizeBytes', p_size_bytes,
        'sha256', p_sha256
      ),
      v_ip_hash,
      v_ua,
      v_now
    );
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'ok',
    'orgId', v_lookup.org_id,
    'fieldId', v_field.id,
    'fileId', v_file_id,
    'filename', v_clean_filename,
    'contentType', p_content_type,
    'sizeBytes', p_size_bytes,
    'sha256', p_sha256,
    'uploadedAt', pg_catalog.to_char(v_now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
END $$;

REVOKE ALL ON FUNCTION
  ludy_sign.webhook_open(integer),
  ludy_sign.personal_data_erase_kyc_check_summary(text, text),
  ludy_sign.public_attachment_preflight(text, uuid),
  ludy_sign.public_record_attachment(text, uuid, text, text, integer, text, text, text, text, text)
FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT rolname
    FROM pg_catalog.pg_roles
    WHERE (rolname LIKE 'ludy\_%' OR rolname LIKE 'crove\_%')
      AND rolname <> current_user
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON FUNCTION ludy_sign.webhook_open(integer), ludy_sign.personal_data_erase_kyc_check_summary(text, text), ludy_sign.public_attachment_preflight(text, uuid), ludy_sign.public_record_attachment(text, uuid, text, text, integer, text, text, text, text, text) FROM %I',
      r.rolname
    );
  END LOOP;
END $$;

GRANT EXECUTE ON FUNCTION
  ludy_sign.webhook_open(integer)
TO ludy_worker;

GRANT EXECUTE ON FUNCTION
  ludy_sign.personal_data_erase_kyc_check_summary(text, text),
  ludy_sign.public_attachment_preflight(text, uuid),
  ludy_sign.public_record_attachment(text, uuid, text, text, integer, text, text, text, text, text)
TO ludy_app;
