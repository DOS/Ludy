-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #4250, step 2 of the link table of #2840 point 3, #4238; plan stock-and-marketplaces.md section 8.7): the link between a marketplace connection and the staged file its poll
-- ingested. Idempotent; applied files stay untouched.
--
-- marketplace_connection_file   one row per file a connection's poll ingested: the finance marketplace connection and the file. It is written by finance.marketplace_connection.ingest_page (the system
--                               context, the poll's command) in the SAME transaction as the ingest, so a file is linked if and only if its poll ingested it, and the orders still waiting for a connection
--                               are counted from this link, not from the file's name (a member's upload named after a connection id no longer inflates it). Org-level: no legal entity (the file
--                               carries its own, and so does the connection). Unique per file: a file belongs to one connection, and a page read twice (the same bytes) is one file and one link.
--
-- Append-only for a tenant role (read and insert; no UPDATE, no DELETE). The foreign keys cascade, so the file's own deletion (retention, erasure), the connection's removal and the org's purge take
-- the link with them without a DELETE grant. The link holds ids and a time only: no filename, no order, no buyer data.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_finance.marketplace_connection_file (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  marketplace_connection_id uuid NOT NULL,
  file_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  -- A file belongs to one connection.
  CONSTRAINT marketplace_connection_file_file_uq UNIQUE (org_id, file_id),
  -- Both are the org's own, and the removal of either removes the link.
  CONSTRAINT marketplace_connection_file_connection_fk FOREIGN KEY (org_id, marketplace_connection_id) REFERENCES crove_finance.marketplace_connection (org_id, id) ON DELETE CASCADE,
  CONSTRAINT marketplace_connection_file_file_fk FOREIGN KEY (org_id, file_id) REFERENCES crove_kernel.file (org_id, id) ON DELETE CASCADE
);
-- The orders-waiting count reads the links of each connection.
CREATE INDEX IF NOT EXISTS marketplace_connection_file_connection_idx ON crove_finance.marketplace_connection_file (org_id, marketplace_connection_id);
SELECT crove_kernel.apply_tenant_rls('crove_finance.marketplace_connection_file');
-- Append-only: no UPDATE and no DELETE for a tenant role (the cascades above and the org purge remove the rows).
REVOKE UPDATE, DELETE ON crove_finance.marketplace_connection_file FROM crove_tenant;
