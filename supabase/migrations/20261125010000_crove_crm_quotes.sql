-- SPDX-License-Identifier: AGPL-3.0-only
-- Ludy CRM, slice 2, step Q1 (issue #2693, plan docs/plan/crm-quotes.md sections 4.1, 4.2 and 4.6): the quotes of a deal, their lines and the org's quote
-- setting. Idempotent; applied files stay untouched.
--
-- crove_crm.quote          one row per version of a quote of a deal (a revision is a new row with the same number). In this step every quote is a
--                          draft: the columns a later step fills when a quote is sent (the number, the status, who and when) exist but no login role may
--                          write them (UPDATE is a column grant of the draft's own columns, and a policy holds every INSERT to a fresh draft), so nothing in this
--                          step can move a quote out of draft. Step Q2 widens the grant with the send command and adds the guard that freezes a quote once it has
--                          left draft.
-- crove_crm.quote_line     a priced line of a quote: free text or an item, quantity, unit price, discount percent and VAT rate, with its amount and VAT amount
--                          (computed by the command with @crove/l10n-vn totalLines, whole dong, half up). A quote has at most 100 lines.
-- crove_crm.quote_setting  the org's one row of quote settings: how many days a quote stays valid, the VAT rate of a new line and the terms a new draft starts
--                          with. Every member reads it; only an owner or admin (or the system) writes it.
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- The org's setting
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_crm.quote_setting (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  valid_days smallint NOT NULL DEFAULT 14 CHECK (valid_days BETWEEN 7 AND 60),
  -- The VAT rate of a new line, written as an invoice writes it (QUOTE_VAT_RATES in @crove/kernel-contract, compared with this check by check-unions.db.test.ts).
  default_vat text NOT NULL DEFAULT '10%' CHECK (default_vat IN ('0%', '5%', '8%', '10%', 'KCT', 'KKKNT')),
  default_terms text NOT NULL DEFAULT '' CHECK (pg_catalog.length(default_terms) <= 2000),
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

-- ---------------------------------------------------------------------------
-- The quote
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_crm.quote (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  deal_id uuid NOT NULL,
  -- The customer, copied from the deal when the quote is made.
  party_id uuid NOT NULL,
  -- BG-2026-0007, taken when the quote is first sent (step Q2); a draft of a new quote has none, and a revision keeps the number of the quote it revises.
  number text CHECK (number IS NULL OR number ~ '^BG-[0-9]{4}-[0-9]{4,}$'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  revision_of uuid,
  -- The sets are the product's (QUOTE_STATUSES in packages/db/src/schema.ts, compared with this check by check-unions.db.test.ts). Expired is not a status: a
  -- sent quote whose valid_until has passed is shown as expired.
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'accepted', 'declined', 'superseded')),
  valid_until date NOT NULL,
  -- The customer's details as they were when the quote was sent (step Q2); empty on a draft.
  buyer_name text CHECK (buyer_name IS NULL OR pg_catalog.length(buyer_name) BETWEEN 1 AND 400),
  buyer_tax_code text CHECK (buyer_tax_code IS NULL OR pg_catalog.length(buyer_tax_code) BETWEEN 1 AND 20),
  buyer_address text CHECK (buyer_address IS NULL OR pg_catalog.length(buyer_address) BETWEEN 1 AND 500),
  buyer_email text CHECK (buyer_email IS NULL OR pg_catalog.length(buyer_email) BETWEEN 3 AND 254),
  -- The notes the quote prints for the customer (the API and the screens call them notes; the column is not named notes because that name is classified by the
  -- kernel's own tables and the audit-facts scan reads a column by its name).
  remarks text NOT NULL DEFAULT '' CHECK (pg_catalog.length(remarks) <= 2000),
  terms text NOT NULL DEFAULT '' CHECK (pg_catalog.length(terms) <= 2000),
  subtotal numeric(20, 4) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  vat_amount numeric(20, 4) NOT NULL DEFAULT 0 CHECK (vat_amount >= 0),
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
  -- A draft has not been sent: no send time, no decision. Every other status has been sent and carries its number.
  CONSTRAINT quote_sent_state_check CHECK (
    (status = 'draft' AND sent_at IS NULL AND decided_at IS NULL)
    OR (status <> 'draft' AND sent_at IS NOT NULL AND number IS NOT NULL)
  ),
  -- A deal's quotes go with the deal only by a person's choice: the deal is refused while it has a quote (crm.deal.delete says so first).
  CONSTRAINT quote_deal_fk FOREIGN KEY (org_id, deal_id) REFERENCES crove_crm.deal (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT quote_party_fk FOREIGN KEY (org_id, party_id) REFERENCES crove_kernel.party (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT quote_revision_of_fk FOREIGN KEY (org_id, revision_of) REFERENCES crove_crm.quote (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT quote_revision_not_self CHECK (revision_of IS DISTINCT FROM id)
);
-- A number and a revision name one quote.
CREATE UNIQUE INDEX IF NOT EXISTS quote_number_revision_uq ON crove_crm.quote (org_id, number, revision) WHERE number IS NOT NULL;
-- The deal's panel reads its quotes, a contact's panel reads theirs, the list reads by status and validity.
CREATE INDEX IF NOT EXISTS quote_deal_idx ON crove_crm.quote (org_id, deal_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS quote_party_idx ON crove_crm.quote (org_id, party_id);
CREATE INDEX IF NOT EXISTS quote_status_idx ON crove_crm.quote (org_id, status, valid_until);
CREATE INDEX IF NOT EXISTS quote_revision_of_idx ON crove_crm.quote (org_id, revision_of) WHERE revision_of IS NOT NULL;
CREATE INDEX IF NOT EXISTS quote_created_idx ON crove_crm.quote (org_id, created_at DESC, id DESC);
SELECT crove_kernel.apply_tenant_rls('crove_crm.quote');
-- The deal, the customer, the revision link and who made a quote never change, and a login role updates the draft's own columns only: the number, the status,
-- the buyer's snapshot and who sent it and when are for step Q2's commands, whose migration widens this grant. Nothing inserts a quote that is not a fresh draft:
-- the policy below holds every insert to the draft's own shape (the matrix probes table-level grants, so the insert is held by a policy and not by a column
-- grant). Until Q2 a quote is a draft, and nothing in this step can move one out of it.
REVOKE UPDATE ON crove_crm.quote FROM crove_tenant;
GRANT UPDATE (valid_until, remarks, terms, subtotal, vat_amount, total, version, updated_by, updated_at) ON crove_crm.quote TO crove_tenant;
DROP POLICY IF EXISTS quote_insert_draft ON crove_crm.quote;
CREATE POLICY quote_insert_draft ON crove_crm.quote AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK (status = 'draft' AND number IS NULL AND sent_at IS NULL AND sent_via IS NULL AND first_viewed_at IS NULL AND decided_at IS NULL AND decline_reason IS NULL
    AND buyer_name IS NULL AND buyer_tax_code IS NULL AND buyer_address IS NULL AND buyer_email IS NULL);

-- ---------------------------------------------------------------------------
-- The lines
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_crm.quote_line (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  quote_id uuid NOT NULL,
  line_no integer NOT NULL CHECK (line_no BETWEEN 1 AND 100),
  -- An item line is priced; a text line is a note row with no amounts.
  kind text NOT NULL DEFAULT 'item' CHECK (kind IN ('item', 'text')),
  description text NOT NULL DEFAULT '' CHECK (pg_catalog.length(description) <= 500),
  unit text CHECK (unit IS NULL OR pg_catalog.length(unit) BETWEEN 1 AND 50),
  -- The same precisions as a sales e-invoice draft's line (quantity numeric(20,6), unit price numeric(24,8)), so a line copies to one with no rounding.
  quantity numeric(20, 6) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  unit_price numeric(24, 8) NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  discount_percent numeric(5, 2) NOT NULL DEFAULT 0 CHECK (discount_percent BETWEEN 0 AND 100),
  -- The rate as an invoice writes it; the set is the product's (QUOTE_VAT_RATES).
  vat_rate text NOT NULL DEFAULT '10%' CHECK (vat_rate IN ('0%', '5%', '8%', '10%', 'KCT', 'KKKNT')),
  amount numeric(20, 4) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  vat_amount numeric(20, 4) NOT NULL DEFAULT 0 CHECK (vat_amount >= 0),
  -- A stock item of Kế toán when the line was picked from it. No foreign key: the item lives in another module's schema.
  stock_item_id uuid,
  PRIMARY KEY (org_id, id),
  CONSTRAINT quote_line_no_uq UNIQUE (org_id, quote_id, line_no),
  CONSTRAINT quote_line_text_check CHECK (kind = 'item' OR (quantity = 0 AND unit_price = 0 AND amount = 0 AND vat_amount = 0 AND stock_item_id IS NULL)),
  CONSTRAINT quote_line_quote_fk FOREIGN KEY (org_id, quote_id) REFERENCES crove_crm.quote (org_id, id) ON DELETE CASCADE
);
-- The foreign key to the quote (G3 fk-index).
CREATE INDEX IF NOT EXISTS quote_line_quote_idx ON crove_crm.quote_line (org_id, quote_id);
SELECT crove_kernel.apply_tenant_rls('crove_crm.quote_line');
REVOKE UPDATE ON crove_crm.quote_line FROM crove_tenant;
GRANT UPDATE (line_no, kind, description, unit, quantity, unit_price, discount_percent, vat_rate, amount, vat_amount, stock_item_id) ON crove_crm.quote_line TO crove_tenant;
