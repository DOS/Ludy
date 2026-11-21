-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove eSign Slice 4d (#3820, docs/plan/esign.md):
--   1. In-person host signing ceremony: add in_person_host_user_id on crove_sign.signing_token,
--      host_user_id on crove_sign.signing_event, crove_sign.mint_in_person_signing_token (max 2h TTL,
--      hr_contract confidentiality), in-person delegation block in public_token_resolve, public_record_view,
--      and public_delegate, active in-person session protection in public_mail_token_issue, and host
--      provenance in public_submit (recording in_person_signed in the hash-chained signing_event ledger).
--   2. Self-service public template hub: add listed_on_public_hub on crove_sign.template_direct_link,
--      update direct-link management definers and revocation triggers, and add narrow orgless
--      SECURITY DEFINER public_hub_* resolvers enforcing crove_kernel.org_app_on(org_id, 'sign'),
--      active 1-signer inspected templates, listed_on_public_hub = true, and zero plaintext tokens.

SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. In-person host signing columns, immutability, and hash-chained provenance
-- ---------------------------------------------------------------------------

ALTER TABLE crove_sign.signing_token
  ADD COLUMN IF NOT EXISTS in_person_host_user_id uuid REFERENCES crove_kernel.user_account (id);

CREATE OR REPLACE FUNCTION crove_sign.signing_token_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF (
    NEW.org_id,
    NEW.id,
    NEW.envelope_id,
    NEW.signer_id,
    NEW.token_sha256,
    NEW.expires_at,
    NEW.in_person_host_user_id,
    NEW.created_by,
    NEW.created_at
  ) IS DISTINCT FROM (
    OLD.org_id,
    OLD.id,
    OLD.envelope_id,
    OLD.signer_id,
    OLD.token_sha256,
    OLD.expires_at,
    OLD.in_person_host_user_id,
    OLD.created_by,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION 'SIGNING_TOKEN_IMMUTABLE'
      USING ERRCODE = '42501', DETAIL = 'signing_token identity, host, and hash columns are immutable';
  END IF;
  IF OLD.used_at IS NOT NULL OR OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'SIGNING_TOKEN_FINAL'
      USING ERRCODE = '42501', DETAIL = 'used or revoked signing_token cannot be modified';
  END IF;
  IF NEW.used_at IS NOT NULL AND NEW.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'SIGNING_TOKEN_INVALID_STATE'
      USING ERRCODE = '42501', DETAIL = 'signing_token cannot be both used and revoked';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION crove_sign.signing_token_immutable()
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

ALTER TABLE crove_sign.signing_event
  ADD COLUMN IF NOT EXISTS host_user_id uuid REFERENCES crove_kernel.user_account (id);

CREATE INDEX IF NOT EXISTS signing_event_host_user_idx
  ON crove_sign.signing_event (org_id, host_user_id)
  WHERE host_user_id IS NOT NULL;

CREATE OR REPLACE FUNCTION crove_sign.public_append_event_with_host(
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
  p_occurred_at timestamptz,
  p_host_user_id uuid
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
  v_base jsonb;
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
  v_base := pg_catalog.jsonb_build_object(
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
  );
  IF p_host_user_id IS NOT NULL THEN
    v_base := v_base || pg_catalog.jsonb_build_object('hostUserId', p_host_user_id::text);
  END IF;
  v_canonical := crove_sign.canonical_jsonb(v_base);
  v_hash := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_canonical, 'UTF8')), 'hex');

  INSERT INTO crove_sign.signing_event (
    org_id, envelope_id, signer_id, host_user_id, seq, event_type, actor_type, actor_id, actor_label,
    document_sha256, prev_event_hash, event_hash, payload_json, ip_hash, user_agent, occurred_at
  )
  VALUES (
    p_org_id, p_envelope_id, p_signer_id, p_host_user_id, v_seq, p_event_type, p_actor_type, NULL, p_actor_label,
    p_document_sha256, v_prev, v_hash, v_payload, v_ip_hash, v_ua, v_occ
  );
END $$;

REVOKE ALL ON FUNCTION crove_sign.public_append_event_with_host(uuid, uuid, uuid, text, text, text, text, jsonb, text, text, timestamptz, uuid)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

