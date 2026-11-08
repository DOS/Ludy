-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove kernel, for the meetings module's step M5 (issue #2579, ADR-0047 point 7, plan docs/plan/meetings.md section 9): the org's three meeting retention
-- settings and the index of the orphan scan. Idempotent; applied files stay untouched. The meetings schema's own changes are in the next migration.
--
-- 1. crove_kernel.tenant gets the org's three retention settings (audio, video, text), stamped on each meeting when it is recorded. They live on the
--    tenant row, as the other one-row-per-org settings of a module do (the missing-invoice reminder day), so no new tenant table is needed. Only an
--    owner or admin changes them (meetings.settings.set; a guard trigger holds every other writer).
-- 2. A small partial index on the meeting media file rows, for the worker's scan of ciphertext files no meeting row names any more.
-- 3. The org export's two meeting readers (ADR-0047 point 7): the meetings shared with the whole org, which every whole-org member reads anyway, and per
--    recorder the count of attendees-only meetings left out, as private notes are. Both answer only the worker's system context of the org it exports.
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. The three settings
-- ---------------------------------------------------------------------------
ALTER TABLE crove_kernel.tenant ADD COLUMN IF NOT EXISTS meeting_audio_retention_days smallint NOT NULL DEFAULT 30;
ALTER TABLE crove_kernel.tenant ADD COLUMN IF NOT EXISTS meeting_video_retention_days smallint NOT NULL DEFAULT 7;
ALTER TABLE crove_kernel.tenant ADD COLUMN IF NOT EXISTS meeting_text_retention_days smallint NOT NULL DEFAULT 365;

-- The bounds only; the exact choices (a fixed set, which the CHECK-union test of schema.ts would ask to be refined) are held by the command's input schema.
-- Audio: 0 is "deleted right after the transcript" (7 days while no transcript exists, plan section 9), else 7, 30 or 90. Video: 7 or 30, never longer than
-- the audio (0 counts as 7). Text: 90, 365 or 730 days, or 0 for until a person deletes it.
DO $$
BEGIN
  ALTER TABLE crove_kernel.tenant ADD CONSTRAINT tenant_meeting_audio_retention_days_check CHECK (meeting_audio_retention_days BETWEEN 0 AND 90);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$
BEGIN
  ALTER TABLE crove_kernel.tenant ADD CONSTRAINT tenant_meeting_video_retention_days_check CHECK (meeting_video_retention_days BETWEEN 7 AND 30);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$
BEGIN
  ALTER TABLE crove_kernel.tenant ADD CONSTRAINT tenant_meeting_text_retention_days_check CHECK (meeting_text_retention_days BETWEEN 0 AND 730);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$
BEGIN
  ALTER TABLE crove_kernel.tenant ADD CONSTRAINT tenant_meeting_video_not_longer_than_audio CHECK (meeting_video_retention_days <= GREATEST(meeting_audio_retention_days, 7));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- A change of a setting is refused (MEETING_SETTINGS_FORBIDDEN, 42501) unless the sealed context is a user who is an owner or admin of the org. Staff (a
-- superuser, or a role that can act as the table's owner) may make any change, as in tenant_contact_email_guard.
CREATE OR REPLACE FUNCTION crove_kernel.tenant_meeting_retention_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_staff boolean;
  v_user uuid;
BEGIN
  IF NEW.meeting_audio_retention_days IS NOT DISTINCT FROM OLD.meeting_audio_retention_days
     AND NEW.meeting_video_retention_days IS NOT DISTINCT FROM OLD.meeting_video_retention_days
     AND NEW.meeting_text_retention_days IS NOT DISTINCT FROM OLD.meeting_text_retention_days THEN
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
    RAISE EXCEPTION 'MEETING_SETTINGS_FORBIDDEN' USING ERRCODE = '42501',
      DETAIL = 'only meetings.settings.set, run by an owner or admin of the org, changes its meeting retention';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tenant_meeting_retention_guard ON crove_kernel.tenant;
CREATE TRIGGER tenant_meeting_retention_guard BEFORE UPDATE OF meeting_audio_retention_days, meeting_video_retention_days, meeting_text_retention_days ON crove_kernel.tenant
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.tenant_meeting_retention_guard();
REVOKE ALL ON FUNCTION crove_kernel.tenant_meeting_retention_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- ---------------------------------------------------------------------------
-- 2. The orphan scan's index
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS file_meeting_media_idx ON crove_kernel.file (created_at, id) WHERE source IN ('meeting_audio', 'meeting_video');


-- ---------------------------------------------------------------------------
-- 3. What the org export carries of meetings
-- ---------------------------------------------------------------------------
-- The meetings shared with the whole org. Attendees-only meetings stay out (their readers download their own before), and so do the audio and video,
-- which are in no export (the file rows of meeting media are left out of the kernel.file part).
CREATE OR REPLACE FUNCTION crove_kernel.meeting_export_rows()
RETURNS SETOF crove_meetings.meeting LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
BEGIN
  IF v_org IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'system' OR NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'MEETINGS_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT m.* FROM crove_meetings.meeting m WHERE m.org_id = v_org AND m.visibility = 'org' ORDER BY m.started_at, m.id;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.meeting_export_rows() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.meeting_export_rows() TO crove_tenant;

-- How many attendees-only meetings each recorder has: counts only, no title.
CREATE OR REPLACE FUNCTION crove_kernel.meeting_private_counts()
RETURNS TABLE (org_id uuid, recorder_user_id uuid, meetings bigint) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
BEGIN
  IF v_org IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'system' OR NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'MEETINGS_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT m.org_id, m.recorder_user_id, pg_catalog.count(*)
    FROM crove_meetings.meeting m WHERE m.org_id = v_org AND m.visibility = 'attendees' GROUP BY m.org_id, m.recorder_user_id ORDER BY m.recorder_user_id;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.meeting_private_counts() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.meeting_private_counts() TO crove_tenant;
