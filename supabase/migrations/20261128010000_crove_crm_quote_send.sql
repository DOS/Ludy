-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove CRM (issue #2694, plan docs/plan/crm-quotes.md sections 4.1, 4.5, 4.6 and step Q2): sending a quote. Idempotent; applied files stay untouched.
--
-- crove_crm.quote       gains the issuing legal entity (issuer_entity_id: the document's letterhead, not a row scope, so it is not named legal_entity_id and
--                       a quote stays visible to every member, plan CRM-6) and the buyer snapshot taken when the quote is sent (name, tax code, address, email).
--                       The tenant roles may now set the status, the number and those columns, but only through the transitions the guard below allows:
--                       draft to sent (a person sends), sent to superseded (the revision of a sent quote was sent). A quote that has left `draft` is frozen.
-- crove_crm.quote_line  a write to a line takes a share lock on its quote and refuses unless the quote is a draft, so a line write racing a send waits for it and
--                       then fails (the plain EXISTS of the line policies takes no lock).
-- crove_crm.quote_link  a public link to a sent quote: the SHA-256 of its token (the secret is only in the URL the person copies), its expiry (the quote's validity
--                       plus 30 days at most), its revocation, and how often it was opened. Owners, admins and members make and revoke links through commands.
-- crove_crm.quote_link_view(token)  for a live link (well-formed token, not revoked, not expired, active org, quote sent or decided): the document as JSON and
--                       the view counted; NULL otherwise, the same answer for every kind of bad token. Only crove_app (the API login, which serves the public page)
--                       may execute it.
-- crove_crm.quote_setting  gains the letterhead the document needs: phone, email and a free-text bank note (printed as written, never parsed).
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. The quote: issuer, buyer snapshot, the transitions
-- ---------------------------------------------------------------------------
ALTER TABLE crove_crm.quote ADD COLUMN IF NOT EXISTS issuer_entity_id uuid;
ALTER TABLE crove_crm.quote ADD COLUMN IF NOT EXISTS buyer_name text CHECK (buyer_name IS NULL OR pg_catalog.length(buyer_name) BETWEEN 1 AND 400);
ALTER TABLE crove_crm.quote ADD COLUMN IF NOT EXISTS buyer_tax_code text CHECK (buyer_tax_code IS NULL OR pg_catalog.length(buyer_tax_code) BETWEEN 1 AND 20);
ALTER TABLE crove_crm.quote ADD COLUMN IF NOT EXISTS buyer_address text CHECK (buyer_address IS NULL OR pg_catalog.length(buyer_address) BETWEEN 1 AND 500);
ALTER TABLE crove_crm.quote ADD COLUMN IF NOT EXISTS buyer_email text CHECK (buyer_email IS NULL OR pg_catalog.length(buyer_email) BETWEEN 3 AND 254);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'quote_issuer_fk' AND conrelid = 'crove_crm.quote'::pg_catalog.regclass) THEN
    ALTER TABLE crove_crm.quote ADD CONSTRAINT quote_issuer_fk FOREIGN KEY (org_id, issuer_entity_id) REFERENCES crove_kernel.legal_entity (org_id, id) ON DELETE RESTRICT;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS quote_issuer_idx ON crove_crm.quote (org_id, issuer_entity_id) WHERE issuer_entity_id IS NOT NULL;
-- What the send step writes, besides the Q1 columns. first_viewed_at, decided_at and decline_reason stay out of reach (the public view and Q4 write them).
GRANT UPDATE (status, number, sent_at, sent_via, issuer_entity_id, buyer_name, buyer_tax_code, buyer_address, buyer_email) ON crove_crm.quote TO crove_tenant;

-- Every transition runs through the guard, so the policies only say who may try: a writer of the org, on a row of any status (a SELECT ... FOR UPDATE applies the
-- UPDATE policy too, so a quote that left `draft` must stay visible to it to be refused by its status and not reported as missing).
DROP POLICY IF EXISTS quote_update ON crove_crm.quote;
CREATE POLICY quote_update ON crove_crm.quote AS RESTRICTIVE FOR UPDATE TO crove_tenant
  USING ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = quote.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member')))
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = quote.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member')));

