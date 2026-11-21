-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #4244, Tingee #2045): how the last pull of a mapped bank feed account ended, so the card can say why a pull stopped. Idempotent; applied files stay untouched.
--
-- `last_pull_outcome` is `ok` after a pull that was stored (finance.bank_feed.record_pull sets it in the same transaction as the lines and the cursor) or the closed kind of the refusal that stopped the last one
-- (finance.bank_feed.record_outcome, the sync's own command): a refused credential, the server's clock, a rate limit, an upstream answer that was not understood, a connection that cannot be read, a page with a line
-- that cannot be read, or a day with more lines than one pull may carry. `last_pull_item` is the refused line's position in the page (0-based) and goes only with `bad_page`. Null means no pull yet.
-- Nothing of a provider's own text is kept: a kind from a closed list and a small integer. The three columns are written by the commands above under the account's own RLS and entity scope, so the same
-- column-level grant as `cursor` and `last_synced_at` is all they need; no new table, so nothing for the org purge or the personal-data registry to learn (the columns hold no personal data).
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_finance.bank_feed_account ADD COLUMN IF NOT EXISTS last_pull_outcome text
  CHECK (last_pull_outcome IN ('ok', 'credentials', 'clock', 'rate_limited', 'upstream', 'config', 'bad_page', 'too_many_lines'));
ALTER TABLE crove_finance.bank_feed_account ADD COLUMN IF NOT EXISTS last_pull_outcome_at timestamptz;
ALTER TABLE crove_finance.bank_feed_account ADD COLUMN IF NOT EXISTS last_pull_item integer
  CHECK (last_pull_item BETWEEN 0 AND 100000);

-- The three agree: all null before the first pull; otherwise a kind and its time, and a line position only for a page with a bad line.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'bank_feed_account_last_pull_ck' AND conrelid = 'crove_finance.bank_feed_account'::regclass
  ) THEN
    ALTER TABLE crove_finance.bank_feed_account ADD CONSTRAINT bank_feed_account_last_pull_ck CHECK (
      (last_pull_outcome IS NULL AND last_pull_outcome_at IS NULL AND last_pull_item IS NULL)
      OR (last_pull_outcome IS NOT NULL AND last_pull_outcome_at IS NOT NULL AND (last_pull_item IS NULL OR last_pull_outcome = 'bad_page'))
    );
  END IF;
END $$;

GRANT UPDATE (last_pull_outcome, last_pull_outcome_at, last_pull_item) ON crove_finance.bank_feed_account TO crove_tenant;
