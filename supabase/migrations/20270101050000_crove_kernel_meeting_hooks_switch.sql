-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove kernel: the owner's switch for members' minutes webhooks (Meetings A6, issue #3164, plan docs/plan/meetings-integrations.md section 4.5). Idempotent; applied files stay untouched.
-- A column of the org's own row, off by default, changed only by an owner in the org's own context (meetings.hooks.switch.set); the meetings migration that follows reads it.
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- The owner's switch: crove_kernel.tenant.meeting_hooks (off by default), changed only by an owner in the org's own context.
-- ---------------------------------------------------------------------------
ALTER TABLE crove_kernel.tenant ADD COLUMN IF NOT EXISTS meeting_hooks boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION crove_kernel.tenant_meeting_hooks_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_staff boolean;
  v_user uuid;
BEGIN
  IF NEW.meeting_hooks IS NOT DISTINCT FROM OLD.meeting_hooks THEN
    RETURN NEW;
  END IF;
  SELECT r.rolsuper
         OR pg_catalog.pg_has_role(r.oid, (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID), 'USAGE')
    INTO v_staff
  FROM pg_catalog.pg_roles r WHERE r.rolname = SESSION_USER;
  IF COALESCE(v_staff, false) THEN
    RETURN NEW;
  END IF;
  v_user := crove_kernel.ctx_user_id();
  IF crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user'
     OR crove_kernel.ctx_org_id() IS DISTINCT FROM NEW.org_id
     OR NOT EXISTS (
       SELECT 1 FROM crove_kernel.tenant_member m
       WHERE m.org_id = NEW.org_id AND m.user_id = v_user AND m.role = 'owner'
     ) THEN
    RAISE EXCEPTION 'MEETING_HOOKS_FORBIDDEN' USING ERRCODE = '42501',
      DETAIL = 'only meetings.hooks.switch.set, run by an owner of the org in its own context, changes the org switch for members'' minutes webhooks';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tenant_meeting_hooks_guard ON crove_kernel.tenant;
CREATE TRIGGER tenant_meeting_hooks_guard BEFORE UPDATE OF meeting_hooks ON crove_kernel.tenant
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.tenant_meeting_hooks_guard();
REVOKE ALL ON FUNCTION crove_kernel.tenant_meeting_hooks_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
