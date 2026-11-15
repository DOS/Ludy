-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #2516, marketplace rework to the AI consensus of 2026-11-15, slice C1): the posting of a stored marketplace settlement is ONE general voucher per settlement AND MONTH of
-- delivery (working answer A5 of #2520, pending the accountant: revenue belongs to the month of successful delivery, an entry has one date), all the months of a settlement posted by ONE proposal in
-- one transaction (the Accounting PO's decision of 2026-11-15), so the settlement is posted in full or not at all. Idempotent; applied files stay untouched.
--
-- crove_finance.journal_voucher.settlement_month  the first day of the month a settlement's posting voucher is for. A voucher that names a settlement names the month too (a voucher posted before this
--     migration names none: it posted the whole settlement, which no database holds yet because the posting gate has been closed, and it stays valid). A CHECK keeps the day to the first of a month and
--     the month to a voucher that names a settlement.
-- The old unique index (one voucher per settlement, 20261231071500) is replaced by two: one voucher per settlement for the vouchers without a month (so a whole-settlement voucher is still unique and
--     excludes none other than itself), and one per settlement and month. The command refuses a month when a whole-settlement voucher exists, and the reverse, before the database would have to.
-- crove_finance.ledger_effect_recorded and the a_effect_proposal trigger are NOT touched: the effect of the posting command is a voucher that names a settlement and THE PROPOSAL (v.proposal_id =
--     p_proposal AND v.settlement_id IS NOT NULL, 20261231071600): with several vouchers under one proposal it asks for at least one posted in the transaction, and the command posts all of them or fails. b_voucher_tag_command (20270101020000, #3255) keys on settlement_id and is unchanged.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_finance.journal_voucher ADD COLUMN IF NOT EXISTS settlement_month date;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'journal_voucher_settlement_month'
                   AND conrelid = 'crove_finance.journal_voucher'::pg_catalog.regclass) THEN
    ALTER TABLE crove_finance.journal_voucher
      ADD CONSTRAINT journal_voucher_settlement_month CHECK (settlement_month IS NULL
        OR (settlement_id IS NOT NULL AND settlement_month = pg_catalog.date_trunc('month', settlement_month::timestamp)::date));
  END IF;
END $$;

DROP INDEX IF EXISTS crove_finance.journal_voucher_settlement_uq;
CREATE UNIQUE INDEX IF NOT EXISTS journal_voucher_settlement_whole_uq ON crove_finance.journal_voucher (org_id, settlement_id)
  WHERE settlement_id IS NOT NULL AND settlement_month IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS journal_voucher_settlement_month_uq ON crove_finance.journal_voucher (org_id, settlement_id, settlement_month)
  WHERE settlement_month IS NOT NULL;
