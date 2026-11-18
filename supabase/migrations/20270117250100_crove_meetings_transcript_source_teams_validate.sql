-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove meetings integrations C4 (#3176, step C): validates the constraint 20270117250000 replaced NOT VALID. Every existing row is 'ludy' or 'google_meet', so it passes. Idempotent.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_meetings.transcript_segment VALIDATE CONSTRAINT transcript_segment_source_check;
