-- SPDX-License-Identifier: AGPL-3.0-only
-- Line wake events (#3858 slice e; ADR-0051 decision 13; owner decision 2026-11-18/19). A line (Engage, Ads, Social) may register an event type for the wake-up of an MCP grant: a name in its own namespace and the fields of
-- its body, each an id, a date, an amount or one of a fixed list of words, and nothing else (ids, types, dates and amounts only: never a name, a note or a message). What this migration adds, with no event registered:
--   crove_kernel.mcp_wake_event_type   the catalog: type (`<line>.<words>`, the line the scope's own: `ludy.engage.write` is `engage`), the write scope a grant must hold to be woken by it, and its fields; filled only by the
--                        migration of the line, empty here, readable by the tenant role, written by no login;
--   mcp_wake_body_ok (restated whole from 20261224000000, STABLE now that it reads the catalog)   a body of a type the catalog does not list is refused, as is a field it does not list, a missing one or a value that is
--                        not of its kind, in the delivery table's CHECK (so nothing can be stored whatever writes the row);
--   agent_wake_delivery.type   the three fixed types, or a type in the line shape (the body check says which are registered);
--   mcp_wake_enqueue (restated whole from 20261225030000, one check more)   an event of a line's type is stored only for a company grant that holds the type's scope with the read scope: a member-bound grant (which holds no
--                        write scope), a read-only grant and a grant of another line are refused (MCP_WAKE_SCOPE), so no id of a line's data leaves for a receiver that may not read it. Which items a grant may be woken
--                        for is the line's own rule, run as the grant in its read-only context (the reads of the line's tables are the database's: slice b).
-- Idempotent (create if not exists, create or replace, drop and create); applied files untouched.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.mcp_wake_fields_ok(p_fields jsonb, p_type text, p_scope text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  k text;
  v jsonb;
  w jsonb;
BEGIN
  IF p_fields IS NULL OR pg_catalog.jsonb_typeof(p_fields) <> 'object' OR p_fields = '{}'::jsonb OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(p_fields)) > 12 THEN
    RETURN false;
  END IF;
  -- The type is in the namespace of the line the scope belongs to.
  IF p_type !~ '^[a-z]+(\.[a-z_]+){1,3}$' OR pg_catalog.split_part(p_type, '.', 1) IS DISTINCT FROM pg_catalog.split_part(p_scope, '.', 2) THEN
    RETURN false;
  END IF;
  FOR k, v IN SELECT * FROM pg_catalog.jsonb_each(p_fields) LOOP
    IF k !~ '^[a-z][a-z_]{0,30}$' THEN
      RETURN false;
    END IF;
    IF pg_catalog.jsonb_typeof(v) = 'string' THEN
      IF (v #>> '{}') NOT IN ('id', 'date', 'amount') THEN
        RETURN false;
      END IF;
    ELSIF pg_catalog.jsonb_typeof(v) = 'array' THEN
      IF pg_catalog.jsonb_array_length(v) NOT BETWEEN 1 AND 16 THEN
        RETURN false;
      END IF;
      FOR w IN SELECT * FROM pg_catalog.jsonb_array_elements(v) LOOP
        IF pg_catalog.jsonb_typeof(w) <> 'string' OR (w #>> '{}') !~ '^[a-z][a-z_]{0,30}$' THEN
          RETURN false;
        END IF;
      END LOOP;
    ELSE
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.mcp_wake_fields_ok(jsonb, text, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

CREATE TABLE IF NOT EXISTS crove_kernel.mcp_wake_event_type (
  type text PRIMARY KEY,
  scope text NOT NULL CHECK (scope IN ('ludy.social.draft', 'ludy.engage.write', 'ludy.ads.draft')),
  fields jsonb NOT NULL,
  adr text NOT NULL CHECK (adr ~ '^ADR-[0-9]{4}( .*)?$'),
  CHECK (type NOT IN ('signal.fired', 'schedule.due', 'ping')),
  CHECK (crove_kernel.mcp_wake_fields_ok(fields, type, scope))
);
REVOKE ALL ON crove_kernel.mcp_wake_event_type FROM PUBLIC;
GRANT SELECT ON crove_kernel.mcp_wake_event_type TO crove_tenant;
SELECT crove_kernel.agent_write_guard_install('crove_kernel.mcp_wake_event_type');

-- The delivery table's type: the three fixed ones, or the shape of a line's (the body check says which are registered).
DO $$
BEGIN
  ALTER TABLE crove_kernel.agent_wake_delivery DROP CONSTRAINT IF EXISTS agent_wake_delivery_type_check;
  ALTER TABLE crove_kernel.agent_wake_delivery DROP CONSTRAINT IF EXISTS agent_wake_delivery_type_shape;
  ALTER TABLE crove_kernel.agent_wake_delivery ADD CONSTRAINT agent_wake_delivery_type_shape
    CHECK (type IN ('signal.fired', 'schedule.due', 'ping') OR type ~ '^(social|engage|ads)(\.[a-z_]+){1,3}$') NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
ALTER TABLE crove_kernel.agent_wake_delivery VALIDATE CONSTRAINT agent_wake_delivery_type_shape;

-- mcp_wake_body_ok, restated whole from 20261224000000 with the branch for a line's type.
CREATE OR REPLACE FUNCTION crove_kernel.mcp_wake_body_ok(p_body jsonb, p_id uuid, p_org uuid, p_grant uuid, p_type text)
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  k text;
  v_item jsonb;
  v_items jsonb;
  v_fields jsonb;
  v_kind jsonb;
  v_val text;
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
  END IF;
  -- An event type a line registered (crove_kernel.mcp_wake_event_type, filled only by the migration of the line): the keys of `data` are exactly the registered fields, each one string of its kind, and nothing else.
  SELECT t.fields INTO v_fields FROM crove_kernel.mcp_wake_event_type t WHERE t.type = p_type;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  FOR k IN SELECT pg_catalog.jsonb_object_keys(p_body -> 'data') LOOP
    IF NOT (v_fields ? k) THEN
      RETURN false;
    END IF;
  END LOOP;
  FOR k IN SELECT pg_catalog.jsonb_object_keys(v_fields) LOOP
    v_kind := v_fields -> k;
    IF pg_catalog.jsonb_typeof(p_body #> ARRAY['data', k]) IS DISTINCT FROM 'string' THEN
      RETURN false;
    END IF;
    v_val := p_body #>> ARRAY['data', k];
    IF pg_catalog.jsonb_typeof(v_kind) = 'array' THEN
      IF NOT (v_kind @> pg_catalog.to_jsonb(v_val)) THEN
        RETURN false;
      END IF;
    ELSIF (v_kind #>> '{}') = 'id' THEN
      IF v_val !~ c_uuid THEN
        RETURN false;
      END IF;
    ELSIF (v_kind #>> '{}') = 'date' THEN
      IF v_val !~ '^\d{4}-\d{2}-\d{2}$' THEN
        RETURN false;
      END IF;
    ELSIF (v_kind #>> '{}') = 'amount' THEN
      IF v_val !~ '^-?(0|[1-9][0-9]{0,17})(\.[0-9]{1,4})?$' THEN
        RETURN false;
      END IF;
    ELSE
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END $$;

-- mcp_wake_enqueue, restated whole from 20261225030000 with the scope check for a line's type.
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
