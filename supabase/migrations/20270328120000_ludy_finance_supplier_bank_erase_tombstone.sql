-- SPDX-License-Identifier: AGPL-3.0-only
-- Erase tombstone for supplier bank data (#3738, follow-up of #3735 and #3751):
-- on finance.supplier_bank_account.erase, wipe last4 ('****') and hashes ('erased') on
-- ludy_finance.supplier_bank_account, ludy_finance.supplier_bank_account_change,
-- finished ludy_finance.supplier_payment rows, and terminal finance.supplier_payment.record
-- proposal payload/result snapshots in ludy_kernel.proposal for the erased supplier (both
-- subject:v1 and legacy keyed rows). Direct updates to hashes, last4, or change history
-- stay forbidden; only ludy_finance.supplier_bank_account_erase_tombstone(uuid, timestamptz)
-- may perform the exact tombstone transition after active accounts are retired, the
-- supplier's subject key is shredded, and an owner's fresh step-up timestamp is verified.
-- Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. Widen hash and last4 CHECK constraints for explicit erase tombstones
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.conname
    FROM pg_catalog.pg_constraint c
    JOIN pg_catalog.pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
    WHERE c.conrelid = 'ludy_finance.supplier_bank_account'::pg_catalog.regclass
      AND c.contype = 'c'
      AND pg_catalog.array_length(c.conkey, 1) = 1
      AND a.attname IN ('number_hash', 'last4')
  LOOP
    EXECUTE pg_catalog.format('ALTER TABLE ludy_finance.supplier_bank_account DROP CONSTRAINT IF EXISTS %I', r.conname);
  END LOOP;

  FOR r IN
    SELECT c.conname
    FROM pg_catalog.pg_constraint c
    JOIN pg_catalog.pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
    WHERE c.conrelid = 'ludy_finance.supplier_bank_account_change'::pg_catalog.regclass
      AND c.contype = 'c'
      AND pg_catalog.array_length(c.conkey, 1) = 1
      AND a.attname IN ('old_number_hash', 'new_number_hash')
  LOOP
    EXECUTE pg_catalog.format('ALTER TABLE ludy_finance.supplier_bank_account_change DROP CONSTRAINT IF EXISTS %I', r.conname);
  END LOOP;

  FOR r IN
    SELECT c.conname
    FROM pg_catalog.pg_constraint c
    JOIN pg_catalog.pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
    WHERE c.conrelid = 'ludy_finance.supplier_payment'::pg_catalog.regclass
      AND c.contype = 'c'
      AND pg_catalog.array_length(c.conkey, 1) = 1
      AND a.attname = 'number_hash'
  LOOP
    EXECUTE pg_catalog.format('ALTER TABLE ludy_finance.supplier_payment DROP CONSTRAINT IF EXISTS %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE ludy_finance.supplier_bank_account
  DROP CONSTRAINT IF EXISTS supplier_bank_account_erased_ck,
  ADD CONSTRAINT supplier_bank_account_number_hash_check CHECK (number_hash ~ '^(?:[0-9a-f]{64}|erased)$'),
  ADD CONSTRAINT supplier_bank_account_last4_check CHECK (last4 ~ '^(?:[0-9]{4}|\*{4})$'),
  ADD CONSTRAINT supplier_bank_account_erased_ck CHECK ((number_hash = 'erased') = (last4 = '****') AND (number_hash <> 'erased' OR status = 'retired'));

ALTER TABLE ludy_finance.supplier_bank_account_change
  DROP CONSTRAINT IF EXISTS supplier_bank_account_change_hash_ck,
  ADD CONSTRAINT supplier_bank_account_change_old_number_hash_check CHECK (old_number_hash IS NULL OR old_number_hash ~ '^(?:[0-9a-f]{64}|erased)$'),
  ADD CONSTRAINT supplier_bank_account_change_new_number_hash_check CHECK (new_number_hash IS NULL OR new_number_hash ~ '^(?:[0-9a-f]{64}|erased)$'),
  ADD CONSTRAINT supplier_bank_account_change_hash_ck CHECK (
    (kind = 'added' AND old_number_hash IS NULL AND new_number_hash IS NOT NULL AND (new_number_hash ~ '^[0-9a-f]{64}$' OR new_number_hash = 'erased'))
    OR (kind = 'retired' AND old_number_hash IS NOT NULL AND (old_number_hash ~ '^[0-9a-f]{64}$' OR old_number_hash = 'erased') AND new_number_hash IS NULL)
    OR (kind = 'replaced' AND old_number_hash IS NOT NULL AND new_number_hash IS NOT NULL AND (
      (old_number_hash ~ '^[0-9a-f]{64}$' AND new_number_hash ~ '^[0-9a-f]{64}$' AND old_number_hash <> new_number_hash)
      OR (old_number_hash = 'erased' AND new_number_hash = 'erased')
    ))
  );

ALTER TABLE ludy_finance.supplier_payment
  DROP CONSTRAINT IF EXISTS supplier_payment_erased_ck,
  ADD CONSTRAINT supplier_payment_number_hash_check CHECK (number_hash ~ '^(?:[0-9a-f]{64}|erased)$'),
  ADD CONSTRAINT supplier_payment_erased_ck CHECK (number_hash <> 'erased' OR status IN ('paid', 'cancelled', 'stale'));

-- ---------------------------------------------------------------------------
-- 2. Owner-only SECURITY DEFINER erase tombstone helper (no tenant UPDATE grant on change history or hashes)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ludy_finance.supplier_bank_account_erase_tombstone(p_party_id uuid, p_step_up_at timestamptz)
RETURNS TABLE (accounts integer, changes integer, payments integer, proposals integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_actor text := ludy_kernel.ctx_actor_type();
  v_agent uuid := ludy_kernel.ctx_agent_id();
  v_user uuid := ludy_kernel.ctx_user_id();
  v_now timestamptz := pg_catalog.now();
  v_token text;
  v_accounts integer := 0;
  v_changes integer := 0;
  v_payments integer := 0;
  v_proposals integer := 0;
BEGIN
  IF p_party_id IS NULL THEN
    RAISE EXCEPTION 'SUPPLIER_BANK_PARTY_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  IF v_actor IS DISTINCT FROM 'user' OR v_agent IS NOT NULL OR NOT EXISTS (
    SELECT 1 FROM ludy_kernel.tenant_member m
    WHERE m.org_id = v_org AND m.user_id = v_user AND m.role = 'owner'
  ) THEN
    RAISE EXCEPTION 'SUPPLIER_BANK_ERASE_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  -- Require a fresh R3 step-up timestamp matching Runtime STEP_UP_MAX_AGE_S (300s) and CLOCK_TOLERANCE_S (30s).
  IF p_step_up_at IS NULL
     OR p_step_up_at > v_now + interval '30 seconds'
     OR p_step_up_at < v_now - interval '5 minutes' THEN
    RAISE EXCEPTION 'STEP_UP_REQUIRED' USING ERRCODE = '42501';
  END IF;

  -- Lock rows in deterministic order before validating state so concurrent writes serialize cleanly.
  PERFORM 1 FROM ludy_finance.supplier_bank_account b
    WHERE b.org_id = v_org AND b.party_id = p_party_id ORDER BY b.id FOR UPDATE;
  PERFORM 1 FROM ludy_finance.supplier_bank_account_change c
    WHERE c.org_id = v_org AND c.party_id = p_party_id ORDER BY c.id FOR UPDATE;
  PERFORM 1 FROM ludy_finance.supplier_payment p
    WHERE p.org_id = v_org AND p.party_id = p_party_id ORDER BY p.id FOR UPDATE;
  PERFORM 1 FROM ludy_kernel.proposal q
    WHERE q.org_id = v_org
      AND q.command = 'finance.supplier_payment.record'
      AND q.status IN ('executed', 'rejected', 'failed', 'expired')
      AND pg_catalog.lower(q.payload ->> 'partyId') = pg_catalog.lower(p_party_id::text)
      AND (
        (pg_catalog.jsonb_typeof(q.payload) = 'object' AND q.payload ? 'last4' AND q.payload ->> 'last4' IS DISTINCT FROM '****')
        OR (pg_catalog.jsonb_typeof(q.result) = 'object' AND q.result ? 'last4' AND q.result ->> 'last4' IS DISTINCT FROM '****')
      )
    ORDER BY q.id FOR UPDATE;

  IF EXISTS (
    SELECT 1 FROM ludy_finance.supplier_bank_account b
    WHERE b.org_id = v_org AND b.party_id = p_party_id AND b.status = 'active'
  ) THEN
    RAISE EXCEPTION 'SUPPLIER_BANK_ACCOUNT_ACTIVE' USING ERRCODE = '42501';
  END IF;

  -- Subject data key must already be shredded before tombstoning any rows.
  IF EXISTS (
    SELECT 1 FROM ludy_kernel.subject_key k
    WHERE k.org_id = v_org AND k.ref = 'supplier:' || pg_catalog.lower(p_party_id::text)
  ) THEN
    RAISE EXCEPTION 'SUPPLIER_BANK_KEY_ACTIVE' USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1 FROM ludy_finance.supplier_payment p
    WHERE p.org_id = v_org AND p.party_id = p_party_id AND p.status = 'approved'
  ) OR EXISTS (
    SELECT 1 FROM ludy_kernel.proposal q
    WHERE q.org_id = v_org
      AND q.command = 'finance.supplier_payment.record'
      AND q.status = 'pending'
      AND pg_catalog.lower(q.payload ->> 'partyId') = pg_catalog.lower(p_party_id::text)
  ) THEN
    RAISE EXCEPTION 'SUPPLIER_PAYMENT_WAITING' USING ERRCODE = '42501';
  END IF;

  v_token := v_org::text || ':' || pg_catalog.lower(p_party_id::text);
  PERFORM pg_catalog.set_config('ludy.supplier_bank_erase', v_token, true);
  BEGIN
    UPDATE ludy_finance.supplier_bank_account b
       SET number_hash = 'erased',
           last4 = '****'
     WHERE b.org_id = v_org
       AND b.party_id = p_party_id
       AND b.status = 'retired'
       AND (b.number_hash IS DISTINCT FROM 'erased' OR b.last4 IS DISTINCT FROM '****');
    GET DIAGNOSTICS v_accounts = ROW_COUNT;

    UPDATE ludy_finance.supplier_bank_account_change c
       SET old_number_hash = CASE WHEN c.kind IN ('retired', 'replaced') THEN 'erased' ELSE NULL END,
           new_number_hash = CASE WHEN c.kind IN ('added', 'replaced') THEN 'erased' ELSE NULL END
     WHERE c.org_id = v_org
       AND c.party_id = p_party_id
       AND (
         (c.kind = 'added' AND (c.old_number_hash IS NOT NULL OR c.new_number_hash IS DISTINCT FROM 'erased'))
         OR (c.kind = 'retired' AND (c.old_number_hash IS DISTINCT FROM 'erased' OR c.new_number_hash IS NOT NULL))
         OR (c.kind = 'replaced' AND (c.old_number_hash IS DISTINCT FROM 'erased' OR c.new_number_hash IS DISTINCT FROM 'erased'))
       );
    GET DIAGNOSTICS v_changes = ROW_COUNT;

    UPDATE ludy_finance.supplier_payment p
       SET number_hash = 'erased'
     WHERE p.org_id = v_org
       AND p.party_id = p_party_id
       AND p.status IN ('paid', 'cancelled', 'stale')
       AND p.number_hash IS DISTINCT FROM 'erased';
    GET DIAGNOSTICS v_payments = ROW_COUNT;

    UPDATE ludy_kernel.proposal q
       SET payload = CASE
                       WHEN pg_catalog.jsonb_typeof(q.payload) = 'object'
                            AND q.payload ? 'last4'
                            AND q.payload ->> 'last4' IS DISTINCT FROM '****'
                         THEN pg_catalog.jsonb_set(q.payload, '{last4}', pg_catalog.to_jsonb('****'::text), false)
                       ELSE q.payload
                     END,
           result = CASE
                      WHEN pg_catalog.jsonb_typeof(q.result) = 'object'
                           AND q.result ? 'last4'
                           AND q.result ->> 'last4' IS DISTINCT FROM '****'
                        THEN pg_catalog.jsonb_set(q.result, '{last4}', pg_catalog.to_jsonb('****'::text), false)
                      ELSE q.result
                    END
     WHERE q.org_id = v_org
       AND q.command = 'finance.supplier_payment.record'
       AND q.status IN ('executed', 'rejected', 'failed', 'expired')
       AND pg_catalog.lower(q.payload ->> 'partyId') = pg_catalog.lower(p_party_id::text)
       AND (
         (pg_catalog.jsonb_typeof(q.payload) = 'object' AND q.payload ? 'last4' AND q.payload ->> 'last4' IS DISTINCT FROM '****')
         OR (pg_catalog.jsonb_typeof(q.result) = 'object' AND q.result ? 'last4' AND q.result ->> 'last4' IS DISTINCT FROM '****')
       );
    GET DIAGNOSTICS v_proposals = ROW_COUNT;
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_catalog.set_config('ludy.supplier_bank_erase', '', true);
    RAISE;
  END;
  PERFORM pg_catalog.set_config('ludy.supplier_bank_erase', '', true);

  RETURN QUERY SELECT v_accounts, v_changes, v_payments, v_proposals;
END $$;

REVOKE ALL ON FUNCTION ludy_finance.supplier_bank_account_erase_tombstone(uuid, timestamptz) FROM PUBLIC;
DO $$
DECLARE
  v_role text;
BEGIN
  FOR v_role IN
    SELECT rolname FROM pg_catalog.pg_roles
    WHERE rolname LIKE 'ludy\_%' AND rolname <> current_user
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_finance.supplier_bank_account_erase_tombstone(uuid, timestamptz) FROM %I', v_role);
  END LOOP;
END $$;
-- Post-ADR-0054 Stage 7 (20270315090000): ludy_app is always the active API login role.
GRANT EXECUTE ON FUNCTION ludy_finance.supplier_bank_account_erase_tombstone(uuid, timestamptz) TO ludy_app;

-- ---------------------------------------------------------------------------
-- 3. Narrow guard triggers: only the exact erase tombstone transition may touch hashes/last4
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ludy_finance.supplier_bank_account_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_erase_owner text;
  v_cur_role text := current_user;
  v_token text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'active' OR NEW.number_hash !~ '^[0-9a-f]{64}$' OR NEW.last4 !~ '^[0-9]{4}$' THEN
      RAISE EXCEPTION 'SUPPLIER_BANK_ACCOUNT_STATE' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.number_hash IS DISTINCT FROM OLD.number_hash OR NEW.last4 IS DISTINCT FROM OLD.last4 THEN
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
       AND OLD.status = 'retired'
       AND NEW.status = 'retired'
       AND NEW.number_hash = 'erased'
       AND NEW.last4 = '****'
       AND pg_catalog.to_jsonb(NEW) - ARRAY['number_hash', 'last4'] = pg_catalog.to_jsonb(OLD) - ARRAY['number_hash', 'last4'] THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'SUPPLIER_BANK_ACCOUNT_STATE' USING ERRCODE = '42501';
  END IF;

  -- The author's membership ending clears created_by (the foreign key's SET NULL); that is the only other change allowed.
  IF pg_catalog.to_jsonb(NEW) - ARRAY['status', 'retired_at', 'created_by'] <> pg_catalog.to_jsonb(OLD) - ARRAY['status', 'retired_at', 'created_by']
     OR (NEW.created_by IS NOT NULL AND NEW.created_by IS DISTINCT FROM OLD.created_by)
     OR (OLD.status = 'retired' AND (NEW.status <> 'retired' OR NEW.retired_at IS DISTINCT FROM OLD.retired_at)) THEN
    RAISE EXCEPTION 'SUPPLIER_BANK_ACCOUNT_STATE' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION ludy_finance.supplier_bank_account_guard() FROM PUBLIC;
