-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove meetings (issue #2578, ADR-0047 points 2 and 3, ADR-0049 stage A, meetings plan M4a): the transcript of a meeting as
-- timestamped segments. Idempotent; applied files stay untouched.
--
-- crove_meetings.transcript_segment  one spoken stretch of a meeting: where it starts and ends (seconds on the meeting's own
--                                    timeline), a speaker label, the text, and its stage.
-- A segment is born 'draft': the recorder's own working copy, which only the recorder reads, writes and corrects. Nobody
-- else reads a draft, whatever their role: not an attendee, not an owner or admin, not another member, not an agent or the
-- system context (the policies below name the recorder, and the recorder is a user in the org). 'published' is for the
-- recorder's one click of publishing (the summary step of the plan, M6): no row is inserted published here, and an attendee
-- reads only published rows of a meeting they may read. Text is personal data (class pii in the manifest). A segment goes
-- with its meeting (ON DELETE CASCADE: the recorder's delete, the retention shred, the org purge).
-- The write path that fills drafts for a recorder is a command, meetings.transcript.draft_store; the background run that
-- calls it as the recorder's own Vy is M4b (it waits for the member-scoped context of ADR-0049 stage B).
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_meetings.transcript_segment (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  meeting_id uuid NOT NULL,
  start_seconds numeric(10, 3) NOT NULL CHECK (start_seconds >= 0),
  end_seconds numeric(10, 3) NOT NULL,
  speaker_label text NOT NULL DEFAULT 'Người nói 1' CHECK (pg_catalog.char_length(speaker_label) BETWEEN 1 AND 80),
  text text NOT NULL CHECK (pg_catalog.char_length(text) BETWEEN 1 AND 4000),
  stage text NOT NULL DEFAULT 'draft' CHECK (stage IN ('draft', 'published')),
  -- True once the recorder edited the text or the label by hand.
  corrected boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT transcript_segment_meeting_fk FOREIGN KEY (org_id, meeting_id) REFERENCES crove_meetings.meeting (org_id, id) ON DELETE CASCADE,
  CONSTRAINT transcript_segment_span_ck CHECK (end_seconds >= start_seconds)
);
CREATE INDEX IF NOT EXISTS transcript_segment_meeting_idx ON crove_meetings.transcript_segment (org_id, meeting_id, start_seconds, id);

SELECT crove_kernel.apply_tenant_rls('crove_meetings.transcript_segment');
REVOKE UPDATE ON crove_meetings.transcript_segment FROM crove_tenant;
GRANT UPDATE (text, speaker_label, corrected, updated_at) ON crove_meetings.transcript_segment TO crove_tenant;

-- The recorder reads every stage; a reader of the meeting reads published rows only.
DROP POLICY IF EXISTS transcript_segment_read ON crove_meetings.transcript_segment;
CREATE POLICY transcript_segment_read ON crove_meetings.transcript_segment AS RESTRICTIVE FOR SELECT TO crove_tenant
  USING (
    crove_meetings.is_meeting_recorder(org_id, meeting_id)
    OR (stage = 'published' AND crove_meetings.is_meeting_reader(org_id, meeting_id))
  );

-- Only the recorder inserts, and only drafts.
DROP POLICY IF EXISTS transcript_segment_insert ON crove_meetings.transcript_segment;
CREATE POLICY transcript_segment_insert ON crove_meetings.transcript_segment AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK (stage = 'draft' AND crove_meetings.is_meeting_recorder(org_id, meeting_id));

-- The recorder corrects a draft's text and label (the column grant above); a published row is not edited here.
DROP POLICY IF EXISTS transcript_segment_update ON crove_meetings.transcript_segment;
CREATE POLICY transcript_segment_update ON crove_meetings.transcript_segment AS RESTRICTIVE FOR UPDATE TO crove_tenant
  USING (stage = 'draft' AND crove_meetings.is_meeting_recorder(org_id, meeting_id))
  WITH CHECK (stage = 'draft' AND crove_meetings.is_meeting_recorder(org_id, meeting_id));

-- The recorder deletes drafts (a new transcription replaces the old draft).
DROP POLICY IF EXISTS transcript_segment_delete ON crove_meetings.transcript_segment;
CREATE POLICY transcript_segment_delete ON crove_meetings.transcript_segment AS RESTRICTIVE FOR DELETE TO crove_tenant
  USING (stage = 'draft' AND crove_meetings.is_meeting_recorder(org_id, meeting_id));
