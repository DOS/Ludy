-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove kernel, Meetings B1 (issue #3165, plan docs/plan/meetings-integrations.md section 5.1): the member's switch for reading the names and times of their own calendar meetings. Idempotent;
-- applied files stay untouched.
--
-- crove_kernel.calendar_connection.read_events
--                              The member's switch "Cho Ludy đọc tên và giờ cuộc họp trong lịch", off by default. The connection reads busy times only until it is on AND Google's grant carries the
--                              events-read scope (the kernel's connection_state answers both together). The member's own UPDATE grant gains this column, like the write-back switch.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_kernel.calendar_connection ADD COLUMN IF NOT EXISTS read_events boolean NOT NULL DEFAULT false;
GRANT UPDATE (read_events) ON crove_kernel.calendar_connection TO crove_tenant;