DO $$
DECLARE
  v_role text;
BEGIN
  FOR v_role IN
    SELECT rolname FROM pg_catalog.pg_roles
    WHERE rolname LIKE 'ludy\_%' AND rolname <> current_user
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_finance.supplier_bank_account_guard() FROM %I', v_role);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION ludy_finance.supplier_bank_account_change_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_erase_owner text;
  v_cur_role text := current_user;
  v_token text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF (NEW.old_number_hash IS NOT NULL AND NEW.old_number_hash !~ '^[0-9a-f]{64}$')
       OR (NEW.new_number_hash IS NOT NULL AND NEW.new_number_hash !~ '^[0-9a-f]{64}$') THEN
      RAISE EXCEPTION 'SUPPLIER_BANK_CHANGE_IMMUTABLE' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  -- A departing member's FK ON DELETE SET NULL clears changed_by only.
  IF NEW.changed_by IS NULL
     AND pg_catalog.to_jsonb(NEW) - ARRAY['changed_by'] = pg_catalog.to_jsonb(OLD) - ARRAY['changed_by'] THEN
    RETURN NEW;
  END IF;

  -- Superuser test helpers backdate changed_at outside actor contexts without touching any hash or identity column.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = v_cur_role AND r.rolsuper)
     AND ludy_kernel.ctx_actor_type() IS NULL
     AND pg_catalog.to_jsonb(NEW) - ARRAY['changed_at'] = pg_catalog.to_jsonb(OLD) - ARRAY['changed_at'] THEN
    RETURN NEW;
  END IF;

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
     AND NOT EXISTS (
       SELECT 1 FROM ludy_finance.supplier_bank_account a
       WHERE a.org_id = OLD.org_id AND a.party_id = OLD.party_id AND a.status = 'active'
     )
     AND pg_catalog.to_jsonb(NEW) - ARRAY['old_number_hash', 'new_number_hash'] = pg_catalog.to_jsonb(OLD) - ARRAY['old_number_hash', 'new_number_hash']
     AND (
       (OLD.kind = 'added' AND NEW.old_number_hash IS NULL AND NEW.new_number_hash = 'erased')
       OR (OLD.kind = 'retired' AND NEW.old_number_hash = 'erased' AND NEW.new_number_hash IS NULL)
       OR (OLD.kind = 'replaced' AND NEW.old_number_hash = 'erased' AND NEW.new_number_hash = 'erased')
     ) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'SUPPLIER_BANK_CHANGE_IMMUTABLE' USING ERRCODE = '42501';
END $$;

REVOKE ALL ON FUNCTION ludy_finance.supplier_bank_account_change_guard() FROM PUBLIC;
DO $$
DECLARE
  v_role text;
BEGIN
  FOR v_role IN
    SELECT rolname FROM pg_catalog.pg_roles
    WHERE rolname LIKE 'ludy\_%' AND rolname <> current_user
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_finance.supplier_bank_account_change_guard() FROM %I', v_role);
  END LOOP;
END $$;

DROP TRIGGER IF EXISTS supplier_bank_account_change_guard ON ludy_finance.supplier_bank_account_change;
CREATE TRIGGER supplier_bank_account_change_guard BEFORE INSERT OR UPDATE ON ludy_finance.supplier_bank_account_change
  FOR EACH ROW EXECUTE FUNCTION ludy_finance.supplier_bank_account_change_guard();

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
    IF (v_single OR coalesce(v_self, false)) AND v_account.created_at > pg_catalog.now() - interval '30 days' THEN
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
    WHERE rolname LIKE 'ludy\_%' AND rolname <> current_user
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_finance.supplier_payment_guard() FROM %I', v_role);
  END LOOP;
END $$;
