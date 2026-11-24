-- SPDX-License-Identifier: AGPL-3.0-only
-- Ludy kernel, for the Meetings line (issue #4703, owner decision 2026-11-24): the org setting "Ký biên bản họp", off by default. Idempotent; applied files stay untouched.
--
-- ludy_kernel.tenant.meeting_minutes_esign: while it is false (every org today, no backfill), ludy_sign refuses to create a meeting_minutes envelope (sign.envelope.create and the template
-- instantiate both pass through assertCanCreateMeetingMinutesEnvelope); an envelope made earlier stays readable and a signed one downloadable, and turning the setting off only stops new
-- ones. It lives on the tenant row beside the consent policy and the webhook switch, and a guard trigger lets only meetings.minutes_esign.set, run by an owner or admin of the org in its own
-- context, change it (the same guard as meeting_consent_policy; staff may make any change).
SET LOCAL lock_timeout = '2s';

ALTER TABLE ludy_kernel.tenant ADD COLUMN IF NOT EXISTS meeting_minutes_esign boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION ludy_kernel.tenant_meeting_minutes_esign_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_staff boolean;
  v_user uuid;
BEGIN
  IF NEW.meeting_minutes_esign IS NOT DISTINCT FROM OLD.meeting_minutes_esign THEN
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
    RAISE EXCEPTION 'MEETING_MINUTES_ESIGN_FORBIDDEN' USING ERRCODE = '42501',
      DETAIL = 'only meetings.minutes_esign.set, run by an owner or admin of the org in its own context, changes the org setting for signing meeting minutes';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tenant_meeting_minutes_esign_guard ON ludy_kernel.tenant;
CREATE TRIGGER tenant_meeting_minutes_esign_guard BEFORE UPDATE OF meeting_minutes_esign ON ludy_kernel.tenant
  FOR EACH ROW EXECUTE FUNCTION ludy_kernel.tenant_meeting_minutes_esign_guard();
REVOKE ALL ON FUNCTION ludy_kernel.tenant_meeting_minutes_esign_guard() FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
