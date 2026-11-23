-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove meetings A4 (issue #3162, plan docs/plan/meetings-integrations.md section 4.3): the minutes template of a meeting. Idempotent; applied files stay
-- untouched.
--
-- crove_meetings.meeting.summary_template  a code, never text: which of the five minutes templates the recorder picked for this meeting. The sections of
--                                          a template, their hints for Vy and their titles live in code (packages/kernel-contract); the text of the
--                                          sections is stored in the existing summary column of meeting_result (see meetings.summary.save), so the
--                                          personal-data finders and the erasure already cover it. 'general' (Tom tat chung) is today's behavior and the default.
--                                          The recorder changes it with meetings.minutes.set_template (recorder only, through Runtime.execute); the column
--                                          grant below is for that command only.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_meetings.meeting ADD COLUMN IF NOT EXISTS summary_template text NOT NULL DEFAULT 'general';
ALTER TABLE crove_meetings.meeting DROP CONSTRAINT IF EXISTS meeting_summary_template_check;
ALTER TABLE crove_meetings.meeting ADD CONSTRAINT meeting_summary_template_check CHECK (summary_template IN ('general', 'briefing', 'customer', 'supplier', 'one_on_one'));

GRANT UPDATE (summary_template) ON crove_meetings.meeting TO crove_tenant;
