-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove kernel (issue #1375, calendar plan step C7): crove_kernel.calendar_event.conference, the flag that asks the provider to make a conference (a Google Meet)
-- for the event when the C6 write-back writes it. The booking of a Meet event type sets it in the same transaction as its event; the system command
-- crm.booking.meeting_settle clears it once the outcome is known. Idempotent; applied files stay untouched. Its own file, in the kernel's schema, apart from
-- the crm migration that needs it (20261121160000).
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_kernel.calendar_event ADD COLUMN IF NOT EXISTS conference boolean NOT NULL DEFAULT false;
