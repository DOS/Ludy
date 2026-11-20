-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #4124, S3b part 3 of #4103; plan accounting-software-sync.md step 5): the default item of a MISA connection. Idempotent; applied files stay untouched.
--
-- A service line (a purchase of services) and a sales line are written with the item the person names, which until now they typed again with every preview. A person now keeps a default per connection:
--   default_service_item_code   the item code for service lines (a purchase of services)
--   default_sales_item_code     the item code for sales lines
-- Each is the code as the firm's catalogue in MISA spells it (at most 50 characters, as the preview's own field), or NULL for none. A code is typed, not picked from a list: the API cannot read the catalogue
-- (the access code is sealed and only the worker opens it) and the catalogue is never stored. The worker checks a code against the catalogue with the next check (an item the catalogue does not have is a
-- blocker, `item_code_unknown`, by line), so nothing wrong is sent.
-- No new table: the two columns sit on the connection row. An owner or admin sets or clears them through finance.misa_amis_connection.set_default_item; the table's own update policy already allows only owners,
-- admins and the system context, and the trigger that fixes the product and the channel connection (misa_amis_connection_fixed) is untouched.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_finance.misa_amis_connection ADD COLUMN IF NOT EXISTS default_service_item_code text;
ALTER TABLE crove_finance.misa_amis_connection ADD COLUMN IF NOT EXISTS default_sales_item_code text;
ALTER TABLE crove_finance.misa_amis_connection DROP CONSTRAINT IF EXISTS misa_amis_connection_default_items_ck;
ALTER TABLE crove_finance.misa_amis_connection ADD CONSTRAINT misa_amis_connection_default_items_ck CHECK (
  (default_service_item_code IS NULL OR char_length(default_service_item_code) BETWEEN 1 AND 50)
  AND (default_sales_item_code IS NULL OR char_length(default_sales_item_code) BETWEEN 1 AND 50)
);
-- The only two columns besides the last test's state and time that a tenant role may update; the product, the channel connection, the company code and the entity stay as they were made.
GRANT UPDATE (default_service_item_code, default_sales_item_code) ON crove_finance.misa_amis_connection TO crove_tenant;
