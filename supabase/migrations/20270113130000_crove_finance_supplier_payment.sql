-- SPDX-License-Identifier: AGPL-3.0-only
-- A payment to a supplier approved in Ludy (#3113 S2, #3699; JOY's answers of 2026-11-14 on #3113). Ludy moves no money: the row records that an owner or an admin approved paying one received
-- invoice to the bank account they saw, and the bank file (S3) and the bank-line match (S3) build on it. Everything that keeps the approved amount from going to an account the approver did
-- not see is enforced here, in the database, on the database clock, and not only in the commands:
--   supplier_payment   one row per approved payment. The row is created by finance.supplier_payment.record while the proposal is being approved (so its status starts as `approved`; a payment still
--                      waiting for its approval is the proposal). It pins the supplier's bank account row and the hash of its number as the approver saw them ("approve what you saw").
-- Rules in the database:
--   1. A row is written only by the execution of an approved finance.supplier_payment.record proposal (b_supplier_payment_proposal, on the shared effect_proposal helpers).
--   2. The pinned account must still be the supplier's active account with the same number hash, the invoice a purchase of that supplier in the same currency and entity, and the amount at most
--      the invoice total.
--   3. When the org has a single owner or admin and the pinned account was created in the last 30 days (a new or a changed account: a change creates a new account row), payable_after is
--      greatest(approved_at, the account's creation) + 24 hours, from the database clock; otherwise it is null.
--   4. Any change of the supplier's bank accounts (a supplier_bank_account_change row) moves that supplier's `approved` payments to `stale`. `stale` is final: the payment can only be asked for again
--      as a new proposal that shows the new account. A payment moves to `paid` only when payable_after has passed (database clock) and its pinned account is still the active one.
--   5. The supplier-confirmation marker (who, when, by which channel) is evidence only: it never shortens the hold.
-- Idempotent; applied files stay untouched. A tenant role inserts (owners and admins, through the proposal) and moves a payment on; nothing is deleted by a tenant role (the org purge deletes them).
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_finance.supplier_payment (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  legal_entity_id uuid NOT NULL,
  -- The supplier (a party), the received invoice this pays (one payment per invoice), and the amount of it.
  party_id uuid NOT NULL,
  purchase_document_id uuid NOT NULL,
  amount crove_finance.amount NOT NULL CHECK (amount > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  -- The account the approver saw, and the hash of its number (and the key id it was made under) at that time.
  bank_account_id uuid NOT NULL,
  number_hash text NOT NULL CHECK (number_hash ~ '^[0-9a-f]{64}$'),
  hash_key_id text NOT NULL CHECK (char_length(hash_key_id) BETWEEN 1 AND 64),
  status text NOT NULL DEFAULT 'approved' CHECK (status IN ('approved', 'paid', 'cancelled', 'stale')),
  -- The approved finance.supplier_payment.record proposal that wrote this row (checked by a_effect_proposal).
  proposal_id uuid NOT NULL,
  approved_by uuid,
  approved_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  -- When the approver's fresh second factor last passed.
  approver_step_up_at timestamptz NOT NULL,
  -- The 24-hour hold of a new or changed account in an org with a single owner or admin (rule 3), and why.
  payable_after timestamptz,
  hold_reason text CHECK (hold_reason IN ('new_account')),
  -- Evidence that the supplier confirmed the account by a channel known beforehand; it never shortens the hold.
  confirmed_by uuid,
  confirmed_at timestamptz,
  confirmed_channel text CHECK (confirmed_channel IN ('phone_on_file', 'in_person', 'email_on_file')),
  stale_at timestamptz,
  cancelled_by uuid,
  cancelled_at timestamptz,
  cancel_reason text CHECK (cancel_reason IS NULL OR char_length(cancel_reason) BETWEEN 1 AND 300),
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT supplier_payment_hold_ck CHECK ((payable_after IS NULL) = (hold_reason IS NULL)),
  CONSTRAINT supplier_payment_confirm_ck CHECK ((confirmed_at IS NULL) = (confirmed_channel IS NULL)),
  CONSTRAINT supplier_payment_state_ck CHECK (
    (status = 'stale') = (stale_at IS NOT NULL)
    AND (status = 'cancelled') = (cancelled_at IS NOT NULL)
    AND (status = 'paid') = (paid_at IS NOT NULL)),
  CONSTRAINT supplier_payment_entity_fk FOREIGN KEY (org_id, legal_entity_id) REFERENCES crove_kernel.legal_entity (org_id, id),
  CONSTRAINT supplier_payment_party_fk FOREIGN KEY (org_id, party_id) REFERENCES crove_kernel.party (org_id, id),
  CONSTRAINT supplier_payment_document_fk FOREIGN KEY (org_id, purchase_document_id) REFERENCES crove_finance.purchase_document (org_id, id),
  CONSTRAINT supplier_payment_account_fk FOREIGN KEY (org_id, bank_account_id) REFERENCES crove_finance.supplier_bank_account (org_id, id),
  CONSTRAINT supplier_payment_approver_fk FOREIGN KEY (org_id, approved_by) REFERENCES crove_kernel.tenant_member (org_id, user_id) ON DELETE SET NULL (approved_by),
  CONSTRAINT supplier_payment_confirmer_fk FOREIGN KEY (org_id, confirmed_by) REFERENCES crove_kernel.tenant_member (org_id, user_id) ON DELETE SET NULL (confirmed_by),
  CONSTRAINT supplier_payment_canceller_fk FOREIGN KEY (org_id, cancelled_by) REFERENCES crove_kernel.tenant_member (org_id, user_id) ON DELETE SET NULL (cancelled_by)
);
-- One live payment per invoice: a stale or cancelled one does not hold it, so the invoice can be asked for again.
CREATE UNIQUE INDEX IF NOT EXISTS supplier_payment_live_uq ON crove_finance.supplier_payment (org_id, purchase_document_id) WHERE status IN ('approved', 'paid');
CREATE INDEX IF NOT EXISTS supplier_payment_document_idx ON crove_finance.supplier_payment (org_id, purchase_document_id);
CREATE UNIQUE INDEX IF NOT EXISTS supplier_payment_proposal_uq ON crove_finance.supplier_payment (org_id, proposal_id);
CREATE INDEX IF NOT EXISTS supplier_payment_entity_idx ON crove_finance.supplier_payment (legal_entity_id, org_id);
CREATE INDEX IF NOT EXISTS supplier_payment_party_idx ON crove_finance.supplier_payment (org_id, party_id, status);
CREATE INDEX IF NOT EXISTS supplier_payment_account_idx ON crove_finance.supplier_payment (org_id, bank_account_id);
CREATE INDEX IF NOT EXISTS supplier_payment_approved_by_idx ON crove_finance.supplier_payment (org_id, approved_by) WHERE approved_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS supplier_payment_confirmed_by_idx ON crove_finance.supplier_payment (org_id, confirmed_by) WHERE confirmed_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS supplier_payment_cancelled_by_idx ON crove_finance.supplier_payment (org_id, cancelled_by) WHERE cancelled_by IS NOT NULL;
SELECT crove_kernel.apply_tenant_rls('crove_finance.supplier_payment');
-- A tenant role moves a payment on (its status and the marker, cancel and paid columns); nothing else changes and nothing is deleted.
REVOKE UPDATE, DELETE ON crove_finance.supplier_payment FROM crove_tenant;
GRANT UPDATE (status, confirmed_by, confirmed_at, confirmed_channel, stale_at, cancelled_by, cancelled_at, cancel_reason, paid_at) ON crove_finance.supplier_payment TO crove_tenant;
DROP TRIGGER IF EXISTS b_legal_entity ON crove_finance.supplier_payment;
CREATE TRIGGER b_legal_entity BEFORE INSERT OR UPDATE OF legal_entity_id ON crove_finance.supplier_payment
  FOR EACH ROW EXECUTE FUNCTION crove_finance.legal_entity_fill();
ALTER TABLE crove_finance.supplier_payment ENABLE ALWAYS TRIGGER b_legal_entity;
DROP POLICY IF EXISTS le_scope ON crove_finance.supplier_payment;
CREATE POLICY le_scope ON crove_finance.supplier_payment AS RESTRICTIVE FOR ALL TO crove_tenant
  USING ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]))
  WITH CHECK ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]));
