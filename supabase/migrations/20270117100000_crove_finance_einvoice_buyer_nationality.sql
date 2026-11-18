-- SPDX-License-Identifier: AGPL-3.0-only
-- Two facts of a sales e-invoice draft that the research of 2026-11-18 asked for (#3709, plan einvoice-issue.md sections 3a and 3c; the research doc, E rows 6 and 7):
--   buyer_nationality        the ISO 3166-1 alpha-2 code of a foreign buyer who gives a passport (Decree 254 Appendix point 4.b). Only a passport carries one. Personal data like the identity it
--                            belongs to: classified `national_id` in the finance manifest and listed in the personal-data registry. That a passport comes with a nationality is the save command's
--                            rule and a check on the draft, not a CHECK here: a draft saved with a passport before this change has none, and a constraint (even NOT VALID) would refuse every later
--                            update of that row, the state moves of issuing included. Those drafts show the issue and cannot be issued until it is filled.
--   correction_rate_basis    the day the 8% of an adjusting or a replacing invoice's lines is judged on, as a person confirmed it: 'original' (the original's date: no change of amount, a return, a
--                            trade discount) or 'correction_date' (the correction's own date: an error that changes the amount and the VAT). Only with a correction; null on a correction made
--                            before this column, which is judged on the original's date as it always was.
-- Both are content of the invoice: einvoice_draft_guard compares whole rows, so they are frozen with the rest once a draft leaves `draft`, and each joins the content hash only when set, so the hash
-- of every draft without them, and of a request already made for it, is what it was.
ALTER TABLE crove_finance.einvoice_draft ADD COLUMN IF NOT EXISTS buyer_nationality text;
ALTER TABLE crove_finance.einvoice_draft ADD COLUMN IF NOT EXISTS correction_rate_basis text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'einvoice_draft_buyer_nationality_check' AND conrelid = 'crove_finance.einvoice_draft'::pg_catalog.regclass) THEN
    -- Only a passport carries a nationality, and it is two capital letters.
    ALTER TABLE crove_finance.einvoice_draft ADD CONSTRAINT einvoice_draft_buyer_nationality_check CHECK (
      buyer_nationality IS NULL OR (buyer_identity_kind = 'passport' AND buyer_nationality ~ '^[A-Z]{2}$')
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'einvoice_draft_correction_rate_basis_check' AND conrelid = 'crove_finance.einvoice_draft'::pg_catalog.regclass) THEN
    ALTER TABLE crove_finance.einvoice_draft ADD CONSTRAINT einvoice_draft_correction_rate_basis_check CHECK (correction_rate_basis IS NULL OR correction_rate_basis IN ('original', 'correction_date'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'einvoice_draft_correction_rate_basis_kind_check' AND conrelid = 'crove_finance.einvoice_draft'::pg_catalog.regclass) THEN
    -- The basis belongs to a correction.
    ALTER TABLE crove_finance.einvoice_draft ADD CONSTRAINT einvoice_draft_correction_rate_basis_kind_check CHECK (correction_rate_basis IS NULL OR correction_kind IS NOT NULL);
  END IF;
END $$;

-- The content an invoice is issued from, as one hash. This is the newest body (20270110100000: the base, the sale date, the buyer's identity, the correction) with the nationality after the
-- identity and the rate basis after the correction; each term after the base joins the hash only when set.
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
     || CASE WHEN d.buyer_identity IS NULL THEN '[]'::pg_catalog.jsonb ELSE pg_catalog.jsonb_build_array(d.buyer_identity_kind, d.buyer_identity) END
     || CASE WHEN d.buyer_nationality IS NULL THEN '[]'::pg_catalog.jsonb ELSE pg_catalog.jsonb_build_array(d.buyer_nationality) END
     || CASE WHEN d.correction_kind IS NULL THEN '[]'::pg_catalog.jsonb
             ELSE pg_catalog.jsonb_build_array(d.correction_kind, d.original_draft_id::text, d.reason_code, COALESCE(d.agreement_file_id::text, '')) END
     || CASE WHEN d.correction_rate_basis IS NULL THEN '[]'::pg_catalog.jsonb ELSE pg_catalog.jsonb_build_array(d.correction_rate_basis) END)::text,
    'UTF8')), 'hex')
  FROM crove_finance.einvoice_draft d
  WHERE d.org_id = p_org AND d.id = p_draft
$$;
REVOKE ALL ON FUNCTION crove_finance.einvoice_content_hash(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_finance.einvoice_content_hash(uuid, uuid) TO crove_tenant;
