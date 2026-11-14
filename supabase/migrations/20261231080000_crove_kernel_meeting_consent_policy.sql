-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove kernel, for Meetings A2 (issue #3160, plan docs/plan/meetings-integrations.md section 4.1): the org setting "consent required before
-- recording". Idempotent; applied files stay untouched.
--
-- crove_kernel.tenant.meeting_consent_policy: 'standard' (today: any consent method the meeting offers) or 'strict' (the recorder must pick a
-- written method: pasted in the call chat, written in the invite, agreed in writing; "said at the start" alone is refused by
-- meetings.meeting.create). It lives on the tenant row beside the three retention settings of 20261125100000, and a guard trigger lets only
-- meetings.consent_policy.set, run by an owner or admin of the org in its own context, change it. A change applies to meetings created afterwards:
-- no meeting is re-stamped. No backfill: every existing org is 'standard'.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_kernel.tenant ADD COLUMN IF NOT EXISTS meeting_consent_policy text NOT NULL DEFAULT 'standard';
DO $$
BEGIN
  ALTER TABLE crove_kernel.tenant ADD CONSTRAINT tenant_meeting_consent_policy_check CHECK (meeting_consent_policy IN ('standard', 'strict'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- A change is refused (MEETING_CONSENT_POLICY_FORBIDDEN, 42501) unless the sealed context is a user who is an owner or admin of the org. Staff (a
-- superuser, or a role that can act as the table's owner) may make any change, as in tenant_meeting_retention_guard.
CREATE OR REPLACE FUNCTION crove_kernel.tenant_meeting_consent_policy_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_staff boolean;
  v_user uuid;
BEGIN
  IF NEW.meeting_consent_policy IS NOT DISTINCT FROM OLD.meeting_consent_policy THEN
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
       WHERE m.org_id = NEW.org_id AND m.user_id = v_user AND m.role IN ('owner', 'admin')
     ) THEN
    RAISE EXCEPTION 'MEETING_CONSENT_POLICY_FORBIDDEN' USING ERRCODE = '42501',
      DETAIL = 'only meetings.consent_policy.set, run by an owner or admin of the org, changes its meeting consent policy';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tenant_meeting_consent_policy_guard ON crove_kernel.tenant;
CREATE TRIGGER tenant_meeting_consent_policy_guard BEFORE UPDATE OF meeting_consent_policy ON crove_kernel.tenant
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.tenant_meeting_consent_policy_guard();
REVOKE ALL ON FUNCTION crove_kernel.tenant_meeting_consent_policy_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
