-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove CRM (issue #2826, plan docs/plan/crm-quotes.md sections 4.1 and 4.6, a follow-up of Q2 #2694): the seller's letterhead is frozen into the quote when it is sent.
-- Idempotent; applied files stay untouched.
--
-- Decision (Engage PO): a sent quote is a commitment, and its payment details must not change under the customer's feet (the rule of the frozen order, ADR-0050); a
-- live bank note is also a fraud vector if an account is taken over. So, like the buyer, the seller block of the document is copied into the quote at send: the issuing
-- entity's name and tax code, the org's address, and the quote settings' phone, email and bank note. The public page (and the PDF) read that snapshot for a sent quote;
-- a draft keeps reading the live settings; a revision takes a fresh snapshot when it is sent; a quote sent before this migration has no snapshot (seller_name is NULL)
-- and still shows the live letterhead.
--
-- crove_crm.quote        gains the six seller_* columns; the tenant roles may set them only in the draft to sent step the guard allows (and a new row has none).
-- crove_crm.quote_guard  is the body of 20261128170000 (Q4, with the accepted and declined step) with the six columns held like the buyer's: none on a new row, unchanged by an edit of a draft, and a sent quote
--                        has a seller_name.
-- crove_crm.quote_link_view  is the body of 20261128120000 with the seller block read from the snapshot when there is one. Signature, owner and grants as they were.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_crm.quote ADD COLUMN IF NOT EXISTS seller_name text CHECK (seller_name IS NULL OR pg_catalog.length(seller_name) BETWEEN 1 AND 400);
ALTER TABLE crove_crm.quote ADD COLUMN IF NOT EXISTS seller_tax_code text CHECK (seller_tax_code IS NULL OR pg_catalog.length(seller_tax_code) BETWEEN 1 AND 40);
ALTER TABLE crove_crm.quote ADD COLUMN IF NOT EXISTS seller_address text CHECK (seller_address IS NULL OR pg_catalog.length(seller_address) BETWEEN 1 AND 1000);
ALTER TABLE crove_crm.quote ADD COLUMN IF NOT EXISTS seller_phone text CHECK (seller_phone IS NULL OR pg_catalog.length(seller_phone) BETWEEN 1 AND 40);
ALTER TABLE crove_crm.quote ADD COLUMN IF NOT EXISTS seller_email text CHECK (seller_email IS NULL OR pg_catalog.length(seller_email) BETWEEN 3 AND 254);
ALTER TABLE crove_crm.quote ADD COLUMN IF NOT EXISTS seller_bank_note text CHECK (seller_bank_note IS NULL OR pg_catalog.length(seller_bank_note) BETWEEN 1 AND 500);
GRANT UPDATE (seller_name, seller_tax_code, seller_address, seller_phone, seller_email, seller_bank_note) ON crove_crm.quote TO crove_tenant;

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
       OR NEW.buyer_tax_code IS NOT NULL OR NEW.buyer_address IS NOT NULL OR NEW.buyer_email IS NOT NULL
       OR NEW.seller_name IS NOT NULL OR NEW.seller_tax_code IS NOT NULL OR NEW.seller_address IS NOT NULL OR NEW.seller_phone IS NOT NULL OR NEW.seller_email IS NOT NULL OR NEW.seller_bank_note IS NOT NULL THEN
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
      IF (NEW.number, NEW.sent_at, NEW.sent_via, NEW.first_viewed_at, NEW.decided_at, NEW.decline_reason, NEW.issuer_entity_id, NEW.buyer_name, NEW.buyer_tax_code, NEW.buyer_address, NEW.buyer_email,
          NEW.seller_name, NEW.seller_tax_code, NEW.seller_address, NEW.seller_phone, NEW.seller_email, NEW.seller_bank_note)
         IS DISTINCT FROM (OLD.number, OLD.sent_at, OLD.sent_via, OLD.first_viewed_at, OLD.decided_at, OLD.decline_reason, OLD.issuer_entity_id, OLD.buyer_name, OLD.buyer_tax_code, OLD.buyer_address, OLD.buyer_email,
          OLD.seller_name, OLD.seller_tax_code, OLD.seller_address, OLD.seller_phone, OLD.seller_email, OLD.seller_bank_note) THEN
        RAISE EXCEPTION 'QUOTE_FORBIDDEN' USING ERRCODE = '42501', DETAIL = 'a draft is sent by the send command, not edited into a sent one';
      END IF;
    ELSIF NEW.status = 'sent' THEN
      -- The send: what the customer will see is what was saved (the totals, the validity, the notes and the terms do not change in the same statement).
      IF (NEW.subtotal, NEW.vat_amount, NEW.total, NEW.valid_until, NEW.remarks, NEW.terms) IS DISTINCT FROM (OLD.subtotal, OLD.vat_amount, OLD.total, OLD.valid_until, OLD.remarks, OLD.terms) THEN
        RAISE EXCEPTION 'QUOTE_FORBIDDEN' USING ERRCODE = '42501', DETAIL = 'a quote is sent as it was saved';
      END IF;
      IF NEW.number IS NULL OR NEW.number !~ '^BG-[0-9]{4}-[0-9]{4,}$' OR NEW.sent_at IS NULL OR NEW.sent_via IS NULL OR NEW.issuer_entity_id IS NULL OR NEW.buyer_name IS NULL OR NEW.seller_name IS NULL
         OR NEW.first_viewed_at IS NOT NULL OR NEW.decided_at IS NOT NULL OR NEW.decline_reason IS NOT NULL THEN
        RAISE EXCEPTION 'QUOTE_FORBIDDEN' USING ERRCODE = '42501', DETAIL = 'a sent quote has its number, time, way, issuing entity, seller and buyer, and none of the decision facts';
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
      -- The seller as it was when the quote was sent; a quote sent before the snapshot existed (no seller_name) shows the live letterhead.
      'seller', CASE WHEN v_quote.seller_name IS NOT NULL THEN pg_catalog.jsonb_build_object(
          'name', v_quote.seller_name,
          'taxCode', v_quote.seller_tax_code,
          'address', v_quote.seller_address,
          'phone', v_quote.seller_phone,
          'email', v_quote.seller_email,
          'bankNote', v_quote.seller_bank_note)
        ELSE (
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
        WHERE t.org_id = v_quote.org_id) END,
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

REVOKE ALL ON FUNCTION crove_crm.quote_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION crove_crm.quote_link_view(text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_crm.quote_link_view(text) TO crove_app;
