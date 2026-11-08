-- SPDX-License-Identifier: AGPL-3.0-only
-- Meeting media file rows are visible only to the meeting's readers (#2874, ADR-0047).
-- Until now crove_kernel.file carried only tenant_isolation, so every org member saw the file rows of meeting audio and video (filename with the meeting id, size,
-- creator). No earlier migration defines another policy on this table, so there is no body to restate: this adds one RESTRICTIVE SELECT policy beside tenant_isolation.
-- Visible rows: any file that is not meeting media (tested first, so ordinary rows never reach the probes); every row to the system context (worker sweeps, orphan
-- scan, org purge); the creator's own row while the creator still holds a base role of owner, admin or member (an upload is inserted before its segment or video row
-- exists); a meeting media row whose segment or video row names a meeting the sealed context's user reads (crove_meetings.is_meeting_reader); and, to a member Vy
-- run (actor agent), a segment file of a meeting that run may open (member_vy_reads_media_file below, which asks audio_for_member_vy and so repeats none of its checks).
-- The owner's compliance path stays the meeting_owner_list / meeting_owner_delete definers. No index is built on the hot file table: the probes use
-- audio_segment_file_idx and meeting_video_file_idx.
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

DROP POLICY IF EXISTS file_meeting_media_read ON crove_kernel.file;
CREATE POLICY file_meeting_media_read ON crove_kernel.file AS RESTRICTIVE FOR SELECT TO crove_tenant
  USING (
    source NOT IN ('meeting_audio', 'meeting_video')
    OR crove_kernel.ctx_actor_type() = 'system'
    OR (
      crove_kernel.ctx_actor_type() = 'user'
      AND created_by = (SELECT crove_kernel.ctx_user_id())
      AND EXISTS (
        SELECT 1 FROM crove_kernel.tenant_member m
        WHERE m.org_id = file.org_id AND m.user_id = created_by AND m.role IN ('owner', 'admin', 'member')
      )
    )
    OR (
      crove_kernel.ctx_actor_type() = 'user'
      AND (
        EXISTS (
          SELECT 1 FROM crove_meetings.audio_segment s
          WHERE s.org_id = file.org_id AND s.file_id = file.id AND crove_meetings.is_meeting_reader(s.org_id, s.meeting_id)
        )
        OR EXISTS (
          SELECT 1 FROM crove_meetings.meeting_video v
          WHERE v.org_id = file.org_id AND v.file_id = file.id AND crove_meetings.is_meeting_reader(v.org_id, v.meeting_id)
        )
      )
    )
    OR (crove_kernel.ctx_actor_type() = 'agent' AND crove_meetings.member_vy_reads_media_file(org_id, id))
  );
