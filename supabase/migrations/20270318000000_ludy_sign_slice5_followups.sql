-- SPDX-License-Identifier: AGPL-3.0-only
-- Consolidated non-blocking review follow-ups for eSign Slice 5 (#4510, PRs #4456, #4466, #4464, #4467, #4469):
--   1. Webhooks (#4466):
--      - Add org-wide recent delivery index (org_id, created_at DESC, id DESC) on ludy_sign.webhook_delivery.
--      - Dynamic REVOKE loop across both ludy_% and crove_% roles over all ludy_sign.webhook* routines,
--        re-granting ONLY the narrow ludy_app and ludy_worker surfaces.
--      - Extract ludy_sign.webhook_url_ok helper for webhook_create/webhook_update URL validation clarity,
--        enforce org_app_on('sign') on 'send' sweep rows in webhook_open (while preserving >8h expiry),
--        and scrub payload_json in webhook_delivery_get for confidential source kinds as defense-in-depth.
--   2. KYC (#4467):
--      - Add partial index ludy_sign.kyc_check (checked_by) WHERE checked_by IS NOT NULL.
--      - Add worker-only recovery/timeout candidate reader ludy_sign.kyc_work_recovery_candidates(...).
--      - Add ludy_sign.personal_data_erase_kyc_check_summary(text, text) returning both erased KYC row and
--        distinct attachment counts, detach matching unsealed attachment fields safely via field_guard, and
--        preserve ludy_sign.personal_data_erase_kyc_check(text, text) compatibility wrapper.
--   3. API keys & MCP (#4469):
--      - Enforce case-insensitive unique active API key labels per org (api_key_org_active_name_uidx + api_key_insert 23505).
--      - Align ludy_sign.api_key_create_draft_from_template to require active inspected templates and preserve full
--        template inspection metadata safely.
--      - Add trigger-maintained, indexed next_pending_due_date date on ludy_sign.envelope_obligation for
--        bounded-scan MCP renewal priority across >200 confirmed contracts.

SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. Webhooks (#4466): org-wide delivery index, URL helper, sweep/retry parity, dynamic revokes
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS webhook_delivery_org_recent_idx
  ON ludy_sign.webhook_delivery (org_id, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION ludy_sign.webhook_url_ok(p_url text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT p_url IS NOT NULL
    AND pg_catalog.char_length(p_url) BETWEEN 12 AND 2048
    AND p_url ~ '^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:443)?(/[^[:space:]#]*)?$'
    AND p_url !~ '^https://[0-9.]+(:|/|$)';
$$;

CREATE OR REPLACE FUNCTION ludy_sign.webhook_create(
  p_id uuid,
  p_url text,
  p_events text[],
  p_enabled boolean,
  p_key_id text,
  p_secret_envelope text,
  p_secret_hint text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_user uuid;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_events text[];
  v_count integer;
  v_row ludy_sign.webhook;
BEGIN
  v_user := ludy_sign.webhook_admin_caller();

  IF NOT ludy_sign.webhook_url_ok(p_url)
     OR p_events IS NULL
     OR pg_catalog.cardinality(p_events) < 1
     OR NOT (p_events <@ ARRAY[
       'sign.envelope.sent',
       'sign.signer.signed',
       'sign.envelope.completed',
       'sign.envelope.declined',
       'sign.envelope.expired'
     ]::text[])
     OR p_enabled IS NULL
     OR p_key_id IS NULL OR pg_catalog.length(p_key_id) NOT BETWEEN 1 AND 128
     OR p_secret_envelope IS NULL OR pg_catalog.length(p_secret_envelope) NOT BETWEEN 16 AND 16384
     OR p_secret_hint IS NULL OR p_secret_hint !~ '^whk_[0-9a-f]{8}$' THEN
    RAISE EXCEPTION 'SIGN_WEBHOOK_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT ARRAY(SELECT DISTINCT e FROM pg_catalog.unnest(p_events) AS e ORDER BY e)
  INTO v_events;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('sign.webhook.create:' || v_org::text, 0));

  SELECT pg_catalog.count(*)::int
  INTO v_count
  FROM ludy_sign.webhook w
  WHERE w.org_id = v_org;

  IF v_count >= 20 THEN
    RAISE EXCEPTION 'SIGN_WEBHOOKS_MAX' USING ERRCODE = '22023';
  END IF;

  INSERT INTO ludy_sign.webhook (
    org_id, id, url, events, enabled, key_id, secret_envelope, secret_hint, created_by, created_at, updated_at
  )
  VALUES (
    v_org,
    COALESCE(p_id, ludy_kernel.uuid_v7()),
    p_url,
    v_events,
    p_enabled,
    p_key_id,
    p_secret_envelope,
    p_secret_hint,
    v_user,
    v_now,
    v_now
  )
  RETURNING * INTO v_row;

  RETURN ludy_sign.webhook_row_json(v_row);
END $$;

CREATE OR REPLACE FUNCTION ludy_sign.webhook_update(
  p_webhook_id uuid,
  p_url text,
  p_events text[],
  p_enabled boolean
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_events text[];
  v_old ludy_sign.webhook;
  v_row ludy_sign.webhook;
  v_url_changed boolean;
  v_reenabled boolean;
BEGIN
  PERFORM ludy_sign.webhook_admin_caller();

  IF p_webhook_id IS NULL
     OR NOT ludy_sign.webhook_url_ok(p_url)
     OR p_events IS NULL
     OR pg_catalog.cardinality(p_events) < 1
     OR NOT (p_events <@ ARRAY[
       'sign.envelope.sent',
       'sign.signer.signed',
       'sign.envelope.completed',
       'sign.envelope.declined',
       'sign.envelope.expired'
     ]::text[])
     OR p_enabled IS NULL THEN
    RAISE EXCEPTION 'SIGN_WEBHOOK_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT ARRAY(SELECT DISTINCT e FROM pg_catalog.unnest(p_events) AS e ORDER BY e)
  INTO v_events;

  SELECT w.*
  INTO v_old
  FROM ludy_sign.webhook w
  WHERE w.org_id = v_org AND w.id = p_webhook_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SIGN_WEBHOOK_NOT_FOUND' USING ERRCODE = '22023';
  END IF;

  v_url_changed := v_old.url IS DISTINCT FROM p_url;
  v_reenabled := p_enabled AND NOT v_old.enabled;

  -- Changing the destination URL or disabling the endpoint drops queued deliveries queued for the prior target/state.
  IF v_url_changed OR NOT p_enabled THEN
    PERFORM ludy_sign.webhook_drop_queued(v_org, v_old.id);
  ELSIF NOT (v_old.events <@ v_events) THEN
    UPDATE ludy_sign.webhook_delivery d
    SET status = 'dropped',
        payload_json = NULL
    WHERE d.org_id = v_org
      AND d.webhook_id = v_old.id
      AND d.status = 'queued'
      AND d.event_type <> 'ping'
      AND NOT (d.event_type = ANY(v_events));
  END IF;

  UPDATE ludy_sign.webhook w
  SET url = p_url,
      events = v_events,
      enabled = p_enabled,
      paused_reason = CASE WHEN p_enabled THEN NULL ELSE w.paused_reason END,
      failing_since = CASE WHEN v_reenabled OR v_url_changed THEN NULL ELSE w.failing_since END,
      consecutive_failures = CASE WHEN v_reenabled OR v_url_changed THEN 0 ELSE w.consecutive_failures END,
      updated_at = v_now
  WHERE w.org_id = v_org AND w.id = v_old.id
  RETURNING * INTO v_row;

  RETURN ludy_sign.webhook_row_json(v_row);
END $$;

CREATE OR REPLACE FUNCTION ludy_sign.webhook_open(p_limit integer)
RETURNS TABLE (org_id uuid, id uuid, kind text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT d.org_id, d.id,
         CASE WHEN d.created_at <= pg_catalog.clock_timestamp() - interval '8 hours' THEN 'expire' ELSE 'send' END
  FROM ludy_sign.webhook_delivery d
  LEFT JOIN ludy_sign.envelope e
    ON e.org_id = d.org_id AND e.id = d.envelope_id
  WHERE d.status = 'queued'
    AND (
      d.created_at <= pg_catalog.clock_timestamp() - interval '8 hours'
      OR (
        ludy_kernel.org_app_on(d.org_id, 'sign')
        AND (
          d.handed_at IS NULL
          OR (d.attempts = 0 AND d.handed_at <= pg_catalog.clock_timestamp() - interval '3 minutes')
        )
      )
    )
    AND (
      d.created_at <= pg_catalog.clock_timestamp() - interval '8 hours'
      OR e.id IS NULL
      OR e.source_kind NOT IN ('hr_contract', 'meeting_minutes')
    )
  ORDER BY d.created_at, d.id
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 200), 500))
$$;

CREATE OR REPLACE FUNCTION ludy_sign.webhook_delivery_get(p_org_id uuid, p_id uuid)
RETURNS TABLE (
  id uuid,
  webhook_id uuid,
  envelope_id uuid,
  envelope_source_kind text,
  event_type text,
  payload_json jsonb,
  status text,
  attempts integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := ludy_sign.webhook_system_org();
BEGIN
  RETURN QUERY
  SELECT
    d.id,
    d.webhook_id,
    d.envelope_id,
    e.source_kind,
    d.event_type,
    -- Never cross the worker read boundary with payload data for confidential envelopes (even on retries).
    CASE
      WHEN e.source_kind IN ('hr_contract', 'meeting_minutes') THEN NULL::jsonb
      ELSE d.payload_json
    END,
    d.status,
    d.attempts
  FROM ludy_sign.webhook_delivery d
  LEFT JOIN ludy_sign.envelope e ON e.org_id = d.org_id AND e.id = d.envelope_id
  WHERE d.org_id = p_org_id
    AND d.id = p_id
    AND p_org_id = v_org;
END $$;

REVOKE ALL ON FUNCTION
  ludy_sign.webhook_url_ok(text),
  ludy_sign.webhook_create(uuid, text, text[], boolean, text, text, text),
  ludy_sign.webhook_update(uuid, text, text[], boolean),
  ludy_sign.webhook_open(integer),
  ludy_sign.webhook_delivery_get(uuid, uuid)
FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;

DO $$
DECLARE
  v_fn record;
  v_role record;
BEGIN
  FOR v_fn IN
    SELECT p.oid::pg_catalog.regprocedure AS sig
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'ludy_sign'
      AND p.proname LIKE 'webhook\_%'
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON FUNCTION %s FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant',
      v_fn.sig
    );
    FOR v_role IN
      SELECT rolname
      FROM pg_catalog.pg_roles
      WHERE (rolname LIKE 'ludy\_%' OR rolname LIKE 'crove\_%')
        AND rolname <> current_user
    LOOP
      EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM %I', v_fn.sig, v_role.rolname);
    END LOOP;
  END LOOP;
END $$;

GRANT EXECUTE ON FUNCTION
  ludy_sign.webhook_list(),
  ludy_sign.webhook_deliveries_list(uuid, integer),
  ludy_sign.webhook_create(uuid, text, text[], boolean, text, text, text),
  ludy_sign.webhook_update(uuid, text, text[], boolean),
  ludy_sign.webhook_rotate_secret(uuid, text, text, text),
  ludy_sign.webhook_delete(uuid),
  ludy_sign.webhook_ping(uuid),
  ludy_sign.webhook_enqueue_event(uuid, text, text, timestamptz, uuid, text, timestamptz, timestamptz, text, text)
TO ludy_app;

GRANT EXECUTE ON FUNCTION
  ludy_sign.webhook_enqueue_event(uuid, text, text, timestamptz, uuid, text, timestamptz, timestamptz, text, text),
  ludy_sign.webhook_open(integer),
  ludy_sign.webhook_delivery_get(uuid, uuid),
  ludy_sign.webhook_target(uuid),
  ludy_sign.webhook_touch(uuid),
  ludy_sign.webhook_record(uuid, text, integer)
TO ludy_worker;

-- ---------------------------------------------------------------------------
-- 2. KYC (#4467): partial checked_by index, worker recovery reader, PDPL summary + unsealed attachment cleanup
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS kyc_check_checked_by_idx
  ON ludy_sign.kyc_check (checked_by)
  WHERE checked_by IS NOT NULL;

CREATE OR REPLACE FUNCTION ludy_sign.kyc_work_recovery_candidates(
  p_older_than timestamptz,
  p_limit integer DEFAULT 100,
  p_org_id uuid DEFAULT NULL,
  p_after_updated_at timestamptz DEFAULT NULL,
  p_after_org_id uuid DEFAULT NULL,
  p_after_id uuid DEFAULT NULL
)
RETURNS TABLE (
  org_id uuid,
  id uuid,
  envelope_id uuid,
  field_id uuid,
  file_id uuid,
  file_sha256 text,
  created_at timestamptz,
  updated_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT
    k.org_id,
    k.id,
    k.envelope_id,
    k.field_id,
    k.file_id,
    k.file_sha256,
    k.created_at,
    k.updated_at
  FROM ludy_sign.kyc_check k
  WHERE k.status = 'pending'
    AND k.mode = 'deterministic'
    AND k.updated_at <= p_older_than
    AND (p_org_id IS NULL OR k.org_id = p_org_id)
    AND (
      p_after_updated_at IS NULL
      OR (k.updated_at, k.org_id, k.id) > (p_after_updated_at, p_after_org_id, p_after_id)
    )
  ORDER BY k.updated_at ASC, k.org_id ASC, k.id ASC
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 100), 500));
$$;

REVOKE ALL ON FUNCTION ludy_sign.kyc_work_recovery_candidates(timestamptz, integer, uuid, timestamptz, uuid, uuid)
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
      'REVOKE ALL ON FUNCTION ludy_sign.kyc_work_recovery_candidates(timestamptz, integer, uuid, timestamptz, uuid, uuid) FROM %I',
      r.rolname
    );
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION ludy_sign.kyc_work_recovery_candidates(timestamptz, integer, uuid, timestamptz, uuid, uuid) TO ludy_worker;

CREATE OR REPLACE FUNCTION ludy_sign.personal_data_erase_kyc_check_summary(p_kind text, p_value text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
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

  WITH gone AS (
    DELETE FROM ludy_sign.kyc_check k
     WHERE k.org_id = v_org
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
    -- Lock matching unsealed parent envelopes in canonical id order before updating field rows.
    PERFORM 1
      FROM ludy_sign.envelope e
     WHERE e.org_id = v_org
       AND e.id IN (
         SELECT f.envelope_id
           FROM ludy_sign.field f
          WHERE f.org_id = v_org
            AND f.id = ANY (v_field_ids)
            AND f.field_type = 'attachment'
            AND f.attachment_file_id = ANY (v_file_ids)
       )
       AND e.status IN ('draft', 'voided', 'expired', 'declined')
       AND e.sealed_file_id IS NULL
     ORDER BY e.id ASC
     FOR SHARE;

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

CREATE OR REPLACE FUNCTION ludy_sign.personal_data_erase_kyc_check(p_kind text, p_value text)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT (ludy_sign.personal_data_erase_kyc_check_summary(p_kind, p_value)->>'rows')::integer;
$$;

CREATE OR REPLACE FUNCTION ludy_sign.field_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_actor text := ludy_kernel.ctx_actor_type();
  v_env_id uuid := COALESCE(OLD.envelope_id, NEW.envelope_id);
  v_org uuid := COALESCE(OLD.org_id, NEW.org_id);
  v_env_status text;
  v_env_sealed_file_id uuid;
  v_erase_owner oid := (SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.oid = 'ludy_sign.personal_erase_unsealed_signers(text,text)'::pg_catalog.regprocedure);
  v_kyc_erase_owner oid := (SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.oid = 'ludy_sign.personal_data_erase_kyc_check_summary(text,text)'::pg_catalog.regprocedure);
  v_preserve_owner oid := (SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.oid = 'ludy_sign.preserve_draft_field_text_defaults(uuid,jsonb)'::pg_catalog.regprocedure);
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
  FROM ludy_sign.envelope e WHERE e.org_id = v_org AND e.id = v_env_id FOR SHARE;
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
  IF TG_OP = 'UPDATE'
     AND v_env_status IN ('draft', 'voided', 'expired', 'declined')
     AND v_env_sealed_file_id IS NULL
     AND v_kyc_erase_owner IS NOT NULL
     AND v_cur_role = v_kyc_erase_owner
     AND pg_catalog.current_setting('ludy.sign_kyc_erase', true) = OLD.org_id::text
     AND v_actor = 'user'
     AND ludy_kernel.ctx_agent_id() IS NULL
     AND ludy_kernel.ctx_org_id() = OLD.org_id
     AND EXISTS (
       SELECT 1 FROM ludy_kernel.tenant_member m
       WHERE m.org_id = OLD.org_id AND m.user_id = ludy_kernel.ctx_user_id() AND m.role = 'owner'
     )
     AND OLD.field_type = 'attachment'
     AND NEW.field_type = 'attachment'
     AND NEW.attachment_file_id IS NULL
     AND NEW.attachment_filename IS NULL
     AND NEW.attachment_content_type IS NULL
     AND NEW.attachment_size_bytes IS NULL
     AND NEW.attachment_sha256 IS NULL
     AND NEW.filled_at IS NULL
     AND (pg_catalog.to_jsonb(OLD) - ARRAY[
       'attachment_file_id', 'attachment_filename', 'attachment_content_type',
       'attachment_size_bytes', 'attachment_sha256', 'filled_at', 'updated_at'
     ]) IS NOT DISTINCT FROM (pg_catalog.to_jsonb(NEW) - ARRAY[
       'attachment_file_id', 'attachment_filename', 'attachment_content_type',
       'attachment_size_bytes', 'attachment_sha256', 'filled_at', 'updated_at'
     ]) THEN
    RETURN NEW;
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

REVOKE ALL ON FUNCTION
  ludy_sign.personal_data_erase_kyc_check_summary(text, text),
  ludy_sign.personal_data_erase_kyc_check(text, text),
  ludy_sign.field_guard()
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
      'REVOKE ALL ON FUNCTION ludy_sign.personal_data_erase_kyc_check_summary(text, text), ludy_sign.personal_data_erase_kyc_check(text, text), ludy_sign.field_guard() FROM %I',
      r.rolname
    );
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION
  ludy_sign.personal_data_erase_kyc_check_summary(text, text),
  ludy_sign.personal_data_erase_kyc_check(text, text)
TO ludy_app;

-- ---------------------------------------------------------------------------
-- 3. API keys & MCP (#4469): duplicate active name uniqueness, template inspect alignment, renewal priority index
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS api_key_org_active_name_uidx
  ON ludy_sign.api_key (org_id, pg_catalog.lower(name))
  WHERE revoked_at IS NULL;

CREATE OR REPLACE FUNCTION ludy_sign.api_key_insert(
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
  v_row ludy_sign.api_key%ROWTYPE;
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

  IF EXISTS (
    SELECT 1
    FROM ludy_sign.api_key k
    WHERE k.org_id = v_org
      AND k.revoked_at IS NULL
      AND pg_catalog.lower(k.name) = pg_catalog.lower(v_name)
  ) THEN
    RAISE EXCEPTION 'SIGN_API_KEY_DUPLICATE_NAME' USING ERRCODE = '23505';
  END IF;

  SELECT pg_catalog.count(*)::integer
  INTO v_active_count
  FROM ludy_sign.api_key k
  WHERE k.org_id = v_org
    AND k.revoked_at IS NULL
    AND (k.expires_at IS NULL OR k.expires_at > v_now);

  IF v_active_count >= 50 THEN
    RAISE EXCEPTION 'SIGN_API_KEY_LIMIT_REACHED' USING ERRCODE = '22023';
  END IF;

  INSERT INTO ludy_sign.api_key (
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

REVOKE ALL ON FUNCTION ludy_sign.api_key_insert(uuid, text, text, text, text[], timestamptz)
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
      'REVOKE ALL ON FUNCTION ludy_sign.api_key_insert(uuid, text, text, text, text[], timestamptz) FROM %I',
      r.rolname
    );
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION ludy_sign.api_key_insert(uuid, text, text, text, text[], timestamptz) TO ludy_app;

CREATE OR REPLACE FUNCTION ludy_sign.api_key_create_draft_from_template(
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
  FROM ludy_sign.api_key ak
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
    UPDATE ludy_sign.api_key
    SET last_used_at = v_now,
        updated_at = v_now
    WHERE org_id = v_ak.org_id AND id = v_ak.key_id;
  END IF;

  IF p_template_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('status', 'template_not_found');
  END IF;

  SELECT tpl.*
  INTO v_tpl
  FROM ludy_sign.template tpl
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

  IF v_tpl.status IS DISTINCT FROM 'active' THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'SIGN_TEMPLATE_NOT_ACTIVE',
      'httpStatus', 409,
      'message', 'Only active templates can instantiate envelopes'
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

  IF v_tpl.inspect_status <> 'passed' OR v_tpl.page_count IS NULL OR v_tpl.page_count < 1 THEN
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
      SELECT 1 FROM ludy_sign.template_role r
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
        'message', 'Duplicate roleKey in recipients'
      );
    END IF;
    v_seen_keys := array_append(v_seen_keys, v_rec_key);
  END LOOP;

  FOR v_role IN
    SELECT r.role_key
    FROM ludy_sign.template_role r
    WHERE r.org_id = v_ak.org_id
      AND r.template_id = v_tpl.id
      AND r.signer_role IN ('signer', 'approver')
  LOOP
    IF NOT (v_role.role_key = ANY (v_seen_keys)) THEN
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
  -- Inherits verified template inspection metadata atomically so reviewers open ready-to-edit drafts.
  INSERT INTO ludy_sign.envelope (
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
    inspect_error,
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
    NULL,
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
    FROM ludy_sign.template_role r
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
    IF v_email IS NOT NULL AND NOT ludy_sign.is_single_mail_address(v_email) THEN
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

    INSERT INTO ludy_sign.signer (
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
      FROM ludy_sign.template_field f
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

      INSERT INTO ludy_sign.field (
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

  v_ip_hash := ludy_sign.public_keyed_ip_hash(v_ak.org_id, p_ip_hash);

  PERFORM ludy_sign.public_append_event(
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
      'sourceKind', 'standalone',
      'templatePageCount', v_tpl.page_count
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

REVOKE ALL ON FUNCTION ludy_sign.api_key_create_draft_from_template(text, uuid, text, text, text, timestamptz, boolean, jsonb, jsonb, text, text)
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
      'REVOKE ALL ON FUNCTION ludy_sign.api_key_create_draft_from_template(text, uuid, text, text, text, timestamptz, boolean, jsonb, jsonb, text, text) FROM %I',
      r.rolname
    );
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION ludy_sign.api_key_create_draft_from_template(text, uuid, text, text, text, timestamptz, boolean, jsonb, jsonb, text, text)
  TO ludy_app;

-- Denormalize earliest pending obligation dueDate for indexed MCP renewal priority across >200 contracts.
ALTER TABLE ludy_sign.envelope_obligation
  ADD COLUMN IF NOT EXISTS next_pending_due_date date;

CREATE OR REPLACE FUNCTION ludy_sign.obligation_next_pending_due_date(p_obligations jsonb)
RETURNS date
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_elem jsonb;
  v_raw text;
  v_d date;
  v_min date;
BEGIN
  IF p_obligations IS NULL OR pg_catalog.jsonb_typeof(p_obligations) <> 'array' THEN
    RETURN NULL;
  END IF;
  FOR v_elem IN SELECT elem FROM pg_catalog.jsonb_array_elements(p_obligations) AS elem
  LOOP
    IF v_elem->>'status' = 'pending' THEN
      v_raw := v_elem->>'dueDate';
      IF v_raw ~ '^\d{4}-\d{2}-\d{2}$' THEN
        BEGIN
          v_d := v_raw::date;
          IF v_min IS NULL OR v_d < v_min THEN
            v_min := v_d;
          END IF;
        EXCEPTION
          WHEN data_exception THEN
            NULL;
        END;
      END IF;
    END IF;
  END LOOP;
  RETURN v_min;
END $$;

CREATE OR REPLACE FUNCTION ludy_sign.envelope_obligation_sync_next_pending_due_date()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_elem jsonb;
  v_raw text;
  v_d date;
  v_min date;
BEGIN
  IF NEW.obligations_json IS NOT NULL AND pg_catalog.jsonb_typeof(NEW.obligations_json) = 'array' THEN
    FOR v_elem IN SELECT elem FROM pg_catalog.jsonb_array_elements(NEW.obligations_json) AS elem
    LOOP
      IF v_elem->>'status' = 'pending' THEN
        v_raw := v_elem->>'dueDate';
        IF v_raw ~ '^\d{4}-\d{2}-\d{2}$' THEN
          BEGIN
            v_d := v_raw::date;
            IF v_min IS NULL OR v_d < v_min THEN
              v_min := v_d;
            END IF;
          EXCEPTION
            WHEN data_exception THEN
              NULL;
          END;
        END IF;
      END IF;
    END LOOP;
  END IF;
  NEW.next_pending_due_date := v_min;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION
  ludy_sign.obligation_next_pending_due_date(jsonb),
  ludy_sign.envelope_obligation_sync_next_pending_due_date()
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
      'REVOKE ALL ON FUNCTION ludy_sign.obligation_next_pending_due_date(jsonb), ludy_sign.envelope_obligation_sync_next_pending_due_date() FROM %I',
      r.rolname
    );
  END LOOP;
END $$;

DROP TRIGGER IF EXISTS envelope_obligation_sync_next_pending_due_date ON ludy_sign.envelope_obligation;
CREATE TRIGGER envelope_obligation_sync_next_pending_due_date
  BEFORE INSERT OR UPDATE OF obligations_json ON ludy_sign.envelope_obligation
  FOR EACH ROW
  EXECUTE FUNCTION ludy_sign.envelope_obligation_sync_next_pending_due_date();

UPDATE ludy_sign.envelope_obligation
SET next_pending_due_date = ludy_sign.obligation_next_pending_due_date(obligations_json)
WHERE next_pending_due_date IS DISTINCT FROM ludy_sign.obligation_next_pending_due_date(obligations_json);

CREATE INDEX IF NOT EXISTS envelope_obligation_org_renewal_priority_idx
  ON ludy_sign.envelope_obligation (
    org_id,
    LEAST(
      (expiry_date - COALESCE(renewal_notice_days, 0)),
      next_pending_due_date
    ) ASC NULLS LAST,
    updated_at DESC,
    id DESC
  )
  WHERE status = 'confirmed';
