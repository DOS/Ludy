-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove meetings integrations C2 (#3174, PR A of the transcript-only import): whose transcription a transcript line is. Idempotent; applied files stay untouched.
--   crove_meetings.transcript_segment.source
--       'ludy' (Ludy's own transcription, or what the recorder typed: every row before this migration) or 'google_meet' (the transcript Google Meet wrote, taken by the import).
--       Set only by the INSERT of the recorder's own command; crove_tenant has no UPDATE on it (the column grant of 20261127300000 names text, speaker_label, corrected and
--       updated_at only, and this migration adds nothing to it), so a correction of a line's text keeps the label of the transcription it began as.
-- The default makes the new column a metadata-only change for the existing rows. The rows the import writes are born tainted (the rule of 20261216100000: a draft the recorder has not
-- read is never published), and the recorder clears the mark by reading the transcript like any other draft.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_meetings.transcript_segment ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'ludy' CHECK (source IN ('ludy', 'google_meet'));
