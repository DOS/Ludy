-- SPDX-License-Identifier: AGPL-3.0-only
-- The wake-up webhook, "send a test" (ADR-0051 decision 4, issue #3024, step c2): an owner or admin asks for a `ping` to a grant's receiver. The ping is a delivery like
-- any other (the same table, queue, signature, retries and checks); it only has no signal behind it and carries no data. The function stores it and answers its id; the
-- delivery sweep hands it to the queue at its next pass (a minute at most), because a ping is stored as if it had waited past the hand-over delay.
-- At most one ping a minute per grant, kept here in the database so no number of API processes can send more.

CREATE OR REPLACE FUNCTION crove_kernel.mcp_wake_test(p_grant_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_grant_user uuid;
  v_id uuid := crove_kernel.uuid_v7();
BEGIN
  PERFORM crove_kernel.mcp_wake_caller();
  SELECT g.user_id INTO v_grant_user
  FROM crove_kernel.agent_grant_wake w JOIN crove_kernel.agent_grant g ON g.org_id = w.org_id AND g.id = w.grant_id
  WHERE w.org_id = v_org AND w.grant_id = p_grant_id AND w.enabled;
  IF NOT FOUND OR NOT crove_kernel.mcp_grant_standing(p_grant_id, v_org, v_grant_user) THEN
    RAISE EXCEPTION 'MCP_WAKE_GRANT' USING ERRCODE = '22023';
  END IF;
  -- Serialize the asks of one grant, so two at once cannot both pass the check below.
  PERFORM 1 FROM crove_kernel.agent_grant_wake w WHERE w.org_id = v_org AND w.grant_id = p_grant_id FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM crove_kernel.agent_wake_delivery d
    WHERE d.org_id = v_org AND d.grant_id = p_grant_id AND d.type = 'ping' AND d.created_at > pg_catalog.clock_timestamp() - interval '1 minute'
  ) THEN
    RAISE EXCEPTION 'MCP_WAKE_TOO_SOON' USING ERRCODE = '22023';
  END IF;
  INSERT INTO crove_kernel.agent_wake_delivery (org_id, id, grant_id, type, body, queued_at)
  VALUES (
    v_org, v_id, p_grant_id, 'ping',
    pg_catalog.jsonb_build_object(
      'id', v_id, 'type', 'ping',
      'created_at', pg_catalog.to_char(pg_catalog.clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'org', v_org, 'grant', p_grant_id, 'data', '{}'::jsonb),
    pg_catalog.clock_timestamp() - interval '3 minutes'
  );
  RETURN v_id;
END $$;

REVOKE ALL ON FUNCTION crove_kernel.mcp_wake_test(uuid) FROM PUBLIC;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE 'crove\_%' AND rolname <> current_user LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION crove_kernel.mcp_wake_test(uuid) FROM %I', r.rolname);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION crove_kernel.mcp_wake_test(uuid) TO crove_app;
