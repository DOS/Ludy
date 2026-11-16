-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove kernel (issue #3310, ADR-0053 slice c, C2b): every open stream of an org hears when its apps change.
-- Idempotent; applied files stay untouched.
--
-- crove_kernel.tenant_apps_notify() sends `<org_id> org_apps <org_id>` on the crove_stream channel when a tenant row's apps_off or apps_version changes
-- (the hint type org_apps; its id is the org's own, which any member knows). A stream that gets it checks again first, so the apps it filters by are the
-- new ones, and the app reads kernel.org.apps again. Ids only, as every hint: no role needs a grant, and nobody may execute the trigger function.
SET LOCAL lock_timeout = '2s';

-- Like crove_kernel.stream_notify, it takes the hint type and the id column as trigger arguments (the stream invariant reads two of them on every unscoped
-- stream trigger); the tenant row has no `id`, its id is `org_id`.
CREATE OR REPLACE FUNCTION crove_kernel.tenant_apps_notify() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_NARGS <> 2 OR TG_ARGV[0] <> 'org_apps' OR TG_ARGV[1] <> 'org_id' THEN
    RAISE EXCEPTION 'tenant_apps_notify takes (org_apps, org_id)' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_notify('crove_stream', NEW.org_id::text || ' ' || TG_ARGV[0] || ' ' || NEW.org_id::text);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.tenant_apps_notify() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

DROP TRIGGER IF EXISTS tenant_apps_notify ON crove_kernel.tenant;
CREATE TRIGGER tenant_apps_notify
  AFTER UPDATE OF apps_off, apps_version ON crove_kernel.tenant
  FOR EACH ROW WHEN (OLD.apps_off IS DISTINCT FROM NEW.apps_off OR OLD.apps_version IS DISTINCT FROM NEW.apps_version)
  EXECUTE FUNCTION crove_kernel.tenant_apps_notify('org_apps', 'org_id');