CREATE OR REPLACE FUNCTION crove_sign.mint_in_person_signing_token(
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
  v_env_expires_at timestamptz;
  v_signer_status text;
  v_signer_role text;
  v_token_id uuid;
BEGIN
  IF v_org IS NULL OR v_actor IS DISTINCT FROM 'user' OR crove_kernel.ctx_agent_id() IS NOT NULL OR v_user IS NULL THEN
    RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF NOT crove_kernel.org_app_on(v_org, 'sign') THEN
    RAISE EXCEPTION 'SIGN_APP_DISABLED' USING ERRCODE = '42501';
  END IF;

  SELECT m.role INTO v_role
  FROM crove_kernel.tenant_member m
  WHERE m.org_id = v_org
    AND m.user_id = v_user
    AND m.role IN ('owner', 'admin', 'member');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  IF p_token_sha256 IS NULL OR p_token_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'SIGN_INVALID_TOKEN_HASH' USING ERRCODE = '22023';
  END IF;
  IF p_expires_at IS NULL OR p_expires_at <= v_now OR p_expires_at > v_now + interval '2 hours' + interval '5 minutes' THEN
    RAISE EXCEPTION 'SIGN_INVALID_EXPIRY' USING ERRCODE = '22023';
  END IF;

  SELECT e.status, e.created_by, e.source_kind, e.expires_at
  INTO v_env_status, v_env_creator, v_env_source_kind, v_env_expires_at
  FROM crove_sign.envelope e
  WHERE e.org_id = v_org AND e.id = p_envelope_id
  FOR SHARE;
  IF v_env_status IS NULL OR v_env_status NOT IN ('sent', 'in_progress') THEN
    RAISE EXCEPTION 'ENVELOPE_NOT_ACTIVE' USING ERRCODE = '42501';
  END IF;
  IF v_env_expires_at IS NOT NULL AND v_env_expires_at <= v_now THEN
    RAISE EXCEPTION 'ENVELOPE_NOT_ACTIVE' USING ERRCODE = '42501';
  END IF;
  IF v_env_source_kind = 'hr_contract'
     AND v_user IS DISTINCT FROM v_env_creator
     AND v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'ENVELOPE_NOT_ACTIVE' USING ERRCODE = '42501';
  END IF;

  SELECT s.status, s.signer_role
  INTO v_signer_status, v_signer_role
  FROM crove_sign.signer s
  WHERE s.org_id = v_org AND s.id = p_signer_id AND s.envelope_id = p_envelope_id
  FOR UPDATE;
  IF v_signer_status IS NULL OR v_signer_role = 'cc' OR v_signer_status NOT IN ('pending', 'viewed') THEN
    RAISE EXCEPTION 'SIGNER_NOT_LIVE' USING ERRCODE = '42501';
  END IF;

  UPDATE crove_sign.signing_token t
  SET revoked_at = v_now,
      revoked_by = v_user
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

  INSERT INTO crove_sign.signing_token (
    org_id, envelope_id, signer_id, token_sha256, expires_at, in_person_host_user_id, created_by, created_at
  )
  VALUES (
    v_org, p_envelope_id, p_signer_id, p_token_sha256, p_expires_at, v_user, v_user, v_now
  )
  RETURNING id INTO v_token_id;

  RETURN v_token_id;
END $$;

REVOKE ALL ON FUNCTION crove_sign.mint_in_person_signing_token(uuid, uuid, text, timestamptz)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.mint_in_person_signing_token(uuid, uuid, text, timestamptz) TO crove_tenant;

-- Prevent queued remote sign.invite / sign.remind messages from revoking a live unexpired in-person host session
-- or minting a remote link while the signer is actively completing an in-person ceremony (#3820, #4280).
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
  v_mail record;
  v_existing record;
  v_active record;
  v_prev_mail record;
  v_prev_msg text;
  v_prev_mac bytea;
  v_prev_raw text;
  v_prev_hash text;
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

  SELECT s.id, s.name, s.signer_role, s.status, s.delivery_mode, s.email
  INTO v_signer
  FROM crove_sign.signer s
  WHERE s.org_id = v_org
    AND s.envelope_id = v_env.id
    AND s.id = p_signer_id
  FOR UPDATE;

  IF NOT FOUND
     OR v_signer.signer_role = 'cc'
     OR v_signer.status NOT IN ('pending', 'viewed')
     OR v_signer.delivery_mode IS DISTINCT FROM 'email'
     OR v_signer.email IS NULL THEN
    RETURN NULL;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM crove_sign.signing_token st
    WHERE st.org_id = v_org
      AND st.signer_id = v_signer.id
      AND st.in_person_host_user_id IS NOT NULL
      AND st.revoked_at IS NULL
      AND st.used_at IS NULL
      AND st.expires_at > p_now
  ) THEN
    RETURN NULL;
  END IF;

  SELECT m.id, m.source, m.to_address, m.created_at
  INTO v_mail
  FROM crove_kernel.mail_message m
  WHERE m.org_id = v_org
    AND m.id = p_message_id;

  IF NOT FOUND
     OR v_mail.to_address IS NULL
     OR pg_catalog.lower(pg_catalog.btrim(v_mail.to_address)) <> pg_catalog.lower(pg_catalog.btrim(v_signer.email))
     OR EXISTS (
       SELECT 1
       FROM crove_kernel.mail_message m2
       WHERE m2.org_id = v_org
         AND m2.source_id = v_signer.id
         AND m2.template_key = 'sign.invite'
         AND m2.source IN ('sign.signer.correct_recipient', 'sign.public.delegate')
         AND (m2.created_at, m2.id) > (v_mail.created_at, v_mail.id)
     ) THEN
    RETURN NULL;
  END IF;

  SELECT k.k_ipad, k.k_opad
  INTO v_ipad, v_opad
  FROM crove_kernel.mail_hash_key k
  WHERE k.id = 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MAIL_HASH_KEY_MISSING' USING ERRCODE = '55000';
  END IF;

  -- Preserve #3813 non-disruptive token reuse for automatic 24h pre-expiry reminders (#4158).
  IF v_mail.source = 'sign.envelope.pre_expiry_remind_sweep' THEN
    SELECT t.id, t.token_sha256, t.expires_at, t.last_viewed_at
    INTO v_active
    FROM crove_sign.signing_token t
    WHERE t.org_id = v_org
      AND t.signer_id = v_signer.id
      AND t.revoked_at IS NULL
      AND t.used_at IS NULL
    FOR UPDATE;

    IF FOUND AND v_active.expires_at > p_now THEN
      FOR v_prev_mail IN
        SELECT m.id
        FROM crove_kernel.mail_message m
        WHERE m.org_id = v_org
          AND m.source_id = v_signer.id
          AND m.template_key IN ('sign.invite', 'sign.remind')
          AND m.id <> p_message_id
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT 10
      LOOP
        v_prev_msg := 'crove:sign:mail-token:v1:' || v_org::text || ':' || v_env.id::text || ':' || v_signer.id::text || ':' || v_prev_mail.id::text;
        v_prev_mac := pg_catalog.sha256(v_opad OPERATOR(pg_catalog.||) pg_catalog.sha256(v_ipad OPERATOR(pg_catalog.||) pg_catalog.convert_to(v_prev_msg, 'UTF8')));
        v_prev_raw := pg_catalog.rtrim(pg_catalog.translate(pg_catalog.encode(v_prev_mac, 'base64'), '+/', '-_'), '=');
        v_prev_hash := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_prev_raw, 'UTF8')), 'hex');
        IF v_prev_hash = v_active.token_sha256 THEN
          RETURN pg_catalog.jsonb_build_object(
            'tokenId', v_active.id,
            'token', v_prev_raw,
            'signerName', v_signer.name,
            'message', v_env.message,
            'expiresAt', pg_catalog.to_char(v_active.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'minted', false
          );
        END IF;
      END LOOP;

      IF v_active.last_viewed_at IS NOT NULL AND v_active.last_viewed_at > p_now - interval '15 minutes' THEN
        RETURN NULL;
      END IF;
    END IF;
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
    tok.in_person_host_user_id,
    e.title,
    e.message,
    e.status AS envelope_status,
    e.routing_mode,
    e.allow_delegation,
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
    s.delegation_count,
    s.delegated_from_name,
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
    'inPerson', v_row.in_person_host_user_id IS NOT NULL,
    'inPersonHostUserId', v_row.in_person_host_user_id,
    'envelopeStatus', v_row.envelope_status,
    'signerStatus', v_row.signer_status,
    'signerRole', v_row.signer_role,
    'routingMode', v_row.routing_mode,
    'routingOrder', v_row.routing_order,
    'requireEmailOtp', v_row.require_email_otp,
    'otpVerifiedAt', v_otp_verified_at,
    'allowDelegation', (v_row.allow_delegation AND v_row.in_person_host_user_id IS NULL AND v_row.signer_role IN ('signer', 'approver') AND v_row.delegation_count < 2),
    'delegationCount', v_row.delegation_count,
    'delegatedFromName', v_row.delegated_from_name,
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

REVOKE ALL ON FUNCTION crove_sign.public_record_view(text, text, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.public_record_view(text, text, text) TO crove_app;

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

  UPDATE crove_sign.signing_token
  SET used_at = v_now
  WHERE org_id = v_lookup.org_id
    AND id = v_tok.id
    AND used_at IS NULL
    AND revoked_at IS NULL;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'already_used');
  END IF;

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
    'inPerson', v_tok.in_person_host_user_id IS NOT NULL,
    'signedAt', pg_catalog.to_char(v_now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
END $$;

REVOKE ALL ON FUNCTION crove_sign.public_submit(text, boolean, text, text, jsonb, text, text, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.public_submit(text, boolean, text, text, jsonb, text, text, text) TO crove_app;

-- Block active in-person signing tokens from delegating via POST /api/sign/delegate (#3820, #4280).
CREATE OR REPLACE FUNCTION crove_sign.public_delegate(
  p_token_sha256 text,
  p_delegate_name text,
  p_delegate_email text,
  p_reason text DEFAULT NULL,
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
  v_delegate_name text := NULLIF(pg_catalog.btrim(pg_catalog.regexp_replace(COALESCE(p_delegate_name, ''), '[[:cntrl:]]+', ' ', 'g')), '');
  v_delegate_email text := NULLIF(pg_catalog.lower(pg_catalog.btrim(COALESCE(p_delegate_email, ''))), '');
  v_reason text := pg_catalog.left(NULLIF(pg_catalog.btrim(pg_catalog.regexp_replace(COALESCE(p_reason, ''), '[[:cntrl:]]+', ' ', 'g')), ''), 500);
  v_ip_hash text;
  v_ua text := pg_catalog.left(NULLIF(pg_catalog.btrim(pg_catalog.regexp_replace(COALESCE(p_user_agent, ''), '[[:cntrl:]]+', ' ', 'g')), ''), 500);
  v_domain text := CASE WHEN p_message_id_domain IS NOT NULL AND pg_catalog.btrim(p_message_id_domain) ~ '^[A-Za-z0-9.-]{1,120}$'
    THEN pg_catalog.lower(pg_catalog.btrim(p_message_id_domain)) ELSE 'crove.invalid' END;
  v_to_hash text;
  v_suppressed boolean := false;
  v_sender_email text;
  v_sender_hash text;
  v_sender_suppressed boolean := false;
  v_prev_name text;
  v_prev_email text;
  v_next_count integer;
  v_org_name text;
  v_doc_title text;
  v_role_label text;
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

  -- Canonical lock order: envelope -> signer -> signing_token -> signing_otp.
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
    AND tok.signer_id = v_lookup.signer_id
  ORDER BY tok.id
  FOR UPDATE;

  SELECT tok.*
  INTO v_tok
  FROM crove_sign.signing_token tok
  WHERE tok.org_id = v_lookup.org_id
    AND tok.id = v_lookup.token_id;

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

  IF v_tok.in_person_host_user_id IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'SIGN_DELEGATION_DISABLED',
      'httpStatus', 403,
      'message', 'Signer delegation is disabled for in-person signing sessions'
    );
  END IF;

  IF v_signer.require_email_otp
     AND crove_sign.public_otp_verified_at_for_token(v_lookup.org_id, v_signer.id, v_tok.id) IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'SIGN_OTP_REQUIRED',
      'httpStatus', 403,
      'message', 'Email OTP verification is required before delegating'
    );
  END IF;

  IF NOT v_env.allow_delegation OR v_tok.in_person_host_user_id IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'SIGN_DELEGATION_DISABLED',
      'httpStatus', 403,
      'message', 'Signer delegation is disabled for this envelope'
    );
  END IF;

  IF v_signer.delegation_count >= 2 THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'SIGN_DELEGATION_LIMIT_REACHED',
      'httpStatus', 409,
      'message', 'Maximum delegation limit (2) reached for this recipient'
    );
  END IF;

  IF v_delegate_name IS NULL OR pg_catalog.length(v_delegate_name) > 200 THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'VALIDATION',
      'httpStatus', 422,
      'message', 'Delegate name must be between 1 and 200 characters'
    );
  END IF;

  IF v_delegate_email IS NULL OR NOT crove_sign.is_single_mail_address(v_delegate_email) THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'VALIDATION',
      'httpStatus', 422,
      'message', 'Delegate email must be a valid single mailbox address'
    );
  END IF;

  IF v_signer.email IS NOT NULL AND pg_catalog.lower(pg_catalog.btrim(v_signer.email)) = v_delegate_email THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'SIGN_DELEGATE_SAME_EMAIL',
      'httpStatus', 422,
      'message', 'Delegate email must differ from the current recipient email'
    );
  END IF;

  IF v_reason IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'VALIDATION',
      'httpStatus', 422,
      'message', 'Delegation reason is required'
    );
  END IF;

  v_to_hash := crove_kernel.mail_address_hash(v_delegate_email);
  IF v_to_hash IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'SIGN_EMAIL_SUPPRESSED',
      'httpStatus', 422,
      'message', 'Delegate email address cannot receive invitations'
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
      'message', 'Delegate email address is suppressed'
    );
  END IF;

  PERFORM 1
  FROM crove_sign.signing_otp o
  WHERE o.org_id = v_lookup.org_id
    AND o.signer_id = v_signer.id
    AND o.invalidated_at IS NULL
  ORDER BY o.id
  FOR UPDATE;

  UPDATE crove_sign.signing_token
  SET used_at = v_now
  WHERE org_id = v_lookup.org_id
    AND id = v_tok.id
    AND used_at IS NULL
    AND revoked_at IS NULL;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'already_used');
  END IF;

  UPDATE crove_sign.signing_token
  SET revoked_at = v_now
  WHERE org_id = v_lookup.org_id
    AND signer_id = v_signer.id
    AND id <> v_tok.id
    AND used_at IS NULL
    AND revoked_at IS NULL;

  UPDATE crove_sign.signing_otp o
  SET invalidated_at = v_now
  WHERE o.org_id = v_lookup.org_id
    AND o.signer_id = v_signer.id
    AND o.invalidated_at IS NULL;

  v_prev_name := v_signer.name;
  v_prev_email := v_signer.email;
  v_next_count := v_signer.delegation_count + 1;
  v_ip_hash := crove_sign.public_keyed_ip_hash(v_lookup.org_id, p_ip_hash);

  UPDATE crove_sign.signer
  SET name = v_delegate_name,
      email = v_delegate_email,
      delivery_mode = 'email',
      status = 'pending',
      viewed_at = NULL,
      otp_verified_at = NULL,
      token_last_reminded_at = NULL,
      delegated_from_name = v_prev_name,
      delegated_from_email = v_prev_email,
      delegation_reason = v_reason,
      delegation_count = v_next_count,
      updated_at = v_now
  WHERE org_id = v_lookup.org_id
    AND id = v_signer.id;

  UPDATE crove_sign.envelope
  SET version = v_env.version + 1,
      updated_at = v_now
  WHERE org_id = v_lookup.org_id
    AND id = v_env.id;

  v_actor_label := COALESCE(NULLIF(pg_catalog.btrim(pg_catalog.regexp_replace(COALESCE(v_prev_email, v_prev_name), '[[:cntrl:]]+', ' ', 'g')), ''), 'Signer');
  v_actor_label := pg_catalog.left(v_actor_label, 254);

  PERFORM crove_sign.public_append_event(
    v_lookup.org_id,
    v_env.id,
    v_signer.id,
    'signer_delegated',
    'signer',
    v_actor_label,
    v_env.source_sha256,
    pg_catalog.jsonb_build_object(
      'routingOrder', v_signer.routing_order,
      'fromName', v_prev_name,
      'fromMaskedEmail', crove_sign.mask_email(v_prev_email),
      'delegateName', v_delegate_name,
      'delegateMaskedEmail', crove_sign.mask_email(v_delegate_email),
      'delegationCount', v_next_count,
      'reasonProvided', true
    ),
    v_ip_hash,
    v_ua,
    v_now
  );

  v_org_name := COALESCE(NULLIF(pg_catalog.left(pg_catalog.btrim(pg_catalog.regexp_replace(v_tenant.name, '[[:cntrl:]]+', ' ', 'g')), 200), ''), 'Ludy');
  v_doc_title := COALESCE(NULLIF(pg_catalog.left(pg_catalog.btrim(pg_catalog.regexp_replace(v_env.title, '[[:cntrl:]]+', ' ', 'g')), 300), ''), 'Tai lieu');
  v_role_label := COALESCE(NULLIF(pg_catalog.left(pg_catalog.btrim(pg_catalog.regexp_replace(v_signer.role_label, '[[:cntrl:]]+', ' ', 'g')), 120), ''), CASE WHEN v_signer.signer_role = 'approver' THEN 'Nguoi duyet' ELSE 'Nguoi ky' END);

  -- Queue fresh signing invitation to the delegate (zero plaintext token stored in mail_message).
  INSERT INTO crove_kernel.mail_message (
    org_id, stream, source, source_id, template_key, to_address, to_hash,
    subject, payload, message_id_header, status, created_by
  )
  VALUES (
    v_lookup.org_id,
    'transactional',
    'sign.public.delegate',
    v_signer.id,
    'sign.invite',
    v_delegate_email,
    v_to_hash,
    pg_catalog.left((CASE WHEN v_signer.signer_role = 'approver' THEN 'Moi duyet: ' ELSE 'Moi ky: ' END) || v_doc_title, 300),
    pg_catalog.jsonb_build_object(
      'lang', 'vi',
      'orgName', v_org_name,
      'envelopeId', v_env.id::text,
      'signerId', v_signer.id::text,
      'signerRole', CASE WHEN v_signer.signer_role = 'approver' THEN 'approver' ELSE 'signer' END,
      'docTitle', v_doc_title,
      'roleLabel', v_role_label,
      'expiresAt', CASE WHEN v_env.expires_at IS NOT NULL
        THEN pg_catalog.to_char(v_env.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        ELSE NULL END
    ),
    '<' || pg_catalog.gen_random_uuid()::text || '@' || v_domain || '>',
    'queued',
    NULL
  );

  -- Notify the envelope sender (created_by) about the audited delegation.
  SELECT NULLIF(pg_catalog.lower(pg_catalog.btrim(u.email)), '')
  INTO v_sender_email
  FROM crove_kernel.user_account u
  WHERE u.id = v_env.created_by;

  IF v_sender_email IS NOT NULL AND crove_sign.is_single_mail_address(v_sender_email) THEN
    v_sender_hash := crove_kernel.mail_address_hash(v_sender_email);
    IF v_sender_hash IS NOT NULL THEN
      SELECT EXISTS (
        SELECT 1
        FROM crove_kernel.mail_suppression ms
        WHERE ms.org_id = v_lookup.org_id
          AND ms.to_hash = v_sender_hash
          AND ms.scope = 'all'
          AND ms.lifted_at IS NULL
      )
      INTO v_sender_suppressed;

      INSERT INTO crove_kernel.mail_message (
        org_id, stream, source, source_id, template_key, to_address, to_hash,
        subject, payload, message_id_header, status, created_by
      )
      VALUES (
        v_lookup.org_id,
        'transactional',
        'sign.public.delegate',
        v_env.id,
        'sign.delegated',
        v_sender_email,
        v_sender_hash,
        pg_catalog.left('Uy quyen ky: ' || v_doc_title, 300),
        pg_catalog.jsonb_build_object(
          'lang', 'vi',
          'orgName', v_org_name,
          'envelopeId', v_env.id::text,
          'signerId', v_signer.id::text,
          'docTitle', v_doc_title,
          'roleLabel', v_role_label,
          'delegationCount', v_next_count
        ),
        '<' || pg_catalog.gen_random_uuid()::text || '@' || v_domain || '>',
        CASE WHEN v_sender_suppressed THEN 'suppressed' ELSE 'queued' END,
        NULL
      );
    END IF;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'ok',
    'signerId', v_signer.id,
    'delegateName', v_delegate_name,
    'maskedDelegateEmail', crove_sign.mask_email(v_delegate_email),
    'delegationCount', v_next_count,
    'delegatedAt', pg_catalog.to_char(v_now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
END $$;

REVOKE ALL ON FUNCTION crove_sign.public_delegate(text, text, text, text, text, text, text)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.public_delegate(text, text, text, text, text, text, text) TO crove_app;

-- ---------------------------------------------------------------------------
-- 2. Self-service public template hub on crove_sign.template_direct_link
-- ---------------------------------------------------------------------------

ALTER TABLE crove_sign.template_direct_link
  ADD COLUMN IF NOT EXISTS listed_on_public_hub boolean NOT NULL DEFAULT false;

UPDATE crove_sign.template_direct_link
SET listed_on_public_hub = false
WHERE listed_on_public_hub AND (NOT enabled OR revoked_at IS NOT NULL);

ALTER TABLE crove_sign.template_direct_link
  DROP CONSTRAINT IF EXISTS template_direct_link_hub_enabled_check;
ALTER TABLE crove_sign.template_direct_link
  ADD CONSTRAINT template_direct_link_hub_enabled_check
  CHECK (NOT (listed_on_public_hub AND (NOT enabled OR revoked_at IS NOT NULL)));

CREATE INDEX IF NOT EXISTS template_direct_link_public_hub_idx
  ON crove_sign.template_direct_link (org_id, template_id)
  WHERE enabled = true AND listed_on_public_hub = true AND revoked_at IS NULL;

CREATE OR REPLACE FUNCTION crove_sign.template_direct_link_revoke_for_template(
  p_template_id uuid
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_actor text := crove_kernel.ctx_actor_type();
  v_user uuid := crove_kernel.ctx_user_id();
  v_now timestamptz := pg_catalog.now();
  v_count integer := 0;
BEGIN
  IF v_org IS NULL OR v_actor IS NULL OR p_template_id IS NULL THEN
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
      WHERE m.org_id = v_org AND m.user_id = v_user AND m.role IN ('owner', 'admin', 'member')
    ) THEN
      RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
  END IF;

  WITH updated AS (
    UPDATE crove_sign.template_direct_link
    SET enabled = false,
        listed_on_public_hub = false,
        revoked_at = v_now,
        revoked_by = v_user,
        updated_at = v_now
    WHERE org_id = v_org AND template_id = p_template_id AND revoked_at IS NULL
    RETURNING id
  )
  SELECT pg_catalog.count(*)::integer INTO v_count FROM updated;

  RETURN v_count;
END $$;

REVOKE ALL ON FUNCTION crove_sign.template_direct_link_revoke_for_template(uuid)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.template_direct_link_revoke_for_template(uuid) TO crove_tenant;

CREATE OR REPLACE FUNCTION crove_sign.template_direct_link_sync_on_template() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF (NEW.status <> 'active' OR NEW.inspect_status <> 'passed')
     AND EXISTS (
       SELECT 1 FROM crove_sign.template_direct_link l
       WHERE l.org_id = NEW.org_id AND l.template_id = NEW.id AND l.revoked_at IS NULL
     ) THEN
    UPDATE crove_sign.template_direct_link
    SET enabled = false,
        listed_on_public_hub = false,
        revoked_at = pg_catalog.now(),
        revoked_by = crove_kernel.ctx_user_id(),
        updated_at = pg_catalog.now()
    WHERE org_id = NEW.org_id AND template_id = NEW.id AND revoked_at IS NULL;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION crove_sign.template_direct_link_sync_on_role() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := COALESCE(NEW.org_id, OLD.org_id);
  v_tpl_id uuid := COALESCE(NEW.template_id, OLD.template_id);
  v_non_cc_count integer;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.signer_role IS NOT DISTINCT FROM NEW.signer_role THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM crove_sign.template_direct_link l
    WHERE l.org_id = v_org AND l.template_id = v_tpl_id AND l.revoked_at IS NULL
  ) THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM crove_sign.template t WHERE t.org_id = v_org AND t.id = v_tpl_id) THEN
    RETURN NULL;
  END IF;
  SELECT pg_catalog.count(*)::integer
  INTO v_non_cc_count
  FROM crove_sign.template_role r
  WHERE r.org_id = v_org AND r.template_id = v_tpl_id AND r.signer_role <> 'cc';

  IF v_non_cc_count <> 1 THEN
    UPDATE crove_sign.template_direct_link
    SET enabled = false,
        listed_on_public_hub = false,
        revoked_at = pg_catalog.now(),
        revoked_by = crove_kernel.ctx_user_id(),
        updated_at = pg_catalog.now()
    WHERE org_id = v_org AND template_id = v_tpl_id AND revoked_at IS NULL;
  END IF;
  RETURN NULL;
