-- SPDX-License-Identifier: AGPL-3.0-only
-- #2874: the question the file table's meeting-media policy asks for a member Vy run (see 20261202030100_crove_kernel_file_meeting_media_rls.sql).
SET LOCAL lock_timeout = '2s';

-- True when the sealed member Vy context may open the audio of the meeting this file is a segment of: audio_for_member_vy answers for it (it refuses with 42501
-- unless the run is live, the member is the meeting's recorder and is active, and the key exists). Returns a boolean only, never a row.
CREATE OR REPLACE FUNCTION crove_meetings.member_vy_reads_media_file(p_org_id uuid, p_file_id uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_meeting uuid;
BEGIN
  IF crove_kernel.ctx_actor_type() IS DISTINCT FROM 'agent' OR p_org_id IS DISTINCT FROM crove_kernel.ctx_org_id() THEN
    RETURN false;
  END IF;
  SELECT s.meeting_id INTO v_meeting
  FROM crove_meetings.audio_segment s
  WHERE s.org_id = p_org_id AND s.file_id = p_file_id
  LIMIT 1;
  IF v_meeting IS NULL THEN
    RETURN false;
  END IF;
  PERFORM 1 FROM crove_meetings.audio_for_member_vy(p_org_id, v_meeting) LIMIT 1;
  RETURN FOUND;
EXCEPTION WHEN insufficient_privilege THEN
  RETURN false;
END;
$$;
REVOKE ALL ON FUNCTION crove_meetings.member_vy_reads_media_file(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_meetings.member_vy_reads_media_file(uuid, uuid) TO crove_tenant, crove_worker;
