-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove meetings B1 (issue #3165, plan docs/plan/meetings-integrations.md section 5.1): a member's own Google Calendar meetings, read to suggest "record this meeting". Idempotent; applied
-- files stay untouched.
--
-- (The member's switch crove_kernel.calendar_connection.read_events is added by the crove_kernel migration just before this one.)
-- crove_meetings.calendar_agenda
--                              A per-member cache of the events of the member's own primary calendar from 1 day back to 7 days ahead: title, start, end, time zone, a join address (https only) and
--                              the number of invitees. No column holds an invitee address, a description or an attachment. Only the member reads it (an owner, an admin, another member, an agent
--                              context and the system context read none) and only the member's own row security lets them delete it or set `meeting_id` (the L1-style link of a meeting to the
--                              event they were recorded from, one event per meeting). A row goes with its connection (disconnect), with its meeting and with the org. Nothing else writes it:
-- crove_meetings.agenda_replace
--                              The sweep's one writer (worker login, the org's system context): replaces the unlinked rows of a connection that has the switch on with the events it read, and returns a
--                              COUNT, never text. The system context cannot select the table, so a definer is the only way to delete what the sweep no longer finds; it writes nothing for a
--                              connection whose switch is off or that is not active, and a row linked to a meeting is kept (updated, never dropped) until its meeting goes.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_meetings.calendar_agenda (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  -- The connection the event was read through; the member who owns it owns the row. Disconnecting deletes the connection and so its cache at once.
  connection_id uuid NOT NULL,
  user_id uuid NOT NULL,
  -- The provider's event id, for the replace. Never shown.
  external_id text NOT NULL CHECK (pg_catalog.char_length(external_id) BETWEEN 1 AND 1024),
  title text NOT NULL CHECK (pg_catalog.char_length(title) <= 200),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  time_zone text NOT NULL CHECK (pg_catalog.char_length(time_zone) BETWEEN 1 AND 64),
  -- A Meet, Zoom or Teams address as the adapter parses it, https only.
  join_url text CHECK (join_url IS NULL OR (pg_catalog.char_length(join_url) <= 500 AND pg_catalog.left(join_url, 8) = 'https://')),
  invitee_count integer NOT NULL DEFAULT 0 CHECK (invitee_count BETWEEN 0 AND 1000),
  -- The meeting recorded from this event, set by the member's own "Gắn vào sự kiện lịch này" click.
  meeting_id uuid,
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT calendar_agenda_order CHECK (ends_at > starts_at),
  CONSTRAINT calendar_agenda_length CHECK (ends_at - starts_at <= interval '31 days'),
  CONSTRAINT calendar_agenda_connection_fk FOREIGN KEY (org_id, connection_id) REFERENCES crove_kernel.calendar_connection (org_id, id) ON DELETE CASCADE,
  CONSTRAINT calendar_agenda_meeting_fk FOREIGN KEY (org_id, meeting_id) REFERENCES crove_meetings.meeting (org_id, id) ON DELETE CASCADE,
  CONSTRAINT calendar_agenda_event_uq UNIQUE (org_id, connection_id, external_id),
  -- One event a meeting (a NULL is distinct from every other NULL, so unlinked rows do not collide).
  CONSTRAINT calendar_agenda_meeting_uq UNIQUE (org_id, meeting_id)
);
CREATE INDEX IF NOT EXISTS calendar_agenda_user_idx ON crove_meetings.calendar_agenda (org_id, user_id, starts_at);

SELECT crove_kernel.apply_tenant_rls('crove_meetings.calendar_agenda');
-- Rows come from agenda_replace alone; a member may delete their own and set only the link.
REVOKE INSERT, UPDATE ON crove_meetings.calendar_agenda FROM crove_tenant;
GRANT UPDATE (meeting_id) ON crove_meetings.calendar_agenda TO crove_tenant;

-- The member alone, in a user context (an owner, an admin, any agent context, a member Vy run included, and the system context read none).
DROP POLICY IF EXISTS calendar_agenda_read ON crove_meetings.calendar_agenda;
CREATE POLICY calendar_agenda_read ON crove_meetings.calendar_agenda AS RESTRICTIVE FOR SELECT TO crove_tenant
  USING (crove_kernel.ctx_actor_type() = 'user' AND user_id = crove_kernel.ctx_user_id());