END $$;

REVOKE ALL ON FUNCTION crove_sign.template_direct_link_sync_on_template(), crove_sign.template_direct_link_sync_on_role()
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

CREATE OR REPLACE FUNCTION crove_sign.template_direct_link_state(
  p_template_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_actor text := crove_kernel.ctx_actor_type();
  v_user uuid := crove_kernel.ctx_user_id();
  v_row record;
BEGIN
  IF v_org IS NULL OR v_actor IS NULL OR p_template_id IS NULL THEN
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

  SELECT l.id, l.enabled, l.require_email_otp, l.listed_on_public_hub, l.max_uses, l.uses_count, l.expires_at,
         l.last_rotated_at, l.created_at, l.updated_at
  INTO v_row
  FROM crove_sign.template_direct_link l
  WHERE l.org_id = v_org AND l.template_id = p_template_id AND l.revoked_at IS NULL
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'id', v_row.id,
    'enabled', v_row.enabled,
    'requireEmailOtp', v_row.require_email_otp,
    'listedOnPublicHub', v_row.listed_on_public_hub,
    'maxUses', v_row.max_uses,
    'usesCount', v_row.uses_count,
    'expiresAt', v_row.expires_at,
    'lastRotatedAt', v_row.last_rotated_at,
    'createdAt', v_row.created_at,
    'updatedAt', v_row.updated_at
  );
