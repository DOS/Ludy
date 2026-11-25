-- SPDX-License-Identifier: AGPL-3.0-only
-- Ludy meetings integrations C3 (#3175, gap 2): the transcript Zoom wrote is a fourth maker of a transcript line. Idempotent; applied files stay untouched.
--   ludy_meetings.transcript_segment.source
--       gains 'zoom' beside 'ludy', 'google_meet' and 'microsoft_teams'. The CHECK is replaced NOT VALID and validated in the next file, as the Teams one (20270117250000) did, so the
--       migration holds no long lock on a big table (every existing row is 'ludy', 'google_meet' or 'microsoft_teams', so it passes).
--   The taint trigger (transcript_segment_taint, 20270117180000) is NOT touched: it already refuses an insert whose source is not 'ludy' unless the row is tainted, and refuses any
--   change of source, so a Zoom line is born unread and keeps its label without a new rule.
SET LOCAL lock_timeout = '2s';

ALTER TABLE ludy_meetings.transcript_segment DROP CONSTRAINT IF EXISTS transcript_segment_source_check;
ALTER TABLE ludy_meetings.transcript_segment ADD CONSTRAINT transcript_segment_source_check CHECK (source IN ('ludy', 'google_meet', 'microsoft_teams', 'zoom')) NOT VALID;