-- What each actor may do to a quote. A person inserts a fresh draft, which may name the sent quote it revises (same deal, same customer, the next revision
-- number). A person edits a draft (the Q1 columns), sends it (draft to sent: the number, the time, how, the issuing entity and the buyer snapshot, a total above zero,
-- nothing else changed), and marks the quote a revision replaced superseded (sent to superseded, when that revision is itself sent). Everything else about a quote that
-- has left `draft` is frozen. A person deletes a draft only. The system context (the org purge, later steps) and a database owner's own statement (the public view's
-- first-view stamp, a test's setup) have no person to hold: they are not held to it.
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
REVOKE ALL ON FUNCTION crove_crm.quote_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS quote_guard ON crove_crm.quote;
CREATE TRIGGER quote_guard BEFORE INSERT OR UPDATE OR DELETE ON crove_crm.quote
  FOR EACH ROW EXECUTE FUNCTION crove_crm.quote_guard();
ALTER TABLE crove_crm.quote ENABLE ALWAYS TRIGGER quote_guard;

-- ---------------------------------------------------------------------------
-- 2. The lines: written only while the quote is a draft, under a share lock on it
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_crm.quote_line_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid;
  v_quote uuid;
  v_status text;
BEGIN
  IF crove_kernel.ctx_actor_type() IS NULL OR crove_kernel.ctx_actor_type() = 'system' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  -- A line stays on its quote: moving one would write to a quote whose status was never looked at.
  -- (A move to another org is left to the row policies, whose refusal the cross-org matrix expects.)
  IF TG_OP = 'UPDATE' AND NEW.org_id = OLD.org_id AND NEW.quote_id IS DISTINCT FROM OLD.quote_id THEN
    RAISE EXCEPTION 'QUOTE_FROZEN' USING ERRCODE = '42501', DETAIL = 'a line does not move to another quote';
  END IF;
  IF TG_OP = 'DELETE' THEN
    v_org := OLD.org_id;
    v_quote := OLD.quote_id;
  ELSE
    v_org := NEW.org_id;
    v_quote := NEW.quote_id;
  END IF;
  -- Held to the end of the transaction: a send (an UPDATE of the quote row) waits for it, and a write that comes after the send finds the quote sent.
  SELECT q.status INTO v_status FROM crove_crm.quote q WHERE q.org_id = v_org AND q.id = v_quote FOR SHARE;
  IF NOT FOUND THEN
    -- The quote is gone (its own delete cascades here) or not this org's to see: the foreign key and the policies decide.
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'QUOTE_FROZEN' USING ERRCODE = '42501', DETAIL = 'the lines of a quote that has left draft do not change';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_crm.quote_line_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS quote_line_guard ON crove_crm.quote_line;
CREATE TRIGGER quote_line_guard BEFORE INSERT OR UPDATE OR DELETE ON crove_crm.quote_line
  FOR EACH ROW EXECUTE FUNCTION crove_crm.quote_line_guard();
ALTER TABLE crove_crm.quote_line ENABLE ALWAYS TRIGGER quote_line_guard;

