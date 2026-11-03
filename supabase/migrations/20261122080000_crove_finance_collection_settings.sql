-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #2488, slice 3): what the org sets for its payment reminders ("nhắc thu nợ"). Idempotent; applied files
-- stay untouched.
--
-- collection_setting    the org's one row (UNIQUE (org_id)): terms_days, the days after an invoice date at which a sale falls
--                       due (30 until a row says otherwise, as the code assumed so far), and weekly_item, the switch of a
--                       weekly "Hôm nay cần bạn" item that says how many customers are overdue (off by default; it only adds an
--                       item, it never drafts or sends anything). Org-wide: no legal entity, as the org's other settings.
--                       Every member of the org reads it; only an owner or admin, or the system, writes it.
--
-- customer_collection   what the org set for one customer (UNIQUE (org_id, party_id)): its own terms_days (NULL: the org's), and
--                       paused_until, a date until which no reminder is drafted for it (NULL: not paused). Org-wide as party
--                       is: a customer is one party across the entities. Every member reads it; an owner, admin or member, or
--                       the system, writes it (the roles that may send a reminder). A party removed from the books takes its
--                       row with it.
--
-- Neither table holds a name, an address, an email or an account number: a party id, small numbers and a date. Tenant roles
-- update the value columns, who set them and when (a column grant), and delete nothing: a row is changed, never removed (the
-- org's purge and a party's removal clear them). Writes go through two audited commands (finance.collection_setting.set and
-- finance.customer_collection.set); nothing in the database sends a mail.
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. The org's settings
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_finance.collection_setting (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  terms_days smallint NOT NULL DEFAULT 30 CHECK (terms_days BETWEEN 1 AND 365),
  weekly_item boolean NOT NULL DEFAULT false,
  set_by uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT collection_setting_org_uq UNIQUE (org_id),
  CONSTRAINT collection_setting_member_fk FOREIGN KEY (org_id, set_by) REFERENCES crove_kernel.tenant_member (org_id, user_id) ON DELETE SET NULL (set_by)
);
CREATE INDEX IF NOT EXISTS collection_setting_set_by_idx ON crove_finance.collection_setting (org_id, set_by) WHERE set_by IS NOT NULL;
SELECT crove_kernel.apply_tenant_rls('crove_finance.collection_setting');
REVOKE UPDATE, DELETE ON crove_finance.collection_setting FROM crove_tenant;
GRANT UPDATE (terms_days, weekly_item, set_by, updated_at) ON crove_finance.collection_setting TO crove_tenant;
DROP POLICY IF EXISTS collection_setting_insert ON crove_finance.collection_setting;
CREATE POLICY collection_setting_insert ON crove_finance.collection_setting AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = collection_setting.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin')));
DROP POLICY IF EXISTS collection_setting_update ON crove_finance.collection_setting;
CREATE POLICY collection_setting_update ON crove_finance.collection_setting AS RESTRICTIVE FOR UPDATE TO crove_tenant
  USING ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = collection_setting.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin')))
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = collection_setting.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin')));

-- ---------------------------------------------------------------------------
-- 2. What the org set for one customer
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_finance.customer_collection (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  party_id uuid NOT NULL,
  -- The customer's own payment terms; NULL takes the org's.
  terms_days smallint CHECK (terms_days IS NULL OR terms_days BETWEEN 1 AND 365),
  -- No reminder is drafted for the customer up to and including this date; NULL: not paused.
  paused_until date,
  set_by uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT customer_collection_party_uq UNIQUE (org_id, party_id),
  -- A party removed from the books takes its row with it.
  CONSTRAINT customer_collection_party_fk FOREIGN KEY (org_id, party_id) REFERENCES crove_kernel.party (org_id, id) ON DELETE CASCADE,
  CONSTRAINT customer_collection_member_fk FOREIGN KEY (org_id, set_by) REFERENCES crove_kernel.tenant_member (org_id, user_id) ON DELETE SET NULL (set_by)
);
CREATE INDEX IF NOT EXISTS customer_collection_set_by_idx ON crove_finance.customer_collection (org_id, set_by) WHERE set_by IS NOT NULL;
SELECT crove_kernel.apply_tenant_rls('crove_finance.customer_collection');
REVOKE UPDATE, DELETE ON crove_finance.customer_collection FROM crove_tenant;
GRANT UPDATE (terms_days, paused_until, set_by, updated_at) ON crove_finance.customer_collection TO crove_tenant;
DROP POLICY IF EXISTS customer_collection_insert ON crove_finance.customer_collection;
CREATE POLICY customer_collection_insert ON crove_finance.customer_collection AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = customer_collection.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member')));
DROP POLICY IF EXISTS customer_collection_update ON crove_finance.customer_collection;
CREATE POLICY customer_collection_update ON crove_finance.customer_collection AS RESTRICTIVE FOR UPDATE TO crove_tenant
  USING ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = customer_collection.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member')))
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = customer_collection.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member')));