DROP POLICY IF EXISTS calendar_agenda_insert ON crove_meetings.calendar_agenda;
CREATE POLICY calendar_agenda_insert ON crove_meetings.calendar_agenda AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK (false);
-- The link: a meeting the member recorded, or none (clearing it).
DROP POLICY IF EXISTS calendar_agenda_update ON crove_meetings.calendar_agenda;
CREATE POLICY calendar_agenda_update ON crove_meetings.calendar_agenda AS RESTRICTIVE FOR UPDATE TO crove_tenant
  USING (crove_kernel.ctx_actor_type() = 'user' AND user_id = crove_kernel.ctx_user_id())
  WITH CHECK (crove_kernel.ctx_actor_type() = 'user' AND user_id = crove_kernel.ctx_user_id() AND (meeting_id IS NULL OR crove_meetings.is_meeting_recorder(org_id, meeting_id)));
DROP POLICY IF EXISTS calendar_agenda_delete ON crove_meetings.calendar_agenda;
CREATE POLICY calendar_agenda_delete ON crove_meetings.calendar_agenda AS RESTRICTIVE FOR DELETE TO crove_tenant
  USING (crove_kernel.ctx_actor_type() = 'user' AND user_id = crove_kernel.ctx_user_id());

-- ---------------------------------------------------------------------------
-- The sweep's writer
-- ---------------------------------------------------------------------------
-- p_rows is a JSON array of at most 300 events: {id, title, startsAt, endsAt, timeZone, joinUrl, invitees}. Raises MEETINGS_WORKER_ONLY (42501) for a login that is not the worker's,
-- MEETINGS_SYSTEM_CONTEXT (42501) outside the org's system context and AGENDA_INVALID (22023) for a malformed list. A connection that is gone, not active or without the switch is left as
-- it is (0 rows). The unlinked rows of the connection that end before p_from or are not in the list are deleted; the events in the list are inserted or updated (a linked row keeps its
-- meeting). The connection row is locked FOR SHARE, so a member switching the read off (which updates it) waits for a replace in flight and then deletes what it wrote.
CREATE OR REPLACE FUNCTION crove_meetings.agenda_replace(p_connection uuid, p_from timestamptz, p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_user uuid;
  v_ids text[];
  v_n integer;
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'MEETINGS_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF v_org IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'system' THEN
    RAISE EXCEPTION 'MEETINGS_SYSTEM_CONTEXT' USING ERRCODE = '42501';
  END IF;
  IF p_from IS NULL OR p_rows IS NULL OR pg_catalog.jsonb_typeof(p_rows) IS DISTINCT FROM 'array' OR pg_catalog.jsonb_array_length(p_rows) > 300 THEN
    RAISE EXCEPTION 'AGENDA_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT c.user_id INTO v_user FROM crove_kernel.calendar_connection c
  WHERE c.org_id = v_org AND c.id = p_connection AND c.status = 'active' AND c.read_events
  FOR SHARE;
  IF NOT FOUND THEN
    RETURN 0;
  END IF;
  SELECT pg_catalog.array_agg(e.value ->> 'id') INTO v_ids FROM pg_catalog.jsonb_array_elements(p_rows) AS e(value);
  DELETE FROM crove_meetings.calendar_agenda a
  WHERE a.org_id = v_org AND a.connection_id = p_connection AND a.meeting_id IS NULL
    AND (a.ends_at < p_from OR a.external_id <> ALL (COALESCE(v_ids, ARRAY[]::text[])));
  INSERT INTO crove_meetings.calendar_agenda AS a (org_id, connection_id, user_id, external_id, title, starts_at, ends_at, time_zone, join_url, invitee_count)
  SELECT DISTINCT ON (e.value ->> 'id') v_org, p_connection, v_user, e.value ->> 'id',
         pg_catalog.left(COALESCE(e.value ->> 'title', ''), 200),
         (e.value ->> 'startsAt')::timestamptz,
         (e.value ->> 'endsAt')::timestamptz,
         COALESCE(NULLIF(e.value ->> 'timeZone', ''), 'UTC'),
         CASE WHEN pg_catalog.left(COALESCE(e.value ->> 'joinUrl', ''), 8) = 'https://' AND pg_catalog.char_length(e.value ->> 'joinUrl') <= 500 THEN e.value ->> 'joinUrl' END,
         LEAST(GREATEST(COALESCE((e.value ->> 'invitees')::integer, 0), 0), 1000)
  FROM pg_catalog.jsonb_array_elements(p_rows) AS e(value)
  ORDER BY e.value ->> 'id'
  ON CONFLICT ON CONSTRAINT calendar_agenda_event_uq DO UPDATE
    SET title = EXCLUDED.title, starts_at = EXCLUDED.starts_at, ends_at = EXCLUDED.ends_at, time_zone = EXCLUDED.time_zone,
        join_url = EXCLUDED.join_url, invitee_count = EXCLUDED.invitee_count, updated_at = pg_catalog.now();
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;
REVOKE ALL ON FUNCTION crove_meetings.agenda_replace(uuid, timestamptz, jsonb) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_meetings.agenda_replace(uuid, timestamptz, jsonb) TO crove_worker;
