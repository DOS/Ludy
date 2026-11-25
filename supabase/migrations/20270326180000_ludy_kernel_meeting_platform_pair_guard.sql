-- SPDX-License-Identifier: AGPL-3.0-only
-- Meetings, Teams pair rows (ADR-0055, issue #4943): the guard "the two entries of one call do not both become meetings" moves into the definer that begins a recording, so it holds for every caller and not
-- only for the meetings.import.start command that checked it first (#4939). Idempotent; applied files stay untouched.
--
-- A platform that offers one meeting as two suggestions (Microsoft Teams: its video, and its transcript alone, whose key is the video's key plus '~transcript') makes two rows of one member and one connection.
-- ludy_kernel.meeting_platform_recording_begin(recording, meeting, staging_key) now, before it moves the row:
--   1. takes a transaction advisory lock on the pair (org, connection, the key without the suffix; the same text the command used), so two starts of the two rows are serialized: the second waits for the first's
--      commit and then reads its status. A row lock cannot do this for the caller (the tenant role has no UPDATE grant), and one taken inside the definer on the two rows could deadlock, so the pair lock comes first;
--   2. refuses with MEETING_PLATFORM_PAIR_TAKEN (55000, like the state refusal) when the other row of the pair, of the same member and connection, is importing, staged, claimed or imported. A sibling that is
--      only suggested, failed or dismissed leaves this row free.
-- Same signature as the last definition (20270119140000, its schema renamed to ludy_kernel by the rebrand), so the grants and the EXECUTE matrix are unchanged; the rest of the body is that one.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION ludy_kernel.meeting_platform_recording_begin(p_recording uuid, p_meeting uuid, p_staging_key text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_user uuid := ludy_kernel.meeting_platform_member();
  v_row ludy_kernel.meeting_platform_recording%ROWTYPE;
  v_connection uuid;
  v_external text;
  v_base text;
BEGIN
  IF p_staging_key IS NULL OR p_staging_key !~ '^staging/[0-9a-f]{64}$' OR p_meeting IS NULL THEN
    RAISE EXCEPTION 'MEETING_PLATFORM_INVALID' USING ERRCODE = '22023';
  END IF;
  -- The row's own connection and key, read without a lock: they name the pair to lock before any row is.
  SELECT r.connection_id, r.external_id INTO v_connection, v_external
  FROM ludy_kernel.meeting_platform_recording r WHERE r.org_id = v_org AND r.id = p_recording AND r.user_id = v_user;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MEETING_PLATFORM_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  v_base := pg_catalog.regexp_replace(v_external, '~transcript$', '');
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(pg_catalog.format('meetings.import.pair:%s:%s:%s', v_org, v_connection, v_base), 0));
  SELECT * INTO v_row FROM ludy_kernel.meeting_platform_recording r WHERE r.org_id = v_org AND r.id = p_recording AND r.user_id = v_user FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MEETING_PLATFORM_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  -- The meeting the click just made must exist and be this member's to record (a kernel row naming a meeting by id, so it is checked here and not only by the command that calls this).
  IF NOT EXISTS (SELECT 1 FROM ludy_meetings.meeting m WHERE m.org_id = v_org AND m.id = p_meeting AND m.recorder_user_id = v_user) THEN
    RAISE EXCEPTION 'MEETING_PLATFORM_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_row.status NOT IN ('suggested', 'failed') THEN
    RAISE EXCEPTION 'MEETING_PLATFORM_STATE' USING ERRCODE = '55000';
  END IF;
  -- One meeting offered as two suggestions: once the other row of the pair is on its way or done, this one is refused (any status but suggested, failed or dismissed means the call is taken).
  IF EXISTS (
    SELECT 1 FROM ludy_kernel.meeting_platform_recording s
    WHERE s.org_id = v_org AND s.connection_id = v_connection AND s.user_id = v_user AND s.id <> p_recording
      AND s.external_id IN (v_base, v_base || '~transcript')
      AND s.status NOT IN ('suggested', 'failed', 'dismissed')
  ) THEN
    RAISE EXCEPTION 'MEETING_PLATFORM_PAIR_TAKEN' USING ERRCODE = '55000';
  END IF;
  -- An audio file is taken as it is, a video file has its audio extracted and a transcript is taken as the platform's lines; a recording with none of the three is refused here and no empty meeting is made for it.
  IF NOT v_row.has_audio AND NOT v_row.has_video AND NOT v_row.has_transcript THEN
    RAISE EXCEPTION 'MEETING_PLATFORM_NO_AUDIO' USING ERRCODE = '22023';
  END IF;
  UPDATE ludy_kernel.meeting_platform_recording r
  SET status = 'importing', meeting_id = p_meeting, staging_key = p_staging_key, staged_at = NULL, error_code = NULL, updated_at = pg_catalog.now()
  WHERE r.org_id = v_org AND r.id = p_recording;
END $$;

-- The execute matrix of the last definition, stated again: the app role alone (the click's command runs as it); nobody else, no tenant, worker or definer role.
REVOKE ALL ON FUNCTION ludy_kernel.meeting_platform_recording_begin(uuid, uuid, text) FROM PUBLIC;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE (rolname LIKE 'ludy\_%' OR rolname LIKE 'crove\_%') AND rolname <> current_user LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_kernel.meeting_platform_recording_begin(uuid, uuid, text) FROM %I', r.rolname);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION ludy_kernel.meeting_platform_recording_begin(uuid, uuid, text) TO ludy_app;
