-- SPDX-License-Identifier: AGPL-3.0-only
-- eSign meeting minutes (#4532, review-followup of #4157; docs/plan/esign.md Slice 3a, ADR-0047): the server ties a meeting-minutes envelope to the minutes.
-- 1) ludy_sign.envelope.source_revision: sha256 of the published minutes (result and published action items) the envelope was made for, set by a BEFORE INSERT trigger
--    from the database, never from client input, and immutable after. Rows that existed before get 'legacy' (never matches a current revision, so they read as stale and
--    are not sent again); a meeting_minutes row always has one, any other source kind none.
-- 2) ludy_sign.meeting_minutes_revision(meeting): the current revision for a reader of a meeting with shared minutes, NULL for anyone else (the same gate as
--    check_meeting_minutes_source). The command layer compares it with the envelope's stored revision to report `stale` and to refuse sending a stale envelope.
-- 3) ludy_sign.can_create_meeting_minutes_envelope (same signature, so the RLS insert policy follows): only the meeting's recorder creates one. A plain reader reads the
--    minutes and cannot start a signature on someone else's minutes.
-- Idempotent; applied files stay untouched.

SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. The column, the scrub of existing rows, then the check (added NOT VALID, validated after the scrub)
-- ---------------------------------------------------------------------------

ALTER TABLE ludy_sign.envelope
  ADD COLUMN IF NOT EXISTS source_revision text;

UPDATE ludy_sign.envelope
SET source_revision = 'legacy'
WHERE source_kind = 'meeting_minutes'
  AND source_revision IS NULL;

ALTER TABLE ludy_sign.envelope DROP CONSTRAINT IF EXISTS envelope_meeting_minutes_revision_check;
ALTER TABLE ludy_sign.envelope
  ADD CONSTRAINT envelope_meeting_minutes_revision_check
  CHECK (
    (source_kind = 'meeting_minutes') = (source_revision IS NOT NULL)
    AND (source_revision IS NULL OR source_revision ~ '^([0-9a-f]{64}|legacy)$')
  ) NOT VALID;
ALTER TABLE ludy_sign.envelope VALIDATE CONSTRAINT envelope_meeting_minutes_revision_check;

-- ---------------------------------------------------------------------------
-- 2. The revision of the published minutes
-- ---------------------------------------------------------------------------

-- Internal definer-only helper: the revision of the published minutes of one meeting, with no reader gate (the trigger below and the gated function call it). NULL when nothing
-- is published. The published result is unique per meeting (meeting_result_stage_uq); the published action items are taken in id order. Anything a reader sees in the minutes
-- (summary, decisions, each item's title, who and when) changes the hash.
-- migration-lint: cross-module reads ludy_meetings.meeting_result and ludy_meetings.action_item to hash the published minutes (#4532).
CREATE OR REPLACE FUNCTION ludy_sign.meeting_minutes_revision_raw(
  p_org_id uuid,
  p_meeting_id uuid
) RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_result jsonb;
  v_items jsonb;
BEGIN
  IF p_org_id IS NULL OR p_meeting_id IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT pg_catalog.jsonb_build_array(r.id, r.summary, r.decisions)
  INTO v_result
  FROM ludy_meetings.meeting_result r
  WHERE r.org_id = p_org_id
    AND r.meeting_id = p_meeting_id
    AND r.stage = 'published';
  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_array(ai.id, ai.title, ai.who_drafted, ai.who_parsed, ai.when_drafted, ai.when_parsed)
      ORDER BY ai.id
    ),
    '[]'::jsonb
  )
  INTO v_items
  FROM ludy_meetings.action_item ai
  WHERE ai.org_id = p_org_id
    AND ai.meeting_id = p_meeting_id
    AND ai.stage = 'published';
  IF v_result IS NULL AND v_items = '[]'::jsonb THEN
    RETURN NULL;
  END IF;
  RETURN pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_array(v_result, v_items)::text, 'UTF8')),
    'hex'
  );
END $$;

REVOKE ALL ON FUNCTION ludy_sign.meeting_minutes_revision_raw(uuid, uuid)
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;

-- The current revision for the caller: NULL unless the caller is a reader of a meeting of this org whose minutes are shared (check_meeting_minutes_source = 2).
CREATE OR REPLACE FUNCTION ludy_sign.meeting_minutes_revision(
  p_meeting_id uuid
) RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
BEGIN
  IF v_org IS NULL OR p_meeting_id IS NULL THEN
    RETURN NULL;
  END IF;
  IF ludy_sign.check_meeting_minutes_source(p_meeting_id) <> 2 THEN
    RETURN NULL;
  END IF;
  RETURN ludy_sign.meeting_minutes_revision_raw(v_org, p_meeting_id);
END $$;

REVOKE ALL ON FUNCTION ludy_sign.meeting_minutes_revision(uuid)
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION ludy_sign.meeting_minutes_revision(uuid) TO ludy_tenant;

-- The trigger that makes the stored revision the database's: on insert a meeting_minutes row gets the current revision of its meeting (or 'legacy' when nothing is published,
-- which only a system insert can reach, the RLS policy needing shared minutes), any other row gets none, whatever the insert said; on update it cannot change.
CREATE OR REPLACE FUNCTION ludy_sign.envelope_minutes_revision() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.source_kind = 'meeting_minutes' THEN
      NEW.source_revision := COALESCE(ludy_sign.meeting_minutes_revision_raw(NEW.org_id, NEW.source_id), 'legacy');
    ELSE
      NEW.source_revision := NULL;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.source_revision IS DISTINCT FROM OLD.source_revision THEN
    RAISE EXCEPTION 'ENVELOPE_IMMUTABLE' USING ERRCODE = '42501', DETAIL = 'the minutes revision of an envelope is set when it is created and never changes';
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION ludy_sign.envelope_minutes_revision()
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;

DROP TRIGGER IF EXISTS envelope_minutes_revision ON ludy_sign.envelope;
CREATE TRIGGER envelope_minutes_revision BEFORE INSERT OR UPDATE OF source_revision ON ludy_sign.envelope
  FOR EACH ROW EXECUTE FUNCTION ludy_sign.envelope_minutes_revision();

-- ---------------------------------------------------------------------------
-- 3. Only the recorder creates a meeting-minutes envelope
-- ---------------------------------------------------------------------------

-- Same signature as the function of 20270209000000 (renamed with the schema), so the meeting_minutes_insert policy calls this one. A reader who is not the recorder gets false.
-- migration-lint: cross-module reads ludy_meetings.meeting to tie the creator to the recorder (#4532).
CREATE OR REPLACE FUNCTION ludy_sign.can_create_meeting_minutes_envelope(
  p_org_id uuid,
  p_meeting_id uuid
) RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_org_id IS NULL OR p_org_id IS DISTINCT FROM ludy_kernel.ctx_org_id() THEN
    RETURN false;
  END IF;
  IF ludy_sign.check_meeting_minutes_source(p_meeting_id) <> 2 THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM ludy_meetings.meeting m
    WHERE m.org_id = p_org_id
      AND m.id = p_meeting_id
      AND m.recorder_user_id = ludy_kernel.ctx_user_id()
  );
END $$;

REVOKE ALL ON FUNCTION ludy_sign.can_create_meeting_minutes_envelope(uuid, uuid)
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION ludy_sign.can_create_meeting_minutes_envelope(uuid, uuid) TO ludy_tenant;
