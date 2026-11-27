-- SPDX-License-Identifier: AGPL-3.0-only
-- Per-member "Da xem" (seen) acknowledgements for SG1 contact "Can chu y" items (#4993).
-- Holds only IDs, kind, and timestamps (never customer or deal prose). Read/write is restricted
-- to the owning human org member; viewers cannot insert/update, and system/agent contexts reach none.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS ludy_crm.party_attention_seen (
  org_id uuid NOT NULL REFERENCES ludy_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT ludy_kernel.uuid_v7(),
  user_id uuid NOT NULL,
  party_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('quote_viewed', 'quote_expiring', 'quote_unanswered', 'customer_replied')),
  target_id uuid NOT NULL,
  seen_event_at timestamptz NOT NULL,
  seen_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT party_attention_seen_member_fk
    FOREIGN KEY (org_id, user_id) REFERENCES ludy_kernel.tenant_member (org_id, user_id) ON DELETE CASCADE,
  CONSTRAINT party_attention_seen_party_fk
    FOREIGN KEY (org_id, party_id) REFERENCES ludy_kernel.party (org_id, id) ON DELETE CASCADE,
  CONSTRAINT party_attention_seen_uq UNIQUE (org_id, user_id, party_id, kind, target_id)
);

-- Supports party_attention_seen_party_fk lookups/cascade; party_attention_seen_uq covers (org_id, user_id, ...).
CREATE INDEX IF NOT EXISTS party_attention_seen_party_idx
  ON ludy_crm.party_attention_seen (org_id, party_id);

CREATE OR REPLACE FUNCTION ludy_crm.party_attention_seen_monotonic()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.seen_event_at < OLD.seen_event_at THEN
    RAISE EXCEPTION 'ATTENTION_SEEN_EVENT_REGRESSION' USING ERRCODE = '22000';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ludy_crm.party_attention_seen_monotonic()
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;

DROP TRIGGER IF EXISTS party_attention_seen_monotonic ON ludy_crm.party_attention_seen;
CREATE TRIGGER party_attention_seen_monotonic
  BEFORE UPDATE ON ludy_crm.party_attention_seen
  FOR EACH ROW EXECUTE FUNCTION ludy_crm.party_attention_seen_monotonic();

SELECT ludy_kernel.apply_tenant_rls('ludy_crm.party_attention_seen');
REVOKE ALL ON TABLE ludy_crm.party_attention_seen
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT SELECT, INSERT ON TABLE ludy_crm.party_attention_seen TO ludy_tenant;
GRANT UPDATE (seen_event_at, seen_at) ON TABLE ludy_crm.party_attention_seen TO ludy_tenant;

DROP POLICY IF EXISTS party_attention_seen_select ON ludy_crm.party_attention_seen;
CREATE POLICY party_attention_seen_select ON ludy_crm.party_attention_seen
  AS RESTRICTIVE FOR SELECT TO ludy_tenant
  USING (
    ludy_kernel.ctx_actor_type() = 'user'
    AND user_id = (SELECT ludy_kernel.ctx_user_id())
  );

DROP POLICY IF EXISTS party_attention_seen_insert ON ludy_crm.party_attention_seen;
CREATE POLICY party_attention_seen_insert ON ludy_crm.party_attention_seen
  AS RESTRICTIVE FOR INSERT TO ludy_tenant
  WITH CHECK (
    ludy_kernel.ctx_actor_type() = 'user'
    AND user_id = (SELECT ludy_kernel.ctx_user_id())
    AND EXISTS (
      SELECT 1 FROM ludy_kernel.tenant_member m
      WHERE m.org_id = party_attention_seen.org_id
        AND m.user_id = (SELECT ludy_kernel.ctx_user_id())
        AND m.role IN ('owner', 'admin', 'member')
    )
  );

DROP POLICY IF EXISTS party_attention_seen_update ON ludy_crm.party_attention_seen;
CREATE POLICY party_attention_seen_update ON ludy_crm.party_attention_seen
  AS RESTRICTIVE FOR UPDATE TO ludy_tenant
  USING (
    ludy_kernel.ctx_actor_type() = 'user'
    AND user_id = (SELECT ludy_kernel.ctx_user_id())
    AND EXISTS (
      SELECT 1 FROM ludy_kernel.tenant_member m
      WHERE m.org_id = party_attention_seen.org_id
        AND m.user_id = (SELECT ludy_kernel.ctx_user_id())
        AND m.role IN ('owner', 'admin', 'member')
    )
  )
  WITH CHECK (
    ludy_kernel.ctx_actor_type() = 'user'
    AND user_id = (SELECT ludy_kernel.ctx_user_id())
    AND EXISTS (
      SELECT 1 FROM ludy_kernel.tenant_member m
      WHERE m.org_id = party_attention_seen.org_id
        AND m.user_id = (SELECT ludy_kernel.ctx_user_id())
        AND m.role IN ('owner', 'admin', 'member')
    )
  );

DROP POLICY IF EXISTS party_attention_seen_delete ON ludy_crm.party_attention_seen;
CREATE POLICY party_attention_seen_delete ON ludy_crm.party_attention_seen
  AS RESTRICTIVE FOR DELETE TO ludy_tenant
  USING (false);
