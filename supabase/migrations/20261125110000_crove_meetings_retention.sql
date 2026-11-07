-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove meetings M5 (issue #2579, ADR-0047 point 7, plan docs/plan/meetings.md section 9): retention and shredding of audio, video and text.
-- Idempotent; applied files stay untouched. The org's three settings (columns of crove_kernel.tenant) are in the migration before this one.
--
-- 1. crove_meetings.meeting.text_retention_date may be NULL: the org chose to keep text until a person deletes it.
-- 2. The recorder's UPDATE grant on the two retention dates is revoked: no command used it, and a recorder must not move the period the participants
--    were told. (The dates move through a definer in a later step: M4 moves them to the transcript's time.)
-- 3. The nightly job's worker-only definers, each pinned to pg_catalog, pg_temp, EXECUTE for the worker login alone, each answering ids, counts and dates:
--    meetings_due(limit)                the meetings whose audio, video or text period has ended, for the nightly job
--    meeting_shred(org, meeting, kind)  audio or video: deletes the kind's media_key row and its rows, once its date has come (the database checks it)
--    meeting_text_purge(org, meeting)   the text date has come: deletes the meeting with everything of it (rows, readers, keys), as the database checks
--    meeting_replay_shred(org, meeting) after a restore: deletes a meeting a shred reference names, whatever its dates
--    meetings_orphan_media(limit), meeting_media_discard(org, file)
--                                       the ciphertext file rows no segment or video row points at any more, and the delete of one (ADR-0047 point 7:
--                                       the objects go as the store allows); the worker deletes the object first, then the row
--    meetings_deleted_since(since)      the meetings a person deleted since a moment, read from the audit trail, for the shred references the worker
--                                       writes to the archive store (ADR-0017 section 8)
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1 and 2. Text kept until deleted; the retention dates are no longer the recorder's to write
-- ---------------------------------------------------------------------------
ALTER TABLE crove_meetings.meeting ALTER COLUMN text_retention_date DROP NOT NULL;
REVOKE UPDATE (audio_retention_date, text_retention_date) ON crove_meetings.meeting FROM crove_tenant;

-- ---------------------------------------------------------------------------
-- 3. The worker-only definers
-- ---------------------------------------------------------------------------

-- The meetings whose period has ended, oldest first. A meeting whose text date has come is listed once, as text (its purge takes the media too); otherwise its
-- audio, its video or both. Ids and a kind only; the worker runs each in the meeting's own org (meetings.retention.shred and .purge).
CREATE OR REPLACE FUNCTION crove_meetings.meetings_due(p_limit integer)
RETURNS TABLE (org_id uuid, meeting_id uuid, kind text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_today date := (pg_catalog.timezone('Asia/Ho_Chi_Minh', pg_catalog.now()))::date;
BEGIN
  IF (NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER')) OR crove_kernel.ctx_actor_type() IS NOT NULL THEN
    RAISE EXCEPTION 'MEETINGS_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT d.org_id, d.meeting_id, d.kind
  FROM (
    SELECT m.org_id, m.id AS meeting_id, 'text'::text AS kind, m.text_retention_date AS due
    FROM crove_meetings.meeting m
    WHERE m.text_retention_date IS NOT NULL AND m.text_retention_date <= v_today
    UNION ALL
    SELECT m.org_id, m.id, 'audio'::text, m.audio_retention_date
    FROM crove_meetings.meeting m
    WHERE m.audio_retention_date <= v_today
      AND (m.text_retention_date IS NULL OR m.text_retention_date > v_today)
      AND (EXISTS (SELECT 1 FROM crove_meetings.media_key k WHERE k.org_id = m.org_id AND k.meeting_id = m.id AND k.kind = 'audio')
           OR EXISTS (SELECT 1 FROM crove_meetings.audio_segment s WHERE s.org_id = m.org_id AND s.meeting_id = m.id))
    UNION ALL
    SELECT v.org_id, v.meeting_id, 'video'::text, v.video_retention_date
    FROM crove_meetings.meeting_video v
    JOIN crove_meetings.meeting m ON m.org_id = v.org_id AND m.id = v.meeting_id
    WHERE v.video_retention_date <= v_today
      AND (m.text_retention_date IS NULL OR m.text_retention_date > v_today)
  ) d
  ORDER BY d.due, d.org_id, d.meeting_id, d.kind
  LIMIT LEAST(GREATEST(p_limit, 1), 1000);
END;
$$;
REVOKE ALL ON FUNCTION crove_meetings.meetings_due(integer) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_meetings.meetings_due(integer) TO crove_worker;

-- Shreds the audio or the video of one meeting once its date has come: the key row goes (every copy of the ciphertext, current and old versions and bucket
-- backups, is unreadable from this commit on), and so do the segment or video rows, which leaves their file rows for the orphan sweep. Runs inside the system
-- command meetings.retention.shred, in the meeting's own org. The database checks the date, so a bug in the job can fail a run but never shred early.
-- Answers how many rows it deleted (0: not due, or already shredded).
CREATE OR REPLACE FUNCTION crove_meetings.meeting_shred(p_org_id uuid, p_meeting_id uuid, p_kind text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_today date := (pg_catalog.timezone('Asia/Ho_Chi_Minh', pg_catalog.now()))::date;
  v_n integer := 0;
  v_k integer;
BEGIN
  IF (NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER'))
     OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'system'
     OR crove_kernel.ctx_org_id() IS DISTINCT FROM p_org_id THEN
    RAISE EXCEPTION 'MEETINGS_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('audio', 'video') THEN
    RAISE EXCEPTION 'MEETINGS_BAD_KIND' USING ERRCODE = '22023';
  END IF;
  IF p_kind = 'audio' THEN
    IF NOT EXISTS (SELECT 1 FROM crove_meetings.meeting m WHERE m.org_id = p_org_id AND m.id = p_meeting_id AND m.audio_retention_date <= v_today) THEN
      RETURN 0;
    END IF;
    DELETE FROM crove_meetings.media_key WHERE org_id = p_org_id AND meeting_id = p_meeting_id AND kind = 'audio';
    GET DIAGNOSTICS v_k = ROW_COUNT;
    v_n := v_n + v_k;
    DELETE FROM crove_meetings.audio_segment WHERE org_id = p_org_id AND meeting_id = p_meeting_id;
    GET DIAGNOSTICS v_k = ROW_COUNT;
    v_n := v_n + v_k;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM crove_meetings.meeting_video v WHERE v.org_id = p_org_id AND v.meeting_id = p_meeting_id AND v.video_retention_date <= v_today) THEN
      -- Nothing to shred: no video row is due. (The key and the video row are written in one transaction, so a key never outlives its row; the text purge takes any key.)
      RETURN 0;
    END IF;
    DELETE FROM crove_meetings.media_key WHERE org_id = p_org_id AND meeting_id = p_meeting_id AND kind = 'video';
    GET DIAGNOSTICS v_k = ROW_COUNT;
    v_n := v_n + v_k;
    DELETE FROM crove_meetings.meeting_video WHERE org_id = p_org_id AND meeting_id = p_meeting_id;
    GET DIAGNOSTICS v_k = ROW_COUNT;
    v_n := v_n + v_k;
  END IF;
  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION crove_meetings.meeting_shred(uuid, uuid, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_meetings.meeting_shred(uuid, uuid, text) TO crove_worker;

-- Deletes a meeting whose text date has come, with everything of it: the keys first (the media is unreadable at once), then the media rows, then the meeting,
-- whose cascade takes the readers and every later text table. The consent record is kept as long as the text and goes with it (ADR-0047 point 6).
CREATE OR REPLACE FUNCTION crove_meetings.meeting_text_purge(p_org_id uuid, p_meeting_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_today date := (pg_catalog.timezone('Asia/Ho_Chi_Minh', pg_catalog.now()))::date;
BEGIN
  IF (NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER'))
     OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'system'
     OR crove_kernel.ctx_org_id() IS DISTINCT FROM p_org_id THEN
    RAISE EXCEPTION 'MEETINGS_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM crove_meetings.meeting m
    WHERE m.org_id = p_org_id AND m.id = p_meeting_id AND m.text_retention_date IS NOT NULL AND m.text_retention_date <= v_today
  ) THEN
    RETURN false;
  END IF;
  DELETE FROM crove_meetings.media_key WHERE org_id = p_org_id AND meeting_id = p_meeting_id;
  DELETE FROM crove_meetings.audio_segment WHERE org_id = p_org_id AND meeting_id = p_meeting_id;
  DELETE FROM crove_meetings.meeting_video WHERE org_id = p_org_id AND meeting_id = p_meeting_id;
  DELETE FROM crove_meetings.meeting WHERE org_id = p_org_id AND id = p_meeting_id;
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION crove_meetings.meeting_text_purge(uuid, uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_meetings.meeting_text_purge(uuid, uuid) TO crove_worker;

-- After a restore: deletes a meeting a shred reference of the archive store names, whatever its dates (a person deleted it before the restore point's
-- successor; the reference is the authority, and it names one meeting id, so a live meeting nobody deleted is never reached). Idempotent: false when it is gone.
CREATE OR REPLACE FUNCTION crove_meetings.meeting_replay_shred(p_org_id uuid, p_meeting_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER'))
     OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'system'
     OR crove_kernel.ctx_org_id() IS DISTINCT FROM p_org_id THEN
    RAISE EXCEPTION 'MEETINGS_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  DELETE FROM crove_meetings.media_key WHERE org_id = p_org_id AND meeting_id = p_meeting_id;
  DELETE FROM crove_meetings.audio_segment WHERE org_id = p_org_id AND meeting_id = p_meeting_id;
  DELETE FROM crove_meetings.meeting_video WHERE org_id = p_org_id AND meeting_id = p_meeting_id;
  DELETE FROM crove_meetings.meeting WHERE org_id = p_org_id AND id = p_meeting_id;
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION crove_meetings.meeting_replay_shred(uuid, uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_meetings.meeting_replay_shred(uuid, uuid) TO crove_worker;

-- The file rows of meeting media that no audio segment or video row names: the ciphertext of a deleted, expired or replayed meeting. Oldest first.
CREATE OR REPLACE FUNCTION crove_meetings.meetings_orphan_media(p_limit integer)
RETURNS TABLE (org_id uuid, file_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER')) OR crove_kernel.ctx_actor_type() IS NOT NULL THEN
    RAISE EXCEPTION 'MEETINGS_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT f.org_id, f.id
  FROM crove_kernel.file f
  WHERE f.source IN ('meeting_audio', 'meeting_video')
    AND NOT EXISTS (SELECT 1 FROM crove_meetings.audio_segment s WHERE s.org_id = f.org_id AND s.file_id = f.id)
    AND NOT EXISTS (SELECT 1 FROM crove_meetings.meeting_video v WHERE v.org_id = f.org_id AND v.file_id = f.id)
  ORDER BY f.created_at, f.id
  LIMIT LEAST(GREATEST(p_limit, 1), 1000);
END;
$$;
REVOKE ALL ON FUNCTION crove_meetings.meetings_orphan_media(integer) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_meetings.meetings_orphan_media(integer) TO crove_worker;

-- Deletes one orphan file row (the worker deleted its object first). Refuses a row that a segment or video row still names, or that is not meeting media,
-- so the worker cannot delete another file through it. Inside the system command meetings.media.discard, in the file's own org.
CREATE OR REPLACE FUNCTION crove_meetings.meeting_media_discard(p_org_id uuid, p_file_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER'))
     OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'system'
     OR crove_kernel.ctx_org_id() IS DISTINCT FROM p_org_id THEN
    RAISE EXCEPTION 'MEETINGS_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  DELETE FROM crove_kernel.file f
  WHERE f.org_id = p_org_id AND f.id = p_file_id AND f.source IN ('meeting_audio', 'meeting_video')
    AND NOT EXISTS (SELECT 1 FROM crove_meetings.audio_segment s WHERE s.org_id = f.org_id AND s.file_id = f.id)
    AND NOT EXISTS (SELECT 1 FROM crove_meetings.meeting_video v WHERE v.org_id = f.org_id AND v.file_id = f.id);
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION crove_meetings.meeting_media_discard(uuid, uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_meetings.meeting_media_discard(uuid, uuid) TO crove_worker;

-- The meetings a person deleted (the recorder, or an owner for a personal-data request) since a moment, from the audit trail: the worker writes a shred
-- reference to the archive store for each, so a restore to a point before the deletion can delete it again (ADR-0017 section 8). Ids and a time only.
CREATE OR REPLACE FUNCTION crove_meetings.meetings_deleted_since(p_since timestamptz)
RETURNS TABLE (org_id uuid, meeting_id uuid, occurred_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER')) OR crove_kernel.ctx_actor_type() IS NOT NULL THEN
    RAISE EXCEPTION 'MEETINGS_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT a.org_id, a.target_id, a.occurred_at
  FROM crove_kernel.audit_event a
  WHERE a.occurred_at >= p_since
    AND a.command IN ('meetings.meeting.delete', 'meetings.meeting.owner_delete')
    AND a.outcome = 'ok'
    AND a.target_type = 'meetings.meeting'
    AND a.target_id IS NOT NULL
  ORDER BY a.occurred_at, a.id
  LIMIT 10000;
END;
$$;
REVOKE ALL ON FUNCTION crove_meetings.meetings_deleted_since(timestamptz) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_meetings.meetings_deleted_since(timestamptz) TO crove_worker;
