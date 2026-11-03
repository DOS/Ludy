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
  buyer_tax_code text CHECK (buyer_tax_code IS NULL OR buyer_tax_code ~ '^([0-9]{10}(-[0-9]{3})?|[0-9]{12})$'),
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

-- A non-system writer edits a draft and nothing else: it cannot change the state, the key or the provider's reference, and it
-- cannot touch or delete a draft that has left `draft` (the issue job, a system context, moves it on). Runs as the writer.
CREATE OR REPLACE FUNCTION crove_finance.einvoice_draft_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (SELECT crove_kernel.ctx_actor_type()) = 'system' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'draft' OR NEW.provider_ref IS NOT NULL THEN
      RAISE EXCEPTION 'EINVOICE_NOT_DRAFT' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.state <> 'draft' THEN
    RAISE EXCEPTION 'EINVOICE_NOT_DRAFT' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.state IS DISTINCT FROM OLD.state OR NEW.provider_ref IS DISTINCT FROM OLD.provider_ref OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key THEN
      RAISE EXCEPTION 'EINVOICE_FIELD_LOCKED' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION crove_finance.einvoice_draft_guard() FROM PUBLIC, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_finance.einvoice_draft_guard() TO crove_tenant;
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
  description text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 500),
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

-- A line is written only while its draft is a draft (the issue job, a system context, is not held to it). Runs as the writer, which
-- reads the draft through its own policies.
CREATE OR REPLACE FUNCTION crove_finance.einvoice_draft_line_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_state text;
BEGIN
  IF (SELECT crove_kernel.ctx_actor_type()) = 'system' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  SELECT d.state INTO v_state FROM crove_finance.einvoice_draft d
  WHERE d.org_id = CASE WHEN TG_OP = 'DELETE' THEN OLD.org_id ELSE NEW.org_id END
    AND d.id = CASE WHEN TG_OP = 'DELETE' THEN OLD.draft_id ELSE NEW.draft_id END;
  -- A line whose draft is gone (the cascade of a draft's own delete) or not visible is not for this guard to judge.
  IF v_state IS NOT NULL AND v_state <> 'draft' THEN
    RAISE EXCEPTION 'EINVOICE_NOT_DRAFT' USING ERRCODE = '42501';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
REVOKE ALL ON FUNCTION crove_finance.einvoice_draft_line_guard() FROM PUBLIC, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_finance.einvoice_draft_line_guard() TO crove_tenant;
DROP TRIGGER IF EXISTS einvoice_draft_line_guard ON crove_finance.einvoice_draft_line;
CREATE TRIGGER einvoice_draft_line_guard BEFORE INSERT OR UPDATE OR DELETE ON crove_finance.einvoice_draft_line
  FOR EACH ROW EXECUTE FUNCTION crove_finance.einvoice_draft_line_guard();
