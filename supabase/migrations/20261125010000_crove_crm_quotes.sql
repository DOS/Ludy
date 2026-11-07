-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove CRM (issue #2693, plan docs/plan/crm-quotes.md section 4 and 8, step Q1): a quote of a deal, its lines and the org's quote settings.
-- Idempotent; applied files stay untouched.
--
-- crove_crm.quote          one row per version of a quote of a deal (a revision is a new row). A person edits a quote only while it is a draft: the
--                          writers (owners, admins, members) insert a fresh draft and update the editable columns, nothing else. The status, the
--                          number and the sent and decided columns are the send and accept steps' (Q2 and Q4); no column grant or insert policy lets a
--                          tenant role set them, and a row that has left `draft` is read-only to a tenant role. The totals are computed by the
--                          command from the lines (total = subtotal + VAT).
-- crove_crm.quote_line     the lines of a quote (an item with a quantity, a price, a discount and a VAT rate, or a text line), written only while the
--                          quote is a draft.
-- crove_crm.quote_setting  the org's one row of quote settings (valid days, default VAT rate, default terms). With no row every default applies.
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. Quotes
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_crm.quote (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  deal_id uuid NOT NULL,
  -- The customer, copied from the deal when the quote is made.
  party_id uuid NOT NULL,
  -- BG-2026-0007, taken when the quote is first sent (Q2); a draft has none. A revision keeps its number.
  number text CHECK (number IS NULL OR pg_catalog.length(number) BETWEEN 1 AND 30),
  revision smallint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  -- The quote this one revises: its number and revision count carry from it when it is sent. At most one revision per quote at a time.
  revises_id uuid,
  -- The sets are the product's (QUOTE_STATUSES and QUOTE_SENT_VIA in packages/db/src/schema.ts, compared with these constraints by check-unions.db.test.ts).
  -- Expired is not stored: a sent quote whose valid_until is past is shown as expired.
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'accepted', 'declined', 'superseded')),
  valid_until date NOT NULL,
  remarks text CHECK (remarks IS NULL OR pg_catalog.length(remarks) <= 2000),
  terms text CHECK (terms IS NULL OR pg_catalog.length(terms) <= 2000),
  subtotal numeric(20, 4) NOT NULL DEFAULT 0,
  vat_amount numeric(20, 4) NOT NULL DEFAULT 0,
  total numeric(20, 4) NOT NULL DEFAULT 0,
  sent_at timestamptz,
  sent_via text CHECK (sent_via IS NULL OR sent_via IN ('link', 'email')),
  first_viewed_at timestamptz,
  decided_at timestamptz,
  decline_reason text CHECK (decline_reason IS NULL OR pg_catalog.length(decline_reason) <= 200),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT quote_total_check CHECK (total = subtotal + vat_amount),
  CONSTRAINT quote_number_uq UNIQUE (org_id, number, revision),
  CONSTRAINT quote_deal_fk FOREIGN KEY (org_id, deal_id) REFERENCES crove_crm.deal (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT quote_party_fk FOREIGN KEY (org_id, party_id) REFERENCES crove_kernel.party (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT quote_revises_fk FOREIGN KEY (org_id, revises_id) REFERENCES crove_crm.quote (org_id, id) ON DELETE SET NULL (revises_id)
);
CREATE INDEX IF NOT EXISTS quote_deal_idx ON crove_crm.quote (org_id, deal_id, number, revision);
CREATE INDEX IF NOT EXISTS quote_party_idx ON crove_crm.quote (org_id, party_id);
CREATE INDEX IF NOT EXISTS quote_status_idx ON crove_crm.quote (org_id, status, valid_until);
CREATE UNIQUE INDEX IF NOT EXISTS quote_revises_uq ON crove_crm.quote (org_id, revises_id) WHERE revises_id IS NOT NULL;
SELECT crove_kernel.apply_tenant_rls('crove_crm.quote');
-- A person never changes who made the quote, its status, number or sent and decided facts, nor the deal and customer it was made for.
REVOKE UPDATE ON crove_crm.quote FROM crove_tenant;
GRANT UPDATE (valid_until, remarks, terms, subtotal, vat_amount, total, version, updated_by, updated_at) ON crove_crm.quote TO crove_tenant;
-- Owners, admins and members write quotes; a viewer only reads. A new quote is a fresh draft (nothing is sent or decided on creation) and only a draft is
-- changed or deleted by a tenant role (the system context is exempt for the org purge and later steps).
DROP POLICY IF EXISTS quote_insert ON crove_crm.quote;
CREATE POLICY quote_insert ON crove_crm.quote AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR (EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = quote.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member'))
      AND quote.status = 'draft' AND quote.number IS NULL AND quote.sent_at IS NULL AND quote.sent_via IS NULL AND quote.first_viewed_at IS NULL
      AND quote.decided_at IS NULL AND quote.decline_reason IS NULL));
