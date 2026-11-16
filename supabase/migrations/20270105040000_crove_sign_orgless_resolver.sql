-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove eSign Slice 1b (docs/plan/esign.md, #3324): orgless public link resolvers, certificate verification
-- lookup, and atomic public ceremony procedures callable by crove_app with canonical lock ordering
-- (envelope -> signer -> signing_token -> field -> signing_otp) and strict per-token OTP verification.
-- Idempotent; keeps SECURITY DEFINER ownership with the migration runner so signing_token and signing_otp
-- stay inaccessible to runtime roles directly.
SET LOCAL lock_timeout = '2s';

CREATE INDEX IF NOT EXISTS envelope_certificate_lookup_idx
  ON crove_sign.envelope (certificate_code)
  WHERE certificate_code IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 1. Shared internal helpers (callable by nothing directly)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_sign.canonical_jsonb(p_val jsonb) RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE pg_catalog.jsonb_typeof(p_val)
    WHEN 'object' THEN
      '{' || COALESCE((
        SELECT pg_catalog.string_agg(
          pg_catalog.to_json(e.key)::text || ':' || crove_sign.canonical_jsonb(e.value),
          ',' ORDER BY e.key COLLATE "C"
        )
        FROM pg_catalog.jsonb_each(p_val) AS e(key, value)
      ), '') || '}'
    WHEN 'array' THEN
      '[' || COALESCE((
        SELECT pg_catalog.string_agg(
          crove_sign.canonical_jsonb(a.value),
          ',' ORDER BY a.ordinality
        )
        FROM pg_catalog.jsonb_array_elements(p_val) WITH ORDINALITY AS a(value, ordinality)
      ), '') || ']'
    WHEN 'string' THEN pg_catalog.to_json(p_val #>> '{}')::text
    ELSE COALESCE(p_val::text, 'null')
  END
$$;

REVOKE ALL ON FUNCTION crove_sign.canonical_jsonb(jsonb) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

CREATE OR REPLACE FUNCTION crove_sign.mask_email(p_email text) RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_trimmed text;
  v_at integer;
  v_local text;
  v_domain text;
  v_masked text;
BEGIN
  IF p_email IS NULL THEN
    RETURN NULL;
  END IF;
  v_trimmed := pg_catalog.btrim(p_email);
  v_at := pg_catalog.strpos(v_trimmed, '@');
  IF v_at <= 1 OR v_at = pg_catalog.length(v_trimmed) THEN
    RETURN NULL;
  END IF;
  v_local := pg_catalog.substr(v_trimmed, 1, v_at - 1);
  v_domain := pg_catalog.substr(v_trimmed, v_at + 1);
  IF pg_catalog.length(v_local) <= 2 THEN
    v_masked := pg_catalog.substr(v_local, 1, 1) || '***';
  ELSE
    v_masked := pg_catalog.substr(v_local, 1, 1) || '***' || pg_catalog.substr(v_local, pg_catalog.length(v_local), 1);
  END IF;
  RETURN pg_catalog.left(v_masked || '@' || v_domain, 200);
END $$;

REVOKE ALL ON FUNCTION crove_sign.mask_email(text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

CREATE OR REPLACE FUNCTION crove_sign.public_otp_verified_at_for_token(
  p_org_id uuid,
  p_signer_id uuid,
  p_token_id uuid
) RETURNS timestamptz
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT o.verified_at
  FROM crove_sign.signing_otp o
  WHERE o.org_id = p_org_id
    AND o.signer_id = p_signer_id
    AND o.signing_token_id = p_token_id
    AND o.verified_at IS NOT NULL
    AND o.invalidated_at IS NULL
  ORDER BY o.verified_at DESC, o.id DESC
  LIMIT 1
$$;

REVOKE ALL ON FUNCTION crove_sign.public_otp_verified_at_for_token(uuid, uuid, uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

CREATE OR REPLACE FUNCTION crove_sign.public_keyed_ip_hash(
  p_org_id uuid,
  p_ip_hash text
) RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_clean text := CASE WHEN p_ip_hash IS NOT NULL AND pg_catalog.lower(pg_catalog.btrim(p_ip_hash)) ~ '^[0-9a-f]{64}$'
    THEN pg_catalog.lower(pg_catalog.btrim(p_ip_hash)) ELSE NULL END;
  v_ipad bytea;
  v_opad bytea;
BEGIN
  IF p_org_id IS NULL OR v_clean IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT k.k_ipad, k.k_opad
  INTO v_ipad, v_opad
  FROM crove_kernel.mail_hash_key k
  WHERE k.id = 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MAIL_HASH_KEY_MISSING' USING ERRCODE = '55000';
  END IF;
  RETURN pg_catalog.encode(
    pg_catalog.sha256(
      v_opad OPERATOR(pg_catalog.||) pg_catalog.sha256(
        v_ipad OPERATOR(pg_catalog.||) pg_catalog.convert_to(
          'crove:sign:ip:hmac:v1:' || p_org_id::text || ':' || v_clean,
          'UTF8'
        )
      )
    ),
    'hex'
  );
END $$;

REVOKE ALL ON FUNCTION crove_sign.public_keyed_ip_hash(uuid, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

CREATE OR REPLACE FUNCTION crove_sign.public_append_event(
  p_org_id uuid,
  p_envelope_id uuid,
  p_signer_id uuid,
  p_event_type text,
  p_actor_type text,
  p_actor_label text,
  p_document_sha256 text,
  p_payload_json jsonb,
  p_ip_hash text,
  p_user_agent text,
  p_occurred_at timestamptz
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_seq integer;
  v_prev text;
  v_occ timestamptz := pg_catalog.date_trunc('milliseconds', p_occurred_at);
  v_occ_iso text := pg_catalog.to_char(v_occ AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_ip_hash text := CASE WHEN p_ip_hash IS NOT NULL AND pg_catalog.lower(pg_catalog.btrim(p_ip_hash)) ~ '^[0-9a-f]{64}$'
    THEN pg_catalog.lower(pg_catalog.btrim(p_ip_hash)) ELSE NULL END;
  v_ua text := pg_catalog.left(NULLIF(pg_catalog.btrim(pg_catalog.regexp_replace(COALESCE(p_user_agent, ''), '[[:cntrl:]]+', ' ', 'g')), ''), 500);
  v_payload jsonb := COALESCE(p_payload_json, '{}'::jsonb);
  v_canonical text;
  v_hash text;
BEGIN
  PERFORM 1 FROM crove_sign.envelope e WHERE e.org_id = p_org_id AND e.id = p_envelope_id FOR UPDATE;

  SELECT ev.seq, ev.event_hash
  INTO v_seq, v_prev
  FROM crove_sign.signing_event ev
  WHERE ev.org_id = p_org_id
    AND ev.envelope_id = p_envelope_id
  ORDER BY ev.seq DESC
  LIMIT 1;

  v_seq := COALESCE(v_seq, 0) + 1;
  v_canonical := crove_sign.canonical_jsonb(
    pg_catalog.jsonb_build_object(
      'actorId', NULL::text,
      'actorLabel', p_actor_label,
      'actorType', p_actor_type,
      'documentSha256', p_document_sha256,
      'envelopeId', p_envelope_id::text,
      'eventType', p_event_type,
      'ipHash', v_ip_hash,
      'occurredAt', v_occ_iso,
      'orgId', p_org_id::text,
      'payloadJson', v_payload,
      'prevEventHash', v_prev,
      'seq', v_seq,
      'signerId', p_signer_id::text,
      'userAgent', v_ua
    )
  );
  v_hash := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_canonical, 'UTF8')), 'hex');

  INSERT INTO crove_sign.signing_event (
    org_id, envelope_id, signer_id, seq, event_type, actor_type, actor_id, actor_label,
    document_sha256, prev_event_hash, event_hash, payload_json, ip_hash, user_agent, occurred_at
  )
  VALUES (
    p_org_id, p_envelope_id, p_signer_id, v_seq, p_event_type, p_actor_type, NULL, p_actor_label,
    p_document_sha256, v_prev, v_hash, v_payload, v_ip_hash, v_ua, v_occ
  );
END $$;

REVOKE ALL ON FUNCTION crove_sign.public_append_event(uuid, uuid, uuid, text, text, text, text, jsonb, text, text, timestamptz) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- ---------------------------------------------------------------------------
-- 2. Worker mail-time OTP & token hydration definers (crove_worker + system ctx only)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_sign.public_otp_issue(
  p_otp_id uuid,
  p_expires_at timestamptz,
  p_now timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_actor text := crove_kernel.ctx_actor_type();
  v_ipad bytea;
  v_opad bytea;
  v_lookup record;
  v_env record;
  v_signer record;
  v_tok record;
  v_otp record;
  v_ctr integer := 0;
  v_msg text;
  v_mac bytea;
  v_u32 bigint;
  v_code text;
  v_hash text;
  v_final_exp timestamptz;
BEGIN
  IF v_org IS NULL
     OR v_actor IS DISTINCT FROM 'system'
     OR NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER')
     OR p_otp_id IS NULL
     OR p_now IS NULL
     OR p_expires_at IS NULL THEN
    RAISE EXCEPTION 'SIGN_SYSTEM_CONTEXT_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF p_expires_at <= p_now THEN
    RAISE EXCEPTION 'SIGN_INVALID_OTP_EXPIRY' USING ERRCODE = '22023';
  END IF;

  SELECT
    o.id AS otp_id,
    o.signer_id,
    o.signing_token_id,
    s.envelope_id
  INTO v_lookup
  FROM crove_sign.signing_otp o
  JOIN crove_sign.signer s
    ON s.org_id = o.org_id
   AND s.id = o.signer_id
  WHERE o.org_id = v_org
    AND o.id = p_otp_id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- Canonical lock order: envelope -> signer -> signing_token -> signing_otp.
  SELECT e.id, e.title, e.status, e.expires_at
  INTO v_env
  FROM crove_sign.envelope e
  WHERE e.org_id = v_org
    AND e.id = v_lookup.envelope_id
  FOR SHARE;

  SELECT s.id, s.status, s.name
  INTO v_signer
  FROM crove_sign.signer s
  WHERE s.org_id = v_org
    AND s.envelope_id = v_lookup.envelope_id
    AND s.id = v_lookup.signer_id
  FOR SHARE;

  SELECT tok.id, tok.revoked_at, tok.used_at, tok.expires_at
  INTO v_tok
  FROM crove_sign.signing_token tok
  WHERE tok.org_id = v_org
    AND tok.id = v_lookup.signing_token_id
  FOR SHARE;

  SELECT o.id, o.signer_id, o.otp_sha256, o.attempts, o.expires_at, o.verified_at, o.invalidated_at
  INTO v_otp
  FROM crove_sign.signing_otp o
  WHERE o.org_id = v_org
    AND o.id = v_lookup.otp_id
  FOR UPDATE;

  IF NOT FOUND
     OR v_otp.verified_at IS NOT NULL
     OR v_otp.invalidated_at IS NOT NULL
     OR v_otp.attempts >= 5
     OR v_tok.revoked_at IS NOT NULL
     OR v_tok.used_at IS NOT NULL
     OR v_tok.expires_at <= p_now
     OR v_signer.status NOT IN ('pending', 'viewed')
     OR v_env.status NOT IN ('sent', 'in_progress')
     OR (v_env.expires_at IS NOT NULL AND v_env.expires_at <= p_now) THEN
    RETURN NULL;
  END IF;

  SELECT k.k_ipad, k.k_opad
  INTO v_ipad, v_opad
  FROM crove_kernel.mail_hash_key k
  WHERE k.id = 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MAIL_HASH_KEY_MISSING' USING ERRCODE = '55000';
  END IF;

  LOOP
    v_msg := 'crove:sign:otp:hmac:v1:' || v_org::text || ':' || v_otp.signer_id::text || ':' || v_otp.id::text || ':' || v_ctr::text;
    v_mac := pg_catalog.sha256(v_opad OPERATOR(pg_catalog.||) pg_catalog.sha256(v_ipad OPERATOR(pg_catalog.||) pg_catalog.convert_to(v_msg, 'UTF8')));
    v_u32 := pg_catalog.get_byte(v_mac, 0)::bigint * 16777216
           + pg_catalog.get_byte(v_mac, 1)::bigint * 65536
           + pg_catalog.get_byte(v_mac, 2)::bigint * 256
           + pg_catalog.get_byte(v_mac, 3)::bigint;
    IF v_u32 < 4294000000 OR v_ctr >= 64 THEN
      v_code := pg_catalog.lpad((v_u32 % 1000000)::text, 6, '0');
      EXIT;
    END IF;
    v_ctr := v_ctr + 1;
  END LOOP;

  v_hash := pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to('crove:sign:otp:v1:' || v_otp.signer_id::text || ':' || v_otp.id::text || ':' || v_code, 'UTF8')
    ),
    'hex'
  );

  IF v_otp.otp_sha256 IS NOT NULL AND v_otp.otp_sha256 IS DISTINCT FROM v_hash THEN
    RETURN NULL;
  END IF;

  v_final_exp := LEAST(v_tok.expires_at, GREATEST(v_otp.expires_at, p_expires_at));
  UPDATE crove_sign.signing_otp
  SET otp_sha256 = v_hash,
      expires_at = v_final_exp
  WHERE org_id = v_org
    AND id = v_otp.id;

  RETURN pg_catalog.jsonb_build_object(
    'otpId', v_otp.id,
    'signerId', v_otp.signer_id,
    'envelopeId', v_env.id,
    'signerName', v_signer.name,
    'title', v_env.title,
    'code', v_code,
    'expiresAt', pg_catalog.to_char(v_final_exp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
END $$;

REVOKE ALL ON FUNCTION crove_sign.public_otp_issue(uuid, timestamptz, timestamptz) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.public_otp_issue(uuid, timestamptz, timestamptz) TO crove_tenant;

CREATE OR REPLACE FUNCTION crove_sign.public_mail_token_issue(
  p_envelope_id uuid,
  p_signer_id uuid,
  p_message_id uuid,
  p_expires_at timestamptz,
  p_now timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_actor text := crove_kernel.ctx_actor_type();
  v_ipad bytea;
  v_opad bytea;
  v_env record;
  v_signer record;
  v_existing record;
  v_msg text;
  v_mac bytea;
  v_raw_token text;
  v_token_hash text;
  v_final_exp timestamptz;
  v_token_id uuid;
BEGIN
  IF v_org IS NULL
     OR v_actor IS DISTINCT FROM 'system'
     OR NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER')
     OR p_envelope_id IS NULL
     OR p_signer_id IS NULL
     OR p_message_id IS NULL
     OR p_now IS NULL
     OR p_expires_at IS NULL THEN
    RAISE EXCEPTION 'SIGN_SYSTEM_CONTEXT_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF p_expires_at <= p_now THEN
    RAISE EXCEPTION 'SIGN_INVALID_EXPIRY' USING ERRCODE = '22023';
  END IF;

  -- Canonical lock order: envelope -> signer -> signing_token -> signing_otp.
  SELECT e.id, e.status, e.message, e.expires_at, e.created_by
  INTO v_env
  FROM crove_sign.envelope e
  WHERE e.org_id = v_org
    AND e.id = p_envelope_id
  FOR SHARE;

  IF NOT FOUND
     OR v_env.status NOT IN ('sent', 'in_progress')
     OR (v_env.expires_at IS NOT NULL AND v_env.expires_at <= p_now) THEN
    RETURN NULL;
  END IF;

  SELECT s.id, s.name, s.signer_role, s.status
  INTO v_signer
  FROM crove_sign.signer s
  WHERE s.org_id = v_org
    AND s.envelope_id = v_env.id
    AND s.id = p_signer_id
  FOR UPDATE;

  IF NOT FOUND
     OR v_signer.signer_role = 'cc'
     OR v_signer.status NOT IN ('pending', 'viewed') THEN
    RETURN NULL;
  END IF;

  SELECT k.k_ipad, k.k_opad
  INTO v_ipad, v_opad
  FROM crove_kernel.mail_hash_key k
  WHERE k.id = 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MAIL_HASH_KEY_MISSING' USING ERRCODE = '55000';
  END IF;

  v_msg := 'crove:sign:mail-token:v1:' || v_org::text || ':' || v_env.id::text || ':' || v_signer.id::text || ':' || p_message_id::text;
  v_mac := pg_catalog.sha256(v_opad OPERATOR(pg_catalog.||) pg_catalog.sha256(v_ipad OPERATOR(pg_catalog.||) pg_catalog.convert_to(v_msg, 'UTF8')));
  v_raw_token := pg_catalog.rtrim(pg_catalog.translate(pg_catalog.encode(v_mac, 'base64'), '+/', '-_'), '=');
  v_token_hash := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_raw_token, 'UTF8')), 'hex');

  SELECT t.id, t.expires_at, t.revoked_at, t.used_at
  INTO v_existing
  FROM crove_sign.signing_token t
  WHERE t.org_id = v_org
    AND t.signer_id = v_signer.id
    AND t.token_sha256 = v_token_hash
  FOR UPDATE;

  IF FOUND THEN
    IF v_existing.revoked_at IS NOT NULL OR v_existing.used_at IS NOT NULL OR v_existing.expires_at <= p_now THEN
      RETURN NULL;
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'tokenId', v_existing.id,
      'token', v_raw_token,
      'signerName', v_signer.name,
      'message', v_env.message,
      'expiresAt', pg_catalog.to_char(v_existing.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'minted', false
    );
  END IF;

  UPDATE crove_sign.signing_token t
  SET revoked_at = p_now,
      revoked_by = v_env.created_by
  WHERE t.org_id = v_org
    AND t.signer_id = v_signer.id
    AND t.revoked_at IS NULL
    AND t.used_at IS NULL;

  UPDATE crove_sign.signing_otp o
  SET invalidated_at = p_now
  WHERE o.org_id = v_org
    AND o.signer_id = v_signer.id
    AND o.invalidated_at IS NULL
    AND o.verified_at IS NULL;

  v_final_exp := CASE
    WHEN v_env.expires_at IS NOT NULL AND v_env.expires_at > p_now THEN v_env.expires_at
    ELSE p_expires_at
  END;

  INSERT INTO crove_sign.signing_token (org_id, envelope_id, signer_id, token_sha256, expires_at, created_by)
  VALUES (v_org, v_env.id, v_signer.id, v_token_hash, v_final_exp, v_env.created_by)
  RETURNING id INTO v_token_id;

  RETURN pg_catalog.jsonb_build_object(
    'tokenId', v_token_id,
    'token', v_raw_token,
    'signerName', v_signer.name,
    'message', v_env.message,
    'expiresAt', pg_catalog.to_char(v_final_exp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'minted', true
  );
END $$;

REVOKE ALL ON FUNCTION crove_sign.public_mail_token_issue(uuid, uuid, uuid, timestamptz, timestamptz) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.public_mail_token_issue(uuid, uuid, uuid, timestamptz, timestamptz) TO crove_tenant;

-- ---------------------------------------------------------------------------
-- 3. Orgless resolvers and ceremony procedures callable by crove_app
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_sign.public_token_resolve(
  p_token_sha256 text,
  p_allow_used boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_now timestamptz := pg_catalog.now();
  v_row record;
  v_otp_verified_at timestamptz;
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
    e.title,
    e.message,
    e.status AS envelope_status,
    e.routing_mode,
    e.source_sha256,
    e.page_count,
    e.page_dimensions_json,
    e.expires_at AS envelope_expires_at,
    s.routing_order,
    s.signer_role,
    s.role_label,
    s.name AS signer_name,
    s.email AS signer_email,
    s.require_email_otp,
    s.status AS signer_status,
    t.name AS org_name,
    t.status AS tenant_status
  INTO v_row
  FROM crove_sign.signing_token tok
  JOIN crove_sign.envelope e
    ON e.org_id = tok.org_id
   AND e.id = tok.envelope_id
  JOIN crove_sign.signer s
    ON s.org_id = tok.org_id
   AND s.id = tok.signer_id
   AND s.envelope_id = tok.envelope_id
  JOIN crove_kernel.tenant t
    ON t.org_id = tok.org_id
  WHERE tok.token_sha256 = p_token_sha256;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF v_row.tenant_status IS DISTINCT FROM 'active' THEN
    RETURN NULL;
  END IF;

  IF NOT crove_kernel.org_app_on(v_row.org_id, 'sign') THEN
    RETURN NULL;
  END IF;

  IF v_row.token_revoked_at IS NOT NULL OR v_row.token_expires_at <= v_now THEN
    RETURN NULL;
  END IF;

  IF v_row.signer_role = 'cc' OR v_row.signer_status IN ('waiting', 'voided', 'expired') THEN
    RETURN NULL;
  END IF;

  IF NOT COALESCE(p_allow_used, false) THEN
    IF v_row.token_used_at IS NOT NULL THEN
      RETURN NULL;
    END IF;
    IF v_row.signer_status NOT IN ('pending', 'viewed') THEN
      RETURN NULL;
    END IF;
    IF v_row.envelope_status NOT IN ('sent', 'in_progress') THEN
      RETURN NULL;
    END IF;
    IF v_row.envelope_expires_at IS NOT NULL AND v_row.envelope_expires_at <= v_now THEN
      RETURN NULL;
    END IF;
  ELSE
    IF v_row.signer_status NOT IN ('pending', 'viewed', 'signed', 'declined') THEN
      RETURN NULL;
    END IF;
    IF v_row.envelope_status NOT IN ('sent', 'in_progress', 'completed', 'declined') THEN
      RETURN NULL;
    END IF;
    IF v_row.token_used_at IS NULL
       AND v_row.signer_status IN ('pending', 'viewed')
       AND v_row.envelope_expires_at IS NOT NULL
       AND v_row.envelope_expires_at <= v_now THEN
      RETURN NULL;
    END IF;
  END IF;

  v_otp_verified_at := crove_sign.public_otp_verified_at_for_token(v_row.org_id, v_row.signer_id, v_row.token_id);

  RETURN pg_catalog.jsonb_build_object(
    'orgId', v_row.org_id,
    'orgName', v_row.org_name,
    'tokenId', v_row.token_id,
    'envelopeId', v_row.envelope_id,
    'signerId', v_row.signer_id,
    'tokenUsed', v_row.token_used_at IS NOT NULL OR v_row.signer_status IN ('signed', 'declined'),
    'tokenExpiresAt', v_row.token_expires_at,
    'envelopeStatus', v_row.envelope_status,
    'signerStatus', v_row.signer_status,
    'signerRole', v_row.signer_role,
    'routingMode', v_row.routing_mode,
    'routingOrder', v_row.routing_order,
    'requireEmailOtp', v_row.require_email_otp,
    'otpVerifiedAt', v_otp_verified_at,
    'title', v_row.title,
    'message', v_row.message,
    'roleLabel', v_row.role_label,
    'signerName', v_row.signer_name,
    'hasEmail', v_row.signer_email IS NOT NULL,
    'pageCount', v_row.page_count,
    'pageDimensions', v_row.page_dimensions_json,
    'sourceSha256', v_row.source_sha256
  );
END $$;

REVOKE ALL ON FUNCTION crove_sign.public_token_resolve(text, boolean) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.public_token_resolve(text, boolean) TO crove_app;

CREATE OR REPLACE FUNCTION crove_sign.public_pdf_source(p_token_sha256 text) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_now timestamptz := pg_catalog.now();
  v_row record;
  v_otp_verified boolean := false;
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
    e.source_storage_key,
    e.source_generation,
    e.source_sha256,
    s.signer_role,
    s.status AS signer_status,
    s.require_email_otp,
    t.status AS tenant_status
  INTO v_row
  FROM crove_sign.signing_token tok
  JOIN crove_sign.envelope e
    ON e.org_id = tok.org_id
   AND e.id = tok.envelope_id
  JOIN crove_sign.signer s
    ON s.org_id = tok.org_id
   AND s.id = tok.signer_id
   AND s.envelope_id = tok.envelope_id
  JOIN crove_kernel.tenant t
    ON t.org_id = tok.org_id
  WHERE tok.token_sha256 = p_token_sha256;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF v_row.tenant_status IS DISTINCT FROM 'active'
     OR NOT crove_kernel.org_app_on(v_row.org_id, 'sign')
     OR v_row.token_revoked_at IS NOT NULL
     OR v_row.token_used_at IS NOT NULL
     OR v_row.token_expires_at <= v_now
     OR v_row.signer_role = 'cc'
     OR v_row.signer_status NOT IN ('pending', 'viewed')
     OR v_row.envelope_status NOT IN ('sent', 'in_progress')
     OR (v_row.envelope_expires_at IS NOT NULL AND v_row.envelope_expires_at <= v_now) THEN
    RETURN NULL;
  END IF;

  v_otp_verified := crove_sign.public_otp_verified_at_for_token(v_row.org_id, v_row.signer_id, v_row.token_id) IS NOT NULL;
  IF v_row.require_email_otp AND NOT v_otp_verified THEN
    RETURN pg_catalog.jsonb_build_object(
      'orgId', v_row.org_id,
      'otpRequired', true
    );
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'orgId', v_row.org_id,
    'otpRequired', false,
    'envelopeId', v_row.envelope_id,
    'signerId', v_row.signer_id,
    'storageKey', v_row.source_storage_key,
    'generation', v_row.source_generation,
    'sha256', v_row.source_sha256
  );
END $$;

REVOKE ALL ON FUNCTION crove_sign.public_pdf_source(text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.public_pdf_source(text) TO crove_app;

CREATE OR REPLACE FUNCTION crove_sign.public_verify_certificate(
  p_certificate_code text,
  p_file_sha256 text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_code text := pg_catalog.upper(pg_catalog.btrim(p_certificate_code));
  v_hash text := pg_catalog.lower(pg_catalog.btrim(p_file_sha256));
  v_row record;
  v_signer_count integer := 0;
BEGIN
  IF v_code IS NULL OR v_code !~ '^CS-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$' THEN
    RETURN NULL;
  END IF;
  IF v_hash IS NULL OR v_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN NULL;
  END IF;

  SELECT
    e.org_id,
    e.id AS envelope_id,
    e.status AS envelope_status,
    e.completed_at,
    e.sealed_sha256,
    t.status AS tenant_status
  INTO v_row
  FROM crove_sign.envelope e
  JOIN crove_kernel.tenant t
    ON t.org_id = e.org_id
  WHERE e.certificate_code = v_code
    AND e.sealed_sha256 = v_hash
    AND e.status = 'completed'
    AND e.seal_status = 'sealed'
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF v_row.tenant_status IS DISTINCT FROM 'active' OR NOT crove_kernel.org_app_on(v_row.org_id, 'sign') THEN
    RETURN NULL;
  END IF;

  SELECT pg_catalog.count(*)::integer
  INTO v_signer_count
  FROM crove_sign.signer s
  WHERE s.org_id = v_row.org_id
    AND s.envelope_id = v_row.envelope_id
    AND s.signer_role <> 'cc'
    AND s.status = 'signed';

  RETURN pg_catalog.jsonb_build_object(
    'orgId', v_row.org_id,
    'matched', true,
    'envelopeStatus', v_row.envelope_status,
    'completedAt', v_row.completed_at,
    'signerCount', v_signer_count,
    'sealedSha256', v_row.sealed_sha256
  );
END $$;

REVOKE ALL ON FUNCTION crove_sign.public_verify_certificate(text, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.public_verify_certificate(text, text) TO crove_app;

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
  FROM crove_kernel.tenant t
  WHERE t.org_id = v_lookup.org_id;

  IF v_tenant.status IS DISTINCT FROM 'active'
     OR NOT crove_kernel.org_app_on(v_lookup.org_id, 'sign')
     OR v_tok.revoked_at IS NOT NULL
     OR v_tok.used_at IS NOT NULL
     OR v_tok.expires_at <= v_now
     OR v_signer.signer_role = 'cc'
     OR v_signer.status NOT IN ('pending', 'viewed')
     OR v_env.status NOT IN ('sent', 'in_progress')
     OR (v_env.expires_at IS NOT NULL AND v_env.expires_at <= v_now) THEN
    RETURN NULL;
  END IF;

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
      'maskedEmail', crove_sign.mask_email(v_signer.email)
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
        'fontSizePt', f.font_size_pt
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
    'fields', v_fields
  );
END $$;

REVOKE ALL ON FUNCTION crove_sign.public_record_view(text, text, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.public_record_view(text, text, text) TO crove_app;

CREATE OR REPLACE FUNCTION crove_sign.public_request_otp(
  p_token_sha256 text,
  p_message_id_domain text DEFAULT 'crove.invalid'
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_now timestamptz := pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp());
  v_exp timestamptz := v_now + interval '10 minutes';
  v_lookup record;
  v_env record;
  v_signer record;
  v_tok record;
  v_tenant record;
  v_otp_verified boolean := false;
  v_email text;
  v_to_hash text;
  v_suppressed boolean := false;
  v_recent integer := 0;
  v_otp_id uuid;
  v_domain text := CASE WHEN p_message_id_domain IS NOT NULL AND pg_catalog.btrim(p_message_id_domain) ~ '^[A-Za-z0-9.-]{1,120}$'
    THEN pg_catalog.lower(pg_catalog.btrim(p_message_id_domain)) ELSE 'crove.invalid' END;
  v_org_name text;
  v_doc_title text;
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

  -- Canonical lock order: envelope -> signer -> signing_token -> signing_otp.
  SELECT e.id, e.title, e.status, e.expires_at
  INTO v_env
  FROM crove_sign.envelope e
  WHERE e.org_id = v_lookup.org_id
    AND e.id = v_lookup.envelope_id
  FOR SHARE;

  SELECT s.id, s.signer_role, s.email, s.require_email_otp, s.status
  INTO v_signer
  FROM crove_sign.signer s
  WHERE s.org_id = v_lookup.org_id
    AND s.envelope_id = v_lookup.envelope_id
    AND s.id = v_lookup.signer_id
  FOR UPDATE;

  SELECT tok.id, tok.expires_at, tok.used_at, tok.revoked_at
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
     OR v_tok.used_at IS NOT NULL
     OR v_tok.expires_at <= v_now
     OR v_signer.signer_role = 'cc'
     OR v_signer.status NOT IN ('pending', 'viewed')
     OR v_env.status NOT IN ('sent', 'in_progress')
     OR (v_env.expires_at IS NOT NULL AND v_env.expires_at <= v_now) THEN
    RETURN NULL;
  END IF;

  v_otp_verified := crove_sign.public_otp_verified_at_for_token(v_lookup.org_id, v_signer.id, v_tok.id) IS NOT NULL;
  IF NOT v_signer.require_email_otp OR v_signer.email IS NULL OR v_otp_verified THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'SIGN_OTP_NOT_REQUIRED',
      'httpStatus', 409,
      'message', 'Email OTP verification is not required or already completed'
    );
  END IF;

  v_email := pg_catalog.lower(pg_catalog.btrim(v_signer.email));
  v_to_hash := crove_kernel.mail_address_hash(v_email);
  IF v_to_hash IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'SIGN_EMAIL_SUPPRESSED',
      'httpStatus', 422,
      'message', 'Signer email address is invalid or suppressed'
    );
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM crove_kernel.mail_suppression ms
    WHERE ms.org_id = v_lookup.org_id
      AND ms.to_hash = v_to_hash
      AND ms.scope = 'all'
      AND ms.lifted_at IS NULL
  )
  INTO v_suppressed;

  IF v_suppressed THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'SIGN_EMAIL_SUPPRESSED',
      'httpStatus', 422,
      'message', 'Signer email address is suppressed'
    );
  END IF;

  SELECT pg_catalog.count(*)::integer
  INTO v_recent
  FROM crove_sign.signing_otp o
  WHERE o.org_id = v_lookup.org_id
    AND o.signer_id = v_signer.id
    AND o.created_at > v_now - interval '1 hour';

  IF v_recent >= 3 THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'SIGN_OTP_RATE_LIMITED',
      'httpStatus', 429,
      'message', 'Too many OTP requests; wait before trying again'
    );
  END IF;

  PERFORM 1
  FROM crove_sign.signing_otp o
  WHERE o.org_id = v_lookup.org_id
    AND o.signer_id = v_signer.id
    AND o.verified_at IS NULL
    AND o.invalidated_at IS NULL
  ORDER BY o.id
  FOR UPDATE;

  UPDATE crove_sign.signing_otp o
  SET invalidated_at = v_now
  WHERE o.org_id = v_lookup.org_id
    AND o.signer_id = v_signer.id
    AND o.verified_at IS NULL
    AND o.invalidated_at IS NULL;

  INSERT INTO crove_sign.signing_otp (
    org_id, signer_id, signing_token_id, email, otp_sha256, expires_at, attempts, created_at
  )
  VALUES (
    v_lookup.org_id, v_signer.id, v_tok.id, v_email, NULL, LEAST(v_tok.expires_at, v_exp), 0, v_now
  )
  RETURNING id INTO v_otp_id;

  v_org_name := COALESCE(NULLIF(pg_catalog.left(pg_catalog.btrim(pg_catalog.regexp_replace(v_tenant.name, '[[:cntrl:]]+', ' ', 'g')), 200), ''), 'Ludy');
  v_doc_title := COALESCE(NULLIF(pg_catalog.left(pg_catalog.btrim(pg_catalog.regexp_replace(v_env.title, '[[:cntrl:]]+', ' ', 'g')), 300), ''), 'Tai lieu');

  INSERT INTO crove_kernel.mail_message (
    org_id, stream, source, source_id, template_key, to_address, to_hash,
    subject, payload, message_id_header, status, created_by
  )
  VALUES (
    v_lookup.org_id,
    'transactional',
    'sign.public.request_otp',
    v_otp_id,
    'sign.otp',
    v_email,
    v_to_hash,
    pg_catalog.left('Ma xac thuc ky tai lieu: ' || v_doc_title, 300),
    pg_catalog.jsonb_build_object(
      'lang', 'vi',
      'orgName', v_org_name,
      'signerId', v_signer.id::text,
      'otpId', v_otp_id::text,
      'docTitle', v_doc_title,
      'expiresAt', pg_catalog.to_char(LEAST(v_tok.expires_at, v_exp) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ),
    '<' || pg_catalog.gen_random_uuid()::text || '@' || v_domain || '>',
    'queued',
    NULL
  );

  RETURN pg_catalog.jsonb_build_object(
    'status', 'ok',
    'sent', true,
    'expiresInMinutes', 10,
    'maskedEmail', crove_sign.mask_email(v_email)
  );
END $$;

REVOKE ALL ON FUNCTION crove_sign.public_request_otp(text, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.public_request_otp(text, text) TO crove_app;

CREATE OR REPLACE FUNCTION crove_sign.public_verify_otp(
  p_token_sha256 text,
  p_code text,
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
  v_otp record;
  v_cand_hash text;
  v_next integer;
  v_locked boolean;
  v_ip_hash text;
  v_actor_label text;
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

  -- Canonical lock order: envelope -> signer -> signing_token -> signing_otp.
  SELECT e.id, e.source_sha256, e.status, e.expires_at
  INTO v_env
  FROM crove_sign.envelope e
  WHERE e.org_id = v_lookup.org_id
    AND e.id = v_lookup.envelope_id
  FOR UPDATE;

  SELECT s.id, s.signer_role, s.name, s.email, s.require_email_otp, s.status
  INTO v_signer
  FROM crove_sign.signer s
  WHERE s.org_id = v_lookup.org_id
    AND s.envelope_id = v_lookup.envelope_id
    AND s.id = v_lookup.signer_id
  FOR UPDATE;

  SELECT tok.id, tok.expires_at, tok.used_at, tok.revoked_at
  INTO v_tok
  FROM crove_sign.signing_token tok
  WHERE tok.org_id = v_lookup.org_id
    AND tok.id = v_lookup.token_id
  FOR UPDATE;

  SELECT t.status
  INTO v_tenant
  FROM crove_kernel.tenant t
  WHERE t.org_id = v_lookup.org_id;

  IF v_tenant.status IS DISTINCT FROM 'active'
     OR NOT crove_kernel.org_app_on(v_lookup.org_id, 'sign')
     OR v_tok.revoked_at IS NOT NULL
     OR v_tok.used_at IS NOT NULL
     OR v_tok.expires_at <= v_now
     OR v_signer.signer_role = 'cc'
     OR v_signer.status NOT IN ('pending', 'viewed')
     OR v_env.status NOT IN ('sent', 'in_progress')
     OR (v_env.expires_at IS NOT NULL AND v_env.expires_at <= v_now) THEN
    RETURN NULL;
  END IF;

  IF p_code IS NULL OR p_code !~ '^\d{6}$' THEN
    RETURN pg_catalog.jsonb_build_object('status', 'validation_error', 'message', 'OTP code must be 6 digits');
  END IF;

  v_otp_verified := crove_sign.public_otp_verified_at_for_token(v_lookup.org_id, v_signer.id, v_tok.id) IS NOT NULL;
  IF NOT v_signer.require_email_otp OR v_otp_verified THEN
    RETURN pg_catalog.jsonb_build_object('ok', true, 'locked', false, 'attemptsRemaining', 5);
  END IF;

  SELECT o.id, o.otp_sha256, o.expires_at, o.attempts, o.invalidated_at
  INTO v_otp
  FROM crove_sign.signing_otp o
  WHERE o.org_id = v_lookup.org_id
    AND o.signer_id = v_signer.id
    AND o.signing_token_id = v_tok.id
    AND o.verified_at IS NULL
  ORDER BY o.created_at DESC, o.id DESC
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'locked', false, 'attemptsRemaining', 0);
  END IF;

  IF v_otp.invalidated_at IS NOT NULL OR v_otp.attempts >= 5 THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'locked', true, 'attemptsRemaining', 0);
  END IF;

  IF v_otp.expires_at <= v_now THEN
    UPDATE crove_sign.signing_otp
    SET invalidated_at = v_now
    WHERE org_id = v_lookup.org_id
      AND id = v_otp.id;
    RETURN pg_catalog.jsonb_build_object('ok', false, 'locked', false, 'attemptsRemaining', 0, 'expired', true);
  END IF;

  IF v_otp.otp_sha256 IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false,
      'locked', false,
      'attemptsRemaining', GREATEST(0, 5 - v_otp.attempts),
      'notReady', true
    );
  END IF;

  v_cand_hash := pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to('crove:sign:otp:v1:' || v_signer.id::text || ':' || v_otp.id::text || ':' || p_code, 'UTF8')
    ),
    'hex'
  );

  IF v_cand_hash = v_otp.otp_sha256 THEN
    UPDATE crove_sign.signing_otp
    SET verified_at = v_now
    WHERE org_id = v_lookup.org_id
      AND id = v_otp.id;

    UPDATE crove_sign.signer
    SET otp_verified_at = v_now,
        updated_at = v_now
    WHERE org_id = v_lookup.org_id
      AND id = v_signer.id;

    v_ip_hash := crove_sign.public_keyed_ip_hash(v_lookup.org_id, p_ip_hash);
    v_actor_label := COALESCE(NULLIF(pg_catalog.btrim(pg_catalog.regexp_replace(COALESCE(v_signer.email, v_signer.name), '[[:cntrl:]]+', ' ', 'g')), ''), 'Signer');
    v_actor_label := pg_catalog.left(v_actor_label, 254);

    PERFORM crove_sign.public_append_event(
      v_lookup.org_id,
      v_env.id,
      v_signer.id,
      'signer_otp_verified',
      'signer',
      v_actor_label,
      v_env.source_sha256,
      pg_catalog.jsonb_build_object('otpId', v_otp.id::text, 'attempts', v_otp.attempts),
      v_ip_hash,
      p_user_agent,
      v_now
    );

    RETURN pg_catalog.jsonb_build_object(
      'ok', true,
      'locked', false,
      'attemptsRemaining', GREATEST(0, 5 - v_otp.attempts)
    );
  END IF;

  v_next := v_otp.attempts + 1;
  v_locked := v_next >= 5;
  UPDATE crove_sign.signing_otp
  SET attempts = v_next,
      invalidated_at = CASE WHEN v_locked THEN v_now ELSE NULL END
  WHERE org_id = v_lookup.org_id
    AND id = v_otp.id;

  RETURN pg_catalog.jsonb_build_object(
    'ok', false,
    'locked', v_locked,
    'attemptsRemaining', GREATEST(0, 5 - v_next)
  );
