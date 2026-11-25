-- SPDX-License-Identifier: AGPL-3.0-only
-- Ludy meetings, issue #4822 (owner decision 2026-11-25, the 8th locked exception of the meetings definer-return rule, listed in invariant PR #4833 first): the public side of the minutes link.
-- Idempotent; applied files stay untouched.
--
-- ludy_meetings.minutes_link_view(p_token)   the one function a person outside the org reaches. It returns ONE jsonb column `page` (the exception's exact shape) or no row at all:
--                                            the title, the date, the PUBLISHED summary, decisions and action items of the one meeting the link names, and the org's name. The meeting is taken only
--                                            from the link row the token resolves to (never from the caller), published rows only (a draft, the transcript, the chapters and the recording are never read),
--                                            the link's own org only. It counts the open (`views`, `first_viewed_at`; nothing about who opened it). No row for a malformed token, an unknown, revoked or
--                                            expired one, an org that is not active, an org whose setting for sharing minutes is off, an org with Meetings off, a meeting with no published minutes: the
--                                            same answer for every one of them. EXECUTE goes to the API login alone.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION ludy_meetings.minutes_link_view(p_token text)
RETURNS TABLE (page jsonb) LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_link ludy_meetings.minutes_link;
  v_result ludy_meetings.meeting_result;
  v_meeting ludy_meetings.meeting;
  v_org_name text;
BEGIN
  IF p_token IS NULL OR p_token !~ '^[A-Za-z0-9_-]{43}$' THEN
    RETURN;
  END IF;
  SELECT l.* INTO v_link FROM ludy_meetings.minutes_link l
  WHERE l.token_sha256 = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_token, 'UTF8')), 'hex');
  IF v_link.id IS NULL OR v_link.revoked_at IS NOT NULL OR v_link.expires_at <= pg_catalog.now() THEN
    RETURN;
  END IF;
  -- The org is active, has chosen to share minutes outside, and has Meetings on (the SQL half of the app gate, ADR-0053).
  SELECT t.name INTO v_org_name FROM ludy_kernel.tenant t
  WHERE t.org_id = v_link.org_id AND t.status = 'active' AND t.meeting_minutes_link AND ludy_kernel.org_app_on(t.org_id, 'meetings');
  IF NOT FOUND THEN
    RETURN;
  END IF;
  SELECT r.* INTO v_result FROM ludy_meetings.meeting_result r
  WHERE r.org_id = v_link.org_id AND r.meeting_id = v_link.meeting_id AND r.stage = 'published';
  IF v_result.id IS NULL THEN
    RETURN;
  END IF;
  SELECT m.* INTO v_meeting FROM ludy_meetings.meeting m WHERE m.org_id = v_link.org_id AND m.id = v_link.meeting_id;
  IF v_meeting.id IS NULL THEN
    RETURN;
  END IF;
  UPDATE ludy_meetings.minutes_link SET views = views + 1, first_viewed_at = COALESCE(first_viewed_at, pg_catalog.now())
  WHERE org_id = v_link.org_id AND id = v_link.id AND revoked_at IS NULL;
  RETURN QUERY SELECT pg_catalog.jsonb_build_object(
    'title', v_meeting.title,
    'startedAt', v_meeting.started_at,
    'publishedAt', v_result.updated_at,
    'summary', v_result.summary,
    'decisions', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(pg_catalog.left(d.value #>> '{}', 1000)) ORDER BY d.ord)
      FROM pg_catalog.jsonb_array_elements(v_result.decisions) WITH ORDINALITY AS d (value, ord)
      WHERE pg_catalog.jsonb_typeof(d.value) = 'string'), '[]'::jsonb),
    'actionItems', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'text', i.title,
        'owner', i.who_drafted,
        'due', COALESCE(i.when_parsed::text, NULLIF(i.when_drafted, ''))) ORDER BY i.transcript_seconds NULLS LAST, i.id)
      FROM (SELECT a.* FROM ludy_meetings.action_item a
            WHERE a.org_id = v_link.org_id AND a.meeting_id = v_link.meeting_id AND a.stage = 'published'
            ORDER BY a.transcript_seconds NULLS LAST, a.id LIMIT 100) i), '[]'::jsonb),
    'orgName', pg_catalog.left(v_org_name, 200));
END $$;
REVOKE ALL ON FUNCTION ludy_meetings.minutes_link_view(text) FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION ludy_meetings.minutes_link_view(text) TO ludy_app;
