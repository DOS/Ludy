-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove CRM (issue #2229, plan docs/plan/crm.md §4.4 and §5, step K5): the staging of a contact import. Idempotent;
-- applied files stay untouched.
--
-- crove_crm.import_batch  one import in progress or done: the file's name, whether a duplicate is skipped or its empty
--                         fields filled, the counts of what the rows were classified as, and what the commit made. The
--                         file itself is read in the browser and never stored. A batch lives on as its counts once it is
--                         committed, cancelled or expired.
-- crove_crm.import_row    one row of the file as read, with how it was classified (new, duplicate, conflict or invalid)
--                         and why (a fixed code, never a value), and the party a duplicate matched. The rows carry
--                         personal data, so they exist only while the batch is staged: a commit, a cancel or an expiry
--                         (7 days) deletes them.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_crm.import_batch (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  filename text NOT NULL CHECK (pg_catalog.length(filename) BETWEEN 1 AND 255),
  status text NOT NULL DEFAULT 'staged' CHECK (status IN ('staged', 'committed', 'cancelled', 'expired')),
  on_duplicate text NOT NULL DEFAULT 'skip' CHECK (on_duplicate IN ('skip', 'fill_empty')),
  total_rows integer NOT NULL DEFAULT 0 CHECK (total_rows >= 0),
  new_rows integer NOT NULL DEFAULT 0 CHECK (new_rows >= 0),
  duplicate_rows integer NOT NULL DEFAULT 0 CHECK (duplicate_rows >= 0),
  conflict_rows integer NOT NULL DEFAULT 0 CHECK (conflict_rows >= 0),
  invalid_rows integer NOT NULL DEFAULT 0 CHECK (invalid_rows >= 0),
  created_rows integer NOT NULL DEFAULT 0 CHECK (created_rows >= 0),
  updated_rows integer NOT NULL DEFAULT 0 CHECK (updated_rows >= 0),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- When the batch was committed, cancelled or expired.
  decided_at timestamptz,
  PRIMARY KEY (org_id, id)
);
CREATE INDEX IF NOT EXISTS import_batch_status_idx ON crove_crm.import_batch (org_id, status, created_at);
SELECT crove_kernel.apply_tenant_rls('crove_crm.import_batch');
-- A batch changes only as the import runs: its status, the duplicate choice, the counts and when it was decided.
REVOKE UPDATE ON crove_crm.import_batch FROM crove_tenant;
GRANT UPDATE (status, on_duplicate, total_rows, new_rows, duplicate_rows, conflict_rows, invalid_rows, created_rows, updated_rows, decided_at) ON crove_crm.import_batch TO crove_tenant;

CREATE TABLE IF NOT EXISTS crove_crm.import_row (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  batch_id uuid NOT NULL,
  row_no integer NOT NULL CHECK (row_no >= 1),
  kind text NOT NULL DEFAULT 'person' CHECK (kind IN ('organization', 'person')),
  -- As the file had it, trimmed; an invalid row may have none.
  name text NOT NULL DEFAULT '' CHECK (pg_catalog.length(name) <= 1000),
  tax_code text CHECK (tax_code IS NULL OR pg_catalog.length(tax_code) <= 40),
  email text CHECK (email IS NULL OR pg_catalog.length(email) <= 1000),
  phone text CHECK (phone IS NULL OR pg_catalog.length(phone) <= 100),
  address text CHECK (address IS NULL OR pg_catalog.length(address) <= 2000),
  outcome text NOT NULL CHECK (outcome IN ('new', 'duplicate', 'conflict', 'invalid')),
  -- A fixed code such as DUPLICATE_TAX_CODE or INVALID_EMAIL, never a value from the file.
  reason text CHECK (reason IS NULL OR reason ~ '^[A-Z_]{1,60}$'),
  match_party_id uuid,
  PRIMARY KEY (org_id, id),
  CONSTRAINT import_row_batch_row_uq UNIQUE (org_id, batch_id, row_no),
  CONSTRAINT import_row_batch_fk FOREIGN KEY (org_id, batch_id) REFERENCES crove_crm.import_batch (org_id, id) ON DELETE CASCADE,
  CONSTRAINT import_row_party_fk FOREIGN KEY (org_id, match_party_id) REFERENCES crove_kernel.party (org_id, id) ON DELETE SET NULL (match_party_id)
);
CREATE INDEX IF NOT EXISTS import_row_party_idx ON crove_crm.import_row (org_id, match_party_id);
SELECT crove_kernel.apply_tenant_rls('crove_crm.import_row');
-- A staged row is written once and deleted; nothing edits what was read from the file.
REVOKE UPDATE ON crove_crm.import_row FROM crove_tenant;
