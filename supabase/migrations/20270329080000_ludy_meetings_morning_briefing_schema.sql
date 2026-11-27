-- SPDX-License-Identifier: AGPL-3.0-only
-- Morning briefing schema and helper primitives (#5080 Slice A1, ADR-0049 amendment):
--   1. Extend ludy_meetings.morning_notice with enabled, content ('count' | 'full'), and vy_lines flags.
--   2. Create ludy_meetings.morning_brief_lines (36h short-lived prep lines, SELECT-only for ludy_tenant,
--      agent_write_guard protected, cascaded on meeting deletion).
--   3. Extend ludy_meetings.morning_notice_member_removed() to also delete morning_brief_lines on removal.
--   4. Add worker-only definers morning_brief_lines_upsert and morning_brief_lines_purge, plus owner PDPL
--      helpers morning_brief_lines_counts and morning_brief_lines_erase (and update personal_erase).
--   5. Restate morning_notices_due, weekly_notices_due, and series_nudges_due to refuse member_briefing
--      and honor morning_notice.enabled = true.
-- Idempotent; applied migrations stay untouched.
SET LOCAL lock_timeout = '2s';

ALTER TABLE ludy_meetings.morning_notice
  ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS content text NOT NULL DEFAULT 'count',
  ADD COLUMN IF NOT EXISTS vy_lines boolean NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint c
    JOIN pg_catalog.pg_class r ON r.oid = c.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = r.relnamespace
    WHERE n.nspname = 'ludy_meetings' AND r.relname = 'morning_notice' AND c.conname = 'morning_notice_content_ck'
  ) THEN
    ALTER TABLE ludy_meetings.morning_notice
      ADD CONSTRAINT morning_notice_content_ck CHECK (content IN ('count', 'full'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS ludy_meetings.morning_brief_lines (
  org_id uuid NOT NULL REFERENCES ludy_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT ludy_kernel.uuid_v7(),
  user_id uuid NOT NULL,
  meeting_id uuid NOT NULL,
  lines jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (pg_catalog.jsonb_typeof(lines) = 'array' AND pg_catalog.jsonb_array_length(lines) <= 20),
  expires_at timestamptz NOT NULL DEFAULT (pg_catalog.now() + interval '36 hours'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  FOREIGN KEY (org_id, meeting_id) REFERENCES ludy_meetings.meeting (org_id, id) ON DELETE CASCADE,
  CONSTRAINT morning_brief_lines_user_meeting_uq UNIQUE (org_id, user_id, meeting_id)
);

CREATE INDEX IF NOT EXISTS morning_brief_lines_expires_idx ON ludy_meetings.morning_brief_lines (expires_at);
CREATE INDEX IF NOT EXISTS morning_brief_lines_meeting_idx ON ludy_meetings.morning_brief_lines (org_id, meeting_id);

SELECT ludy_kernel.apply_tenant_rls('ludy_meetings.morning_brief_lines');
ALTER TABLE ludy_meetings.morning_brief_lines FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE ludy_meetings.morning_brief_lines FROM PUBLIC;
DO $$
DECLARE
  v_role name;
BEGIN
  FOR v_role IN
    SELECT rolname FROM pg_catalog.pg_roles
    WHERE rolname LIKE 'ludy\_%' ESCAPE '\' AND rolname <> current_user
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON TABLE ludy_meetings.morning_brief_lines FROM %I', v_role);
  END LOOP;
END $$;
GRANT SELECT ON TABLE ludy_meetings.morning_brief_lines TO ludy_tenant;
SELECT ludy_kernel.agent_write_guard_install('ludy_meetings.morning_brief_lines');

-- Temporary user-only SELECT policy; replaced in the next migration once ctx_briefing_user_id() exists.
DROP POLICY IF EXISTS morning_brief_lines_read ON ludy_meetings.morning_brief_lines;
CREATE POLICY morning_brief_lines_read ON ludy_meetings.morning_brief_lines AS RESTRICTIVE FOR SELECT TO ludy_tenant
  USING (
    ludy_kernel.ctx_actor_type() = 'user'
    AND user_id = (SELECT ludy_kernel.ctx_user_id())
    AND expires_at > pg_catalog.now()
    AND ludy_meetings.is_meeting_reader(org_id, meeting_id)
  );

CREATE OR REPLACE FUNCTION ludy_meetings.morning_notice_member_removed()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  DELETE FROM ludy_meetings.morning_notice n WHERE n.org_id = OLD.org_id AND n.user_id = OLD.user_id;
  DELETE FROM ludy_meetings.morning_brief_lines l WHERE l.org_id = OLD.org_id AND l.user_id = OLD.user_id;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION ludy_meetings.morning_notice_member_removed() FROM PUBLIC;
DO $$
DECLARE
  v_role name;
BEGIN
  FOR v_role IN
    SELECT rolname FROM pg_catalog.pg_roles
    WHERE rolname LIKE 'ludy\_%' ESCAPE '\' AND rolname <> current_user
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_meetings.morning_notice_member_removed() FROM %I', v_role);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION ludy_meetings.morning_brief_lines_upsert(
  p_org_id uuid,
  p_user_id uuid,
  p_meeting_id uuid,
  p_lines jsonb,
  p_expires_at timestamptz
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (ludy_kernel.ctx_verified() ->> 'kind') = 'member_briefing' THEN
    RAISE EXCEPTION 'AGENT_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'ludy_worker', 'MEMBER')
     OR ludy_kernel.ctx_actor_type() IS DISTINCT FROM 'system'
     OR ludy_kernel.ctx_org_id() IS DISTINCT FROM p_org_id
     OR p_org_id IS NULL OR p_user_id IS NULL OR p_meeting_id IS NULL THEN
    RAISE EXCEPTION 'MEETINGS_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF p_lines IS NULL
     OR pg_catalog.jsonb_typeof(p_lines) <> 'array'
     OR pg_catalog.jsonb_array_length(p_lines) > 20
     OR EXISTS (
       SELECT 1 FROM pg_catalog.jsonb_array_elements(p_lines) e(v)
       WHERE pg_catalog.jsonb_typeof(e.v) <> 'string'
          OR pg_catalog.char_length(e.v #>> '{}') > 300
     ) THEN
    RAISE EXCEPTION 'BRIEF_LINES_INVALID' USING ERRCODE = '22023';
  END IF;
  IF p_expires_at IS NULL
     OR p_expires_at <= pg_catalog.now()
     OR p_expires_at > pg_catalog.now() + interval '48 hours' THEN
    RAISE EXCEPTION 'BRIEF_LINES_EXPIRY_INVALID' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM ludy_kernel.tenant t
    JOIN ludy_kernel.tenant_member m ON m.org_id = t.org_id
    JOIN ludy_kernel.user_account u ON u.id = m.user_id
    JOIN ludy_meetings.morning_notice mn ON mn.org_id = t.org_id AND mn.user_id = m.user_id
    WHERE t.org_id = p_org_id
      AND t.status = 'active'
      AND ludy_kernel.org_app_on(t.org_id, 'meetings')
      AND m.user_id = p_user_id
      AND m.role IN ('owner', 'admin', 'member')
      AND u.disabled_at IS NULL
      AND mn.enabled = true
      AND mn.vy_lines = true
  ) THEN
    RAISE EXCEPTION 'BRIEF_LINES_NOT_ELIGIBLE' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM ludy_meetings.meeting mt WHERE mt.org_id = p_org_id AND mt.id = p_meeting_id
  ) THEN
    RAISE EXCEPTION 'BRIEF_LINES_MEETING_MISSING' USING ERRCODE = '22023';
  END IF;

  INSERT INTO ludy_meetings.morning_brief_lines (org_id, user_id, meeting_id, lines, expires_at)
  VALUES (p_org_id, p_user_id, p_meeting_id, p_lines, p_expires_at)
  ON CONFLICT (org_id, user_id, meeting_id) DO UPDATE
    SET lines = EXCLUDED.lines,
        expires_at = EXCLUDED.expires_at,
        created_at = pg_catalog.now();
END $$;
REVOKE ALL ON FUNCTION ludy_meetings.morning_brief_lines_upsert(uuid, uuid, uuid, jsonb, timestamptz) FROM PUBLIC;
DO $$
DECLARE
  v_role name;
BEGIN
  FOR v_role IN
    SELECT rolname FROM pg_catalog.pg_roles
    WHERE rolname LIKE 'ludy\_%' ESCAPE '\' AND rolname <> current_user
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_meetings.morning_brief_lines_upsert(uuid, uuid, uuid, jsonb, timestamptz) FROM %I', v_role);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION ludy_meetings.morning_brief_lines_upsert(uuid, uuid, uuid, jsonb, timestamptz) TO ludy_worker;

CREATE OR REPLACE FUNCTION ludy_meetings.morning_brief_lines_purge(p_limit integer DEFAULT 500)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_deleted integer;
BEGIN
  IF (ludy_kernel.ctx_verified() ->> 'kind') = 'member_briefing' THEN
    RAISE EXCEPTION 'AGENT_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'ludy_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'MEETINGS_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  WITH target AS (
    SELECT l.org_id, l.id
    FROM ludy_meetings.morning_brief_lines l
    WHERE l.expires_at <= pg_catalog.now()
    ORDER BY l.expires_at, l.org_id, l.id
    LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 500), 5000))
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM ludy_meetings.morning_brief_lines b
  USING target t
  WHERE b.org_id = t.org_id AND b.id = t.id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END $$;
