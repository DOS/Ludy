-- SPDX-License-Identifier: AGPL-3.0-only
-- Meeting labels (#4955, plan docs/plan/meetings.md L28): the recorder puts up to five short plain-text labels on a meeting ("Khách Hoa Sen", "Dự án website", "Họp tuần"), and the meetings list filters by them, so a
-- business with no CRM data can group "everything about this client". Idempotent; applied files stay untouched.
--
-- ludy_meetings.meeting_label  one row per label: `label` (1 to 40 characters, no edge spaces; the command also refuses a line break, an "@" and a run of seven digits, so it is not a place for an address, a phone
--                              number or an ID), `created_by` (the recorder, always the caller). The same label on the same meeting twice, whatever the case, is one label (a unique index on the lower-cased text).
--                              At most five labels a meeting: the command counts them under a lock on the meeting, as the highlights do (a table check cannot count other rows). The row holds no transcript text and no name
--                              of a person by design; the page says so where the label is typed. A row goes with its meeting (ON DELETE CASCADE: the recorder's delete, an owner's delete, the org purge).
--
-- Who may do what is in the row policies, not in the queries, and every policy admits a user context only: an agent context (a member Vy run included), the system context and the sealed company context read and
-- write none.
--   read    the recorder of the meeting and its readers (the same people who read the meeting; an owner or admin has no extra right, ADR-0047). A label never tells anyone a meeting exists.
--   insert  the recorder, in their own name (created_by is the caller).
--   delete  the recorder.
--   update  nobody: a label is added or removed, never edited (no UPDATE grant for the login role).
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS ludy_meetings.meeting_label (
  org_id uuid NOT NULL REFERENCES ludy_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT ludy_kernel.uuid_v7(),
  meeting_id uuid NOT NULL,
  label text NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT meeting_label_text_ck CHECK (label = pg_catalog.btrim(label) AND pg_catalog.char_length(label) BETWEEN 1 AND 40),
  CONSTRAINT meeting_label_meeting_fk FOREIGN KEY (org_id, meeting_id) REFERENCES ludy_meetings.meeting (org_id, id) ON DELETE CASCADE
);

-- The same label on the same meeting twice is one label, whatever the case.
CREATE UNIQUE INDEX IF NOT EXISTS meeting_label_meeting_uq ON ludy_meetings.meeting_label (org_id, meeting_id, (pg_catalog.lower(label)));
-- The labels of the org's meetings, by label (the filter and the list of labels).
CREATE INDEX IF NOT EXISTS meeting_label_label_idx ON ludy_meetings.meeting_label (org_id, (pg_catalog.lower(label)), meeting_id);

SELECT ludy_kernel.apply_tenant_rls('ludy_meetings.meeting_label');
-- A label is never edited.
REVOKE UPDATE ON ludy_meetings.meeting_label FROM ludy_tenant;

-- The recorder and the readers of the meeting read its labels (a user context only: ctx_actor_type() is 'user' for a signed-in member alone).
DROP POLICY IF EXISTS meeting_label_read ON ludy_meetings.meeting_label;
CREATE POLICY meeting_label_read ON ludy_meetings.meeting_label AS RESTRICTIVE FOR SELECT TO ludy_tenant
  USING (ludy_kernel.ctx_actor_type() = 'user' AND (ludy_meetings.is_meeting_recorder(org_id, meeting_id) OR ludy_meetings.is_meeting_reader(org_id, meeting_id)));
-- Only the recorder puts a label on their meeting, and in their own name.
DROP POLICY IF EXISTS meeting_label_insert ON ludy_meetings.meeting_label;
CREATE POLICY meeting_label_insert ON ludy_meetings.meeting_label AS RESTRICTIVE FOR INSERT TO ludy_tenant
  WITH CHECK (
    ludy_kernel.ctx_actor_type() = 'user'
    AND created_by = (SELECT ludy_kernel.ctx_user_id())
    AND ludy_meetings.is_meeting_recorder(org_id, meeting_id)
  );
-- Only the recorder takes a label off their meeting.
DROP POLICY IF EXISTS meeting_label_delete ON ludy_meetings.meeting_label;
CREATE POLICY meeting_label_delete ON ludy_meetings.meeting_label AS RESTRICTIVE FOR DELETE TO ludy_tenant
  USING (ludy_kernel.ctx_actor_type() = 'user' AND ludy_meetings.is_meeting_recorder(org_id, meeting_id));