END $$;

REVOKE ALL ON FUNCTION crove_sign.template_direct_link_state(uuid)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.template_direct_link_state(uuid) TO crove_tenant;

CREATE OR REPLACE FUNCTION crove_sign.template_direct_link_set_v3(
  p_template_id uuid,
  p_enabled boolean,
  p_require_email_otp boolean DEFAULT false,
  p_token_sha256 text DEFAULT NULL,
  p_max_uses integer DEFAULT NULL,
  p_expires_at timestamptz DEFAULT NULL,
  p_update_limits boolean DEFAULT false,
  p_listed_on_public_hub boolean DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_actor text := crove_kernel.ctx_actor_type();
  v_user uuid := crove_kernel.ctx_user_id();
  v_now timestamptz := pg_catalog.now();
  v_tpl record;
  v_non_cc_count integer;
  v_existing record;
  v_creator uuid;
  v_link_id uuid;
  v_revoked_count integer := 0;
  v_next_max_uses integer;
  v_next_expires_at timestamptz;
  v_next_hub boolean;
BEGIN
  IF v_org IS NULL OR v_actor IS NULL OR p_template_id IS NULL OR p_enabled IS NULL THEN
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
      WHERE m.org_id = v_org AND m.user_id = v_user AND m.role IN ('owner', 'admin', 'member')
    ) THEN
      RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF p_max_uses IS NOT NULL AND (p_max_uses < 1 OR p_max_uses > 100000) THEN
    RAISE EXCEPTION 'SIGN_INVALID_MAX_USES' USING ERRCODE = '22023';
  END IF;
  IF p_expires_at IS NOT NULL AND p_expires_at <= v_now THEN
    RAISE EXCEPTION 'SIGN_INVALID_EXPIRY' USING ERRCODE = '22023';
  END IF;

  SELECT t.id, t.status, t.inspect_status, t.page_count, t.created_by
  INTO v_tpl
  FROM crove_sign.template t
  WHERE t.org_id = v_org AND t.id = p_template_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SIGN_TEMPLATE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  v_creator := COALESCE(v_user, v_tpl.created_by);

  IF NOT p_enabled THEN
    WITH revoked AS (
      UPDATE crove_sign.template_direct_link
      SET enabled = false,
          listed_on_public_hub = false,
          revoked_at = v_now,
          revoked_by = v_user,
          updated_at = v_now
      WHERE org_id = v_org AND template_id = p_template_id AND revoked_at IS NULL
      RETURNING id
    )
    SELECT pg_catalog.count(*)::integer INTO v_revoked_count FROM revoked;

    UPDATE crove_sign.signing_otp o
    SET invalidated_at = v_now
    WHERE o.org_id = v_org
      AND o.direct_link_id IN (
        SELECT l.id FROM crove_sign.template_direct_link l
        WHERE l.org_id = v_org AND l.template_id = p_template_id
      )
      AND o.invalidated_at IS NULL;

    RETURN pg_catalog.jsonb_build_object(
      'id', NULL,
      'enabled', false,
      'requireEmailOtp', COALESCE(p_require_email_otp, false),
      'listedOnPublicHub', false,
      'maxUses', NULL,
      'usesCount', 0,
      'expiresAt', NULL,
      'minted', false,
      'revokedCount', v_revoked_count,
      'lastRotatedAt', NULL
    );
  END IF;

  IF v_tpl.status <> 'active' THEN
    RAISE EXCEPTION 'SIGN_TEMPLATE_NOT_ACTIVE' USING ERRCODE = '42501';
  END IF;
  IF v_tpl.inspect_status <> 'passed' OR v_tpl.page_count IS NULL THEN
    RAISE EXCEPTION 'SIGN_TEMPLATE_NOT_INSPECTED' USING ERRCODE = '42501';
  END IF;

  SELECT pg_catalog.count(*)::integer
  INTO v_non_cc_count
  FROM crove_sign.template_role r
  WHERE r.org_id = v_org AND r.template_id = p_template_id AND r.signer_role <> 'cc';

  IF v_non_cc_count <> 1 THEN
    RAISE EXCEPTION 'SIGN_DIRECT_LINK_SINGLE_ROLE_REQUIRED' USING ERRCODE = '22023';
  END IF;

  SELECT l.id, l.enabled, l.require_email_otp, l.listed_on_public_hub, l.max_uses, l.uses_count, l.expires_at, l.last_rotated_at
  INTO v_existing
  FROM crove_sign.template_direct_link l
  WHERE l.org_id = v_org AND l.template_id = p_template_id AND l.revoked_at IS NULL
  FOR UPDATE;

  IF FOUND AND v_existing.enabled AND p_token_sha256 IS NULL THEN
    v_next_max_uses := CASE WHEN COALESCE(p_update_limits, false) THEN p_max_uses ELSE v_existing.max_uses END;
    v_next_expires_at := CASE WHEN COALESCE(p_update_limits, false) THEN p_expires_at ELSE v_existing.expires_at END;
    v_next_hub := COALESCE(p_listed_on_public_hub, v_existing.listed_on_public_hub, false);
    IF v_next_max_uses IS NOT NULL AND v_next_max_uses < v_existing.uses_count THEN
      RAISE EXCEPTION 'SIGN_DIRECT_LINK_MAX_USES_EXCEEDED' USING ERRCODE = '22023';
    END IF;

    UPDATE crove_sign.template_direct_link
    SET require_email_otp = COALESCE(p_require_email_otp, false),
        listed_on_public_hub = v_next_hub,
        max_uses = v_next_max_uses,
        expires_at = v_next_expires_at,
        updated_at = v_now
    WHERE org_id = v_org AND id = v_existing.id;

    RETURN pg_catalog.jsonb_build_object(
      'id', v_existing.id,
      'enabled', true,
      'requireEmailOtp', COALESCE(p_require_email_otp, false),
      'listedOnPublicHub', v_next_hub,
      'maxUses', v_next_max_uses,
      'usesCount', v_existing.uses_count,
      'expiresAt', v_next_expires_at,
      'minted', false,
      'revokedCount', 0,
      'lastRotatedAt', v_existing.last_rotated_at
    );
  END IF;

  IF p_token_sha256 IS NULL OR p_token_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'SIGN_INVALID_TOKEN_HASH' USING ERRCODE = '22023';
  END IF;

  IF FOUND THEN
    UPDATE crove_sign.template_direct_link
    SET enabled = false,
        listed_on_public_hub = false,
        revoked_at = v_now,
        revoked_by = v_user,
        updated_at = v_now
    WHERE org_id = v_org AND template_id = p_template_id AND revoked_at IS NULL;
    v_revoked_count := 1;
  END IF;

  v_next_hub := COALESCE(p_listed_on_public_hub, false);

  INSERT INTO crove_sign.template_direct_link (
    org_id, template_id, token_sha256, enabled, require_email_otp, listed_on_public_hub,
    max_uses, uses_count, expires_at, created_by, created_at, updated_at
  ) VALUES (
    v_org, p_template_id, p_token_sha256, true, COALESCE(p_require_email_otp, false), v_next_hub,
    p_max_uses, 0, p_expires_at, v_creator, v_now, v_now
  )
  RETURNING id INTO v_link_id;

  RETURN pg_catalog.jsonb_build_object(
    'id', v_link_id,
    'enabled', true,
    'requireEmailOtp', COALESCE(p_require_email_otp, false),
    'listedOnPublicHub', v_next_hub,
    'maxUses', p_max_uses,
    'usesCount', 0,
    'expiresAt', p_expires_at,
    'minted', true,
    'revokedCount', v_revoked_count,
    'lastRotatedAt', NULL
  );
