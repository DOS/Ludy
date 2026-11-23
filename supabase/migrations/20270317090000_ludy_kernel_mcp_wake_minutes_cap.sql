-- SPDX-License-Identifier: AGPL-3.0-only
-- Ludy kernel (issue #4535, from the independent security review of #3824): a cap on the minutes wake-up. `meetings.minutes_published` had no per-grant or per-org limit: a member who is the
-- recorder of an org-visible meeting can save and publish its minutes in a loop (no AI, no budget), and every publish stores one signed delivery for each company grant of the org, each a POST to
-- the org's receiver with retries and an agent run on the owner's spend. Only an id and an instant leave, so this is cost and noise, not a leak.
-- mcp_wake_enqueue is restated whole from 20270209120000 (as the rebrand of schemas, 20270315090000, left it: `ludy_kernel` names), with one block added for this type: per grant, over the last hour, at
-- most 3 wakes for the same meeting (the first publish and two corrections, so the rule "a second publish wakes each grant once more" of the minutes invariant still holds) and at most 60 for all meetings.
-- A wake over the cap stores nothing and answers false, which the worker already treats as nothing to send. One enqueue at a time per grant (the grant's wake row is locked, as the test ping does).
-- The index agent_wake_delivery_grant_idx (org_id, grant_id, created_at DESC) serves the count. Idempotent; applied files stay untouched; grants of the function are kept by CREATE OR REPLACE.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION ludy_kernel.mcp_wake_enqueue(p_id uuid, p_grant_id uuid, p_type text, p_body jsonb, p_keys text[])
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := ludy_kernel.mcp_wake_system();
  v_user uuid;
  v_kind text;
  v_scopes text[];
  v_scope text;
  v_row ludy_kernel.agent_grant_wake%ROWTYPE;
  v_count integer;
  v_hour integer;
  v_same integer;
  v_meeting text;
BEGIN
  SELECT g.user_id, g.kind, g.scopes INTO v_user, v_kind, v_scopes
  FROM ludy_kernel.agent_grant_wake w JOIN ludy_kernel.agent_grant g ON g.org_id = w.org_id AND g.id = w.grant_id
  WHERE w.org_id = v_org AND w.grant_id = p_grant_id AND w.enabled;
  IF NOT FOUND OR NOT ludy_kernel.mcp_grant_standing(p_grant_id, v_org, v_user) THEN
    RAISE EXCEPTION 'MCP_WAKE_GRANT' USING ERRCODE = '22023';
  END IF;
  -- A member-bound grant gets no signal and no minutes event: no id of business data leaves for a receiver that only reads what a member reads (the hold of 2026-11-13).
  IF p_type IN ('signal.fired', 'meetings.minutes_published') AND v_kind = 'member' THEN
    RAISE EXCEPTION 'MCP_WAKE_INVALID' USING ERRCODE = '22023';
  END IF;
  -- An event of a line's own type goes only to a company grant that holds the line's write scope (with the read scope, as every write scope comes): a member-bound grant, a grant of another line and a read-only
  -- grant are refused, so no id of the line's data leaves for a receiver that may not read it.
  IF p_type NOT IN ('signal.fired', 'schedule.due', 'ping', 'meetings.minutes_published') THEN
    SELECT t.scope INTO v_scope FROM ludy_kernel.mcp_wake_event_type t WHERE t.type = p_type;
    IF NOT FOUND OR v_kind <> 'company' OR NOT (v_scope = ANY (v_scopes)) OR NOT ('ludy.read' = ANY (v_scopes)) THEN
      RAISE EXCEPTION 'MCP_WAKE_SCOPE' USING ERRCODE = '22023';
    END IF;
  END IF;
  IF p_keys IS NOT NULL AND pg_catalog.cardinality(p_keys) > 20 THEN
    RAISE EXCEPTION 'MCP_WAKE_INVALID' USING ERRCODE = '22023';
  END IF;
  IF p_keys IS NOT NULL AND p_type IN ('schedule.due', 'ping', 'meetings.minutes_published') THEN
    RAISE EXCEPTION 'MCP_WAKE_INVALID' USING ERRCODE = '22023';
  END IF;
  -- A line event carries exactly one key, the type's own name (dots as underscores), an item and the day of its window: the item's "seen" rule, kept with the event.
  IF p_keys IS NOT NULL AND p_type NOT IN ('signal.fired', 'schedule.due', 'ping', 'meetings.minutes_published')
     AND (pg_catalog.cardinality(p_keys) <> 1 OR p_keys[1] IS NULL
          OR p_keys[1] !~ ('^' || pg_catalog.replace(p_type, '.', '_') || '(:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}){1,3}:[0-9]{4}-[0-9]{2}-[0-9]{2}$')) THEN
    RAISE EXCEPTION 'MCP_WAKE_INVALID' USING ERRCODE = '22023';
  END IF;
  IF p_type = 'schedule.due' THEN
    SELECT w.* INTO v_row FROM ludy_kernel.agent_grant_wake w
    WHERE w.org_id = v_org AND w.grant_id = p_grant_id AND w.schedule <> 'off' AND w.next_due_at IS NOT NULL AND w.next_due_at <= pg_catalog.clock_timestamp()
    FOR UPDATE;
    IF NOT FOUND THEN
      RETURN false;
    END IF;
  END IF;
  -- The line's key first: a key already seen stores nothing, whatever two sweeps did at the same time.
  IF p_keys IS NOT NULL AND p_type NOT IN ('signal.fired', 'schedule.due', 'ping', 'meetings.minutes_published') THEN
    INSERT INTO ludy_kernel.agent_wake_signal_seen (org_id, grant_id, key) VALUES (v_org, p_grant_id, p_keys[1])
    ON CONFLICT (org_id, grant_id, key) DO NOTHING;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    IF v_count = 0 THEN
      RETURN false;
    END IF;
  END IF;
  -- The minutes event is capped, so a member who publishes the minutes of a meeting again and again (a draft saved and published in a loop costs nothing) cannot make every company grant's agent
  -- run, and the owner pay for it, once per publish (#4535). Per grant, over the last hour: at most 3 wakes for one meeting (its first publish and two corrections) and at most 60 for all meetings.
  -- A wake over the cap stores nothing and answers false, as a retry of a stored one does: it is a nudge, and the agent reads the current minutes through the tool when it acts. One enqueue at a time per
  -- grant (the grant's wake row, as the test ping takes it) so two at once cannot both pass the count.
  IF p_type = 'meetings.minutes_published' THEN
    PERFORM 1 FROM ludy_kernel.agent_grant_wake w WHERE w.org_id = v_org AND w.grant_id = p_grant_id FOR UPDATE;
    v_meeting := p_body #>> '{data,meeting_id}';
    SELECT pg_catalog.count(*)::integer, (pg_catalog.count(*) FILTER (WHERE d.body #>> '{data,meeting_id}' IS NOT DISTINCT FROM v_meeting))::integer INTO v_hour, v_same
    FROM ludy_kernel.agent_wake_delivery d
    WHERE d.org_id = v_org AND d.grant_id = p_grant_id AND d.type = 'meetings.minutes_published' AND d.created_at > pg_catalog.clock_timestamp() - interval '1 hour';
    IF v_hour >= 60 OR (v_meeting IS NOT NULL AND v_same >= 3) THEN
      RETURN false;
    END IF;
  END IF;
  INSERT INTO ludy_kernel.agent_wake_delivery (org_id, id, grant_id, type, body) VALUES (v_org, p_id, p_grant_id, p_type, p_body)
  ON CONFLICT (org_id, id) DO NOTHING;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count = 0 THEN
    RETURN false;
  END IF;
  IF p_type = 'schedule.due' THEN
    UPDATE ludy_kernel.agent_grant_wake w SET
      next_due_at = ludy_kernel.mcp_wake_next_due(v_row.schedule, v_row.schedule_minute, v_row.schedule_weekday, pg_catalog.clock_timestamp()),
      updated_at = pg_catalog.clock_timestamp()
    WHERE w.org_id = v_org AND w.grant_id = p_grant_id;
  ELSIF p_keys IS NOT NULL AND p_type = 'signal.fired' THEN
    INSERT INTO ludy_kernel.agent_wake_signal_seen (org_id, grant_id, key) SELECT v_org, p_grant_id, k FROM pg_catalog.unnest(p_keys) AS k
    ON CONFLICT (org_id, grant_id, key) DO NOTHING;
  END IF;
  RETURN true;
END $$;
