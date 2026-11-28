-- SPDX-License-Identifier: AGPL-3.0-only
-- Ludy finance (issue #2199, follow-up of the conflict check of #2191): an index for the lookup of an account's keyless, flagged bank lines by their reference.
-- Idempotent; applied files stay untouched.
--
-- The conflict check (modules/finance/src/bank.ts, storedFacts) looks the lines a batch meets up in two ways: the keyed ones through the unique index bank_line_dedupe_uq, and, next to them, the
-- keyless lines that were stored flagged `ambiguous` (a line stored as a conflict has no key, #2191) by their reference:
--     WHERE org_id = $1 AND legal_entity_id = $2 AND bank_account = $3 AND dedupe_key IS NULL AND ambiguous = true AND bank_ref IN (...)
-- No index covered bank_ref, so that lookup read the account's lines through bank_line_account_date_idx, as far as the account's history goes, once per preview, stage, confirm, feed pull and opening of
-- the line panel. This partial index holds exactly the keyless flagged lines, by the same four columns the lookup filters on, so it stays as small as the conflicts and the lookup is bounded by them.
-- The predicate is written as the lookup writes it (`ambiguous = true`), so the planner proves it from the query. bank_line is not one of the hot tables (audit_event, the outbox, ludy_jobs), so
-- the build is an ordinary one in the migration's transaction.
SET LOCAL lock_timeout = '2s';

CREATE INDEX IF NOT EXISTS bank_line_keyless_ref_idx
  ON ludy_finance.bank_line (org_id, legal_entity_id, bank_account, bank_ref)
  WHERE dedupe_key IS NULL AND ambiguous = true;