-- ---------------------------------------------------------------------------
-- 3. The public link
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_crm.quote_link (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  quote_id uuid NOT NULL,
  token_sha256 text NOT NULL CONSTRAINT quote_link_token_format CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by uuid,
  -- Set by the public view: the first time the customer opened the link, and how many times it was opened.
  first_viewed_at timestamptz,
  views integer NOT NULL DEFAULT 0 CHECK (views >= 0),
  PRIMARY KEY (org_id, id),
  CONSTRAINT quote_link_token_uq UNIQUE (token_sha256),
  CONSTRAINT quote_link_quote_fk FOREIGN KEY (org_id, quote_id) REFERENCES crove_crm.quote (org_id, id) ON DELETE CASCADE,
  CONSTRAINT quote_link_expiry CHECK (expires_at > created_at AND expires_at <= created_at + interval '120 days'),
  CONSTRAINT quote_link_revoked CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
-- Backs the quote's foreign key and the live links of a quote.
CREATE INDEX IF NOT EXISTS quote_link_quote_idx ON crove_crm.quote_link (org_id, quote_id, created_at DESC);
SELECT crove_kernel.apply_tenant_rls('crove_crm.quote_link');
REVOKE UPDATE, DELETE ON crove_crm.quote_link FROM crove_tenant;
GRANT UPDATE (revoked_at, revoked_by) ON crove_crm.quote_link TO crove_tenant;
-- Writers make a link for a quote that has been sent (never for a draft) and revoke it.
DROP POLICY IF EXISTS quote_link_insert ON crove_crm.quote_link;
CREATE POLICY quote_link_insert ON crove_crm.quote_link AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR (EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = quote_link.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member'))
      AND EXISTS (SELECT 1 FROM crove_crm.quote q WHERE q.org_id = quote_link.org_id AND q.id = quote_link.quote_id AND q.status IN ('sent', 'accepted', 'declined'))
      AND quote_link.created_by = (SELECT crove_kernel.ctx_user_id())
      AND quote_link.created_at BETWEEN pg_catalog.now() - pg_catalog.make_interval(mins => 1) AND pg_catalog.now() + pg_catalog.make_interval(mins => 1)
      AND quote_link.revoked_at IS NULL AND quote_link.first_viewed_at IS NULL AND quote_link.views = 0));
DROP POLICY IF EXISTS quote_link_update ON crove_crm.quote_link;
CREATE POLICY quote_link_update ON crove_crm.quote_link AS RESTRICTIVE FOR UPDATE TO crove_tenant
  USING ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = quote_link.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member')))
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = quote_link.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member')));

-- A link is revoked once and in the revoker's own name; nothing else about it changes.
CREATE OR REPLACE FUNCTION crove_crm.quote_link_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF crove_kernel.ctx_actor_type() IS NULL OR crove_kernel.ctx_actor_type() = 'system' OR NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL OR NEW.revoked_by IS DISTINCT FROM crove_kernel.ctx_user_id() THEN
    RAISE EXCEPTION 'QUOTE_LINK_FORBIDDEN' USING ERRCODE = '42501', DETAIL = 'a link is revoked once, in the name of the person who revokes it';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_crm.quote_link_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS quote_link_guard ON crove_crm.quote_link;
CREATE TRIGGER quote_link_guard BEFORE UPDATE ON crove_crm.quote_link
  FOR EACH ROW EXECUTE FUNCTION crove_crm.quote_link_guard();
ALTER TABLE crove_crm.quote_link ENABLE ALWAYS TRIGGER quote_link_guard;

-- ---------------------------------------------------------------------------
-- 4. The letterhead
-- ---------------------------------------------------------------------------
ALTER TABLE crove_crm.quote_setting ADD COLUMN IF NOT EXISTS phone text CHECK (phone IS NULL OR pg_catalog.length(phone) BETWEEN 1 AND 40);
ALTER TABLE crove_crm.quote_setting ADD COLUMN IF NOT EXISTS email text CHECK (email IS NULL OR pg_catalog.length(email) BETWEEN 3 AND 254);
ALTER TABLE crove_crm.quote_setting ADD COLUMN IF NOT EXISTS bank_note text CHECK (bank_note IS NULL OR pg_catalog.length(bank_note) <= 500);
GRANT UPDATE (phone, email, bank_note) ON crove_crm.quote_setting TO crove_tenant;

