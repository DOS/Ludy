-- SPDX-License-Identifier: AGPL-3.0-only
-- Optional org-level strict L1 overtime approval gate (#4488, PR #4709 pattern):
-- false by default so SME owner/admin final-approval fallback on pending_l1 stays unchanged;
-- when true, hr.overtime.approve_final requires prior L1 approval (pending_final).

SET LOCAL lock_timeout = '2s';

ALTER TABLE ludy_kernel.tenant
  ADD COLUMN IF NOT EXISTS hr_overtime_require_l1 boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION ludy_kernel.tenant_hr_overtime_require_l1_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_staff boolean;
  v_user uuid;
BEGIN
  IF NEW.hr_overtime_require_l1 IS NOT DISTINCT FROM OLD.hr_overtime_require_l1 THEN
    RETURN NEW;
  END IF;
  SELECT r.rolsuper
         OR pg_catalog.pg_has_role(r.oid, (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID), 'USAGE')
    INTO v_staff
  FROM pg_catalog.pg_roles r WHERE r.rolname = SESSION_USER;
  IF COALESCE(v_staff, false) THEN
    RETURN NEW;
  END IF;
  v_user := ludy_kernel.ctx_user_id();
  IF ludy_kernel.ctx_actor_type() IS DISTINCT FROM 'user'
     OR ludy_kernel.ctx_org_id() IS DISTINCT FROM NEW.org_id
     OR NOT EXISTS (
       SELECT 1 FROM ludy_kernel.tenant_member m
       WHERE m.org_id = NEW.org_id AND m.user_id = v_user AND m.role IN ('owner', 'admin')
     ) THEN
    RAISE EXCEPTION 'HR_OVERTIME_REQUIRE_L1_FORBIDDEN' USING ERRCODE = '42501',
      DETAIL = 'only hr.overtime.settings.set, run by an owner or admin of the org in its own context, changes hr_overtime_require_l1';
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION ludy_kernel.tenant_hr_overtime_require_l1_guard() FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;

DROP TRIGGER IF EXISTS tenant_hr_overtime_require_l1_guard ON ludy_kernel.tenant;
CREATE TRIGGER tenant_hr_overtime_require_l1_guard
  BEFORE UPDATE OF hr_overtime_require_l1 ON ludy_kernel.tenant
  FOR EACH ROW EXECUTE FUNCTION ludy_kernel.tenant_hr_overtime_require_l1_guard();
ALTER TABLE ludy_kernel.tenant ENABLE ALWAYS TRIGGER tenant_hr_overtime_require_l1_guard;
