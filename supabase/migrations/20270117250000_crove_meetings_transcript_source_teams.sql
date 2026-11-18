-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove meetings integrations C4 (#3176, step C): the transcript Microsoft Teams wrote is a third maker of a transcript line. Idempotent; applied files stay untouched.
--   crove_meetings.transcript_segment.source
--       gains 'microsoft_teams' beside 'ludy' and 'google_meet'. The CHECK is replaced NOT VALID and validated in the next file, as 20270117180000 and 20270117190000 did, so the
--       migration holds no long lock on a big table (every existing row is 'ludy' or 'google_meet', so it passes).
--   The taint trigger (crove_meetings.transcript_segment_taint, 20270117180000) is NOT touched: it already refuses an insert whose source is not 'ludy' unless the row is tainted, and
--   refuses any change of source, so a Teams line is born unread and keeps its label without a new rule.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_meetings.transcript_segment DROP CONSTRAINT IF EXISTS transcript_segment_source_check;
ALTER TABLE crove_meetings.transcript_segment ADD CONSTRAINT transcript_segment_source_check CHECK (source IN ('ludy', 'google_meet', 'microsoft_teams')) NOT VALID;
