-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove meetings (issue #2576, ADR-0047, plan docs/plan/meetings.md section 15 step M2): meeting records with encrypted
-- audio and video, consent records, and reader-gated access. Idempotent; applied files stay untouched.
--
-- crove_meetings.meeting         a recorded meeting: title, language, duration, visibility (attendees or org), consent confirmation,
--                                and retention dates. Written by its recorder; updated by recorder or org owner/admin; deleted by recorder.
-- crove_meetings.meeting_reader  explicit attendee readers for an attendees-only meeting. Managed by the meeting recorder.
-- crove_meetings.audio_segment   normalized audio chunks of a meeting, backed by ciphertext files in crove_kernel.file.
-- crove_meetings.meeting_video   optional kept video of a meeting, backed by ciphertext file in crove_kernel.file.
-- crove_meetings.media_key       wrapped AES-256-GCM data keys for meeting audio and video. Definer-only (MACHINERY), zero grants to login roles.
SET LOCAL lock_timeout = '2s';

-- Expand file source check for meeting media
ALTER TABLE crove_kernel.file DROP CONSTRAINT IF EXISTS file_source_check;
ALTER TABLE crove_kernel.file ADD CONSTRAINT file_source_check CHECK (source IN ('upload', 'email', 'social', 'import', 'meeting_audio', 'meeting_video'));

CREATE SCHEMA IF NOT EXISTS crove_meetings;
GRANT USAGE ON SCHEMA crove_meetings TO crove_tenant;

-- ---------------------------------------------------------------------------
-- 1. Meeting core table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_meetings.meeting (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  recorder_user_id uuid NOT NULL,
  visibility text NOT NULL DEFAULT 'attendees' CHECK (visibility IN ('attendees', 'org')),
  title text NOT NULL CHECK (pg_catalog.length(title) BETWEEN 1 AND 200),
  language text NOT NULL DEFAULT 'vi' CHECK (language IN ('vi', 'en')),
  status text NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'processing', 'completed', 'error')),
  started_at timestamptz,
  ended_at timestamptz,
  length_seconds integer CHECK (length_seconds IS NULL OR length_seconds >= 0),
  keep_video boolean NOT NULL DEFAULT false,
  consent_method text NOT NULL CHECK (consent_method IN ('told_at_start', 'in_invite', 'in_writing')),
  consent_confirmed_by uuid NOT NULL,
  consent_confirmed_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  consent_notice_version text NOT NULL DEFAULT '1.0' CHECK (pg_catalog.length(consent_notice_version) <= 20),
  audio_retention_date date NOT NULL,
  text_retention_date date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id)
);
CREATE INDEX IF NOT EXISTS meeting_recorder_idx ON crove_meetings.meeting (org_id, recorder_user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS meeting_started_idx ON crove_meetings.meeting (org_id, started_at DESC);
CREATE INDEX IF NOT EXISTS meeting_audio_retention_idx ON crove_meetings.meeting (audio_retention_date);
CREATE INDEX IF NOT EXISTS meeting_text_retention_idx ON crove_meetings.meeting (text_retention_date);

SELECT crove_kernel.apply_tenant_rls('crove_meetings.meeting');
REVOKE UPDATE, DELETE ON crove_meetings.meeting FROM crove_tenant;
GRANT UPDATE (title, language, visibility, status, ended_at, length_seconds, keep_video, updated_at, audio_retention_date, text_retention_date) ON crove_meetings.meeting TO crove_tenant;
GRANT DELETE ON crove_meetings.meeting TO crove_tenant;

-- ---------------------------------------------------------------------------
-- 2. Meeting reader table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_meetings.meeting_reader (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  meeting_id uuid NOT NULL,
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT meeting_reader_meeting_fk FOREIGN KEY (org_id, meeting_id) REFERENCES crove_meetings.meeting (org_id, id) ON DELETE CASCADE,
  CONSTRAINT meeting_reader_uq UNIQUE (org_id, meeting_id, user_id)
);
CREATE INDEX IF NOT EXISTS meeting_reader_meeting_idx ON crove_meetings.meeting_reader (org_id, meeting_id);
CREATE INDEX IF NOT EXISTS meeting_reader_user_idx ON crove_meetings.meeting_reader (org_id, user_id);

SELECT crove_kernel.apply_tenant_rls('crove_meetings.meeting_reader');
REVOKE UPDATE ON crove_meetings.meeting_reader FROM crove_tenant;

-- ---------------------------------------------------------------------------
-- 3. Audio segment table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_meetings.audio_segment (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  meeting_id uuid NOT NULL,
  file_id uuid NOT NULL,
  segment_order integer NOT NULL CHECK (segment_order >= 0),
  start_offset_seconds integer NOT NULL DEFAULT 0 CHECK (start_offset_seconds >= 0),
  length_seconds integer NOT NULL CHECK (length_seconds > 0),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT audio_segment_meeting_fk FOREIGN KEY (org_id, meeting_id) REFERENCES crove_meetings.meeting (org_id, id) ON DELETE CASCADE,
  CONSTRAINT audio_segment_file_fk FOREIGN KEY (org_id, file_id) REFERENCES crove_kernel.file (org_id, id) ON DELETE CASCADE,
  CONSTRAINT audio_segment_order_uq UNIQUE (org_id, meeting_id, segment_order)
);
CREATE INDEX IF NOT EXISTS audio_segment_meeting_idx ON crove_meetings.audio_segment (org_id, meeting_id);
CREATE INDEX IF NOT EXISTS audio_segment_file_idx ON crove_meetings.audio_segment (org_id, file_id);

SELECT crove_kernel.apply_tenant_rls('crove_meetings.audio_segment');
REVOKE UPDATE ON crove_meetings.audio_segment FROM crove_tenant;

-- ---------------------------------------------------------------------------
-- 4. Meeting video table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_meetings.meeting_video (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  meeting_id uuid NOT NULL,
  file_id uuid NOT NULL,
  length_seconds integer NOT NULL CHECK (length_seconds > 0),
  video_retention_date date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT meeting_video_meeting_fk FOREIGN KEY (org_id, meeting_id) REFERENCES crove_meetings.meeting (org_id, id) ON DELETE CASCADE,
  CONSTRAINT meeting_video_file_fk FOREIGN KEY (org_id, file_id) REFERENCES crove_kernel.file (org_id, id) ON DELETE CASCADE,
  CONSTRAINT meeting_video_meeting_uq UNIQUE (org_id, meeting_id)
);
CREATE INDEX IF NOT EXISTS meeting_video_meeting_idx ON crove_meetings.meeting_video (org_id, meeting_id);
CREATE INDEX IF NOT EXISTS meeting_video_file_idx ON crove_meetings.meeting_video (org_id, file_id);
CREATE INDEX IF NOT EXISTS meeting_video_retention_idx ON crove_meetings.meeting_video (video_retention_date);

SELECT crove_kernel.apply_tenant_rls('crove_meetings.meeting_video');
REVOKE UPDATE ON crove_meetings.meeting_video FROM crove_tenant;

-- ---------------------------------------------------------------------------
-- 5. Media key table (MACHINERY - Definer-only, zero grants)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_meetings.media_key (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  meeting_id uuid NOT NULL,
  key_id text NOT NULL CHECK (pg_catalog.length(key_id) <= 64),
  kind text NOT NULL CHECK (kind IN ('audio', 'video')),
  wrapped_key bytea NOT NULL CHECK (pg_catalog.octet_length(wrapped_key) = 60),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT media_key_meeting_fk FOREIGN KEY (org_id, meeting_id) REFERENCES crove_meetings.meeting (org_id, id) ON DELETE CASCADE,
  CONSTRAINT media_key_meeting_kind_uq UNIQUE (org_id, meeting_id, kind)
);
CREATE INDEX IF NOT EXISTS media_key_meeting_idx ON crove_meetings.media_key (org_id, meeting_id);

SELECT crove_kernel.apply_tenant_rls('crove_meetings.media_key');
REVOKE ALL ON crove_meetings.media_key FROM PUBLIC, crove_tenant, crove_app, crove_worker;
CREATE POLICY media_key_machinery ON crove_meetings.media_key AS RESTRICTIVE FOR ALL TO crove_tenant USING (false) WITH CHECK (false);

-- ---------------------------------------------------------------------------
-- 6. Restrictive RLS policies
-- ---------------------------------------------------------------------------

-- Meeting policies
DROP POLICY IF EXISTS meeting_read ON crove_meetings.meeting;
CREATE POLICY meeting_read ON crove_meetings.meeting AS RESTRICTIVE FOR SELECT TO crove_tenant
  USING (
    recorder_user_id = (SELECT crove_kernel.ctx_user_id())
    OR (
      visibility = 'org'
      AND '*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[])
      AND EXISTS (
        SELECT 1 FROM crove_kernel.tenant_member m
        WHERE m.org_id = meeting.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member')
      )
    )
    OR EXISTS (
      SELECT 1 FROM crove_meetings.meeting_reader r
      WHERE r.org_id = meeting.org_id AND r.meeting_id = meeting.id AND r.user_id = (SELECT crove_kernel.ctx_user_id())
    )
  );

DROP POLICY IF EXISTS meeting_insert ON crove_meetings.meeting;
CREATE POLICY meeting_insert ON crove_meetings.meeting AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK (
    recorder_user_id = (SELECT crove_kernel.ctx_user_id())
    AND consent_confirmed_by = (SELECT crove_kernel.ctx_user_id())
    AND '*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[])
    AND EXISTS (
      SELECT 1 FROM crove_kernel.tenant_member m
      WHERE m.org_id = meeting.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member')
    )
  );

DROP POLICY IF EXISTS meeting_update ON crove_meetings.meeting;
CREATE POLICY meeting_update ON crove_meetings.meeting AS RESTRICTIVE FOR UPDATE TO crove_tenant
  USING (
    recorder_user_id = (SELECT crove_kernel.ctx_user_id())
    OR (
      visibility = 'org'
      AND '*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[])
      AND EXISTS (
        SELECT 1 FROM crove_kernel.tenant_member m
        WHERE m.org_id = meeting.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin')
      )
    )
  )
  WITH CHECK (
    recorder_user_id = (SELECT crove_kernel.ctx_user_id())
    OR (
      visibility = 'org'
      AND '*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[])
      AND EXISTS (
        SELECT 1 FROM crove_kernel.tenant_member m
        WHERE m.org_id = meeting.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin')
      )
    )
  );

DROP POLICY IF EXISTS meeting_delete ON crove_meetings.meeting;
CREATE POLICY meeting_delete ON crove_meetings.meeting AS RESTRICTIVE FOR DELETE TO crove_tenant
  USING (recorder_user_id = (SELECT crove_kernel.ctx_user_id()));

-- Meeting reader policies
DROP POLICY IF EXISTS meeting_reader_read ON crove_meetings.meeting_reader;
CREATE POLICY meeting_reader_read ON crove_meetings.meeting_reader AS RESTRICTIVE FOR SELECT TO crove_tenant
  USING (
    user_id = (SELECT crove_kernel.ctx_user_id())
    OR EXISTS (
      SELECT 1 FROM crove_meetings.meeting m
      WHERE m.org_id = meeting_reader.org_id AND m.id = meeting_reader.meeting_id AND m.recorder_user_id = (SELECT crove_kernel.ctx_user_id())
    )
  );

DROP POLICY IF EXISTS meeting_reader_insert ON crove_meetings.meeting_reader;
CREATE POLICY meeting_reader_insert ON crove_meetings.meeting_reader AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM crove_meetings.meeting m
      WHERE m.org_id = meeting_reader.org_id AND m.id = meeting_reader.meeting_id AND m.recorder_user_id = (SELECT crove_kernel.ctx_user_id())
    )
  );