END $$;

REVOKE ALL ON FUNCTION crove_sign.template_direct_link_set_v3(uuid, boolean, boolean, text, integer, timestamptz, boolean, boolean)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.template_direct_link_set_v3(uuid, boolean, boolean, text, integer, timestamptz, boolean, boolean) TO crove_tenant;

CREATE OR REPLACE FUNCTION crove_sign.template_direct_link_set_v2(
  p_template_id uuid,
  p_enabled boolean,
  p_require_email_otp boolean DEFAULT false,
  p_token_sha256 text DEFAULT NULL,
  p_max_uses integer DEFAULT NULL,
  p_expires_at timestamptz DEFAULT NULL,
  p_update_limits boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RETURN crove_sign.template_direct_link_set_v3(
    p_template_id, p_enabled, p_require_email_otp, p_token_sha256,
    p_max_uses, p_expires_at, p_update_limits, NULL
  );
END $$;

REVOKE ALL ON FUNCTION crove_sign.template_direct_link_set_v2(uuid, boolean, boolean, text, integer, timestamptz, boolean)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.template_direct_link_set_v2(uuid, boolean, boolean, text, integer, timestamptz, boolean) TO crove_tenant;

CREATE OR REPLACE FUNCTION crove_sign.template_direct_link_rotate_v3(
  p_template_id uuid,
  p_token_sha256 text,
  p_require_email_otp boolean DEFAULT NULL,
  p_max_uses integer DEFAULT NULL,
  p_expires_at timestamptz DEFAULT NULL,
  p_update_limits boolean DEFAULT false,
  p_listed_on_public_hub boolean DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_actor text := crove_kernel.ctx_actor_type();
  v_user uuid := crove_kernel.ctx_user_id();
  v_now timestamptz := pg_catalog.now();
  v_tpl record;
  v_non_cc_count integer;
  v_prev record;
  v_revoked_count integer := 0;
  v_creator uuid;
  v_link_id uuid;
  v_effective_otp boolean;
  v_effective_hub boolean;
  v_effective_max_uses integer;
  v_effective_expires_at timestamptz;
BEGIN
  IF v_org IS NULL OR v_actor IS NULL OR p_template_id IS NULL THEN
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
      WHERE m.org_id = v_org AND m.user_id = v_user AND m.role IN ('owner', 'admin', 'member')
    ) THEN
      RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF p_token_sha256 IS NULL OR p_token_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'SIGN_INVALID_TOKEN_HASH' USING ERRCODE = '22023';
  END IF;
  IF p_max_uses IS NOT NULL AND (p_max_uses < 1 OR p_max_uses > 100000) THEN
    RAISE EXCEPTION 'SIGN_INVALID_MAX_USES' USING ERRCODE = '22023';
  END IF;
  IF p_expires_at IS NOT NULL AND p_expires_at <= v_now THEN
    RAISE EXCEPTION 'SIGN_INVALID_EXPIRY' USING ERRCODE = '22023';
  END IF;

  SELECT t.id, t.status, t.inspect_status, t.page_count, t.created_by
  INTO v_tpl
  FROM crove_sign.template t
  WHERE t.org_id = v_org AND t.id = p_template_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SIGN_TEMPLATE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_tpl.status <> 'active' THEN
    RAISE EXCEPTION 'SIGN_TEMPLATE_NOT_ACTIVE' USING ERRCODE = '42501';
  END IF;
  IF v_tpl.inspect_status <> 'passed' OR v_tpl.page_count IS NULL THEN
    RAISE EXCEPTION 'SIGN_TEMPLATE_NOT_INSPECTED' USING ERRCODE = '42501';
  END IF;

  SELECT pg_catalog.count(*)::integer
  INTO v_non_cc_count
  FROM crove_sign.template_role r
  WHERE r.org_id = v_org AND r.template_id = p_template_id AND r.signer_role <> 'cc';

  IF v_non_cc_count <> 1 THEN
    RAISE EXCEPTION 'SIGN_DIRECT_LINK_SINGLE_ROLE_REQUIRED' USING ERRCODE = '22023';
  END IF;

  SELECT l.id, l.require_email_otp, l.listed_on_public_hub, l.max_uses, l.expires_at
  INTO v_prev
  FROM crove_sign.template_direct_link l
  WHERE l.org_id = v_org AND l.template_id = p_template_id AND l.revoked_at IS NULL
  FOR UPDATE;

  IF FOUND THEN
    UPDATE crove_sign.template_direct_link
    SET enabled = false,
        listed_on_public_hub = false,
        revoked_at = v_now,
        revoked_by = v_user,
        updated_at = v_now
    WHERE org_id = v_org AND template_id = p_template_id AND revoked_at IS NULL;
    v_revoked_count := 1;

    UPDATE crove_sign.signing_otp o
    SET invalidated_at = v_now
    WHERE o.org_id = v_org
      AND o.direct_link_id = v_prev.id
      AND o.invalidated_at IS NULL;

    v_effective_otp := COALESCE(p_require_email_otp, v_prev.require_email_otp, false);
    v_effective_hub := COALESCE(p_listed_on_public_hub, v_prev.listed_on_public_hub, false);
    v_effective_max_uses := CASE WHEN COALESCE(p_update_limits, false) THEN p_max_uses ELSE v_prev.max_uses END;
    v_effective_expires_at := CASE WHEN COALESCE(p_update_limits, false) THEN p_expires_at ELSE v_prev.expires_at END;
  ELSE
    v_effective_otp := COALESCE(p_require_email_otp, false);
    v_effective_hub := COALESCE(p_listed_on_public_hub, false);
    v_effective_max_uses := p_max_uses;
    v_effective_expires_at := p_expires_at;
  END IF;

  v_creator := COALESCE(v_user, v_tpl.created_by);

  INSERT INTO crove_sign.template_direct_link (
    org_id, template_id, token_sha256, enabled, require_email_otp, listed_on_public_hub,
    max_uses, uses_count, expires_at, last_rotated_at, created_by, created_at, updated_at
  ) VALUES (
    v_org, p_template_id, p_token_sha256, true, v_effective_otp, v_effective_hub,
    v_effective_max_uses, 0, v_effective_expires_at, v_now, v_creator, v_now, v_now
  )
  RETURNING id INTO v_link_id;

  RETURN pg_catalog.jsonb_build_object(
    'id', v_link_id,
    'enabled', true,
    'requireEmailOtp', v_effective_otp,
    'listedOnPublicHub', v_effective_hub,
    'maxUses', v_effective_max_uses,
    'usesCount', 0,
    'expiresAt', v_effective_expires_at,
    'minted', true,
    'revokedCount', v_revoked_count,
    'lastRotatedAt', v_now
  );
END $$;

REVOKE ALL ON FUNCTION crove_sign.template_direct_link_rotate_v3(uuid, text, boolean, integer, timestamptz, boolean, boolean)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.template_direct_link_rotate_v3(uuid, text, boolean, integer, timestamptz, boolean, boolean) TO crove_tenant;

CREATE OR REPLACE FUNCTION crove_sign.template_direct_link_rotate_v2(
  p_template_id uuid,
  p_token_sha256 text,
  p_require_email_otp boolean DEFAULT NULL,
  p_max_uses integer DEFAULT NULL,
  p_expires_at timestamptz DEFAULT NULL,
  p_update_limits boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RETURN crove_sign.template_direct_link_rotate_v3(
    p_template_id, p_token_sha256, p_require_email_otp,
    p_max_uses, p_expires_at, p_update_limits, NULL
  );
END $$;

REVOKE ALL ON FUNCTION crove_sign.template_direct_link_rotate_v2(uuid, text, boolean, integer, timestamptz, boolean)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.template_direct_link_rotate_v2(uuid, text, boolean, integer, timestamptz, boolean) TO crove_tenant;

-- ---------------------------------------------------------------------------
-- 3. Orgless public template hub resolvers & ceremony wrappers (crove_app only)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION crove_sign.public_hub_list(
  p_org_slug text
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_slug text := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_org_slug, '')));
  v_now timestamptz := pg_catalog.now();
  v_tenant record;
  v_items jsonb := '[]'::jsonb;
