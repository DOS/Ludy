-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove Ads W0a (issue #2294, plan docs/plan/ads-write.md sections 3.3, 3.6 and 5.1, ADR-0043): the switches and the spend caps
-- of running ads. Nothing here calls a platform and nothing spends. Idempotent; applied files stay untouched.
--
-- crove_ads.ad_org_setting  the org's one row of switches (UNIQUE (org_id)): `write_enabled` (an owner turns ad writing on for the org, R3, off
--                           by default) and `launches_blocked` (the kill switch's flag: while set, every launch, activation
--                           and resume is refused, and only an owner clears it). Org-wide, so it names no legal entity. Tenant
--                           roles update the two switches and who set them, nothing else, and delete nothing.
-- crove_ads.ad_spend_cap    a row per cap change of the org or of one ad account, in a period (daily, monthly) and a currency:
--                           the history, the latest row of each (scope, account, period) is the cap. Written once and never
--                           changed or deleted by a tenant role (an account's caps go with it). Org caps carry the org's
--                           currency, account caps the account's.
-- crove_ads.ad_account      gains `write_enabled`: an owner enables one account for running ads (R3, off by default), only
--                           where the org switch is on.
--
-- Neither new table names a legal entity: the caps and switches are the owners' and admins' to read and change, through
-- commands that check the role, and a member limited to one entity has no business with an org-wide cap.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_ads.ad_org_setting (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  write_enabled boolean NOT NULL DEFAULT false,
  launches_blocked boolean NOT NULL DEFAULT false,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  -- One row per org, enforced here: a second row could never diverge from the first.
  CONSTRAINT ad_org_setting_org_uq UNIQUE (org_id)
);
SELECT crove_kernel.apply_tenant_rls('crove_ads.ad_org_setting');
REVOKE UPDATE, DELETE ON crove_ads.ad_org_setting FROM crove_tenant;
GRANT UPDATE (write_enabled, launches_blocked, updated_by, updated_at) ON crove_ads.ad_org_setting TO crove_tenant;

CREATE TABLE IF NOT EXISTS crove_ads.ad_spend_cap (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  scope text NOT NULL CHECK (scope IN ('org', 'account')),
  ad_account_id uuid,
  period text NOT NULL CHECK (period IN ('daily', 'monthly')),
  -- A decimal in the currency's own units, above zero; arithmetic on it is decimal.js (AGENTS.md "Money").
  amount numeric NOT NULL CHECK (amount > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  set_by uuid NOT NULL,
  set_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  -- An org cap names no account, an account cap names one.
  CONSTRAINT ad_spend_cap_scope_ck CHECK ((scope = 'org') = (ad_account_id IS NULL)),
  CONSTRAINT ad_spend_cap_account_fk FOREIGN KEY (org_id, ad_account_id) REFERENCES crove_ads.ad_account (org_id, id) ON DELETE CASCADE
);
-- The current cap of each (scope, account, period) is its latest row; the foreign key's own index serves the account.
CREATE INDEX IF NOT EXISTS ad_spend_cap_account_idx ON crove_ads.ad_spend_cap (org_id, ad_account_id, period, set_at DESC);
CREATE INDEX IF NOT EXISTS ad_spend_cap_org_idx ON crove_ads.ad_spend_cap (org_id, scope, period, set_at DESC);
SELECT crove_kernel.apply_tenant_rls('crove_ads.ad_spend_cap');
REVOKE UPDATE, DELETE ON crove_ads.ad_spend_cap FROM crove_tenant;

ALTER TABLE crove_ads.ad_account ADD COLUMN IF NOT EXISTS write_enabled boolean NOT NULL DEFAULT false;
GRANT UPDATE (write_enabled) ON crove_ads.ad_account TO crove_tenant;

-- The owner-only guard of the switches, in the database as well as in the commands (the Platform PO's condition on #2294): what
-- opens the way to spend, a write switch turned on (the org's or an account's) or launches unblocked, is made by a signed-in owner
-- of the org alone; what only stops it, a switch turned off or launches blocked, by an owner or an admin. An agent, the system and
-- any context that is not a user are refused either way, whatever a command's own role check says, so a path that reaches the
-- table another way (a future command, a definer, raw SQL on a connection) cannot turn spending on. A change that touches
-- neither switch (the audit columns, a no-op update, a row made with both off) passes. Fires for every role, the table's owner
-- included.
CREATE OR REPLACE FUNCTION crove_ads.switch_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_actor text := crove_kernel.ctx_actor_type();
  v_user uuid := crove_kernel.ctx_user_id();
  v_role text;
  v_opens boolean;
  v_closes boolean;
BEGIN
  IF TG_TABLE_NAME = 'ad_org_setting' THEN
    v_opens := (NEW.write_enabled AND NOT COALESCE(OLD.write_enabled, false)) OR (COALESCE(OLD.launches_blocked, false) AND NOT NEW.launches_blocked);
    v_closes := (COALESCE(OLD.write_enabled, false) AND NOT NEW.write_enabled) OR (NEW.launches_blocked AND NOT COALESCE(OLD.launches_blocked, false));
  ELSE
    v_opens := NEW.write_enabled AND NOT COALESCE(OLD.write_enabled, false);
    v_closes := COALESCE(OLD.write_enabled, false) AND NOT NEW.write_enabled;
  END IF;
  IF NOT (v_opens OR v_closes) THEN
    RETURN NEW;
  END IF;
  IF v_actor IS DISTINCT FROM 'user' OR v_user IS NULL THEN
    RAISE EXCEPTION 'ADS_SWITCH_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  SELECT m.role INTO v_role FROM crove_kernel.tenant_member m WHERE m.org_id = NEW.org_id AND m.user_id = v_user;
  IF v_role IS NULL OR (v_opens AND v_role <> 'owner') OR (v_closes AND v_role NOT IN ('owner', 'admin')) THEN
    RAISE EXCEPTION 'ADS_SWITCH_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_ads.switch_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

DROP TRIGGER IF EXISTS switch_guard ON crove_ads.ad_org_setting;
CREATE TRIGGER switch_guard BEFORE INSERT OR UPDATE ON crove_ads.ad_org_setting FOR EACH ROW EXECUTE FUNCTION crove_ads.switch_guard();
ALTER TABLE crove_ads.ad_org_setting ENABLE ALWAYS TRIGGER switch_guard;
DROP TRIGGER IF EXISTS switch_guard ON crove_ads.ad_account;
CREATE TRIGGER switch_guard BEFORE UPDATE OF write_enabled ON crove_ads.ad_account FOR EACH ROW EXECUTE FUNCTION crove_ads.switch_guard();
ALTER TABLE crove_ads.ad_account ENABLE ALWAYS TRIGGER switch_guard;
