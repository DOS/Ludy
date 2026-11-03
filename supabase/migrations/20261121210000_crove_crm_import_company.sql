-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove CRM (issue #2438, CRM-Q5 of docs/plan/crm.md, PR 2): the "Công ty" column of the contact import. A person's row may name the company they work
-- at, as a name or as the company's tax code; the staging keeps what the row came to, so the preview can show it and the commit can link the person
-- (kernel.party.company_id, 20261121180000). Idempotent; applied files stay untouched. No table is added.
--
-- crove_crm.import_row    company_name   the cell as the file had it (personal data like the rest of the row: a person's workplace), cut to the column;
--                         company_state  none (no cell, or nothing usable in it), matched (an existing company), new (a name the org does not have),
--                                        unknown_tax_code (a tax code no company has) or ambiguous (two companies of that name);
--                         company_party_id  the company a matched row names (the party kept, never one merged into another); set to NULL if that
--                                        company is deleted (the org purge), as match_party_id is.
-- crove_crm.import_batch  new_companies  the companies the new rows name that the org does not have yet (a commit that is told to makes them);
--                         created_companies, linked_rows  what the commit did. Counts only, like the others.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_crm.import_row
  ADD COLUMN IF NOT EXISTS company_name text CHECK (company_name IS NULL OR pg_catalog.length(company_name) <= 1000),
  ADD COLUMN IF NOT EXISTS company_state text NOT NULL DEFAULT 'none' CHECK (company_state IN ('none', 'matched', 'new', 'unknown_tax_code', 'ambiguous')),
  ADD COLUMN IF NOT EXISTS company_party_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'import_row_company_fk' AND conrelid = 'crove_crm.import_row'::regclass) THEN
    ALTER TABLE crove_crm.import_row
      ADD CONSTRAINT import_row_company_fk FOREIGN KEY (org_id, company_party_id) REFERENCES crove_kernel.party (org_id, id) ON DELETE SET NULL (company_party_id);
  END IF;
END
$$;
CREATE INDEX IF NOT EXISTS import_row_company_idx ON crove_crm.import_row (org_id, company_party_id) WHERE company_party_id IS NOT NULL;

ALTER TABLE crove_crm.import_batch
  ADD COLUMN IF NOT EXISTS new_companies integer NOT NULL DEFAULT 0 CHECK (new_companies >= 0),
  ADD COLUMN IF NOT EXISTS created_companies integer NOT NULL DEFAULT 0 CHECK (created_companies >= 0),
  ADD COLUMN IF NOT EXISTS linked_rows integer NOT NULL DEFAULT 0 CHECK (linked_rows >= 0);
-- A batch changes only as the import runs (20261116090000): the new counts join the columns the tenant role may update.
GRANT UPDATE (new_companies, created_companies, linked_rows) ON crove_crm.import_batch TO crove_tenant;