DROP POLICY IF EXISTS meeting_reader_delete ON crove_meetings.meeting_reader;
CREATE POLICY meeting_reader_delete ON crove_meetings.meeting_reader AS RESTRICTIVE FOR DELETE TO crove_tenant
  USING (
    EXISTS (
      SELECT 1 FROM crove_meetings.meeting m
      WHERE m.org_id = meeting_reader.org_id AND m.id = meeting_reader.meeting_id AND m.recorder_user_id = (SELECT crove_kernel.ctx_user_id())
    )
  );

-- Audio segment policies
DROP POLICY IF EXISTS audio_segment_read ON crove_meetings.audio_segment;
CREATE POLICY audio_segment_read ON crove_meetings.audio_segment AS RESTRICTIVE FOR SELECT TO crove_tenant
  USING (EXISTS (SELECT 1 FROM crove_meetings.meeting m WHERE m.org_id = audio_segment.org_id AND m.id = audio_segment.meeting_id));

DROP POLICY IF EXISTS audio_segment_insert ON crove_meetings.audio_segment;
CREATE POLICY audio_segment_insert ON crove_meetings.audio_segment AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM crove_meetings.meeting m
      WHERE m.org_id = audio_segment.org_id AND m.id = audio_segment.meeting_id AND m.recorder_user_id = (SELECT crove_kernel.ctx_user_id())
    )
  );

