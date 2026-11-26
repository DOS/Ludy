-- SPDX-License-Identifier: AGPL-3.0-only
-- Fail closed in ludy_finance.supplier_payment_guard() when a non-staff insert names a proposal
-- that is not found or cannot be read by the writer (#3770, follow-up of #3768).
-- Preserves the entire definition from 20270328120000 (including #3738 erase tombstones, S3b export
-- markers, S3c settlement checks, and N1/N3/N4 guards). Staff (effect_proposal_staff(TG_RELID):
-- superuser, support, and migration paths that write no real proposal) keep the count rule alone
-- when no proposal row is found. Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION ludy_finance.supplier_payment_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_account record;
  v_doc record;
  v_single boolean;
  v_self boolean;
  v_erase_owner text;
  v_cur_role text := current_user;
  v_token text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'approved' OR NEW.confirmed_at IS NOT NULL OR NEW.stale_at IS NOT NULL OR NEW.cancelled_at IS NOT NULL OR NEW.paid_at IS NOT NULL
       OR NEW.exported_at IS NOT NULL OR NEW.exported_by IS NOT NULL OR NEW.export_count <> 0
       OR NEW.number_hash !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'SUPPLIER_PAYMENT_STATE' USING ERRCODE = '42501';
    END IF;
    SELECT a.id, a.created_at INTO v_account FROM ludy_finance.supplier_bank_account a
      WHERE a.org_id = NEW.org_id AND a.id = NEW.bank_account_id AND a.party_id = NEW.party_id AND a.status = 'active'
        AND a.number_hash = NEW.number_hash AND a.hash_key_id = NEW.hash_key_id FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'SUPPLIER_PAYMENT_ACCOUNT_CHANGED' USING ERRCODE = '42501';
    END IF;
    SELECT d.total, d.currency, d.legal_entity_id INTO v_doc FROM ludy_finance.purchase_document d
      WHERE d.org_id = NEW.org_id AND d.id = NEW.purchase_document_id AND d.direction = 'purchase' AND d.party_id = NEW.party_id;
    IF NOT FOUND OR v_doc.currency <> NEW.currency OR NEW.amount > v_doc.total OR v_doc.legal_entity_id <> NEW.legal_entity_id
       OR EXISTS (SELECT 1 FROM ludy_finance.purchase_document_void v WHERE v.org_id = NEW.org_id AND v.document_id = NEW.purchase_document_id) THEN
      RAISE EXCEPTION 'SUPPLIER_PAYMENT_DOCUMENT' USING ERRCODE = '42501';
    END IF;
    NEW.approved_at := pg_catalog.now();
    SELECT pg_catalog.count(*) = 1 INTO v_single FROM ludy_kernel.tenant_member m WHERE m.org_id = NEW.org_id AND m.role IN ('owner', 'admin');
    SELECT coalesce(NEW.approved_by IS NOT NULL AND (
             EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(CASE WHEN pg_catalog.jsonb_typeof(p.authors) = 'array' THEN p.authors ELSE '[]'::jsonb END) a
                      WHERE a ->> 'type' IN ('user', 'co_author') AND pg_catalog.lower(a ->> 'id') = pg_catalog.lower(NEW.approved_by::text))
             OR (p.co_authors IS NOT NULL AND EXISTS (SELECT 1 FROM pg_catalog.unnest(p.co_authors) c WHERE c = NEW.approved_by))), false)
      INTO v_self FROM ludy_kernel.proposal p WHERE p.org_id = NEW.org_id AND p.id = NEW.proposal_id;
    IF NOT FOUND THEN
      IF NOT ludy_finance.effect_proposal_staff(TG_RELID) THEN
        RAISE EXCEPTION 'SUPPLIER_PAYMENT_PROPOSAL' USING ERRCODE = '42501';
      END IF;
      v_self := false;
    END IF;
    IF (v_single OR v_self) AND v_account.created_at > pg_catalog.now() - interval '30 days' THEN
      NEW.payable_after := GREATEST(NEW.approved_at, v_account.created_at) + interval '24 hours';
      NEW.hold_reason := 'new_account';
    ELSE
      NEW.payable_after := NULL;
      NEW.hold_reason := NULL;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.number_hash IS DISTINCT FROM OLD.number_hash THEN
    SELECT r.rolname INTO v_erase_owner
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
     WHERE p.oid = pg_catalog.to_regprocedure('ludy_finance.supplier_bank_account_erase_tombstone(uuid,timestamptz)');
    v_token := pg_catalog.current_setting('ludy.supplier_bank_erase', true);
    IF v_erase_owner IS NOT NULL
       AND v_cur_role = v_erase_owner
       AND v_token = OLD.org_id::text || ':' || pg_catalog.lower(OLD.party_id::text)
       AND ludy_kernel.ctx_actor_type() = 'user'
       AND ludy_kernel.ctx_agent_id() IS NULL
       AND ludy_kernel.ctx_org_id() = OLD.org_id
       AND EXISTS (
         SELECT 1 FROM ludy_kernel.tenant_member m
         WHERE m.org_id = OLD.org_id AND m.user_id = ludy_kernel.ctx_user_id() AND m.role = 'owner'
       )
       AND OLD.status IN ('paid', 'cancelled', 'stale')
       AND NEW.number_hash = 'erased'
       AND NOT EXISTS (
         SELECT 1 FROM ludy_finance.supplier_bank_account a
         WHERE a.org_id = OLD.org_id AND a.party_id = OLD.party_id AND a.status = 'active'
       )
       AND pg_catalog.to_jsonb(NEW) - ARRAY['number_hash'] = pg_catalog.to_jsonb(OLD) - ARRAY['number_hash'] THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'SUPPLIER_PAYMENT_STATE' USING ERRCODE = '42501';
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
    IF NOT EXISTS (SELECT 1 FROM ludy_finance.supplier_bank_account a
      WHERE a.org_id = OLD.org_id AND a.id = OLD.bank_account_id AND a.status = 'active' AND a.number_hash = OLD.number_hash AND a.hash_key_id = OLD.hash_key_id) THEN
      RAISE EXCEPTION 'SUPPLIER_PAYMENT_ACCOUNT_CHANGED' USING ERRCODE = '23514';
    END IF;
    -- An invoice voided after the approval is not paid (N3).
    IF EXISTS (SELECT 1 FROM ludy_finance.purchase_document_void v WHERE v.org_id = OLD.org_id AND v.document_id = OLD.purchase_document_id) THEN
      RAISE EXCEPTION 'SUPPLIER_PAYMENT_DOCUMENT' USING ERRCODE = '23514';
    END IF;
    -- A payment is paid by its settlement (#3700 S3c): its file was handed over, and a bank voucher that names it exists (the settlement's, stored just before in the same transaction).
    IF OLD.export_count = 0 THEN
      RAISE EXCEPTION 'SUPPLIER_PAYMENT_NOT_EXPORTED' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM ludy_finance.cash_voucher v WHERE v.org_id = OLD.org_id AND v.supplier_payment_id = OLD.id) THEN
      RAISE EXCEPTION 'SUPPLIER_PAYMENT_NO_VOUCHER' USING ERRCODE = '23514';
    END IF;
    NEW.paid_at := pg_catalog.now();
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION ludy_finance.supplier_payment_guard() FROM PUBLIC;
DO $$
DECLARE
  v_role text;
BEGIN
  FOR v_role IN
    SELECT rolname FROM pg_catalog.pg_roles
    WHERE (rolname LIKE 'ludy\_%' OR rolname LIKE 'crove\_%') AND rolname <> current_user
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_finance.supplier_payment_guard() FROM %I', v_role);
  END LOOP;
END $$;
