-- SPDX-License-Identifier: AGPL-3.0-only
-- Validates the checks of 20270123100000 (#4149): the origin of a row is 'ui' or 'mcp' and a row of origin 'mcp' is tainted. They were added NOT VALID there, so they already bind every new or changed row; the scan
-- of the old rows runs here, in a transaction of its own, one table at a time, so it does not run under the lock the added columns took. Every old row took the defaults and passes. Idempotent.
SET LOCAL lock_timeout = '2s';

-- migration-lint: cross-module validates the check that file added on the table of the line that owns the row (#4149).
ALTER TABLE crove_crm.deal VALIDATE CONSTRAINT mcp_origin_ck;
-- migration-lint: cross-module see above.
ALTER TABLE crove_crm.quote VALIDATE CONSTRAINT mcp_origin_ck;
-- migration-lint: cross-module see above.
ALTER TABLE crove_crm.quote_line VALIDATE CONSTRAINT mcp_origin_ck;
ALTER TABLE crove_kernel.conversation_note VALIDATE CONSTRAINT mcp_origin_ck;
ALTER TABLE crove_kernel.party VALIDATE CONSTRAINT mcp_origin_ck;
ALTER TABLE crove_kernel.activity VALIDATE CONSTRAINT mcp_origin_ck;
