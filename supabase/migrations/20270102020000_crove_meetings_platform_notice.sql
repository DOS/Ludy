-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove meetings C1 (issue #3173, plan docs/plan/meetings-integrations.md section 6.1): the consent method of an imported recording. consent_method takes 'platform_notice': the platform showed its
-- own recording notice to everyone in the call, and the importer confirms it. The four older values stay. Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_meetings.meeting DROP CONSTRAINT IF EXISTS meeting_consent_method_check;
ALTER TABLE crove_meetings.meeting ADD CONSTRAINT meeting_consent_method_check CHECK (consent_method IN ('told_at_start', 'in_invite', 'in_writing', 'in_call_chat', 'platform_notice'));
