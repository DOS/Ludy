-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove meetings, one meeting one live capture (ADR-0055 slice 1, issue #4123). Idempotent; applied files stay untouched.
--
-- crove_meetings.capture_session
--                              The record that a call is being captured right now: by which kind of client (the browser extension or the app), since when and last heard from when. A client asks the
--                              server to start before it sends any audio (meetings.meeting.create, with a `capture`), and the server refuses a second open capture of the same call. "The same call" is the
--                              member's own calendar event, or a meeting key (a sha256 of the org, the platform and the platform's meeting id, read from a join address; the address itself is
--                              never stored). A capture that names neither is recorded and conflicts with nothing: nothing is known of its call. Only the recorder reads the row; no other member, no
--                              owner, no agent and no system context does.
--                              Rows are written by capture_open alone; the recorder's own commands end a row (ended_at, ended_reason) and the heartbeat sets last_seen_at.
-- crove_meetings.capture_open(meeting, kind, agenda, key)
--                              Ends the open captures of this key or calendar event that have not been heard from for 90 seconds (reason 'lost', so a crashed browser never locks the call; no job runs for it), then opens
--                              the capture of the recorder's meeting. When the call is already held it opens nothing and returns the one holder as (kind, since): never a person, a meeting id or a title.
--                              The other members' rows are reached by this definer only, because the row security shows each recorder their own.
-- crove_meetings.capture_beat(meeting)
--                              The heartbeat of the recorder's own capture: sets last_seen_at, and takes the call back when the capture was ended as 'lost' and nothing else holds it now. True while the
--                              capture holds its call, false otherwise. It never ends a recording: the client keeps recording whatever the answer is.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_meetings.capture_session (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  meeting_id uuid NOT NULL,
  recorder_user_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('extension', 'app')),
  -- The recorder's own calendar event, when the client named one. No foreign key: the agenda cache is replaced by its sweep, and this is an identity, not a link.
  agenda_id uuid,
  -- sha256 (hex) of org, platform and the platform's meeting id; null when the call is not known.
  meeting_key text CHECK (meeting_key IS NULL OR meeting_key ~ '^[0-9a-f]{64}$'),
  started_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  last_seen_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  ended_at timestamptz,
  ended_reason text CHECK (ended_reason IN ('media', 'stopped', 'lost')),
  PRIMARY KEY (org_id, id),
  CONSTRAINT capture_session_meeting_fk FOREIGN KEY (org_id, meeting_id) REFERENCES crove_meetings.meeting (org_id, id) ON DELETE CASCADE,
  -- One capture a meeting (a heartbeat after a loss re-opens the same row).
  CONSTRAINT capture_session_meeting_uq UNIQUE (org_id, meeting_id),
  -- An end has a reason and a reason has an end.
  CONSTRAINT capture_session_end_ck CHECK ((ended_at IS NULL) = (ended_reason IS NULL))
);
-- At most one OPEN capture for each identity of a call: the same meeting key, the same calendar event.
CREATE UNIQUE INDEX IF NOT EXISTS capture_session_key_open_uq ON crove_meetings.capture_session (org_id, meeting_key) WHERE ended_at IS NULL AND meeting_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS capture_session_agenda_open_uq ON crove_meetings.capture_session (org_id, agenda_id) WHERE ended_at IS NULL AND agenda_id IS NOT NULL;

SELECT crove_kernel.apply_tenant_rls('crove_meetings.capture_session');
-- Rows come from capture_open alone; the recorder's commands set the heartbeat and the end, and nothing else.
REVOKE INSERT, UPDATE ON crove_meetings.capture_session FROM crove_tenant;
GRANT UPDATE (last_seen_at, ended_at, ended_reason) ON crove_meetings.capture_session TO crove_tenant;

-- The recorder alone, in a user context: is_meeting_recorder answers false for an agent context (a member Vy run included) and for the system.
DROP POLICY IF EXISTS capture_session_read ON crove_meetings.capture_session;
CREATE POLICY capture_session_read ON crove_meetings.capture_session AS RESTRICTIVE FOR SELECT TO crove_tenant
  USING (crove_meetings.is_meeting_recorder(org_id, meeting_id));
DROP POLICY IF EXISTS capture_session_insert ON crove_meetings.capture_session;
CREATE POLICY capture_session_insert ON crove_meetings.capture_session AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK (false);
DROP POLICY IF EXISTS capture_session_update ON crove_meetings.capture_session;
CREATE POLICY capture_session_update ON crove_meetings.capture_session AS RESTRICTIVE FOR UPDATE TO crove_tenant
  USING (crove_meetings.is_meeting_recorder(org_id, meeting_id))
  WITH CHECK (crove_meetings.is_meeting_recorder(org_id, meeting_id));