BEGIN
  IF v_slug !~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$' THEN
    RETURN NULL;
  END IF;

  SELECT t.org_id, t.slug, t.name, t.status
  INTO v_tenant
  FROM crove_kernel.tenant t
  WHERE t.slug = v_slug;

  IF NOT FOUND
     OR v_tenant.status IS DISTINCT FROM 'active'
     OR NOT crove_kernel.org_app_on(v_tenant.org_id, 'sign') THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'templateId', q.template_id,
        'title', q.title,
        'description', q.description,
        'roleLabel', q.role_label,
        'signerRole', CASE WHEN q.signer_role = 'approver' THEN 'approver' ELSE 'signer' END,
        'requireEmailOtp', q.effective_otp,
        'pageCount', q.page_count
      )
      ORDER BY q.title ASC, q.template_id ASC
    ),
    '[]'::jsonb
  )
  INTO v_items
  FROM (
    SELECT
      tpl.id AS template_id,
      tpl.title,
      tpl.description,
      tpl.page_count,
      r.role_label,
      r.signer_role,
      (COALESCE(l.require_email_otp, false) OR COALESCE(r.require_email_otp, false)) AS effective_otp
    FROM crove_sign.template_direct_link l
    JOIN crove_sign.template tpl
      ON tpl.org_id = l.org_id
     AND tpl.id = l.template_id
    JOIN LATERAL (
      SELECT
        pg_catalog.count(*)::integer AS non_cc_count,
        (pg_catalog.array_agg(tr.id ORDER BY tr.routing_order ASC, tr.created_at ASC, tr.id ASC))[1] AS role_id,
        (pg_catalog.array_agg(tr.role_label ORDER BY tr.routing_order ASC, tr.created_at ASC, tr.id ASC))[1] AS role_label,
        (pg_catalog.array_agg(tr.signer_role ORDER BY tr.routing_order ASC, tr.created_at ASC, tr.id ASC))[1] AS signer_role,
        pg_catalog.bool_or(tr.require_email_otp) AS require_email_otp
      FROM crove_sign.template_role tr
      WHERE tr.org_id = l.org_id
        AND tr.template_id = l.template_id
        AND tr.signer_role <> 'cc'
    ) r ON r.non_cc_count = 1
    WHERE l.org_id = v_tenant.org_id
      AND l.enabled = true
      AND l.listed_on_public_hub = true
      AND l.revoked_at IS NULL
      AND (l.expires_at IS NULL OR l.expires_at > v_now)
      AND (l.max_uses IS NULL OR l.uses_count < l.max_uses)
      AND tpl.status = 'active'
      AND tpl.inspect_status = 'passed'
      AND tpl.page_count IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM crove_sign.template_field f_oob
        WHERE f_oob.org_id = l.org_id
          AND f_oob.template_id = tpl.id
          AND f_oob.template_role_id = r.role_id
          AND f_oob.page_number > tpl.page_count
      )
      AND (
        r.signer_role = 'approver'
        OR EXISTS (
          SELECT 1
          FROM crove_sign.template_field f_sig
          WHERE f_sig.org_id = l.org_id
            AND f_sig.template_id = tpl.id
            AND f_sig.template_role_id = r.role_id
            AND f_sig.field_type = 'signature'
        )
      )
    ORDER BY tpl.title ASC, tpl.id ASC
    LIMIT 100
  ) q;

  -- Return NULL when zero templates opted into the hub so callers cannot probe org existence.
  IF pg_catalog.jsonb_array_length(v_items) = 0 THEN
    RETURN NULL;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'orgId', v_tenant.org_id,
    'orgSlug', v_tenant.slug,
    'orgName', v_tenant.name,
    'items', v_items
  );
