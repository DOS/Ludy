-- SPDX-License-Identifier: AGPL-3.0-only
-- Meetings B1 follow-up (#3246): delete stale unlinked rows in ludy_meetings.calendar_agenda
-- left behind when the calendar sweep stops visiting a connection (expired connection, demoted or
-- removed member, disabled adapter, or failed API clear). Linked rows (meeting_id IS NOT NULL)
-- stay until their meeting goes, and worker-only pruning returns only the deleted count.
-- Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

CREATE INDEX IF NOT EXISTS calendar_agenda_stale_idx
  ON ludy_meetings.calendar_agenda (updated_at)
  WHERE meeting_id IS NULL;

-- Deletes unlinked calendar_agenda rows whose updated_at is older than p_cutoff. Worker login
-- alone, outside any org or actor context (returns a count, never titles or ids).
CREATE OR REPLACE FUNCTION ludy_meetings.calendar_agenda_prune_stale(p_cutoff timestamptz)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_deleted integer;
BEGIN
  IF (NOT pg_catalog.pg_has_role(SESSION_USER, 'ludy_worker', 'MEMBER'))
     OR ludy_kernel.ctx_org_id() IS NOT NULL
     OR ludy_kernel.ctx_actor_type() IS NOT NULL THEN
    RAISE EXCEPTION 'MEETINGS_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF p_cutoff IS NULL OR p_cutoff > pg_catalog.now() - interval '1 day' THEN
    RAISE EXCEPTION 'AGENDA_PRUNE_CUTOFF' USING ERRCODE = '22023';
  END IF;
  DELETE FROM ludy_meetings.calendar_agenda a
  WHERE a.meeting_id IS NULL
    AND a.updated_at < p_cutoff;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END $$;

REVOKE ALL ON FUNCTION ludy_meetings.calendar_agenda_prune_stale(timestamptz) FROM PUBLIC;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT rolname
    FROM pg_catalog.pg_roles
    WHERE (rolname LIKE 'ludy\_%' OR rolname LIKE 'crove\_%')
      AND rolname <> current_user
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_meetings.calendar_agenda_prune_stale(timestamptz) FROM %I', r.rolname);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION ludy_meetings.calendar_agenda_prune_stale(timestamptz) TO ludy_worker;
