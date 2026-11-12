-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove kernel (issue #3024, ADR-0051 decision 4): the delivery of an MCP grant's wake-up webhook, step (b). The setup (the receiver, the sealed secret, the schedule) is
-- 20261223000000; this adds what the sweep and the delivery worker keep. Idempotent; applied files stay untouched.
--
-- - agent_wake_delivery: one wake-up to send, as a body of ids, an event type, dates and decimal-string amounts, and how its delivery went. The body is checked by the database
--   too (mcp_wake_body_ok: the keys, the shape of every value, and the ids equal to the row's), so no name, note or message can be stored in one whatever wrote the row.
-- - agent_wake_signal_seen: the keys of the signals already sent for a grant, so a signal fires when its key first appears and again only after it went away.
-- - Both are definer-only like agent_grant_wake. The delivery worker lists work through mcp_wake_due and mcp_wake_open, loads a delivery with mcp_wake_delivery_get and the
--   receiver with mcp_wake_target (20261223000000); every change goes through a system command that calls mcp_wake_enqueue, mcp_wake_touch, mcp_wake_record, mcp_wake_signals_sync
--   or mcp_wake_schedule_advance, which refuse any context but the system's, in an org.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_kernel.agent_grant_wake ADD COLUMN IF NOT EXISTS signals_checked_at timestamptz;

-- ---------------------------------------------------------------------------
-- The body of a wake-up, as the database accepts it. The same shapes as apps/kernel/src/mcp-wake-body.ts, which is the only builder.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_kernel.mcp_wake_body_ok(p_body jsonb, p_id uuid, p_org uuid, p_grant uuid, p_type text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  k text;
  v_item jsonb;
  v_items jsonb;
  c_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
BEGIN
  IF p_body IS NULL OR pg_catalog.jsonb_typeof(p_body) <> 'object' THEN
    RETURN false;
  END IF;
  FOR k IN SELECT pg_catalog.jsonb_object_keys(p_body) LOOP
    IF k NOT IN ('id', 'type', 'created_at', 'org', 'grant', 'data') THEN
      RETURN false;
    END IF;
  END LOOP;
  IF p_body ->> 'id' IS DISTINCT FROM p_id::text OR p_body ->> 'org' IS DISTINCT FROM p_org::text OR p_body ->> 'grant' IS DISTINCT FROM p_grant::text
     OR p_body ->> 'type' IS DISTINCT FROM p_type THEN
    RETURN false;
  END IF;
  IF pg_catalog.jsonb_typeof(p_body -> 'created_at') <> 'string' OR (p_body ->> 'created_at') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$' THEN
    RETURN false;
  END IF;
  IF pg_catalog.jsonb_typeof(p_body -> 'data') <> 'object' THEN
    RETURN false;
  END IF;
  IF p_type = 'ping' THEN
    RETURN (p_body -> 'data') = '{}'::jsonb;
  ELSIF p_type = 'schedule.due' THEN
    FOR k IN SELECT pg_catalog.jsonb_object_keys(p_body -> 'data') LOOP
      IF k <> 'date' THEN
        RETURN false;
      END IF;
    END LOOP;
    RETURN pg_catalog.jsonb_typeof(p_body #> '{data,date}') = 'string' AND (p_body #>> '{data,date}') ~ '^\d{4}-\d{2}-\d{2}$';
  ELSIF p_type = 'signal.fired' THEN
    FOR k IN SELECT pg_catalog.jsonb_object_keys(p_body -> 'data') LOOP
      IF k <> 'items' THEN
        RETURN false;
      END IF;
    END LOOP;
    v_items := p_body #> '{data,items}';
    IF pg_catalog.jsonb_typeof(v_items) <> 'array' OR pg_catalog.jsonb_array_length(v_items) NOT BETWEEN 1 AND 20 THEN
      RETURN false;
    END IF;
    FOR v_item IN SELECT * FROM pg_catalog.jsonb_array_elements(v_items) LOOP
      IF pg_catalog.jsonb_typeof(v_item) <> 'object' THEN
        RETURN false;
      END IF;
      FOR k IN SELECT pg_catalog.jsonb_object_keys(v_item) LOOP
        IF k NOT IN ('rule', 'key', 'severity', 'party_id', 'deal_id', 'invoice_id', 'amount', 'due_on', 'days') THEN
          RETURN false;
        END IF;
      END LOOP;
      IF pg_catalog.jsonb_typeof(v_item -> 'rule') <> 'string'
         OR (v_item ->> 'rule') NOT IN ('kernel.signals.deal_without_invoice', 'kernel.signals.receivable_with_open_deal', 'kernel.signals.supplier_bank_changed')
         OR pg_catalog.jsonb_typeof(v_item -> 'key') <> 'string'
         OR (v_item ->> 'key') !~ '^[a-z]+(_[a-z]+)*(:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}){1,3}$'
         OR pg_catalog.jsonb_typeof(v_item -> 'severity') <> 'string' OR (v_item ->> 'severity') NOT IN ('info', 'warn', 'block') THEN
        RETURN false;
      END IF;
      FOREACH k IN ARRAY ARRAY['party_id', 'deal_id', 'invoice_id'] LOOP
        IF v_item ? k AND (pg_catalog.jsonb_typeof(v_item -> k) <> 'string' OR (v_item ->> k) !~ c_uuid) THEN
          RETURN false;
        END IF;
      END LOOP;
      IF v_item ? 'amount' AND (pg_catalog.jsonb_typeof(v_item -> 'amount') <> 'string' OR (v_item ->> 'amount') !~ '^-?(0|[1-9][0-9]{0,17})(\.[0-9]{1,4})?$') THEN
        RETURN false;
      END IF;
      IF v_item ? 'due_on' AND (pg_catalog.jsonb_typeof(v_item -> 'due_on') <> 'string' OR (v_item ->> 'due_on') !~ '^\d{4}-\d{2}-\d{2}$') THEN
        RETURN false;
      END IF;
      IF v_item ? 'days' AND (pg_catalog.jsonb_typeof(v_item -> 'days') <> 'number' OR (v_item ->> 'days') !~ '^[0-9]{1,4}$' OR (v_item ->> 'days')::integer > 3650) THEN
        RETURN false;
      END IF;
    END LOOP;
    RETURN true;
  END IF;
  RETURN false;
END $$;

-- ---------------------------------------------------------------------------
-- agent_wake_delivery and agent_wake_signal_seen
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_kernel.agent_wake_delivery (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  -- The event id the receiver sees; it never changes across retries.
  id uuid NOT NULL,
  grant_id uuid NOT NULL,
  type text NOT NULL CHECK (type IN ('signal.fired', 'schedule.due', 'ping')),
  body jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'failed', 'dropped')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  -- The HTTP status of the last attempt, when the receiver answered.
  last_code smallint,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  -- When it was last handed to the queue; a delivery never handed over is handed over again after three minutes.
  queued_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  sent_at timestamptz,
  PRIMARY KEY (org_id, id),
  FOREIGN KEY (org_id, grant_id) REFERENCES crove_kernel.agent_grant (org_id, id) ON DELETE CASCADE,
  CHECK (crove_kernel.mcp_wake_body_ok(body, id, org_id, grant_id, type))
);
CREATE INDEX IF NOT EXISTS agent_wake_delivery_open_idx ON crove_kernel.agent_wake_delivery (queued_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS agent_wake_delivery_grant_idx ON crove_kernel.agent_wake_delivery (org_id, grant_id, created_at DESC);
ALTER TABLE crove_kernel.agent_wake_delivery ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS crove_kernel.agent_wake_signal_seen (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  grant_id uuid NOT NULL,
  -- A rule's short name and the ids it is about, as in a body's item key: nothing a person typed.
  key text NOT NULL CHECK (key ~ '^[a-z]+(_[a-z]+)*(:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}){1,3}$'),
  first_seen_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  last_seen_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  UNIQUE (org_id, grant_id, key),
  FOREIGN KEY (org_id, grant_id) REFERENCES crove_kernel.agent_grant (org_id, id) ON DELETE CASCADE
);
ALTER TABLE crove_kernel.agent_wake_signal_seen ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  r record;
BEGIN
  REVOKE ALL ON crove_kernel.agent_wake_delivery, crove_kernel.agent_wake_signal_seen FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE 'crove\_%' AND rolname <> current_user LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON crove_kernel.agent_wake_delivery, crove_kernel.agent_wake_signal_seen FROM %I', r.rolname);
  END LOOP;
END $$;
SELECT crove_kernel.agent_write_guard_install('crove_kernel.agent_wake_delivery');
SELECT crove_kernel.agent_write_guard_install('crove_kernel.agent_wake_signal_seen');

-- ---------------------------------------------------------------------------
-- The worker's lists (no context: they carry the org). Ids only, never a URL, a secret or a body.
-- ---------------------------------------------------------------------------
-- The wake-ups to look at now: enabled, the grant in good standing, and a schedule that is due or signals not checked for five minutes.
CREATE OR REPLACE FUNCTION crove_kernel.mcp_wake_due(p_limit integer)
RETURNS TABLE (org_id uuid, grant_id uuid, user_id uuid, schedule_due boolean, signals_due boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT w.org_id, w.grant_id, g.user_id,
         (w.schedule <> 'off' AND w.next_due_at IS NOT NULL AND w.next_due_at <= pg_catalog.clock_timestamp()),
         (w.signals_checked_at IS NULL OR w.signals_checked_at <= pg_catalog.clock_timestamp() - interval '5 minutes')
  FROM crove_kernel.agent_grant_wake w
  JOIN crove_kernel.agent_grant g ON g.org_id = w.org_id AND g.id = w.grant_id
  WHERE w.enabled
    AND (
      (w.schedule <> 'off' AND w.next_due_at IS NOT NULL AND w.next_due_at <= pg_catalog.clock_timestamp())
      OR w.signals_checked_at IS NULL OR w.signals_checked_at <= pg_catalog.clock_timestamp() - interval '5 minutes')
    AND crove_kernel.mcp_grant_standing(g.id, g.org_id, g.user_id)
  ORDER BY w.org_id, w.grant_id
  LIMIT GREATEST(1, LEAST(p_limit, 500))
$$;

-- The deliveries that need the queue: never handed over for three minutes ('send'), or still waiting after eight hours, which is longer than the queue's retries
-- last ('expire').
CREATE OR REPLACE FUNCTION crove_kernel.mcp_wake_open(p_limit integer)
RETURNS TABLE (org_id uuid, id uuid, kind text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT d.org_id, d.id,
         CASE WHEN d.created_at <= pg_catalog.clock_timestamp() - interval '8 hours' THEN 'expire' ELSE 'send' END
  FROM crove_kernel.agent_wake_delivery d
  WHERE d.status = 'queued'
    AND (d.created_at <= pg_catalog.clock_timestamp() - interval '8 hours'
         OR (d.attempts = 0 AND d.queued_at <= pg_catalog.clock_timestamp() - interval '3 minutes'))
  ORDER BY d.queued_at, d.id
  LIMIT GREATEST(1, LEAST(p_limit, 500))
$$;

-- One delivery, for the job that sends it: its body is what the receiver gets.
CREATE OR REPLACE FUNCTION crove_kernel.mcp_wake_delivery_get(p_org_id uuid, p_id uuid)
RETURNS TABLE (id uuid, grant_id uuid, type text, body jsonb, status text, attempts integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT d.id, d.grant_id, d.type, d.body, d.status, d.attempts
  FROM crove_kernel.agent_wake_delivery d
  WHERE d.org_id = p_org_id AND d.id = p_id
$$;

-- ---------------------------------------------------------------------------
-- The system's own writes (a system context in an org): refuse any other.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_kernel.mcp_wake_system()
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
BEGIN
  IF v_org IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'system' THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  RETURN v_org;
END $$;

-- Stores a delivery for a grant whose wake-up is enabled and in good standing: false when the id is already stored (a replay). Raises MCP_WAKE_GRANT (22023) when the
-- grant cannot be woken now, and the body's CHECK (23514) for a body that does not fit.
CREATE OR REPLACE FUNCTION crove_kernel.mcp_wake_enqueue(p_id uuid, p_grant_id uuid, p_type text, p_body jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := crove_kernel.mcp_wake_system();
  v_user uuid;
  v_count integer;
BEGIN
  SELECT g.user_id INTO v_user
  FROM crove_kernel.agent_grant_wake w JOIN crove_kernel.agent_grant g ON g.org_id = w.org_id AND g.id = w.grant_id
  WHERE w.org_id = v_org AND w.grant_id = p_grant_id AND w.enabled;
  IF NOT FOUND OR NOT crove_kernel.mcp_grant_standing(p_grant_id, v_org, v_user) THEN
    RAISE EXCEPTION 'MCP_WAKE_GRANT' USING ERRCODE = '22023';
  END IF;
  INSERT INTO crove_kernel.agent_wake_delivery (org_id, id, grant_id, type, body) VALUES (v_org, p_id, p_grant_id, p_type, p_body)
  ON CONFLICT (org_id, id) DO NOTHING;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count = 1;
END $$;

-- Notes that a queued delivery was handed to the queue now.
CREATE OR REPLACE FUNCTION crove_kernel.mcp_wake_touch(p_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := crove_kernel.mcp_wake_system();
  v_count integer;
BEGIN
  UPDATE crove_kernel.agent_wake_delivery d SET queued_at = pg_catalog.clock_timestamp() WHERE d.org_id = v_org AND d.id = p_id AND d.status = 'queued';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count = 1;
END $$;

-- The outcome of one attempt. 'sent': delivered. 'retry': the attempt failed and the queue tries again. 'failed': the last attempt failed. 'dropped': the grant can no longer be
-- woken, so nothing is sent. A failure counts on the wake-up; after seven days of failing the wake-up is paused with the reason. A delivery already settled is left as it is (false).
CREATE OR REPLACE FUNCTION crove_kernel.mcp_wake_record(p_id uuid, p_outcome text, p_code integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := crove_kernel.mcp_wake_system();
  v_grant uuid;
BEGIN
  IF p_outcome IS NULL OR p_outcome NOT IN ('sent', 'retry', 'failed', 'dropped') OR (p_code IS NOT NULL AND p_code NOT BETWEEN 100 AND 599) THEN
    RAISE EXCEPTION 'MCP_WAKE_INVALID' USING ERRCODE = '22023';
  END IF;
  UPDATE crove_kernel.agent_wake_delivery d SET
    status = CASE p_outcome WHEN 'sent' THEN 'sent' WHEN 'failed' THEN 'failed' WHEN 'dropped' THEN 'dropped' ELSE d.status END,
    attempts = d.attempts + CASE WHEN p_outcome = 'dropped' THEN 0 ELSE 1 END,
    last_code = p_code,
    sent_at = CASE WHEN p_outcome = 'sent' THEN pg_catalog.clock_timestamp() ELSE d.sent_at END
  WHERE d.org_id = v_org AND d.id = p_id AND d.status = 'queued'
  RETURNING d.grant_id INTO v_grant;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF p_outcome = 'sent' THEN
    UPDATE crove_kernel.agent_grant_wake w SET last_delivery_at = pg_catalog.clock_timestamp(), last_status = 'sent', consecutive_failures = 0, failing_since = NULL
    WHERE w.org_id = v_org AND w.grant_id = v_grant;
  ELSIF p_outcome IN ('retry', 'failed') THEN
    UPDATE crove_kernel.agent_grant_wake w SET
      last_status = 'failed',
      consecutive_failures = w.consecutive_failures + 1,
      failing_since = COALESCE(w.failing_since, pg_catalog.clock_timestamp())
    WHERE w.org_id = v_org AND w.grant_id = v_grant;
    UPDATE crove_kernel.agent_grant_wake w SET enabled = false, paused_reason = 'failing'
    WHERE w.org_id = v_org AND w.grant_id = v_grant AND w.enabled AND w.failing_since <= pg_catalog.clock_timestamp() - interval '7 days';
  END IF;
  -- The log of a grant's deliveries is kept for 30 days once settled.
  DELETE FROM crove_kernel.agent_wake_delivery d
  WHERE d.org_id = v_org AND d.grant_id = v_grant AND d.status <> 'queued' AND d.created_at < pg_catalog.clock_timestamp() - interval '30 days';
  RETURN true;
END $$;

-- The signal keys a grant's wake-up has seen: stores the keys not seen before and returns them, forgets the keys that are gone (so one that comes back fires again) and notes
-- that the signals were checked now.
CREATE OR REPLACE FUNCTION crove_kernel.mcp_wake_signals_sync(p_grant_id uuid, p_keys text[])
RETURNS text[] LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := crove_kernel.mcp_wake_system();
  v_new text[];
BEGIN
  IF p_keys IS NULL OR pg_catalog.cardinality(p_keys) > 200 THEN
    RAISE EXCEPTION 'MCP_WAKE_INVALID' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM crove_kernel.agent_grant_wake w WHERE w.org_id = v_org AND w.grant_id = p_grant_id) THEN
    RAISE EXCEPTION 'MCP_WAKE_GRANT' USING ERRCODE = '22023';
  END IF;
  DELETE FROM crove_kernel.agent_wake_signal_seen s WHERE s.org_id = v_org AND s.grant_id = p_grant_id AND NOT (s.key = ANY (p_keys));
  UPDATE crove_kernel.agent_wake_signal_seen s SET last_seen_at = pg_catalog.clock_timestamp() WHERE s.org_id = v_org AND s.grant_id = p_grant_id AND s.key = ANY (p_keys);
  WITH ins AS (
    INSERT INTO crove_kernel.agent_wake_signal_seen (org_id, grant_id, key)
    SELECT v_org, p_grant_id, k FROM pg_catalog.unnest(p_keys) AS k
    ON CONFLICT (org_id, grant_id, key) DO NOTHING
    RETURNING key)
  SELECT pg_catalog.array_agg(ins.key ORDER BY ins.key) INTO v_new FROM ins;
  UPDATE crove_kernel.agent_grant_wake w SET signals_checked_at = pg_catalog.clock_timestamp() WHERE w.org_id = v_org AND w.grant_id = p_grant_id;
  RETURN COALESCE(v_new, ARRAY[]::text[]);
END $$;

-- A schedule that is due moves to its next time (counted from now, so a gap sends once and not once per missed day) and returns the Vietnam calendar day it was due, or
-- null when it is not due.
CREATE OR REPLACE FUNCTION crove_kernel.mcp_wake_schedule_advance(p_grant_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := crove_kernel.mcp_wake_system();
  v_row crove_kernel.agent_grant_wake%ROWTYPE;
BEGIN
  SELECT w.* INTO v_row FROM crove_kernel.agent_grant_wake w
  WHERE w.org_id = v_org AND w.grant_id = p_grant_id AND w.enabled AND w.schedule <> 'off' AND w.next_due_at IS NOT NULL AND w.next_due_at <= pg_catalog.clock_timestamp()
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  UPDATE crove_kernel.agent_grant_wake w SET
    next_due_at = crove_kernel.mcp_wake_next_due(v_row.schedule, v_row.schedule_minute, v_row.schedule_weekday, pg_catalog.clock_timestamp()),
    updated_at = pg_catalog.clock_timestamp()
  WHERE w.org_id = v_org AND w.grant_id = p_grant_id;
  RETURN pg_catalog.to_char(v_row.next_due_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD');
END $$;

-- ---------------------------------------------------------------------------
-- Grants: the delivery worker's login alone.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION
  crove_kernel.mcp_wake_body_ok(jsonb, uuid, uuid, uuid, text),
  crove_kernel.mcp_wake_due(integer),
  crove_kernel.mcp_wake_open(integer),
  crove_kernel.mcp_wake_delivery_get(uuid, uuid),
  crove_kernel.mcp_wake_system(),
  crove_kernel.mcp_wake_enqueue(uuid, uuid, text, jsonb),
  crove_kernel.mcp_wake_touch(uuid),
  crove_kernel.mcp_wake_record(uuid, text, integer),
  crove_kernel.mcp_wake_signals_sync(uuid, text[]),
  crove_kernel.mcp_wake_schedule_advance(uuid)
FROM PUBLIC;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE 'crove\_%' AND rolname <> current_user LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON FUNCTION crove_kernel.mcp_wake_body_ok(jsonb, uuid, uuid, uuid, text), crove_kernel.mcp_wake_due(integer), crove_kernel.mcp_wake_open(integer), '
      'crove_kernel.mcp_wake_delivery_get(uuid, uuid), crove_kernel.mcp_wake_system(), crove_kernel.mcp_wake_enqueue(uuid, uuid, text, jsonb), crove_kernel.mcp_wake_touch(uuid), '
      'crove_kernel.mcp_wake_record(uuid, text, integer), crove_kernel.mcp_wake_signals_sync(uuid, text[]), crove_kernel.mcp_wake_schedule_advance(uuid) FROM %I',
      r.rolname);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION
  crove_kernel.mcp_wake_due(integer),
  crove_kernel.mcp_wake_open(integer),
  crove_kernel.mcp_wake_delivery_get(uuid, uuid),
  crove_kernel.mcp_wake_enqueue(uuid, uuid, text, jsonb),
  crove_kernel.mcp_wake_touch(uuid),
  crove_kernel.mcp_wake_record(uuid, text, integer),
  crove_kernel.mcp_wake_signals_sync(uuid, text[]),
  crove_kernel.mcp_wake_schedule_advance(uuid)
TO crove_worker;

-- ---------------------------------------------------------------------------
-- Queues (QUEUES in apps/kernel/src/jobs-schema.ts; create_queue skips existing ones, and both send their dead letters to kernel-job.dlq):
--   kernel-mcp-wake        one delivery to a grant's receiver. 'stately': at most one queued and one active job per delivery, so a handed-over-again delivery is one job.
--   kernel-mcp-wake-sweep  the worker's sweep, every minute: hands over deliveries, advances due schedules, checks signals (apps/kernel/src/mcp-wake.ts).
-- ---------------------------------------------------------------------------
SELECT crove_jobs.create_queue('kernel-mcp-wake', '{"policy":"stately","deadLetter":"kernel-job.dlq"}'::jsonb);
SELECT crove_jobs.create_queue('kernel-mcp-wake-sweep', '{"policy":"standard","deadLetter":"kernel-job.dlq"}'::jsonb);
