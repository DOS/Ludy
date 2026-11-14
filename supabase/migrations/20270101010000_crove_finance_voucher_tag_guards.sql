-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #3214, notes 1 and 7, from the reviews of #3213): two database guards on the journal voucher's marketplace tags. Idempotent; applied files stay untouched.
--
-- crove_finance.journal_voucher_tag_check()          BEFORE INSERT on crove_finance.journal_voucher (trigger b_voucher_tag_command, which sorts right after a_effect_proposal): a voucher that
--     names settlement_id, payout_settlement_id / payout_bank_line_id or fee_document_id names a proposal executing exactly the command that posts that kind of voucher
--     (finance.marketplace_settlement.record, finance.marketplace_payout.record, finance.marketplace_fee_clearing.record). So finance.journal_voucher.record, or any other voucher command, can
--     no longer carry a marketplace tag: only command code writes them today, this makes it a database fact. Same refusal and same staff exemption as a_effect_proposal
--     (EFFECT_PROPOSAL_MISMATCH, 23514, effect_proposal_staff). The commands list of a_effect_proposal and ledger_effect_recorded are not touched.
-- crove_finance.check_payout_bank_line()             AFTER INSERT on crove_finance.journal_voucher for a payout voucher (trigger journal_voucher_settles_bank_line): its bank line is refused when
--     another unreversed cash voucher holds it.
-- crove_finance.check_cash_voucher_bank_line()       the body of 20261020130000 (still its only body) with the reverse check: a cash voucher is refused when a payout voucher whose entry is not
--     reversed names the line. Both checks take the line's advisory lock, so the two writers serialize and the later one sees the earlier.
-- Neither guard adds a column or touches data. Nothing in the approval policy changes.
SET LOCAL lock_timeout = '2s';

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

DROP TRIGGER IF EXISTS b_voucher_tag_command ON crove_finance.journal_voucher;
CREATE TRIGGER b_voucher_tag_command BEFORE INSERT ON crove_finance.journal_voucher
  FOR EACH ROW EXECUTE FUNCTION crove_finance.journal_voucher_tag_check();

-- Owned by the migration runner, like check_cash_voucher_bank_line, so it sees every voucher and entry of the org whatever the writer can see. It reads only rows of NEW.org_id.
CREATE OR REPLACE FUNCTION crove_finance.check_payout_bank_line() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.payout_bank_line_id IS NULL THEN
    RETURN NULL;
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('crove_finance.bank_line:' || NEW.org_id::text || ':' || NEW.payout_bank_line_id::text, 0));
  -- A cash voucher of the line whose entry is not reversed (a cash voucher without an entry cannot be committed, so every other one seen here has one).
  IF EXISTS (
    SELECT 1
    FROM crove_finance.cash_voucher v
    JOIN crove_finance.journal_entry e
      ON e.org_id = v.org_id AND e.source_type = 'finance.cash_voucher' AND e.source_id = v.id AND e.reverses_entry_id IS NULL
    WHERE v.org_id = NEW.org_id AND v.bank_line_id = NEW.payout_bank_line_id
      AND NOT EXISTS (SELECT 1 FROM crove_finance.journal_entry r WHERE r.org_id = e.org_id AND r.reverses_entry_id = e.id)
  ) THEN
    RAISE EXCEPTION 'bank line % is already settled by a cash voucher', NEW.payout_bank_line_id USING ERRCODE = '23505';
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS journal_voucher_settles_bank_line ON crove_finance.journal_voucher;
CREATE TRIGGER journal_voucher_settles_bank_line
  AFTER INSERT ON crove_finance.journal_voucher
  FOR EACH ROW WHEN (NEW.payout_bank_line_id IS NOT NULL)
  EXECUTE FUNCTION crove_finance.check_payout_bank_line();

