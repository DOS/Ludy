-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #2516, ADR-0045 point 6, plan stock-and-marketplaces.md section 8.4): the platform as the counterparty of account 131. Idempotent; applied files stay
-- untouched.
--
-- marketplace_party   links one legal entity's marketplace platform (`shopee`, `tiktok_shop`, ...) to an ordinary organization party (crove_kernel.party, kind `organization`).
--                     The settlement entry's Dr 131 line names that party. One link per entity and platform; a party is linked once. The row holds only the link: no
--                     credential, no provider message, no buyer data.
--
-- Why a table and not a party kind: the party kinds are `organization` and `person`; a `marketplace` kind would widen a shared-core CHECK and every contact screen that lists the kinds.
-- Every member of the entity reads the links; the command that first posts a settlement of a platform creates the party and the link (a later slice). Tenant roles read and insert;
-- nothing updates or deletes a row (a platform's party stays the counterparty of the entries that named it).
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_finance.marketplace_party (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  legal_entity_id uuid NOT NULL,
  -- The platform's id as the staged reports name it; a format, not a fixed list, so a new platform needs no migration.
  platform text NOT NULL CHECK (platform ~ '^[a-z][a-z0-9_]{1,30}$'),
  party_id uuid NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  -- One link per entity and platform; a party is the counterparty of one platform only.
  CONSTRAINT marketplace_party_platform_uq UNIQUE (org_id, legal_entity_id, platform),
  CONSTRAINT marketplace_party_party_uq UNIQUE (org_id, party_id),
  CONSTRAINT marketplace_party_entity_fk FOREIGN KEY (org_id, legal_entity_id) REFERENCES crove_kernel.legal_entity (org_id, id),
  CONSTRAINT marketplace_party_party_fk FOREIGN KEY (org_id, party_id) REFERENCES crove_kernel.party (org_id, id),
  CONSTRAINT marketplace_party_member_fk FOREIGN KEY (org_id, created_by) REFERENCES crove_kernel.tenant_member (org_id, user_id) ON DELETE SET NULL (created_by)
);
CREATE INDEX IF NOT EXISTS marketplace_party_entity_idx ON crove_finance.marketplace_party (legal_entity_id, org_id);
CREATE INDEX IF NOT EXISTS marketplace_party_created_by_idx ON crove_finance.marketplace_party (org_id, created_by) WHERE created_by IS NOT NULL;
SELECT crove_kernel.apply_tenant_rls('crove_finance.marketplace_party');
REVOKE UPDATE, DELETE ON crove_finance.marketplace_party FROM crove_tenant;
DROP TRIGGER IF EXISTS b_legal_entity ON crove_finance.marketplace_party;
CREATE TRIGGER b_legal_entity BEFORE INSERT OR UPDATE OF legal_entity_id ON crove_finance.marketplace_party
  FOR EACH ROW EXECUTE FUNCTION crove_finance.legal_entity_fill();
ALTER TABLE crove_finance.marketplace_party ENABLE ALWAYS TRIGGER b_legal_entity;
DROP POLICY IF EXISTS le_scope ON crove_finance.marketplace_party;
CREATE POLICY le_scope ON crove_finance.marketplace_party AS RESTRICTIVE FOR ALL TO crove_tenant
  USING ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]))
  WITH CHECK ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]));

-- The party a link names is an organization that is not merged into another: a person is never a platform. Runs as the writer, which reads the party through its own policies; a party it
-- cannot see is refused too (stricter than the foreign key alone).
CREATE OR REPLACE FUNCTION crove_finance.marketplace_party_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM crove_kernel.party p WHERE p.org_id = NEW.org_id AND p.id = NEW.party_id AND p.kind = 'organization' AND p.duplicate_of IS NULL) THEN
    RAISE EXCEPTION 'MARKETPLACE_PARTY_KIND' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_finance.marketplace_party_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
DROP TRIGGER IF EXISTS marketplace_party_guard ON crove_finance.marketplace_party;
CREATE TRIGGER marketplace_party_guard BEFORE INSERT OR UPDATE OF party_id ON crove_finance.marketplace_party
  FOR EACH ROW EXECUTE FUNCTION crove_finance.marketplace_party_guard();
ALTER TABLE crove_finance.marketplace_party ENABLE ALWAYS TRIGGER marketplace_party_guard;
