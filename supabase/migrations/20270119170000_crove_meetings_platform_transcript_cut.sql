-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove Meetings (issue #3922, a follow-up of #3919): tell the member when a platform's transcript was cut. A transcript longer than the adapter reads (Google Meet's 5000 entries, Teams' file cap) or
-- than the draft takes (TRANSCRIPT_SEGMENTS_MAX lines) is imported as far as it goes, and until now nothing on the screen said the draft stops early. The import job stages the fact beside the lines, the
-- claim route hands it to meetings.import.take_transcript, and this column keeps it for the meeting's page to read. Idempotent; applied files stay untouched.
--
-- platform_transcript_cut: true while the meeting's draft is a platform's transcript that was cut. A flag, never text or personal data. Set by meetings.import.take_transcript in the same transaction as the
-- lines and cleared by replaceDraft when the draft is replaced from any other source (the recorder's own transcription), so the note never outlives the partial draft. The default is false, which is
-- what every meeting that exists now is: a constant default is a catalog change only, no table rewrite. The column grant is the recording_stop_reason pattern (20261230110000): the commands that write
-- the draft run as crove_tenant and update this column and no other new one; it is not insertable (a meeting is created with the flag false).
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_meetings.meeting ADD COLUMN IF NOT EXISTS platform_transcript_cut boolean NOT NULL DEFAULT false;

GRANT UPDATE (platform_transcript_cut) ON crove_meetings.meeting TO crove_tenant;
