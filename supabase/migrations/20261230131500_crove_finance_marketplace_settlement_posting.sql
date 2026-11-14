-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #2516, ADR-0045 point 6, plan stock-and-marketplaces.md section 8.4): the posting of a stored marketplace settlement as ONE general journal voucher. Idempotent; applied
-- files stay untouched.
--
-- crove_finance.journal_voucher.settlement_id  the voucher that posts a settlement names it (the id of a crove_finance.channel_settlement), one per settlement: a unique index makes "approving the
--                                              proposal posts once" a fact of the database, not only of the command. Such a voucher is no year closing, no close of a month of stock, no count
--                                              and no pay run posting, and it names the proposal that approved it. The settlement is in the same schema, but the column carries no foreign key,
--                                              like the voucher's other sources: the posting is the entry's own record and never blocks the settlement's purge.
-- The trigger and the ledger effect of the new command are in 20261230131600, its approval policy in 20261230131700 (the kernel's own migration: a finance migration touches no crove_kernel object).
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_finance.journal_voucher ADD COLUMN IF NOT EXISTS settlement_id uuid;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'journal_voucher_settlement' AND conrelid = 'crove_finance.journal_voucher'::regclass) THEN
    ALTER TABLE crove_finance.journal_voucher
      ADD CONSTRAINT journal_voucher_settlement CHECK (settlement_id IS NULL OR (closing_year IS NULL AND stock_closing_month IS NULL AND stock_count_id IS NULL AND payroll_run_id IS NULL AND proposal_id IS NOT NULL));
  END IF;
END
$$;
CREATE UNIQUE INDEX IF NOT EXISTS journal_voucher_settlement_uq ON crove_finance.journal_voucher (org_id, settlement_id) WHERE settlement_id IS NOT NULL;
