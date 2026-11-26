-- SPDX-License-Identifier: AGPL-3.0-only
-- Keyset pagination index for ludy_meetings.meeting (#5052, refs #3519): meetings.meeting.list and meeting_owner_list_page
-- order by (COALESCE(started_at, created_at) DESC, id DESC) per org, while meeting_started_idx covers (org_id, started_at DESC)
-- only. This index lets first-page, cursor-paged, and searched reads scan in order and stop at LIMIT without a Sort node.
-- ludy_meetings.meeting is not a hot table, so a plain build is allowed. Idempotent.
SET LOCAL lock_timeout = '2s';

CREATE INDEX IF NOT EXISTS meeting_held_idx
  ON ludy_meetings.meeting (org_id, (COALESCE(started_at, created_at)) DESC, id DESC);