DROP POLICY IF EXISTS quote_update ON crove_crm.quote;
CREATE POLICY quote_update ON crove_crm.quote AS RESTRICTIVE FOR UPDATE TO crove_tenant
  USING ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR (quote.status = 'draft' AND EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = quote.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member'))))
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR (quote.status = 'draft' AND EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = quote.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member'))));
DROP POLICY IF EXISTS quote_delete ON crove_crm.quote;
CREATE POLICY quote_delete ON crove_crm.quote AS RESTRICTIVE FOR DELETE TO crove_tenant
  USING ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR (quote.status = 'draft' AND EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = quote.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member'))));

-- ---------------------------------------------------------------------------
-- 2. Lines
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_crm.quote_line (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  quote_id uuid NOT NULL,
  line_no smallint NOT NULL CHECK (line_no BETWEEN 1 AND 100),
  -- A text line is a note row with no amounts.
  kind text NOT NULL CHECK (kind IN ('item', 'text')),
  description text NOT NULL CHECK (pg_catalog.length(description) BETWEEN 1 AND 500),
  unit text CHECK (unit IS NULL OR pg_catalog.length(unit) BETWEEN 1 AND 30),
  -- The same domains as crove_finance.quantity and crove_finance.unit_amount (a test pins them equal), so a line copies to an e-invoice draft line
  -- without rounding.
  quantity numeric(20, 6),
  unit_price numeric(24, 8),
  discount_percent numeric(5, 2) NOT NULL DEFAULT 0 CHECK (discount_percent BETWEEN 0 AND 100),
  -- As an invoice writes it ('10%', 'KCT'); the allowed set is @crove/l10n-vn's, checked by the command.
  vat_rate text CHECK (vat_rate IS NULL OR pg_catalog.length(vat_rate) BETWEEN 1 AND 20),
  amount numeric(20, 4) NOT NULL DEFAULT 0,
  vat_amount numeric(20, 4) NOT NULL DEFAULT 0,
  -- A stock item of Kế toán, named by id only: it lives in another module, so there is no foreign key (plan decision QT-6).
  stock_item_id uuid,
  PRIMARY KEY (org_id, id),
  CONSTRAINT quote_line_quote_fk FOREIGN KEY (org_id, quote_id) REFERENCES crove_crm.quote (org_id, id) ON DELETE CASCADE,
  CONSTRAINT quote_line_no_uq UNIQUE (org_id, quote_id, line_no),
  CONSTRAINT quote_line_shape_check CHECK (
    (kind = 'item' AND quantity > 0 AND unit_price > 0 AND vat_rate IS NOT NULL)
    OR (kind = 'text' AND quantity IS NULL AND unit_price IS NULL AND vat_rate IS NULL AND discount_percent = 0 AND amount = 0 AND vat_amount = 0 AND stock_item_id IS NULL))
);
SELECT crove_kernel.apply_tenant_rls('crove_crm.quote_line');
-- A line is written only while its quote is a draft, by the roles that write quotes.
DROP POLICY IF EXISTS quote_line_insert ON crove_crm.quote_line;
CREATE POLICY quote_line_insert ON crove_crm.quote_line AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR (EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = quote_line.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member'))
      AND EXISTS (SELECT 1 FROM crove_crm.quote q WHERE q.org_id = quote_line.org_id AND q.id = quote_line.quote_id AND q.status = 'draft')));
DROP POLICY IF EXISTS quote_line_update ON crove_crm.quote_line;
CREATE POLICY quote_line_update ON crove_crm.quote_line AS RESTRICTIVE FOR UPDATE TO crove_tenant
  USING ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR (EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = quote_line.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member'))
      AND EXISTS (SELECT 1 FROM crove_crm.quote q WHERE q.org_id = quote_line.org_id AND q.id = quote_line.quote_id AND q.status = 'draft')))
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR (EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = quote_line.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member'))
      AND EXISTS (SELECT 1 FROM crove_crm.quote q WHERE q.org_id = quote_line.org_id AND q.id = quote_line.quote_id AND q.status = 'draft')));
