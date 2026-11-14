-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove meetings A1 (issue #3159, plan docs/plan/meetings-integrations.md section 4.1): the recording notice and the always-visible
-- recording indicator. Idempotent; applied files stay untouched.
--
-- 1. consent_method takes 'in_call_chat': the recorder pasted the recording notice in the call's chat. The three older values stay.
-- 2. recording_stop_reason: a code (never text) saying why a recording stopped without the recorder's own click (tab closed, microphone
--    or permission lost, storage full, the recorder screen left). NULL for a recording the recorder stopped. The stop time is ended_at,
--    which meetings.meeting.recording_stopped sets together with it. A column grant keeps it writable only through that command.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_meetings.meeting DROP CONSTRAINT IF EXISTS meeting_consent_method_check;
ALTER TABLE crove_meetings.meeting ADD CONSTRAINT meeting_consent_method_check CHECK (consent_method IN ('told_at_start', 'in_invite', 'in_writing', 'in_call_chat'));

ALTER TABLE crove_meetings.meeting ADD COLUMN IF NOT EXISTS recording_stop_reason text;
ALTER TABLE crove_meetings.meeting DROP CONSTRAINT IF EXISTS meeting_recording_stop_reason_check;
ALTER TABLE crove_meetings.meeting ADD CONSTRAINT meeting_recording_stop_reason_check CHECK (recording_stop_reason IS NULL OR recording_stop_reason IN ('tab_closed', 'mic_lost', 'permission_lost', 'storage_full', 'left_screen', 'unknown'));

GRANT UPDATE (recording_stop_reason) ON crove_meetings.meeting TO crove_tenant;
