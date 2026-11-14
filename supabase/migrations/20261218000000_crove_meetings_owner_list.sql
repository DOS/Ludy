-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove meetings, #2703 (Meetings M2 review follow-ups, ADR-0047): the owner's compliance list, crove_meetings.meeting_owner_list_page, for
-- the Settings privacy screen. An owner deletes a meeting of the org through meeting_owner_delete; for an attendees-only meeting the owner is
-- no reader of, row security hides the meeting from them, so this definer is how they find it. It answers metadata only: the id, the start
-- (the creation time when a meeting has none), the recorder, whether the meeting is org-wide, its status as a code and its three retention
-- dates. No title, no transcript, no summary, no reader and no text column at all (the walk in
-- apps/kernel/test/invariant/meetings-readers.db.test.ts allows no text column but key_id or kind), so visibility is a boolean and status
-- a code:
--   status_code 1 ready, 2 processing, 3 completed, 4 error.
-- Newest first, keyset paged on (start, id), at most 200 rows a call. The caller must be a user-context owner of the context org with the
-- whole org in scope, as meeting_owner_delete requires; it never reads another org's rows.
-- meeting_owner_list of 20261124130000 answered less (no visibility, status or video date) and had no caller. Its name cannot take the new
-- result: re-applying that file (every file is re-applied in the migration test) would then fail on a changed result type. So the new
-- function has a name of its own, and the old one, unused, is dropped. Idempotent.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_meetings.meeting_owner_list_page(
  p_org_id uuid,
  p_limit integer DEFAULT 200,
  p_after_started timestamptz DEFAULT NULL,
  p_after_id uuid DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  started_at timestamptz,
  recorder_user_id uuid,
  org_wide boolean,
  status_code smallint,
  audio_retention_date date,
  video_retention_date date,
  text_retention_date date
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_user uuid := crove_kernel.ctx_user_id();
  v_actor text := crove_kernel.ctx_actor_type();
BEGIN
  IF v_org IS NULL OR p_org_id IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION 'MEETINGS_NOT_ALLOWED' USING ERRCODE = '42501';
  END IF;

  IF NOT (
    v_actor = 'user' AND v_user IS NOT NULL
    AND '*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[])
    AND EXISTS (
      SELECT 1 FROM crove_kernel.tenant_member m
      WHERE m.org_id = v_org AND m.user_id = v_user AND m.role = 'owner'
    )
  ) THEN
    RAISE EXCEPTION 'MEETINGS_OWNER_ONLY' USING ERRCODE = '42501';
  END IF;

  -- A cursor is both halves or none.
  IF (p_after_started IS NULL) <> (p_after_id IS NULL) THEN
    RAISE EXCEPTION 'MEETINGS_BAD_CURSOR' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT m.id,
         COALESCE(m.started_at, m.created_at),
         m.recorder_user_id,
         m.visibility = 'org',
         (CASE m.status WHEN 'ready' THEN 1 WHEN 'processing' THEN 2 WHEN 'completed' THEN 3 ELSE 4 END)::smallint,
         m.audio_retention_date,
         v.video_retention_date,
         m.text_retention_date
  FROM crove_meetings.meeting m
  LEFT JOIN crove_meetings.meeting_video v ON v.org_id = m.org_id AND v.meeting_id = m.id
  WHERE m.org_id = v_org
    AND (
      p_after_started IS NULL
      OR (COALESCE(m.started_at, m.created_at), m.id) < (p_after_started, p_after_id)
    )
  ORDER BY COALESCE(m.started_at, m.created_at) DESC, m.id DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 200), 1), 200);
END;
$$;
REVOKE ALL ON FUNCTION crove_meetings.meeting_owner_list_page(uuid, integer, timestamptz, uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_meetings.meeting_owner_list_page(uuid, integer, timestamptz, uuid) TO crove_tenant;

-- The list it replaces: no code calls it.
-- crove:contract adr=0047
DROP FUNCTION IF EXISTS crove_meetings.meeting_owner_list(uuid, integer, timestamptz, uuid);
