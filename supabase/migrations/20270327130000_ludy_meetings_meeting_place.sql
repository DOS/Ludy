-- SPDX-License-Identifier: AGPL-3.0-only
-- Meetings A4 follow-up (issue #5013, refs #3162): the place of a meeting, set once by the recorder and printed on the biên bản. Idempotent; applied files stay untouched.
--
-- ludy_meetings.meeting.place  free text the recorder types ("Phòng họp tầng 3, 12 Nguyễn Huệ"): NULL when none, else 1 to 200 characters on one line (the title's bounds, cleaned
--                              the way a title is by meetings.meeting.set_place). It may name or describe a person or an address, so the manifest classes it as pii; it is not
--                              yet read by the personal-data finder and the erasure (listed in PERSONAL_DATA_PENDING, see the PR); it goes with the meeting row (delete, owner
--                              delete, text retention, org purge) and with the org export of an org-shared meeting (the export function returns the whole row).
--                              Only the recorder writes it: the table's UPDATE policy admits the recorder alone, and the column grant below is for meetings.meeting.set_place only.
--                              Readers see it where they see the title (the meeting's own read).
SET LOCAL lock_timeout = '2s';

ALTER TABLE ludy_meetings.meeting ADD COLUMN IF NOT EXISTS place text;
ALTER TABLE ludy_meetings.meeting DROP CONSTRAINT IF EXISTS meeting_place_check;
ALTER TABLE ludy_meetings.meeting ADD CONSTRAINT meeting_place_check CHECK (place IS NULL OR (pg_catalog.char_length(place) BETWEEN 1 AND 200 AND place !~ '[\r\n]'));

GRANT UPDATE (place) ON ludy_meetings.meeting TO ludy_tenant;
