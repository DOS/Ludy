-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove meetings L4a-1 (issue #3109, ADR-0052 decision 2, ADR-0047 points 4 and 7): live notes capture. While a meeting the recorder opted into live notes
-- is recorded, the recorder sends pieces of about 15 seconds. Each piece is sealed by the upload route under its own data key (a media_key row of kind
-- live:<seq>, wrapped like the audio key, so the reseal pass and the shred already cover it), its ciphertext is a meeting_audio file row, and this table names it.
-- The final recording is uploaded as before and replaces the pieces (live_chunk_discard), so the audio is kept once. Idempotent; applied files stay untouched.
--
-- 1. crove_meetings.meeting.live_notes: the opt-in, set when the meeting is created and never changed (no UPDATE grant, the same as the retention dates).
-- 2. crove_meetings.media_key.kind also takes live:<seq> (seq 0 to 999).
-- 3. crove_meetings.live_chunk: one row per piece (order, file, size, the recorder's own length). Metadata only, no key and no text. Only the recorder reads it.
-- 4. live_chunk_discard(org, meeting): the recorder's definer that deletes a meeting's pieces and their keys (the final audio was recorded).
-- 5. The retention definers restated from 20261125110000 with the pieces added: meetings_due and meeting_shred (a meeting that never got its final audio still
--    has its pieces shredded at its audio date), meetings_orphan_media and meeting_media_discard (a piece's file row is no orphan while a live_chunk row names it).
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. The opt-in
-- ---------------------------------------------------------------------------
ALTER TABLE crove_meetings.meeting ADD COLUMN IF NOT EXISTS live_notes boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- 2. Media keys of live pieces
-- ---------------------------------------------------------------------------
ALTER TABLE crove_meetings.media_key DROP CONSTRAINT IF EXISTS media_key_kind_check;
ALTER TABLE crove_meetings.media_key ADD CONSTRAINT media_key_kind_check CHECK (kind IN ('audio', 'video') OR kind OPERATOR(pg_catalog.~) '^live:[0-9]{1,3}$');

-- ---------------------------------------------------------------------------
-- 3. The pieces
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_meetings.live_chunk (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  meeting_id uuid NOT NULL,
  seq integer NOT NULL CHECK (seq >= 0 AND seq < 1000),
  file_id uuid NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  length_seconds integer NOT NULL CHECK (length_seconds BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT live_chunk_meeting_fk FOREIGN KEY (org_id, meeting_id) REFERENCES crove_meetings.meeting (org_id, id) ON DELETE CASCADE,
  CONSTRAINT live_chunk_file_fk FOREIGN KEY (org_id, file_id) REFERENCES crove_kernel.file (org_id, id) ON DELETE CASCADE,
  CONSTRAINT live_chunk_seq_uq UNIQUE (org_id, meeting_id, seq)
);
CREATE INDEX IF NOT EXISTS live_chunk_file_idx ON crove_meetings.live_chunk (org_id, file_id);

SELECT crove_kernel.apply_tenant_rls('crove_meetings.live_chunk');
REVOKE UPDATE ON crove_meetings.live_chunk FROM crove_tenant;

-- Only the recorder reads, writes or deletes a piece: an attendee, an owner or an admin who is no recorder sees none (the meeting's audio is theirs to read, the live pieces are not).
DROP POLICY IF EXISTS live_chunk_read ON crove_meetings.live_chunk;
CREATE POLICY live_chunk_read ON crove_meetings.live_chunk AS RESTRICTIVE FOR SELECT TO crove_tenant
  USING (crove_meetings.is_meeting_recorder(org_id, meeting_id));

DROP POLICY IF EXISTS live_chunk_insert ON crove_meetings.live_chunk;
CREATE POLICY live_chunk_insert ON crove_meetings.live_chunk AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK (
    crove_meetings.is_meeting_recorder(org_id, meeting_id)
    AND crove_meetings.is_own_meeting_media_file(org_id, file_id, 'audio')
  );

DROP POLICY IF EXISTS live_chunk_delete ON crove_meetings.live_chunk;
CREATE POLICY live_chunk_delete ON crove_meetings.live_chunk AS RESTRICTIVE FOR DELETE TO crove_tenant
  USING (crove_meetings.is_meeting_recorder(org_id, meeting_id));

-- ---------------------------------------------------------------------------
-- 4. The final audio was recorded: the pieces and their keys go
-- ---------------------------------------------------------------------------
-- The keys first, so the ciphertext is unreadable from this commit; the pieces' file rows are then orphans and the worker's sweep deletes the objects. Answers
-- how many pieces it deleted. Runs inside meetings.media.record (and the meeting's own commands), as the recorder, in the app login.
CREATE OR REPLACE FUNCTION crove_meetings.live_chunk_discard(p_org_id uuid, p_meeting_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_user uuid := crove_kernel.ctx_user_id();
  v_actor text := crove_kernel.ctx_actor_type();
  v_n integer;
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_app', 'MEMBER') THEN
    RAISE EXCEPTION 'MEETINGS_APP_ONLY' USING ERRCODE = '42501';
  END IF;
  IF v_org IS NULL OR p_org_id IS DISTINCT FROM v_org OR v_actor IS DISTINCT FROM 'user' OR v_user IS NULL THEN
    RAISE EXCEPTION 'MEETINGS_NOT_ALLOWED' USING ERRCODE = '42501';
  END IF;
  IF NOT crove_meetings.is_meeting_recorder(v_org, p_meeting_id) THEN
    RAISE EXCEPTION 'MEETINGS_NOT_RECORDER' USING ERRCODE = '42501';
  END IF;
  DELETE FROM crove_meetings.media_key WHERE org_id = v_org AND meeting_id = p_meeting_id AND kind OPERATOR(pg_catalog.~) '^live:[0-9]{1,3}$';
  DELETE FROM crove_meetings.live_chunk WHERE org_id = v_org AND meeting_id = p_meeting_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION crove_meetings.live_chunk_discard(uuid, uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_meetings.live_chunk_discard(uuid, uuid) TO crove_app;

-- ---------------------------------------------------------------------------
-- 5. The retention definers, with the pieces
-- ---------------------------------------------------------------------------
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
           OR EXISTS (SELECT 1 FROM crove_meetings.audio_segment s WHERE s.org_id = m.org_id AND s.meeting_id = m.id)
           OR EXISTS (SELECT 1 FROM crove_meetings.live_chunk c WHERE c.org_id = m.org_id AND c.meeting_id = m.id))
    UNION ALL
    SELECT v.org_id, v.meeting_id, 'video'::text, v.video_retention_date
    FROM crove_meetings.meeting_video v
    JOIN crove_meetings.meeting m ON m.org_id = v.org_id AND m.id = v.meeting_id
    WHERE v.video_retention_date <= v_today
      AND (m.text_retention_date IS NULL OR m.text_retention_date > v_today)
  ) d
  -- Only orgs a system context can enter (active, or offboarding before its purge): a closed org's rows would fail every run.
  JOIN crove_kernel.tenant t ON t.org_id = d.org_id AND t.status IN ('active', 'offboarding')
  ORDER BY d.due, d.org_id, d.meeting_id, d.kind
  LIMIT LEAST(GREATEST(p_limit, 1), 1000);
END;
$$;
REVOKE ALL ON FUNCTION crove_meetings.meetings_due(integer) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_meetings.meetings_due(integer) TO crove_worker;

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
    -- The live chunks of a meeting (ADR-0052 L4a) are audio too: their keys go with the audio key, so they are unreadable from the same commit.
    DELETE FROM crove_meetings.media_key WHERE org_id = p_org_id AND meeting_id = p_meeting_id AND (kind = 'audio' OR kind OPERATOR(pg_catalog.~) '^live:[0-9]{1,3}$');
    GET DIAGNOSTICS v_k = ROW_COUNT;
    v_n := v_n + v_k;
    DELETE FROM crove_meetings.audio_segment WHERE org_id = p_org_id AND meeting_id = p_meeting_id;
    GET DIAGNOSTICS v_k = ROW_COUNT;
    v_n := v_n + v_k;
    DELETE FROM crove_meetings.live_chunk WHERE org_id = p_org_id AND meeting_id = p_meeting_id;
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
  JOIN crove_kernel.tenant t ON t.org_id = f.org_id AND t.status IN ('active', 'offboarding')
  WHERE f.source IN ('meeting_audio', 'meeting_video')
    AND NOT EXISTS (SELECT 1 FROM crove_meetings.audio_segment s WHERE s.org_id = f.org_id AND s.file_id = f.id)
    AND NOT EXISTS (SELECT 1 FROM crove_meetings.meeting_video v WHERE v.org_id = f.org_id AND v.file_id = f.id)
    AND NOT EXISTS (SELECT 1 FROM crove_meetings.live_chunk c WHERE c.org_id = f.org_id AND c.file_id = f.id)
  ORDER BY f.created_at, f.id
  LIMIT LEAST(GREATEST(p_limit, 1), 1000);
END;
$$;
REVOKE ALL ON FUNCTION crove_meetings.meetings_orphan_media(integer) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_meetings.meetings_orphan_media(integer) TO crove_worker;

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
    AND NOT EXISTS (SELECT 1 FROM crove_meetings.meeting_video v WHERE v.org_id = f.org_id AND v.file_id = f.id)
    AND NOT EXISTS (SELECT 1 FROM crove_meetings.live_chunk c WHERE c.org_id = f.org_id AND c.file_id = f.id);
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION crove_meetings.meeting_media_discard(uuid, uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_meetings.meeting_media_discard(uuid, uuid) TO crove_worker;
