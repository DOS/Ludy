-- SPDX-License-Identifier: AGPL-3.0-only
-- ADR-0051 decisions 2 and 4, issue #2975, slice 3, step 3c-2: the wake-up of a member-bound MCP grant.
-- - A member (of any role) sets, rotates, clears and tests the wake-up of their OWN member-bound grant, and of nothing else. Another member's grant is not found for
--   anyone, owners and admins included (the receiver is that person's); a company grant stays the owners' and admins'.
-- - What an owner or admin reads of another member's wake-up is the receiver's host and no more (`https://host`, no path: the path can carry a token). A non-admin reads
--   only their own. Cutting one off is revoking the grant, which already ends delivery.
-- - A member-bound grant gets no signal: its wake-up is a schedule and a ping, which carry a date or nothing. mcp_wake_due never asks for its signals and
--   mcp_wake_enqueue refuses a signal event for it, so no id of business data can leave for a receiver that only reads what a member reads.
-- - Rates, kept in the database: a grant rotates its secret once a minute at most, and sends at most ten pings an hour (besides the one a minute that was already there).
-- Same signatures everywhere (CREATE OR REPLACE), so every earlier file stays re-appliable.

-- ---------------------------------------------------------------------------
-- The member of the org in context: any role, the org active and not stopped, the account enabled. Raises NO_CONTEXT or MCP_FORBIDDEN (42501).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_kernel.mcp_wake_member_ctx()
RETURNS TABLE (user_id uuid, is_admin boolean) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_user uuid := crove_kernel.ctx_user_id();
  v_role text;
BEGIN
  IF v_org IS NULL OR v_user IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  SELECT m.role INTO v_role
  FROM crove_kernel.tenant_member m
  JOIN crove_kernel.tenant t ON t.org_id = m.org_id AND t.status = 'active'
  JOIN crove_kernel.user_account u ON u.id = m.user_id AND u.disabled_at IS NULL
  WHERE m.org_id = v_org AND m.user_id = v_user;
  IF NOT FOUND OR crove_kernel.global_kill_switch_on('ai') OR EXISTS (
    SELECT 1 FROM crove_kernel.kill_switch k WHERE k.org_id = v_org AND k.scope = 'org' AND k.released_at IS NULL
  ) THEN
    RAISE EXCEPTION 'MCP_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  user_id := v_user;
  is_admin := v_role IN ('owner', 'admin');
  RETURN NEXT;
END $$;

-- ---------------------------------------------------------------------------
-- The right to act on the wake-up of one grant. Returns the caller's user id, or raises:
--   MCP_WAKE_GRANT (22023): a member-bound grant that is not the caller's (the same answer for an owner or admin), or a grant that is not in the org for a non-admin;
--   MCP_FORBIDDEN (42501): a company grant, for a caller who is not an owner or admin.
-- A grant that is not in the org passes an owner or admin through, as before: the function that called this answers for it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_kernel.mcp_wake_gate(p_grant_id uuid)
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_user uuid;
  v_admin boolean;
  v_kind text;
  v_member uuid;
BEGIN
  SELECT c.user_id, c.is_admin INTO v_user, v_admin FROM crove_kernel.mcp_wake_member_ctx() c;
  SELECT g.kind, g.member_id INTO v_kind, v_member FROM crove_kernel.agent_grant g WHERE g.org_id = v_org AND g.id = p_grant_id;
  IF NOT FOUND THEN
    IF v_admin THEN
      RETURN v_user;
    END IF;
    RAISE EXCEPTION 'MCP_WAKE_GRANT' USING ERRCODE = '22023';
  END IF;
  IF v_kind = 'member' THEN
    IF v_member IS DISTINCT FROM v_user THEN
      RAISE EXCEPTION 'MCP_WAKE_GRANT' USING ERRCODE = '22023';
    END IF;
  ELSIF NOT v_admin THEN
    RAISE EXCEPTION 'MCP_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN v_user;
END $$;

-- ---------------------------------------------------------------------------
-- put, rotate, clear, get: the gate above in place of the owner-or-admin check; rotate with its rate.
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
  v_user := crove_kernel.mcp_wake_gate(p_grant_id);
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

CREATE OR REPLACE FUNCTION crove_kernel.mcp_wake_rotate(p_grant_id uuid, p_sealed jsonb, p_hint text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_grant_user uuid;
  v_count integer;
BEGIN
  PERFORM crove_kernel.mcp_wake_gate(p_grant_id);
  SELECT g.user_id INTO v_grant_user FROM crove_kernel.agent_grant g WHERE g.org_id = v_org AND g.id = p_grant_id;
  IF NOT FOUND OR NOT crove_kernel.mcp_grant_standing(p_grant_id, v_org, v_grant_user) THEN
    RAISE EXCEPTION 'MCP_WAKE_GRANT' USING ERRCODE = '22023';
  END IF;
  IF p_sealed IS NULL OR pg_catalog.jsonb_typeof(p_sealed) <> 'object' OR p_hint IS NULL OR p_hint !~ '^whk_[0-9a-f]{8}$' THEN
    RAISE EXCEPTION 'MCP_WAKE_INVALID' USING ERRCODE = '22023';
  END IF;
  -- Once a minute at most: a rotation keeps the old secret for 24 hours, so one made less than a minute ago left previous_until in its last minute.
  IF EXISTS (
    SELECT 1 FROM crove_kernel.agent_grant_wake w
    WHERE w.org_id = v_org AND w.grant_id = p_grant_id AND w.previous_until > pg_catalog.clock_timestamp() + interval '23 hours 59 minutes'
  ) THEN
    RAISE EXCEPTION 'MCP_WAKE_TOO_SOON' USING ERRCODE = '22023';
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

CREATE OR REPLACE FUNCTION crove_kernel.mcp_wake_clear(p_grant_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_count integer;
BEGIN
  PERFORM crove_kernel.mcp_wake_gate(p_grant_id);
  DELETE FROM crove_kernel.agent_grant_wake w WHERE w.org_id = crove_kernel.ctx_org_id() AND w.grant_id = p_grant_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count = 1;
END $$;

-- What the caller may see: an owner or admin, the org's company wake-ups in full and, for a member-bound grant that is not theirs, the receiver's host only; a non-admin,
-- their own member-bound grant's, in full. Never a secret.
CREATE OR REPLACE FUNCTION crove_kernel.mcp_wake_get(p_grant_id uuid)
RETURNS TABLE (grant_id uuid, url text, enabled boolean, paused_reason text, secret_hint text, previous_until timestamptz, schedule text, schedule_minute smallint,
               schedule_weekday smallint, next_due_at timestamptz, failing_since timestamptz, consecutive_failures integer, last_delivery_at timestamptz, last_status text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_user uuid;
  v_admin boolean;
BEGIN
  SELECT c.user_id, c.is_admin INTO v_user, v_admin FROM crove_kernel.mcp_wake_member_ctx() c;
  RETURN QUERY
    SELECT w.grant_id,
           CASE WHEN g.kind = 'member' AND g.member_id IS DISTINCT FROM v_user
                THEN 'https://' || COALESCE(pg_catalog.substring(w.url, '^https://([^/:]+)'), '')
                ELSE w.url END,
           w.enabled, w.paused_reason, w.secret_hint, w.previous_until, w.schedule, w.schedule_minute, w.schedule_weekday, w.next_due_at,
           w.failing_since, w.consecutive_failures, w.last_delivery_at, w.last_status
    FROM crove_kernel.agent_grant_wake w
    JOIN crove_kernel.agent_grant g ON g.org_id = w.org_id AND g.id = w.grant_id
    WHERE w.org_id = crove_kernel.ctx_org_id() AND (p_grant_id IS NULL OR w.grant_id = p_grant_id)
      AND (v_admin OR (g.kind = 'member' AND g.member_id = v_user))
    ORDER BY w.created_at, w.id;
END $$;

-- ---------------------------------------------------------------------------
-- test: the gate, and at most ten pings an hour per grant besides the one a minute.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_kernel.mcp_wake_test(p_grant_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_grant_user uuid;
  v_id uuid := crove_kernel.uuid_v7();
BEGIN
  PERFORM crove_kernel.mcp_wake_gate(p_grant_id);
  SELECT g.user_id INTO v_grant_user
  FROM crove_kernel.agent_grant_wake w JOIN crove_kernel.agent_grant g ON g.org_id = w.org_id AND g.id = w.grant_id
  WHERE w.org_id = v_org AND w.grant_id = p_grant_id AND w.enabled;
  IF NOT FOUND OR NOT crove_kernel.mcp_grant_standing(p_grant_id, v_org, v_grant_user) THEN
    RAISE EXCEPTION 'MCP_WAKE_GRANT' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM crove_kernel.agent_grant_wake w WHERE w.org_id = v_org AND w.grant_id = p_grant_id FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM crove_kernel.agent_wake_delivery d
    WHERE d.org_id = v_org AND d.grant_id = p_grant_id AND d.type = 'ping' AND d.created_at > pg_catalog.clock_timestamp() - interval '1 minute'
  ) OR (
    SELECT pg_catalog.count(*) FROM crove_kernel.agent_wake_delivery d
    WHERE d.org_id = v_org AND d.grant_id = p_grant_id AND d.type = 'ping' AND d.created_at > pg_catalog.clock_timestamp() - interval '1 hour'
  ) >= 10 THEN
    RAISE EXCEPTION 'MCP_WAKE_TOO_SOON' USING ERRCODE = '22023';
  END IF;
  INSERT INTO crove_kernel.agent_wake_delivery (org_id, id, grant_id, type, body, queued_at)
  VALUES (
    v_org, v_id, p_grant_id, 'ping',
    pg_catalog.jsonb_build_object(
      'id', v_id, 'type', 'ping',
      'created_at', pg_catalog.to_char(pg_catalog.clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'org', v_org, 'grant', p_grant_id, 'data', '{}'::jsonb),
    pg_catalog.clock_timestamp() - interval '3 minutes'
  );
  RETURN v_id;
END $$;

-- ---------------------------------------------------------------------------
-- The delivery side: a member-bound grant is asked for no signals, and a signal event for one is refused.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_kernel.mcp_wake_due(p_limit integer)
RETURNS TABLE (org_id uuid, grant_id uuid, user_id uuid, schedule_due boolean, due_day text, signals_due boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT w.org_id, w.grant_id, g.user_id,
         (w.schedule <> 'off' AND w.next_due_at IS NOT NULL AND w.next_due_at <= pg_catalog.clock_timestamp()) AS schedule_due,
         CASE WHEN w.schedule <> 'off' AND w.next_due_at IS NOT NULL AND w.next_due_at <= pg_catalog.clock_timestamp()
              THEN pg_catalog.to_char(w.next_due_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD') END AS due_day,
         (g.kind <> 'member' AND (w.signals_checked_at IS NULL OR w.signals_checked_at <= pg_catalog.clock_timestamp() - interval '5 minutes')) AS signals_due
  FROM crove_kernel.agent_grant_wake w
  JOIN crove_kernel.agent_grant g ON g.org_id = w.org_id AND g.id = w.grant_id
  WHERE w.enabled
    AND (
      (w.schedule <> 'off' AND w.next_due_at IS NOT NULL AND w.next_due_at <= pg_catalog.clock_timestamp())
      OR (g.kind <> 'member' AND (w.signals_checked_at IS NULL OR w.signals_checked_at <= pg_catalog.clock_timestamp() - interval '5 minutes')))
    AND crove_kernel.mcp_grant_standing(g.id, g.org_id, g.user_id)
  ORDER BY (w.schedule <> 'off' AND w.next_due_at IS NOT NULL AND w.next_due_at <= pg_catalog.clock_timestamp()) DESC, w.org_id, w.grant_id
  LIMIT GREATEST(1, LEAST(p_limit, 500))
$$;

CREATE OR REPLACE FUNCTION crove_kernel.mcp_wake_enqueue(p_id uuid, p_grant_id uuid, p_type text, p_body jsonb, p_keys text[])
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := crove_kernel.mcp_wake_system();
  v_user uuid;
  v_kind text;
  v_row crove_kernel.agent_grant_wake%ROWTYPE;
  v_count integer;
BEGIN
  SELECT g.user_id, g.kind INTO v_user, v_kind
  FROM crove_kernel.agent_grant_wake w JOIN crove_kernel.agent_grant g ON g.org_id = w.org_id AND g.id = w.grant_id
  WHERE w.org_id = v_org AND w.grant_id = p_grant_id AND w.enabled;
  IF NOT FOUND OR NOT crove_kernel.mcp_grant_standing(p_grant_id, v_org, v_user) THEN
    RAISE EXCEPTION 'MCP_WAKE_GRANT' USING ERRCODE = '22023';
  END IF;
  IF p_type = 'signal.fired' AND v_kind = 'member' THEN
    RAISE EXCEPTION 'MCP_WAKE_INVALID' USING ERRCODE = '22023';
  END IF;
  IF p_keys IS NOT NULL AND (p_type <> 'signal.fired' OR pg_catalog.cardinality(p_keys) > 20) THEN
    RAISE EXCEPTION 'MCP_WAKE_INVALID' USING ERRCODE = '22023';
  END IF;
  IF p_type = 'schedule.due' THEN
    SELECT w.* INTO v_row FROM crove_kernel.agent_grant_wake w
    WHERE w.org_id = v_org AND w.grant_id = p_grant_id AND w.schedule <> 'off' AND w.next_due_at IS NOT NULL AND w.next_due_at <= pg_catalog.clock_timestamp()
    FOR UPDATE;
    IF NOT FOUND THEN
      RETURN false;
    END IF;
  END IF;
  INSERT INTO crove_kernel.agent_wake_delivery (org_id, id, grant_id, type, body) VALUES (v_org, p_id, p_grant_id, p_type, p_body)
  ON CONFLICT (org_id, id) DO NOTHING;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count = 0 THEN
    RETURN false;
  END IF;
  IF p_type = 'schedule.due' THEN
    UPDATE crove_kernel.agent_grant_wake w SET
      next_due_at = crove_kernel.mcp_wake_next_due(v_row.schedule, v_row.schedule_minute, v_row.schedule_weekday, pg_catalog.clock_timestamp()),
      updated_at = pg_catalog.clock_timestamp()
    WHERE w.org_id = v_org AND w.grant_id = p_grant_id;
  ELSIF p_keys IS NOT NULL THEN
    INSERT INTO crove_kernel.agent_wake_signal_seen (org_id, grant_id, key) SELECT v_org, p_grant_id, k FROM pg_catalog.unnest(p_keys) AS k
    ON CONFLICT (org_id, grant_id, key) DO NOTHING;
  END IF;
  RETURN true;
END $$;

-- ---------------------------------------------------------------------------
-- Grants: the two new helpers to the API's login alone, nothing to PUBLIC or any other login. The replaced functions keep theirs (CREATE OR REPLACE keeps the ACL).
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION crove_kernel.mcp_wake_member_ctx(), crove_kernel.mcp_wake_gate(uuid) FROM PUBLIC;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE 'crove\_%' AND rolname <> current_user LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION crove_kernel.mcp_wake_member_ctx(), crove_kernel.mcp_wake_gate(uuid) FROM %I', r.rolname);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION crove_kernel.mcp_wake_member_ctx(), crove_kernel.mcp_wake_gate(uuid) TO crove_app;
