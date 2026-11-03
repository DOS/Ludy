-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #2500, ADR-0044, plan einvoice-issue.md sections 6 and 8): sales e-invoice drafts and the series they are
-- issued from. Idempotent; applied files stay untouched. Nothing here calls a provider: a draft is made, edited and checked.
--
-- einvoice_series   a template number and a symbol a provider holds, linked to one legal entity of the org (a company with several
--                   entities issues from the series of the right one). Read from the provider (the offline sandbox's today), never
--                   typed or built by Ludy. At most one default per entity. Every member reads them; owners and admins write.
--
-- einvoice_draft    one sales invoice before it is issued: the buyer (a customer of the org, or typed), the date, the series, the totals
--                   (computed by the command, never taken from the caller; total = subtotal + VAT), Ludy's idempotency key (a UUID kept
--                   on the draft and sent as the provider's own key) and the state (draft, submitting, pending, issued, rejected,
--                   failed). Per legal entity. Owners, admins and members write it, and only while it is a draft: a non-system writer
--                   can neither change the state, the key or the provider's reference nor touch a draft that has left `draft`.
--
-- einvoice_draft_line  the lines of a draft (description, unit, quantity, unit price, amount, VAT rate and amount), under the same
--                   rule: written only while the draft is a draft.
--
-- The buyer's name, tax code, address and email are personal data when the buyer is an individual: they are classified, listed in
-- the personal-data registry, and kept like the books once a draft has become an invoice.
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. Series
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_finance.einvoice_series (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  legal_entity_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_]{1,30}$'),
  -- One digit: 1 VAT invoice, 2 sales invoice, and so on (Circular 91, Appendix I).
  template_no text NOT NULL CHECK (template_no ~ '^[0-9]$'),
  -- Six characters: C (coded) or K, a 2-digit year, a type letter, 2 characters the seller chose.
  symbol text NOT NULL CHECK (symbol ~ '^[CK][0-9]{2}[A-Z][A-Z0-9]{2}$'),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 200),
  is_default boolean NOT NULL DEFAULT false,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT einvoice_series_uq UNIQUE (org_id, legal_entity_id, provider, template_no, symbol),
  -- Backs the draft's composite key: a draft's series belongs to the draft's entity.
  CONSTRAINT einvoice_series_entity_id_uq UNIQUE (org_id, legal_entity_id, id),
  CONSTRAINT einvoice_series_entity_fk FOREIGN KEY (org_id, legal_entity_id) REFERENCES crove_kernel.legal_entity (org_id, id),
  CONSTRAINT einvoice_series_member_fk FOREIGN KEY (org_id, created_by) REFERENCES crove_kernel.tenant_member (org_id, user_id) ON DELETE SET NULL (created_by)
);
CREATE INDEX IF NOT EXISTS einvoice_series_entity_idx ON crove_finance.einvoice_series (legal_entity_id, org_id);
CREATE INDEX IF NOT EXISTS einvoice_series_created_by_idx ON crove_finance.einvoice_series (org_id, created_by) WHERE created_by IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS einvoice_series_default_uq ON crove_finance.einvoice_series (org_id, legal_entity_id) WHERE is_default;
SELECT crove_kernel.apply_tenant_rls('crove_finance.einvoice_series');
REVOKE UPDATE ON crove_finance.einvoice_series FROM crove_tenant;
GRANT UPDATE (is_default, description) ON crove_finance.einvoice_series TO crove_tenant;
DROP TRIGGER IF EXISTS b_legal_entity ON crove_finance.einvoice_series;
CREATE TRIGGER b_legal_entity BEFORE INSERT OR UPDATE OF legal_entity_id ON crove_finance.einvoice_series
  FOR EACH ROW EXECUTE FUNCTION crove_finance.legal_entity_fill();
