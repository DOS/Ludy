-- SPDX-License-Identifier: AGPL-3.0-only
-- C2 (#3174, PR B): the click on "Nhập" no longer refuses a recording that has only the platform's own transcript. The import job stages that transcript like it stages audio, and the member's request
-- claims it and writes it as the recorder's draft (meetings.import.take_transcript). Whether the recording's provider has a transcript path at all is the module command's check, made before the meeting is
-- created; a recording with no audio, no video and no transcript is still refused here and no empty meeting is made for it. Same signature as the last definition, so the grants and the EXECUTE matrix
-- are unchanged; only the guard differs (it is the guard of 20270117270000 with `has_transcript` added).
CREATE OR REPLACE FUNCTION crove_kernel.meeting_platform_recording_begin(p_recording uuid, p_meeting uuid, p_staging_key text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_user uuid := crove_kernel.meeting_platform_member();
  v_row crove_kernel.meeting_platform_recording%ROWTYPE;
BEGIN
  IF p_staging_key IS NULL OR p_staging_key !~ '^staging/[0-9a-f]{64}$' OR p_meeting IS NULL THEN
    RAISE EXCEPTION 'MEETING_PLATFORM_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_row FROM crove_kernel.meeting_platform_recording r WHERE r.org_id = v_org AND r.id = p_recording AND r.user_id = v_user FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MEETING_PLATFORM_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  -- The meeting the click just made must exist and be this member's to record (a kernel row naming a meeting by id, so it is checked here and not only by the command that calls this).
  IF NOT EXISTS (SELECT 1 FROM crove_meetings.meeting m WHERE m.org_id = v_org AND m.id = p_meeting AND m.recorder_user_id = v_user) THEN
    RAISE EXCEPTION 'MEETING_PLATFORM_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_row.status NOT IN ('suggested', 'failed') THEN
    RAISE EXCEPTION 'MEETING_PLATFORM_STATE' USING ERRCODE = '55000';
  END IF;
  -- An audio file is taken as it is, a video file has its audio extracted and a transcript is taken as the platform's lines; a recording with none of the three is refused here and no empty meeting is made for it.
  IF NOT v_row.has_audio AND NOT v_row.has_video AND NOT v_row.has_transcript THEN
    RAISE EXCEPTION 'MEETING_PLATFORM_NO_AUDIO' USING ERRCODE = '22023';
  END IF;
  UPDATE crove_kernel.meeting_platform_recording r
  SET status = 'importing', meeting_id = p_meeting, staging_key = p_staging_key, staged_at = NULL, error_code = NULL, updated_at = pg_catalog.now()
  WHERE r.org_id = v_org AND r.id = p_recording;
END $$;
