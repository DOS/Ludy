-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove meetings, issue #3187 (ADR-0052 L4a-3 follow-up): a late complete upload may replace a recording that was joined from the live pieces.
-- The joined recording is the fallback for a lost upload and may have gaps. When the complete recording then arrives (the extension keeps its device
-- copy and retries), meetings.media.record replaces the joined segment in one transaction, under the meeting's media lock, as long as no transcript or
-- summary was made from the joined audio. To know which segment was joined, audio_segment gets a flag, set when the row is written (the recorder holds
-- INSERT on the table and no UPDATE, so the flag cannot be changed afterwards). Idempotent; applied files stay untouched.
--
-- 1. crove_meetings.audio_segment.joined_from_pieces: true for a segment recorded by meetings.live.assemble_record, false for an upload.
-- 2. crove_meetings.meeting.audio_used_at: when a transcription or a summary was started on the meeting's recording. The recorder's own Vy runs are private rows
--    the meetings module may not read, so the two start commands leave this trace on the meeting, under the media lock, and the replacement checks it. The recorder
--    holds the column grant (the meeting's update policy is already the recorder's alone).
-- 3. Backfill: a segment of a meeting whose audit trail holds an ok meetings.live.assemble_record is marked joined, and a meeting with a joined segment whose audit
--    trail holds an ok start of a transcription or a summary gets the time of the first, so a recording joined before this change can be replaced too (and one that was
--    already used is not). The audit rows are the only trace there was.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_meetings.audio_segment ADD COLUMN IF NOT EXISTS joined_from_pieces boolean NOT NULL DEFAULT false;

ALTER TABLE crove_meetings.meeting ADD COLUMN IF NOT EXISTS audio_used_at timestamptz;
GRANT UPDATE (audio_used_at) ON crove_meetings.meeting TO crove_tenant;

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

-- migration-lint: cross-module reads the audit trail once to mark the meetings whose joined recording was already used
UPDATE crove_meetings.meeting m
SET audio_used_at = used.first_at
FROM (
  SELECT a.org_id, a.target_id, pg_catalog.min(a.occurred_at) AS first_at
  FROM crove_kernel.audit_event a
  WHERE a.command IN ('meetings.transcript.start', 'meetings.summary.start') AND a.outcome = 'ok'
  GROUP BY a.org_id, a.target_id
) used
WHERE m.audio_used_at IS NULL
  AND m.org_id = used.org_id
  AND m.id = used.target_id
  AND EXISTS (SELECT 1 FROM crove_meetings.audio_segment s WHERE s.org_id = m.org_id AND s.meeting_id = m.id AND s.joined_from_pieces);
