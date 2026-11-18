-- SPDX-License-Identifier: AGPL-3.0-only
-- Finance #3113 S2 (#3699), the first carry-over of the security review of S1 (#3735): a supplier's bank account is never created or retired without its change row. Rule 3 (a supplier's
-- account changed while a payment waits) reads only supplier_bank_account_change, so a code path that wrote an account without a history row would hide a change from it.
-- A deferred constraint trigger, checked when the transaction commits: an account row inserted in the transaction has a change row of kind added or replaced for it, and an account whose status
-- moves from active to retired has a change row of kind retired for it, or a change row of kind replaced that names its hash as the old one (a replacement records the closing of the old
-- account in its own row), all written in the same transaction (their changed_at is the transaction's own now()).
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_finance.supplier_bank_account_change_required() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NOT (OLD.status = 'active' AND NEW.status = 'retired') THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM crove_finance.supplier_bank_account_change c
    WHERE c.org_id = NEW.org_id AND c.changed_at = pg_catalog.now()
      AND ((TG_OP = 'INSERT' AND c.account_id = NEW.id AND c.kind IN ('added', 'replaced'))
        OR (TG_OP = 'UPDATE' AND ((c.account_id = NEW.id AND c.kind = 'retired')
          OR (c.party_id = NEW.party_id AND c.kind = 'replaced' AND c.old_number_hash = NEW.number_hash))))
  ) THEN
    RAISE EXCEPTION 'SUPPLIER_BANK_CHANGE_MISSING' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION crove_finance.supplier_bank_account_change_required() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

DROP TRIGGER IF EXISTS supplier_bank_account_change_required ON crove_finance.supplier_bank_account;
CREATE CONSTRAINT TRIGGER supplier_bank_account_change_required AFTER INSERT OR UPDATE OF status ON crove_finance.supplier_bank_account
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION crove_finance.supplier_bank_account_change_required();
