-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #2516, ADR-0045 point 6, plan stock-and-marketplaces.md section 8.4 "The payout"): the posting of a platform's payout as ONE general journal voucher that names the
-- settlement it pays and the bank line of the transfer. Idempotent; applied files stay untouched.
--
-- crove_finance.journal_voucher.payout_settlement_id  the voucher that posts a payout names the settlement (a crove_finance.channel_settlement) it settles, one per settlement
-- crove_finance.journal_voucher.payout_bank_line_id   and the bank line (crove_finance.bank_line) of the platform's transfer, one per line
-- Both are set together, and such a voucher is no settlement posting, no year closing, no close of a month of stock, no count and no pay run posting, and it names the proposal that approved
-- it. The two unique indexes make "approving the proposal posts once" and "a line settles at most one payout" facts of the database, not only of the command. Neither column carries a foreign
-- key, like the voucher's other sources: the posting is the entry's own record and never blocks the purge of what it names.
-- The trigger and the ledger effect of the new command are in 20261231120000, its approval policy in 20261231130000 (the kernel's own migration).
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_finance.journal_voucher ADD COLUMN IF NOT EXISTS payout_settlement_id uuid;
ALTER TABLE crove_finance.journal_voucher ADD COLUMN IF NOT EXISTS payout_bank_line_id uuid;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'journal_voucher_payout' AND conrelid = 'crove_finance.journal_voucher'::regclass) THEN
    ALTER TABLE crove_finance.journal_voucher
      ADD CONSTRAINT journal_voucher_payout CHECK ((payout_settlement_id IS NULL AND payout_bank_line_id IS NULL)
        OR (payout_settlement_id IS NOT NULL AND payout_bank_line_id IS NOT NULL AND settlement_id IS NULL AND closing_year IS NULL AND stock_closing_month IS NULL AND stock_count_id IS NULL AND payroll_run_id IS NULL AND proposal_id IS NOT NULL));
  END IF;
END
$$;
CREATE UNIQUE INDEX IF NOT EXISTS journal_voucher_payout_settlement_uq ON crove_finance.journal_voucher (org_id, payout_settlement_id) WHERE payout_settlement_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS journal_voucher_payout_bank_line_uq ON crove_finance.journal_voucher (org_id, payout_bank_line_id) WHERE payout_bank_line_id IS NOT NULL;
