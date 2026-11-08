-- SPDX-License-Identifier: AGPL-3.0-only
-- The queue of the live calendar check before a booking is decided (#2139, part of #1374). Idempotent; applied files stay untouched.
--
-- Added here:
--   crm-booking-live  a visitor's booking request (crm.booking.requested) or manage ask (crm.booking.manage_requested): the worker first
--                     asks the hosts' connected Google calendars whether the slot is busy right now, adds what it sees to the
--                     stored busy blocks, then runs crm.booking.confirm or crm.booking.manage as the crm-booking queue did. The
--                     crm-booking queue keeps the member events and any job already queued when this lands.
SET LOCAL lock_timeout = '2s';

SELECT crove_jobs.create_queue('crm-booking-live', '{"policy":"standard","deadLetter":"kernel-job.dlq"}'::jsonb);
