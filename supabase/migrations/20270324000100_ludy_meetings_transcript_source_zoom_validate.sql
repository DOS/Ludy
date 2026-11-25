-- SPDX-License-Identifier: AGPL-3.0-only
-- Ludy meetings integrations C3 (#3175, gap 2): validates the constraint 20270324000000 replaced NOT VALID. Every existing row is 'ludy', 'google_meet' or 'microsoft_teams', so it passes. Idempotent.
SET LOCAL lock_timeout = '2s';

ALTER TABLE ludy_meetings.transcript_segment VALIDATE CONSTRAINT transcript_segment_source_check;
