-- SPDX-License-Identifier: AGPL-3.0-only
-- #2878: a recorder links only media file rows they created. Restated from the newest body of both policies (20261124130000_crove_meetings_core.sql, the only
-- migration that defines them): audio_segment_insert and meeting_video_insert asked only that the caller records the meeting, so a recorder could name any file id of
-- the org in their own meeting's segment or video row. The linked file must now be of the matching source and created by the caller; nothing else in either policy changes.
-- The file check is a SECURITY DEFINER helper because of RLS recursion: once the SELECT policy on crove_kernel.file for meeting media (#2874, PR #2875) exists, it reads
-- audio_segment and meeting_video, so an insert check on those tables that read the file table under RLS would loop back into itself (SQLSTATE 42P17). The helper reads the
-- file row as its owner, without RLS, and answers a boolean only: false outside a user context, for another org, when the file id is null, and for any file that is not the
-- caller's own media file of that kind. It works with or without that policy on main.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_meetings.is_own_meeting_media_file(p_org_id uuid, p_file_id uuid, p_kind text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_user uuid := crove_kernel.ctx_user_id();
BEGIN
  IF crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' OR v_user IS NULL OR p_org_id IS DISTINCT FROM crove_kernel.ctx_org_id() OR p_file_id IS NULL THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM crove_kernel.file f
    WHERE f.org_id = p_org_id AND f.id = p_file_id AND f.created_by = v_user
      AND f.source = CASE p_kind WHEN 'audio' THEN 'meeting_audio' WHEN 'video' THEN 'meeting_video' END
  );
END;
$$;
REVOKE ALL ON FUNCTION crove_meetings.is_own_meeting_media_file(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_meetings.is_own_meeting_media_file(uuid, uuid, text) TO crove_tenant;

DROP POLICY IF EXISTS audio_segment_insert ON crove_meetings.audio_segment;
CREATE POLICY audio_segment_insert ON crove_meetings.audio_segment AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK (
    crove_meetings.is_meeting_recorder(org_id, meeting_id)
    AND crove_meetings.is_own_meeting_media_file(org_id, file_id, 'audio')
  );

DROP POLICY IF EXISTS meeting_video_insert ON crove_meetings.meeting_video;
CREATE POLICY meeting_video_insert ON crove_meetings.meeting_video AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK (
    crove_meetings.is_meeting_recorder(org_id, meeting_id)
    AND crove_meetings.is_own_meeting_media_file(org_id, file_id, 'video')
  );
