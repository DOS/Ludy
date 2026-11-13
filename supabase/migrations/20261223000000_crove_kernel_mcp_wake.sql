-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove kernel (issue #3024, ADR-0051 decision 4): the wake-up webhook's setup, step (a). One HTTPS receiver per MCP grant, its sealed secret and an org-set schedule.
-- Nothing here sends anything: the delivery (the queue, the signed request) is the next step. Idempotent; applied files stay untouched.
--
-- - crove_kernel.agent_grant_wake is definer-only, like agent_grant: no login role reads or writes it, so the sealed secret is reachable by nothing but the
--   definers below. The secret is sealed by the API with the credential broker before it gets here (binding: org, grant, purpose); the database never sees it in the clear.
-- - mcp_wake_put / mcp_wake_rotate / mcp_wake_clear / mcp_wake_get: an owner or admin of the org in context, for a grant that is live and in good standing. The grant's
--   consenting user keeps the right they had; the URL is checked again here (https, a name, port 443 only), as the API checked it with a lookup first.
-- - mcp_wake_target: the delivery worker's one read. It answers only while the grant is live, the org is active and not stopped, the consenting user is still an owner or
--   admin and the wake-up is enabled, so a revoked or expired grant, a removed member or a stopped org ends the very next attempt.
-- The URL can carry a token in its path, so it is read back only by owner and admin, never copied into an audit row, an event or a log.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_kernel.agent_grant_wake (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  grant_id uuid NOT NULL,
  url text NOT NULL CHECK (pg_catalog.char_length(url) BETWEEN 12 AND 2048 AND url ~ '^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:443)?(/[^[:space:]#]*)?$' AND url !~ '^https://[0-9.]+(:|/|$)'),
  enabled boolean NOT NULL DEFAULT true,
  paused_reason text CHECK (paused_reason IS NULL OR paused_reason = 'failing'),
  -- The secret as the credential broker sealed it ({keyId, envelope}), and the one it replaced while a rotation overlaps.
  secret_sealed jsonb NOT NULL CHECK (pg_catalog.jsonb_typeof(secret_sealed) = 'object' AND pg_catalog.pg_column_size(secret_sealed) <= 4096),
  previous_sealed jsonb CHECK (previous_sealed IS NULL OR (pg_catalog.jsonb_typeof(previous_sealed) = 'object' AND pg_catalog.pg_column_size(previous_sealed) <= 4096)),
  previous_until timestamptz,
  -- The public id the receiver can see beside the secret ("whk_" and eight hex digits): enough to tell which secret signed, never enough to sign.
  secret_hint text NOT NULL CHECK (secret_hint ~ '^whk_[0-9a-f]{8}$'),
  schedule text NOT NULL DEFAULT 'off' CHECK (schedule IN ('off', 'daily', 'weekly')),
  -- Minutes after midnight in Vietnam time, and the ISO weekday (1 Monday to 7 Sunday).
  schedule_minute smallint CHECK (schedule_minute BETWEEN 0 AND 1439),
  schedule_weekday smallint CHECK (schedule_weekday BETWEEN 1 AND 7),
  next_due_at timestamptz,
  failing_since timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  last_delivery_at timestamptz,
  last_status text CHECK (last_status IS NULL OR last_status IN ('sent', 'failed')),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  created_by uuid NOT NULL,
  PRIMARY KEY (org_id, id),
  UNIQUE (org_id, grant_id),
  FOREIGN KEY (org_id, grant_id) REFERENCES crove_kernel.agent_grant (org_id, id) ON DELETE CASCADE,
  CHECK (schedule = 'off' OR schedule_minute IS NOT NULL),
  CHECK (schedule <> 'weekly' OR schedule_weekday IS NOT NULL),
  CHECK ((previous_sealed IS NULL) = (previous_until IS NULL))
);
ALTER TABLE crove_kernel.agent_grant_wake ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  r record;
BEGIN
  REVOKE ALL ON crove_kernel.agent_grant_wake FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE 'crove\_%' AND rolname <> current_user LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON crove_kernel.agent_grant_wake FROM %I', r.rolname);
  END LOOP;
END $$;
-- Definer-only tables skip apply_tenant_rls, which installs the agent write guard (#285) on tenant tables; an agent context never sets up a wake-up.
SELECT crove_kernel.agent_write_guard_install('crove_kernel.agent_grant_wake');

-- ---------------------------------------------------------------------------
-- The next time a schedule is due, in Vietnam time (no daylight saving): the first matching time after p_from.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_kernel.mcp_wake_next_due(p_schedule text, p_minute smallint, p_weekday smallint, p_from timestamptz)
RETURNS timestamptz LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_local timestamp := p_from AT TIME ZONE 'Asia/Ho_Chi_Minh';
  v_at timestamp;
BEGIN
  IF p_schedule IS NULL OR p_schedule = 'off' OR p_minute IS NULL THEN
    RETURN NULL;
  END IF;
  v_at := pg_catalog.date_trunc('day', v_local) + p_minute * interval '1 minute';
  IF p_schedule = 'daily' THEN
    IF v_at <= v_local THEN
      v_at := v_at + interval '1 day';
    END IF;
  ELSIF p_schedule = 'weekly' AND p_weekday IS NOT NULL THEN
    WHILE v_at <= v_local OR pg_catalog.date_part('isodow', v_at)::integer <> p_weekday LOOP
      v_at := v_at + interval '1 day';
    END LOOP;
  ELSE
    RETURN NULL;
  END IF;
  RETURN v_at AT TIME ZONE 'Asia/Ho_Chi_Minh';
END $$;

-- ---------------------------------------------------------------------------
-- The caller: an owner or admin of an active org in context, with a user context, not stopped. Raises NO_CONTEXT (42501) or MCP_FORBIDDEN (42501).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_kernel.mcp_wake_caller()
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_user uuid := crove_kernel.ctx_user_id();
BEGIN
  IF v_org IS NULL OR v_user IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM crove_kernel.tenant_member m
    JOIN crove_kernel.tenant t ON t.org_id = m.org_id AND t.status = 'active'
    JOIN crove_kernel.user_account u ON u.id = m.user_id AND u.disabled_at IS NULL
    WHERE m.org_id = v_org AND m.user_id = v_user AND m.role IN ('owner', 'admin')
  ) OR crove_kernel.global_kill_switch_on('ai') OR EXISTS (
    SELECT 1 FROM crove_kernel.kill_switch k WHERE k.org_id = v_org AND k.scope = 'org' AND k.released_at IS NULL
  ) THEN
    RAISE EXCEPTION 'MCP_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN v_user;
END $$;

-- ---------------------------------------------------------------------------
-- mcp_wake_put: set or change the receiver and the schedule of a grant. A new wake-up keeps the sealed secret it is given; an existing one keeps its own
-- (a rotation is its own call), and the sealed secret given with a change is dropped. Returns whether the row is new. Raises MCP_WAKE_GRANT (22023) for
-- a grant that is not live in this org, MCP_WAKE_INVALID (22023) for a URL or schedule that does not fit.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_kernel.mcp_wake_put(
  p_grant_id uuid, p_url text, p_sealed jsonb, p_hint text, p_schedule text, p_minute smallint, p_weekday smallint, p_enabled boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_user uuid;
  v_grant_user uuid;
  v_new boolean;
BEGIN
  v_user := crove_kernel.mcp_wake_caller();
  SELECT g.user_id INTO v_grant_user FROM crove_kernel.agent_grant g WHERE g.org_id = v_org AND g.id = p_grant_id;
  IF NOT FOUND OR NOT crove_kernel.mcp_grant_standing(p_grant_id, v_org, v_grant_user) THEN
    RAISE EXCEPTION 'MCP_WAKE_GRANT' USING ERRCODE = '22023';
  END IF;
  IF p_url IS NULL OR p_url !~ '^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:443)?(/[^[:space:]#]*)?$' OR p_url ~ '^https://[0-9.]+(:|/|$)'
     OR pg_catalog.char_length(p_url) NOT BETWEEN 12 AND 2048
     OR p_sealed IS NULL OR pg_catalog.jsonb_typeof(p_sealed) <> 'object'
     OR p_hint IS NULL OR p_hint !~ '^whk_[0-9a-f]{8}$'
     OR p_schedule IS NULL OR p_schedule NOT IN ('off', 'daily', 'weekly')
     OR (p_schedule <> 'off' AND (p_minute IS NULL OR p_minute NOT BETWEEN 0 AND 1439))
     OR (p_schedule = 'weekly' AND (p_weekday IS NULL OR p_weekday NOT BETWEEN 1 AND 7))
     OR p_enabled IS NULL THEN
    RAISE EXCEPTION 'MCP_WAKE_INVALID' USING ERRCODE = '22023';
  END IF;
  INSERT INTO crove_kernel.agent_grant_wake AS w (org_id, grant_id, url, enabled, secret_sealed, secret_hint, schedule, schedule_minute, schedule_weekday, next_due_at, created_by)
  VALUES (v_org, p_grant_id, p_url, p_enabled, p_sealed, p_hint, p_schedule,
          CASE WHEN p_schedule = 'off' THEN NULL ELSE p_minute END,
          CASE WHEN p_schedule = 'weekly' THEN p_weekday ELSE NULL END,
          crove_kernel.mcp_wake_next_due(p_schedule, p_minute, p_weekday, pg_catalog.clock_timestamp()), v_user)
  ON CONFLICT (org_id, grant_id) DO UPDATE SET
    url = EXCLUDED.url,
    enabled = EXCLUDED.enabled,
    -- Switching it on again by hand clears a pause and the count of failures that caused it.
    paused_reason = CASE WHEN EXCLUDED.enabled THEN NULL ELSE w.paused_reason END,
    failing_since = CASE WHEN EXCLUDED.enabled THEN NULL ELSE w.failing_since END,
    consecutive_failures = CASE WHEN EXCLUDED.enabled THEN 0 ELSE w.consecutive_failures END,
    schedule = EXCLUDED.schedule,
    schedule_minute = EXCLUDED.schedule_minute,
    schedule_weekday = EXCLUDED.schedule_weekday,
    next_due_at = EXCLUDED.next_due_at,
    updated_at = pg_catalog.clock_timestamp()
  RETURNING (xmax = 0) INTO v_new;
  RETURN v_new;
END $$;

-- ---------------------------------------------------------------------------
-- mcp_wake_rotate: a new sealed secret; the one it replaces still signs for 24 hours (the delivery signs with both). false when the grant has no wake-up.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_kernel.mcp_wake_rotate(p_grant_id uuid, p_sealed jsonb, p_hint text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_grant_user uuid;
  v_count integer;
BEGIN
  PERFORM crove_kernel.mcp_wake_caller();
  SELECT g.user_id INTO v_grant_user FROM crove_kernel.agent_grant g WHERE g.org_id = v_org AND g.id = p_grant_id;
  IF NOT FOUND OR NOT crove_kernel.mcp_grant_standing(p_grant_id, v_org, v_grant_user) THEN
    RAISE EXCEPTION 'MCP_WAKE_GRANT' USING ERRCODE = '22023';
  END IF;
  IF p_sealed IS NULL OR pg_catalog.jsonb_typeof(p_sealed) <> 'object' OR p_hint IS NULL OR p_hint !~ '^whk_[0-9a-f]{8}$' THEN
    RAISE EXCEPTION 'MCP_WAKE_INVALID' USING ERRCODE = '22023';
  END IF;
  UPDATE crove_kernel.agent_grant_wake w SET
    previous_sealed = w.secret_sealed,
    previous_until = pg_catalog.clock_timestamp() + interval '24 hours',
    secret_sealed = p_sealed,
    secret_hint = p_hint,
    updated_at = pg_catalog.clock_timestamp()
  WHERE w.org_id = v_org AND w.grant_id = p_grant_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count = 1;
END $$;

-- ---------------------------------------------------------------------------
-- mcp_wake_clear: removes the receiver, the secrets and the schedule of a grant. true when there was one.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_kernel.mcp_wake_clear(p_grant_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_count integer;
BEGIN
  PERFORM crove_kernel.mcp_wake_caller();
  DELETE FROM crove_kernel.agent_grant_wake w WHERE w.org_id = crove_kernel.ctx_org_id() AND w.grant_id = p_grant_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count = 1;
END $$;

-- ---------------------------------------------------------------------------
-- mcp_wake_get: what an owner or admin sees of the org's wake-ups (one grant, or all): everything but the secrets. The URL is read back so it can be shown and
-- changed; it is for these two roles only.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_kernel.mcp_wake_get(p_grant_id uuid)
RETURNS TABLE (grant_id uuid, url text, enabled boolean, paused_reason text, secret_hint text, previous_until timestamptz, schedule text, schedule_minute smallint,
               schedule_weekday smallint, next_due_at timestamptz, failing_since timestamptz, consecutive_failures integer, last_delivery_at timestamptz, last_status text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
BEGIN
  PERFORM crove_kernel.mcp_wake_caller();
  RETURN QUERY
    SELECT w.grant_id, w.url, w.enabled, w.paused_reason, w.secret_hint, w.previous_until, w.schedule, w.schedule_minute, w.schedule_weekday, w.next_due_at,
           w.failing_since, w.consecutive_failures, w.last_delivery_at, w.last_status
    FROM crove_kernel.agent_grant_wake w
    WHERE w.org_id = crove_kernel.ctx_org_id() AND (p_grant_id IS NULL OR w.grant_id = p_grant_id)
    ORDER BY w.created_at, w.id;
END $$;

-- ---------------------------------------------------------------------------
-- mcp_wake_target: the delivery worker's read, across orgs (it carries the org). One row while the wake-up is enabled and the grant is in good standing now:
-- live, not expired, the org active and not stopped, the consenting user still an owner or admin. The previous secret is returned only while its overlap lasts.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_kernel.mcp_wake_target(p_org_id uuid, p_grant_id uuid)
RETURNS TABLE (url text, secret_sealed jsonb, previous_sealed jsonb, previous_until timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT w.url, w.secret_sealed,
         CASE WHEN w.previous_until > pg_catalog.clock_timestamp() THEN w.previous_sealed END,
         CASE WHEN w.previous_until > pg_catalog.clock_timestamp() THEN w.previous_until END
  FROM crove_kernel.agent_grant_wake w
  JOIN crove_kernel.agent_grant g ON g.org_id = w.org_id AND g.id = w.grant_id
  WHERE w.org_id = p_org_id AND w.grant_id = p_grant_id AND w.enabled
    AND crove_kernel.mcp_grant_standing(g.id, g.org_id, g.user_id)
$$;

-- ---------------------------------------------------------------------------
-- Grants: the setup functions to the API's login; the target to the worker's alone. Nothing to PUBLIC or to any other login.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION
  crove_kernel.mcp_wake_next_due(text, smallint, smallint, timestamptz),
  crove_kernel.mcp_wake_caller(),
  crove_kernel.mcp_wake_put(uuid, text, jsonb, text, text, smallint, smallint, boolean),
  crove_kernel.mcp_wake_rotate(uuid, jsonb, text),
  crove_kernel.mcp_wake_clear(uuid),
  crove_kernel.mcp_wake_get(uuid),
  crove_kernel.mcp_wake_target(uuid, uuid)
FROM PUBLIC;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE 'crove\_%' AND rolname <> current_user LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON FUNCTION crove_kernel.mcp_wake_next_due(text, smallint, smallint, timestamptz), crove_kernel.mcp_wake_caller(), '
      'crove_kernel.mcp_wake_put(uuid, text, jsonb, text, text, smallint, smallint, boolean), crove_kernel.mcp_wake_rotate(uuid, jsonb, text), '
      'crove_kernel.mcp_wake_clear(uuid), crove_kernel.mcp_wake_get(uuid), crove_kernel.mcp_wake_target(uuid, uuid) FROM %I',
      r.rolname);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION
  crove_kernel.mcp_wake_put(uuid, text, jsonb, text, text, smallint, smallint, boolean),
  crove_kernel.mcp_wake_rotate(uuid, jsonb, text),
  crove_kernel.mcp_wake_clear(uuid),
  crove_kernel.mcp_wake_get(uuid)
TO crove_app;
GRANT EXECUTE ON FUNCTION crove_kernel.mcp_wake_target(uuid, uuid) TO crove_worker;
