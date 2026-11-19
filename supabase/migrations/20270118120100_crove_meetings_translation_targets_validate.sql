-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove meetings integrations E3 (#3186): validates the constraint 20270118120000 replaced NOT VALID. Every existing row is 'vi' or 'en', so it passes. Idempotent.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_meetings.translation VALIDATE CONSTRAINT translation_target_language_check;
