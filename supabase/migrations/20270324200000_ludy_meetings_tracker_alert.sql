-- SPDX-License-Identifier: AGPL-3.0-only
-- Alerts when a tracked keyword comes up in the minutes of a new meeting (#4873, builds on the keyword trackers of #4818). A member who turns it on is told, once per meeting, which tracked words are in the
-- minutes the recorder just published for them to read, and how often: counted by code, with no model and no text in the notice.
--
-- ludy_meetings.tracker_alert: one row per member who opted in (no row, no alert; off by default). Private to its member: the row policy shows and changes a member's own row only, in a user context; an
--   owner, an admin, another member, an agent context and the system context read none of it (the worker reads it through the definer below). It holds no word, no meeting and no text.
-- ludy_meetings.tracker_alert_input(org, meeting, now): the worker-only definer the alert's dispatch asks. The system context cannot read meeting rows or terms, and the reader rule must be decided for each
--   recipient, not for the caller, so this is the one place that does both. It answers NULL unless the meeting still exists, Meetings is on for the org and its text period has not ended (as minutes_wake_open
--   reads it); otherwise one jsonb of the three things the dispatch counts with: `recipients` (the opted-in members who are an active owner, admin or member of the org with an enabled account, are not the
--   recorder, and read the meeting now: it is shared with the org, or they are one of its readers), `terms` (the org's tracked words, at most 20) and `texts` (the PUBLISHED minutes a reader may read: the summary, the decisions, the action item
--   titles and the chapter titles). The terms and the texts are returned only when at least one recipient exists. Nothing of it is stored or logged by the dispatch, and none of it enters the notice.
--   Like minutes_wake_open it holds the caller to the system context of the same org (ctx_org_id() is set, the actor is 'system' and p_org is that org), or it raises NO_CONTEXT (42501). Worker's login alone.
-- Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS ludy_meetings.tracker_alert (
  org_id uuid NOT NULL REFERENCES ludy_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT ludy_kernel.uuid_v7(),
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT tracker_alert_user_uq UNIQUE (org_id, user_id)
);

SELECT ludy_kernel.apply_tenant_rls('ludy_meetings.tracker_alert');
-- A row is added or removed, never edited.
REVOKE UPDATE ON ludy_meetings.tracker_alert FROM ludy_tenant;

DROP POLICY IF EXISTS tracker_alert_own ON ludy_meetings.tracker_alert;
CREATE POLICY tracker_alert_own ON ludy_meetings.tracker_alert AS RESTRICTIVE FOR ALL TO ludy_tenant
  USING (ludy_kernel.ctx_actor_type() = 'user' AND user_id = (SELECT ludy_kernel.ctx_user_id()))
  WITH CHECK (ludy_kernel.ctx_actor_type() = 'user' AND user_id = (SELECT ludy_kernel.ctx_user_id()));

CREATE OR REPLACE FUNCTION ludy_meetings.tracker_alert_input(p_org uuid, p_meeting uuid, p_now timestamptz)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_recipients jsonb;
  v_terms jsonb;
  v_texts jsonb;
BEGIN
  IF v_org IS NULL OR ludy_kernel.ctx_actor_type() IS DISTINCT FROM 'system' OR p_org IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  -- The meeting is still there, Meetings is on, and the text day has not been reached on the Vietnam calendar day of p_now (the day the text is shredded counts as ended).
  IF NOT ludy_kernel.org_app_on(v_org, 'meetings') OR NOT EXISTS (
    SELECT 1 FROM ludy_meetings.meeting m
    WHERE m.org_id = v_org AND m.id = p_meeting
      AND (m.text_retention_date IS NULL OR m.text_retention_date > ((p_now AT TIME ZONE 'UTC') + interval '7 hours')::date)
  ) THEN
    RETURN NULL;
  END IF;
  SELECT COALESCE(pg_catalog.jsonb_agg(r.user_id ORDER BY r.user_id), '[]'::jsonb) INTO v_recipients
  FROM (
    SELECT a.user_id
    FROM ludy_meetings.tracker_alert a
    JOIN ludy_meetings.meeting mt ON mt.org_id = a.org_id AND mt.id = p_meeting
    WHERE a.org_id = v_org
      -- The recorder published it; they are not told about their own publish.
      AND mt.recorder_user_id IS DISTINCT FROM a.user_id
      AND EXISTS (SELECT 1 FROM ludy_kernel.tenant_member m WHERE m.org_id = a.org_id AND m.user_id = a.user_id AND m.role IN ('owner', 'admin', 'member'))
      AND EXISTS (SELECT 1 FROM ludy_kernel.user_account u WHERE u.id = a.user_id AND u.disabled_at IS NULL)
      -- The reader rule, for this member: the meeting is shared with the org (every user context carries the all-entities scope), or they are one of its readers (an owner or admin has no extra right, ADR-0047).
      AND (mt.visibility = 'org' OR EXISTS (SELECT 1 FROM ludy_meetings.meeting_reader rd WHERE rd.org_id = a.org_id AND rd.meeting_id = p_meeting AND rd.user_id = a.user_id))
    ORDER BY a.user_id
    LIMIT 500
  ) r;
  IF v_recipients = '[]'::jsonb THEN
    RETURN pg_catalog.jsonb_build_object('recipients', v_recipients, 'terms', '[]'::jsonb, 'texts', '[]'::jsonb);
  END IF;
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', t.id, 'term', t.term) ORDER BY t.id), '[]'::jsonb) INTO v_terms
  FROM (SELECT id, term FROM ludy_meetings.tracker_term WHERE org_id = v_org ORDER BY id LIMIT 20) t;
  SELECT COALESCE(pg_catalog.jsonb_agg(x.body), '[]'::jsonb) INTO v_texts
  FROM (
    SELECT r.summary AS body FROM ludy_meetings.meeting_result r WHERE r.org_id = v_org AND r.meeting_id = p_meeting AND r.stage = 'published'
    UNION ALL
    SELECT d.value AS body
    FROM ludy_meetings.meeting_result r, pg_catalog.jsonb_array_elements_text(CASE WHEN pg_catalog.jsonb_typeof(r.decisions) = 'array' THEN r.decisions ELSE '[]'::jsonb END) AS d(value)
    WHERE r.org_id = v_org AND r.meeting_id = p_meeting AND r.stage = 'published'
    UNION ALL
    (SELECT i.title AS body FROM ludy_meetings.action_item i WHERE i.org_id = v_org AND i.meeting_id = p_meeting AND i.stage = 'published' ORDER BY i.id LIMIT 200)
    UNION ALL
    (SELECT c.title AS body FROM ludy_meetings.meeting_chapter c WHERE c.org_id = v_org AND c.meeting_id = p_meeting AND c.stage = 'published' ORDER BY c.start_seconds, c.id LIMIT 200)
  ) x;
  RETURN pg_catalog.jsonb_build_object('recipients', v_recipients, 'terms', v_terms, 'texts', v_texts);
END $$;

REVOKE ALL ON FUNCTION ludy_meetings.tracker_alert_input(uuid, uuid, timestamptz) FROM PUBLIC;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE 'ludy\_%' AND rolname <> current_user LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_meetings.tracker_alert_input(uuid, uuid, timestamptz) FROM %I', r.rolname);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION ludy_meetings.tracker_alert_input(uuid, uuid, timestamptz) TO ludy_worker;