DROP POLICY IF EXISTS capture_session_delete ON crove_meetings.capture_session;
CREATE POLICY capture_session_delete ON crove_meetings.capture_session AS RESTRICTIVE FOR DELETE TO crove_tenant
  USING (crove_meetings.is_meeting_recorder(org_id, meeting_id));

-- ---------------------------------------------------------------------------
-- capture_open
-- ---------------------------------------------------------------------------
-- Raises CAPTURE_NOT_RECORDER (42501) unless the caller is the recorder of p_meeting in a user context, and CAPTURE_INVALID (22023) for a kind that is not one or a key that is not a sha256 in hex.
-- Returns no row when the capture was opened, and one row (kind, since) of the open capture that holds the call when it was not (the caller then refuses and rolls back). The holder is the oldest open
-- capture of the same key or calendar event.
CREATE OR REPLACE FUNCTION crove_meetings.capture_open(p_meeting uuid, p_kind text, p_agenda uuid, p_key text)
RETURNS TABLE (kind text, since timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_user uuid := crove_kernel.ctx_user_id();
BEGIN
  IF v_org IS NULL OR NOT crove_meetings.is_meeting_recorder(v_org, p_meeting) THEN
    RAISE EXCEPTION 'CAPTURE_NOT_RECORDER' USING ERRCODE = '42501';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('extension', 'app') OR (p_key IS NOT NULL AND p_key !~ '^[0-9a-f]{64}$') THEN
    RAISE EXCEPTION 'CAPTURE_INVALID' USING ERRCODE = '22023';
  END IF;
  UPDATE crove_meetings.capture_session s
     SET ended_at = pg_catalog.now(), ended_reason = 'lost'
   WHERE s.org_id = v_org AND s.ended_at IS NULL
     AND s.last_seen_at < pg_catalog.now() - interval '90 seconds'
     AND ((p_key IS NOT NULL AND s.meeting_key = p_key) OR (p_agenda IS NOT NULL AND s.agenda_id = p_agenda));
  BEGIN
    INSERT INTO crove_meetings.capture_session (org_id, meeting_id, recorder_user_id, kind, agenda_id, meeting_key)
    VALUES (v_org, p_meeting, v_user, p_kind, p_agenda, p_key);
  EXCEPTION WHEN unique_violation THEN
    RETURN QUERY
      SELECT h.kind, h.started_at
        FROM crove_meetings.capture_session h
       WHERE h.org_id = v_org AND h.ended_at IS NULL
         AND ((p_key IS NOT NULL AND h.meeting_key = p_key) OR (p_agenda IS NOT NULL AND h.agenda_id = p_agenda))
       ORDER BY h.started_at, h.id
       LIMIT 1;
    IF NOT FOUND THEN
      -- The conflict was on something else (this meeting already has its capture): never report an opened capture that was not.
      RAISE EXCEPTION 'CAPTURE_CONFLICT' USING ERRCODE = '23505';
    END IF;
  END;
  RETURN;
END $$;
REVOKE ALL ON FUNCTION crove_meetings.capture_open(uuid, text, uuid, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_meetings.capture_open(uuid, text, uuid, text) TO crove_tenant, crove_app;

-- ---------------------------------------------------------------------------
-- capture_beat
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_meetings.capture_beat(p_meeting uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
BEGIN
  IF v_org IS NULL OR NOT crove_meetings.is_meeting_recorder(v_org, p_meeting) THEN
    RETURN false;
  END IF;
  UPDATE crove_meetings.capture_session s
     SET last_seen_at = pg_catalog.now()
   WHERE s.org_id = v_org AND s.meeting_id = p_meeting AND s.ended_at IS NULL;
  IF FOUND THEN
    RETURN true;
  END IF;
  -- Ended as lost (no beat for 90 seconds, for example a laptop that slept): take the call back unless another capture holds it now (the unique indexes say so), or the recording is over (the meeting has
  -- its end time once its media is recorded or it is reported stopped).
  BEGIN
    UPDATE crove_meetings.capture_session s
       SET ended_at = NULL, ended_reason = NULL, last_seen_at = pg_catalog.now()
     WHERE s.org_id = v_org AND s.meeting_id = p_meeting AND s.ended_reason = 'lost'
       AND EXISTS (SELECT 1 FROM crove_meetings.meeting m WHERE m.org_id = v_org AND m.id = p_meeting AND m.ended_at IS NULL);
    RETURN FOUND;
  EXCEPTION WHEN unique_violation THEN
    RETURN false;
  END;
END $$;
REVOKE ALL ON FUNCTION crove_meetings.capture_beat(uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_meetings.capture_beat(uuid) TO crove_tenant, crove_app;
