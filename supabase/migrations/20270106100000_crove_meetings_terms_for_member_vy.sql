-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove meetings, a term list of names for transcription (#3499, ADR-0047 point 5 as amended 2026-11-16): crove_meetings.terms_for_member_vy(org, meeting) answers the names
-- that may be spoken in one meeting, for the recorder's own transcription run, so the worker can send them to the provider with the audio. Names and nothing else:
--   * the recorder's and the attendees' display names (the people the recorder added to the meeting, by the names the org knows them by; never an email address);
--   * the party the meeting is linked to (L1), by name, and that party's people when it is a company (the persons whose company it is), or its company when it is a person;
--   * never another party, never a phone number, an email address, a tax code, an address or an amount: the function selects the `name` and `display_name` columns and no other.
-- The rows are raw text that people typed; the caller (packages/agent normalizeTerms) cuts and cleans them before anything leaves. Idempotent; applied files stay untouched.
--
-- The door is the audio door's own: the function first runs crove_meetings.audio_for_member_vy for the same meeting (restated in 20261214010000), which refuses unless the call
-- is the worker login in the sealed context of a live run of this member's Vy for THIS meeting and the transcribe feature, the member is the meeting's recorder and active, the
-- text and audio dates have not passed and the audio key is not shredded. Whatever refuses the audio refuses the names, with the same errors. Worker login only.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_meetings.terms_for_member_vy(p_org_id uuid, p_meeting_id uuid)
RETURNS TABLE (term text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_agent uuid := crove_kernel.ctx_agent_id();
  v_member uuid;
BEGIN
  -- The audio door's whole gate, for this meeting (it raises its own fixed codes: MEETINGS_WORKER_ONLY, MEETINGS_RUN_REQUIRED, MEETINGS_NOT_RECORDER, ...).
  PERFORM 1 FROM crove_meetings.audio_for_member_vy(p_org_id, p_meeting_id) LIMIT 1;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  -- The gate passed, so the agent is this member's active Vy and the member is the meeting's recorder.
  SELECT a.member_user_id INTO v_member
  FROM crove_kernel.agent a
  WHERE a.org_id = v_org AND a.id = v_agent AND a.kind = 'member_vy' AND a.status = 'active';
  IF v_member IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH people AS (
    SELECT v_member AS user_id, 0 AS rank
    UNION ALL
    SELECT r.user_id, 1
    FROM crove_meetings.meeting_reader r
    WHERE r.org_id = v_org AND r.meeting_id = p_meeting_id AND r.user_id <> v_member
  ),
  -- The parties this meeting is linked to, each as the party it was kept as (a duplicate stands for the party it was merged into).
  linked AS (
    SELECT DISTINCT coalesce(p.duplicate_of, p.id) AS party_id
    FROM crove_meetings.meeting_link l
    JOIN crove_kernel.party p ON p.org_id = l.org_id AND p.id = l.party_id
    WHERE l.org_id = v_org AND l.meeting_id = p_meeting_id AND l.party_id IS NOT NULL
  ),
  names AS (
    SELECT pr.display_name AS term, people.rank AS rank, pr.display_name AS sort_key
    FROM people
    JOIN crove_kernel.member_profiles((SELECT pg_catalog.array_agg(DISTINCT people.user_id) FROM people)) pr ON pr.user_id = people.user_id
    WHERE pr.display_name IS NOT NULL
    UNION ALL
    -- The linked party itself.
    SELECT k.name, 2, k.name
    FROM linked
    JOIN crove_kernel.party k ON k.org_id = v_org AND k.id = linked.party_id
    UNION ALL
    -- A company's people (a person whose company it is, never a duplicate), or a person's company.
    SELECT c.name, 3, c.name
    FROM linked
    JOIN crove_kernel.party k ON k.org_id = v_org AND k.id = linked.party_id
    JOIN crove_kernel.party c ON c.org_id = v_org AND c.duplicate_of IS NULL AND (
      (k.kind = 'organization' AND c.kind = 'person' AND c.company_id = k.id)
      OR (k.kind = 'person' AND c.kind = 'organization' AND c.id = k.company_id)
    )
  )
  SELECT n.term FROM names n WHERE n.term IS NOT NULL ORDER BY n.rank, n.sort_key LIMIT 200;
END;
$$;
REVOKE ALL ON FUNCTION crove_meetings.terms_for_member_vy(uuid, uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_meetings.terms_for_member_vy(uuid, uuid) TO crove_worker;
