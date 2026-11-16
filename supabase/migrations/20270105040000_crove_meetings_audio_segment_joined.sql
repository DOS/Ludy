-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove meetings, issue #3187 (ADR-0052 L4a-3 follow-up): a late complete upload may replace a recording that was joined from the live pieces.
-- The joined recording is the fallback for a lost upload and may have gaps. When the complete recording then arrives (the extension keeps its device
-- copy and retries), meetings.media.record replaces the joined segment in one transaction, under the meeting's media lock, as long as no transcript or
-- summary was made from the joined audio. To know which segment was joined, audio_segment gets a flag, set when the row is written (the recorder holds
-- INSERT on the table and no UPDATE, so the flag cannot be changed afterwards). Idempotent; applied files stay untouched.
--
-- 1. crove_meetings.audio_segment.joined_from_pieces: true for a segment recorded by meetings.live.assemble_record, false for an upload.
-- 2. Backfill: a segment of a meeting whose audit trail holds an ok meetings.live.assemble_record is marked joined, so a recording joined before this
--    change can be replaced too. The audit row is the only trace of a join there was.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_meetings.audio_segment ADD COLUMN IF NOT EXISTS joined_from_pieces boolean NOT NULL DEFAULT false;

-- migration-lint: cross-module reads the audit trail once to mark the joins made before this column existed
UPDATE crove_meetings.audio_segment s
SET joined_from_pieces = true
WHERE NOT s.joined_from_pieces
  AND EXISTS (
    SELECT 1 FROM crove_kernel.audit_event a
    WHERE a.org_id = s.org_id
      AND a.command = 'meetings.live.assemble_record'
      AND a.outcome = 'ok'
      AND a.target_id = s.meeting_id
  );
