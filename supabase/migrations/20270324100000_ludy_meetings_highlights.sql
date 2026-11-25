-- SPDX-License-Identifier: AGPL-3.0-only
-- Meetings highlights (#4819): a reader or the recorder marks a transcript line, or a range of lines, as a highlight. Idempotent; applied files stay untouched.
--
-- ludy_meetings.meeting_highlight  one row per mark: `created_by` (the member who marked, always the caller), `start_seconds` and `end_seconds` (whole seconds, 0 to 86400, the start second of the
--                                  first and of the last line of the mark; equal for a single line). The row holds NO text of its own: the lines are read from the transcript each time a highlight is
--                                  shown, so what a reader sees is exactly what the transcript shows them (a redacted line shows redacted, a line that is no longer there shows nothing), and the
--                                  retention is the transcript's: a row goes with its meeting (ON DELETE CASCADE: the recorder's delete, an owner's delete, the text retention shred, the org purge).
--                                  Because it holds no text, the personal-data finder and the erasure have nothing to reach here (an optional note would be text, and is not part of this table).
--
-- Who may do what is in the row policies, not in the queries, and every policy admits a user context only: an agent context (a member Vy run included), the system context and the sealed company
-- context read and write none.
--   read    the recorder of the meeting and its readers (the same people who read the transcript; an owner or admin has no extra right, ADR-0047).
--   insert  the recorder or a reader, for themselves only (created_by is the caller).
--   delete  the member who marked it, or the recorder of the meeting.
--   update  nobody: a mark is added or removed, never edited (no UPDATE grant for the login role).
-- The command checks the same again, only accepts a second at which a PUBLISHED line starts (the readers read published lines only, so a mark on the recorder's draft would tell them where it is), and caps the marks of one member in one meeting.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS ludy_meetings.meeting_highlight (
  org_id uuid NOT NULL REFERENCES ludy_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT ludy_kernel.uuid_v7(),
  meeting_id uuid NOT NULL,
  created_by uuid NOT NULL,
  start_seconds integer NOT NULL CHECK (start_seconds BETWEEN 0 AND 86400),
  end_seconds integer NOT NULL CHECK (end_seconds BETWEEN 0 AND 86400),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT meeting_highlight_range_ck CHECK (end_seconds >= start_seconds),
  CONSTRAINT meeting_highlight_meeting_fk FOREIGN KEY (org_id, meeting_id) REFERENCES ludy_meetings.meeting (org_id, id) ON DELETE CASCADE,
  -- The same member marking the same range twice is one mark.
  CONSTRAINT meeting_highlight_range_uq UNIQUE (org_id, meeting_id, created_by, start_seconds, end_seconds)
);

CREATE INDEX IF NOT EXISTS meeting_highlight_meeting_idx ON ludy_meetings.meeting_highlight (org_id, meeting_id, start_seconds, end_seconds);

SELECT ludy_kernel.apply_tenant_rls('ludy_meetings.meeting_highlight');
-- A mark is never edited.
REVOKE UPDATE ON ludy_meetings.meeting_highlight FROM ludy_tenant;

-- The recorder and the readers of the meeting read every mark (a user context only: ctx_actor_type() is 'user' for a signed-in member alone).
DROP POLICY IF EXISTS meeting_highlight_read ON ludy_meetings.meeting_highlight;
CREATE POLICY meeting_highlight_read ON ludy_meetings.meeting_highlight AS RESTRICTIVE FOR SELECT TO ludy_tenant
  USING (ludy_kernel.ctx_actor_type() = 'user' AND (ludy_meetings.is_meeting_recorder(org_id, meeting_id) OR ludy_meetings.is_meeting_reader(org_id, meeting_id)));
-- The recorder or a reader inserts a mark, and only in their own name.
DROP POLICY IF EXISTS meeting_highlight_insert ON ludy_meetings.meeting_highlight;
CREATE POLICY meeting_highlight_insert ON ludy_meetings.meeting_highlight AS RESTRICTIVE FOR INSERT TO ludy_tenant
  WITH CHECK (
    ludy_kernel.ctx_actor_type() = 'user'
    AND created_by = (SELECT ludy_kernel.ctx_user_id())
    AND (ludy_meetings.is_meeting_recorder(org_id, meeting_id) OR ludy_meetings.is_meeting_reader(org_id, meeting_id))
  );
-- The member who marked removes their own mark; the recorder removes any mark of their meeting. A member who is no longer a reader cannot remove their old mark (they cannot see it either).
DROP POLICY IF EXISTS meeting_highlight_delete ON ludy_meetings.meeting_highlight;
CREATE POLICY meeting_highlight_delete ON ludy_meetings.meeting_highlight AS RESTRICTIVE FOR DELETE TO ludy_tenant
  USING (
    ludy_kernel.ctx_actor_type() = 'user'
    AND (
      ludy_meetings.is_meeting_recorder(org_id, meeting_id)
      OR (created_by = (SELECT ludy_kernel.ctx_user_id()) AND ludy_meetings.is_meeting_reader(org_id, meeting_id))
    )
  );
