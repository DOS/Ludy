-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #2402, part B): the counterparty's account number on a bank statement line. Idempotent; applied files stay
-- untouched.
--
-- bank_line.counterparty_account  the other side's account number as a statement's "counterparty account" column prints it, digits only
--                                 (6 to 20), NULL when the file has no such column or the cell is no account number. Kept with the
--                                 line it came from, which is append-only evidence for the books like the rest of the line (the
--                                 manifest classes it as `payment`, and the personal-data list names it). The matcher reads it to
--                                 find the party a person matched to this account before (bank_party_rule of kind 'account', keyed
--                                 hash only); the number itself is never copied into a rule.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_finance.bank_line ADD COLUMN IF NOT EXISTS counterparty_account text;
-- Added NOT VALID and validated after, so the table is not held for the scan of its rows (every one is NULL).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'bank_line_counterparty_account_digits' AND conrelid = 'crove_finance.bank_line'::regclass) THEN
    ALTER TABLE crove_finance.bank_line ADD CONSTRAINT bank_line_counterparty_account_digits CHECK (counterparty_account IS NULL OR counterparty_account ~ '^[0-9]{6,20}$') NOT VALID;
  END IF;
END $$;
ALTER TABLE crove_finance.bank_line VALIDATE CONSTRAINT bank_line_counterparty_account_digits;