DROP POLICY IF EXISTS quote_line_delete ON crove_crm.quote_line;
CREATE POLICY quote_line_delete ON crove_crm.quote_line AS RESTRICTIVE FOR DELETE TO crove_tenant
  USING ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR (EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = quote_line.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member'))
      AND EXISTS (SELECT 1 FROM crove_crm.quote q WHERE q.org_id = quote_line.org_id AND q.id = quote_line.quote_id AND q.status = 'draft')));
-- The quote's own foreign key already backs its lines' lookups: (org_id, quote_id, line_no) is the unique index above.

-- ---------------------------------------------------------------------------
-- 3. The org's setting
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_crm.quote_setting (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  -- How long a new quote stays valid, in days; with no row the product's 14 applies.
  valid_days smallint NOT NULL DEFAULT 14 CHECK (valid_days BETWEEN 7 AND 60),
  -- The VAT rate a new line starts with when no earlier quote to the customer names one.
  default_vat text NOT NULL DEFAULT '10%' CHECK (pg_catalog.length(default_vat) BETWEEN 1 AND 20),
  default_terms text CHECK (default_terms IS NULL OR pg_catalog.length(default_terms) <= 2000),
  set_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT quote_setting_org_uq UNIQUE (org_id),
  CONSTRAINT quote_setting_member_fk FOREIGN KEY (org_id, set_by) REFERENCES crove_kernel.tenant_member (org_id, user_id) ON DELETE SET NULL (set_by)
);
CREATE INDEX IF NOT EXISTS quote_setting_set_by_idx ON crove_crm.quote_setting (org_id, set_by) WHERE set_by IS NOT NULL;
SELECT crove_kernel.apply_tenant_rls('crove_crm.quote_setting');
REVOKE UPDATE ON crove_crm.quote_setting FROM crove_tenant;
GRANT UPDATE (valid_days, default_vat, default_terms, set_by, updated_at) ON crove_crm.quote_setting TO crove_tenant;
DROP POLICY IF EXISTS quote_setting_insert ON crove_crm.quote_setting;
CREATE POLICY quote_setting_insert ON crove_crm.quote_setting AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = quote_setting.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin')));
DROP POLICY IF EXISTS quote_setting_update ON crove_crm.quote_setting;
CREATE POLICY quote_setting_update ON crove_crm.quote_setting AS RESTRICTIVE FOR UPDATE TO crove_tenant
  USING ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = quote_setting.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin')))
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = quote_setting.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin')));
DROP POLICY IF EXISTS quote_setting_delete ON crove_crm.quote_setting;
CREATE POLICY quote_setting_delete ON crove_crm.quote_setting AS RESTRICTIVE FOR DELETE TO crove_tenant
  USING ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = quote_setting.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin')));
