-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove meetings #4043 (step 3b): crove_meetings.glossary_for_recorder(p_meeting_id uuid) returns the organization's glossary terms (term text only, up to 60 in deterministic order) for the
-- meeting recorder's own text runs (summary, translation, chapters, title), under owner Option 1 approval (#4043#issuecomment-7048555673) and invariant pre-listing (#4309).
-- The glossary_term table remains owner/admin-only under RLS; this definer runs strictly in a user context on crove_app, verifies active org and active non-disabled member standing plus
-- crove_meetings.is_meeting_recorder(v_org, p_meeting_id) (and text retention not expired), and refuses every other caller (non-recorder attendee, non-member, viewer, disabled user,
-- inactive org, agent/system context, crove_worker, crove_tenant, crove_definer_tenant) with ERRCODE 42501.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_meetings.glossary_for_recorder(p_meeting_id uuid)
RETURNS TABLE (term text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_user uuid := crove_kernel.ctx_user_id();
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_app', 'MEMBER') THEN
    RAISE EXCEPTION 'GLOSSARY_APP_ONLY' USING ERRCODE = '42501';
  END IF;
  IF v_org IS NULL OR v_user IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM crove_kernel.tenant_member m
    JOIN crove_kernel.tenant t ON t.org_id = m.org_id AND t.status = 'active'
    JOIN crove_kernel.user_account u ON u.id = m.user_id AND u.disabled_at IS NULL
    WHERE m.org_id = v_org AND m.user_id = v_user AND m.role IN ('owner', 'admin', 'member')
  ) THEN
    RAISE EXCEPTION 'GLOSSARY_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_meeting_id IS NULL
     OR NOT crove_meetings.is_meeting_recorder(v_org, p_meeting_id)
     OR NOT EXISTS (
       SELECT 1
       FROM crove_meetings.meeting mt
       WHERE mt.org_id = v_org
         AND mt.id = p_meeting_id
         AND mt.recorder_user_id = v_user
         AND (mt.text_retention_date IS NULL OR mt.text_retention_date > (pg_catalog.now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date)
     ) THEN
    RAISE EXCEPTION 'GLOSSARY_NOT_RECORDER' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT gt.term
  FROM crove_meetings.glossary_term gt
  WHERE gt.org_id = v_org
  ORDER BY pg_catalog.lower(gt.term), gt.id
  LIMIT 60;
END $$;

REVOKE ALL ON FUNCTION crove_meetings.glossary_for_recorder(uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE 'crove\_%' AND rolname <> current_user LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION crove_meetings.glossary_for_recorder(uuid) FROM %I', r.rolname);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION crove_meetings.glossary_for_recorder(uuid) TO crove_app;
