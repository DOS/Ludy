-- SPDX-License-Identifier: AGPL-3.0-only
-- #2874: a recorder links only media file rows they created. Restated from the newest body of both policies (20261124130000_crove_meetings_core.sql, the only
-- migration that defines them): audio_segment_insert and meeting_video_insert asked only that the caller records the meeting, so a recorder could name any file id
-- of the org (including another meeting's media row) in their own meeting's segment or video row and so read it through the file policy. The referenced file must now be
-- of the matching source and created by the caller. Nothing else in either policy changes.
SET LOCAL lock_timeout = '2s';

DROP POLICY IF EXISTS audio_segment_insert ON crove_meetings.audio_segment;
CREATE POLICY audio_segment_insert ON crove_meetings.audio_segment AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK (
    crove_meetings.is_meeting_recorder(org_id, meeting_id)
    AND EXISTS (
      SELECT 1 FROM crove_kernel.file f
      WHERE f.org_id = audio_segment.org_id AND f.id = audio_segment.file_id AND f.source = 'meeting_audio' AND f.created_by = (SELECT crove_kernel.ctx_user_id())
    )
  );

DROP POLICY IF EXISTS meeting_video_insert ON crove_meetings.meeting_video;
CREATE POLICY meeting_video_insert ON crove_meetings.meeting_video AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK (
    crove_meetings.is_meeting_recorder(org_id, meeting_id)
    AND EXISTS (
      SELECT 1 FROM crove_kernel.file f
      WHERE f.org_id = meeting_video.org_id AND f.id = meeting_video.file_id AND f.source = 'meeting_video' AND f.created_by = (SELECT crove_kernel.ctx_user_id())
    )
  );
