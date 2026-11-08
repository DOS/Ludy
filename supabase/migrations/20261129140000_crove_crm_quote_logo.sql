-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove CRM (issue #2814, plan docs/plan/crm-quotes.md section 4.6, a follow-up of Q2 #2694): the logo on the quote's letterhead. Idempotent; applied files stay untouched.
--
-- Decision (Engage PO): the logo is one kernel file of the org, set by an owner or admin, shown on the public quote page and the PDF. It stays live (unlike the seller's text, which
-- #2826 froze at send): a new logo shows on quotes already sent. The public page reaches the image only through quote_link_logo, by the link's token, which answers for that one
-- quote's seller logo and nothing else.
--
-- crove_crm.quote_setting       gains logo_file_id, a composite foreign key to the kernel's file table (no ON DELETE action, like the Social watermark's file: a file in use is not
--                               deleted; the org purge deletes the settings before the files). The tenant roles may update it. No new table, so no RLS or org purge change.
-- crove_crm.quote_link_view     is the body of 20261129130000 with one added key, hasLogo (whether the page has an image to ask for). Signature, owner and grants as they were.
-- crove_crm.quote_link_logo     (new) the file reference of the logo for the link's token, for the server to read the bytes with; the same refusals as quote_link_view, in the same
--                               order, answered with NULL, but it counts no view and changes no row. Execute only for crove_app, as the view's.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_crm.quote_setting ADD COLUMN IF NOT EXISTS logo_file_id uuid;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint c
    WHERE c.conname = 'quote_setting_logo_fk' AND c.conrelid = 'crove_crm.quote_setting'::pg_catalog.regclass
  ) THEN
    ALTER TABLE crove_crm.quote_setting
      ADD CONSTRAINT quote_setting_logo_fk FOREIGN KEY (org_id, logo_file_id) REFERENCES crove_kernel.file (org_id, id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS quote_setting_logo_idx ON crove_crm.quote_setting (org_id, logo_file_id) WHERE logo_file_id IS NOT NULL;
GRANT UPDATE (logo_file_id) ON crove_crm.quote_setting TO crove_tenant;

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
      -- Whether the org's letterhead has a logo; the image itself comes from quote_link_logo, by the same token.
      'hasLogo', EXISTS (
        SELECT 1 FROM crove_crm.quote_setting s
        JOIN crove_kernel.file f ON f.org_id = s.org_id AND f.id = s.logo_file_id
        WHERE s.org_id = v_quote.org_id AND f.content_type IN ('image/png', 'image/jpeg')),
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

CREATE OR REPLACE FUNCTION crove_crm.quote_link_logo(p_token text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_link crove_crm.quote_link;
  v_quote crove_crm.quote;
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
  SELECT q.* INTO v_quote FROM crove_crm.quote q WHERE q.org_id = v_link.org_id AND q.id = v_link.quote_id;
  IF v_quote.id IS NULL OR v_quote.status NOT IN ('sent', 'accepted', 'declined') THEN
    RETURN NULL;
  END IF;
  -- Only the logo of the quote's own org, and only an image the upload checks let in.
  RETURN (
    SELECT pg_catalog.jsonb_build_object(
      'storageKey', f.storage_key,
      'generation', f.generation,
      'sha256', f.sha256,
      'contentType', f.content_type,
      'sizeBytes', f.size_bytes)
    FROM crove_crm.quote_setting s
    JOIN crove_kernel.file f ON f.org_id = s.org_id AND f.id = s.logo_file_id
    WHERE s.org_id = v_quote.org_id AND f.content_type IN ('image/png', 'image/jpeg'));
END $$;

REVOKE ALL ON FUNCTION crove_crm.quote_link_view(text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_crm.quote_link_view(text) TO crove_app;
REVOKE ALL ON FUNCTION crove_crm.quote_link_logo(text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_crm.quote_link_logo(text) TO crove_app;
