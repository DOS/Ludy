-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove CRM (issue #2696, ADR-0050, plan docs/plan/crm-quotes.md sections 4.7 and 6, step Q4): the sales order of an accepted quote. Idempotent; applied files stay untouched.
--
-- crove_crm.sales_order       one per accepted quote (UNIQUE (org_id, quote_id)): a frozen copy of the quote's buyer snapshot and totals, in the quote's issuing entity (named
--                             issuer_entity_id, not legal_entity_id, so it stays out of the legal-entity scope machinery as the quote's own column does). Its number comes from
--                             the kernel's gapless yearly series (doc type crm.sales_order), taken by the accept command in the same transaction. Owners, admins and members insert
--                             it through that command and may only cancel it afterwards (a column grant and a guard); nobody deletes it.
-- crove_crm.sales_order_line  the lines of the order, a frozen copy of the quote's lines: inserted with the order, never updated or deleted by a tenant role.
-- crove_crm.quote             gains the decision step: sent to accepted or declined (the grant of decided_at and decline_reason, and one branch in the guard that Q2 built).
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. The order
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_crm.sales_order (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  quote_id uuid NOT NULL,
  deal_id uuid NOT NULL,
  party_id uuid NOT NULL,
  issuer_entity_id uuid NOT NULL,
  -- DH-2026-0003, from the kernel's series of the entity.
  number text NOT NULL CHECK (pg_catalog.length(number) BETWEEN 1 AND 30),
  -- The day the customer said yes, in Vietnam's calendar.
  order_date date NOT NULL,
  -- The set is the product's (SALES_ORDER_STATUSES in packages/db/src/schema.ts, compared with this constraint by check-unions.db.test.ts).
  status text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'cancelled')),
  buyer_name text NOT NULL CHECK (pg_catalog.length(buyer_name) BETWEEN 1 AND 400),
  buyer_tax_code text CHECK (buyer_tax_code IS NULL OR pg_catalog.length(buyer_tax_code) BETWEEN 1 AND 20),
  buyer_address text CHECK (buyer_address IS NULL OR pg_catalog.length(buyer_address) BETWEEN 1 AND 500),
  buyer_email text CHECK (buyer_email IS NULL OR pg_catalog.length(buyer_email) BETWEEN 3 AND 254),
  subtotal numeric(20, 4) NOT NULL DEFAULT 0,
  vat_amount numeric(20, 4) NOT NULL DEFAULT 0,
  total numeric(20, 4) NOT NULL DEFAULT 0,
  -- How the customer's yes arrived (QUOTE_ACCEPTED_VIA in packages/db/src/schema.ts): a record of it, not a proof.
  accepted_via text CHECK (accepted_via IS NULL OR accepted_via IN ('chat', 'email', 'phone', 'in_person', 'other')),
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz,
  cancel_reason text CHECK (cancel_reason IS NULL OR pg_catalog.length(cancel_reason) BETWEEN 1 AND 200),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT sales_order_total_check CHECK (total = subtotal + vat_amount),
  CONSTRAINT sales_order_cancel_check CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL) AND (cancel_reason IS NULL OR status = 'cancelled')),
  CONSTRAINT sales_order_quote_uq UNIQUE (org_id, quote_id),
  CONSTRAINT sales_order_number_uq UNIQUE (org_id, issuer_entity_id, number),
  CONSTRAINT sales_order_quote_fk FOREIGN KEY (org_id, quote_id) REFERENCES crove_crm.quote (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT sales_order_deal_fk FOREIGN KEY (org_id, deal_id) REFERENCES crove_crm.deal (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT sales_order_party_fk FOREIGN KEY (org_id, party_id) REFERENCES crove_kernel.party (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT sales_order_issuer_fk FOREIGN KEY (org_id, issuer_entity_id) REFERENCES crove_kernel.legal_entity (org_id, id) ON DELETE RESTRICT
);
-- sales_order_quote_uq backs the quote's foreign key; the rest are the lookups of the lists.
CREATE INDEX IF NOT EXISTS sales_order_deal_idx ON crove_crm.sales_order (org_id, deal_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS sales_order_party_idx ON crove_crm.sales_order (org_id, party_id);
CREATE INDEX IF NOT EXISTS sales_order_issuer_idx ON crove_crm.sales_order (org_id, issuer_entity_id);
CREATE INDEX IF NOT EXISTS sales_order_status_idx ON crove_crm.sales_order (org_id, status, created_at DESC, id DESC);
SELECT crove_kernel.apply_tenant_rls('crove_crm.sales_order');
-- A person never changes what the order froze: only the cancellation (and the bookkeeping that goes with a change) is theirs.
REVOKE UPDATE, DELETE ON crove_crm.sales_order FROM crove_tenant;
GRANT UPDATE (status, cancelled_at, cancel_reason, version, updated_by, updated_at) ON crove_crm.sales_order TO crove_tenant;
-- Owners, admins and members write orders; a viewer only reads. An order is inserted as confirmed and not cancelled. The policy holds that it is made by the person who
-- signs it, for a sent quote, with the quote's own deal, customer and issuing entity; the quote's guard holds the other side: a quote becomes accepted only when its order exists.
DROP POLICY IF EXISTS sales_order_insert ON crove_crm.sales_order;
CREATE POLICY sales_order_insert ON crove_crm.sales_order AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR (EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = sales_order.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member'))
      AND sales_order.created_by = (SELECT crove_kernel.ctx_user_id())
      AND sales_order.status = 'confirmed' AND sales_order.cancelled_at IS NULL AND sales_order.cancel_reason IS NULL
      AND EXISTS (SELECT 1 FROM crove_crm.quote q WHERE q.org_id = sales_order.org_id AND q.id = sales_order.quote_id AND q.status = 'sent'
        AND q.deal_id = sales_order.deal_id AND q.party_id = sales_order.party_id AND q.issuer_entity_id = sales_order.issuer_entity_id)));
DROP POLICY IF EXISTS sales_order_update ON crove_crm.sales_order;
CREATE POLICY sales_order_update ON crove_crm.sales_order AS RESTRICTIVE FOR UPDATE TO crove_tenant
  USING ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = sales_order.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member')))
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = sales_order.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member')));

-- What a person may do to an order: nothing but the cancellation of a confirmed one (status, time and reason, with the bookkeeping). The system context (the org purge) and a
-- statement with no context (a database owner's own, a test's setup) are not held.
CREATE OR REPLACE FUNCTION crove_crm.sales_order_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_actor text := crove_kernel.ctx_actor_type();
  v_keep text[] := ARRAY['version', 'updated_by', 'updated_at'];
BEGIN
  IF v_actor IS NULL OR v_actor = 'system' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ORDER_FROZEN' USING ERRCODE = '42501', DETAIL = 'an order is cancelled, never deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;
  IF (pg_catalog.to_jsonb(NEW) - v_keep) IS NOT DISTINCT FROM (pg_catalog.to_jsonb(OLD) - v_keep) THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'confirmed' AND NEW.status = 'cancelled' THEN
    IF (pg_catalog.to_jsonb(NEW) - v_keep - 'status' - 'cancelled_at' - 'cancel_reason') IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - v_keep - 'status' - 'cancelled_at' - 'cancel_reason')
       OR NEW.cancelled_at IS NULL OR NEW.cancel_reason IS NULL THEN
      RAISE EXCEPTION 'ORDER_FROZEN' USING ERRCODE = '42501', DETAIL = 'a cancellation changes the status, its time and its reason only';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ORDER_FROZEN' USING ERRCODE = '42501', DETAIL = 'an order does not change but to be cancelled once';
END $$;
REVOKE ALL ON FUNCTION crove_crm.sales_order_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS sales_order_guard ON crove_crm.sales_order;
CREATE TRIGGER sales_order_guard BEFORE INSERT OR UPDATE OR DELETE ON crove_crm.sales_order
  FOR EACH ROW EXECUTE FUNCTION crove_crm.sales_order_guard();
ALTER TABLE crove_crm.sales_order ENABLE ALWAYS TRIGGER sales_order_guard;

-- ---------------------------------------------------------------------------
-- 2. The lines
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_crm.sales_order_line (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  order_id uuid NOT NULL,
  line_no smallint NOT NULL CHECK (line_no BETWEEN 1 AND 100),
  kind text NOT NULL CHECK (kind IN ('item', 'text')),
  description text NOT NULL CHECK (pg_catalog.length(description) BETWEEN 1 AND 500),
  unit text CHECK (unit IS NULL OR pg_catalog.length(unit) BETWEEN 1 AND 30),
  -- The same domains as the quote's lines and the e-invoice draft's, so a line copies without rounding.
  quantity numeric(20, 6),
  unit_price numeric(24, 8),
  discount_percent numeric(5, 2) NOT NULL DEFAULT 0 CHECK (discount_percent BETWEEN 0 AND 100),
  vat_rate text CHECK (vat_rate IS NULL OR pg_catalog.length(vat_rate) BETWEEN 1 AND 20),
  amount numeric(20, 4) NOT NULL DEFAULT 0,
  vat_amount numeric(20, 4) NOT NULL DEFAULT 0,
  -- A stock item of Kế toán, by id only: no foreign key across modules (plan decision QT-6).
  stock_item_id uuid,
  PRIMARY KEY (org_id, id),
  CONSTRAINT sales_order_line_order_fk FOREIGN KEY (org_id, order_id) REFERENCES crove_crm.sales_order (org_id, id) ON DELETE CASCADE,
  CONSTRAINT sales_order_line_no_uq UNIQUE (org_id, order_id, line_no),
  CONSTRAINT sales_order_line_shape_check CHECK (
    (kind = 'item' AND quantity IS NOT NULL AND unit_price IS NOT NULL AND quantity > 0 AND unit_price > 0 AND vat_rate IS NOT NULL)
    OR (kind = 'text' AND quantity IS NULL AND unit_price IS NULL AND vat_rate IS NULL AND discount_percent = 0 AND amount = 0 AND vat_amount = 0 AND stock_item_id IS NULL))
);
-- The order's own foreign key is backed by the unique index (org_id, order_id, line_no).
SELECT crove_kernel.apply_tenant_rls('crove_crm.sales_order_line');
-- A line is the frozen copy made with its order: inserted only for an order made in the same transaction (its created_at is the transaction's now()), never changed or
-- removed by a tenant role (APPEND_ONLY in the RLS matrix), so no line can be added to an order later.
REVOKE UPDATE, DELETE ON crove_crm.sales_order_line FROM crove_tenant;
DROP POLICY IF EXISTS sales_order_line_insert ON crove_crm.sales_order_line;
CREATE POLICY sales_order_line_insert ON crove_crm.sales_order_line AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR (EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = sales_order_line.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member'))
      AND EXISTS (SELECT 1 FROM crove_crm.sales_order o WHERE o.org_id = sales_order_line.org_id AND o.id = sales_order_line.order_id AND o.status = 'confirmed'
        AND o.created_at = pg_catalog.now())));

-- ---------------------------------------------------------------------------
-- 3. The decision step of the quote
-- ---------------------------------------------------------------------------
-- The decision time and a decline's reason (decided_at and decline_reason were left ungranted by Q1 and Q2 for this step); the guard below holds what may change with them.
GRANT UPDATE (decided_at, decline_reason) ON crove_crm.quote TO crove_tenant;

-- The guard of Q2 (20261128120000) with one branch added: sent to accepted or declined. Every other rule is as it was.
CREATE OR REPLACE FUNCTION crove_crm.quote_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_actor text := crove_kernel.ctx_actor_type();
  v_source crove_crm.quote;
  v_old jsonb;
  v_new jsonb;
  -- The columns an edit, a send and a revision's own save are allowed to change as bookkeeping.
  v_keep text[] := ARRAY['version', 'updated_by', 'updated_at'];
BEGIN
  -- Only the system context and a statement with no context at all are not held: any other actor (a person, an agent) is.
  IF v_actor IS NULL OR v_actor = 'system' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'QUOTE_FROZEN' USING ERRCODE = '42501', DETAIL = 'only a draft quote is deleted';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    -- A row for another org is the tenant policy's to refuse (its own message), not this guard's.
    IF NEW.org_id IS DISTINCT FROM crove_kernel.ctx_org_id() THEN
      RETURN NEW;
    END IF;
    IF NEW.status <> 'draft' OR NEW.number IS NOT NULL OR NEW.sent_at IS NOT NULL OR NEW.sent_via IS NOT NULL OR NEW.first_viewed_at IS NOT NULL
       OR NEW.decided_at IS NOT NULL OR NEW.decline_reason IS NOT NULL OR NEW.issuer_entity_id IS NOT NULL OR NEW.buyer_name IS NOT NULL
       OR NEW.buyer_tax_code IS NOT NULL OR NEW.buyer_address IS NOT NULL OR NEW.buyer_email IS NOT NULL THEN
      RAISE EXCEPTION 'QUOTE_FORBIDDEN' USING ERRCODE = '42501', DETAIL = 'a quote is created as a fresh draft';
    END IF;
    IF NEW.revises_id IS NOT NULL THEN
      SELECT q.* INTO v_source FROM crove_crm.quote q WHERE q.org_id = NEW.org_id AND q.id = NEW.revises_id;
      IF v_source.id IS NULL OR v_source.deal_id IS DISTINCT FROM NEW.deal_id OR v_source.party_id IS DISTINCT FROM NEW.party_id
         OR v_source.status NOT IN ('sent', 'declined') OR NEW.revision IS DISTINCT FROM v_source.revision + 1 THEN
        RAISE EXCEPTION 'QUOTE_FORBIDDEN' USING ERRCODE = '42501', DETAIL = 'a revision names a sent or declined quote of the same deal and customer, and the next revision number';
      END IF;
    ELSIF NEW.revision <> 1 THEN
      RAISE EXCEPTION 'QUOTE_FORBIDDEN' USING ERRCODE = '42501', DETAIL = 'a quote that revises none is revision 1';
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE
  v_old := pg_catalog.to_jsonb(OLD) - v_keep;
  v_new := pg_catalog.to_jsonb(NEW) - v_keep;
  -- A statement that changes nothing changes nothing, whoever runs it and whatever the quote's state.
  IF v_old IS NOT DISTINCT FROM v_new THEN
    RETURN NEW;
  END IF;
  IF (NEW.org_id, NEW.id, NEW.deal_id, NEW.party_id, NEW.revises_id, NEW.revision, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.org_id, OLD.id, OLD.deal_id, OLD.party_id, OLD.revises_id, OLD.revision, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'QUOTE_IMMUTABLE' USING ERRCODE = '42501', DETAIL = 'a quote keeps its deal, its customer, the quote it revises and its revision';
  END IF;
  IF OLD.status = 'draft' THEN
    IF NEW.status = 'draft' THEN
      -- An edit changes the Q1 columns only.
      IF (NEW.number, NEW.sent_at, NEW.sent_via, NEW.first_viewed_at, NEW.decided_at, NEW.decline_reason, NEW.issuer_entity_id, NEW.buyer_name, NEW.buyer_tax_code, NEW.buyer_address, NEW.buyer_email)
         IS DISTINCT FROM (OLD.number, OLD.sent_at, OLD.sent_via, OLD.first_viewed_at, OLD.decided_at, OLD.decline_reason, OLD.issuer_entity_id, OLD.buyer_name, OLD.buyer_tax_code, OLD.buyer_address, OLD.buyer_email) THEN
        RAISE EXCEPTION 'QUOTE_FORBIDDEN' USING ERRCODE = '42501', DETAIL = 'a draft is sent by the send command, not edited into a sent one';
      END IF;
    ELSIF NEW.status = 'sent' THEN
      -- The send: what the customer will see is what was saved (the totals, the validity, the notes and the terms do not change in the same statement).
      IF (NEW.subtotal, NEW.vat_amount, NEW.total, NEW.valid_until, NEW.remarks, NEW.terms) IS DISTINCT FROM (OLD.subtotal, OLD.vat_amount, OLD.total, OLD.valid_until, OLD.remarks, OLD.terms) THEN
        RAISE EXCEPTION 'QUOTE_FORBIDDEN' USING ERRCODE = '42501', DETAIL = 'a quote is sent as it was saved';
      END IF;
      IF NEW.number IS NULL OR NEW.number !~ '^BG-[0-9]{4}-[0-9]{4,}$' OR NEW.sent_at IS NULL OR NEW.sent_via IS NULL OR NEW.issuer_entity_id IS NULL OR NEW.buyer_name IS NULL
         OR NEW.first_viewed_at IS NOT NULL OR NEW.decided_at IS NOT NULL OR NEW.decline_reason IS NOT NULL THEN
        RAISE EXCEPTION 'QUOTE_FORBIDDEN' USING ERRCODE = '42501', DETAIL = 'a sent quote has its number, time, way, issuing entity and buyer, and none of the decision facts';
      END IF;
      IF NEW.total <= 0 OR NEW.valid_until < (pg_catalog.now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - 1
         OR NEW.sent_at < pg_catalog.now() - pg_catalog.make_interval(days => 1) OR NEW.sent_at > pg_catalog.now() + pg_catalog.make_interval(days => 1) THEN
        RAISE EXCEPTION 'QUOTE_FORBIDDEN' USING ERRCODE = '42501', DETAIL = 'a sent quote has a total above zero, a validity that has not passed and a send time of now';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM crove_crm.quote_line l WHERE l.org_id = NEW.org_id AND l.quote_id = NEW.id AND l.kind = 'item') THEN
        RAISE EXCEPTION 'QUOTE_FORBIDDEN' USING ERRCODE = '42501', DETAIL = 'a sent quote has a priced line';
      END IF;
      -- A revision keeps the number of the quote it revises.
      IF NEW.revises_id IS NOT NULL THEN
        SELECT q.* INTO v_source FROM crove_crm.quote q WHERE q.org_id = NEW.org_id AND q.id = NEW.revises_id;
        IF v_source.id IS NULL OR v_source.number IS DISTINCT FROM NEW.number OR v_source.status NOT IN ('sent', 'declined') THEN
          RAISE EXCEPTION 'QUOTE_FORBIDDEN' USING ERRCODE = '42501', DETAIL = 'a revision is sent under the number of the quote it revises';
        END IF;
      END IF;
    ELSE
      RAISE EXCEPTION 'QUOTE_FORBIDDEN' USING ERRCODE = '42501', DETAIL = 'a draft is sent and nothing else';
    END IF;
  ELSIF OLD.status = 'sent' AND NEW.status IN ('accepted', 'declined') THEN
    -- A person records the customer's decision (Q4, ADR-0050): only the status, the decision time and, for a decline, its reason change; the quote was not expired; an
    -- acceptance has its sales order, made earlier in the same transaction.
    IF (pg_catalog.to_jsonb(NEW) - v_keep - 'status' - 'decided_at' - 'decline_reason') IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - v_keep - 'status' - 'decided_at' - 'decline_reason') THEN
      RAISE EXCEPTION 'QUOTE_FORBIDDEN' USING ERRCODE = '42501', DETAIL = 'a decision changes the status, its time and its reason only';
    END IF;
    IF NEW.decided_at IS NULL OR (NEW.status = 'accepted' AND NEW.decline_reason IS NOT NULL) OR NEW.decided_at < pg_catalog.now() - pg_catalog.make_interval(days => 1)
       OR NEW.decided_at > pg_catalog.now() + pg_catalog.make_interval(days => 1) THEN
      RAISE EXCEPTION 'QUOTE_FORBIDDEN' USING ERRCODE = '42501', DETAIL = 'a decision has the time of now, and an acceptance has no decline reason';
    END IF;
    IF OLD.valid_until < (pg_catalog.now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date THEN
      RAISE EXCEPTION 'QUOTE_FORBIDDEN' USING ERRCODE = '42501', DETAIL = 'a quote past its validity is revised, not decided';
    END IF;
    IF NEW.status = 'accepted' AND NOT EXISTS (SELECT 1 FROM crove_crm.sales_order o WHERE o.org_id = NEW.org_id AND o.quote_id = NEW.id) THEN
      RAISE EXCEPTION 'QUOTE_FORBIDDEN' USING ERRCODE = '42501', DETAIL = 'an accepted quote has its sales order';
    END IF;
  ELSIF OLD.status IN ('sent', 'declined') AND NEW.status = 'superseded' THEN
    -- Replaced by the revision that was sent in this transaction (a declined quote is revised too): nothing but the status changes.
    IF (pg_catalog.to_jsonb(NEW) - v_keep - 'status') IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - v_keep - 'status')
       OR NOT EXISTS (SELECT 1 FROM crove_crm.quote r WHERE r.org_id = OLD.org_id AND r.revises_id = OLD.id AND r.status = 'sent') THEN
      RAISE EXCEPTION 'QUOTE_FROZEN' USING ERRCODE = '42501', DETAIL = 'a sent or declined quote is only replaced by its sent revision';
    END IF;
  ELSE
    RAISE EXCEPTION 'QUOTE_FROZEN' USING ERRCODE = '42501', DETAIL = 'a quote that has left draft does not change';
  END IF;
  RETURN NEW;
END $$;