END $$;

REVOKE ALL ON FUNCTION crove_sign.public_hub_list(text)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.public_hub_list(text) TO crove_app;

CREATE OR REPLACE FUNCTION crove_sign.public_hub_resolve(
  p_org_slug text,
  p_template_id uuid,
  p_claim_sha256 text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_slug text := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_org_slug, '')));
  v_tenant record;
  v_token_sha256 text;
BEGIN
  IF p_template_id IS NULL OR v_slug !~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$' THEN
    RETURN NULL;
  END IF;

  SELECT t.org_id, t.status
  INTO v_tenant
  FROM crove_kernel.tenant t
  WHERE t.slug = v_slug;

  IF NOT FOUND
     OR v_tenant.status IS DISTINCT FROM 'active'
     OR NOT crove_kernel.org_app_on(v_tenant.org_id, 'sign') THEN
    RETURN NULL;
  END IF;

  SELECT l.token_sha256
  INTO v_token_sha256
  FROM crove_sign.template_direct_link l
  WHERE l.org_id = v_tenant.org_id
    AND l.template_id = p_template_id
    AND l.enabled = true
    AND l.listed_on_public_hub = true
    AND l.revoked_at IS NULL
  LIMIT 1;

  IF NOT FOUND OR v_token_sha256 IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN crove_sign.public_direct_resolve(v_token_sha256, p_claim_sha256);
