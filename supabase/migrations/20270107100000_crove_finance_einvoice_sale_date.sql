-- SPDX-License-Identifier: AGPL-3.0-only
-- The sale date of a sales e-invoice draft, apart from the date of the invoice (#3535, plan einvoice-issue.md section 3b, the accountant's answer to #2506 question 4: a sale
-- missed in its own period is issued later and declared in the period of the sale). `invoice_date` stays the date the invoice is issued and printed; `sale_date` is the moment of
-- the sale (Decree 254 Art. 9), null for "the same day". A sale issued after the next working day carries the person's reason (`late_reason`), the one thing the fine for a late
-- invoice is argued from. Both columns are content of the invoice: einvoice_draft_guard compares whole rows, so they are frozen with the rest once a draft leaves `draft`.
ALTER TABLE crove_finance.einvoice_draft ADD COLUMN IF NOT EXISTS sale_date date;
ALTER TABLE crove_finance.einvoice_draft ADD COLUMN IF NOT EXISTS late_reason text;

DO $$
BEGIN
  -- A sale is not later than its invoice, and a reason belongs only to a sale that has a date of its own.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'einvoice_draft_sale_date_check' AND conrelid = 'crove_finance.einvoice_draft'::pg_catalog.regclass) THEN
    ALTER TABLE crove_finance.einvoice_draft ADD CONSTRAINT einvoice_draft_sale_date_check CHECK (sale_date IS NULL OR sale_date <= invoice_date);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'einvoice_draft_late_reason_check' AND conrelid = 'crove_finance.einvoice_draft'::pg_catalog.regclass) THEN
    ALTER TABLE crove_finance.einvoice_draft ADD CONSTRAINT einvoice_draft_late_reason_check CHECK (late_reason IS NULL OR (sale_date IS NOT NULL AND char_length(late_reason) BETWEEN 1 AND 500));
  END IF;
END $$;

-- The VAT working finds the draft of a recorded sale by entity and invoice number as the intake keeps it (digits without leading zeros, anything else upper-cased). The expression is
-- the one the query writes (modules/finance/src/vat.ts SALE_DATE), so the planner reads this small partial index and never scans the drafts. The table is not a hot one (no
-- concurrent build is asked for).
CREATE INDEX IF NOT EXISTS einvoice_draft_sale_number_idx ON crove_finance.einvoice_draft (
  org_id, legal_entity_id,
  (CASE WHEN pg_catalog.btrim(issued_number) ~ '^[0-9]+$' THEN pg_catalog.regexp_replace(pg_catalog.btrim(issued_number), '^0+(?=[0-9])', '') ELSE pg_catalog.upper(pg_catalog.btrim(issued_number)) END)
) WHERE state = 'issued' AND sale_date IS NOT NULL;

-- The content an invoice is issued from, as one hash (20261123050000): the sale date and the reason join it only when the draft has a sale date, so the hash of every draft without
-- one, and of a request already made for it, is what it was.
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
     || CASE WHEN d.sale_date IS NULL THEN '[]'::pg_catalog.jsonb ELSE pg_catalog.jsonb_build_array(d.sale_date::text, COALESCE(d.late_reason, '')) END)::text,
    'UTF8')), 'hex')
  FROM crove_finance.einvoice_draft d
  WHERE d.org_id = p_org AND d.id = p_draft
$$;
REVOKE ALL ON FUNCTION crove_finance.einvoice_content_hash(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_finance.einvoice_content_hash(uuid, uuid) TO crove_tenant;
