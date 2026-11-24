-- SPDX-License-Identifier: AGPL-3.0-only
-- Store the canonical call meeting key (sha256 of org, platform, platform call id) on platform recording rows so
-- "already recorded" matching also works for members without a connected calendar (ADR-0055 section 3.4, issue #4572).
-- Never accepts or stores a raw join address. Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

ALTER TABLE ludy_kernel.meeting_platform_recording
  ADD COLUMN IF NOT EXISTS meeting_key text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'ludy_kernel.meeting_platform_recording'::pg_catalog.regclass
      AND conname = 'meeting_platform_recording_meeting_key_ck'
  ) THEN
    ALTER TABLE ludy_kernel.meeting_platform_recording
      ADD CONSTRAINT meeting_platform_recording_meeting_key_ck
      CHECK (meeting_key IS NULL OR meeting_key ~ '^[0-9a-f]{64}$');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS meeting_platform_recording_key_idx
  ON ludy_kernel.meeting_platform_recording (org_id, meeting_key)
  WHERE meeting_key IS NOT NULL;

-- Replace the sweep's suggestion writer in place (preserving signature, return type, and ludy_worker-only execute grant)
-- to validate and persist optional meetingKey (`^[0-9a-f]{64}$` or JSON null).
CREATE OR REPLACE FUNCTION ludy_kernel.meeting_platform_recording_replace(p_connection uuid, p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := ludy_kernel.meeting_platform_system();
  v_user uuid;
  v_ids text[];
  v_n integer;
BEGIN
  IF p_rows IS NULL OR pg_catalog.jsonb_typeof(p_rows) IS DISTINCT FROM 'array' OR pg_catalog.jsonb_array_length(p_rows) > 100 THEN
    RAISE EXCEPTION 'MEETING_PLATFORM_INVALID' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_rows) AS e(value)
    WHERE COALESCE(pg_catalog.jsonb_typeof(e.value -> 'id'), '') <> 'string'
       OR COALESCE(e.value ->> 'id', '') = ''
       OR pg_catalog.char_length(e.value ->> 'id') > 1024
       OR COALESCE(pg_catalog.jsonb_typeof(e.value -> 'startedAt'), '') <> 'string'
       OR (
         e.value ? 'meetingKey'
         AND pg_catalog.jsonb_typeof(e.value -> 'meetingKey') <> 'null'
         AND (
           pg_catalog.jsonb_typeof(e.value -> 'meetingKey') <> 'string'
           OR (e.value ->> 'meetingKey') !~ '^[0-9a-f]{64}$'
         )
       )
  ) THEN
    RAISE EXCEPTION 'MEETING_PLATFORM_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT c.user_id INTO v_user
  FROM ludy_kernel.meeting_platform_connection c
  WHERE c.org_id = v_org AND c.id = p_connection AND c.status = 'active'
  FOR SHARE;
  IF NOT FOUND THEN
    RETURN 0;
  END IF;
  SELECT pg_catalog.array_agg(e.value ->> 'id') INTO v_ids
  FROM pg_catalog.jsonb_array_elements(p_rows) AS e(value);
  DELETE FROM ludy_kernel.meeting_platform_recording r
  WHERE r.org_id = v_org AND r.connection_id = p_connection AND r.status = 'suggested'
    AND r.external_id <> ALL (COALESCE(v_ids, ARRAY[]::text[]));
  INSERT INTO ludy_kernel.meeting_platform_recording AS r (
    org_id, connection_id, user_id, external_id, title, started_at, length_seconds, size_bytes, has_audio, has_video, has_transcript, meeting_key
  )
  SELECT DISTINCT ON (e.value ->> 'id')
         v_org, p_connection, v_user, e.value ->> 'id',
         pg_catalog.left(COALESCE(e.value ->> 'title', ''), 200),
         (e.value ->> 'startedAt')::timestamptz,
         CASE WHEN COALESCE(e.value ->> 'lengthSeconds', '') ~ '^[0-9]{1,9}$' THEN (e.value ->> 'lengthSeconds')::integer END,
         CASE WHEN COALESCE(e.value ->> 'sizeBytes', '') ~ '^[0-9]{1,15}$' THEN (e.value ->> 'sizeBytes')::bigint END,
         COALESCE((e.value ->> 'hasAudio')::boolean, false),
         COALESCE((e.value ->> 'hasVideo')::boolean, false),
         COALESCE((e.value ->> 'hasTranscript')::boolean, false),
         CASE WHEN pg_catalog.jsonb_typeof(e.value -> 'meetingKey') = 'string' THEN e.value ->> 'meetingKey' END
  FROM pg_catalog.jsonb_array_elements(p_rows) AS e(value)
  ORDER BY e.value ->> 'id'
  ON CONFLICT ON CONSTRAINT meeting_platform_recording_uq DO UPDATE
    SET title = EXCLUDED.title,
        length_seconds = EXCLUDED.length_seconds,
        size_bytes = EXCLUDED.size_bytes,
        has_audio = EXCLUDED.has_audio,
        has_video = EXCLUDED.has_video,
        has_transcript = EXCLUDED.has_transcript,
        meeting_key = EXCLUDED.meeting_key,
        updated_at = pg_catalog.now()
    WHERE r.status = 'suggested';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  UPDATE ludy_kernel.meeting_platform_connection c
  SET last_synced_at = pg_catalog.now(), updated_at = pg_catalog.now()
  WHERE c.org_id = v_org AND c.id = p_connection;
  RETURN v_n;
END $$;

REVOKE ALL ON FUNCTION ludy_kernel.meeting_platform_recording_replace(uuid, jsonb) FROM PUBLIC;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE (rolname LIKE 'ludy\_%' OR rolname LIKE 'crove\_%') AND rolname <> current_user AND rolname <> 'ludy_worker' LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_kernel.meeting_platform_recording_replace(uuid, jsonb) FROM %I', r.rolname);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION ludy_kernel.meeting_platform_recording_replace(uuid, jsonb) TO ludy_worker;

