-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #3875, S2 of #3854; plan accounting-software-sync.md step 4): an entity's connection to MISA AMIS Kế toán. Idempotent; applied files stay untouched.
--
-- misa_amis_connection   one row per legal entity: the channel connection that holds the sealed access code (crove_kernel.channel_connection and crove_kernel.credential,
--                        ADR-0025: provider `accounting_misa_amis`), the legal entity it pushes for, and the opaque code Ludy gave this connection's data in AMIS
--                        (org_company_code, the free code the token call carries and the callback names). The row holds no credential: the access code lives only in the
--                        channel layer, is never returned after it is saved, and is dropped when the connection is closed. Every member of the entity reads the row; owners and
--                        admins connect and disconnect.
--
-- A tenant role updates only the result of the last connection test (a column grant; the test itself is a later slice's worker job); the entity, the channel connection and the code are
-- fixed for the row's life. A disconnect revokes the channel connection (which drops the credential) and deletes this row; a reconnect is a new channel connection, a new row and a new code.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_finance.misa_amis_connection (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  legal_entity_id uuid NOT NULL,
  channel_connection_id uuid NOT NULL,
  -- What AMIS is told is this customer's code and what the callback of a later slice finds the organisation by: random, unique across the deployment, and not a secret that opens anything.
  org_company_code text NOT NULL DEFAULT ('ludy-' || pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '')) CHECK (org_company_code ~ '^ludy-[0-9a-f]{32}$'),
  -- What a connection test came back with, as a state and never MISA's own text.
  last_test_state text CHECK (last_test_state IN ('works', 'wrong_credentials', 'unreachable')),
  last_tested_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT misa_amis_connection_test_ck CHECK ((last_test_state IS NULL) = (last_tested_at IS NULL)),
  CONSTRAINT misa_amis_connection_channel_uq UNIQUE (org_id, channel_connection_id),
  -- One connection per entity.
  CONSTRAINT misa_amis_connection_entity_uq UNIQUE (org_id, legal_entity_id),
  CONSTRAINT misa_amis_connection_code_uq UNIQUE (org_company_code),
  CONSTRAINT misa_amis_connection_entity_fk FOREIGN KEY (org_id, legal_entity_id) REFERENCES crove_kernel.legal_entity (org_id, id),
  CONSTRAINT misa_amis_connection_channel_fk FOREIGN KEY (org_id, channel_connection_id) REFERENCES crove_kernel.channel_connection (org_id, id),
  CONSTRAINT misa_amis_connection_member_fk FOREIGN KEY (org_id, created_by) REFERENCES crove_kernel.tenant_member (org_id, user_id) ON DELETE SET NULL (created_by)
);
CREATE INDEX IF NOT EXISTS misa_amis_connection_created_by_idx ON crove_finance.misa_amis_connection (org_id, created_by) WHERE created_by IS NOT NULL;
SELECT crove_kernel.apply_tenant_rls('crove_finance.misa_amis_connection');
REVOKE UPDATE ON crove_finance.misa_amis_connection FROM crove_tenant;
GRANT UPDATE (last_test_state, last_tested_at) ON crove_finance.misa_amis_connection TO crove_tenant;
DROP TRIGGER IF EXISTS b_legal_entity ON crove_finance.misa_amis_connection;
CREATE TRIGGER b_legal_entity BEFORE INSERT OR UPDATE OF legal_entity_id ON crove_finance.misa_amis_connection
  FOR EACH ROW EXECUTE FUNCTION crove_finance.legal_entity_fill();
ALTER TABLE crove_finance.misa_amis_connection ENABLE ALWAYS TRIGGER b_legal_entity;
DROP POLICY IF EXISTS le_scope ON crove_finance.misa_amis_connection;
CREATE POLICY le_scope ON crove_finance.misa_amis_connection AS RESTRICTIVE FOR ALL TO crove_tenant
  USING ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]))
  WITH CHECK ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]));
-- Owners and admins write (the same people who may connect a channel); every member reads. The system context writes too (the matrix's own-org control and the later
-- slices' jobs), never another org's rows.
DROP POLICY IF EXISTS misa_amis_connection_insert ON crove_finance.misa_amis_connection;
CREATE POLICY misa_amis_connection_insert ON crove_finance.misa_amis_connection AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = misa_amis_connection.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin')));
DROP POLICY IF EXISTS misa_amis_connection_update ON crove_finance.misa_amis_connection;
CREATE POLICY misa_amis_connection_update ON crove_finance.misa_amis_connection AS RESTRICTIVE FOR UPDATE TO crove_tenant
  USING ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = misa_amis_connection.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin')))
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = misa_amis_connection.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin')));
DROP POLICY IF EXISTS misa_amis_connection_delete ON crove_finance.misa_amis_connection;
CREATE POLICY misa_amis_connection_delete ON crove_finance.misa_amis_connection AS RESTRICTIVE FOR DELETE TO crove_tenant
  USING ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = misa_amis_connection.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin')));

-- The row's channel connection is the AMIS one: a connection cannot be filed on a channel of another provider than the one that holds this credential. Runs as the writer,
-- which reads the channel connection through its own policies: a row it cannot see is left to the foreign keys and the policies.
-- A tenant role never types the company code (the callback of a later slice finds the organisation by it) nor the result of a connection test (only a test writes that): whatever such a writer
-- gives for them is replaced by a fresh code and no result. The RLS matrix refuses column-level INSERT grants, so this is a trigger; a superuser (a restore) and the table's owner keep what they write.
CREATE OR REPLACE FUNCTION crove_finance.misa_amis_connection_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF pg_catalog.pg_has_role(current_user, 'crove_tenant', 'MEMBER')
     AND NOT (SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user) THEN
    NEW.org_company_code := 'ludy-' || pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '');
    NEW.last_test_state := NULL;
    NEW.last_tested_at := NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM crove_kernel.channel_connection c WHERE c.org_id = NEW.org_id AND c.id = NEW.channel_connection_id AND c.provider <> 'accounting_misa_amis') THEN
    RAISE EXCEPTION 'MISA_AMIS_CONNECTION_PROVIDER' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_finance.misa_amis_connection_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
DROP TRIGGER IF EXISTS misa_amis_connection_guard ON crove_finance.misa_amis_connection;
CREATE TRIGGER misa_amis_connection_guard BEFORE INSERT ON crove_finance.misa_amis_connection
  FOR EACH ROW EXECUTE FUNCTION crove_finance.misa_amis_connection_guard();
