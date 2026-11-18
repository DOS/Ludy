-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #3700, S3c of #3113): the settlement of an approved supplier payment by the bank line that is its transfer. Idempotent; applied files stay untouched.
--
-- Ludy moves no money: when the bank line of the transfer is matched, finance.supplier_payment.settle.record (an R3 ledger proposal) records a bank voucher (giấy báo Nợ, Dr 331 / Cr the bank) that
-- names the payment, and the payment becomes `paid`, in one transaction. The approval policy is in 20270116120000 (the kernel's own migration).
-- crove_finance.cash_voucher.supplier_payment_id    the voucher that settles a payment names it (the id of crove_finance.supplier_payment; no foreign key, as the pay run's: the org purge keeps the
--                                                   vouchers and deletes the payments). A voucher that names a payment is a bank_debit made from a bank line by an approved proposal. One voucher per payment (a unique
--                                                   index): a voucher of a payment cannot be reversed while the payment is paid (the trigger below), so this is also "one live voucher".
-- crove_finance.cash_voucher_tag_check()            BEFORE INSERT (b_cash_voucher_tag_command): a voucher that names a payment names a proposal executing exactly the settlement command.
-- crove_finance.effect_proposal_check (a_effect_proposal) on cash_voucher lists the new command. ledger_effect_recorded is the body of 20261231230000 with the branch for the new command (and the
--                                                   plain voucher branch refuses a voucher that names a payment).
-- crove_finance.supplier_payment_guard()            the body of 20270116100000 with the move to paid also needing a file handed over and a voucher that names the payment.
-- supplier_payment_update (policy)                  also lets the settlement's own transaction move the payment, whoever approves it (the chief accountant of an accountant-preset org is a
--                                                   member): the row is the one a voucher of an approved settlement proposal names.
-- crove_finance.journal_entry_supplier_payment_reversal()  BEFORE INSERT of a reversal (b_supplier_payment_reversal): the entry of a voucher whose payment is paid cannot be reversed, so a reversal
--                                                   can never free a payment to be paid twice.
SET LOCAL lock_timeout = '2s';

-- crove_finance.supplier_payment.first_exported_at  when the first file with the payment was handed over (set by the guard with the first export; a second file moves exported_at, never this): the day
--                                                   a settlement's line may not precede, so a re-export cannot make the transfer of the first file look older than the file.
ALTER TABLE crove_finance.supplier_payment ADD COLUMN IF NOT EXISTS first_exported_at timestamptz;
UPDATE crove_finance.supplier_payment SET first_exported_at = exported_at WHERE first_exported_at IS NULL AND exported_at IS NOT NULL;
ALTER TABLE crove_finance.cash_voucher ADD COLUMN IF NOT EXISTS supplier_payment_id uuid;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'cash_voucher_supplier_payment' AND conrelid = 'crove_finance.cash_voucher'::regclass) THEN
    ALTER TABLE crove_finance.cash_voucher
      ADD CONSTRAINT cash_voucher_supplier_payment CHECK (
        supplier_payment_id IS NULL
        OR (voucher_type = 'bank_debit' AND proposal_id IS NOT NULL AND bank_line_id IS NOT NULL AND payroll_run_id IS NULL AND payroll_payment_kind IS NULL));
  END IF;
END
$$;
CREATE UNIQUE INDEX IF NOT EXISTS cash_voucher_supplier_payment_uq ON crove_finance.cash_voucher (org_id, supplier_payment_id) WHERE supplier_payment_id IS NOT NULL;

DROP TRIGGER IF EXISTS a_effect_proposal ON crove_finance.cash_voucher;
CREATE TRIGGER a_effect_proposal BEFORE INSERT ON crove_finance.cash_voucher
  FOR EACH ROW EXECUTE FUNCTION crove_finance.effect_proposal_check('finance.voucher.record', 'finance.payroll_payment.record', 'finance.supplier_payment.settle.record');