ALTER TABLE crove_finance.einvoice_series ENABLE ALWAYS TRIGGER b_legal_entity;
DROP POLICY IF EXISTS le_scope ON crove_finance.einvoice_series;
CREATE POLICY le_scope ON crove_finance.einvoice_series AS RESTRICTIVE FOR ALL TO crove_tenant
  USING ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]))
  WITH CHECK ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]));
DROP POLICY IF EXISTS einvoice_series_insert ON crove_finance.einvoice_series;
CREATE POLICY einvoice_series_insert ON crove_finance.einvoice_series AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = einvoice_series.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin')));
DROP POLICY IF EXISTS einvoice_series_update ON crove_finance.einvoice_series;
CREATE POLICY einvoice_series_update ON crove_finance.einvoice_series AS RESTRICTIVE FOR UPDATE TO crove_tenant
  USING ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = einvoice_series.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin')))
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = einvoice_series.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin')));
DROP POLICY IF EXISTS einvoice_series_delete ON crove_finance.einvoice_series;
CREATE POLICY einvoice_series_delete ON crove_finance.einvoice_series AS RESTRICTIVE FOR DELETE TO crove_tenant
  USING ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = einvoice_series.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin')));

-- ---------------------------------------------------------------------------
-- 2. Drafts
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_finance.einvoice_draft (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  legal_entity_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'submitting', 'pending', 'issued', 'rejected', 'failed')),
  series_id uuid,
  invoice_date date NOT NULL,
  currency text NOT NULL DEFAULT 'VND' CHECK (currency ~ '^[A-Z]{3}$'),
  buyer_kind text NOT NULL CHECK (buyer_kind IN ('business', 'individual', 'consumer')),
  -- A customer of the org, when the buyer was picked from them; a removed party leaves the typed details.
  buyer_party_id uuid,
  -- Its shape is the check's business (a draft may hold a tax code that does not pass yet); the database keeps only its length.
  buyer_tax_code text CHECK (buyer_tax_code IS NULL OR char_length(buyer_tax_code) BETWEEN 1 AND 20),
  buyer_name text CHECK (buyer_name IS NULL OR char_length(buyer_name) BETWEEN 1 AND 400),
  buyer_address text CHECK (buyer_address IS NULL OR char_length(buyer_address) BETWEEN 1 AND 500),
  buyer_email text CHECK (buyer_email IS NULL OR char_length(buyer_email) BETWEEN 3 AND 254),
  subtotal crove_finance.amount NOT NULL,
  vat_amount crove_finance.amount NOT NULL,
  total crove_finance.amount NOT NULL,
  -- Ludy's key for this invoice, sent as the provider's own idempotency field where it has one.
  idempotency_key uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  -- The provider's reference once it has accepted the invoice.
  provider_ref text CHECK (provider_ref IS NULL OR char_length(provider_ref) BETWEEN 1 AND 200),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT einvoice_draft_total_check CHECK (total = subtotal + vat_amount),
  -- Once the provider has accepted the invoice it has a reference.
  CONSTRAINT einvoice_draft_ref_check CHECK (state NOT IN ('pending', 'issued') OR provider_ref IS NOT NULL),
  CONSTRAINT einvoice_draft_key_uq UNIQUE (org_id, idempotency_key),
  -- Backs the lines' composite key.
  CONSTRAINT einvoice_draft_entity_id_uq UNIQUE (org_id, legal_entity_id, id),
  CONSTRAINT einvoice_draft_entity_fk FOREIGN KEY (org_id, legal_entity_id) REFERENCES crove_kernel.legal_entity (org_id, id),
  -- A draft's series belongs to the draft's entity.
  CONSTRAINT einvoice_draft_series_fk FOREIGN KEY (org_id, legal_entity_id, series_id) REFERENCES crove_finance.einvoice_series (org_id, legal_entity_id, id),
  CONSTRAINT einvoice_draft_party_fk FOREIGN KEY (org_id, buyer_party_id) REFERENCES crove_kernel.party (org_id, id) ON DELETE SET NULL (buyer_party_id),
  CONSTRAINT einvoice_draft_member_fk FOREIGN KEY (org_id, created_by) REFERENCES crove_kernel.tenant_member (org_id, user_id) ON DELETE SET NULL (created_by)
);
CREATE INDEX IF NOT EXISTS einvoice_draft_entity_idx ON crove_finance.einvoice_draft (legal_entity_id, org_id);
CREATE INDEX IF NOT EXISTS einvoice_draft_series_idx ON crove_finance.einvoice_draft (org_id, legal_entity_id, series_id) WHERE series_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS einvoice_draft_party_idx ON crove_finance.einvoice_draft (org_id, buyer_party_id) WHERE buyer_party_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS einvoice_draft_created_by_idx ON crove_finance.einvoice_draft (org_id, created_by) WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS einvoice_draft_date_idx ON crove_finance.einvoice_draft (org_id, invoice_date DESC);
SELECT crove_kernel.apply_tenant_rls('crove_finance.einvoice_draft');
DROP TRIGGER IF EXISTS b_legal_entity ON crove_finance.einvoice_draft;
CREATE TRIGGER b_legal_entity BEFORE INSERT OR UPDATE OF legal_entity_id ON crove_finance.einvoice_draft
  FOR EACH ROW EXECUTE FUNCTION crove_finance.legal_entity_fill();
