-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove kernel (issue #3313, ADR-0053 slice a of #3307): the apps an org's owner or admin turned off for their own
-- company. Idempotent; applied files stay untouched.
--
-- crove_kernel.tenant  apps_off      the module ids the org switched off, sorted, default empty: every app is on with no
--                                    setup, and a module shipped later is on for every org until someone turns it off;
--                      apps_version  starts at 1 and grows by one on every change.
--
-- Writes: only an owner or admin of the org, through the audited command kernel.org.set_app (R2). The
-- tenant_apps_guard and tenant_apps_requires_audit triggers refuse any other write, as tenant_approval_policy_guard and
-- tenant_approval_policy_requires_audit do for the approval preset. Staff (a superuser, or a role that can act as the
-- table's owner) may change the authorization, so a support fix is not locked out, but never the shape: kernel can not
-- be switched off, and an id is well formed, once and not NULL, for staff too.
--
-- crove_kernel.org_app_on(org, module) is the SQL half of the effective-set gate (ADR-0053 section 1): the sweeps, the
-- relay and the public pages that run without a tenant context ask it. It reads the org's choice only, not the
-- entitlement or the deployment's CROVE_MODULES, which the caller also asks. Nothing enforces it yet (slices b and c).
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_kernel.tenant ADD COLUMN IF NOT EXISTS apps_off text[] NOT NULL DEFAULT '{}';
ALTER TABLE crove_kernel.tenant ADD COLUMN IF NOT EXISTS apps_version integer NOT NULL DEFAULT 1;

DO $$
BEGIN
  ALTER TABLE crove_kernel.tenant ADD CONSTRAINT tenant_apps_version_check CHECK (apps_version >= 1);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- The row's choice is a well formed set: ids shaped like module ids, once each, never kernel. Run for staff as well.
CREATE OR REPLACE FUNCTION crove_kernel.tenant_apps_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_staff boolean;
BEGIN
  IF NEW.apps_off IS NULL
     OR pg_catalog.array_position(NEW.apps_off, NULL) IS NOT NULL
     OR pg_catalog.array_position(NEW.apps_off, 'kernel') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_catalog.unnest(NEW.apps_off) AS a(id) WHERE a.id !~ '^[a-z][a-z0-9_]{0,49}$')
     OR (SELECT pg_catalog.count(DISTINCT a.id) FROM pg_catalog.unnest(NEW.apps_off) AS a(id)) IS DISTINCT FROM pg_catalog.cardinality(NEW.apps_off) THEN
    RAISE EXCEPTION 'APPS_OFF_INVALID' USING ERRCODE = '23514',
      DETAIL = 'apps_off holds module ids shaped like [a-z][a-z0-9_]*, each once, and never kernel';
  END IF;
  IF TG_OP = 'INSERT' THEN
    -- Org creation inserts the tenant before its owner's membership exists: only the defaults pass.
    IF NEW.apps_off = '{}' AND NEW.apps_version = 1 THEN
      RETURN NEW;
    END IF;
  ELSIF NEW.apps_off IS NOT DISTINCT FROM OLD.apps_off
        AND NEW.apps_version IS NOT DISTINCT FROM OLD.apps_version THEN
    RETURN NEW;
  END IF;
  SELECT r.rolsuper
         OR pg_catalog.pg_has_role(r.oid, (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID), 'USAGE')
    INTO v_staff
  FROM pg_catalog.pg_roles r WHERE r.rolname = SESSION_USER;
  IF COALESCE(v_staff, false) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT'
     OR NEW.apps_version IS DISTINCT FROM OLD.apps_version + 1
     OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user'
     OR crove_kernel.ctx_org_id() IS DISTINCT FROM NEW.org_id
     OR NOT EXISTS (
       SELECT 1 FROM crove_kernel.tenant_member m
       WHERE m.org_id = NEW.org_id AND m.user_id = crove_kernel.ctx_user_id() AND m.role IN ('owner', 'admin')
     ) THEN
    RAISE EXCEPTION 'APPS_FORBIDDEN' USING ERRCODE = '42501',
      DETAIL = 'only kernel.org.set_app, run by an owner or admin of the org, changes the apps the org turned off';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tenant_apps_guard ON crove_kernel.tenant;
CREATE TRIGGER tenant_apps_guard BEFORE INSERT OR UPDATE OF apps_off, apps_version ON crove_kernel.tenant
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.tenant_apps_guard();

-- One commit changes the choice only with the command's own 'ok' audit row naming the module, its new state and the new
-- version, and the change is exactly that one module: no second app switched in the same write.
CREATE OR REPLACE FUNCTION crove_kernel.tenant_apps_requires_audit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_staff boolean;
BEGIN
  SELECT r.rolsuper
         OR pg_catalog.pg_has_role(r.oid, (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID), 'USAGE')
    INTO v_staff
  FROM pg_catalog.pg_roles r WHERE r.rolname = SESSION_USER;
  IF COALESCE(v_staff, false) THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM crove_kernel.audit_event a
    JOIN crove_kernel.tenant_member m ON m.org_id = a.org_id AND m.user_id = a.actor_id AND m.role IN ('owner', 'admin')
    WHERE a.org_id = NEW.org_id
      AND a.command = 'kernel.org.set_app'
      AND a.outcome = 'ok'
      AND a.actor_type = 'user'
      AND a.occurred_at = pg_catalog.now()
      AND a.detail ->> 'version' IS NOT DISTINCT FROM NEW.apps_version::text
      AND (a.detail ->> 'enabled') IN ('true', 'false')
      AND a.detail ->> 'module' IS NOT NULL
      AND (
        CASE WHEN (a.detail ->> 'enabled') = 'true'
          THEN pg_catalog.array_remove(OLD.apps_off, a.detail ->> 'module')
          ELSE OLD.apps_off || ARRAY[a.detail ->> 'module']
        END
      ) @> NEW.apps_off
      AND NEW.apps_off @> (
        CASE WHEN (a.detail ->> 'enabled') = 'true'
          THEN pg_catalog.array_remove(OLD.apps_off, a.detail ->> 'module')
          ELSE OLD.apps_off || ARRAY[a.detail ->> 'module']
        END
      )
      AND (a.detail ->> 'module' = ANY (OLD.apps_off)) IS DISTINCT FROM (a.detail ->> 'module' = ANY (NEW.apps_off))
  ) THEN
    RAISE EXCEPTION 'APPS_UNAUDITED' USING ERRCODE = '42501';
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS tenant_apps_requires_audit ON crove_kernel.tenant;
CREATE CONSTRAINT TRIGGER tenant_apps_requires_audit
  AFTER UPDATE OF apps_off, apps_version ON crove_kernel.tenant
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (OLD.apps_off IS DISTINCT FROM NEW.apps_off
                     OR OLD.apps_version IS DISTINCT FROM NEW.apps_version)
  EXECUTE FUNCTION crove_kernel.tenant_apps_requires_audit();

-- Whether the org has not switched the module off. kernel is always on; an org without a tenant row (purged) answers
-- false, so no work is found for it.
CREATE OR REPLACE FUNCTION crove_kernel.org_app_on(p_org uuid, p_module text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT p_module = 'kernel'
         OR COALESCE((SELECT NOT (p_module = ANY (t.apps_off)) FROM crove_kernel.tenant t WHERE t.org_id = p_org), false)
$$;

-- EXECUTE matrix: the triggers' functions are callable by nobody; org_app_on by the API (public pages) and the worker
-- (sweeps, relay). The runtime reads the column itself in the caller's context, so crove_tenant does not need it.
REVOKE ALL ON FUNCTION crove_kernel.tenant_apps_guard(), crove_kernel.tenant_apps_requires_audit()
FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
REVOKE ALL ON FUNCTION crove_kernel.org_app_on(uuid, text) FROM PUBLIC, crove_tenant, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.org_app_on(uuid, text) TO crove_app, crove_worker;
