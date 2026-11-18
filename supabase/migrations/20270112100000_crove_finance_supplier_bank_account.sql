-- SPDX-License-Identifier: AGPL-3.0-only
-- Supplier bank accounts and their change history (#3113 slice 1, #3698; JOY's answers of 2026-11-14 on #3113). V5 rule 3 (a supplier's account changed while a payment to that supplier waits)
-- needs the data behind it:
--   supplier_bank_account          one row per account of a supplier (a party): the bank, the holder, the full number SEALED under the supplier's subject key (`supplier:<party_id>`, ADR-0017, class
--                                  payment, opened only by a sensitive query), a keyed hash of the normalized digits (is it the same account, the change check) and the last four digits for display. A change never
--                                  edits a number: the old row is retired and a new one added.
--   supplier_bank_account_change   the append-only history of those changes (added, replaced, retired), with the old and new hash and the time the actor's fresh second factor passed.
-- The accounts are org-level (no legal entity); a payment to a supplier is entity-level (#3699). Only owners and admins write, and only the commands do; nothing here carries a full number in the clear.
-- Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_finance.supplier_bank_account (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  -- The supplier (a party).
  party_id uuid NOT NULL,
  bank_name text NOT NULL CHECK (char_length(bank_name) BETWEEN 1 AND 100),
  -- The account holder's name (personal data when the supplier is a sole trader), sealed under the same subject key as the number, so one shred erases both.
  account_holder_sealed text NOT NULL CHECK (pg_catalog.length(account_holder_sealed) <= 2000 AND account_holder_sealed LIKE 'crove:s1:%'),
  -- The full number, sealed under the supplier's subject key (`crove:s1:...`); never read back except by a sensitive query.
  number_sealed text NOT NULL CHECK (pg_catalog.length(number_sealed) <= 2000 AND number_sealed LIKE 'crove:s1:%'),
  -- Keyed hash of the normalized digits (hex of 32 bytes): not reversible, the same number gives the same hash within the org.
  number_hash text NOT NULL CHECK (number_hash ~ '^[0-9a-f]{64}$'),
  -- The id of the credential key the hash was made under (ctx.keyedHashKeyId): after a key rotation a hash under another id is made again from the sealed number, never read as a change.
  hash_key_id text NOT NULL CHECK (char_length(hash_key_id) BETWEEN 1 AND 64),
  last4 text NOT NULL CHECK (last4 ~ '^[0-9]{4}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  retired_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  -- An account is retired exactly when it has its time.
  CONSTRAINT supplier_bank_account_retired_ck CHECK ((status = 'retired') = (retired_at IS NOT NULL)),
  CONSTRAINT supplier_bank_account_party_fk FOREIGN KEY (org_id, party_id) REFERENCES crove_kernel.party (org_id, id),
  CONSTRAINT supplier_bank_account_member_fk FOREIGN KEY (org_id, created_by) REFERENCES crove_kernel.tenant_member (org_id, user_id) ON DELETE SET NULL (created_by)
);
-- One active row per supplier and number.
CREATE UNIQUE INDEX IF NOT EXISTS supplier_bank_account_active_uq ON crove_finance.supplier_bank_account (org_id, party_id, number_hash) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS supplier_bank_account_party_idx ON crove_finance.supplier_bank_account (org_id, party_id);
CREATE INDEX IF NOT EXISTS supplier_bank_account_created_by_idx ON crove_finance.supplier_bank_account (org_id, created_by) WHERE created_by IS NOT NULL;
SELECT crove_kernel.apply_tenant_rls('crove_finance.supplier_bank_account');
-- Only the status and its time may change (an account is retired, never edited); nothing is deleted by a tenant role.
REVOKE UPDATE, DELETE ON crove_finance.supplier_bank_account FROM crove_tenant;
GRANT UPDATE (status, retired_at) ON crove_finance.supplier_bank_account TO crove_tenant;

CREATE TABLE IF NOT EXISTS crove_finance.supplier_bank_account_change (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  party_id uuid NOT NULL,
  -- The account row this change added or retired.
  account_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('added', 'replaced', 'retired')),
  old_number_hash text CHECK (old_number_hash IS NULL OR old_number_hash ~ '^[0-9a-f]{64}$'),
  new_number_hash text CHECK (new_number_hash IS NULL OR new_number_hash ~ '^[0-9a-f]{64}$'),
  -- Who changed it, and when the actor's second factor last passed (the proof the step-up held).
  changed_by uuid,
  changed_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  step_up_at timestamptz NOT NULL,
  PRIMARY KEY (org_id, id),
  -- added has only the new hash, retired only the old one, replaced both.
  CONSTRAINT supplier_bank_account_change_hash_ck CHECK (
    (kind = 'added' AND old_number_hash IS NULL AND new_number_hash IS NOT NULL)
    OR (kind = 'retired' AND old_number_hash IS NOT NULL AND new_number_hash IS NULL)
    OR (kind = 'replaced' AND old_number_hash IS NOT NULL AND new_number_hash IS NOT NULL AND old_number_hash <> new_number_hash)),
  CONSTRAINT supplier_bank_account_change_party_fk FOREIGN KEY (org_id, party_id) REFERENCES crove_kernel.party (org_id, id),
  CONSTRAINT supplier_bank_account_change_account_fk FOREIGN KEY (org_id, account_id) REFERENCES crove_finance.supplier_bank_account (org_id, id),
  CONSTRAINT supplier_bank_account_change_member_fk FOREIGN KEY (org_id, changed_by) REFERENCES crove_kernel.tenant_member (org_id, user_id) ON DELETE SET NULL (changed_by)
);
CREATE INDEX IF NOT EXISTS supplier_bank_account_change_party_idx ON crove_finance.supplier_bank_account_change (org_id, party_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS supplier_bank_account_change_account_idx ON crove_finance.supplier_bank_account_change (org_id, account_id);
CREATE INDEX IF NOT EXISTS supplier_bank_account_change_by_idx ON crove_finance.supplier_bank_account_change (org_id, changed_by) WHERE changed_by IS NOT NULL;
SELECT crove_kernel.apply_tenant_rls('crove_finance.supplier_bank_account_change');
REVOKE UPDATE, DELETE ON crove_finance.supplier_bank_account_change FROM crove_tenant;

-- Owners and admins write both tables (and the system context for the org's own jobs); every member of the org reads (a number is only ciphertext and a hash here; the screen and the
-- sensitive reads decide who sees what).
DROP POLICY IF EXISTS supplier_bank_account_insert ON crove_finance.supplier_bank_account;
CREATE POLICY supplier_bank_account_insert ON crove_finance.supplier_bank_account AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = supplier_bank_account.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin')));
DROP POLICY IF EXISTS supplier_bank_account_update ON crove_finance.supplier_bank_account;
CREATE POLICY supplier_bank_account_update ON crove_finance.supplier_bank_account AS RESTRICTIVE FOR UPDATE TO crove_tenant
  USING ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = supplier_bank_account.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin')))
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = supplier_bank_account.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin')));
DROP POLICY IF EXISTS supplier_bank_account_change_insert ON crove_finance.supplier_bank_account_change;
CREATE POLICY supplier_bank_account_change_insert ON crove_finance.supplier_bank_account_change AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = supplier_bank_account_change.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin')));

-- An account is retired once and nothing else about it changes: the bank, the holder, the sealed number, the hash and the supplier are fixed; a retired account never comes back.
CREATE OR REPLACE FUNCTION crove_finance.supplier_bank_account_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'active' THEN
      RAISE EXCEPTION 'SUPPLIER_BANK_ACCOUNT_STATE' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  -- The author's membership ending clears created_by (the foreign key's SET NULL); that is the only other change allowed.
  IF pg_catalog.to_jsonb(NEW) - ARRAY['status', 'retired_at', 'created_by'] <> pg_catalog.to_jsonb(OLD) - ARRAY['status', 'retired_at', 'created_by']
     OR (NEW.created_by IS NOT NULL AND NEW.created_by IS DISTINCT FROM OLD.created_by)
     OR (OLD.status = 'retired' AND (NEW.status <> 'retired' OR NEW.retired_at IS DISTINCT FROM OLD.retired_at)) THEN
    RAISE EXCEPTION 'SUPPLIER_BANK_ACCOUNT_STATE' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_finance.supplier_bank_account_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
DROP TRIGGER IF EXISTS supplier_bank_account_guard ON crove_finance.supplier_bank_account;
CREATE TRIGGER supplier_bank_account_guard BEFORE INSERT OR UPDATE ON crove_finance.supplier_bank_account
  FOR EACH ROW EXECUTE FUNCTION crove_finance.supplier_bank_account_guard();
