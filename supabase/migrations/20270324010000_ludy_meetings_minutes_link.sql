-- SPDX-License-Identifier: AGPL-3.0-only
-- Ludy meetings, issue #4822 (owner decision 2026-11-25): a read-only, revocable link to the PUBLISHED minutes of a meeting for people outside the org. Idempotent; applied files stay untouched.
--
-- ludy_kernel.tenant.meeting_minutes_link   the org setting "Chia sẻ biên bản ra ngoài", off by default (every org today, no backfill). While it is false no link can be made and no link opens.
--                                          Like the minutes e-sign switch (20270319200000) it lives on the tenant row and a guard trigger lets only an owner or admin in the org's own
--                                          context change it (meetings.minutes_link.switch.set); staff may make any change.
-- ludy_meetings.minutes_link                one row per link the recorder made: the token is kept only as a SHA-256 hash (never the token), the link lives at most 30 days, is revoked once
--                                          in the revoker's own name, and goes with its meeting (ON DELETE CASCADE: the recorder's delete, the retention shred and the org purge). The public page counts
--                                          opens in `views` and `first_viewed_at`; nothing about who opened it is kept.
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. The org setting
-- ---------------------------------------------------------------------------
ALTER TABLE ludy_kernel.tenant ADD COLUMN IF NOT EXISTS meeting_minutes_link boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION ludy_kernel.tenant_meeting_minutes_link_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_staff boolean;
  v_user uuid;
BEGIN
  IF NEW.meeting_minutes_link IS NOT DISTINCT FROM OLD.meeting_minutes_link THEN
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
    RAISE EXCEPTION 'MEETING_MINUTES_LINK_FORBIDDEN' USING ERRCODE = '42501',
      DETAIL = 'only meetings.minutes_link.switch.set, run by an owner or admin of the org in its own context, changes the org setting for sharing minutes with people outside';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tenant_meeting_minutes_link_guard ON ludy_kernel.tenant;
CREATE TRIGGER tenant_meeting_minutes_link_guard BEFORE UPDATE OF meeting_minutes_link ON ludy_kernel.tenant
  FOR EACH ROW EXECUTE FUNCTION ludy_kernel.tenant_meeting_minutes_link_guard();
REVOKE ALL ON FUNCTION ludy_kernel.tenant_meeting_minutes_link_guard() FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;

-- ---------------------------------------------------------------------------
-- 2. The link
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ludy_meetings.minutes_link (
  org_id uuid NOT NULL REFERENCES ludy_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT ludy_kernel.uuid_v7(),
  meeting_id uuid NOT NULL,
  token_sha256 text NOT NULL CONSTRAINT minutes_link_token_format CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by uuid,
  -- Set by the public page: the first time the link was opened, and how many times. Nothing about who opened it.
  first_viewed_at timestamptz,
  views integer NOT NULL DEFAULT 0 CHECK (views >= 0),
  PRIMARY KEY (org_id, id),
  CONSTRAINT minutes_link_token_uq UNIQUE (token_sha256),
  CONSTRAINT minutes_link_meeting_fk FOREIGN KEY (org_id, meeting_id) REFERENCES ludy_meetings.meeting (org_id, id) ON DELETE CASCADE,
  CONSTRAINT minutes_link_expiry CHECK (expires_at > created_at AND expires_at <= created_at + interval '30 days'),
  CONSTRAINT minutes_link_revoked CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
-- Backs the meeting's foreign key and the live links of a meeting.
CREATE INDEX IF NOT EXISTS minutes_link_meeting_idx ON ludy_meetings.minutes_link (org_id, meeting_id, created_at DESC);
SELECT ludy_kernel.apply_tenant_rls('ludy_meetings.minutes_link');
REVOKE UPDATE, DELETE ON ludy_meetings.minutes_link FROM ludy_tenant;
GRANT UPDATE (revoked_at, revoked_by) ON ludy_meetings.minutes_link TO ludy_tenant;
-- A member makes a link in their own name (the command checks that they recorded the meeting, that the published minutes exist and that the org setting is on) and revokes one.
DROP POLICY IF EXISTS minutes_link_insert ON ludy_meetings.minutes_link;
CREATE POLICY minutes_link_insert ON ludy_meetings.minutes_link AS RESTRICTIVE FOR INSERT TO ludy_tenant
  WITH CHECK ((SELECT ludy_kernel.ctx_actor_type()) = 'system'
    OR (EXISTS (SELECT 1 FROM ludy_kernel.tenant_member m WHERE m.org_id = minutes_link.org_id AND m.user_id = (SELECT ludy_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member'))
      AND minutes_link.created_by = (SELECT ludy_kernel.ctx_user_id())
      AND minutes_link.created_at BETWEEN pg_catalog.now() - pg_catalog.make_interval(mins => 1) AND pg_catalog.now() + pg_catalog.make_interval(mins => 1)
      AND minutes_link.revoked_at IS NULL AND minutes_link.first_viewed_at IS NULL AND minutes_link.views = 0));
DROP POLICY IF EXISTS minutes_link_update ON ludy_meetings.minutes_link;
CREATE POLICY minutes_link_update ON ludy_meetings.minutes_link AS RESTRICTIVE FOR UPDATE TO ludy_tenant
  USING ((SELECT ludy_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM ludy_kernel.tenant_member m WHERE m.org_id = minutes_link.org_id AND m.user_id = (SELECT ludy_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member')))
  WITH CHECK ((SELECT ludy_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM ludy_kernel.tenant_member m WHERE m.org_id = minutes_link.org_id AND m.user_id = (SELECT ludy_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member')));

-- A link is revoked once and in the revoker's own name; nothing else about it changes (the public page's count is made by a definer, in no user's context).
CREATE OR REPLACE FUNCTION ludy_meetings.minutes_link_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF ludy_kernel.ctx_actor_type() IS NULL OR ludy_kernel.ctx_actor_type() = 'system' OR NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL OR NEW.revoked_by IS DISTINCT FROM ludy_kernel.ctx_user_id() THEN
    RAISE EXCEPTION 'MINUTES_LINK_FORBIDDEN' USING ERRCODE = '42501', DETAIL = 'a link is revoked once, in the name of the person who revokes it';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ludy_meetings.minutes_link_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS minutes_link_guard ON ludy_meetings.minutes_link;
CREATE TRIGGER minutes_link_guard BEFORE UPDATE ON ludy_meetings.minutes_link
  FOR EACH ROW EXECUTE FUNCTION ludy_meetings.minutes_link_guard();
ALTER TABLE ludy_meetings.minutes_link ENABLE ALWAYS TRIGGER minutes_link_guard;
