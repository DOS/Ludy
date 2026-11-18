-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove kernel (issue #3803, ADR-0051 decision 4, owner approval 2026-11-18): the wake-up that tells an agent the minutes of an org-visible meeting were published. A new event type,
-- `meetings.minutes_published`, whose body holds exactly two data keys, `meeting_id` and `published_at` (an id and an instant), and nothing a person typed. This only widens what a delivery
-- may be; it opens no read:
--   - agent_wake_delivery.type accepts the new type;
--   - mcp_wake_body_ok knows its shape (the same strictness as the others: the pinned keys, the shape of every value, the ids equal to the row's);
--   - mcp_wake_enqueue refuses it for a member-bound grant, as it refuses a signal (the 2026-11-13 hold: member grants get no signal and no minutes event);
--   - mcp_wake_company_targets(org, limit) lists the grants to wake for the event: the company grants of the org whose wake-up is on and whose standing holds now (mcp_grant_standing, the same test
--     mcp_wake_due uses: not revoked or expired, the grantor still an owner or admin and not disabled, the org active, no kill switch). Ids only; the worker's login alone.
-- The worker builds each body (apps/kernel/src/mcp-wake-body.ts, the only builder) and stores it through kernel.mcp.wake.enqueue; the delivery id is derived from the outbox event and the grant, so a
-- retry stores nothing new. Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

-- The type of a delivery: the three of the first migration and the new one. The constraint takes the name an inline CHECK on the column was given.
ALTER TABLE crove_kernel.agent_wake_delivery DROP CONSTRAINT IF EXISTS agent_wake_delivery_type_check;
ALTER TABLE crove_kernel.agent_wake_delivery ADD CONSTRAINT agent_wake_delivery_type_check CHECK (type IN ('signal.fired', 'schedule.due', 'ping', 'meetings.minutes_published'));

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
        IF k NOT IN ('rule', 'key', 'severity', 'party_id', 'deal_id', 'invoice_id', 'amount', 'currency', 'due_on', 'days') THEN
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
      -- A currency names the unit of an amount and has no meaning without one.
      IF v_item ? 'currency' AND (NOT (v_item ? 'amount') OR pg_catalog.jsonb_typeof(v_item -> 'currency') <> 'string' OR (v_item ->> 'currency') !~ '^[A-Z]{3}$') THEN
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
  ELSIF p_type = 'meetings.minutes_published' THEN
    -- The minutes of an org-visible meeting were published (#3803): the meeting's id and the instant, and nothing a person typed.
    FOR k IN SELECT pg_catalog.jsonb_object_keys(p_body -> 'data') LOOP
      IF k NOT IN ('meeting_id', 'published_at') THEN
        RETURN false;
      END IF;
    END LOOP;
    RETURN pg_catalog.jsonb_typeof(p_body #> '{data,meeting_id}') = 'string' AND (p_body #>> '{data,meeting_id}') ~ c_uuid
       AND pg_catalog.jsonb_typeof(p_body #> '{data,published_at}') = 'string'
       AND (p_body #>> '{data,published_at}') ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$';
  END IF;
  RETURN false;
END $$;

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
  -- A member-bound grant gets no signal and no minutes event: no id of business data leaves for a receiver that only reads what a member reads (the hold of 2026-11-13).
  IF p_type IN ('signal.fired', 'meetings.minutes_published') AND v_kind = 'member' THEN
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
-- The grants to wake for a published minutes event: company grants of the org, wake-up on, standing now. Ids only; no context (like mcp_wake_due, it is the worker's list).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_kernel.mcp_wake_company_targets(p_org_id uuid, p_limit integer)
RETURNS TABLE (grant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT w.grant_id
  FROM crove_kernel.agent_grant_wake w
  JOIN crove_kernel.agent_grant g ON g.org_id = w.org_id AND g.id = w.grant_id
  WHERE w.org_id = p_org_id
    AND w.enabled
    AND g.kind = 'company'
    AND crove_kernel.mcp_grant_standing(g.id, g.org_id, g.user_id)
  ORDER BY w.grant_id
  LIMIT GREATEST(1, LEAST(p_limit, 500))
$$;

-- ---------------------------------------------------------------------------
-- Grants: the delivery worker's login alone (the replaced functions keep theirs).
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION crove_kernel.mcp_wake_company_targets(uuid, integer) FROM PUBLIC;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE 'crove\_%' AND rolname <> current_user LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION crove_kernel.mcp_wake_company_targets(uuid, integer) FROM %I', r.rolname);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION crove_kernel.mcp_wake_company_targets(uuid, integer) TO crove_worker;