DROP POLICY IF EXISTS audio_segment_delete ON crove_meetings.audio_segment;
CREATE POLICY audio_segment_delete ON crove_meetings.audio_segment AS RESTRICTIVE FOR DELETE TO crove_tenant
  USING (
    EXISTS (
      SELECT 1 FROM crove_meetings.meeting m
      WHERE m.org_id = audio_segment.org_id AND m.id = audio_segment.meeting_id AND m.recorder_user_id = (SELECT crove_kernel.ctx_user_id())
    )
  );

-- Meeting video policies
DROP POLICY IF EXISTS meeting_video_read ON crove_meetings.meeting_video;
CREATE POLICY meeting_video_read ON crove_meetings.meeting_video AS RESTRICTIVE FOR SELECT TO crove_tenant
  USING (EXISTS (SELECT 1 FROM crove_meetings.meeting m WHERE m.org_id = meeting_video.org_id AND m.id = meeting_video.meeting_id));

DROP POLICY IF EXISTS meeting_video_insert ON crove_meetings.meeting_video;
CREATE POLICY meeting_video_insert ON crove_meetings.meeting_video AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM crove_meetings.meeting m
      WHERE m.org_id = meeting_video.org_id AND m.id = meeting_video.meeting_id AND m.recorder_user_id = (SELECT crove_kernel.ctx_user_id())
    )
  );

