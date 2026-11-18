-- SPDX-License-Identifier: AGPL-3.0-only
-- The identity an individual buyer gives on a sales e-invoice draft instead of a tax code (#3678, plan einvoice-issue.md section 3a, row 4): the personal ID number (CCCD, 12 digits),
-- a passport number or the code of a unit with a budget relation, one at a time. The shape is the check's business (a draft may hold one that does not pass yet), so the database keeps
-- only the kind, the length and that it belongs to an individual. Personal data: classified `national_id` in the finance manifest (the PO's security review of #3681, as HR classes the same data) and listed in the personal-data registry. Both columns are
-- content of the invoice: einvoice_draft_guard compares whole rows, so they are frozen with the rest once a draft leaves `draft`.
ALTER TABLE crove_finance.einvoice_draft ADD COLUMN IF NOT EXISTS buyer_identity_kind text;
ALTER TABLE crove_finance.einvoice_draft ADD COLUMN IF NOT EXISTS buyer_identity text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'einvoice_draft_buyer_identity_kind_check' AND conrelid = 'crove_finance.einvoice_draft'::pg_catalog.regclass) THEN
    ALTER TABLE crove_finance.einvoice_draft ADD CONSTRAINT einvoice_draft_buyer_identity_kind_check CHECK (buyer_identity_kind IS NULL OR buyer_identity_kind IN ('cccd', 'passport', 'budget_code'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'einvoice_draft_buyer_identity_check' AND conrelid = 'crove_finance.einvoice_draft'::pg_catalog.regclass) THEN
    -- The kind and the value come together, only an individual has one, and its length is bounded.
    ALTER TABLE crove_finance.einvoice_draft ADD CONSTRAINT einvoice_draft_buyer_identity_check CHECK (
      (buyer_identity_kind IS NULL) = (buyer_identity IS NULL)
      AND (buyer_identity IS NULL OR (buyer_kind = 'individual' AND char_length(buyer_identity) BETWEEN 1 AND 20))
    );
  END IF;
END $$;

-- The content an invoice is issued from, as one hash (20261123050000, 20270107100000): the identity joins it only when the draft has one, so the hash of every draft without one, and of a
-- request already made for it, is what it was.
CREATE OR REPLACE FUNCTION crove_finance.einvoice_content_hash(p_org uuid, p_draft uuid) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    (pg_catalog.jsonb_build_array(
      d.legal_entity_id::text, COALESCE(d.series_id::text, ''), d.invoice_date::text, d.currency, d.buyer_kind,
      COALESCE(d.buyer_tax_code, ''), COALESCE(d.buyer_name, ''), COALESCE(d.buyer_address, ''), COALESCE(d.buyer_email, ''),
      d.subtotal::text, d.vat_amount::text, d.total::text,
      COALESCE((
        SELECT pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_array(l.line_no::text, l.description, COALESCE(l.unit, ''), l.quantity::text, l.unit_price::text, l.amount::text, l.vat_rate, l.vat_amount::text)
          ORDER BY l.line_no)
        FROM crove_finance.einvoice_draft_line l WHERE l.org_id = d.org_id AND l.draft_id = d.id), '[]'::pg_catalog.jsonb))
     || CASE WHEN d.sale_date IS NULL THEN '[]'::pg_catalog.jsonb ELSE pg_catalog.jsonb_build_array(d.sale_date::text, COALESCE(d.late_reason, '')) END
     || CASE WHEN d.buyer_identity IS NULL THEN '[]'::pg_catalog.jsonb ELSE pg_catalog.jsonb_build_array(d.buyer_identity_kind, d.buyer_identity) END)::text,
    'UTF8')), 'hex')
  FROM crove_finance.einvoice_draft d
  WHERE d.org_id = p_org AND d.id = p_draft
$$;
REVOKE ALL ON FUNCTION crove_finance.einvoice_content_hash(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_finance.einvoice_content_hash(uuid, uuid) TO crove_tenant;
