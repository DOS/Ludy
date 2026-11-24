-- SPDX-License-Identifier: AGPL-3.0-only
-- Ludy Meetings desktop capture kind (ADR-0055 slice 3, issue #4516). Idempotent; applied files stay untouched.
--
-- Extends ludy_meetings.capture_session.kind and ludy_meetings.capture_open to allow 'desktop' alongside 'extension' and 'app',
-- so Ludy Desktop participates in one-call-one-capture coordination and reports 'desktop' on 409 CAPTURE_ALREADY_RUNNING.
SET LOCAL lock_timeout = '2s';

DO $$
DECLARE
  v_con record;
  v_def text;
BEGIN
  SELECT pg_catalog.pg_get_constraintdef(oid) INTO v_def
  FROM pg_catalog.pg_constraint
  WHERE conrelid = 'ludy_meetings.capture_session'::pg_catalog.regclass
    AND conname = 'capture_session_kind_check';
  IF v_def IS NULL OR v_def NOT LIKE '%desktop%' THEN
    FOR v_con IN
      SELECT conname
      FROM pg_catalog.pg_constraint
      WHERE conrelid = 'ludy_meetings.capture_session'::pg_catalog.regclass
        AND contype = 'c'
        AND pg_catalog.pg_get_constraintdef(oid) LIKE '%extension%'
        AND pg_catalog.pg_get_constraintdef(oid) LIKE '%app%'
    LOOP
      EXECUTE pg_catalog.format('ALTER TABLE ludy_meetings.capture_session DROP CONSTRAINT IF EXISTS %I', v_con.conname);
    END LOOP;
    ALTER TABLE ludy_meetings.capture_session
      ADD CONSTRAINT capture_session_kind_check CHECK (kind IN ('extension', 'app', 'desktop'));
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- capture_open: allow 'desktop' capture kind alongside 'extension' and 'app'
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ludy_meetings.capture_open(p_meeting uuid, p_kind text, p_agenda uuid, p_key text)
RETURNS TABLE (kind text, since timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_user uuid := ludy_kernel.ctx_user_id();
BEGIN
  IF v_org IS NULL OR NOT ludy_meetings.is_meeting_recorder(v_org, p_meeting) THEN
    RAISE EXCEPTION 'CAPTURE_NOT_RECORDER' USING ERRCODE = '42501';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('extension', 'app', 'desktop') OR (p_key IS NOT NULL AND p_key !~ '^[0-9a-f]{64}$') THEN
    RAISE EXCEPTION 'CAPTURE_INVALID' USING ERRCODE = '22023';
  END IF;
  UPDATE ludy_meetings.capture_session s
     SET ended_at = pg_catalog.now(), ended_reason = 'lost'
   WHERE s.org_id = v_org AND s.ended_at IS NULL
     AND s.last_seen_at < pg_catalog.now() - interval '90 seconds'
     AND ((p_key IS NOT NULL AND s.meeting_key = p_key) OR (p_agenda IS NOT NULL AND s.agenda_id = p_agenda));
  BEGIN
    INSERT INTO ludy_meetings.capture_session (org_id, meeting_id, recorder_user_id, kind, agenda_id, meeting_key)
    VALUES (v_org, p_meeting, v_user, p_kind, p_agenda, p_key);
  EXCEPTION WHEN unique_violation THEN
    RETURN QUERY
      SELECT h.kind, h.started_at
        FROM ludy_meetings.capture_session h
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

REVOKE ALL ON FUNCTION ludy_meetings.capture_open(uuid, text, uuid, text) FROM PUBLIC;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE (rolname LIKE 'ludy\_%' OR rolname LIKE 'crove\_%') AND rolname <> current_user AND rolname NOT IN ('ludy_tenant', 'ludy_app') LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_meetings.capture_open(uuid, text, uuid, text) FROM %I', r.rolname);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION ludy_meetings.capture_open(uuid, text, uuid, text) TO ludy_tenant, ludy_app;
