-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove eSign Slice 5b (#4440):
--   1. Definer-only MACHINERY tables crove_sign.webhook and crove_sign.webhook_delivery
--      (RLS enabled, zero login-role table grants, agent_write_guard_install, broker-sealed
--      HMAC secrets with 24-hour dual-secret rotation grace period, and strict safe-metadata
--      payload_json CHECK constraint excluding PDFs, tokens, OTPs, titles, emails, and phones).
--   2. SECURITY DEFINER management, enqueue, sweep, and delivery recording functions with
--      owner/admin RBAC, confidential source_kind exclusion (hr_contract and meeting_minutes),
--      and 7-day consecutive-failure auto-pause.
--   3. Restate crove_sign.public_submit, crove_sign.public_decline, and crove_sign.public_direct_start
--      to enqueue non-confidential signer/envelope webhook events atomically.
--   4. Create pg-boss queues sign-hook-deliver (stately) and sign-hook-sweep (standard).

SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. Strict safe-metadata JSON payload validator
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_sign.webhook_payload_ok(
  p_payload jsonb,
  p_id uuid,
  p_org uuid,
  p_event_type text,
  p_envelope_id uuid,
  p_status text
) RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  c_instant constant text := '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?Z$';
  c_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_key text;
BEGIN
  IF p_status = 'queued' AND p_payload IS NULL THEN
    RETURN false;
  END IF;
  IF p_status IS DISTINCT FROM 'queued' AND p_payload IS NULL THEN
    RETURN true;
  END IF;
  IF p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) <> 'object' THEN
    RETURN false;
  END IF;

  FOR v_key IN SELECT pg_catalog.jsonb_object_keys(p_payload) LOOP
    IF v_key NOT IN (
      'eventId',
      'eventType',
      'occurredAt',
      'orgId',
      'envelopeId',
      'status',
      'signerId',
      'signerRole',
      'signedAt',
      'completedAt',
      'certificateCode',
      'sealedSha256'
    ) THEN
      RETURN false;
    END IF;
  END LOOP;

  IF NOT (p_payload ?& ARRAY['eventId', 'eventType', 'occurredAt', 'orgId', 'status']) THEN
    RETURN false;
  END IF;

  IF pg_catalog.jsonb_typeof(p_payload -> 'eventId') <> 'string'
     OR p_payload ->> 'eventId' <> p_id::text
     OR pg_catalog.jsonb_typeof(p_payload -> 'orgId') <> 'string'
     OR p_payload ->> 'orgId' <> p_org::text
     OR pg_catalog.jsonb_typeof(p_payload -> 'eventType') <> 'string'
     OR p_payload ->> 'eventType' <> p_event_type
     OR pg_catalog.jsonb_typeof(p_payload -> 'occurredAt') <> 'string'
     OR p_payload ->> 'occurredAt' !~ c_instant
     OR pg_catalog.jsonb_typeof(p_payload -> 'status') <> 'string' THEN
    RETURN false;
  END IF;

  IF p_event_type = 'ping' THEN
    IF p_envelope_id IS NOT NULL
       OR p_payload ->> 'status' <> 'ok'
       OR (p_payload ?| ARRAY['envelopeId', 'signerId', 'signerRole', 'signedAt', 'completedAt', 'certificateCode', 'sealedSha256']) THEN
      RETURN false;
    END IF;
    RETURN true;
  END IF;

  IF p_event_type NOT IN (
    'sign.envelope.sent',
    'sign.signer.signed',
    'sign.envelope.completed',
    'sign.envelope.declined',
    'sign.envelope.expired'
  ) OR p_envelope_id IS NULL THEN
    RETURN false;
  END IF;

  IF NOT (p_payload ? 'envelopeId')
     OR pg_catalog.jsonb_typeof(p_payload -> 'envelopeId') <> 'string'
     OR p_payload ->> 'envelopeId' <> p_envelope_id::text THEN
    RETURN false;
  END IF;

  IF (p_payload ->> 'status') NOT IN ('sent', 'in_progress', 'completed', 'declined', 'expired') THEN
    RETURN false;
  END IF;

  IF (p_payload ? 'signerId')
     AND (pg_catalog.jsonb_typeof(p_payload -> 'signerId') <> 'string' OR (p_payload ->> 'signerId') !~ c_uuid) THEN
    RETURN false;
  END IF;

  IF (p_payload ? 'signerRole')
     AND (pg_catalog.jsonb_typeof(p_payload -> 'signerRole') <> 'string' OR (p_payload ->> 'signerRole') NOT IN ('signer', 'approver')) THEN
    RETURN false;
  END IF;

  IF (p_payload ? 'signedAt')
     AND (pg_catalog.jsonb_typeof(p_payload -> 'signedAt') <> 'string' OR (p_payload ->> 'signedAt') !~ c_instant) THEN
    RETURN false;
  END IF;

  IF (p_payload ? 'completedAt')
     AND (pg_catalog.jsonb_typeof(p_payload -> 'completedAt') <> 'string' OR (p_payload ->> 'completedAt') !~ c_instant) THEN
    RETURN false;
  END IF;

  IF (p_payload ? 'certificateCode')
     AND (pg_catalog.jsonb_typeof(p_payload -> 'certificateCode') <> 'string' OR pg_catalog.char_length(p_payload ->> 'certificateCode') NOT BETWEEN 1 AND 64) THEN
    RETURN false;
  END IF;

  IF (p_payload ? 'sealedSha256')
     AND (pg_catalog.jsonb_typeof(p_payload -> 'sealedSha256') <> 'string' OR (p_payload ->> 'sealedSha256') !~ '^[0-9a-f]{64}$') THEN
    RETURN false;
  END IF;

  RETURN true;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Definer-only MACHINERY tables: crove_sign.webhook & crove_sign.webhook_delivery
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_sign.webhook (
  org_id uuid NOT NULL REFERENCES ludy_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT ludy_kernel.uuid_v7(),
  url text NOT NULL CHECK (
    pg_catalog.char_length(url) BETWEEN 12 AND 2048
    AND url ~ '^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:443)?(/[^[:space:]#]*)?$'
    AND url !~ '^https://[0-9.]+(:|/|$)'
  ),
  events text[] NOT NULL CHECK (
    pg_catalog.cardinality(events) >= 1
    AND events <@ ARRAY[
      'sign.envelope.sent',
      'sign.signer.signed',
      'sign.envelope.completed',
      'sign.envelope.declined',
      'sign.envelope.expired'
    ]::text[]
  ),
  enabled boolean NOT NULL DEFAULT true,
  key_id text NOT NULL CHECK (pg_catalog.length(key_id) BETWEEN 1 AND 128),
  secret_envelope text NOT NULL CHECK (pg_catalog.length(secret_envelope) BETWEEN 16 AND 16384),
  secret_hint text NOT NULL CHECK (secret_hint ~ '^whk_[0-9a-f]{8}$'),
  previous_key_id text CHECK (previous_key_id IS NULL OR pg_catalog.length(previous_key_id) BETWEEN 1 AND 128),
  previous_secret_envelope text CHECK (previous_secret_envelope IS NULL OR pg_catalog.length(previous_secret_envelope) BETWEEN 16 AND 16384),
  previous_expires_at timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  failing_since timestamptz,
  paused_reason text CHECK (paused_reason IS NULL OR paused_reason = 'failing'),
  last_delivery_at timestamptz,
  last_status text CHECK (last_status IS NULL OR last_status IN ('sent', 'failed')),
  created_by uuid REFERENCES ludy_kernel.user_account (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT webhook_previous_secret_ck CHECK (
    (previous_key_id IS NULL) = (previous_secret_envelope IS NULL)
    AND (previous_key_id IS NULL) = (previous_expires_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS webhook_org_created_idx
  ON crove_sign.webhook (org_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS webhook_created_by_idx
  ON crove_sign.webhook (created_by)
  WHERE created_by IS NOT NULL;

ALTER TABLE crove_sign.webhook ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS crove_sign.webhook_delivery (
  org_id uuid NOT NULL REFERENCES ludy_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT ludy_kernel.uuid_v7(),
  webhook_id uuid NOT NULL,
  envelope_id uuid,
  event_type text NOT NULL CHECK (
    event_type IN (
      'sign.envelope.sent',
      'sign.signer.signed',
      'sign.envelope.completed',
      'sign.envelope.declined',
      'sign.envelope.expired',
      'ping'
    )
  ),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'failed', 'dropped')),
  payload_json jsonb,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_code smallint CHECK (last_code IS NULL OR last_code BETWEEN 100 AND 599),
  handed_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT webhook_delivery_webhook_fk
    FOREIGN KEY (org_id, webhook_id) REFERENCES crove_sign.webhook (org_id, id) ON DELETE CASCADE,
  CONSTRAINT webhook_delivery_envelope_fk
    FOREIGN KEY (org_id, envelope_id) REFERENCES crove_sign.envelope (org_id, id) ON DELETE CASCADE,
  CONSTRAINT webhook_delivery_ping_envelope_ck
    CHECK ((event_type = 'ping') = (envelope_id IS NULL)),
  CONSTRAINT webhook_delivery_payload_ck
    CHECK (crove_sign.webhook_payload_ok(payload_json, id, org_id, event_type, envelope_id, status))
);

CREATE INDEX IF NOT EXISTS webhook_delivery_open_idx
  ON crove_sign.webhook_delivery (created_at, id)
  WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS webhook_delivery_webhook_idx
  ON crove_sign.webhook_delivery (org_id, webhook_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS webhook_delivery_envelope_idx
  ON crove_sign.webhook_delivery (org_id, envelope_id)
  WHERE envelope_id IS NOT NULL;

ALTER TABLE crove_sign.webhook_delivery ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  r record;
BEGIN
  REVOKE ALL ON crove_sign.webhook, crove_sign.webhook_delivery
    FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE (rolname LIKE 'ludy\_%' OR rolname LIKE 'crove\_%') AND rolname <> current_user LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON crove_sign.webhook, crove_sign.webhook_delivery FROM %I', r.rolname);
  END LOOP;
END $$;

SELECT ludy_kernel.agent_write_guard_install('crove_sign.webhook');
SELECT ludy_kernel.agent_write_guard_install('crove_sign.webhook_delivery');

-- ---------------------------------------------------------------------------
-- 3. SECURITY DEFINER helpers for webhook management, enqueueing, and delivery
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_sign.webhook_admin_caller()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_user uuid := ludy_kernel.ctx_user_id();
BEGIN
  IF v_org IS NULL OR v_user IS NULL OR ludy_kernel.ctx_actor_type() IS DISTINCT FROM 'user' THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  IF NOT ludy_kernel.org_app_on(v_org, 'sign') THEN
    RAISE EXCEPTION 'SIGN_APP_DISABLED' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM ludy_kernel.tenant_member m
    JOIN ludy_kernel.tenant t ON t.org_id = m.org_id AND t.status = 'active'
    JOIN ludy_kernel.user_account u ON u.id = m.user_id AND u.disabled_at IS NULL
    WHERE m.org_id = v_org
      AND m.user_id = v_user
      AND m.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'SIGN_WEBHOOK_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN v_user;
END $$;

CREATE OR REPLACE FUNCTION crove_sign.webhook_system_org()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
BEGIN
  IF v_org IS NULL OR ludy_kernel.ctx_actor_type() IS DISTINCT FROM 'system' THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  RETURN v_org;
END $$;

CREATE OR REPLACE FUNCTION crove_sign.webhook_standing(p_org uuid, p_webhook uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM crove_sign.webhook w
    JOIN ludy_kernel.tenant t ON t.org_id = w.org_id AND t.status = 'active'
    WHERE w.org_id = p_org
      AND w.id = p_webhook
      AND w.enabled
      AND ludy_kernel.org_app_on(p_org, 'sign')
  )
$$;

CREATE OR REPLACE FUNCTION crove_sign.webhook_drop_queued(p_org uuid, p_webhook uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE crove_sign.webhook_delivery d
  SET status = 'dropped',
      payload_json = NULL
  WHERE d.org_id = p_org
    AND d.status = 'queued'
    AND (p_webhook IS NULL OR d.webhook_id = p_webhook);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

CREATE OR REPLACE FUNCTION crove_sign.webhook_drop_on_disable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM crove_sign.webhook_drop_queued(NEW.org_id, NEW.id);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS webhook_drop_on_disable ON crove_sign.webhook;
CREATE TRIGGER webhook_drop_on_disable
  AFTER UPDATE OF enabled ON crove_sign.webhook
  FOR EACH ROW WHEN (OLD.enabled AND NOT NEW.enabled)
  EXECUTE FUNCTION crove_sign.webhook_drop_on_disable();

CREATE OR REPLACE FUNCTION crove_sign.webhook_row_json(p_row crove_sign.webhook)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT pg_catalog.jsonb_build_object(
    'id', p_row.id,
    'url', p_row.url,
    'events', pg_catalog.to_jsonb(p_row.events),
    'enabled', p_row.enabled,
    'secretHint', p_row.secret_hint,
    'previousExpiresAt', CASE
      WHEN p_row.previous_expires_at > pg_catalog.clock_timestamp()
      THEN pg_catalog.to_char(p_row.previous_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      ELSE NULL
    END,
    'consecutiveFailures', p_row.consecutive_failures,
    'failingSince', CASE
      WHEN p_row.failing_since IS NOT NULL
      THEN pg_catalog.to_char(p_row.failing_since AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      ELSE NULL
    END,
    'pausedReason', p_row.paused_reason,
    'lastDeliveryAt', CASE
      WHEN p_row.last_delivery_at IS NOT NULL
      THEN pg_catalog.to_char(p_row.last_delivery_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      ELSE NULL
    END,
    'lastStatus', p_row.last_status,
    'createdBy', p_row.created_by,
    'createdAt', pg_catalog.to_char(p_row.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updatedAt', pg_catalog.to_char(p_row.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )
$$;

CREATE OR REPLACE FUNCTION crove_sign.webhook_list()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_out jsonb;
BEGIN
  PERFORM crove_sign.webhook_admin_caller();
  SELECT COALESCE(
    pg_catalog.jsonb_agg(crove_sign.webhook_row_json(w) ORDER BY w.created_at DESC, w.id DESC),
    '[]'::jsonb
  )
  INTO v_out
  FROM crove_sign.webhook w
  WHERE w.org_id = v_org;
  RETURN v_out;
END $$;

CREATE OR REPLACE FUNCTION crove_sign.webhook_deliveries_list(
  p_webhook_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 50
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_cap integer := GREATEST(1, LEAST(COALESCE(p_limit, 50), 100));
  v_out jsonb;
BEGIN
  PERFORM crove_sign.webhook_admin_caller();
  IF p_webhook_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM crove_sign.webhook w WHERE w.org_id = v_org AND w.id = p_webhook_id
  ) THEN
    RAISE EXCEPTION 'SIGN_WEBHOOK_NOT_FOUND' USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', q.id,
        'webhookId', q.webhook_id,
        'envelopeId', q.envelope_id,
        'eventType', q.event_type,
        'status', q.status,
        'attempts', q.attempts,
        'lastCode', q.last_code,
        'handedAt', CASE WHEN q.handed_at IS NOT NULL THEN pg_catalog.to_char(q.handed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') ELSE NULL END,
        'sentAt', CASE WHEN q.sent_at IS NOT NULL THEN pg_catalog.to_char(q.sent_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') ELSE NULL END,
        'createdAt', pg_catalog.to_char(q.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'payload', q.payload_json
      )
      ORDER BY q.created_at DESC, q.id DESC
    ),
    '[]'::jsonb
  )
  INTO v_out
  FROM (
    SELECT d.*
    FROM crove_sign.webhook_delivery d
    WHERE d.org_id = v_org
      AND (p_webhook_id IS NULL OR d.webhook_id = p_webhook_id)
    ORDER BY d.created_at DESC, d.id DESC
    LIMIT v_cap
  ) q;

  RETURN v_out;
END $$;

CREATE OR REPLACE FUNCTION crove_sign.webhook_create(
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
  v_row crove_sign.webhook;
BEGIN
  v_user := crove_sign.webhook_admin_caller();

  IF p_url IS NULL
     OR pg_catalog.char_length(p_url) NOT BETWEEN 12 AND 2048
     OR p_url !~ '^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:443)?(/[^[:space:]#]*)?$'
     OR p_url ~ '^https://[0-9.]+(:|/|$)'
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
  FROM crove_sign.webhook w
  WHERE w.org_id = v_org;

  IF v_count >= 20 THEN
    RAISE EXCEPTION 'SIGN_WEBHOOKS_MAX' USING ERRCODE = '22023';
  END IF;

  INSERT INTO crove_sign.webhook (
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

  RETURN crove_sign.webhook_row_json(v_row);
END $$;

CREATE OR REPLACE FUNCTION crove_sign.webhook_update(
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
  v_old crove_sign.webhook;
  v_row crove_sign.webhook;
BEGIN
  PERFORM crove_sign.webhook_admin_caller();

  IF p_webhook_id IS NULL
     OR p_url IS NULL
     OR pg_catalog.char_length(p_url) NOT BETWEEN 12 AND 2048
     OR p_url !~ '^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:443)?(/[^[:space:]#]*)?$'
     OR p_url ~ '^https://[0-9.]+(:|/|$)'
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
  FROM crove_sign.webhook w
  WHERE w.org_id = v_org AND w.id = p_webhook_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SIGN_WEBHOOK_NOT_FOUND' USING ERRCODE = '22023';
  END IF;

  IF v_old.url IS DISTINCT FROM p_url OR NOT p_enabled THEN
    PERFORM crove_sign.webhook_drop_queued(v_org, v_old.id);
  ELSIF NOT (v_old.events <@ v_events) THEN
    UPDATE crove_sign.webhook_delivery d
    SET status = 'dropped',
        payload_json = NULL
    WHERE d.org_id = v_org
      AND d.webhook_id = v_old.id
      AND d.status = 'queued'
      AND d.event_type <> 'ping'
      AND NOT (d.event_type = ANY(v_events));
  END IF;

  UPDATE crove_sign.webhook w
  SET url = p_url,
      events = v_events,
      enabled = p_enabled,
      paused_reason = CASE WHEN p_enabled THEN NULL ELSE w.paused_reason END,
      failing_since = CASE WHEN (p_enabled AND NOT w.enabled) OR v_old.url IS DISTINCT FROM p_url THEN NULL ELSE w.failing_since END,
      consecutive_failures = CASE WHEN (p_enabled AND NOT w.enabled) OR v_old.url IS DISTINCT FROM p_url THEN 0 ELSE w.consecutive_failures END,
      updated_at = v_now
  WHERE w.org_id = v_org AND w.id = v_old.id
  RETURNING * INTO v_row;

  RETURN crove_sign.webhook_row_json(v_row);
END $$;

CREATE OR REPLACE FUNCTION crove_sign.webhook_rotate_secret(
  p_webhook_id uuid,
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
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_row crove_sign.webhook;
BEGIN
  PERFORM crove_sign.webhook_admin_caller();

  IF p_webhook_id IS NULL
     OR p_key_id IS NULL OR pg_catalog.length(p_key_id) NOT BETWEEN 1 AND 128
     OR p_secret_envelope IS NULL OR pg_catalog.length(p_secret_envelope) NOT BETWEEN 16 AND 16384
     OR p_secret_hint IS NULL OR p_secret_hint !~ '^whk_[0-9a-f]{8}$' THEN
    RAISE EXCEPTION 'SIGN_WEBHOOK_INVALID' USING ERRCODE = '22023';
  END IF;

  UPDATE crove_sign.webhook w
  SET previous_key_id = w.key_id,
      previous_secret_envelope = w.secret_envelope,
      previous_expires_at = v_now + interval '24 hours',
      key_id = p_key_id,
      secret_envelope = p_secret_envelope,
      secret_hint = p_secret_hint,
      updated_at = v_now
  WHERE w.org_id = v_org AND w.id = p_webhook_id
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SIGN_WEBHOOK_NOT_FOUND' USING ERRCODE = '22023';
  END IF;

  RETURN crove_sign.webhook_row_json(v_row);
END $$;

CREATE OR REPLACE FUNCTION crove_sign.webhook_delete(p_webhook_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_count integer;
BEGIN
  PERFORM crove_sign.webhook_admin_caller();
  DELETE FROM crove_sign.webhook w
  WHERE w.org_id = v_org AND w.id = p_webhook_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count = 1;
END $$;

CREATE OR REPLACE FUNCTION crove_sign.webhook_ping(p_webhook_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_now timestamptz := pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp());
  v_id uuid := ludy_kernel.uuid_v7();
  v_webhook crove_sign.webhook;
  v_occurred text := pg_catalog.to_char(v_now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
  PERFORM crove_sign.webhook_admin_caller();

  SELECT w.*
  INTO v_webhook
  FROM crove_sign.webhook w
  WHERE w.org_id = v_org AND w.id = p_webhook_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SIGN_WEBHOOK_NOT_FOUND' USING ERRCODE = '22023';
  END IF;
  IF NOT crove_sign.webhook_standing(v_org, v_webhook.id) THEN
    RAISE EXCEPTION 'SIGN_WEBHOOK_DISABLED' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM crove_sign.webhook_delivery d
    WHERE d.org_id = v_org
      AND d.webhook_id = v_webhook.id
      AND d.event_type = 'ping'
      AND d.created_at > pg_catalog.clock_timestamp() - interval '1 minute'
  ) OR (
    SELECT pg_catalog.count(*)
    FROM crove_sign.webhook_delivery d
    WHERE d.org_id = v_org
      AND d.webhook_id = v_webhook.id
      AND d.event_type = 'ping'
      AND d.created_at > pg_catalog.clock_timestamp() - interval '1 hour'
  ) >= 10 THEN
    RAISE EXCEPTION 'SIGN_WEBHOOK_PING_RATE_LIMITED' USING ERRCODE = '22023';
  END IF;

  INSERT INTO crove_sign.webhook_delivery (
    org_id, id, webhook_id, envelope_id, event_type, status, payload_json, created_at
  )
  VALUES (
    v_org,
    v_id,
    v_webhook.id,
    NULL,
    'ping',
    'queued',
    pg_catalog.jsonb_build_object(
      'eventId', v_id::text,
      'eventType', 'ping',
      'occurredAt', v_occurred,
      'orgId', v_org::text,
      'status', 'ok'
    ),
    v_now
  );

  RETURN pg_catalog.jsonb_build_object(
    'deliveryId', v_id,
    'webhookId', v_webhook.id,
    'eventType', 'ping',
    'status', 'queued',
    'createdAt', v_occurred
  );
END $$;

-- Internal enqueue helper: hard-excludes confidential hr_contract and meeting_minutes envelopes.
CREATE OR REPLACE FUNCTION crove_sign.webhook_enqueue_internal(
  p_org uuid,
  p_envelope_id uuid,
  p_event_type text,
  p_status text,
  p_occurred_at timestamptz,
  p_signer_id uuid DEFAULT NULL,
  p_signer_role text DEFAULT NULL,
  p_signed_at timestamptz DEFAULT NULL,
  p_completed_at timestamptz DEFAULT NULL,
  p_certificate_code text DEFAULT NULL,
  p_sealed_sha256 text DEFAULT NULL
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_source_kind text;
  v_now timestamptz := pg_catalog.date_trunc('milliseconds', COALESCE(p_occurred_at, pg_catalog.clock_timestamp()));
  v_occurred text := pg_catalog.to_char(v_now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_signed_at text := CASE
    WHEN p_signed_at IS NOT NULL THEN pg_catalog.to_char(pg_catalog.date_trunc('milliseconds', p_signed_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ELSE NULL
  END;
  v_completed_at text := CASE
    WHEN p_completed_at IS NOT NULL THEN pg_catalog.to_char(pg_catalog.date_trunc('milliseconds', p_completed_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ELSE NULL
  END;
  v_hook record;
  v_id uuid;
  v_payload jsonb;
  v_count integer := 0;
BEGIN
  IF p_org IS NULL OR p_envelope_id IS NULL THEN
    RETURN 0;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM ludy_kernel.tenant t
    WHERE t.org_id = p_org AND t.status = 'active'
  ) OR NOT ludy_kernel.org_app_on(p_org, 'sign') THEN
    RETURN 0;
  END IF;

  SELECT e.source_kind
  INTO v_source_kind
  FROM crove_sign.envelope e
  WHERE e.org_id = p_org AND e.id = p_envelope_id;

  -- Strict confidentiality boundary: never enqueue org-level webhooks for hr_contract or meeting_minutes envelopes.
  IF NOT FOUND OR v_source_kind IN ('hr_contract', 'meeting_minutes') THEN
    RETURN 0;
  END IF;

  FOR v_hook IN
    SELECT w.id
    FROM crove_sign.webhook w
    WHERE w.org_id = p_org
      AND w.enabled = true
      AND p_event_type = ANY(w.events)
    ORDER BY w.created_at ASC, w.id ASC
  LOOP
    v_id := ludy_kernel.uuid_v7();
    v_payload := pg_catalog.jsonb_strip_nulls(
      pg_catalog.jsonb_build_object(
        'eventId', v_id::text,
        'eventType', p_event_type,
        'occurredAt', v_occurred,
        'orgId', p_org::text,
        'envelopeId', p_envelope_id::text,
        'status', p_status,
        'signerId', CASE WHEN p_signer_id IS NOT NULL THEN p_signer_id::text ELSE NULL END,
        'signerRole', CASE WHEN p_signer_role IN ('signer', 'approver') THEN p_signer_role ELSE NULL END,
        'signedAt', v_signed_at,
        'completedAt', v_completed_at,
        'certificateCode', p_certificate_code,
        'sealedSha256', p_sealed_sha256
      )
    );

    INSERT INTO crove_sign.webhook_delivery (
      org_id, id, webhook_id, envelope_id, event_type, status, payload_json, created_at
    )
    VALUES (
      p_org, v_id, v_hook.id, p_envelope_id, p_event_type, 'queued', v_payload, v_now
    );
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END $$;

-- Context-bound wrapper for Runtime.execute() commands (sendDraftEnvelope, seal_complete, expire_sweep).
CREATE OR REPLACE FUNCTION crove_sign.webhook_enqueue_event(
  p_envelope_id uuid,
  p_event_type text,
  p_status text,
  p_occurred_at timestamptz,
  p_signer_id uuid DEFAULT NULL,
  p_signer_role text DEFAULT NULL,
  p_signed_at timestamptz DEFAULT NULL,
  p_completed_at timestamptz DEFAULT NULL,
  p_certificate_code text DEFAULT NULL,
  p_sealed_sha256 text DEFAULT NULL
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_actor text := ludy_kernel.ctx_actor_type();
BEGIN
  IF v_org IS NULL OR v_actor IS NULL OR v_actor NOT IN ('user', 'system') THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  IF v_actor = 'user' AND NOT EXISTS (
    SELECT 1
    FROM ludy_kernel.tenant_member m
    WHERE m.org_id = v_org
      AND m.user_id = ludy_kernel.ctx_user_id()
      AND m.role IN ('owner', 'admin', 'member')
  ) THEN
    RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN crove_sign.webhook_enqueue_internal(
    v_org,
    p_envelope_id,
    p_event_type,
    p_status,
    p_occurred_at,
    p_signer_id,
    p_signer_role,
    p_signed_at,
    p_completed_at,
    p_certificate_code,
    p_sealed_sha256
  );
END $$;

-- Worker sweep & delivery definers (ludy_worker only)
CREATE OR REPLACE FUNCTION crove_sign.webhook_open(p_limit integer)
RETURNS TABLE (org_id uuid, id uuid, kind text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT d.org_id, d.id,
         CASE WHEN d.created_at <= pg_catalog.clock_timestamp() - interval '8 hours' THEN 'expire' ELSE 'send' END
  FROM crove_sign.webhook_delivery d
  WHERE d.status = 'queued'
    AND (
      d.created_at <= pg_catalog.clock_timestamp() - interval '8 hours'
      OR d.handed_at IS NULL
      OR (d.attempts = 0 AND d.handed_at <= pg_catalog.clock_timestamp() - interval '3 minutes')
    )
  ORDER BY d.created_at, d.id
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 200), 500))
$$;

CREATE OR REPLACE FUNCTION crove_sign.webhook_delivery_get(p_org_id uuid, p_id uuid)
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
  v_org uuid := crove_sign.webhook_system_org();
BEGIN
  RETURN QUERY
  SELECT
    d.id,
    d.webhook_id,
    d.envelope_id,
    e.source_kind,
    d.event_type,
    d.payload_json,
    d.status,
    d.attempts
  FROM crove_sign.webhook_delivery d
  LEFT JOIN crove_sign.envelope e ON e.org_id = d.org_id AND e.id = d.envelope_id
  WHERE d.org_id = p_org_id
    AND d.id = p_id
    AND p_org_id = v_org;
END $$;

CREATE OR REPLACE FUNCTION crove_sign.webhook_target(p_webhook_id uuid)
RETURNS TABLE (
  id uuid,
  url text,
  key_id text,
  secret_envelope text,
  previous_key_id text,
  previous_secret_envelope text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := crove_sign.webhook_system_org();
BEGIN
  RETURN QUERY
  SELECT
    w.id,
    w.url,
    w.key_id,
    w.secret_envelope,
    CASE WHEN w.previous_expires_at > pg_catalog.clock_timestamp() THEN w.previous_key_id ELSE NULL END,
    CASE WHEN w.previous_expires_at > pg_catalog.clock_timestamp() THEN w.previous_secret_envelope ELSE NULL END
  FROM crove_sign.webhook w
  WHERE w.org_id = v_org
    AND w.id = p_webhook_id
    AND crove_sign.webhook_standing(v_org, w.id);
END $$;

CREATE OR REPLACE FUNCTION crove_sign.webhook_touch(p_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := crove_sign.webhook_system_org();
  v_count integer;
BEGIN
  UPDATE crove_sign.webhook_delivery d
  SET handed_at = pg_catalog.clock_timestamp()
  WHERE d.org_id = v_org
    AND d.id = p_id
    AND d.status = 'queued';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count = 1;
END $$;

CREATE OR REPLACE FUNCTION crove_sign.webhook_record(
  p_id uuid,
  p_outcome text,
  p_code integer
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := crove_sign.webhook_system_org();
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_webhook uuid;
BEGIN
  IF p_outcome IS NULL
     OR p_outcome NOT IN ('sent', 'retry', 'failed', 'dropped', 'expired')
     OR (p_code IS NOT NULL AND p_code NOT BETWEEN 100 AND 599) THEN
    RAISE EXCEPTION 'SIGN_WEBHOOK_INVALID' USING ERRCODE = '22023';
  END IF;

  UPDATE crove_sign.webhook_delivery d
  SET status = CASE p_outcome
        WHEN 'sent' THEN 'sent'
        WHEN 'failed' THEN 'failed'
        WHEN 'expired' THEN 'failed'
        WHEN 'dropped' THEN 'dropped'
        ELSE d.status
      END,
      payload_json = CASE WHEN p_outcome = 'dropped' THEN NULL ELSE d.payload_json END,
      attempts = d.attempts + CASE WHEN p_outcome IN ('dropped', 'expired') THEN 0 ELSE 1 END,
      last_code = p_code,
      sent_at = CASE WHEN p_outcome = 'sent' THEN v_now ELSE d.sent_at END
  WHERE d.org_id = v_org
    AND d.id = p_id
    AND d.status = 'queued'
  RETURNING d.webhook_id INTO v_webhook;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF p_outcome = 'sent' THEN
    UPDATE crove_sign.webhook w
    SET last_delivery_at = v_now,
        last_status = 'sent',
        consecutive_failures = 0,
        failing_since = NULL,
        updated_at = v_now
    WHERE w.org_id = v_org AND w.id = v_webhook;
  ELSIF p_outcome IN ('retry', 'failed') THEN
    UPDATE crove_sign.webhook w
    SET last_status = 'failed',
        consecutive_failures = w.consecutive_failures + 1,
        failing_since = COALESCE(w.failing_since, v_now),
        updated_at = v_now
    WHERE w.org_id = v_org AND w.id = v_webhook;

    UPDATE crove_sign.webhook w
    SET enabled = false,
        paused_reason = 'failing',
        updated_at = v_now
    WHERE w.org_id = v_org
      AND w.id = v_webhook
      AND w.enabled
      AND w.failing_since <= v_now - interval '7 days';
  END IF;

  DELETE FROM crove_sign.webhook_delivery d
  WHERE d.org_id = v_org
    AND d.webhook_id = v_webhook
    AND d.status <> 'queued'
    AND d.created_at < v_now - interval '30 days';

  RETURN true;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Grants on webhook functions
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION
  crove_sign.webhook_payload_ok(jsonb, uuid, uuid, text, uuid, text),
  crove_sign.webhook_admin_caller(),
  crove_sign.webhook_system_org(),
  crove_sign.webhook_standing(uuid, uuid),
  crove_sign.webhook_drop_queued(uuid, uuid),
  crove_sign.webhook_drop_on_disable(),
  crove_sign.webhook_row_json(crove_sign.webhook),
  crove_sign.webhook_list(),
  crove_sign.webhook_deliveries_list(uuid, integer),
  crove_sign.webhook_create(uuid, text, text[], boolean, text, text, text),
  crove_sign.webhook_update(uuid, text, text[], boolean),
  crove_sign.webhook_rotate_secret(uuid, text, text, text),
  crove_sign.webhook_delete(uuid),
  crove_sign.webhook_ping(uuid),
  crove_sign.webhook_enqueue_internal(uuid, uuid, text, text, timestamptz, uuid, text, timestamptz, timestamptz, text, text),
  crove_sign.webhook_enqueue_event(uuid, text, text, timestamptz, uuid, text, timestamptz, timestamptz, text, text),
  crove_sign.webhook_open(integer),
  crove_sign.webhook_delivery_get(uuid, uuid),
  crove_sign.webhook_target(uuid),
  crove_sign.webhook_touch(uuid),
  crove_sign.webhook_record(uuid, text, integer)
FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;

DO $$
DECLARE
  r record;
  v_fns constant text :=
    'crove_sign.webhook_payload_ok(jsonb, uuid, uuid, text, uuid, text), ' ||
    'crove_sign.webhook_admin_caller(), ' ||
    'crove_sign.webhook_system_org(), ' ||
    'crove_sign.webhook_standing(uuid, uuid), ' ||
    'crove_sign.webhook_drop_queued(uuid, uuid), ' ||
    'crove_sign.webhook_drop_on_disable(), ' ||
    'crove_sign.webhook_row_json(crove_sign.webhook), ' ||
    'crove_sign.webhook_list(), ' ||
    'crove_sign.webhook_deliveries_list(uuid, integer), ' ||
    'crove_sign.webhook_create(uuid, text, text[], boolean, text, text, text), ' ||
    'crove_sign.webhook_update(uuid, text, text[], boolean), ' ||
    'crove_sign.webhook_rotate_secret(uuid, text, text, text), ' ||
    'crove_sign.webhook_delete(uuid), ' ||
    'crove_sign.webhook_ping(uuid), ' ||
    'crove_sign.webhook_enqueue_internal(uuid, uuid, text, text, timestamptz, uuid, text, timestamptz, timestamptz, text, text), ' ||
    'crove_sign.webhook_enqueue_event(uuid, text, text, timestamptz, uuid, text, timestamptz, timestamptz, text, text), ' ||
    'crove_sign.webhook_open(integer), ' ||
    'crove_sign.webhook_delivery_get(uuid, uuid), ' ||
    'crove_sign.webhook_target(uuid), ' ||
    'crove_sign.webhook_touch(uuid), ' ||
    'crove_sign.webhook_record(uuid, text, integer)';
BEGIN
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE 'crove\_%' AND rolname <> current_user LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ' || v_fns || ' FROM %I', r.rolname);
  END LOOP;
END $$;

GRANT EXECUTE ON FUNCTION
  crove_sign.webhook_list(),
  crove_sign.webhook_deliveries_list(uuid, integer),
  crove_sign.webhook_create(uuid, text, text[], boolean, text, text, text),
  crove_sign.webhook_update(uuid, text, text[], boolean),
  crove_sign.webhook_rotate_secret(uuid, text, text, text),
  crove_sign.webhook_delete(uuid),
  crove_sign.webhook_ping(uuid),
  crove_sign.webhook_enqueue_event(uuid, text, text, timestamptz, uuid, text, timestamptz, timestamptz, text, text)
TO ludy_app;

GRANT EXECUTE ON FUNCTION
  crove_sign.webhook_enqueue_event(uuid, text, text, timestamptz, uuid, text, timestamptz, timestamptz, text, text),
  crove_sign.webhook_open(integer),
  crove_sign.webhook_delivery_get(uuid, uuid),
  crove_sign.webhook_target(uuid),
  crove_sign.webhook_touch(uuid),
  crove_sign.webhook_record(uuid, text, integer)
TO ludy_worker;

-- ---------------------------------------------------------------------------
-- 5. Restate public_submit, public_decline, and public_direct_start for webhooks
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
    ELSIF v_field.field_type IN ('date', 'text', 'dropdown', 'radio') THEN
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

  PERFORM crove_sign.webhook_enqueue_internal(
    v_lookup.org_id,
    v_env.id,
    'sign.envelope.declined',
    'declined',
    v_now,
    v_signer.id,
    v_signer.signer_role,
    NULL,
    NULL,
    NULL,
    NULL
  );

  RETURN pg_catalog.jsonb_build_object(
    'status', 'ok',
    'signerId', v_signer.id,
    'signerStatus', 'declined',
    'envelopeStatus', 'declined',
    'declinedAt', pg_catalog.to_char(v_now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
END $$;

REVOKE ALL ON FUNCTION crove_sign.public_decline(text, text, text, text) FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.public_decline(text, text, text, text) TO ludy_app;

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
  v_ctx_org uuid := ludy_kernel.ctx_org_id();
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

  IF v_ctx_org IS NOT NULL AND (ludy_kernel.ctx_actor_type() IS DISTINCT FROM 'system' OR v_ctx_org IS DISTINCT FROM v_lookup.org_id) THEN
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
  FROM ludy_kernel.tenant t
  WHERE t.org_id = v_lookup.org_id;

  IF NOT FOUND
     OR v_tenant.status IS DISTINCT FROM 'active'
     OR NOT ludy_kernel.org_app_on(v_lookup.org_id, 'sign')
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
    org_id, title, subject, message, status, routing_mode, allow_delegation,
    source_kind, source_id, direct_link_id, source_file_id, source_storage_key, source_generation, source_sha256,
    inspect_status, page_count, page_dimensions_json, detected_tags_json,
    share_summary_with_signers, shared_summary_json,
    expires_at, sent_at, version, created_by, created_at, updated_at
  )
  VALUES (
    v_lookup.org_id, v_tpl.title, v_tpl.subject, v_tpl.message, 'sent', v_tpl.routing_mode, v_tpl.allow_delegation,
    'standalone', NULL, v_link.id, v_tpl.source_file_id, v_tpl.source_storage_key, v_tpl.source_generation, v_tpl.source_sha256,
    'passed', v_tpl.page_count, v_tpl.page_dimensions_json, v_tpl.detected_tags_json,
    v_tpl.share_summary_with_signers, v_tpl.shared_summary_json,
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
    x_norm, y_norm, w_norm, h_norm, label, required, proposed_by_ai, font_size_pt, options_json,
    created_at, updated_at
  )
  SELECT
    v_lookup.org_id, v_env_id, v_signer_id, f.field_type, f.page_number,
    f.x_norm, f.y_norm, f.w_norm, f.h_norm, f.label, f.required, false, f.font_size_pt, f.options_json,
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

  PERFORM crove_sign.webhook_enqueue_internal(
    v_lookup.org_id,
    v_env_id,
    'sign.envelope.sent',
    'sent',
    v_now,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL
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
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.public_direct_start(text, text, text, text, text, text, text) TO ludy_app;

-- ---------------------------------------------------------------------------
-- 6. pg-boss queues for eSign outbound webhooks
-- ---------------------------------------------------------------------------
SELECT ludy_jobs.create_queue('sign-hook-deliver', '{"policy":"stately","deadLetter":"kernel-job.dlq"}'::jsonb);
SELECT ludy_jobs.create_queue('sign-hook-sweep', '{"policy":"standard","deadLetter":"kernel-job.dlq"}'::jsonb);
