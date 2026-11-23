-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove meetings, a series of meetings (#3542, owner decision 2026-11-17): two meetings are in one series when they come from the same recurring calendar event, or when the recorder says
-- one follows the other. Idempotent; applied files stay untouched.
--
-- crove_meetings.calendar_agenda.series_id  the recurring event an event belongs to, as a uuid: a hash of the provider and the provider's series id (Google recurringEventId, Outlook
--                                           seriesMasterId), so two events of one series carry the same value and the provider's id itself is not stored. NULL for an event that is not
--                                           part of a series. Written by agenda_replace alone (restated below from 20261231200000 with this one column; same signature, owner and grants).
-- crove_meetings.meeting.series_id          the series of a meeting: copied from its calendar event when the recorder links the two (meetings.agenda.link), or set by the recorder's own
--                                           "next in the series" click (meetings.series.set), which gives both meetings one new value. A uuid, never text. The recorder alone updates it (the
--                                           meeting's own update policy); a reader sees it with the meeting.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_meetings.calendar_agenda ADD COLUMN IF NOT EXISTS series_id uuid;
ALTER TABLE crove_meetings.meeting ADD COLUMN IF NOT EXISTS series_id uuid;
CREATE INDEX IF NOT EXISTS meeting_series_idx ON crove_meetings.meeting (org_id, series_id, started_at) WHERE series_id IS NOT NULL;
GRANT UPDATE (series_id) ON crove_meetings.meeting TO crove_tenant;

-- ---------------------------------------------------------------------------
-- The sweep's writer, restated with the series
-- ---------------------------------------------------------------------------
-- p_rows entries may carry "series" (text, at most 1024 characters): the provider's recurring event id.
CREATE OR REPLACE FUNCTION crove_meetings.agenda_replace(p_connection uuid, p_from timestamptz, p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_user uuid;
  v_provider text;
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
  -- An event without an id cannot be told from another on the next sweep: refuse the list rather than fail on a NOT NULL half way.
  IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(p_rows) AS e(value) WHERE COALESCE(pg_catalog.jsonb_typeof(e.value -> 'id'), '') <> 'string' OR COALESCE(e.value ->> 'id', '') = '') THEN
    RAISE EXCEPTION 'AGENDA_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT c.user_id, c.provider INTO v_user, v_provider FROM crove_kernel.calendar_connection c
  WHERE c.org_id = v_org AND c.id = p_connection AND c.status = 'active' AND c.read_events
  FOR SHARE;
  IF NOT FOUND THEN
    RETURN 0;
  END IF;
  SELECT pg_catalog.array_agg(e.value ->> 'id') INTO v_ids FROM pg_catalog.jsonb_array_elements(p_rows) AS e(value);
  DELETE FROM crove_meetings.calendar_agenda a
  WHERE a.org_id = v_org AND a.connection_id = p_connection AND a.meeting_id IS NULL
    AND (a.ends_at < p_from OR a.external_id <> ALL (COALESCE(v_ids, ARRAY[]::text[])));
  INSERT INTO crove_meetings.calendar_agenda AS a (org_id, connection_id, user_id, external_id, title, starts_at, ends_at, time_zone, join_url, invitee_count, series_id)
  SELECT DISTINCT ON (e.value ->> 'id') v_org, p_connection, v_user, e.value ->> 'id',
         pg_catalog.left(COALESCE(e.value ->> 'title', ''), 200),
         (e.value ->> 'startsAt')::timestamptz,
         (e.value ->> 'endsAt')::timestamptz,
         COALESCE(NULLIF(e.value ->> 'timeZone', ''), 'UTC'),
         CASE WHEN pg_catalog.left(COALESCE(e.value ->> 'joinUrl', ''), 8) = 'https://' AND pg_catalog.char_length(e.value ->> 'joinUrl') <= 500 THEN e.value ->> 'joinUrl' END,
         LEAST(GREATEST(COALESCE((e.value ->> 'invitees')::integer, 0), 0), 1000),
         -- The recurring event this one belongs to (Google recurringEventId, Outlook seriesMasterId), kept only as a hash of the provider and that id: two events of one series share it,
         -- the provider's own id is not stored, and an event that is not part of a series has none.
         CASE WHEN pg_catalog.char_length(COALESCE(e.value ->> 'series', '')) BETWEEN 1 AND 1024 THEN pg_catalog.md5(v_provider || ':' || (e.value ->> 'series'))::uuid END
  FROM pg_catalog.jsonb_array_elements(p_rows) AS e(value)
  ORDER BY e.value ->> 'id'
  ON CONFLICT ON CONSTRAINT calendar_agenda_event_uq DO UPDATE
    SET title = EXCLUDED.title, starts_at = EXCLUDED.starts_at, ends_at = EXCLUDED.ends_at, time_zone = EXCLUDED.time_zone,
        join_url = EXCLUDED.join_url, invitee_count = EXCLUDED.invitee_count, series_id = EXCLUDED.series_id, updated_at = pg_catalog.now();
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;
REVOKE ALL ON FUNCTION crove_meetings.agenda_replace(uuid, timestamptz, jsonb) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_meetings.agenda_replace(uuid, timestamptz, jsonb) TO crove_worker;
