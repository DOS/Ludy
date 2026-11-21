-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #4218, Tingee #2045 S4b): the day a mapped bank feed account takes over from statement files.
-- From `feed_from` on (inclusive) the feed supplies the account's lines, so a statement file imported for that bank
-- account skips its lines on or after the date (with a warning) instead of storing them a second time under another key.
-- Null (the default) means no cut-over: files and the feed are deduplicated as before. Idempotent; applied files stay
-- untouched.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_finance.bank_feed_account ADD COLUMN IF NOT EXISTS feed_from date;
-- An owner or admin sets it through finance.bank_feed.map; the same column-level grant as the account's other fields.
GRANT UPDATE (feed_from) ON crove_finance.bank_feed_account TO crove_tenant;