-- Owners and admins write (and the org's own system context); every member of the org reads (the list and the signals decide who sees what).
DROP POLICY IF EXISTS supplier_payment_insert ON crove_finance.supplier_payment;
CREATE POLICY supplier_payment_insert ON crove_finance.supplier_payment AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = supplier_payment.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin')));
DROP POLICY IF EXISTS supplier_payment_update ON crove_finance.supplier_payment;
CREATE POLICY supplier_payment_update ON crove_finance.supplier_payment AS RESTRICTIVE FOR UPDATE TO crove_tenant
  USING ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = supplier_payment.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin')))
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = supplier_payment.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin')));

-- Rule 1: only the execution of an approved finance.supplier_payment.record proposal writes a row (b_, so the agent write guard, which sorts before it, refuses an agent first). The shared effect_proposal_is_executing and effect_proposal_staff helpers judge it (the proposal is of the
-- writer's org, `approved`, for this command; staff are the support and migration paths); the refusal is a writer guard's 42501, as the RLS matrix expects of a table only a command writes.
CREATE OR REPLACE FUNCTION crove_finance.supplier_payment_proposal_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF crove_finance.effect_proposal_staff(TG_RELID) THEN
    RETURN NEW;
  END IF;
  IF NOT crove_finance.effect_proposal_is_executing(NEW.org_id, NEW.proposal_id, ARRAY['finance.supplier_payment.record']) THEN
    RAISE EXCEPTION 'SUPPLIER_PAYMENT_PROPOSAL' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_finance.supplier_payment_proposal_check() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
DROP TRIGGER IF EXISTS a_effect_proposal ON crove_finance.supplier_payment;
DROP TRIGGER IF EXISTS b_supplier_payment_proposal ON crove_finance.supplier_payment;
CREATE TRIGGER b_supplier_payment_proposal BEFORE INSERT ON crove_finance.supplier_payment
  FOR EACH ROW EXECUTE FUNCTION crove_finance.supplier_payment_proposal_check();

-- Rules 2 and 3 at insert (a writer guard's 42501, as the RLS matrix expects of a table only a command writes: the commands check the same things first and answer in words); the moves of a payment at update (rule 4): approved -> paid, cancelled or stale, each final; the marker is set once, while approved; nothing else changes.
CREATE OR REPLACE FUNCTION crove_finance.supplier_payment_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_account record;
  v_doc record;
  v_single boolean;
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
    IF NOT FOUND OR v_doc.currency <> NEW.currency OR NEW.amount > v_doc.total OR v_doc.legal_entity_id <> NEW.legal_entity_id THEN
      RAISE EXCEPTION 'SUPPLIER_PAYMENT_DOCUMENT' USING ERRCODE = '42501';
    END IF;
    NEW.approved_at := pg_catalog.now();
    SELECT pg_catalog.count(*) = 1 INTO v_single FROM crove_kernel.tenant_member m WHERE m.org_id = NEW.org_id AND m.role IN ('owner', 'admin');
    IF v_single AND v_account.created_at > pg_catalog.now() - interval '30 days' THEN
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
  -- The marker is set once.
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
    NEW.paid_at := pg_catalog.now();
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_finance.supplier_payment_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
DROP TRIGGER IF EXISTS c_supplier_payment_guard ON crove_finance.supplier_payment;
CREATE TRIGGER c_supplier_payment_guard BEFORE INSERT OR UPDATE ON crove_finance.supplier_payment
  FOR EACH ROW EXECUTE FUNCTION crove_finance.supplier_payment_guard();

-- Rule 4: any change of the supplier's accounts makes that supplier's approved payments stale. The writer of a change is an owner or an admin of the org (or its system context), who may move a payment on;
-- a payment in an entity outside an admin's scope stays approved here but cannot be paid (the paid move above checks the pinned account), so the approved amount never goes to an account the approver did not see.
CREATE OR REPLACE FUNCTION crove_finance.supplier_payment_stale_on_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  UPDATE crove_finance.supplier_payment p SET status = 'stale' WHERE p.org_id = NEW.org_id AND p.party_id = NEW.party_id AND p.status = 'approved';
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION crove_finance.supplier_payment_stale_on_change() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
DROP TRIGGER IF EXISTS supplier_payment_stale_on_change ON crove_finance.supplier_bank_account_change;
CREATE TRIGGER supplier_payment_stale_on_change AFTER INSERT ON crove_finance.supplier_bank_account_change
  FOR EACH ROW EXECUTE FUNCTION crove_finance.supplier_payment_stale_on_change();
