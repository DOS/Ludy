-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #4285, follow-up of #4273 and #4276): a marketplace connection remembers which seller (shop) it was authorized for. Idempotent; applied files stay untouched.
--
-- Authorizing a connection again (before or after its refresh token ends) or connecting it again replaces the sealed secret, and with it the seller id that was inside it. A seller who rebinds the app to
-- another shop could then silently move the same connection (its books, its link rows, its poll cursor) onto the other shop's orders. So:
-- seller_ref           the platform's id of the seller (digits or letters, a short word, never a name, e-mail or token), written by the worker's authorize step the first time an authorization works and kept
--                      for good: a reconnect does not clear it. A later authorization for a different seller is refused (authorize_state = 'shop_changed') and changes nothing else.
-- authorize_state      gains 'shop_changed' (the seller who authorized is not the seller of this connection: a different seller needs a new connection).
-- The column is not a secret: an identifier the platform shows the seller. The connection list does not return it.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_finance.marketplace_connection
  ADD COLUMN IF NOT EXISTS seller_ref text;

ALTER TABLE crove_finance.marketplace_connection DROP CONSTRAINT IF EXISTS marketplace_connection_seller_ref_ck;
ALTER TABLE crove_finance.marketplace_connection ADD CONSTRAINT marketplace_connection_seller_ref_ck CHECK (seller_ref IS NULL OR seller_ref ~ '^[A-Za-z0-9_-]{1,64}$');

ALTER TABLE crove_finance.marketplace_connection DROP CONSTRAINT IF EXISTS marketplace_connection_authorize_state_ck;
ALTER TABLE crove_finance.marketplace_connection ADD CONSTRAINT marketplace_connection_authorize_state_ck
  CHECK (authorize_state IS NULL OR authorize_state IN ('pending', 'authorized', 'refused', 'failed', 'shop_changed'));

GRANT UPDATE (seller_ref) ON crove_finance.marketplace_connection TO crove_tenant;