DROP POLICY IF EXISTS meeting_video_delete ON crove_meetings.meeting_video;
CREATE POLICY meeting_video_delete ON crove_meetings.meeting_video AS RESTRICTIVE FOR DELETE TO crove_tenant
  USING (
    EXISTS (
      SELECT 1 FROM crove_meetings.meeting m
      WHERE m.org_id = meeting_video.org_id AND m.id = meeting_video.meeting_id AND m.recorder_user_id = (SELECT crove_kernel.ctx_user_id())
    )
  );

-- ---------------------------------------------------------------------------
-- 7. Security Definer functions (search_path = pg_catalog, pg_temp, no public exec)
-- ---------------------------------------------------------------------------

-- Check if user is a reader of a meeting
CREATE OR REPLACE FUNCTION crove_meetings.is_meeting_reader(
  p_org_id uuid,
  p_meeting_id uuid,
  p_user_id uuid
) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_vis text;
  v_recorder uuid;
BEGIN
  IF p_user_id IS NULL OR p_meeting_id IS NULL OR p_org_id IS NULL THEN
    RETURN false;
  END IF;
  SELECT visibility, recorder_user_id INTO v_vis, v_recorder
  FROM crove_meetings.meeting
  WHERE org_id = p_org_id AND id = p_meeting_id;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF v_recorder = p_user_id THEN
    RETURN true;
  END IF;
  IF v_vis = 'org' THEN
    IF '*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) AND EXISTS (
      SELECT 1 FROM crove_kernel.tenant_member m
      WHERE m.org_id = p_org_id AND m.user_id = p_user_id AND m.role IN ('owner', 'admin', 'member')
    ) THEN
      RETURN true;
    END IF;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM crove_meetings.meeting_reader r
    WHERE r.org_id = p_org_id AND r.meeting_id = p_meeting_id AND r.user_id = p_user_id
  );
