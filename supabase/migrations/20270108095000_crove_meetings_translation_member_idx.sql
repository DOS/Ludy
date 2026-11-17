-- SPDX-License-Identifier: AGPL-3.0-only
-- An index for the per-member reads of crove_meetings.translation (#3194): the 30-day purge of a removed member's Vy rows (20270108100000, a crove_kernel migration) lists the users who have translations,
-- takes the newest translation date of one user and deletes one user's rows, always by (org, member). The table's only matching key was its unique key over (org, meeting, member, ...), so each of those
-- read every translation of the org. result and memory rows have the same index (20261128090000). The table is not a hot table, so a plain build is allowed. Idempotent.
SET LOCAL lock_timeout = '2s';

CREATE INDEX IF NOT EXISTS translation_member_idx ON crove_meetings.translation (org_id, member_user_id, created_at);