ALTER TABLE crove_finance.einvoice_draft ENABLE ALWAYS TRIGGER b_legal_entity;
DROP POLICY IF EXISTS le_scope ON crove_finance.einvoice_draft;
CREATE POLICY le_scope ON crove_finance.einvoice_draft AS RESTRICTIVE FOR ALL TO crove_tenant
  USING ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]))
  WITH CHECK ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]));
-- Owners, admins and members write drafts (the roles that may approve a sale); a viewer only reads.
DROP POLICY IF EXISTS einvoice_draft_insert ON crove_finance.einvoice_draft;
CREATE POLICY einvoice_draft_insert ON crove_finance.einvoice_draft AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = einvoice_draft.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member')));
DROP POLICY IF EXISTS einvoice_draft_update ON crove_finance.einvoice_draft;
CREATE POLICY einvoice_draft_update ON crove_finance.einvoice_draft AS RESTRICTIVE FOR UPDATE TO crove_tenant
  USING ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = einvoice_draft.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member')))
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = einvoice_draft.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member')));
DROP POLICY IF EXISTS einvoice_draft_delete ON crove_finance.einvoice_draft;
CREATE POLICY einvoice_draft_delete ON crove_finance.einvoice_draft AS RESTRICTIVE FOR DELETE TO crove_tenant
  USING ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = einvoice_draft.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member')));

