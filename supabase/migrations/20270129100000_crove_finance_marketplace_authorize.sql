-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #4238, Lazada S2b, ADR-0045 point 7): what a marketplace connection needs to be authorized by its seller. Idempotent; applied files stay untouched.
--
-- Lazada's In-house app is authorized by the seller on Lazada's own page, which redirects back with a one-time code that only the app secret can turn into tokens. So the connection row gains:
-- app_key              the App Key the seller typed: a public identifier (the OAuth client_id), kept in the clear so the API can build the authorize address without opening the sealed secret.
-- authorize_state_*    one pending authorization: the hash of a random state (never the state), when it ends, and the member who started it. Single use: the callback clears them in the same
--                      statement that checks them. One pending authorization per connection (a new start replaces the old one).
-- authorize_code_*     the one-time code the callback brought, sealed at the API edge like any secret (the API never opens it); the worker opens it, exchanges it and clears it.
-- authorize_state      where the exchange stands: pending (a code is waiting for the worker), authorized, refused (Lazada says the code is bad, used or expired) or failed.
-- reauthorize_by       when the refresh token ends (a non-secret date): after it the seller authorizes again.
-- The row still holds no token and no provider message. Owners and admins start and finish an authorization; the worker records its outcome (a column grant, as for the test and the poll).
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_finance.marketplace_connection
  ADD COLUMN IF NOT EXISTS app_key text,
  ADD COLUMN IF NOT EXISTS authorize_state text,
  ADD COLUMN IF NOT EXISTS authorize_state_hash text,
  ADD COLUMN IF NOT EXISTS authorize_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS authorize_by uuid,
  ADD COLUMN IF NOT EXISTS authorize_code_key_id text,
  ADD COLUMN IF NOT EXISTS authorize_code_envelope text,
  ADD COLUMN IF NOT EXISTS reauthorize_by timestamptz;

ALTER TABLE crove_finance.marketplace_connection DROP CONSTRAINT IF EXISTS marketplace_connection_app_key_ck;
ALTER TABLE crove_finance.marketplace_connection ADD CONSTRAINT marketplace_connection_app_key_ck CHECK (app_key IS NULL OR app_key ~ '^[!-~]{1,100}$');
ALTER TABLE crove_finance.marketplace_connection DROP CONSTRAINT IF EXISTS marketplace_connection_authorize_state_ck;
ALTER TABLE crove_finance.marketplace_connection ADD CONSTRAINT marketplace_connection_authorize_state_ck CHECK (authorize_state IS NULL OR authorize_state IN ('pending', 'authorized', 'refused', 'failed'));
ALTER TABLE crove_finance.marketplace_connection DROP CONSTRAINT IF EXISTS marketplace_connection_authorize_hash_ck;
ALTER TABLE crove_finance.marketplace_connection ADD CONSTRAINT marketplace_connection_authorize_hash_ck
  CHECK ((authorize_state_hash IS NULL) = (authorize_expires_at IS NULL) AND (authorize_state_hash IS NULL OR authorize_state_hash ~ '^sha256:[0-9a-f]{64}$'));
ALTER TABLE crove_finance.marketplace_connection DROP CONSTRAINT IF EXISTS marketplace_connection_authorize_code_ck;
ALTER TABLE crove_finance.marketplace_connection ADD CONSTRAINT marketplace_connection_authorize_code_ck
  CHECK ((authorize_code_key_id IS NULL) = (authorize_code_envelope IS NULL)
    AND (authorize_code_envelope IS NULL OR pg_catalog.length(authorize_code_envelope) <= 8000)
    AND (authorize_code_key_id IS NULL OR pg_catalog.length(authorize_code_key_id) <= 64)
    AND (authorize_state IS DISTINCT FROM 'pending' OR authorize_code_envelope IS NOT NULL));
-- The member who started it; the member's removal clears only this column.
ALTER TABLE crove_finance.marketplace_connection DROP CONSTRAINT IF EXISTS marketplace_connection_authorize_member_fk;
ALTER TABLE crove_finance.marketplace_connection ADD CONSTRAINT marketplace_connection_authorize_member_fk
  FOREIGN KEY (org_id, authorize_by) REFERENCES crove_kernel.tenant_member (org_id, user_id) ON DELETE SET NULL (authorize_by);
CREATE INDEX IF NOT EXISTS marketplace_connection_authorize_by_idx ON crove_finance.marketplace_connection (org_id, authorize_by) WHERE authorize_by IS NOT NULL;
-- The callback finds its connection by the hash of the state: one pending authorization per hash.
CREATE UNIQUE INDEX IF NOT EXISTS marketplace_connection_authorize_hash_uq ON crove_finance.marketplace_connection (org_id, authorize_state_hash) WHERE authorize_state_hash IS NOT NULL;

GRANT UPDATE (app_key, authorize_state, authorize_state_hash, authorize_expires_at, authorize_by, authorize_code_key_id, authorize_code_envelope, reauthorize_by)
  ON crove_finance.marketplace_connection TO crove_tenant;