END;
$$;
REVOKE ALL ON FUNCTION crove_meetings.is_meeting_reader(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_meetings.is_meeting_reader(uuid, uuid, uuid) TO crove_tenant;

-- Seal media key
CREATE OR REPLACE FUNCTION crove_meetings.media_key_seal(
  p_org_id uuid,
  p_meeting_id uuid,
  p_key_id text,
  p_kind text,
  p_wrapped_key bytea
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO crove_meetings.media_key (org_id, id, meeting_id, key_id, kind, wrapped_key)
  VALUES (p_org_id, crove_kernel.uuid_v7(), p_meeting_id, p_key_id, p_kind, p_wrapped_key)
  ON CONFLICT (org_id, meeting_id, kind)
  DO UPDATE SET key_id = EXCLUDED.key_id, wrapped_key = EXCLUDED.wrapped_key
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION crove_meetings.media_key_seal(uuid, uuid, text, text, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_meetings.media_key_seal(uuid, uuid, text, text, bytea) TO crove_tenant;

-- Read media key (readers only)
CREATE OR REPLACE FUNCTION crove_meetings.media_key_read(
  p_org_id uuid,
  p_meeting_id uuid,
  p_kind text
) RETURNS TABLE (key_id text, wrapped_key bytea)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT (
    crove_meetings.is_meeting_reader(p_org_id, p_meeting_id, crove_kernel.ctx_user_id())
    OR (crove_kernel.ctx_actor_type() = 'system' AND pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER'))
  ) THEN
    RAISE EXCEPTION 'MEETINGS_NOT_READER' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT k.key_id, k.wrapped_key
  FROM crove_meetings.media_key k
  WHERE k.org_id = p_org_id AND k.meeting_id = p_meeting_id AND k.kind = p_kind;
END;
$$;
REVOKE ALL ON FUNCTION crove_meetings.media_key_read(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_meetings.media_key_read(uuid, uuid, text) TO crove_tenant;

-- Shred media key (crypto-shredding)
CREATE OR REPLACE FUNCTION crove_meetings.media_key_shred(
  p_org_id uuid,
  p_meeting_id uuid,
  p_kind text DEFAULT NULL
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_count integer;
BEGIN
  IF NOT (
    EXISTS (SELECT 1 FROM crove_meetings.meeting m WHERE m.org_id = p_org_id AND m.id = p_meeting_id AND m.recorder_user_id = crove_kernel.ctx_user_id())
    OR (
      '*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) AND EXISTS (
        SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = p_org_id AND m.user_id = crove_kernel.ctx_user_id() AND m.role IN ('owner', 'admin')
      )
    )
    OR (crove_kernel.ctx_actor_type() = 'system' AND pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER'))
  ) THEN
    RAISE EXCEPTION 'MEETINGS_NOT_ALLOWED' USING ERRCODE = '42501';
  END IF;

  DELETE FROM crove_meetings.media_key
  WHERE org_id = p_org_id AND meeting_id = p_meeting_id
    AND (p_kind IS NULL OR kind = p_kind);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION crove_meetings.media_key_shred(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_meetings.media_key_shred(uuid, uuid, text) TO crove_tenant;

-- Reseal pass: scan media keys under older key id
CREATE OR REPLACE FUNCTION crove_meetings.media_key_reseal_due(
  p_current_key_id text,
  p_limit integer,
  p_after_created timestamptz DEFAULT NULL,
  p_after_id uuid DEFAULT NULL
)
RETURNS TABLE (org_id uuid, id uuid, meeting_id uuid, key_id text, kind text, wrapped_key bytea, created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'MEETINGS_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT k.org_id, k.id, k.meeting_id, k.key_id, k.kind, k.wrapped_key, k.created_at
  FROM crove_meetings.media_key k
  WHERE k.key_id <> p_current_key_id
    AND (
      p_after_created IS NULL
      OR (k.created_at, k.id) > (p_after_created, p_after_id)
    )
  ORDER BY k.created_at ASC, k.id ASC
  LIMIT LEAST(GREATEST(p_limit, 1), 1000);
END;
$$;
REVOKE ALL ON FUNCTION crove_meetings.media_key_reseal_due(text, integer, timestamptz, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_meetings.media_key_reseal_due(text, integer, timestamptz, uuid) TO crove_worker;

-- Reseal pass: update single media key with new envelope
CREATE OR REPLACE FUNCTION crove_meetings.media_key_reseal(
  p_org_id uuid,
  p_id uuid,
  p_from_key_id text,
  p_to_key_id text,
  p_wrapped_key bytea
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'MEETINGS_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;

  UPDATE crove_meetings.media_key
  SET key_id = p_to_key_id,
      wrapped_key = p_wrapped_key
  WHERE org_id = p_org_id AND id = p_id AND key_id = p_from_key_id;
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION crove_meetings.media_key_reseal(uuid, uuid, text, text, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_meetings.media_key_reseal(uuid, uuid, text, text, bytea) TO crove_worker;

-- Reseal pass: counts by key_id
CREATE OR REPLACE FUNCTION crove_meetings.media_key_counts()
RETURNS TABLE (key_id text, active bigint, inactive bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'MEETINGS_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT k.key_id,
         COUNT(*)::bigint AS active,
         0::bigint AS inactive
  FROM crove_meetings.media_key k
  GROUP BY k.key_id;
END;
$$;
REVOKE ALL ON FUNCTION crove_meetings.media_key_counts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_meetings.media_key_counts() TO crove_worker;

-- Owner compliance list (metadata only, no meeting text)
CREATE OR REPLACE FUNCTION crove_meetings.meeting_owner_list(
  p_org_id uuid,
  p_limit integer DEFAULT 50,
  p_after_started timestamptz DEFAULT NULL,
  p_after_id uuid DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  started_at timestamptz,
  length_seconds integer,
  recorder_user_id uuid,
  audio_retention_date date,
  text_retention_date date
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT (
    '*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) AND EXISTS (
      SELECT 1 FROM crove_kernel.tenant_member m
      WHERE m.org_id = p_org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin')
    )
  ) THEN
    RAISE EXCEPTION 'MEETINGS_OWNER_ONLY' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT m.id, m.started_at, m.length_seconds, m.recorder_user_id, m.audio_retention_date, m.text_retention_date
  FROM crove_meetings.meeting m
  WHERE m.org_id = p_org_id
    AND (
      p_after_started IS NULL
      OR (m.started_at, m.id) < (p_after_started, p_after_id)
    )
  ORDER BY m.started_at DESC NULLS LAST, m.id DESC
  LIMIT LEAST(GREATEST(p_limit, 1), 200);
END;
$$;
REVOKE ALL ON FUNCTION crove_meetings.meeting_owner_list(uuid, integer, timestamptz, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_meetings.meeting_owner_list(uuid, integer, timestamptz, uuid) TO crove_tenant;

-- Owner personal data deletion (without reading meeting text)
CREATE OR REPLACE FUNCTION crove_meetings.meeting_owner_delete(
  p_org_id uuid,
  p_meeting_id uuid
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT (
    '*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) AND EXISTS (
      SELECT 1 FROM crove_kernel.tenant_member m
      WHERE m.org_id = p_org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin')
    )
  ) THEN
    RAISE EXCEPTION 'MEETINGS_OWNER_ONLY' USING ERRCODE = '42501';
  END IF;

  DELETE FROM crove_meetings.meeting WHERE org_id = p_org_id AND id = p_meeting_id;
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION crove_meetings.meeting_owner_delete(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_meetings.meeting_owner_delete(uuid, uuid) TO crove_tenant;