-- The state machine of a draft, kept in the database (ADR-0044 point 4). Runs as the writer.
--   A person (any non-system writer) edits a draft and nothing else: it cannot choose the key (an insert gets a fresh one), change the state, the key or the
--   provider's reference, and it cannot touch or delete a draft that has left `draft`.
--   The system context (the issue job, a later step) moves a draft along these transitions and no others, each raising EINVOICE_STATE otherwise:
--     draft -> submitting; submitting -> pending, issued, rejected or failed; pending -> issued, rejected or failed; failed -> submitting (the same key);
--     rejected -> draft (a new key and no provider reference: a rejected invoice's key is never reused).
--   `issued` is terminal. Once a draft has left `draft` its content (series, date, buyer, amounts) is frozen for the system context too: a transition changes
--   only the state, the provider's reference (set once, from empty) and, on rejected -> draft, the key. A system insert is a `draft` with no reference.
--   Whoever the writer is, a draft that has left `draft` is deleted only by the org's purge.
--   The foreign keys' own action (a member or a party removed) only empties `created_by` or `buyer_party_id`, whatever the state and the writer.
CREATE OR REPLACE FUNCTION crove_finance.einvoice_draft_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_system boolean := (SELECT crove_kernel.ctx_actor_type()) = 'system';
  v_move text;
BEGIN
  IF TG_OP = 'UPDATE'
     AND pg_catalog.to_jsonb(NEW) - ARRAY['created_by', 'buyer_party_id'] = pg_catalog.to_jsonb(OLD) - ARRAY['created_by', 'buyer_party_id']
     AND (NEW.created_by IS NULL OR NEW.created_by IS NOT DISTINCT FROM OLD.created_by)
     AND (NEW.buyer_party_id IS NULL OR NEW.buyer_party_id IS NOT DISTINCT FROM OLD.buyer_party_id) THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.state = 'draft' THEN
      RETURN OLD;
    END IF;
    -- The org's purge, and only it (the checks of crove_kernel.purge_append_only_guard): the role that owns org_purge, the transaction-local mark it sets
    -- around these deletes, the worker login in the org's system context, the org offboarding. Nested, so every other caller meets only the catalog checks.
    IF (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = CURRENT_USER) = (SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.oid = 'crove_kernel.org_purge(integer)'::pg_catalog.regprocedure)
       AND pg_catalog.current_setting('crove.org_purge', true) = OLD.org_id::text THEN
      IF pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER')
         AND crove_kernel.ctx_actor_type() = 'system'
         AND crove_kernel.ctx_org_id() = OLD.org_id
         AND EXISTS (SELECT 1 FROM crove_kernel.tenant t WHERE t.org_id = OLD.org_id AND t.status = 'offboarding') THEN
        RETURN OLD;
      END IF;
    END IF;
    RAISE EXCEPTION '%', CASE WHEN v_system THEN 'EINVOICE_STATE' ELSE 'EINVOICE_NOT_DRAFT' END USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'draft' OR NEW.provider_ref IS NOT NULL THEN
      RAISE EXCEPTION '%', CASE WHEN v_system THEN 'EINVOICE_STATE' ELSE 'EINVOICE_NOT_DRAFT' END USING ERRCODE = '42501';
    END IF;
    -- The key is the database's, never a person's.
    IF NOT v_system THEN
      NEW.idempotency_key := pg_catalog.gen_random_uuid();
    END IF;
    RETURN NEW;
  END IF;

  -- An update.
  IF NOT v_system THEN
    IF OLD.state <> 'draft' THEN
      RAISE EXCEPTION 'EINVOICE_NOT_DRAFT' USING ERRCODE = '42501';
    END IF;
    IF NEW.state IS DISTINCT FROM OLD.state OR NEW.provider_ref IS DISTINCT FROM OLD.provider_ref OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key THEN
      RAISE EXCEPTION 'EINVOICE_FIELD_LOCKED' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.state = 'issued' THEN
    RAISE EXCEPTION 'EINVOICE_STATE' USING ERRCODE = '42501';
  END IF;
  IF NEW.state = OLD.state THEN
    -- No move. A draft is edited (its key and reference stay); anything else changes nothing but the time it was touched.
    IF OLD.state = 'draft' THEN
      IF NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR NEW.provider_ref IS DISTINCT FROM OLD.provider_ref THEN
        RAISE EXCEPTION 'EINVOICE_STATE' USING ERRCODE = '42501';
      END IF;
    ELSIF pg_catalog.to_jsonb(NEW) - 'updated_at' <> pg_catalog.to_jsonb(OLD) - 'updated_at' THEN
      RAISE EXCEPTION 'EINVOICE_STATE' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  v_move := OLD.state || '>' || NEW.state;
  IF v_move NOT IN ('draft>submitting', 'submitting>pending', 'submitting>issued', 'submitting>rejected', 'submitting>failed', 'pending>issued', 'pending>rejected', 'pending>failed',
                    'failed>submitting', 'rejected>draft') THEN
    RAISE EXCEPTION 'EINVOICE_STATE' USING ERRCODE = '42501';
  END IF;
  -- The content stays as it was.
  IF pg_catalog.to_jsonb(NEW) - ARRAY['state', 'provider_ref', 'idempotency_key', 'updated_at'] <> pg_catalog.to_jsonb(OLD) - ARRAY['state', 'provider_ref', 'idempotency_key', 'updated_at'] THEN
    RAISE EXCEPTION 'EINVOICE_STATE' USING ERRCODE = '42501';
  END IF;
  IF v_move = 'rejected>draft' THEN
    -- A fresh key and an empty reference.
    IF NEW.idempotency_key = OLD.idempotency_key OR NEW.provider_ref IS NOT NULL THEN
      RAISE EXCEPTION 'EINVOICE_STATE' USING ERRCODE = '42501';
    END IF;
  ELSE
    -- The same key, and a reference that is only ever set from empty.
    IF NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR (OLD.provider_ref IS NOT NULL AND NEW.provider_ref IS DISTINCT FROM OLD.provider_ref) THEN
      RAISE EXCEPTION 'EINVOICE_STATE' USING ERRCODE = '42501';
    END IF;
    IF v_move = 'draft>submitting' AND NEW.provider_ref IS NOT NULL THEN
      RAISE EXCEPTION 'EINVOICE_STATE' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_finance.einvoice_draft_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
DROP TRIGGER IF EXISTS einvoice_draft_guard ON crove_finance.einvoice_draft;
CREATE TRIGGER einvoice_draft_guard BEFORE INSERT OR UPDATE OR DELETE ON crove_finance.einvoice_draft
  FOR EACH ROW EXECUTE FUNCTION crove_finance.einvoice_draft_guard();

-- ---------------------------------------------------------------------------
-- 3. Lines
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_finance.einvoice_draft_line (
  org_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  legal_entity_id uuid NOT NULL,
  draft_id uuid NOT NULL,
  line_no int NOT NULL CHECK (line_no > 0),
  -- May be empty while a draft is being written; the checks say so before it is issued.
  description text NOT NULL CHECK (char_length(description) <= 500),
  unit text CHECK (unit IS NULL OR char_length(unit) BETWEEN 1 AND 50),
  quantity crove_finance.quantity NOT NULL,
  unit_price crove_finance.unit_amount NOT NULL,
  amount crove_finance.amount NOT NULL,
  vat_rate text NOT NULL CHECK (char_length(vat_rate) BETWEEN 1 AND 20),
  vat_amount crove_finance.amount NOT NULL,
  PRIMARY KEY (org_id, id),
  CONSTRAINT einvoice_draft_line_no_uq UNIQUE (org_id, draft_id, line_no),
  CONSTRAINT einvoice_draft_line_draft_fk FOREIGN KEY (org_id, legal_entity_id, draft_id) REFERENCES crove_finance.einvoice_draft (org_id, legal_entity_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS einvoice_draft_line_entity_idx ON crove_finance.einvoice_draft_line (legal_entity_id, org_id);
-- The foreign key to the draft (G3 fk-index).
CREATE INDEX IF NOT EXISTS einvoice_draft_line_draft_idx ON crove_finance.einvoice_draft_line (org_id, legal_entity_id, draft_id);
SELECT crove_kernel.apply_tenant_rls('crove_finance.einvoice_draft_line');
DROP TRIGGER IF EXISTS b_legal_entity ON crove_finance.einvoice_draft_line;
CREATE TRIGGER b_legal_entity BEFORE INSERT OR UPDATE OF legal_entity_id, draft_id ON crove_finance.einvoice_draft_line
  FOR EACH ROW EXECUTE FUNCTION crove_finance.legal_entity_fill('crove_finance.einvoice_draft', 'draft_id');
ALTER TABLE crove_finance.einvoice_draft_line ENABLE ALWAYS TRIGGER b_legal_entity;
DROP POLICY IF EXISTS le_scope ON crove_finance.einvoice_draft_line;
CREATE POLICY le_scope ON crove_finance.einvoice_draft_line AS RESTRICTIVE FOR ALL TO crove_tenant
  USING ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]))
  WITH CHECK ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]));