REVOKE ALL ON FUNCTION ludy_meetings.morning_brief_lines_purge(integer) FROM PUBLIC;
DO $$
DECLARE
  v_role name;
BEGIN
  FOR v_role IN
    SELECT rolname FROM pg_catalog.pg_roles
    WHERE rolname LIKE 'ludy\_%' ESCAPE '\' AND rolname <> current_user
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_meetings.morning_brief_lines_purge(integer) FROM %I', v_role);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION ludy_meetings.morning_brief_lines_purge(integer) TO ludy_worker;

-- Counts only (never text) per member for owner PDPL reporting.
CREATE OR REPLACE FUNCTION ludy_meetings.morning_brief_lines_counts()
RETURNS TABLE (org_id uuid, member_user_id uuid, brief_lines bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
BEGIN
  IF v_org IS NULL OR ludy_kernel.ctx_actor_type() IS DISTINCT FROM 'user' OR NOT EXISTS (
    SELECT 1 FROM ludy_kernel.tenant_member m
    WHERE m.org_id = v_org AND m.user_id = ludy_kernel.ctx_user_id() AND m.role = 'owner'
  ) THEN
    RAISE EXCEPTION 'MEETINGS_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT b.org_id, b.user_id AS member_user_id, pg_catalog.count(*)::bigint AS brief_lines
  FROM ludy_meetings.morning_brief_lines b
  WHERE b.org_id = v_org
  GROUP BY b.org_id, b.user_id
  ORDER BY b.user_id;
END $$;
REVOKE ALL ON FUNCTION ludy_meetings.morning_brief_lines_counts() FROM PUBLIC;
DO $$
DECLARE
  v_role name;
BEGIN
  FOR v_role IN
    SELECT rolname FROM pg_catalog.pg_roles
    WHERE rolname LIKE 'ludy\_%' ESCAPE '\' AND rolname <> current_user
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_meetings.morning_brief_lines_counts() FROM %I', v_role);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION ludy_meetings.morning_brief_lines_counts() TO ludy_tenant;

-- Owner PDPL erasure for morning_brief_lines mentioning the target value.
CREATE OR REPLACE FUNCTION ludy_meetings.morning_brief_lines_erase(p_kind text, p_value text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_deleted bigint;
BEGIN
  IF v_org IS NULL OR ludy_kernel.ctx_actor_type() IS DISTINCT FROM 'user' OR NOT EXISTS (
    SELECT 1 FROM ludy_kernel.tenant_member m
    WHERE m.org_id = v_org AND m.user_id = ludy_kernel.ctx_user_id() AND m.role = 'owner'
  ) THEN
    RAISE EXCEPTION 'MEETINGS_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  PERFORM ludy_kernel.text_mention_pattern(p_kind, p_value);
  DELETE FROM ludy_meetings.morning_brief_lines b
  WHERE b.org_id = v_org
    AND EXISTS (
      SELECT 1 FROM pg_catalog.jsonb_array_elements(b.lines) e(v)
      WHERE pg_catalog.jsonb_typeof(e.v) = 'string'
        AND ludy_kernel.text_mentions(e.v #>> '{}', p_kind, p_value)
    );
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END $$;
REVOKE ALL ON FUNCTION ludy_meetings.morning_brief_lines_erase(text, text) FROM PUBLIC;
DO $$
DECLARE
  v_role name;
BEGIN
  FOR v_role IN
    SELECT rolname FROM pg_catalog.pg_roles
    WHERE rolname LIKE 'ludy\_%' ESCAPE '\' AND rolname <> current_user
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_meetings.morning_brief_lines_erase(text, text) FROM %I', v_role);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION ludy_meetings.morning_brief_lines_erase(text, text) TO ludy_tenant;

-- Restate personal_erase from 20270327200000_ludy_meetings_personal_data_meeting_place.sql to also drop
-- derived morning_brief_lines rows whenever a matching meeting is processed for erasure.
CREATE OR REPLACE FUNCTION ludy_meetings.personal_erase(p_kind text, p_value text)
RETURNS TABLE (meeting_id uuid, recorder_user_id uuid, lines bigint, results bigint, items bigint, titles bigint, kept bigint, audio_until date, video_until date)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_key bytea;
  v_hex text;
  v_mark constant text := '[đã xóa]';
  v_notices jsonb;
  m record;
  v_rec boolean;
  v_read boolean;
  v_stamp bigint;
  v_named boolean;
  v_seg uuid[];
  v_res uuid[];
  v_itm uuid[];
  v_chp uuid[];
  v_lbl uuid[];
  v_n bigint;
BEGIN
  IF v_org IS NULL OR ludy_kernel.ctx_actor_type() IS DISTINCT FROM 'user' OR NOT EXISTS (
    SELECT 1 FROM ludy_kernel.tenant_member t
    WHERE t.org_id = v_org AND t.user_id = ludy_kernel.ctx_user_id() AND t.role = 'owner'
  ) THEN
    RAISE EXCEPTION 'MEETINGS_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  PERFORM ludy_kernel.text_mention_pattern(p_kind, p_value);
  v_key := ludy_meetings.notice_key_of(v_org, p_kind, p_value);
  v_hex := pg_catalog.encode(v_key, 'hex');
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('entry', e.v, 'sender', a.actor_id, 'event', a.detail ->> 'event')), '[]'::jsonb) INTO v_notices
    FROM ludy_kernel.audit_event a, pg_catalog.jsonb_array_elements_text(a.detail -> 'meetings') e(v)
   WHERE a.org_id = v_org AND a.command = 'kernel.personal_data.notify' AND a.outcome = 'ok'
     AND a.occurred_at <= pg_catalog.now() - interval '24 hours'
     AND pg_catalog.jsonb_typeof(a.detail) = 'object' AND a.detail ->> 'meeting_key' = v_hex
     AND pg_catalog.jsonb_typeof(a.detail -> 'meetings') = 'array';
  FOR m IN
    WITH hits AS MATERIALIZED (
      SELECT s.meeting_id FROM ludy_meetings.transcript_segment s
       WHERE s.org_id = v_org AND (ludy_kernel.text_mentions(s.text, p_kind, p_value) OR ludy_kernel.text_mentions(s.speaker_label, p_kind, p_value))
      UNION
      SELECT r.meeting_id FROM ludy_meetings.meeting_result r
       WHERE r.org_id = v_org AND (ludy_kernel.text_mentions(r.summary, p_kind, p_value)
                                   OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(r.decisions) e(v) WHERE pg_catalog.jsonb_typeof(e.v) = 'string' AND ludy_kernel.text_mentions(e.v #>> '{}', p_kind, p_value)))
      UNION
      SELECT i.meeting_id FROM ludy_meetings.action_item i
       WHERE i.org_id = v_org AND (ludy_kernel.text_mentions(i.title, p_kind, p_value) OR ludy_kernel.text_mentions(i.who_drafted, p_kind, p_value) OR ludy_kernel.text_mentions(i.when_drafted, p_kind, p_value))
      UNION
      SELECT x.id FROM ludy_meetings.meeting x WHERE x.org_id = v_org AND (ludy_kernel.text_mentions(x.title, p_kind, p_value) OR ludy_kernel.text_mentions(x.place, p_kind, p_value))
      UNION
      SELECT c.meeting_id FROM ludy_meetings.meeting_chapter c WHERE c.org_id = v_org AND ludy_kernel.text_mentions(c.title, p_kind, p_value)
      UNION
      SELECT l.meeting_id FROM ludy_meetings.meeting_label l WHERE l.org_id = v_org AND ludy_kernel.text_mentions(l.label, p_kind, p_value)
    )
    SELECT h.meeting_id FROM hits h ORDER BY h.meeting_id
  LOOP
    SELECT x.recorder_user_id INTO recorder_user_id FROM ludy_meetings.meeting x WHERE x.org_id = v_org AND x.id = m.meeting_id FOR NO KEY UPDATE;
    IF NOT FOUND THEN
      CONTINUE;
    END IF;
    SELECT COALESCE(pg_catalog.array_agg(l.id), '{}'::uuid[]) INTO v_seg FROM (SELECT s.id FROM ludy_meetings.transcript_segment s WHERE s.org_id = v_org AND s.meeting_id = m.meeting_id FOR NO KEY UPDATE) l;
    SELECT COALESCE(pg_catalog.array_agg(l.id), '{}'::uuid[]) INTO v_res FROM (SELECT r.id FROM ludy_meetings.meeting_result r WHERE r.org_id = v_org AND r.meeting_id = m.meeting_id FOR NO KEY UPDATE) l;
    SELECT COALESCE(pg_catalog.array_agg(l.id), '{}'::uuid[]) INTO v_itm FROM (SELECT i.id FROM ludy_meetings.action_item i WHERE i.org_id = v_org AND i.meeting_id = m.meeting_id FOR NO KEY UPDATE) l;
    SELECT COALESCE(pg_catalog.array_agg(l.id), '{}'::uuid[]) INTO v_chp FROM (SELECT c.id FROM ludy_meetings.meeting_chapter c WHERE c.org_id = v_org AND c.meeting_id = m.meeting_id FOR NO KEY UPDATE) l;
    SELECT COALESCE(pg_catalog.array_agg(l.id), '{}'::uuid[]) INTO v_lbl FROM (SELECT b.id FROM ludy_meetings.meeting_label b WHERE b.org_id = v_org AND b.meeting_id = m.meeting_id FOR NO KEY UPDATE) l;
    DELETE FROM ludy_meetings.translation x WHERE x.org_id = v_org AND x.meeting_id = m.meeting_id;
    DELETE FROM ludy_meetings.minutes_version x WHERE x.org_id = v_org AND x.meeting_id = m.meeting_id;
    DELETE FROM ludy_meetings.morning_brief_lines x WHERE x.org_id = v_org AND x.meeting_id = m.meeting_id;
    meeting_id := m.meeting_id;
    v_rec := ludy_meetings.is_meeting_recorder(v_org, m.meeting_id);
    v_read := ludy_meetings.is_meeting_reader(v_org, m.meeting_id);
    v_named := false;
    IF NOT v_rec THEN
      v_stamp := ludy_meetings.text_stamp(v_org, m.meeting_id, v_rec, v_read);
      v_named := EXISTS (
        SELECT 1 FROM pg_catalog.jsonb_array_elements(v_notices) n(j)
         WHERE n.j ->> 'entry' = m.meeting_id::text || ':' || v_stamp::text
           AND ludy_meetings.notice_told(v_org, recorder_user_id, (n.j ->> 'sender')::uuid, n.j ->> 'event'));
    END IF;
    WITH done AS (
      UPDATE ludy_meetings.transcript_segment s
         SET text = pg_catalog.left(ludy_kernel.text_redact(s.text, p_kind, p_value, v_mark), 4000),
             speaker_label = pg_catalog.left(ludy_kernel.text_redact(s.speaker_label, p_kind, p_value, v_mark), 80),
             updated_at = pg_catalog.now()
       WHERE s.org_id = v_org AND s.id = ANY (v_seg)
         AND (ludy_kernel.text_mentions(s.text, p_kind, p_value) OR ludy_kernel.text_mentions(s.speaker_label, p_kind, p_value))
         AND (v_named OR v_rec OR (v_read AND s.stage <> 'draft'))
      RETURNING 1)
    SELECT pg_catalog.count(*) INTO lines FROM done;
    WITH done AS (
      UPDATE ludy_meetings.meeting_result r
         SET summary = pg_catalog.left(ludy_kernel.text_redact(r.summary, p_kind, p_value, v_mark), 8000),
             decisions = COALESCE((SELECT pg_catalog.jsonb_agg(CASE WHEN pg_catalog.jsonb_typeof(e.v) = 'string'
                                                                       THEN pg_catalog.to_jsonb(pg_catalog.left(ludy_kernel.text_redact(e.v #>> '{}', p_kind, p_value, v_mark), 500))
                                                                       ELSE e.v END ORDER BY e.i)
                                     FROM pg_catalog.jsonb_array_elements(r.decisions) WITH ORDINALITY AS e(v, i)), '[]'::jsonb),
             updated_at = pg_catalog.now()
       WHERE r.org_id = v_org AND r.id = ANY (v_res)
         AND (ludy_kernel.text_mentions(r.summary, p_kind, p_value)
              OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(r.decisions) e(v) WHERE pg_catalog.jsonb_typeof(e.v) = 'string' AND ludy_kernel.text_mentions(e.v #>> '{}', p_kind, p_value)))
         AND (v_named OR v_rec OR (v_read AND r.stage <> 'draft'))
      RETURNING 1)
    SELECT pg_catalog.count(*) INTO results FROM done;
    WITH done AS (
      UPDATE ludy_meetings.action_item i
         SET title = pg_catalog.left(ludy_kernel.text_redact(i.title, p_kind, p_value, v_mark), 300),
             who_drafted = pg_catalog.left(ludy_kernel.text_redact(i.who_drafted, p_kind, p_value, v_mark), 200),
             when_drafted = pg_catalog.left(ludy_kernel.text_redact(i.when_drafted, p_kind, p_value, v_mark), 200),
             updated_at = pg_catalog.now()
       WHERE i.org_id = v_org AND i.id = ANY (v_itm)
         AND (ludy_kernel.text_mentions(i.title, p_kind, p_value) OR ludy_kernel.text_mentions(i.who_drafted, p_kind, p_value) OR ludy_kernel.text_mentions(i.when_drafted, p_kind, p_value))
         AND (v_named OR v_rec OR (v_read AND i.stage <> 'draft'))
      RETURNING 1)
    SELECT pg_catalog.count(*) INTO items FROM done;
    WITH done AS (
      UPDATE ludy_meetings.meeting x
         SET title = pg_catalog.left(ludy_kernel.text_redact(x.title, p_kind, p_value, v_mark), 200), updated_at = pg_catalog.now()
       WHERE x.org_id = v_org AND x.id = m.meeting_id AND ludy_kernel.text_mentions(x.title, p_kind, p_value)
         AND (v_named OR v_read)
      RETURNING 1)
    SELECT pg_catalog.count(*) INTO titles FROM done;
    WITH done AS (
      UPDATE ludy_meetings.meeting x
         SET place = pg_catalog.left(ludy_kernel.text_redact(x.place, p_kind, p_value, v_mark), 200), updated_at = pg_catalog.now()
       WHERE x.org_id = v_org AND x.id = m.meeting_id AND ludy_kernel.text_mentions(x.place, p_kind, p_value)
         AND (v_named OR v_read)
      RETURNING 1)
    SELECT pg_catalog.count(*) INTO v_n FROM done;
    titles := titles + v_n;
    WITH done AS (
      UPDATE ludy_meetings.meeting_chapter c
         SET title = pg_catalog.left(ludy_kernel.text_redact(c.title, p_kind, p_value, v_mark), 80), updated_at = pg_catalog.now()
       WHERE c.org_id = v_org AND c.id = ANY (v_chp) AND ludy_kernel.text_mentions(c.title, p_kind, p_value)
         AND (v_named OR v_rec OR (v_read AND c.stage <> 'draft'))
      RETURNING 1)
    SELECT pg_catalog.count(*) INTO v_n FROM done;
    titles := titles + v_n;
    WITH cand AS (
      SELECT b.id, b.created_at,
             (ludy_kernel.text_mentions(b.label, p_kind, p_value) AND (v_named OR v_rec OR v_read)) AS chg,
             CASE WHEN ludy_kernel.text_mentions(b.label, p_kind, p_value) AND (v_named OR v_rec OR v_read)
                  THEN pg_catalog.btrim(pg_catalog.left(ludy_kernel.text_redact(b.label, p_kind, p_value, v_mark), 40))
                  ELSE b.label END AS nl
        FROM ludy_meetings.meeting_label b
       WHERE b.org_id = v_org AND b.id = ANY (v_lbl)
    ), ranked AS (
      SELECT c.id, c.chg, c.nl,
             pg_catalog.row_number() OVER (PARTITION BY pg_catalog.lower(c.nl) ORDER BY c.chg, c.created_at, c.id) AS rn
        FROM cand c
    ), gone AS (
      DELETE FROM ludy_meetings.meeting_label b USING ranked r
       WHERE b.org_id = v_org AND b.id = r.id AND r.chg AND r.rn > 1
      RETURNING 1
    ), upd AS (
      UPDATE ludy_meetings.meeting_label b SET label = r.nl FROM ranked r
       WHERE b.org_id = v_org AND b.id = r.id AND r.chg AND r.rn = 1
      RETURNING 1
    )
    SELECT (SELECT pg_catalog.count(*) FROM gone) + (SELECT pg_catalog.count(*) FROM upd) INTO v_n;
    titles := titles + v_n;
    SELECT (SELECT pg_catalog.count(*) FROM ludy_meetings.transcript_segment s WHERE s.org_id = v_org AND s.meeting_id = m.meeting_id
                AND (ludy_kernel.text_mentions(s.text, p_kind, p_value) OR ludy_kernel.text_mentions(s.speaker_label, p_kind, p_value)))
         + (SELECT pg_catalog.count(*) FROM ludy_meetings.meeting_result r WHERE r.org_id = v_org AND r.meeting_id = m.meeting_id
                AND (ludy_kernel.text_mentions(r.summary, p_kind, p_value)
                     OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(r.decisions) e(v) WHERE pg_catalog.jsonb_typeof(e.v) = 'string' AND ludy_kernel.text_mentions(e.v #>> '{}', p_kind, p_value))))
         + (SELECT pg_catalog.count(*) FROM ludy_meetings.action_item i WHERE i.org_id = v_org AND i.meeting_id = m.meeting_id
                AND (ludy_kernel.text_mentions(i.title, p_kind, p_value) OR ludy_kernel.text_mentions(i.who_drafted, p_kind, p_value) OR ludy_kernel.text_mentions(i.when_drafted, p_kind, p_value)))
         + (SELECT pg_catalog.count(*) FROM ludy_meetings.meeting x WHERE x.org_id = v_org AND x.id = m.meeting_id AND ludy_kernel.text_mentions(x.title, p_kind, p_value))
         + (SELECT pg_catalog.count(*) FROM ludy_meetings.meeting x WHERE x.org_id = v_org AND x.id = m.meeting_id AND ludy_kernel.text_mentions(x.place, p_kind, p_value))
         + (SELECT pg_catalog.count(*) FROM ludy_meetings.meeting_chapter c WHERE c.org_id = v_org AND c.meeting_id = m.meeting_id AND ludy_kernel.text_mentions(c.title, p_kind, p_value))
         + (SELECT pg_catalog.count(*) FROM ludy_meetings.meeting_label b WHERE b.org_id = v_org AND b.meeting_id = m.meeting_id AND ludy_kernel.text_mentions(b.label, p_kind, p_value))
      INTO kept;
    SELECT CASE WHEN EXISTS (SELECT 1 FROM ludy_meetings.audio_segment a WHERE a.org_id = v_org AND a.meeting_id = m.meeting_id) THEN x.audio_retention_date END
      INTO audio_until FROM ludy_meetings.meeting x WHERE x.org_id = v_org AND x.id = m.meeting_id;
    SELECT v.video_retention_date INTO video_until FROM ludy_meetings.meeting_video v WHERE v.org_id = v_org AND v.meeting_id = m.meeting_id;
    RETURN NEXT;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION ludy_meetings.personal_erase(text, text) FROM PUBLIC;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE 'ludy\_%' ESCAPE '\' AND rolname <> current_user LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_meetings.personal_erase(text, text) FROM %I', r.rolname);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION ludy_meetings.personal_erase(text, text) TO ludy_tenant;

-- Restate morning_notices_due from 20270121200000: honor morning_notice.enabled = true and refuse member_briefing.
CREATE OR REPLACE FUNCTION ludy_meetings.morning_notices_due(
  p_limit integer,
  p_org_id uuid DEFAULT NULL,
  p_user_id uuid DEFAULT NULL,
  p_day date DEFAULT NULL
)
RETURNS TABLE (org_id uuid, user_id uuid, day date, events integer, english boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (ludy_kernel.ctx_verified() ->> 'kind') = 'member_briefing' THEN
    RAISE EXCEPTION 'AGENT_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  WITH known AS MATERIALIZED (
    SELECT n.org_id, n.user_id, n.send_minute, n.time_zone, n.language
    FROM ludy_meetings.morning_notice n
    WHERE n.enabled = true
      AND (p_org_id IS NULL OR n.org_id = p_org_id)
      AND (p_user_id IS NULL OR n.user_id = p_user_id)
      AND n.time_zone IN (SELECT z.name FROM pg_catalog.pg_timezone_names z)
  ),
  local AS (
    SELECT n.org_id, n.user_id, n.send_minute, n.time_zone, n.language, pg_catalog.now() AT TIME ZONE n.time_zone AS local_now
    FROM known n
    WHERE EXISTS (
        SELECT 1 FROM ludy_kernel.tenant_member m
        WHERE m.org_id = n.org_id AND m.user_id = n.user_id AND m.role IN ('owner', 'admin', 'member')
      )
      AND ludy_kernel.org_app_on(n.org_id, 'meetings')
      AND NOT EXISTS (
        SELECT 1 FROM ludy_kernel.notification_mute x
        WHERE x.org_id = n.org_id AND x.user_id = n.user_id AND x.kind = 'meetings.morning'
      )
  ),
  due AS (
    SELECT l.org_id, l.user_id, l.time_zone, l.language, l.local_now::date AS day
    FROM local l
    WHERE (pg_catalog.date_part('hour', l.local_now) * 60 + pg_catalog.date_part('minute', l.local_now))::integer >= l.send_minute
      AND (pg_catalog.date_part('hour', l.local_now) * 60 + pg_catalog.date_part('minute', l.local_now))::integer < l.send_minute + 360
      AND (p_day IS NULL OR l.local_now::date = p_day)
  )
  SELECT d.org_id, d.user_id, d.day, LEAST(pg_catalog.count(DISTINCT (a.external_id, a.starts_at)), 1000)::integer, (d.language OPERATOR(pg_catalog.=) 'en')
  FROM due d
  JOIN ludy_meetings.calendar_agenda a
    ON a.org_id = d.org_id AND a.user_id = d.user_id
   AND a.starts_at >= (d.day::timestamp AT TIME ZONE d.time_zone)
   AND a.starts_at < ((d.day + 1)::timestamp AT TIME ZONE d.time_zone)
  JOIN ludy_kernel.calendar_connection c
    ON c.org_id = a.org_id AND c.id = a.connection_id AND c.status = 'active' AND c.read_events
  WHERE NOT EXISTS (
    SELECT 1 FROM ludy_kernel.notification x
    WHERE x.org_id = d.org_id AND x.user_id = d.user_id AND x.dedupe_key = 'morning:' || d.day::text
  )
  GROUP BY d.org_id, d.user_id, d.day, d.language
  ORDER BY pg_catalog.random()
  LIMIT GREATEST(1, LEAST(p_limit, 500));
END $$;
REVOKE ALL ON FUNCTION ludy_meetings.morning_notices_due(integer, uuid, uuid, date) FROM PUBLIC;
DO $$
DECLARE
  v_role name;
BEGIN
  FOR v_role IN
    SELECT rolname FROM pg_catalog.pg_roles
    WHERE rolname LIKE 'ludy\_%' ESCAPE '\' AND rolname <> current_user
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_meetings.morning_notices_due(integer, uuid, uuid, date) FROM %I', v_role);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION ludy_meetings.morning_notices_due(integer, uuid, uuid, date) TO ludy_worker;

-- Restate weekly_notices_due from 20270327100000: refuse member_briefing.
CREATE OR REPLACE FUNCTION ludy_meetings.weekly_notices_due(
  p_limit integer,
  p_org_id uuid DEFAULT NULL,
  p_user_id uuid DEFAULT NULL,
  p_day date DEFAULT NULL,
  p_now timestamptz DEFAULT NULL
)
RETURNS TABLE (org_id uuid, user_id uuid, day date, meetings integer, decisions integer, open_items integer, overdue integer, cut boolean, english boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (ludy_kernel.ctx_verified() ->> 'kind') = 'member_briefing' THEN
    RAISE EXCEPTION 'AGENT_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  WITH known AS MATERIALIZED (
    SELECT n.org_id, n.user_id, n.send_minute, n.time_zone, n.language
    FROM ludy_meetings.weekly_notice n
    WHERE (p_org_id IS NULL OR n.org_id = p_org_id)
      AND (p_user_id IS NULL OR n.user_id = p_user_id)
      AND n.time_zone IN (SELECT z.name FROM pg_catalog.pg_timezone_names z)
  ),
  local AS (
    SELECT n.org_id, n.user_id, n.send_minute, n.time_zone, n.language, COALESCE(p_now, pg_catalog.now()) AT TIME ZONE n.time_zone AS local_now
    FROM known n
    JOIN ludy_kernel.tenant t ON t.org_id = n.org_id AND t.status = 'active'
    JOIN ludy_kernel.user_account u ON u.id = n.user_id AND u.disabled_at IS NULL
    WHERE EXISTS (
        SELECT 1 FROM ludy_kernel.tenant_member m
        WHERE m.org_id = n.org_id AND m.user_id = n.user_id AND m.role IN ('owner', 'admin', 'member')
      )
      AND ludy_kernel.org_app_on(n.org_id, 'meetings')
      AND NOT EXISTS (
        SELECT 1 FROM ludy_kernel.notification_mute x
        WHERE x.org_id = n.org_id AND x.user_id = n.user_id AND x.kind = 'meetings.weekly'
      )
  ),
  due AS (
    SELECT l.org_id, l.user_id, l.time_zone, l.language, l.local_now::date AS day
    FROM local l
    WHERE pg_catalog.date_part('isodow', l.local_now) = 1
      AND (pg_catalog.date_part('hour', l.local_now) * 60 + pg_catalog.date_part('minute', l.local_now))::integer >= l.send_minute
      AND (pg_catalog.date_part('hour', l.local_now) * 60 + pg_catalog.date_part('minute', l.local_now))::integer < l.send_minute + 360
      AND (p_day IS NULL OR l.local_now::date = p_day)
      AND NOT EXISTS (
        SELECT 1 FROM ludy_kernel.notification x
        WHERE x.org_id = l.org_id AND x.user_id = l.user_id AND x.dedupe_key = 'weekly:' || l.local_now::date::text
      )
  ),
  scoped AS (
    SELECT d.*,
           (m.role IN ('owner', 'admin')
            OR NOT EXISTS (SELECT 1 FROM ludy_kernel.role_assignment a WHERE a.org_id = d.org_id AND a.user_id = d.user_id)
            OR EXISTS (SELECT 1 FROM ludy_kernel.role_assignment a WHERE a.org_id = d.org_id AND a.user_id = d.user_id AND a.legal_entity_id IS NULL)) AS whole_org
    FROM due d
    JOIN ludy_kernel.tenant_member m ON m.org_id = d.org_id AND m.user_id = d.user_id
  ),
  readable AS (
    SELECT s.org_id, s.user_id, s.day, s.language, s.time_zone, s.whole_org, mt.id AS meeting_id,
           pg_catalog.row_number() OVER (PARTITION BY s.org_id, s.user_id ORDER BY mt.started_at DESC, mt.id) AS rn
    FROM scoped s
    JOIN ludy_meetings.meeting mt ON mt.org_id = s.org_id
    WHERE mt.started_at >= COALESCE(p_now, pg_catalog.now()) - pg_catalog.make_interval(days => 7)
      AND (mt.text_retention_date IS NULL OR mt.text_retention_date > (COALESCE(p_now, pg_catalog.now()) AT TIME ZONE 'Asia/Ho_Chi_Minh')::date)
      AND (
        mt.recorder_user_id = s.user_id
        OR (mt.visibility = 'org' AND s.whole_org)
        OR EXISTS (SELECT 1 FROM ludy_meetings.meeting_reader r WHERE r.org_id = mt.org_id AND r.meeting_id = mt.id AND r.user_id = s.user_id)
      )
      AND (
        EXISTS (SELECT 1 FROM ludy_meetings.meeting_result r WHERE r.org_id = mt.org_id AND r.meeting_id = mt.id AND r.stage = 'published')
        OR EXISTS (SELECT 1 FROM ludy_meetings.action_item a WHERE a.org_id = mt.org_id AND a.meeting_id = mt.id AND a.stage = 'published')
      )
  ),
  per_meeting AS (
    SELECT r.org_id, r.user_id, r.day, r.language, r.rn,
           COALESCE((
             SELECT pg_catalog.count(*)
             FROM ludy_meetings.meeting_result res, pg_catalog.jsonb_array_elements(res.decisions) e
             WHERE res.org_id = r.org_id AND res.meeting_id = r.meeting_id AND res.stage = 'published'
               AND pg_catalog.jsonb_typeof(e) = 'string' AND (e #>> '{}') ~ '[^[:space:]]'
           ), 0)::integer AS d,
           LEAST(100, COALESCE((
             SELECT pg_catalog.count(*)
             FROM ludy_meetings.action_item i
             LEFT JOIN ludy_kernel.task t ON t.org_id = i.org_id AND t.id = i.task_id
             AND (t.legal_entity_id IS NULL OR r.whole_org OR EXISTS (SELECT 1 FROM ludy_kernel.role_assignment ra WHERE ra.org_id = t.org_id AND ra.user_id = r.user_id AND ra.legal_entity_id = t.legal_entity_id))
             AND NOT EXISTS (
               SELECT 1 FROM ludy_projects.project_task pt
               JOIN ludy_projects.project pr ON pr.org_id = pt.org_id AND pr.id = pt.project_id
               WHERE pt.org_id = t.org_id AND pt.task_id = t.id AND pr.visibility <> 'org'
                 AND pr.owner_user_id IS DISTINCT FROM r.user_id
                 AND NOT EXISTS (SELECT 1 FROM ludy_projects.project_member pm WHERE pm.org_id = pr.org_id AND pm.project_id = pr.id AND pm.user_id = r.user_id)
                 AND NOT EXISTS (SELECT 1 FROM ludy_kernel.tenant_member tm WHERE tm.org_id = t.org_id AND tm.user_id = r.user_id AND tm.role IN ('owner', 'admin'))
             )
             WHERE i.org_id = r.org_id AND i.meeting_id = r.meeting_id AND i.stage = 'published'
               AND (t.status IS NULL OR t.status IN ('todo', 'in_progress', 'waiting', 'in_review'))
           ), 0))::integer AS o,
           LEAST(100, COALESCE((
             SELECT pg_catalog.count(*)
             FROM ludy_meetings.action_item i
             LEFT JOIN ludy_kernel.task t ON t.org_id = i.org_id AND t.id = i.task_id
             AND (t.legal_entity_id IS NULL OR r.whole_org OR EXISTS (SELECT 1 FROM ludy_kernel.role_assignment ra WHERE ra.org_id = t.org_id AND ra.user_id = r.user_id AND ra.legal_entity_id = t.legal_entity_id))
             AND NOT EXISTS (
               SELECT 1 FROM ludy_projects.project_task pt
               JOIN ludy_projects.project pr ON pr.org_id = pt.org_id AND pr.id = pt.project_id
               WHERE pt.org_id = t.org_id AND pt.task_id = t.id AND pr.visibility <> 'org'
                 AND pr.owner_user_id IS DISTINCT FROM r.user_id
                 AND NOT EXISTS (SELECT 1 FROM ludy_projects.project_member pm WHERE pm.org_id = pr.org_id AND pm.project_id = pr.id AND pm.user_id = r.user_id)
                 AND NOT EXISTS (SELECT 1 FROM ludy_kernel.tenant_member tm WHERE tm.org_id = t.org_id AND tm.user_id = r.user_id AND tm.role IN ('owner', 'admin'))
             )
             WHERE i.org_id = r.org_id AND i.meeting_id = r.meeting_id AND i.stage = 'published'
               AND (t.status IS NULL OR t.status IN ('todo', 'in_progress', 'waiting', 'in_review'))
               AND COALESCE((t.due AT TIME ZONE 'Asia/Ho_Chi_Minh')::date, i.when_parsed) < (COALESCE(p_now, pg_catalog.now()) AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
           ), 0))::integer AS od
    FROM readable r
    WHERE r.rn <= 50
  ),
  sliced AS (
    SELECT p.*,
           LEAST(p.d, GREATEST(0, 30 - COALESCE(pg_catalog.sum(p.d) OVER (PARTITION BY p.org_id, p.user_id ORDER BY p.rn ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0)))::integer AS d_shown,
           LEAST(p.o, GREATEST(0, 30 - COALESCE(pg_catalog.sum(p.o) OVER (PARTITION BY p.org_id, p.user_id ORDER BY p.rn ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0)))::integer AS o_shown
    FROM per_meeting p
  ),
  totals AS (
    SELECT s.org_id, s.user_id, s.day, s.language,
           (pg_catalog.count(*) FILTER (WHERE s.d_shown > 0 OR s.o_shown > 0))::integer AS meetings,
           pg_catalog.sum(s.d_shown)::integer AS decisions,
           pg_catalog.sum(s.o_shown)::integer AS open_items,
           pg_catalog.sum(s.od)::integer AS overdue_all,
           (pg_catalog.bool_or(s.d_shown < s.d OR s.o_shown < s.o)
            OR EXISTS (SELECT 1 FROM readable x WHERE x.org_id = s.org_id AND x.user_id = s.user_id AND x.rn > 50)) AS cut
    FROM sliced s
    GROUP BY s.org_id, s.user_id, s.day, s.language
  )
  SELECT t.org_id, t.user_id, t.day, t.meetings, t.decisions, t.open_items, LEAST(t.overdue_all, t.open_items), t.cut, (t.language OPERATOR(pg_catalog.=) 'en')
  FROM totals t
  WHERE t.meetings > 0
  ORDER BY pg_catalog.random()
  LIMIT GREATEST(1, LEAST(p_limit, 500));
END $$;
REVOKE ALL ON FUNCTION ludy_meetings.weekly_notices_due(integer, uuid, uuid, date, timestamptz) FROM PUBLIC;
DO $$
DECLARE
  v_role name;
BEGIN
  FOR v_role IN
    SELECT rolname FROM pg_catalog.pg_roles
    WHERE rolname LIKE 'ludy\_%' ESCAPE '\' AND rolname <> current_user
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_meetings.weekly_notices_due(integer, uuid, uuid, date, timestamptz) FROM %I', v_role);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION ludy_meetings.weekly_notices_due(integer, uuid, uuid, date, timestamptz) TO ludy_worker;

-- Restate series_nudges_due from 20270107120000: refuse member_briefing.
CREATE OR REPLACE FUNCTION ludy_meetings.series_nudges_due(
  p_limit integer,
  p_org_id uuid DEFAULT NULL,
  p_user_id uuid DEFAULT NULL,
  p_series_id uuid DEFAULT NULL,
  p_starts_at timestamptz DEFAULT NULL
)
RETURNS TABLE (org_id uuid, user_id uuid, series_id uuid, previous_meeting_id uuid, starts_at timestamptz, open_count integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (ludy_kernel.ctx_verified() ->> 'kind') = 'member_briefing' THEN
    RAISE EXCEPTION 'AGENT_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  WITH upcoming AS (
    SELECT a.org_id, a.user_id, a.series_id, pg_catalog.min(a.starts_at) AS starts_at
    FROM ludy_meetings.calendar_agenda a
    WHERE a.series_id IS NOT NULL
      AND a.starts_at > pg_catalog.now()
      AND a.starts_at <= pg_catalog.now() + interval '30 minutes'
      AND (p_org_id IS NULL OR a.org_id = p_org_id)
      AND (p_user_id IS NULL OR a.user_id = p_user_id)
      AND (p_series_id IS NULL OR a.series_id = p_series_id)
      AND (p_starts_at IS NULL OR a.starts_at = p_starts_at)
      AND EXISTS (
        SELECT 1 FROM ludy_kernel.tenant_member m
        WHERE m.org_id = a.org_id AND m.user_id = a.user_id AND m.role IN ('owner', 'admin', 'member')
      )
      AND EXISTS (
        SELECT 1 FROM ludy_kernel.calendar_connection c
        WHERE c.org_id = a.org_id AND c.id = a.connection_id AND c.status = 'active' AND c.read_events
      )
      AND ludy_kernel.org_app_on(a.org_id, 'meetings')
      AND NOT EXISTS (
        SELECT 1 FROM ludy_kernel.notification_mute x
        WHERE x.org_id = a.org_id AND x.user_id = a.user_id AND x.kind = 'meetings.series_open_items'
      )
    GROUP BY a.org_id, a.user_id, a.series_id, pg_catalog.to_char(a.starts_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD')
  ),
  previous AS (
    SELECT u.org_id, u.user_id, u.series_id, u.starts_at, p.id AS meeting_id
    FROM upcoming u
    CROSS JOIN LATERAL (
      SELECT m.id
      FROM ludy_meetings.meeting m
      WHERE m.org_id = u.org_id
        AND m.series_id = u.series_id
        AND coalesce(m.started_at, m.created_at) < u.starts_at
        AND (m.text_retention_date IS NULL OR m.text_retention_date > (pg_catalog.now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date)
        AND (
          m.recorder_user_id = u.user_id
          OR EXISTS (SELECT 1 FROM ludy_meetings.meeting_reader r WHERE r.org_id = m.org_id AND r.meeting_id = m.id AND r.user_id = u.user_id)
        )
      ORDER BY coalesce(m.started_at, m.created_at) DESC, m.id DESC
      LIMIT 1
    ) p
  )
  SELECT v.org_id, v.user_id, v.series_id, v.meeting_id, v.starts_at, pg_catalog.count(*)::integer
  FROM previous v
  JOIN ludy_meetings.action_item i
    ON i.org_id = v.org_id AND i.meeting_id = v.meeting_id AND i.stage = 'published' AND i.status = 'accepted'
  JOIN ludy_kernel.task t
    ON t.org_id = i.org_id AND t.id = i.task_id AND t.status IN ('todo', 'in_progress', 'waiting', 'in_review')
  LEFT JOIN ludy_kernel.position s
    ON s.org_id = t.org_id AND s.id = t.assignee_position_id AND s.status = 'active'
  WHERE coalesce(s.holder_user_id, i.who_parsed) = v.user_id
    AND NOT EXISTS (
      SELECT 1 FROM ludy_kernel.notification n
      WHERE n.org_id = v.org_id AND n.user_id = v.user_id
        AND n.dedupe_key = 'series:' || v.series_id::text || ':' || pg_catalog.to_char(v.starts_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD')
    )
  GROUP BY v.org_id, v.user_id, v.series_id, v.meeting_id, v.starts_at
  ORDER BY v.starts_at, v.org_id, v.user_id
  LIMIT GREATEST(1, LEAST(p_limit, 500));
END $$;
REVOKE ALL ON FUNCTION ludy_meetings.series_nudges_due(integer, uuid, uuid, uuid, timestamptz) FROM PUBLIC;
DO $$
DECLARE
  v_role name;
BEGIN
  FOR v_role IN
    SELECT rolname FROM pg_catalog.pg_roles
    WHERE rolname LIKE 'ludy\_%' ESCAPE '\' AND rolname <> current_user
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_meetings.series_nudges_due(integer, uuid, uuid, uuid, timestamptz) FROM %I', v_role);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION ludy_meetings.series_nudges_due(integer, uuid, uuid, uuid, timestamptz) TO ludy_worker;
