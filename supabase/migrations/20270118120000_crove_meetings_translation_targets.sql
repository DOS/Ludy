-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove meetings integrations E3 (#3186): Chinese, Japanese and Korean are languages a translation can be made INTO (a meeting is still held in 'vi' or 'en'). Idempotent; applied files stay untouched.
--   crove_meetings.translation.target_language
--       gains 'zh', 'ja' and 'ko' beside 'vi' and 'en'. The CHECK is replaced NOT VALID and validated in the next file, as 20270117250000 did for the transcript maker, so the migration holds no long
--       lock (every existing row is 'vi' or 'en', so it passes). Nothing else changes: the unique key already names the target language, so a member's translations into several languages are
--       several rows, and row security, the purge and the erasure functions read the table as before. Which of the three a deployment offers is the kernel's own switch (MEETINGS_TRANSLATION_LANGUAGES),
--       not the database's: the CHECK only says what the column may hold.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_meetings.translation DROP CONSTRAINT IF EXISTS translation_target_language_check;
ALTER TABLE crove_meetings.translation ADD CONSTRAINT translation_target_language_check CHECK (target_language IN ('vi', 'en', 'zh', 'ja', 'ko')) NOT VALID;