-- ---------------------------------------------------------------------------
-- 5. The public document
-- ---------------------------------------------------------------------------
-- 32 random bytes, base64url without padding (newQuoteToken in modules/crm). Counts the view; answers NULL for a malformed, unknown, revoked or expired token, an
-- inactive org and a quote that is not sent or decided, all the same, and returns nothing of the org but this one quote and the seller's own letterhead.
CREATE OR REPLACE FUNCTION crove_crm.quote_link_view(p_token text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_link crove_crm.quote_link;
  v_quote crove_crm.quote;
  v_today date := (pg_catalog.now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date;
BEGIN
  IF p_token IS NULL OR p_token !~ '^[A-Za-z0-9_-]{43}$' THEN
    RETURN NULL;
  END IF;
  SELECT l.* INTO v_link FROM crove_crm.quote_link l
  WHERE l.token_sha256 = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_token, 'UTF8')), 'hex');
  IF v_link.id IS NULL OR v_link.revoked_at IS NOT NULL OR v_link.expires_at <= pg_catalog.now() THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM crove_kernel.tenant t WHERE t.org_id = v_link.org_id AND t.status = 'active') THEN
    RETURN NULL;
  END IF;
  -- Locked first (a send of a revision waits), so the status read here is the one the two updates below act on.
  SELECT q.* INTO v_quote FROM crove_crm.quote q WHERE q.org_id = v_link.org_id AND q.id = v_link.quote_id FOR UPDATE;
  IF v_quote.id IS NULL OR v_quote.status NOT IN ('sent', 'accepted', 'declined') THEN
    RETURN NULL;
  END IF;
  -- The quote row first, then the link: the send of a revision locks them in that order too, so the two cannot deadlock.
  IF v_quote.first_viewed_at IS NULL THEN
    UPDATE crove_crm.quote SET first_viewed_at = pg_catalog.now() WHERE org_id = v_quote.org_id AND id = v_quote.id AND status IN ('sent', 'accepted', 'declined');
  END IF;
  UPDATE crove_crm.quote_link SET views = views + 1, first_viewed_at = coalesce(first_viewed_at, pg_catalog.now()) WHERE org_id = v_link.org_id AND id = v_link.id AND revoked_at IS NULL;
  RETURN (
    SELECT pg_catalog.jsonb_build_object(
      'number', v_quote.number,
      'revision', v_quote.revision,
      'status', v_quote.status,
      'expired', v_quote.status = 'sent' AND v_quote.valid_until < v_today,
      'validUntil', v_quote.valid_until,
      'sentAt', v_quote.sent_at,
      'notes', v_quote.remarks,
      'terms', v_quote.terms,
      'subtotal', v_quote.subtotal::text,
      'vatAmount', v_quote.vat_amount::text,
      'total', v_quote.total::text,
      'seller', (
        SELECT pg_catalog.jsonb_build_object(
          'name', coalesce(e.name, t.name),
          'taxCode', e.tax_code,
          'address', t.address,
          'phone', s.phone,
          'email', s.email,
          'bankNote', s.bank_note)
        FROM crove_kernel.tenant t
        LEFT JOIN crove_kernel.legal_entity e ON e.org_id = t.org_id AND e.id = v_quote.issuer_entity_id
        LEFT JOIN crove_crm.quote_setting s ON s.org_id = t.org_id
        WHERE t.org_id = v_quote.org_id),
      'buyer', pg_catalog.jsonb_build_object('name', v_quote.buyer_name, 'taxCode', v_quote.buyer_tax_code, 'address', v_quote.buyer_address),
      'lines', coalesce((
        SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'lineNo', l.line_no,
          'kind', l.kind,
          'description', l.description,
          'unit', l.unit,
          'quantity', l.quantity::text,
          'unitPrice', l.unit_price::text,
          'discountPercent', l.discount_percent::text,
          'vatRate', l.vat_rate,
          'amount', l.amount::text,
          'vatAmount', l.vat_amount::text) ORDER BY l.line_no)
        FROM crove_crm.quote_line l
        WHERE l.org_id = v_quote.org_id AND l.quote_id = v_quote.id), '[]'::jsonb)));
END $$;
REVOKE ALL ON FUNCTION crove_crm.quote_link_view(text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_crm.quote_link_view(text) TO crove_app;
