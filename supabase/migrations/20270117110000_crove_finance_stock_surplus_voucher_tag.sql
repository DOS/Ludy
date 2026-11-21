-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #3712 slice 2a, plan stock-and-marketplaces.md section 8.2, research row C3): the resolution of the surplus of a count of stock, as ONE general journal voucher
-- (Dr 3381 / Cr 711, 3388 or 331) that finance.journal_voucher.record posts from a prefilled proposal. Idempotent; applied files stay untouched.
--
-- crove_finance.journal_voucher.surplus_count_id   the voucher that resolves a surplus names the confirmed count whose 3381 it clears. At most one such voucher per count (a partial unique index),
--                                                  so a surplus is resolved once. Such a voucher is no settlement posting, no payout, no fee clearing, no year closing, no close of a month of
--                                                  stock, no count (stock_count_id is the voucher that CONFIRMS a count, a different thing), no pay run posting, and it names the proposal that approved it.
-- crove_finance.journal_voucher_tag_check()        the body of 20270101020000 with one more tag: a voucher that names surplus_count_id names a proposal executing finance.journal_voucher.record
--                                                  (the command that posts a prefilled voucher), and nothing else can write the column. The amount and the account are not a database fact: the command
--                                                  recomputes the amount from the count and refuses the account outside 711, 3388 and 331 (modules/finance/src/stock-surplus.ts).
-- The new constraints are added NOT VALID and validated in the next file; no existing row has the column.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_finance.journal_voucher ADD COLUMN IF NOT EXISTS surplus_count_id uuid;

ALTER TABLE crove_finance.journal_voucher DROP CONSTRAINT IF EXISTS journal_voucher_surplus;
ALTER TABLE crove_finance.journal_voucher
  ADD CONSTRAINT journal_voucher_surplus CHECK (
    surplus_count_id IS NULL OR (
      settlement_id IS NULL AND payout_settlement_id IS NULL AND payout_bank_line_id IS NULL AND fee_document_id IS NULL AND closing_year IS NULL AND stock_closing_month IS NULL
      AND stock_count_id IS NULL AND payroll_run_id IS NULL AND proposal_id IS NOT NULL)
  ) NOT VALID;

ALTER TABLE crove_finance.journal_voucher DROP CONSTRAINT IF EXISTS journal_voucher_surplus_count_fk;
ALTER TABLE crove_finance.journal_voucher
  ADD CONSTRAINT journal_voucher_surplus_count_fk FOREIGN KEY (org_id, surplus_count_id) REFERENCES crove_finance.stock_count (org_id, id) NOT VALID;

-- A surplus is resolved once: the second voucher for the same count is refused by the index, whoever writes it.
CREATE UNIQUE INDEX IF NOT EXISTS journal_voucher_surplus_count_uq ON crove_finance.journal_voucher (org_id, surplus_count_id) WHERE surplus_count_id IS NOT NULL;

CREATE OR REPLACE FUNCTION crove_finance.journal_voucher_tag_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_command text;
BEGIN
  IF crove_finance.effect_proposal_staff(TG_RELID) THEN
    RETURN NEW;
  END IF;
  -- Each tag belongs to one command; a check constraint keeps the tags apart (a voucher names one kind).
  v_command := CASE
    WHEN NEW.settlement_id IS NOT NULL THEN 'finance.marketplace_settlement.record'
    WHEN NEW.payout_settlement_id IS NOT NULL OR NEW.payout_bank_line_id IS NOT NULL THEN 'finance.marketplace_payout.record'
    WHEN NEW.fee_document_id IS NOT NULL THEN 'finance.marketplace_fee_clearing.record'
    WHEN NEW.surplus_count_id IS NOT NULL THEN 'finance.journal_voucher.record'
  END;
  IF v_command IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.proposal_id IS NULL OR NOT crove_finance.effect_proposal_is_executing(NEW.org_id, NEW.proposal_id, ARRAY[v_command]) THEN
    RAISE EXCEPTION 'EFFECT_PROPOSAL_MISMATCH' USING ERRCODE = '23514',
      DETAIL = pg_catalog.json_build_object('table', TG_TABLE_NAME, 'command', v_command)::text;
  END IF;
  RETURN NEW;
END $$;
