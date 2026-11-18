-- SPDX-License-Identifier: AGPL-3.0-only
-- Adjusting or replacing an issued sales e-invoice (#2504, plan einvoice-issue.md section 8 flows "Adjustment" and "Replacement", the accountant's answers of section 3b). A correcting
-- invoice is a draft of its own that points at the issued draft it corrects:
--   correction_kind     'adjustment' (the original stays in force, the new invoice carries the difference) or 'replacement' (the new invoice takes the original's place); null on an ordinary invoice
--   original_draft_id   the issued draft corrected: its series, number and date are the reference sent to the provider, read from its stored row, never typed
--   reason_code         the Appendix XVII code of the reason (#3571), checked against the list by the command
--   agreement_file_id   the signed agreement ("biên bản thỏa thuận") of a buyer with a tax code, an evidence file of the org; null for an individual buyer
-- The four are all set or all null (agreement apart), are content of the invoice (einvoice_draft_guard compares whole rows, so they are frozen with the rest once the draft leaves `draft`)
-- and join the content hash only when set, so the hash of every ordinary draft, and of a request already made for it, is what it was. No cancel action exists: an issued invoice is only
-- ever corrected by one of these two.
-- The agreement file has no foreign key on purpose: the org purge deletes files before the draft rows, and a restricting key there would stop it; the command checks the file is the
-- org's. The original has a plain key (checked at the end of the statement, so a purge that deletes both together passes).
ALTER TABLE crove_finance.einvoice_draft ADD COLUMN IF NOT EXISTS correction_kind text;
ALTER TABLE crove_finance.einvoice_draft ADD COLUMN IF NOT EXISTS original_draft_id uuid;
ALTER TABLE crove_finance.einvoice_draft ADD COLUMN IF NOT EXISTS reason_code text;
ALTER TABLE crove_finance.einvoice_draft ADD COLUMN IF NOT EXISTS agreement_file_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'einvoice_draft_correction_check' AND conrelid = 'crove_finance.einvoice_draft'::pg_catalog.regclass) THEN
    ALTER TABLE crove_finance.einvoice_draft ADD CONSTRAINT einvoice_draft_correction_check CHECK (
      (correction_kind IS NULL AND original_draft_id IS NULL AND reason_code IS NULL AND agreement_file_id IS NULL)
      OR (correction_kind IN ('adjustment', 'replacement') AND original_draft_id IS NOT NULL AND original_draft_id <> id AND reason_code IS NOT NULL AND char_length(reason_code) BETWEEN 1 AND 50));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'einvoice_draft_original_fk' AND conrelid = 'crove_finance.einvoice_draft'::pg_catalog.regclass) THEN
    ALTER TABLE crove_finance.einvoice_draft ADD CONSTRAINT einvoice_draft_original_fk FOREIGN KEY (org_id, original_draft_id) REFERENCES crove_finance.einvoice_draft (org_id, id);
  END IF;
END $$;

-- The foreign key to the original (G3 fk-index), and the lookup of an invoice's corrections.
CREATE INDEX IF NOT EXISTS einvoice_draft_original_idx ON crove_finance.einvoice_draft (org_id, original_draft_id) WHERE original_draft_id IS NOT NULL;

-- The content an invoice is issued from, as one hash. This is the newest body (20270109140000: the base, the sale date, the buyer's identity) with the correction's kind, original, reason
-- and agreement added; each term after the base joins the hash only when set, so the hash of every draft that has none of them, and of a request already made for it, is what it was.
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
     || CASE WHEN d.correction_kind IS NULL THEN '[]'::pg_catalog.jsonb
             ELSE pg_catalog.jsonb_build_array(d.correction_kind, d.original_draft_id::text, d.reason_code, COALESCE(d.agreement_file_id::text, '')) END)::text,
    'UTF8')), 'hex')
  FROM crove_finance.einvoice_draft d
  WHERE d.org_id = p_org AND d.id = p_draft
$$;
REVOKE ALL ON FUNCTION crove_finance.einvoice_content_hash(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_finance.einvoice_content_hash(uuid, uuid) TO crove_tenant;
