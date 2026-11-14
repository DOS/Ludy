-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #2516, ADR-0045 point 6, plan stock-and-marketplaces.md section 8.4 "The payout" and section 11): the clearing of the fees a payout put on 1388 by the platform's fee
-- e-invoice, as ONE general journal voucher (Dr 331 / Cr 1388, the platform's party on both). Idempotent; applied files stay untouched.
--
-- crove_finance.journal_voucher.fee_document_id  the voucher that clears fees names the purchase document (a crove_finance.purchase_document, the platform's fee invoice) it clears. Not unique: an
--                                                invoice may be cleared in parts, as the fees wait and as payouts arrive; the sum of its standing clearings is capped at the invoice total by
--                                                the command, under the platform's lock (the database cannot see the sum). The column carries no foreign key, like the voucher's other
--                                                sources: the clearing is the entry's own record and never blocks the purge of what it names. Such a voucher is no settlement posting, no
--                                                payout, no year closing, no close of a month of stock, no count and no pay run posting, and it names the proposal that approved it.
-- The trigger and the ledger effect of the new command are in 20261231190000, its approval policy in 20261231200000 (the kernel's own migration).
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_finance.journal_voucher ADD COLUMN IF NOT EXISTS fee_document_id uuid;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'journal_voucher_fee_clearing' AND conrelid = 'crove_finance.journal_voucher'::regclass) THEN
    ALTER TABLE crove_finance.journal_voucher
      ADD CONSTRAINT journal_voucher_fee_clearing CHECK (fee_document_id IS NULL OR (settlement_id IS NULL AND payout_settlement_id IS NULL AND payout_bank_line_id IS NULL AND closing_year IS NULL AND stock_closing_month IS NULL AND stock_count_id IS NULL AND payroll_run_id IS NULL AND proposal_id IS NOT NULL));
  END IF;
END
$$;
-- The command sums the standing clearings of one invoice: the lookup by document.
CREATE INDEX IF NOT EXISTS journal_voucher_fee_document_idx ON crove_finance.journal_voucher (org_id, fee_document_id) WHERE fee_document_id IS NOT NULL;
