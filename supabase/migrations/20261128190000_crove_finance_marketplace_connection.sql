-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #2519, ADR-0045 point 7, plan stock-and-marketplaces.md section 8.7): an org's connection to a marketplace. Idempotent; applied files stay
-- untouched.
--
-- marketplace_connection   one row per connected marketplace account: the channel connection that holds the sealed credential (crove_kernel.channel_connection and
--                          crove_kernel.credential, ADR-0025: provider `marketplace_<adapter>`, one per org and platform account), the platform it reads, the legal
--                          entity it imports for, the result of the last connection test as a state, and the poll's progress (the cursor of the last page it read, when,
--                          and how it ended). The row holds no credential, no provider message and no buyer data.
--                          Every member of the entity reads it; owners and admins connect, test, poll and disconnect.
--
-- A tenant role updates only the last test and the poll's progress (a column grant); the entity, the channel connection, the provider and the platform are fixed for the
-- row's life. A disconnect revokes the channel connection (which drops the credential) and deletes this row; a reconnect is a new channel connection and a new row.
-- The poll never confirms an order: what it reads is staged like an uploaded file and a member confirms it (plan section 8.7).
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_finance.marketplace_connection (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  legal_entity_id uuid NOT NULL,
  channel_connection_id uuid NOT NULL,
  -- The channel layer's provider id: `marketplace_` and the adapter (`marketplace_sandbox`); it equals the channel connection's.
  provider text NOT NULL CHECK (provider ~ '^marketplace_[a-z][a-z0-9_]{0,21}$'),
  platform text NOT NULL CHECK (platform IN ('shopee', 'tiktok_shop', 'lazada')),
  last_test_state text CHECK (last_test_state IN ('works', 'wrong_credentials', 'api_not_enabled', 'ip_not_allowed', 'unreachable')),
  last_tested_at timestamptz,
  -- Where the next poll resumes (an opaque position the adapter handed back; never a credential).
  poll_cursor text CHECK (pg_catalog.length(poll_cursor) <= 200),
  last_polled_at timestamptz,
  last_poll_state text CHECK (last_poll_state IN ('ok', 'unreachable', 'credentials', 'rate_limited', 'too_large', 'not_recognized')),
  -- Not written by anything: what waits in the Inbox is counted when the list is read (the staged files of this connection), so a confirm or a reject lowers it. Kept at 0.
  orders_waiting integer NOT NULL DEFAULT 0 CHECK (orders_waiting >= 0),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT marketplace_connection_test_ck CHECK ((last_test_state IS NULL) = (last_tested_at IS NULL)),
  CONSTRAINT marketplace_connection_channel_uq UNIQUE (org_id, channel_connection_id),
  -- One connection per entity, adapter and platform.
  CONSTRAINT marketplace_connection_account_uq UNIQUE (org_id, legal_entity_id, provider, platform),
  CONSTRAINT marketplace_connection_entity_fk FOREIGN KEY (org_id, legal_entity_id) REFERENCES crove_kernel.legal_entity (org_id, id),
  CONSTRAINT marketplace_connection_channel_fk FOREIGN KEY (org_id, channel_connection_id) REFERENCES crove_kernel.channel_connection (org_id, id),
  CONSTRAINT marketplace_connection_member_fk FOREIGN KEY (org_id, created_by) REFERENCES crove_kernel.tenant_member (org_id, user_id) ON DELETE SET NULL (created_by)
);
CREATE INDEX IF NOT EXISTS marketplace_connection_entity_idx ON crove_finance.marketplace_connection (legal_entity_id, org_id);
CREATE INDEX IF NOT EXISTS marketplace_connection_created_by_idx ON crove_finance.marketplace_connection (org_id, created_by) WHERE created_by IS NOT NULL;
SELECT crove_kernel.apply_tenant_rls('crove_finance.marketplace_connection');
REVOKE UPDATE ON crove_finance.marketplace_connection FROM crove_tenant;
GRANT UPDATE (last_test_state, last_tested_at, poll_cursor, last_polled_at, last_poll_state) ON crove_finance.marketplace_connection TO crove_tenant;
DROP TRIGGER IF EXISTS b_legal_entity ON crove_finance.marketplace_connection;
CREATE TRIGGER b_legal_entity BEFORE INSERT OR UPDATE OF legal_entity_id ON crove_finance.marketplace_connection
  FOR EACH ROW EXECUTE FUNCTION crove_finance.legal_entity_fill();
ALTER TABLE crove_finance.marketplace_connection ENABLE ALWAYS TRIGGER b_legal_entity;
DROP POLICY IF EXISTS le_scope ON crove_finance.marketplace_connection;
CREATE POLICY le_scope ON crove_finance.marketplace_connection AS RESTRICTIVE FOR ALL TO crove_tenant
  USING ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]))
  WITH CHECK ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]));
-- Owners and admins write (the same people who may connect a channel); every member reads. The system context writes too (the poll job records its progress, and the
-- matrix's own-org control), never another org's rows.
DROP POLICY IF EXISTS marketplace_connection_insert ON crove_finance.marketplace_connection;
CREATE POLICY marketplace_connection_insert ON crove_finance.marketplace_connection AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = marketplace_connection.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin')));
DROP POLICY IF EXISTS marketplace_connection_update ON crove_finance.marketplace_connection;
CREATE POLICY marketplace_connection_update ON crove_finance.marketplace_connection AS RESTRICTIVE FOR UPDATE TO crove_tenant
  USING ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = marketplace_connection.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin')))
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = marketplace_connection.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin')));
DROP POLICY IF EXISTS marketplace_connection_delete ON crove_finance.marketplace_connection;
CREATE POLICY marketplace_connection_delete ON crove_finance.marketplace_connection AS RESTRICTIVE FOR DELETE TO crove_tenant
  USING ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = marketplace_connection.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin')));

-- The row's provider is its channel connection's: a connection cannot be filed under another provider than the one that holds the credential. Runs as the writer, which
-- reads the channel connection through its own policies: a row it cannot see is left to the foreign keys and the policies.
CREATE OR REPLACE FUNCTION crove_finance.marketplace_connection_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM crove_kernel.channel_connection c WHERE c.org_id = NEW.org_id AND c.id = NEW.channel_connection_id AND c.provider <> NEW.provider) THEN
    RAISE EXCEPTION 'MARKETPLACE_CONNECTION_PROVIDER' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_finance.marketplace_connection_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
DROP TRIGGER IF EXISTS marketplace_connection_guard ON crove_finance.marketplace_connection;
CREATE TRIGGER marketplace_connection_guard BEFORE INSERT ON crove_finance.marketplace_connection
  FOR EACH ROW EXECUTE FUNCTION crove_finance.marketplace_connection_guard();
