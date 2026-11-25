-- SPDX-License-Identifier: AGPL-3.0-only
-- The recorder's entity scope in the transcription term list (#3532, review of #3501): ludy_meetings.terms_for_member_vy is a SECURITY DEFINER that reads ludy_kernel.party (the meeting's linked party and
-- that party's company or people) and so bypasses RLS. This restates it from 20270106100000 with ONE change: a party is named only when the recorder's entity scope reaches it, as the other party-reading definers do
-- (an actor scoped to legal entities sees an org-wide record only if it is linked in record_le, plan section 4.6). The scope is read as enter_context gives it to the member's own user context: the whole org for an
-- owner or admin, a member with an org-wide role assignment or one with no assignment at all; otherwise the entities the assignments name. Nothing changes for a recorder with the whole-org scope, which is every
-- recorder today without an entity-limited assignment. Names and the door (audio_for_member_vy) are as before; grants unchanged (worker login only). Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION ludy_meetings.terms_for_member_vy(p_org_id uuid, p_meeting_id uuid)
RETURNS TABLE (term text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_agent uuid := ludy_kernel.ctx_agent_id();
  v_member uuid;
  v_whole boolean;
  v_entities uuid[] := '{}';
BEGIN
  -- The audio door's whole gate, for this meeting (it raises its own fixed codes: MEETINGS_WORKER_ONLY, MEETINGS_RUN_REQUIRED, MEETINGS_NOT_RECORDER, ...).
  PERFORM 1 FROM ludy_meetings.audio_for_member_vy(p_org_id, p_meeting_id) LIMIT 1;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  -- The gate passed, so the agent is this member's active Vy and the member is the meeting's recorder.
  SELECT a.member_user_id INTO v_member
  FROM ludy_kernel.agent a
  WHERE a.org_id = v_org AND a.id = v_agent AND a.kind = 'member_vy' AND a.status = 'active';
  IF v_member IS NULL THEN
    RETURN;
  END IF;
  -- The recorder's entity scope, as enter_context gives it to the member's own user context: the whole org for an owner or admin, a member with an org-wide role assignment or one with no assignment at all, otherwise
  -- the legal entities the assignments name (#3532). A party outside that scope is not named, so the day parties carry a restrictive per-entity policy this definer (which bypasses RLS) cannot hand its names to the
  -- transcription provider; until then a party is read as before by everyone with the whole-org scope, and a member limited to some entities reads the parties linked to those entities.
  v_whole := EXISTS (SELECT 1 FROM ludy_kernel.tenant_member tm WHERE tm.org_id = v_org AND tm.user_id = v_member AND tm.role IN ('owner', 'admin'))
    OR EXISTS (SELECT 1 FROM ludy_kernel.role_assignment ra WHERE ra.org_id = v_org AND ra.user_id = v_member AND ra.legal_entity_id IS NULL)
    OR NOT EXISTS (SELECT 1 FROM ludy_kernel.role_assignment ra WHERE ra.org_id = v_org AND ra.user_id = v_member);
  IF NOT v_whole THEN
    SELECT COALESCE(pg_catalog.array_agg(DISTINCT ra.legal_entity_id), '{}') INTO v_entities
    FROM ludy_kernel.role_assignment ra
    WHERE ra.org_id = v_org AND ra.user_id = v_member AND ra.legal_entity_id IS NOT NULL;
  END IF;

  RETURN QUERY
  WITH people AS (
    SELECT v_member AS user_id, 0 AS rank
    UNION ALL
    SELECT r.user_id, 1
    FROM ludy_meetings.meeting_reader r
    WHERE r.org_id = v_org AND r.meeting_id = p_meeting_id AND r.user_id <> v_member
  ),
  -- The parties this meeting is linked to, each as the party it was kept as (a duplicate stands for the party it was merged into).
  linked AS (
    SELECT DISTINCT coalesce(p.duplicate_of, p.id) AS party_id
    FROM ludy_meetings.meeting_link l
    JOIN ludy_kernel.party p ON p.org_id = l.org_id AND p.id = l.party_id
    WHERE l.org_id = v_org AND l.meeting_id = p_meeting_id AND l.party_id IS NOT NULL
      AND (v_whole OR EXISTS (SELECT 1 FROM ludy_kernel.record_le rl WHERE rl.org_id = v_org AND rl.record_type = 'kernel.party' AND rl.record_id = p.id AND rl.legal_entity_id = ANY (v_entities)))
  ),
  names AS (
    SELECT pr.display_name AS term, people.rank AS rank, pr.display_name AS sort_key
    FROM people
    JOIN ludy_kernel.member_profiles((SELECT pg_catalog.array_agg(DISTINCT people.user_id) FROM people)) pr ON pr.user_id = people.user_id
    WHERE pr.display_name IS NOT NULL
    UNION ALL
    -- The linked party itself.
    SELECT k.name, 2, k.name
    FROM linked
    JOIN ludy_kernel.party k ON k.org_id = v_org AND k.id = linked.party_id
    WHERE true AND (v_whole OR EXISTS (SELECT 1 FROM ludy_kernel.record_le rl WHERE rl.org_id = v_org AND rl.record_type = 'kernel.party' AND rl.record_id = k.id AND rl.legal_entity_id = ANY (v_entities)))
    UNION ALL
    -- A company's people (a person whose company it is, never a duplicate), or a person's company.
    SELECT c.name, 3, c.name
    FROM linked
    JOIN ludy_kernel.party k ON k.org_id = v_org AND k.id = linked.party_id
    JOIN ludy_kernel.party c ON c.org_id = v_org AND c.duplicate_of IS NULL AND (
      (k.kind = 'organization' AND c.kind = 'person' AND c.company_id = k.id)
      OR (k.kind = 'person' AND c.kind = 'organization' AND c.id = k.company_id)
    )
    WHERE true AND (v_whole OR EXISTS (SELECT 1 FROM ludy_kernel.record_le rl WHERE rl.org_id = v_org AND rl.record_type = 'kernel.party' AND rl.record_id = k.id AND rl.legal_entity_id = ANY (v_entities))) AND (v_whole OR EXISTS (SELECT 1 FROM ludy_kernel.record_le rl WHERE rl.org_id = v_org AND rl.record_type = 'kernel.party' AND rl.record_id = c.id AND rl.legal_entity_id = ANY (v_entities)))
  )
  -- 'Đã xóa theo yêu cầu' is ERASED_PARTY_NAME (packages/kernel/src/personal-data.ts), the name an erased party keeps: not a name to spell.
  SELECT n.term FROM names n WHERE n.term IS NOT NULL AND n.term <> 'Đã xóa theo yêu cầu' ORDER BY n.rank, n.sort_key LIMIT 200;
END;
$$;
REVOKE ALL ON FUNCTION ludy_meetings.terms_for_member_vy(uuid, uuid) FROM PUBLIC;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE 'ludy\_%' AND rolname <> current_user LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_meetings.terms_for_member_vy(uuid, uuid) FROM %I', r.rolname);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION ludy_meetings.terms_for_member_vy(uuid, uuid) TO ludy_worker;
