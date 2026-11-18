-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #3700, S3a of #3113; findings N1, N3 and N4 of the Platform PO's review of #3759, filed as #3760). Idempotent; applied files stay untouched.
--
-- Why: the bank file of S3 is where money can follow a payment, so the three holes the review of S2 left are closed first, in the database.
-- crove_finance.supplier_payment_guard()  the body of 20270115130000 (the newest definition) with:
--   N1  the 24 hour hold applies when the org has one owner or admin OR the approver is among the authors of the proposal (its requester and co-authors): the owner override of a
--       one-person-at-heart org (two owners, the requester approving as the owner because every eligible approver is an author) is a self-approval and holds as much as the one-person path.
--       The proposal is read as the writer. Staff (support and migration paths, no real proposal) keep the count rule alone.
--   N3  an invoice that is voided (a purchase_document_void row) is refused at insert (42501 SUPPLIER_PAYMENT_DOCUMENT) and at the move to paid (23514), not only by the command.
--   N4  confirmed_at is stamped by the database clock when the marker is first set; the app clock never decides it (the marker is evidence only and never shortens the hold).
-- Not changed here: N2 (a concurrent account change) stays bounded by the re-check at paid and by the export's own re-check (S3b); a lock between the two would deadlock against the row lock
-- the change holds. N8: only b_legal_entity is ENABLE ALWAYS on the finance tables with a guard of this kind; the other triggers do not fire under session_replication_role = replica, as on them.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_finance.supplier_payment_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_account record;
  v_doc record;
  v_single boolean;
  v_self boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'approved' OR NEW.confirmed_at IS NOT NULL OR NEW.stale_at IS NOT NULL OR NEW.cancelled_at IS NOT NULL OR NEW.paid_at IS NOT NULL THEN
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
  IF pg_catalog.to_jsonb(NEW) - ARRAY['status', 'confirmed_by', 'confirmed_at', 'confirmed_channel', 'stale_at', 'cancelled_by', 'cancelled_at', 'cancel_reason', 'paid_at', 'approved_by']
     <> pg_catalog.to_jsonb(OLD) - ARRAY['status', 'confirmed_by', 'confirmed_at', 'confirmed_channel', 'stale_at', 'cancelled_by', 'cancelled_at', 'cancel_reason', 'paid_at', 'approved_by']
     OR (NEW.approved_by IS NOT NULL AND NEW.approved_by IS DISTINCT FROM OLD.approved_by) THEN
    RAISE EXCEPTION 'SUPPLIER_PAYMENT_STATE' USING ERRCODE = '42501';
  END IF;
  IF OLD.status <> 'approved' THEN
    -- Final: only a member's leaving may touch it.
    IF NEW.status <> OLD.status OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at OR NEW.confirmed_channel IS DISTINCT FROM OLD.confirmed_channel
       OR NEW.stale_at IS DISTINCT FROM OLD.stale_at OR NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at OR NEW.cancel_reason IS DISTINCT FROM OLD.cancel_reason
       OR NEW.paid_at IS DISTINCT FROM OLD.paid_at
       OR (NEW.confirmed_by IS NOT NULL AND NEW.confirmed_by IS DISTINCT FROM OLD.confirmed_by) OR (NEW.cancelled_by IS NOT NULL AND NEW.cancelled_by IS DISTINCT FROM OLD.cancelled_by) THEN
      RAISE EXCEPTION 'SUPPLIER_PAYMENT_STATE' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
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
    NEW.paid_at := pg_catalog.now();
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_finance.supplier_payment_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