-- The body of 20261020130000 with the check for a payout voucher of the line added at the end.
CREATE OR REPLACE FUNCTION crove_finance.check_cash_voucher_bank_line() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_line record;
BEGIN
  IF NEW.bank_line_id IS NULL THEN
    RETURN NULL;
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('crove_finance.bank_line:' || NEW.org_id::text || ':' || NEW.bank_line_id::text, 0));
  SELECT l.bank_account, l.amount, l.value_date INTO v_line
  FROM crove_finance.bank_line l
  WHERE l.org_id = NEW.org_id AND l.id = NEW.bank_line_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bank line % of cash voucher % is not a line of the org', NEW.bank_line_id, NEW.id USING ERRCODE = '23503';
  END IF;
  IF v_line.bank_account <> NEW.cash_account
     OR v_line.value_date <> NEW.voucher_date
     OR pg_catalog.abs(v_line.amount) <> NEW.amount
     OR (v_line.amount > 0) <> (NEW.voucher_type = 'bank_credit') THEN
    RAISE EXCEPTION 'cash voucher % does not match bank line % (account, date, amount or direction)', NEW.id, NEW.bank_line_id
      USING ERRCODE = '23514';
  END IF;
  -- Another voucher of the line whose entry is not reversed. A voucher without an entry cannot be committed
  -- (cash_voucher_entry), so every other voucher seen here has one.
  IF EXISTS (
    SELECT 1
    FROM crove_finance.cash_voucher v
    JOIN crove_finance.journal_entry e
      ON e.org_id = v.org_id AND e.source_type = 'finance.cash_voucher' AND e.source_id = v.id AND e.reverses_entry_id IS NULL
    WHERE v.org_id = NEW.org_id AND v.bank_line_id = NEW.bank_line_id AND v.id <> NEW.id
      AND NOT EXISTS (SELECT 1 FROM crove_finance.journal_entry r WHERE r.org_id = e.org_id AND r.reverses_entry_id = e.id)
  ) THEN
    RAISE EXCEPTION 'bank line % is already settled by another cash voucher', NEW.bank_line_id USING ERRCODE = '23505';
  END IF;
  -- A payout voucher of the line (#2516) that is not reversed: the platform's transfer is already recorded by it. A payout voucher whose entry is
  -- not stored yet (the same transaction) counts as holding the line, as a pending one does.
  IF EXISTS (
    SELECT 1
    FROM crove_finance.journal_voucher j
    WHERE j.org_id = NEW.org_id AND j.payout_bank_line_id = NEW.bank_line_id
      AND NOT EXISTS (
        SELECT 1
        FROM crove_finance.journal_entry e
        JOIN crove_finance.journal_entry r ON r.org_id = e.org_id AND r.reverses_entry_id = e.id
        WHERE e.org_id = j.org_id AND e.source_type = 'finance.journal_voucher' AND e.source_id = j.id AND e.reverses_entry_id IS NULL)
  ) THEN
    RAISE EXCEPTION 'bank line % is already settled by a marketplace payout', NEW.bank_line_id USING ERRCODE = '23505';
  END IF;
  RETURN NULL;
END $$;

-- Trigger functions only; nobody calls them directly.
REVOKE ALL ON FUNCTION crove_finance.journal_voucher_tag_check(), crove_finance.check_payout_bank_line(), crove_finance.check_cash_voucher_bank_line()
  FROM PUBLIC, crove_tenant, crove_definer_tenant;

-- Drift guard (as in 20261019270000 and 20261020130000): the checks that read other rows must run as a role that row security does not filter on the tables they read.
DO $$
DECLARE
  v_table text;
BEGIN
  SELECT pg_catalog.string_agg(DISTINCT c.oid::pg_catalog.regclass::text, ', ') INTO v_table
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
  CROSS JOIN pg_catalog.pg_class c
  WHERE p.oid IN ('crove_finance.check_payout_bank_line()'::pg_catalog.regprocedure, 'crove_finance.check_cash_voucher_bank_line()'::pg_catalog.regprocedure)
    AND c.oid IN ('crove_finance.journal_entry'::pg_catalog.regclass, 'crove_finance.cash_voucher'::pg_catalog.regclass,
                  'crove_finance.journal_voucher'::pg_catalog.regclass, 'crove_finance.bank_line'::pg_catalog.regclass)
    AND NOT (r.rolsuper OR r.rolbypassrls OR (c.relowner = p.proowner AND NOT c.relforcerowsecurity));
  IF v_table IS NOT NULL THEN
    RAISE EXCEPTION 'the bank line checks of crove_finance vouchers must be owned by the owner of % (row security not forced), a superuser or a BYPASSRLS role', v_table;
  END IF;
END $$;
