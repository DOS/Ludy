-- SPDX-License-Identifier: AGPL-3.0-only
-- Engage's wake rules (#3862, E3 of epic #3857; ADR-0051 decision 13): the deterministic rules, with no model, that tell an AI coworker (Dy, Uy) there is work, as a colleague is told. Each is an event type a line registers
-- in the catalog of 20270119160000 (ids, dates, amounts and enum words only: never a name, a message or a note), each fires once per item per window, and each reads as the grant in its sealed context. What this adds:
--   crove_kernel.conversation_setting.wake_*   the org's N for the three rules that have one (hours a conversation waits before it counts as unanswered, hours before a reply window closes, days a sent quote waits),
--                        with the product's defaults when the org set none; owners and admins change them in Settings (the same row as the retention and the auto draft);
--   crove_kernel.agent_wake_signal_seen.key    the key may now end with a day (`<rule>:<id>:<yyyy-mm-dd>`): the window of a line event, so a rule that still holds fires once, and again only for a new window
--                        (the signals' own keys are as before);
--   mcp_wake_line_plan(grant)    what a line's source needs before it reads, for the worker: the grant's kind and scopes (a source reads only for a company grant that holds its line's scope) and the org's N;
--   mcp_wake_line_check(grant, keys)   which of a source's item keys were not sent yet (and forgets a line key after 90 days, so the table does not grow for ever);
--   mcp_wake_enqueue (restated whole from 20270119160000)   an event of a line's type may carry its one key: the key is noted as seen in the same transaction that stores the event, and an event whose key is
--                        already seen is not stored (so two sweeps never both send it, whatever the check said); the key must start with the type's own name;
--   the catalog's rows for Engage's, Social's and Ads' wake types (ids, dates, amounts and enum words only; an amount has an enum field for its currency).
-- Idempotent (add column if not exists, create or replace, drop and create, insert on conflict do nothing); applied files untouched.
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. The org's N
-- ---------------------------------------------------------------------------
ALTER TABLE crove_kernel.conversation_setting ADD COLUMN IF NOT EXISTS wake_unanswered_hours smallint NOT NULL DEFAULT 4;
ALTER TABLE crove_kernel.conversation_setting ADD COLUMN IF NOT EXISTS wake_reply_window_hours smallint NOT NULL DEFAULT 3;
ALTER TABLE crove_kernel.conversation_setting ADD COLUMN IF NOT EXISTS wake_quote_days smallint NOT NULL DEFAULT 5;
DO $$
BEGIN
  ALTER TABLE crove_kernel.conversation_setting ADD CONSTRAINT conversation_setting_wake_unanswered_hours_range CHECK (wake_unanswered_hours BETWEEN 1 AND 72);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$
BEGIN
  ALTER TABLE crove_kernel.conversation_setting ADD CONSTRAINT conversation_setting_wake_reply_window_hours_range CHECK (wake_reply_window_hours BETWEEN 1 AND 23);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$
BEGIN
  ALTER TABLE crove_kernel.conversation_setting ADD CONSTRAINT conversation_setting_wake_quote_days_range CHECK (wake_quote_days BETWEEN 2 AND 30);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
GRANT UPDATE (wake_unanswered_hours, wake_reply_window_hours, wake_quote_days) ON crove_kernel.conversation_setting TO crove_tenant;

-- ---------------------------------------------------------------------------
-- 2. The key of a seen item: a line event's key ends with the day of its window
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  ALTER TABLE crove_kernel.agent_wake_signal_seen DROP CONSTRAINT IF EXISTS agent_wake_signal_seen_key_check;
  ALTER TABLE crove_kernel.agent_wake_signal_seen DROP CONSTRAINT IF EXISTS agent_wake_signal_seen_key_shape;
  ALTER TABLE crove_kernel.agent_wake_signal_seen ADD CONSTRAINT agent_wake_signal_seen_key_shape
    CHECK (key ~ '^[a-z]+(_[a-z]+)*(:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}){1,3}(:[0-9]{4}-[0-9]{2}-[0-9]{2})?$') NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
ALTER TABLE crove_kernel.agent_wake_signal_seen VALIDATE CONSTRAINT agent_wake_signal_seen_key_shape;

-- ---------------------------------------------------------------------------
-- 3. What a line's source needs before it reads, and which of its keys are new
-- ---------------------------------------------------------------------------
-- The grant's kind and scopes, the apps the org switched off (ADR-0053: an app that is off wakes no coworker) and the org's N, for a grant whose wake-up is on and in good standing. A source reads only for a company grant that holds its line's write scope and the read scope (the database
-- refuses the event of any other, but the read in that grant's own sealed context would already have happened). Nothing a person typed is in the answer.
CREATE OR REPLACE FUNCTION crove_kernel.mcp_wake_line_plan(p_grant_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := crove_kernel.mcp_wake_system();
  v_user uuid;
  v_kind text;
  v_scopes text[];
  v_unanswered smallint;
  v_window smallint;
  v_quote smallint;
  v_off text[];
BEGIN
  SELECT g.user_id, g.kind, g.scopes INTO v_user, v_kind, v_scopes
  FROM crove_kernel.agent_grant_wake w JOIN crove_kernel.agent_grant g ON g.org_id = w.org_id AND g.id = w.grant_id
  WHERE w.org_id = v_org AND w.grant_id = p_grant_id AND w.enabled;
  IF NOT FOUND OR NOT crove_kernel.mcp_grant_standing(p_grant_id, v_org, v_user) THEN
    RAISE EXCEPTION 'MCP_WAKE_GRANT' USING ERRCODE = '22023';
  END IF;
  SELECT s.wake_unanswered_hours, s.wake_reply_window_hours, s.wake_quote_days INTO v_unanswered, v_window, v_quote
  FROM crove_kernel.conversation_setting s WHERE s.org_id = v_org;
  SELECT t.apps_off INTO v_off FROM crove_kernel.tenant t WHERE t.org_id = v_org;
  RETURN pg_catalog.jsonb_build_object(
    'kind', v_kind,
    'appsOff', pg_catalog.to_jsonb(COALESCE(v_off, ARRAY[]::text[])),
    'scopes', pg_catalog.to_jsonb(v_scopes),
    'unansweredHours', COALESCE(v_unanswered, 4),
    'replyWindowHours', COALESCE(v_window, 3),
    'quoteDays', COALESCE(v_quote, 5));
END $$;

-- Which of a source's item keys (`<type>:<id>:<day>`, the type's dots as underscores) were not sent for this grant yet. They are noted as seen by the event that carries them (mcp_wake_enqueue), so a failure
-- between the two sends the event again and never loses it. A line key is forgotten after 90 days, longer than any window a rule looks back over.
CREATE OR REPLACE FUNCTION crove_kernel.mcp_wake_line_check(p_grant_id uuid, p_keys text[])
RETURNS text[] LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := crove_kernel.mcp_wake_system();
  v_fresh text[];
BEGIN
  IF p_keys IS NULL OR pg_catalog.cardinality(p_keys) > 200
     OR EXISTS (SELECT 1 FROM pg_catalog.unnest(p_keys) AS k
                WHERE k !~ '^(engage|social|ads)(_[a-z]+)+(:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}){1,3}:[0-9]{4}-[0-9]{2}-[0-9]{2}$') THEN
    RAISE EXCEPTION 'MCP_WAKE_INVALID' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM crove_kernel.agent_grant_wake w WHERE w.org_id = v_org AND w.grant_id = p_grant_id) THEN
    RAISE EXCEPTION 'MCP_WAKE_GRANT' USING ERRCODE = '22023';
  END IF;
  DELETE FROM crove_kernel.agent_wake_signal_seen s
  WHERE s.org_id = v_org AND s.grant_id = p_grant_id AND s.key ~ '^(engage|social|ads)_' AND s.first_seen_at < pg_catalog.clock_timestamp() - interval '90 days';
  SELECT COALESCE(pg_catalog.array_agg(k ORDER BY k), ARRAY[]::text[]) INTO v_fresh
  FROM pg_catalog.unnest(p_keys) AS k
  WHERE NOT EXISTS (SELECT 1 FROM crove_kernel.agent_wake_signal_seen s WHERE s.org_id = v_org AND s.grant_id = p_grant_id AND s.key = k);
  RETURN v_fresh;
END $$;

-- ---------------------------------------------------------------------------
-- 4. mcp_wake_enqueue, restated whole from 20270119160000: a line event may carry its one key
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_kernel.mcp_wake_enqueue(p_id uuid, p_grant_id uuid, p_type text, p_body jsonb, p_keys text[])
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := crove_kernel.mcp_wake_system();
  v_user uuid;
  v_kind text;
  v_scopes text[];
  v_scope text;
  v_row crove_kernel.agent_grant_wake%ROWTYPE;
  v_count integer;
BEGIN
  SELECT g.user_id, g.kind, g.scopes INTO v_user, v_kind, v_scopes
  FROM crove_kernel.agent_grant_wake w JOIN crove_kernel.agent_grant g ON g.org_id = w.org_id AND g.id = w.grant_id
  WHERE w.org_id = v_org AND w.grant_id = p_grant_id AND w.enabled;
  IF NOT FOUND OR NOT crove_kernel.mcp_grant_standing(p_grant_id, v_org, v_user) THEN
    RAISE EXCEPTION 'MCP_WAKE_GRANT' USING ERRCODE = '22023';
  END IF;
  IF p_type = 'signal.fired' AND v_kind = 'member' THEN
    RAISE EXCEPTION 'MCP_WAKE_INVALID' USING ERRCODE = '22023';
  END IF;
  -- An event of a line's own type goes only to a company grant that holds the line's write scope (with the read scope, as every write scope comes): a member-bound grant, a grant of another line and a read-only
  -- grant are refused, so no id of the line's data leaves for a receiver that may not read it.
  IF p_type NOT IN ('signal.fired', 'schedule.due', 'ping') THEN
    SELECT t.scope INTO v_scope FROM crove_kernel.mcp_wake_event_type t WHERE t.type = p_type;
    IF NOT FOUND OR v_kind <> 'company' OR NOT (v_scope = ANY (v_scopes)) OR NOT ('ludy.read' = ANY (v_scopes)) THEN
      RAISE EXCEPTION 'MCP_WAKE_SCOPE' USING ERRCODE = '22023';
    END IF;
  END IF;
  IF p_keys IS NOT NULL AND pg_catalog.cardinality(p_keys) > 20 THEN
    RAISE EXCEPTION 'MCP_WAKE_INVALID' USING ERRCODE = '22023';
  END IF;
  IF p_keys IS NOT NULL AND p_type IN ('schedule.due', 'ping') THEN
    RAISE EXCEPTION 'MCP_WAKE_INVALID' USING ERRCODE = '22023';
  END IF;
  -- A line event carries exactly one key, the type's own name (dots as underscores), an item and the day of its window: the item's "seen" rule, kept with the event.
  IF p_keys IS NOT NULL AND p_type NOT IN ('signal.fired', 'schedule.due', 'ping')
     AND (pg_catalog.cardinality(p_keys) <> 1 OR p_keys[1] IS NULL
          OR p_keys[1] !~ ('^' || pg_catalog.replace(p_type, '.', '_') || '(:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}){1,3}:[0-9]{4}-[0-9]{2}-[0-9]{2}$')) THEN
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
  -- The line's key first: a key already seen stores nothing, whatever two sweeps did at the same time.
  IF p_keys IS NOT NULL AND p_type NOT IN ('signal.fired', 'schedule.due', 'ping') THEN
    INSERT INTO crove_kernel.agent_wake_signal_seen (org_id, grant_id, key) VALUES (v_org, p_grant_id, p_keys[1])
    ON CONFLICT (org_id, grant_id, key) DO NOTHING;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    IF v_count = 0 THEN
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
  ELSIF p_keys IS NOT NULL AND p_type = 'signal.fired' THEN
    INSERT INTO crove_kernel.agent_wake_signal_seen (org_id, grant_id, key) SELECT v_org, p_grant_id, k FROM pg_catalog.unnest(p_keys) AS k
    ON CONFLICT (org_id, grant_id, key) DO NOTHING;
  END IF;
  RETURN true;
END $$;

-- ---------------------------------------------------------------------------
-- 5. Grants: the delivery worker's login alone
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION crove_kernel.mcp_wake_line_plan(uuid), crove_kernel.mcp_wake_line_check(uuid, text[]) FROM PUBLIC;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE 'crove\_%' AND rolname <> current_user LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION crove_kernel.mcp_wake_line_plan(uuid), crove_kernel.mcp_wake_line_check(uuid, text[]) FROM %I', r.rolname);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION crove_kernel.mcp_wake_line_plan(uuid), crove_kernel.mcp_wake_line_check(uuid, text[]) TO crove_worker;

-- ---------------------------------------------------------------------------
-- 6. The types the lines register (the registry in code, LINE_WAKE_EVENTS in apps/kernel/src/mcp-wake-body.ts, holds the same; a test keeps the two equal)
-- ---------------------------------------------------------------------------
INSERT INTO crove_kernel.mcp_wake_event_type (type, scope, fields, adr) VALUES
  ('engage.conversation_new', 'ludy.engage.write',
   '{"conversation_id": "id", "kind": ["direct", "email"], "since": "date"}'::jsonb, 'ADR-0051 decision 13'),
  ('engage.conversation_unanswered', 'ludy.engage.write',
   '{"conversation_id": "id", "kind": ["direct", "email"], "since": "date"}'::jsonb, 'ADR-0051 decision 13'),
  ('engage.reply_window_closing', 'ludy.engage.write',
   '{"conversation_id": "id", "closes_on": "date"}'::jsonb, 'ADR-0051 decision 13'),
  ('engage.quote_unanswered', 'ludy.engage.write',
   '{"deal_id": "id", "next_step_id": "id", "since": "date", "amount": "amount", "currency": ["vnd"]}'::jsonb, 'ADR-0051 decision 13'),
  ('engage.booking_tomorrow', 'ludy.engage.write',
   '{"booking_id": "id", "on": "date"}'::jsonb, 'ADR-0051 decision 13'),
  ('social.post_comment_new', 'ludy.social.draft',
   '{"conversation_id": "id", "since": "date"}'::jsonb, 'ADR-0051 decision 13'),
  ('ads.pace_over', 'ludy.ads.draft',
   '{"subject_id": "id", "scope": ["org", "account"], "month": "date", "projected": "amount", "cap": "amount", "currency": ["vnd", "usd", "eur", "gbp", "jpy", "krw", "cny", "thb", "sgd", "myr", "idr", "php", "aud", "twd", "other"]}'::jsonb, 'ADR-0051 decision 13'),
  ('ads.daily_cap_over', 'ludy.ads.draft',
   '{"subject_id": "id", "scope": ["org", "account"], "day": "date", "spend": "amount", "cap": "amount", "currency": ["vnd", "usd", "eur", "gbp", "jpy", "krw", "cny", "thb", "sgd", "myr", "idr", "php", "aud", "twd", "other"]}'::jsonb, 'ADR-0051 decision 13'),
  ('ads.monthly_cap_over', 'ludy.ads.draft',
   '{"subject_id": "id", "scope": ["org", "account"], "day": "date", "spend": "amount", "cap": "amount", "currency": ["vnd", "usd", "eur", "gbp", "jpy", "krw", "cny", "thb", "sgd", "myr", "idr", "php", "aud", "twd", "other"]}'::jsonb, 'ADR-0051 decision 13')
ON CONFLICT (type) DO NOTHING;