CREATE OR REPLACE FUNCTION crove_finance.cash_voucher_tag_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.supplier_payment_id IS NULL OR crove_finance.effect_proposal_staff(TG_RELID) THEN
    RETURN NEW;
  END IF;
  IF NEW.proposal_id IS NULL OR NOT crove_finance.effect_proposal_is_executing(NEW.org_id, NEW.proposal_id, ARRAY['finance.supplier_payment.settle.record']) THEN
    RAISE EXCEPTION 'EFFECT_PROPOSAL_MISMATCH' USING ERRCODE = '23514',
      DETAIL = pg_catalog.json_build_object('table', TG_TABLE_NAME, 'command', 'finance.supplier_payment.settle.record')::text;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_finance.cash_voucher_tag_check() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
DROP TRIGGER IF EXISTS b_cash_voucher_tag_command ON crove_finance.cash_voucher;
CREATE TRIGGER b_cash_voucher_tag_command BEFORE INSERT ON crove_finance.cash_voucher
  FOR EACH ROW EXECUTE FUNCTION crove_finance.cash_voucher_tag_check();

-- A ledger proposal moves to 'executed' only when its effect was posted in this transaction (20261105020000). Redefined as it was, with the settlement of a supplier payment added.
CREATE OR REPLACE FUNCTION crove_finance.ledger_effect_recorded(p_org uuid, p_proposal uuid, p_command text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_xact xid8;
BEGIN
  IF p_org IS NULL OR p_org IS DISTINCT FROM crove_kernel.ctx_org_id() THEN
    RETURN false;
  END IF;
  IF NOT coalesce((crove_kernel.approval_command_policy(p_command)).ledger, false) THEN
    RETURN true;
  END IF;
  -- Assigned already: the update this answers for has written.
  v_xact := pg_catalog.pg_current_xact_id_if_assigned();
  IF v_xact IS NULL THEN
    RETURN false;
  END IF;
  RETURN CASE
    WHEN p_command = 'finance.journal.reverse' THEN EXISTS (
      SELECT 1 FROM crove_finance.journal_entry e
      WHERE e.org_id = p_org AND e.source_type = 'kernel.proposal' AND e.source_id = p_proposal AND e.reverses_entry_id IS NOT NULL
        AND e.created_xact_id = v_xact AND e.created_xact_start = pg_catalog.now())
    WHEN p_command = 'finance.purchase.record' THEN EXISTS (
      SELECT 1 FROM crove_finance.purchase_document d
      JOIN crove_finance.journal_entry e ON e.org_id = d.org_id AND e.source_type = 'finance.purchase_document' AND e.source_id = d.id
      WHERE d.org_id = p_org AND d.proposal_id = p_proposal AND e.created_xact_id = v_xact AND e.created_xact_start = pg_catalog.now())
    -- A voucher that names a pay run is the effect of the payment command only: an untagged voucher proposal's effect is an untagged voucher.
    WHEN p_command = 'finance.voucher.record' THEN EXISTS (
      SELECT 1 FROM crove_finance.cash_voucher v
      JOIN crove_finance.journal_entry e ON e.org_id = v.org_id AND e.source_type = 'finance.cash_voucher' AND e.source_id = v.id
      WHERE v.org_id = p_org AND v.proposal_id = p_proposal AND v.payroll_run_id IS NULL AND v.supplier_payment_id IS NULL AND e.created_xact_id = v_xact AND e.created_xact_start = pg_catalog.now())
    -- The close's effect is its voucher and the month it closed, and the count's its voucher and the count it confirmed, stored in this transaction: an untagged voucher is not the effect.
    WHEN p_command = 'finance.stock.close_period' THEN EXISTS (
      SELECT 1 FROM crove_finance.journal_voucher v
      JOIN crove_finance.journal_entry e ON e.org_id = v.org_id AND e.source_type = 'finance.journal_voucher' AND e.source_id = v.id
      JOIN crove_finance.stock_period p ON p.org_id = v.org_id AND p.voucher_id = v.id
      WHERE v.org_id = p_org AND v.proposal_id = p_proposal AND v.stock_closing_month IS NOT NULL AND e.created_xact_id = v_xact AND e.created_xact_start = pg_catalog.now())
    WHEN p_command = 'finance.stock.count_confirm' THEN EXISTS (
      SELECT 1 FROM crove_finance.journal_voucher v
      JOIN crove_finance.journal_entry e ON e.org_id = v.org_id AND e.source_type = 'finance.journal_voucher' AND e.source_id = v.id
      JOIN crove_finance.stock_count c ON c.org_id = v.org_id AND c.voucher_id = v.id AND c.status = 'confirmed'
      WHERE v.org_id = p_org AND v.proposal_id = p_proposal AND v.stock_count_id IS NOT NULL AND e.created_xact_id = v_xact AND e.created_xact_start = pg_catalog.now())
    -- The posting of a pay run (#2532): the effect is a voucher that names the run it posts and the proposal, stored in this transaction. An untagged voucher is not the effect.
    WHEN p_command = 'finance.payroll_posting.record' THEN EXISTS (
      SELECT 1 FROM crove_finance.journal_voucher v
      JOIN crove_finance.journal_entry e ON e.org_id = v.org_id AND e.source_type = 'finance.journal_voucher' AND e.source_id = v.id
      WHERE v.org_id = p_org AND v.proposal_id = p_proposal AND v.payroll_run_id IS NOT NULL AND e.created_xact_id = v_xact AND e.created_xact_start = pg_catalog.now())
    -- The payment of a pay run's net pay or a remittance (#2532): the effect is a voucher that names the run and the kind of payment and the proposal, with its entry, stored in this transaction. An untagged voucher is not the effect.
    WHEN p_command = 'finance.payroll_payment.record' THEN EXISTS (
      SELECT 1 FROM crove_finance.cash_voucher v
      JOIN crove_finance.journal_entry e ON e.org_id = v.org_id AND e.source_type = 'finance.cash_voucher' AND e.source_id = v.id
      WHERE v.org_id = p_org AND v.proposal_id = p_proposal AND v.payroll_run_id IS NOT NULL AND e.created_xact_id = v_xact AND e.created_xact_start = pg_catalog.now())
    -- The posting of a marketplace settlement (#2516): the effect is a voucher that names the settlement it posts and the proposal, stored in this transaction. An untagged voucher is not the effect.
    WHEN p_command = 'finance.marketplace_settlement.record' THEN EXISTS (
      SELECT 1 FROM crove_finance.journal_voucher v
      JOIN crove_finance.journal_entry e ON e.org_id = v.org_id AND e.source_type = 'finance.journal_voucher' AND e.source_id = v.id
      WHERE v.org_id = p_org AND v.proposal_id = p_proposal AND v.settlement_id IS NOT NULL AND e.created_xact_id = v_xact AND e.created_xact_start = pg_catalog.now())
    -- The posting of a platform's payout (#2516): the effect is a voucher that names the settlement it pays and the bank line of the transfer and the proposal, with its entry, stored in this transaction.
    WHEN p_command = 'finance.marketplace_payout.record' THEN EXISTS (
      SELECT 1 FROM crove_finance.journal_voucher v
      JOIN crove_finance.journal_entry e ON e.org_id = v.org_id AND e.source_type = 'finance.journal_voucher' AND e.source_id = v.id
      WHERE v.org_id = p_org AND v.proposal_id = p_proposal AND v.payout_settlement_id IS NOT NULL AND e.created_xact_id = v_xact AND e.created_xact_start = pg_catalog.now())
    -- The clearing of the fees on 1388 by the platform's fee invoice (#2516): the effect is a voucher that names the purchase document it clears and the proposal, with its entry, stored in this transaction.
    WHEN p_command = 'finance.marketplace_fee_clearing.record' THEN EXISTS (
      SELECT 1 FROM crove_finance.journal_voucher v
      JOIN crove_finance.journal_entry e ON e.org_id = v.org_id AND e.source_type = 'finance.journal_voucher' AND e.source_id = v.id
      WHERE v.org_id = p_org AND v.proposal_id = p_proposal AND v.fee_document_id IS NOT NULL AND e.created_xact_id = v_xact AND e.created_xact_start = pg_catalog.now())
    -- The settlement of an approved supplier payment (#3700 S3c): the effect is a bank voucher that names the payment and the proposal, with its entry, stored in this transaction. An untagged voucher is not the effect.
    WHEN p_command = 'finance.supplier_payment.settle.record' THEN EXISTS (
      SELECT 1 FROM crove_finance.cash_voucher v
      JOIN crove_finance.journal_entry e ON e.org_id = v.org_id AND e.source_type = 'finance.cash_voucher' AND e.source_id = v.id
      WHERE v.org_id = p_org AND v.proposal_id = p_proposal AND v.supplier_payment_id IS NOT NULL AND e.created_xact_id = v_xact AND e.created_xact_start = pg_catalog.now())
    WHEN p_command IN ('finance.journal_voucher.record', 'finance.closing.record', 'finance.depreciation.record') THEN EXISTS (
      SELECT 1 FROM crove_finance.journal_voucher v
      JOIN crove_finance.journal_entry e ON e.org_id = v.org_id AND e.source_type = 'finance.journal_voucher' AND e.source_id = v.id
      WHERE v.org_id = p_org AND v.proposal_id = p_proposal AND e.created_xact_id = v_xact AND e.created_xact_start = pg_catalog.now())
    ELSE false
  END;
END $$;
REVOKE ALL ON FUNCTION crove_finance.ledger_effect_recorded(uuid, uuid, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_finance.ledger_effect_recorded(uuid, uuid, text) TO crove_tenant;

CREATE OR REPLACE FUNCTION crove_finance.supplier_payment_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_account record;
  v_doc record;
  v_single boolean;
  v_self boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'approved' OR NEW.confirmed_at IS NOT NULL OR NEW.stale_at IS NOT NULL OR NEW.cancelled_at IS NOT NULL OR NEW.paid_at IS NOT NULL
       OR NEW.exported_at IS NOT NULL OR NEW.exported_by IS NOT NULL OR NEW.export_count <> 0 THEN
      RAISE EXCEPTION 'SUPPLIER_PAYMENT_STATE' USING ERRCODE = '42501';
    END IF;
    SELECT a.id, a.created_at INTO v_account FROM crove_finance.supplier_bank_account a
      WHERE a.org_id = NEW.org_id AND a.id = NEW.bank_account_id AND a.party_id = NEW.party_id AND a.status = 'active'
        AND a.number_hash = NEW.number_hash AND a.hash_key_id = NEW.hash_key_id FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'SUPPLIER_PAYMENT_ACCOUNT_CHANGED' USING ERRCODE = '42501';
    END IF;
    SELECT d.total, d.currency, d.legal_entity_id INTO v_doc FROM crove_finance.purchase_document d
      WHERE d.org_id = NEW.org_id AND d.id = NEW.purchase_document_id AND d.direction = 'purchase' AND d.party_id = NEW.party_id;
    IF NOT FOUND OR v_doc.currency <> NEW.currency OR NEW.amount > v_doc.total OR v_doc.legal_entity_id <> NEW.legal_entity_id
       OR EXISTS (SELECT 1 FROM crove_finance.purchase_document_void v WHERE v.org_id = NEW.org_id AND v.document_id = NEW.purchase_document_id) THEN
      RAISE EXCEPTION 'SUPPLIER_PAYMENT_DOCUMENT' USING ERRCODE = '42501';
    END IF;
    NEW.approved_at := pg_catalog.now();
    -- The hold keys on who approved, not on how many could (the Platform PO's N1 on #3759): the org has one owner or admin, or the approver is among the authors of the proposal
    -- (its requester and co-authors), which is a self-approval whether it came through the one-person path or the owner override. The proposal is read as the writer, as effect_proposal_check does.
    SELECT pg_catalog.count(*) = 1 INTO v_single FROM crove_kernel.tenant_member m WHERE m.org_id = NEW.org_id AND m.role IN ('owner', 'admin');
    SELECT coalesce(NEW.approved_by IS NOT NULL AND (
             EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(CASE WHEN pg_catalog.jsonb_typeof(p.authors) = 'array' THEN p.authors ELSE '[]'::jsonb END) a
                      WHERE a ->> 'type' IN ('user', 'co_author') AND pg_catalog.lower(a ->> 'id') = pg_catalog.lower(NEW.approved_by::text))
             OR (p.co_authors IS NOT NULL AND EXISTS (SELECT 1 FROM pg_catalog.unnest(p.co_authors) c WHERE c = NEW.approved_by))), false)
      INTO v_self FROM crove_kernel.proposal p WHERE p.org_id = NEW.org_id AND p.id = NEW.proposal_id;
    IF (v_single OR coalesce(v_self, false)) AND v_account.created_at > pg_catalog.now() - interval '30 days' THEN
      NEW.payable_after := GREATEST(NEW.approved_at, v_account.created_at) + interval '24 hours';
      NEW.hold_reason := 'new_account';
    ELSE
      NEW.payable_after := NULL;
      NEW.hold_reason := NULL;
    END IF;
    RETURN NEW;
  END IF;
  -- Update. A member leaving clears approved_by, confirmed_by and cancelled_by (the foreign keys' SET NULL); nothing else but the moves below may change.
  IF pg_catalog.to_jsonb(NEW) - ARRAY['status', 'confirmed_by', 'confirmed_at', 'confirmed_channel', 'stale_at', 'cancelled_by', 'cancelled_at', 'cancel_reason', 'paid_at', 'approved_by', 'exported_by', 'exported_at', 'export_count', 'first_exported_at']
     <> pg_catalog.to_jsonb(OLD) - ARRAY['status', 'confirmed_by', 'confirmed_at', 'confirmed_channel', 'stale_at', 'cancelled_by', 'cancelled_at', 'cancel_reason', 'paid_at', 'approved_by', 'exported_by', 'exported_at', 'export_count', 'first_exported_at']
     OR (NEW.approved_by IS NOT NULL AND NEW.approved_by IS DISTINCT FROM OLD.approved_by) THEN
    RAISE EXCEPTION 'SUPPLIER_PAYMENT_STATE' USING ERRCODE = '42501';
  END IF;
  IF OLD.status <> 'approved' THEN
    -- Final: only a member's leaving may touch it.
    IF NEW.status <> OLD.status OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at OR NEW.confirmed_channel IS DISTINCT FROM OLD.confirmed_channel
       OR NEW.stale_at IS DISTINCT FROM OLD.stale_at OR NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at OR NEW.cancel_reason IS DISTINCT FROM OLD.cancel_reason
       OR NEW.paid_at IS DISTINCT FROM OLD.paid_at
       OR NEW.export_count IS DISTINCT FROM OLD.export_count OR NEW.exported_at IS DISTINCT FROM OLD.exported_at
       OR (NEW.exported_by IS NOT NULL AND NEW.exported_by IS DISTINCT FROM OLD.exported_by)
       OR (NEW.confirmed_by IS NOT NULL AND NEW.confirmed_by IS DISTINCT FROM OLD.confirmed_by) OR (NEW.cancelled_by IS NOT NULL AND NEW.cancelled_by IS DISTINCT FROM OLD.cancelled_by) THEN
      RAISE EXCEPTION 'SUPPLIER_PAYMENT_STATE' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  -- The export marker (S3b-2): the count grows by one at a time and stamps exported_at with the database clock; nothing else moves it but a member's leaving (exported_by to NULL).
  IF NEW.export_count IS DISTINCT FROM OLD.export_count THEN
    IF NEW.export_count <> OLD.export_count + 1 OR NEW.exported_by IS NULL THEN
      RAISE EXCEPTION 'SUPPLIER_PAYMENT_STATE' USING ERRCODE = '42501';
    END IF;
    NEW.exported_at := pg_catalog.now();
    IF OLD.export_count = 0 THEN
      NEW.first_exported_at := NEW.exported_at;
    END IF;
  ELSIF NEW.exported_at IS DISTINCT FROM OLD.exported_at OR (NEW.exported_by IS NOT NULL AND NEW.exported_by IS DISTINCT FROM OLD.exported_by) THEN
    RAISE EXCEPTION 'SUPPLIER_PAYMENT_STATE' USING ERRCODE = '42501';
  END IF;
  -- The marker is set once, and stamped by the database clock (N4).
  IF OLD.confirmed_at IS NULL AND NEW.confirmed_at IS NOT NULL THEN
    NEW.confirmed_at := pg_catalog.now();
  END IF;
  IF OLD.confirmed_at IS NOT NULL AND (NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at OR NEW.confirmed_channel IS DISTINCT FROM OLD.confirmed_channel
     OR (NEW.confirmed_by IS NOT NULL AND NEW.confirmed_by IS DISTINCT FROM OLD.confirmed_by)) THEN
    RAISE EXCEPTION 'SUPPLIER_PAYMENT_STATE' USING ERRCODE = '42501';
  END IF;
  IF NEW.status = 'stale' THEN
    NEW.stale_at := pg_catalog.now();
  ELSIF NEW.status = 'cancelled' THEN
    NEW.cancelled_at := pg_catalog.now();
  ELSIF NEW.status = 'paid' THEN
    -- Rule 4: not before payable_after (the database clock), and only to the account that was approved.
    IF OLD.payable_after IS NOT NULL AND pg_catalog.now() < OLD.payable_after THEN
      RAISE EXCEPTION 'SUPPLIER_PAYMENT_HELD' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM crove_finance.supplier_bank_account a
      WHERE a.org_id = OLD.org_id AND a.id = OLD.bank_account_id AND a.status = 'active' AND a.number_hash = OLD.number_hash AND a.hash_key_id = OLD.hash_key_id) THEN
      RAISE EXCEPTION 'SUPPLIER_PAYMENT_ACCOUNT_CHANGED' USING ERRCODE = '23514';
    END IF;
    -- An invoice voided after the approval is not paid (N3).
    IF EXISTS (SELECT 1 FROM crove_finance.purchase_document_void v WHERE v.org_id = OLD.org_id AND v.document_id = OLD.purchase_document_id) THEN
      RAISE EXCEPTION 'SUPPLIER_PAYMENT_DOCUMENT' USING ERRCODE = '23514';
    END IF;
    -- A payment is paid by its settlement (#3700 S3c): its file was handed over, and a bank voucher that names it exists (the settlement's, stored just before in the same transaction).
    IF OLD.export_count = 0 THEN
      RAISE EXCEPTION 'SUPPLIER_PAYMENT_NOT_EXPORTED' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM crove_finance.cash_voucher v WHERE v.org_id = OLD.org_id AND v.supplier_payment_id = OLD.id) THEN
      RAISE EXCEPTION 'SUPPLIER_PAYMENT_NO_VOUCHER' USING ERRCODE = '23514';
    END IF;
    NEW.paid_at := pg_catalog.now();
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_finance.supplier_payment_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- The settlement's own transaction may move the payment it settles. The guard still decides what the move may be (to paid only, with the file, the hold, the account and the invoice checked).
DROP POLICY IF EXISTS supplier_payment_update ON crove_finance.supplier_payment;
CREATE POLICY supplier_payment_update ON crove_finance.supplier_payment AS RESTRICTIVE FOR UPDATE TO crove_tenant
  USING ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = supplier_payment.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin'))
    OR EXISTS (SELECT 1 FROM crove_finance.cash_voucher v WHERE v.org_id = supplier_payment.org_id AND v.supplier_payment_id = supplier_payment.id
                 AND crove_finance.effect_proposal_is_executing(v.org_id, v.proposal_id, ARRAY['finance.supplier_payment.settle.record'])))
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = supplier_payment.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin'))
    OR (supplier_payment.status = 'paid' AND EXISTS (SELECT 1 FROM crove_finance.cash_voucher v WHERE v.org_id = supplier_payment.org_id AND v.supplier_payment_id = supplier_payment.id
                 AND crove_finance.effect_proposal_is_executing(v.org_id, v.proposal_id, ARRAY['finance.supplier_payment.settle.record']))));

-- Owned by the migration runner, like the ledger checks, so it sees every voucher and payment of the org whatever the writer can see. It reads only rows of NEW.org_id.
CREATE OR REPLACE FUNCTION crove_finance.journal_entry_supplier_payment_reversal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM crove_finance.journal_entry o
    JOIN crove_finance.cash_voucher v ON v.org_id = o.org_id AND v.id = o.source_id AND v.supplier_payment_id IS NOT NULL
    JOIN crove_finance.supplier_payment p ON p.org_id = v.org_id AND p.id = v.supplier_payment_id AND p.status = 'paid'
    WHERE o.org_id = NEW.org_id AND o.id = NEW.reverses_entry_id AND o.source_type = 'finance.cash_voucher'
  ) THEN
    RAISE EXCEPTION 'SUPPLIER_PAYMENT_PAID' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_finance.journal_entry_supplier_payment_reversal() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
DROP TRIGGER IF EXISTS b_supplier_payment_reversal ON crove_finance.journal_entry;
CREATE TRIGGER b_supplier_payment_reversal BEFORE INSERT ON crove_finance.journal_entry
  FOR EACH ROW WHEN (NEW.reverses_entry_id IS NOT NULL) EXECUTE FUNCTION crove_finance.journal_entry_supplier_payment_reversal();
