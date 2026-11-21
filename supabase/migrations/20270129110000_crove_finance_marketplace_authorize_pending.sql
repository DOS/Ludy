-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #4238, Lazada S2b): when a seller's authorization became pending. Idempotent; applied files stay untouched.
--
-- A one-time code waits for the worker as `authorize_state = 'pending'`. If the worker dies before it records an outcome, nothing would ever clear it. authorize_pending_at is the time the code was stored: a
-- pending authorization older than the window the finance module keeps (15 minutes) counts as failed everywhere (the list, the worker's target, the command that completes it), so the seller sees a failure
-- and authorizes again. Set by authorize_finish and cleared with the code; a pending state always has it.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_finance.marketplace_connection ADD COLUMN IF NOT EXISTS authorize_pending_at timestamptz;
ALTER TABLE crove_finance.marketplace_connection DROP CONSTRAINT IF EXISTS marketplace_connection_authorize_pending_ck;
ALTER TABLE crove_finance.marketplace_connection ADD CONSTRAINT marketplace_connection_authorize_pending_ck
  CHECK (authorize_state IS DISTINCT FROM 'pending' OR authorize_pending_at IS NOT NULL) NOT VALID;
GRANT UPDATE (authorize_pending_at) ON crove_finance.marketplace_connection TO crove_tenant;
