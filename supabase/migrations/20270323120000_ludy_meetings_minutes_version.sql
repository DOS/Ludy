-- SPDX-License-Identifier: AGPL-3.0-only
-- Ludy meetings, issue #4777: a second-language version of a meeting's published minutes that the recorder reviewed, edited and published beside the original, which the readers of the
-- meeting read. Until now a translation of the summary was a member's private row (the E1 translation table, owner decision 2026-11-14) and nothing a partner could be sent. Idempotent;
-- applied files stay untouched.
--
-- 1. ludy_meetings.minutes_version: one row per meeting and language (the recorder publishes it again to replace it). The body is the checked segments the recorder approved, [{key, text}]
--    in the keys of the published original (summary, decision:<n>, item:<id>). Read by every reader of the meeting (the recorder included); written, replaced and removed by the recorder
--    alone, in a user context. No UPDATE: a replacement is a delete and an insert. The model's draft stays in the member's private translation row and in their Vy result; only the
--    recorder's reviewed text lands here, by their own click (meetings.minutes_version.publish).
-- 2. A version never outlives the original it is beside: a definer trigger drops the versions of a meeting the moment its published summary, decisions or an action item of the published
--    stage is deleted, changes stage or changes text (which is what the personal-data erasure's redaction does). Dropped, not redacted: a name cannot be located reliably in another
--    language (the rule of the private translations). The meeting's removal, the retention job and the org purge reach it by the foreign key.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS ludy_meetings.minutes_version (
  org_id uuid NOT NULL REFERENCES ludy_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT ludy_kernel.uuid_v7(),
  meeting_id uuid NOT NULL,
  language text NOT NULL CHECK (language IN ('vi', 'en', 'zh', 'ja', 'ko')),
  -- The sha256 of the published original this was made from (the same hash the translation run uses): a drift is caught when the recorder publishes, and the triggers below drop the row
  -- when the original changes.
  source_hash text NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  -- The reviewed segments [{key, text}]. Free text a person may be named in (the registry says so).
  body jsonb NOT NULL CHECK (pg_catalog.jsonb_typeof(body) = 'array' AND pg_catalog.jsonb_array_length(body) BETWEEN 1 AND 100 AND pg_catalog.pg_column_size(body) <= 400000),
  -- The recorder who approved it, and the run of their Vy it began from (nullable: a row outlives its run row, and a recorder may write it all by hand).
  published_by uuid NOT NULL,
  source_run_id uuid,
  published_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT minutes_version_meeting_fk FOREIGN KEY (org_id, meeting_id) REFERENCES ludy_meetings.meeting (org_id, id) ON DELETE CASCADE,
  CONSTRAINT minutes_version_one_uq UNIQUE (org_id, meeting_id, language)
);

SELECT ludy_kernel.apply_tenant_rls('ludy_meetings.minutes_version');
REVOKE UPDATE ON ludy_meetings.minutes_version FROM ludy_tenant;

-- Every reader of the meeting reads it (is_meeting_reader answers true for the recorder and for the readers of an active member of an acting role, in a user context only).
DROP POLICY IF EXISTS minutes_version_read ON ludy_meetings.minutes_version;
CREATE POLICY minutes_version_read ON ludy_meetings.minutes_version AS RESTRICTIVE FOR SELECT TO ludy_tenant
  USING (ludy_meetings.is_meeting_reader(org_id, meeting_id));

-- Only the recorder inserts, as themselves, in a user context (ctx_user_id is NULL for an agent context, a member Vy run included, and for the system).
DROP POLICY IF EXISTS minutes_version_insert ON ludy_meetings.minutes_version;
CREATE POLICY minutes_version_insert ON ludy_meetings.minutes_version AS RESTRICTIVE FOR INSERT TO ludy_tenant
  WITH CHECK (published_by = ludy_kernel.ctx_user_id() AND ludy_kernel.ctx_actor_type() = 'user' AND ludy_meetings.is_meeting_recorder(org_id, meeting_id));

DROP POLICY IF EXISTS minutes_version_delete ON ludy_meetings.minutes_version;
CREATE POLICY minutes_version_delete ON ludy_meetings.minutes_version AS RESTRICTIVE FOR DELETE TO ludy_tenant
  USING (ludy_kernel.ctx_actor_type() = 'user' AND ludy_meetings.is_meeting_recorder(org_id, meeting_id));

-- ---------------------------------------------------------------------------
-- 2. A version never outlives the published original it is beside
-- ---------------------------------------------------------------------------
-- A definer, because the row that changes is the recorder's own result or item row (or the erasure's) and the versions are dropped whatever context did it. It deletes by meeting only and
-- returns nothing.
CREATE OR REPLACE FUNCTION ludy_meetings.minutes_version_drop_stale() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  DELETE FROM ludy_meetings.minutes_version v WHERE v.org_id = OLD.org_id AND v.meeting_id = OLD.meeting_id;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION ludy_meetings.minutes_version_drop_stale() FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;

DROP TRIGGER IF EXISTS meeting_result_minutes_version_drop ON ludy_meetings.meeting_result;
CREATE TRIGGER meeting_result_minutes_version_drop AFTER DELETE ON ludy_meetings.meeting_result
  FOR EACH ROW WHEN (OLD.stage = 'published') EXECUTE FUNCTION ludy_meetings.minutes_version_drop_stale();
DROP TRIGGER IF EXISTS meeting_result_minutes_version_stage ON ludy_meetings.meeting_result;
CREATE TRIGGER meeting_result_minutes_version_stage AFTER UPDATE OF stage ON ludy_meetings.meeting_result
  FOR EACH ROW WHEN (OLD.stage IS DISTINCT FROM NEW.stage AND (OLD.stage = 'published' OR NEW.stage = 'published')) EXECUTE FUNCTION ludy_meetings.minutes_version_drop_stale();
DROP TRIGGER IF EXISTS meeting_result_minutes_version_edit ON ludy_meetings.meeting_result;
CREATE TRIGGER meeting_result_minutes_version_edit AFTER UPDATE OF summary, decisions ON ludy_meetings.meeting_result
  FOR EACH ROW WHEN (OLD.stage = 'published' AND (OLD.summary IS DISTINCT FROM NEW.summary OR OLD.decisions IS DISTINCT FROM NEW.decisions)) EXECUTE FUNCTION ludy_meetings.minutes_version_drop_stale();

DROP TRIGGER IF EXISTS action_item_minutes_version_drop ON ludy_meetings.action_item;
CREATE TRIGGER action_item_minutes_version_drop AFTER DELETE ON ludy_meetings.action_item
  FOR EACH ROW WHEN (OLD.stage = 'published') EXECUTE FUNCTION ludy_meetings.minutes_version_drop_stale();
DROP TRIGGER IF EXISTS action_item_minutes_version_stage ON ludy_meetings.action_item;
CREATE TRIGGER action_item_minutes_version_stage AFTER UPDATE OF stage ON ludy_meetings.action_item
  FOR EACH ROW WHEN (OLD.stage IS DISTINCT FROM NEW.stage AND (OLD.stage = 'published' OR NEW.stage = 'published')) EXECUTE FUNCTION ludy_meetings.minutes_version_drop_stale();
DROP TRIGGER IF EXISTS action_item_minutes_version_edit ON ludy_meetings.action_item;
CREATE TRIGGER action_item_minutes_version_edit AFTER UPDATE OF title ON ludy_meetings.action_item
  FOR EACH ROW WHEN (OLD.stage = 'published' AND OLD.title IS DISTINCT FROM NEW.title) EXECUTE FUNCTION ludy_meetings.minutes_version_drop_stale();