DROP POLICY IF EXISTS einvoice_draft_line_insert ON crove_finance.einvoice_draft_line;
CREATE POLICY einvoice_draft_line_insert ON crove_finance.einvoice_draft_line AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = einvoice_draft_line.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member')));
DROP POLICY IF EXISTS einvoice_draft_line_update ON crove_finance.einvoice_draft_line;
CREATE POLICY einvoice_draft_line_update ON crove_finance.einvoice_draft_line AS RESTRICTIVE FOR UPDATE TO crove_tenant
  USING ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = einvoice_draft_line.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member')))
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = einvoice_draft_line.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member')));
DROP POLICY IF EXISTS einvoice_draft_line_delete ON crove_finance.einvoice_draft_line;
CREATE POLICY einvoice_draft_line_delete ON crove_finance.einvoice_draft_line AS RESTRICTIVE FOR DELETE TO crove_tenant
  USING ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = einvoice_draft_line.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member')));

-- A line is written only while its draft is a draft, whoever writes it, the system context included (the issue job changes the draft's state, never its lines); a
-- line of a draft that has left `draft` is deleted only by the org's purge. Runs as the writer, which reads the draft through its own policies.
CREATE OR REPLACE FUNCTION crove_finance.einvoice_draft_line_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_state text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- The org's purge, and only it (the checks of crove_kernel.purge_append_only_guard): the role that owns org_purge, the transaction-local mark it sets
    -- around these deletes, the worker login in the org's system context, the org offboarding. Nested, so every other caller meets only the catalog checks.
    IF (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = CURRENT_USER) = (SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.oid = 'crove_kernel.org_purge(integer)'::pg_catalog.regprocedure)
       AND pg_catalog.current_setting('crove.org_purge', true) = OLD.org_id::text THEN
      IF pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER')
         AND crove_kernel.ctx_actor_type() = 'system'
         AND crove_kernel.ctx_org_id() = OLD.org_id
         AND EXISTS (SELECT 1 FROM crove_kernel.tenant t WHERE t.org_id = OLD.org_id AND t.status = 'offboarding') THEN
        RETURN OLD;
      END IF;
    END IF;
  END IF;
  -- The draft a line is in now (OLD on an update or a delete) and the one it is going to (NEW on an insert or an update): a line of a draft that has left
  -- `draft` can neither be changed nor be moved to another draft, and no line can be added to one that has.
  FOR v_state IN
    SELECT d.state FROM crove_finance.einvoice_draft d
    WHERE d.org_id = CASE WHEN TG_OP = 'INSERT' THEN NEW.org_id ELSE OLD.org_id END
      AND d.id IN (CASE WHEN TG_OP = 'INSERT' THEN NEW.draft_id ELSE OLD.draft_id END, CASE WHEN TG_OP = 'DELETE' THEN OLD.draft_id ELSE NEW.draft_id END)
  LOOP
    -- A line whose draft is gone (the cascade of a draft's own delete) or not visible is not for this guard to judge.
    IF v_state <> 'draft' THEN
      RAISE EXCEPTION 'EINVOICE_NOT_DRAFT' USING ERRCODE = '42501';
    END IF;
  END LOOP;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
REVOKE ALL ON FUNCTION crove_finance.einvoice_draft_line_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
DROP TRIGGER IF EXISTS einvoice_draft_line_guard ON crove_finance.einvoice_draft_line;
CREATE TRIGGER einvoice_draft_line_guard BEFORE INSERT OR UPDATE OR DELETE ON crove_finance.einvoice_draft_line
  FOR EACH ROW EXECUTE FUNCTION crove_finance.einvoice_draft_line_guard();
