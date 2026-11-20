-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #4125, MISA ASP): the default stock of a MISA ASP connection for sales lines. Idempotent; applied files stay untouched.
--
-- ASP's sales line leaves a stock (stock_id, stock_code and stock_name are required), and a Ludy sales line has none, so a person keeps one stock per connection:
--   default_sales_stock_code   the stock code of the sales lines, as the firm's catalogue in MISA ASP spells it (at most 50 characters, as the item defaults), or NULL for none.
-- Typed, not picked from a list, as the default items are: the API cannot read the catalogue (only the worker opens the sealed access code). The next check matches the code against catalogue 3 (an unknown or
-- ambiguous one is a blocker, `stock_unknown`, by line); a connection without one blocks its sales lines (`stock_missing`). Only an ASP connection may keep one (the command refuses it for AMIS).
-- No new table: the column sits on the connection row, written by finance.misa_amis_connection.set_default_item (owner or admin), and the trigger that fixes the product stays as it is.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_finance.misa_amis_connection ADD COLUMN IF NOT EXISTS default_sales_stock_code text;
ALTER TABLE crove_finance.misa_amis_connection DROP CONSTRAINT IF EXISTS misa_amis_connection_default_stock_ck;
ALTER TABLE crove_finance.misa_amis_connection ADD CONSTRAINT misa_amis_connection_default_stock_ck CHECK (
  default_sales_stock_code IS NULL OR (char_length(default_sales_stock_code) BETWEEN 1 AND 50 AND product = 'asp')
);
GRANT UPDATE (default_sales_stock_code) ON crove_finance.misa_amis_connection TO crove_tenant;