END $$;

REVOKE ALL ON FUNCTION crove_sign.public_verify_otp(text, text, text, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.public_verify_otp(text, text, text, text) TO crove_app;

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

    IF v_field.field_type = 'signature' THEN
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
          RETURN pg_catalog.jsonb_build_object('status', 'error', 'code', 'SIGN_INVALID_SIGNATURE_PNG', 'httpStatus', 422, 'message', 'Signature PNG is malformed');
        END IF;
        BEGIN
          v_png_bytes := pg_catalog.decode(v_raw_b64, 'base64');
        EXCEPTION WHEN OTHERS THEN
          RETURN pg_catalog.jsonb_build_object('status', 'error', 'code', 'SIGN_INVALID_SIGNATURE_PNG', 'httpStatus', 422, 'message', 'Signature PNG base64 decode failed');
        END;
        IF pg_catalog.octet_length(v_png_bytes) < 45
           OR pg_catalog.octet_length(v_png_bytes) > 262144
           OR pg_catalog.substr(v_png_bytes, 1, 8) IS DISTINCT FROM '\x89504e470d0a1a0a'::bytea THEN
          RETURN pg_catalog.jsonb_build_object('status', 'error', 'code', 'SIGN_INVALID_SIGNATURE_PNG', 'httpStatus', 422, 'message', 'Signature payload does not contain a valid PNG image');
        END IF;
        v_saw_sig_png := true;
      ELSIF v_field.required THEN
        RETURN pg_catalog.jsonb_build_object('status', 'error', 'code', 'SIGN_FIELD_REQUIRED', 'httpStatus', 422, 'message', 'Required signature field is missing a PNG signature');
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

REVOKE ALL ON FUNCTION crove_sign.public_submit(text, boolean, text, text, jsonb, text, text, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.public_submit(text, boolean, text, text, jsonb, text, text, text) TO crove_app;

CREATE OR REPLACE FUNCTION crove_sign.public_decline(
  p_token_sha256 text,
  p_reason text DEFAULT NULL,
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
  v_reason text := pg_catalog.left(NULLIF(pg_catalog.btrim(COALESCE(p_reason, '')), ''), 1000);
  v_ip_hash text;
  v_ua text := pg_catalog.left(NULLIF(pg_catalog.btrim(pg_catalog.regexp_replace(COALESCE(p_user_agent, ''), '[[:cntrl:]]+', ' ', 'g')), ''), 500);
  v_revoked integer := 0;
  v_actor_label text;
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

  -- Canonical lock order: envelope -> signer (ORDER BY id) -> signing_token (ORDER BY id) -> signing_otp (ORDER BY id).
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

  PERFORM 1
  FROM crove_sign.signing_token tok
  WHERE tok.org_id = v_lookup.org_id
    AND tok.envelope_id = v_lookup.envelope_id
  ORDER BY tok.id
  FOR UPDATE;

  SELECT tok.*
  INTO v_tok
  FROM crove_sign.signing_token tok
  WHERE tok.org_id = v_lookup.org_id
    AND tok.id = v_lookup.token_id;

  SELECT t.status
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

  IF v_signer.require_email_otp
     AND crove_sign.public_otp_verified_at_for_token(v_lookup.org_id, v_signer.id, v_tok.id) IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'SIGN_OTP_REQUIRED',
      'httpStatus', 403,
      'message', 'Email OTP verification is required before declining'
    );
  END IF;

  UPDATE crove_sign.signing_token
  SET used_at = v_now
  WHERE org_id = v_lookup.org_id
    AND id = v_tok.id
    AND used_at IS NULL
    AND revoked_at IS NULL;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'already_used');
  END IF;

  v_ip_hash := crove_sign.public_keyed_ip_hash(v_lookup.org_id, p_ip_hash);

  UPDATE crove_sign.signer
  SET status = 'declined',
      declined_at = v_now,
      decline_reason = v_reason,
      signer_ip_hash = COALESCE(v_ip_hash, v_signer.signer_ip_hash),
      signer_user_agent = COALESCE(v_ua, v_signer.signer_user_agent),
      updated_at = v_now
  WHERE org_id = v_lookup.org_id
    AND id = v_signer.id;

  UPDATE crove_sign.envelope
  SET status = 'declined',
      declined_at = v_now,
      version = v_env.version + 1,
      updated_at = v_now
  WHERE org_id = v_lookup.org_id
    AND id = v_env.id;

  UPDATE crove_sign.signing_token tok
  SET revoked_at = v_now
  WHERE tok.org_id = v_lookup.org_id
    AND tok.envelope_id = v_env.id
    AND tok.revoked_at IS NULL
    AND tok.used_at IS NULL;
  GET DIAGNOSTICS v_revoked = ROW_COUNT;

  PERFORM 1
  FROM crove_sign.signing_otp o
  WHERE o.org_id = v_lookup.org_id
    AND o.signer_id IN (
      SELECT s2.id
      FROM crove_sign.signer s2
      WHERE s2.org_id = v_lookup.org_id
        AND s2.envelope_id = v_env.id
    )
    AND o.verified_at IS NULL
    AND o.invalidated_at IS NULL
  ORDER BY o.id
  FOR UPDATE;

  UPDATE crove_sign.signing_otp o
  SET invalidated_at = v_now
  WHERE o.org_id = v_lookup.org_id
    AND o.signer_id IN (
      SELECT s2.id
      FROM crove_sign.signer s2
      WHERE s2.org_id = v_lookup.org_id
        AND s2.envelope_id = v_env.id
    )
    AND o.verified_at IS NULL
    AND o.invalidated_at IS NULL;

  v_actor_label := COALESCE(NULLIF(pg_catalog.btrim(pg_catalog.regexp_replace(COALESCE(v_signer.email, v_signer.name), '[[:cntrl:]]+', ' ', 'g')), ''), 'Signer');
  v_actor_label := pg_catalog.left(v_actor_label, 254);

  PERFORM crove_sign.public_append_event(
    v_lookup.org_id,
    v_env.id,
    v_signer.id,
    'signer_declined',
    'signer',
    v_actor_label,
    v_env.source_sha256,
    pg_catalog.jsonb_build_object(
      'reasonProvided', v_reason IS NOT NULL,
      'revokedTokens', v_revoked
    ),
    v_ip_hash,
    v_ua,
    v_now
  );

  RETURN pg_catalog.jsonb_build_object(
    'status', 'ok',
    'signerId', v_signer.id,
    'signerStatus', 'declined',
    'envelopeStatus', 'declined',
    'declinedAt', pg_catalog.to_char(v_now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
END $$;

REVOKE ALL ON FUNCTION crove_sign.public_decline(text, text, text, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.public_decline(text, text, text, text) TO crove_app;
