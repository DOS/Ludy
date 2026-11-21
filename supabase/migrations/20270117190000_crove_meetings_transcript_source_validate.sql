-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove meetings integrations C2 (#3174, PR A): validates the constraint 20270117180000 added NOT VALID. Every existing row has the default 'ludy', so it passes. Idempotent.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_meetings.transcript_segment VALIDATE CONSTRAINT transcript_segment_source_check;
