-- SPDX-License-Identifier: AGPL-3.0-only
-- PM1 pre-meeting facts support (#4991):
--   1. Store keyed HMAC-SHA256 hashes (ludy_kernel.email_exact_hash) of synced calendar attendee
--      addresses on ludy_meetings.calendar_agenda (attendee_email_hashes) without storing raw emails,
--      and restate ludy_meetings.agenda_replace to populate them.
--   2. Create ludy_meetings.meeting_brief_draft: per-member private pre-meeting facts draft bound
--      to (target_kind, target_id, party_id), readable and writable only by that member (owner,
--      admin, or member role) in a user context; agent contexts and worker system context read and
--      write none. Cascades on party deletion or member removal; cleaned on meeting deletion and
--      personal-data erasure (meeting_brief_draft_erase / meeting_brief_draft_counts).
-- Idempotent; applied migrations stay untouched.
SET LOCAL lock_timeout = '2s';

ALTER TABLE ludy_meetings.calendar_agenda
  ADD COLUMN IF NOT EXISTS attendee_email_hashes text[] NOT NULL DEFAULT ARRAY[]::text[];

CREATE OR REPLACE FUNCTION ludy_meetings.agenda_replace(p_connection uuid, p_from timestamptz, p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_user uuid;
  v_provider text;
  v_ids text[];
  v_n integer;
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'ludy_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'MEETINGS_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF v_org IS NULL OR ludy_kernel.ctx_actor_type() IS DISTINCT FROM 'system' THEN
    RAISE EXCEPTION 'MEETINGS_SYSTEM_CONTEXT' USING ERRCODE = '42501';
  END IF;
  IF p_from IS NULL OR p_rows IS NULL OR pg_catalog.jsonb_typeof(p_rows) IS DISTINCT FROM 'array' OR pg_catalog.jsonb_array_length(p_rows) > 300 THEN
    RAISE EXCEPTION 'AGENDA_INVALID' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_array_elements(p_rows) AS e(value)
    WHERE COALESCE(pg_catalog.jsonb_typeof(e.value -> 'id'), '') <> 'string' OR COALESCE(e.value ->> 'id', '') = ''
  ) THEN
    RAISE EXCEPTION 'AGENDA_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT c.user_id, c.provider INTO v_user, v_provider
  FROM ludy_kernel.calendar_connection c
  WHERE c.org_id = v_org AND c.id = p_connection AND c.status = 'active' AND c.read_events
  FOR SHARE;
  IF NOT FOUND THEN
    RETURN 0;
  END IF;
  SELECT pg_catalog.array_agg(e.value ->> 'id') INTO v_ids
  FROM pg_catalog.jsonb_array_elements(p_rows) AS e(value);

  DELETE FROM ludy_meetings.calendar_agenda a
  WHERE a.org_id = v_org AND a.connection_id = p_connection AND a.meeting_id IS NULL
    AND (a.ends_at < p_from OR a.external_id <> ALL (COALESCE(v_ids, ARRAY[]::text[])));

  INSERT INTO ludy_meetings.calendar_agenda AS a (
    org_id, connection_id, user_id, external_id, title, starts_at, ends_at, time_zone, join_url, invitee_count, series_id, attendee_email_hashes
  )
  SELECT DISTINCT ON (e.value ->> 'id')
         v_org,
         p_connection,
         v_user,
         e.value ->> 'id',
         pg_catalog.left(COALESCE(e.value ->> 'title', ''), 200),
         (e.value ->> 'startsAt')::timestamptz,
         (e.value ->> 'endsAt')::timestamptz,
         COALESCE(NULLIF(e.value ->> 'timeZone', ''), 'UTC'),
         CASE
           WHEN pg_catalog.left(COALESCE(e.value ->> 'joinUrl', ''), 8) = 'https://'
                AND pg_catalog.char_length(e.value ->> 'joinUrl') <= 500
             THEN e.value ->> 'joinUrl'
         END,
         LEAST(GREATEST(COALESCE((e.value ->> 'invitees')::integer, 0), 0), 1000),
         CASE
           WHEN pg_catalog.char_length(COALESCE(e.value ->> 'series', '')) BETWEEN 1 AND 1024
             THEN pg_catalog.md5(v_provider || ':' || (e.value ->> 'series'))::uuid
         END,
         COALESCE(
           ARRAY(
             SELECT s.h
             FROM (
               SELECT DISTINCT ludy_kernel.email_exact_hash(x.email) AS h
               FROM pg_catalog.jsonb_array_elements_text(
                 CASE
                   WHEN pg_catalog.jsonb_typeof(e.value -> 'attendeeEmails') = 'array' THEN e.value -> 'attendeeEmails'
                   ELSE '[]'::jsonb
                 END
               ) AS x(email)
               WHERE pg_catalog.btrim(x.email) <> ''
                 AND ludy_kernel.email_exact_hash(x.email) IS NOT NULL
               ORDER BY 1
               LIMIT 50
             ) s
           ),
           ARRAY[]::text[]
         )
  FROM pg_catalog.jsonb_array_elements(p_rows) AS e(value)
  ORDER BY e.value ->> 'id'
  ON CONFLICT ON CONSTRAINT calendar_agenda_event_uq DO UPDATE
    SET title = EXCLUDED.title,
        starts_at = EXCLUDED.starts_at,
        ends_at = EXCLUDED.ends_at,
        time_zone = EXCLUDED.time_zone,
        join_url = EXCLUDED.join_url,
        invitee_count = EXCLUDED.invitee_count,
        series_id = EXCLUDED.series_id,
        attendee_email_hashes = EXCLUDED.attendee_email_hashes,
        updated_at = pg_catalog.now();
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

REVOKE ALL ON FUNCTION ludy_meetings.agenda_replace(uuid, timestamptz, jsonb) FROM PUBLIC;
DO $$
DECLARE
  v_role name;
BEGIN
  FOR v_role IN
    SELECT rolname FROM pg_catalog.pg_roles
    WHERE rolname LIKE 'ludy\_%' ESCAPE '\' AND rolname <> current_user
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_meetings.agenda_replace(uuid, timestamptz, jsonb) FROM %I', v_role);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION ludy_meetings.agenda_replace(uuid, timestamptz, jsonb) TO ludy_worker;

CREATE TABLE IF NOT EXISTS ludy_meetings.meeting_brief_draft (
  org_id uuid NOT NULL REFERENCES ludy_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT ludy_kernel.uuid_v7(),
  user_id uuid NOT NULL,
  target_kind text NOT NULL CHECK (target_kind IN ('agenda', 'booking', 'meeting')),
  target_id uuid NOT NULL,
  party_id uuid NOT NULL,
  body text NOT NULL CHECK (pg_catalog.char_length(body) BETWEEN 1 AND 8000),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  FOREIGN KEY (org_id, user_id) REFERENCES ludy_kernel.tenant_member (org_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, party_id) REFERENCES ludy_kernel.party (org_id, id) ON DELETE CASCADE,
  CONSTRAINT meeting_brief_draft_uq UNIQUE (org_id, user_id, target_kind, target_id, party_id)
);

CREATE INDEX IF NOT EXISTS meeting_brief_draft_party_idx
  ON ludy_meetings.meeting_brief_draft (org_id, party_id);
CREATE INDEX IF NOT EXISTS meeting_brief_draft_target_idx
  ON ludy_meetings.meeting_brief_draft (org_id, target_kind, target_id);

SELECT ludy_kernel.apply_tenant_rls('ludy_meetings.meeting_brief_draft');
SELECT ludy_kernel.agent_write_guard_install('ludy_meetings.meeting_brief_draft');

REVOKE ALL ON TABLE ludy_meetings.meeting_brief_draft FROM PUBLIC;
DO $$
DECLARE
  v_role name;
BEGIN
  FOR v_role IN
    SELECT rolname FROM pg_catalog.pg_roles
    WHERE rolname LIKE 'ludy\_%' ESCAPE '\' AND rolname <> current_user
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON TABLE ludy_meetings.meeting_brief_draft FROM %I', v_role);
  END LOOP;
END $$;
GRANT SELECT, INSERT, DELETE ON TABLE ludy_meetings.meeting_brief_draft TO ludy_tenant;
GRANT UPDATE (body, updated_at) ON TABLE ludy_meetings.meeting_brief_draft TO ludy_tenant;

DROP POLICY IF EXISTS meeting_brief_draft_own ON ludy_meetings.meeting_brief_draft;
CREATE POLICY meeting_brief_draft_own ON ludy_meetings.meeting_brief_draft AS RESTRICTIVE FOR ALL TO ludy_tenant
  USING (
    ludy_kernel.ctx_actor_type() = 'user'
    AND user_id = (SELECT ludy_kernel.ctx_user_id())
    AND EXISTS (
      SELECT 1 FROM ludy_kernel.tenant_member tm
      WHERE tm.org_id = meeting_brief_draft.org_id
        AND tm.user_id = (SELECT ludy_kernel.ctx_user_id())
        AND tm.role IN ('owner', 'admin', 'member')
    )
  )
  WITH CHECK (
    ludy_kernel.ctx_actor_type() = 'user'
    AND user_id = (SELECT ludy_kernel.ctx_user_id())
    AND EXISTS (
      SELECT 1 FROM ludy_kernel.tenant_member tm
      WHERE tm.org_id = meeting_brief_draft.org_id
        AND tm.user_id = (SELECT ludy_kernel.ctx_user_id())
        AND tm.role IN ('owner', 'admin', 'member')
    )
  );

CREATE OR REPLACE FUNCTION ludy_meetings.meeting_brief_draft_meeting_deleted()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  DELETE FROM ludy_meetings.meeting_brief_draft d
  WHERE d.org_id = OLD.org_id AND d.target_kind = 'meeting' AND d.target_id = OLD.id;
  RETURN NULL;
END $$;

REVOKE ALL ON FUNCTION ludy_meetings.meeting_brief_draft_meeting_deleted() FROM PUBLIC;
DO $$
DECLARE
  v_role name;
BEGIN
  FOR v_role IN
    SELECT rolname FROM pg_catalog.pg_roles
    WHERE rolname LIKE 'ludy\_%' ESCAPE '\' AND rolname <> current_user
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_meetings.meeting_brief_draft_meeting_deleted() FROM %I', v_role);
  END LOOP;
END $$;

DROP TRIGGER IF EXISTS meeting_brief_draft_meeting_deleted ON ludy_meetings.meeting;
CREATE TRIGGER meeting_brief_draft_meeting_deleted
  AFTER DELETE ON ludy_meetings.meeting
  FOR EACH ROW
  EXECUTE FUNCTION ludy_meetings.meeting_brief_draft_meeting_deleted();

-- Counts only (never text) per member for owner PDPL reporting.
CREATE OR REPLACE FUNCTION ludy_meetings.meeting_brief_draft_counts()
RETURNS TABLE (org_id uuid, member_user_id uuid, drafts bigint)
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
  SELECT d.org_id, d.user_id AS member_user_id, pg_catalog.count(*)::bigint AS drafts
  FROM ludy_meetings.meeting_brief_draft d
  WHERE d.org_id = v_org
  GROUP BY d.org_id, d.user_id
  ORDER BY d.user_id;
END $$;

REVOKE ALL ON FUNCTION ludy_meetings.meeting_brief_draft_counts() FROM PUBLIC;
DO $$
DECLARE
  v_role name;
BEGIN
  FOR v_role IN
    SELECT rolname FROM pg_catalog.pg_roles
    WHERE rolname LIKE 'ludy\_%' ESCAPE '\' AND rolname <> current_user
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_meetings.meeting_brief_draft_counts() FROM %I', v_role);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION ludy_meetings.meeting_brief_draft_counts() TO ludy_tenant;

-- Owner PDPL erasure for meeting_brief_draft rows tied to matched contacts or mentioning the value.
CREATE OR REPLACE FUNCTION ludy_meetings.meeting_brief_draft_erase(
  p_kind text,
  p_value text,
  p_party_ids uuid[] DEFAULT ARRAY[]::uuid[],
  p_match_text boolean DEFAULT true
)
RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_deleted bigint;
  v_parties uuid[] := COALESCE(p_party_ids, ARRAY[]::uuid[]);
BEGIN
  IF v_org IS NULL OR ludy_kernel.ctx_actor_type() IS DISTINCT FROM 'user' OR NOT EXISTS (
    SELECT 1 FROM ludy_kernel.tenant_member m
    WHERE m.org_id = v_org AND m.user_id = ludy_kernel.ctx_user_id() AND m.role = 'owner'
  ) THEN
    RAISE EXCEPTION 'MEETINGS_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF COALESCE(p_match_text, true) THEN
    PERFORM ludy_kernel.text_mention_pattern(p_kind, p_value);
  END IF;
  DELETE FROM ludy_meetings.meeting_brief_draft d
  WHERE d.org_id = v_org
    AND (
      (pg_catalog.cardinality(v_parties) > 0 AND d.party_id = ANY (v_parties))
      OR (COALESCE(p_match_text, true) AND ludy_kernel.text_mentions(d.body, p_kind, p_value))
    );
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END $$;

REVOKE ALL ON FUNCTION ludy_meetings.meeting_brief_draft_erase(text, text, uuid[], boolean) FROM PUBLIC;
DO $$
DECLARE
  v_role name;
BEGIN
  FOR v_role IN
    SELECT rolname FROM pg_catalog.pg_roles
    WHERE rolname LIKE 'ludy\_%' ESCAPE '\' AND rolname <> current_user
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_meetings.meeting_brief_draft_erase(text, text, uuid[], boolean) FROM %I', v_role);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION ludy_meetings.meeting_brief_draft_erase(text, text, uuid[], boolean) TO ludy_tenant;