END $$;

REVOKE ALL ON FUNCTION crove_sign.public_hub_resolve(text, uuid, text)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.public_hub_resolve(text, uuid, text) TO crove_app;

CREATE OR REPLACE FUNCTION crove_sign.public_hub_pdf_source(
  p_org_slug text,
  p_template_id uuid,
  p_claim_sha256 text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_slug text := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_org_slug, '')));
  v_tenant record;
  v_token_sha256 text;
BEGIN
  IF p_template_id IS NULL OR v_slug !~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$' THEN
    RETURN NULL;
  END IF;

  SELECT t.org_id, t.status
  INTO v_tenant
  FROM crove_kernel.tenant t
  WHERE t.slug = v_slug;

  IF NOT FOUND
     OR v_tenant.status IS DISTINCT FROM 'active'
     OR NOT crove_kernel.org_app_on(v_tenant.org_id, 'sign') THEN
    RETURN NULL;
  END IF;

  SELECT l.token_sha256
  INTO v_token_sha256
  FROM crove_sign.template_direct_link l
  WHERE l.org_id = v_tenant.org_id
    AND l.template_id = p_template_id
    AND l.enabled = true
    AND l.listed_on_public_hub = true
    AND l.revoked_at IS NULL
  LIMIT 1;

  IF NOT FOUND OR v_token_sha256 IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN crove_sign.public_direct_pdf_source(v_token_sha256, p_claim_sha256);
END $$;

REVOKE ALL ON FUNCTION crove_sign.public_hub_pdf_source(text, uuid, text)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.public_hub_pdf_source(text, uuid, text) TO crove_app;

CREATE OR REPLACE FUNCTION crove_sign.public_hub_request_otp(
  p_org_slug text,
  p_template_id uuid,
  p_email text,
  p_message_id_domain text DEFAULT 'crove.invalid'
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_slug text := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_org_slug, '')));
  v_tenant record;
  v_token_sha256 text;
BEGIN
  IF p_template_id IS NULL OR v_slug !~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$' THEN
    RETURN NULL;
  END IF;

  SELECT t.org_id, t.status
  INTO v_tenant
  FROM crove_kernel.tenant t
  WHERE t.slug = v_slug;

  IF NOT FOUND
     OR v_tenant.status IS DISTINCT FROM 'active'
     OR NOT crove_kernel.org_app_on(v_tenant.org_id, 'sign') THEN
    RETURN NULL;
  END IF;

  -- Canonical lock order: template -> template_direct_link -> signing_otp.
  PERFORM 1
  FROM crove_sign.template tpl
  WHERE tpl.org_id = v_tenant.org_id
    AND tpl.id = p_template_id
  FOR SHARE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT l.token_sha256
  INTO v_token_sha256
  FROM crove_sign.template_direct_link l
  WHERE l.org_id = v_tenant.org_id
    AND l.template_id = p_template_id
    AND l.enabled = true
    AND l.listed_on_public_hub = true
    AND l.revoked_at IS NULL
  FOR UPDATE;

  IF NOT FOUND OR v_token_sha256 IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN crove_sign.public_direct_request_otp(v_token_sha256, p_email, p_message_id_domain);
END $$;

REVOKE ALL ON FUNCTION crove_sign.public_hub_request_otp(text, uuid, text, text)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.public_hub_request_otp(text, uuid, text, text) TO crove_app;

CREATE OR REPLACE FUNCTION crove_sign.public_hub_verify_otp(
  p_org_slug text,
  p_template_id uuid,
  p_email text,
  p_code text,
  p_claim_sha256 text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_slug text := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_org_slug, '')));
  v_tenant record;
  v_token_sha256 text;
BEGIN
  IF p_template_id IS NULL OR v_slug !~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$' THEN
    RETURN NULL;
  END IF;

  SELECT t.org_id, t.status
  INTO v_tenant
  FROM crove_kernel.tenant t
  WHERE t.slug = v_slug;

  IF NOT FOUND
     OR v_tenant.status IS DISTINCT FROM 'active'
     OR NOT crove_kernel.org_app_on(v_tenant.org_id, 'sign') THEN
    RETURN NULL;
  END IF;

  -- Canonical lock order: template -> template_direct_link -> signing_otp.
  PERFORM 1
  FROM crove_sign.template tpl
  WHERE tpl.org_id = v_tenant.org_id
    AND tpl.id = p_template_id
  FOR SHARE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT l.token_sha256
  INTO v_token_sha256
  FROM crove_sign.template_direct_link l
  WHERE l.org_id = v_tenant.org_id
    AND l.template_id = p_template_id
    AND l.enabled = true
    AND l.listed_on_public_hub = true
    AND l.revoked_at IS NULL
  FOR UPDATE;

  IF NOT FOUND OR v_token_sha256 IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN crove_sign.public_direct_verify_otp(v_token_sha256, p_email, p_code, p_claim_sha256);
END $$;

REVOKE ALL ON FUNCTION crove_sign.public_hub_verify_otp(text, uuid, text, text, text)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.public_hub_verify_otp(text, uuid, text, text, text) TO crove_app;

CREATE OR REPLACE FUNCTION crove_sign.public_hub_start(
  p_org_slug text,
  p_template_id uuid,
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
  v_slug text := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_org_slug, '')));
  v_tenant record;
  v_token_sha256 text;
BEGIN
  IF p_template_id IS NULL OR v_slug !~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$' THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  SELECT t.org_id, t.status
  INTO v_tenant
  FROM crove_kernel.tenant t
  WHERE t.slug = v_slug;

  IF NOT FOUND
     OR v_tenant.status IS DISTINCT FROM 'active'
     OR NOT crove_kernel.org_app_on(v_tenant.org_id, 'sign') THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  -- Canonical lock order: template -> template_direct_link -> signing_otp.
  PERFORM 1
  FROM crove_sign.template tpl
  WHERE tpl.org_id = v_tenant.org_id
    AND tpl.id = p_template_id
  FOR SHARE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  SELECT l.token_sha256
  INTO v_token_sha256
  FROM crove_sign.template_direct_link l
  WHERE l.org_id = v_tenant.org_id
    AND l.template_id = p_template_id
    AND l.enabled = true
    AND l.listed_on_public_hub = true
    AND l.revoked_at IS NULL
  FOR UPDATE;

  IF NOT FOUND OR v_token_sha256 IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  RETURN crove_sign.public_direct_start(
    v_token_sha256,
    p_name,
    p_email,
    p_claim_sha256,
    p_signing_token_sha256,
    p_ip_hash,
    p_user_agent
  );
END $$;

REVOKE ALL ON FUNCTION crove_sign.public_hub_start(text, uuid, text, text, text, text, text, text)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.public_hub_start(text, uuid, text, text, text, text, text, text) TO crove_app;
