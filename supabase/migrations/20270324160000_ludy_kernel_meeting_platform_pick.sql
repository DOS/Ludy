-- SPDX-License-Identifier: AGPL-3.0-only
-- Google Meet audio through the Picker route, step 2 (issue #3174, ADR-0025 amendment of 2026-11-25): where the member's pick is kept. Idempotent; applied files stay untouched.
--
-- A Meet recording is a video file in the organizer's Drive. The member picks it in Google Picker (scope drive.file) in their own browser; the browser then tells the API ONE thing, the Drive file id it picked.
-- That id is kept on the recording row and nothing else of the pick is (no token ever reaches Ludy). The worker's import job compares it with the file id Meet itself gave for the recording (it makes the Google
-- calls; a command makes none) and downloads nothing on a mismatch, so a member cannot make the server read a Drive file of their choice.
--
-- ludy_kernel.meeting_platform_recording.picked_file_id / picked_at   the Drive file id the member picked and when; both set or both empty; a Drive id is letters, digits, '-' and '_' (10 to 128).
-- ludy_kernel.meeting_platform_recording_pick(recording, file)        the member's own row, of a Google Meet recording that has only a video file, still suggested or failed. Granted to the app role,
--                                                                     like the dismiss next to it. A later sync keeps the pick (its upsert never touches these columns); a row the sync drops takes it along.
-- ludy_kernel.meeting_platform_import_pick(recording, staging_key)    worker only, in the org's system context: the id a row that is importing under exactly that staging key holds, or null.
SET LOCAL lock_timeout = '2s';

ALTER TABLE ludy_kernel.meeting_platform_recording ADD COLUMN IF NOT EXISTS picked_file_id text;
ALTER TABLE ludy_kernel.meeting_platform_recording ADD COLUMN IF NOT EXISTS picked_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'ludy_kernel.meeting_platform_recording'::pg_catalog.regclass AND conname = 'meeting_platform_recording_picked_ck'
  ) THEN
    ALTER TABLE ludy_kernel.meeting_platform_recording
      ADD CONSTRAINT meeting_platform_recording_picked_ck
      CHECK ((picked_file_id IS NULL) = (picked_at IS NULL) AND (picked_file_id IS NULL OR picked_file_id ~ '^[A-Za-z0-9_-]{10,128}$'));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION ludy_kernel.meeting_platform_recording_pick(p_recording uuid, p_file text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_user uuid := ludy_kernel.meeting_platform_member();
BEGIN
  IF p_file IS NULL OR p_file !~ '^[A-Za-z0-9_-]{10,128}$' THEN
    RAISE EXCEPTION 'MEETING_PLATFORM_INVALID' USING ERRCODE = '22023';
  END IF;
  UPDATE ludy_kernel.meeting_platform_recording r
  SET picked_file_id = p_file, picked_at = pg_catalog.now(), updated_at = pg_catalog.now(),
      -- A try that failed because of the pick (none, or another file than Meet's) is answered by this new pick: the member may start it again.
      error_code = CASE WHEN r.error_code IN ('pick_missing', 'pick_mismatch') THEN NULL ELSE r.error_code END
  WHERE r.org_id = v_org AND r.id = p_recording AND r.user_id = v_user AND r.status IN ('suggested', 'failed')
    AND r.has_video AND NOT r.has_audio AND NOT r.has_transcript
    AND EXISTS (SELECT 1 FROM ludy_kernel.meeting_platform_connection c WHERE c.org_id = r.org_id AND c.id = r.connection_id AND c.provider = 'google_meet');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MEETING_PLATFORM_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION ludy_kernel.meeting_platform_import_pick(p_recording uuid, p_staging_key text)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := ludy_kernel.meeting_platform_system();
  v_file text;
BEGIN
  SELECT r.picked_file_id INTO v_file
  FROM ludy_kernel.meeting_platform_recording r
  WHERE r.org_id = v_org AND r.id = p_recording AND r.status = 'importing' AND r.staging_key = p_staging_key;
  RETURN v_file;
END $$;

REVOKE ALL ON FUNCTION ludy_kernel.meeting_platform_recording_pick(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION ludy_kernel.meeting_platform_import_pick(uuid, text) FROM PUBLIC;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE (rolname LIKE 'ludy\_%' OR rolname LIKE 'crove\_%') AND rolname <> current_user LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_kernel.meeting_platform_recording_pick(uuid, text) FROM %I', r.rolname);
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_kernel.meeting_platform_import_pick(uuid, text) FROM %I', r.rolname);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION ludy_kernel.meeting_platform_recording_pick(uuid, text) TO ludy_app;
GRANT EXECUTE ON FUNCTION ludy_kernel.meeting_platform_import_pick(uuid, text) TO ludy_worker;
