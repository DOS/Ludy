-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove Ads W0a-1 (issue #2294, plan docs/plan/ads-write.md sections 3.3, 3.6 and 5.1, ADR-0043): the switches and the spend caps
-- of running ads, and the database's guard of both. Nothing here calls a platform and nothing spends. Idempotent; applied files
-- stay untouched.
--
-- crove_ads.ad_org_setting  the org's one row of switches (UNIQUE (org_id)): `write_enabled` (writing on for the org, off by
--                           default; turning it on is a proposal's effect, ADR-0043 point 1) and `launches_blocked` (the kill
--                           switch's flag: while set, every launch, activation and resume is refused, and only an owner clears
--                           it). Org-wide, so it names no legal entity. Tenant roles update the two switches and who set them,
--                           nothing else, and delete nothing.
-- crove_ads.ad_spend_cap    a row per cap change of the org or of one ad account, in a period (daily, monthly) and a currency:
--                           the history, the latest row of each (scope, account, period) is the cap. Written once and never
--                           changed or deleted by a tenant role (an account's caps go with it). Each cap carries its own currency.
-- crove_ads.ad_account      gains `write_enabled`: one account enabled for running ads (off by default).
--
-- Neither new table names a legal entity: the caps and switches are the owners' and admins' to read, and an owner's to open, and
-- a member limited to one entity has no business with an org-wide cap.
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

-- The second way through the guards below: the execution of an approved proposal for the command that makes the change (the
-- Platform PO's design point on #2294: under Q2 an admin may approve, so the guards accept exactly two things, a signed-in owner
-- and an approved proposal's execution, never a plain admin or member context). Stubbed CLOSED in W0a-1: it answers false for
-- every command, so only a signed-in owner passes. W0a-2 replaces the body with the approval gate's marker (the same one
-- `proposal_approval_decide` and the executing command read), whatever the executing context is, with tests both ways. No login
-- role can call it; the guards are definers of the same owner.
CREATE OR REPLACE FUNCTION crove_ads.approved_execution(p_command text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ SELECT false $$;
REVOKE ALL ON FUNCTION crove_ads.approved_execution(text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- The guard of the switches, in the database as well as in the commands (the Platform PO's conditions on #2294): what opens the
-- way to spend, a write switch turned on (the org's or an account's, on a new row or an old one) or launches unblocked, is made by
-- a signed-in owner of the org or by the execution of the approved proposal of its own command (approved_execution, closed for
-- now); what only stops it, a switch turned off or launches blocked, by an owner or an admin. An agent, the system and any context
-- that is not a user are refused either way, whatever a command's own role check says, so a path that reaches the table another
-- way (a future command, a definer, raw SQL on a connection) cannot turn spending on. A change that touches neither switch (a
-- no-op update, a row made with both off) passes. Fires for every role, the table's owner included. On ad_org_setting the guard
-- also stamps who changed the row and when (updated_by, updated_at), whatever the writer sent, so the record of the switches
-- cannot be written by the one who flips them.
CREATE OR REPLACE FUNCTION crove_ads.switch_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_actor text := crove_kernel.ctx_actor_type();
  v_user uuid := crove_kernel.ctx_user_id();
  v_role text;
  v_open_commands text[] := ARRAY[]::text[];
  v_command text;
  v_closes boolean;
BEGIN
  IF TG_TABLE_NAME = 'ad_org_setting' THEN
    NEW.updated_by := CASE WHEN v_actor = 'user' THEN v_user END;
    NEW.updated_at := pg_catalog.clock_timestamp();
    IF NEW.write_enabled AND NOT COALESCE(OLD.write_enabled, false) THEN
      v_open_commands := pg_catalog.array_append(v_open_commands, 'ads.write.enable'::text);
    END IF;
    IF COALESCE(OLD.launches_blocked, false) AND NOT NEW.launches_blocked THEN
      v_open_commands := pg_catalog.array_append(v_open_commands, 'ads.launches.unblock'::text);
    END IF;
    v_closes := (COALESCE(OLD.write_enabled, false) AND NOT NEW.write_enabled) OR (NEW.launches_blocked AND NOT COALESCE(OLD.launches_blocked, false));
  ELSE
    IF NEW.write_enabled AND NOT COALESCE(OLD.write_enabled, false) THEN
      v_open_commands := pg_catalog.array_append(v_open_commands, 'ads.account.enable_write'::text);
    END IF;
    v_closes := COALESCE(OLD.write_enabled, false) AND NOT NEW.write_enabled;
  END IF;
  IF cardinality(v_open_commands) = 0 AND NOT v_closes THEN
    RETURN NEW;
  END IF;
  IF v_actor = 'user' AND v_user IS NOT NULL THEN
    SELECT m.role INTO v_role FROM crove_kernel.tenant_member m WHERE m.org_id = NEW.org_id AND m.user_id = v_user;
  END IF;
  -- A stop: an owner or an admin, signed in.
  IF v_closes AND v_role IS DISTINCT FROM 'owner' AND v_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'ADS_SWITCH_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  -- An opening: an owner, or else each opening needs the approved execution of its own command.
  IF v_role IS DISTINCT FROM 'owner' THEN
    FOREACH v_command IN ARRAY v_open_commands LOOP
      IF NOT crove_ads.approved_execution(v_command) THEN
        RAISE EXCEPTION 'ADS_SWITCH_FORBIDDEN' USING ERRCODE = '42501';
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_ads.switch_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

DROP TRIGGER IF EXISTS switch_guard ON crove_ads.ad_org_setting;
CREATE TRIGGER switch_guard BEFORE INSERT OR UPDATE ON crove_ads.ad_org_setting FOR EACH ROW EXECUTE FUNCTION crove_ads.switch_guard();
ALTER TABLE crove_ads.ad_org_setting ENABLE ALWAYS TRIGGER switch_guard;
-- On the account too, on a row made as well as on one changed: a row born with write_enabled on is as much an opening.
DROP TRIGGER IF EXISTS switch_guard ON crove_ads.ad_account;
CREATE TRIGGER switch_guard BEFORE INSERT OR UPDATE OF write_enabled ON crove_ads.ad_account FOR EACH ROW EXECUTE FUNCTION crove_ads.switch_guard();
ALTER TABLE crove_ads.ad_account ENABLE ALWAYS TRIGGER switch_guard;

-- The guard of the caps: a cap row is inserted by a signed-in owner of the org or by the execution of an approved `ads.cap.set`
-- proposal (approved_execution, closed for now); an agent, the system, an admin and a member are refused otherwise. Its id, who
-- set it and when are stamped here, whatever the writer sent: "the latest cap" is the newest id, and an id a writer could choose
-- (a uuid v7 with a time far ahead) would stay the cap for good. Who set it is the signed-in user of the context; an approved
-- execution in a context with no user keeps the writer's `set_by` (the command's handler, which names the approver). A row of
-- another org is left to row security, which refuses it. Fires for every role, the table's owner included.
CREATE OR REPLACE FUNCTION crove_ads.cap_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_user uuid := CASE WHEN crove_kernel.ctx_actor_type() = 'user' THEN crove_kernel.ctx_user_id() END;
  v_role text;
BEGIN
  IF NEW.org_id IS DISTINCT FROM crove_kernel.ctx_org_id() THEN
    RETURN NEW;
  END IF;
  IF v_user IS NOT NULL THEN
    SELECT m.role INTO v_role FROM crove_kernel.tenant_member m WHERE m.org_id = NEW.org_id AND m.user_id = v_user;
  END IF;
  IF v_role IS DISTINCT FROM 'owner' AND NOT crove_ads.approved_execution('ads.cap.set') THEN
    RAISE EXCEPTION 'ADS_CAP_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  NEW.id := crove_kernel.uuid_v7();
  NEW.set_by := COALESCE(v_user, NEW.set_by);
  NEW.set_at := pg_catalog.clock_timestamp();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_ads.cap_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

DROP TRIGGER IF EXISTS cap_guard ON crove_ads.ad_spend_cap;
CREATE TRIGGER cap_guard BEFORE INSERT ON crove_ads.ad_spend_cap FOR EACH ROW EXECUTE FUNCTION crove_ads.cap_guard();
ALTER TABLE crove_ads.ad_spend_cap ENABLE ALWAYS TRIGGER cap_guard;
