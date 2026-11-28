-- SPDX-License-Identifier: AGPL-3.0-only
-- A database-backed daily cap on the drafts an MCP grant makes (#3253, follow-up of #3227, from the PO's security review of the draft tool, #3251).
--
-- The drafts budget the tool takes at the endpoint (`DraftBudget`, #386) is a token bucket in one API process's memory: a burst, then a steady rate, per instance, forgotten at a restart. A connected
-- client that loops could still leave a few thousand drafts a day for a person to review. This adds a counter on the grant, charged by the endpoint before the draft command runs, refused when the day's
-- number is used up (the day is the UTC day, so a refusal says it starts again at midnight UTC), in the style of the daily row budget (`mcp_rows_charge`).
--
--   drafts_day / drafts_used   the UTC day the counter is for, and the drafts charged on that day. A new day starts at zero.
--   mcp_drafts_charge          the endpoint's one door to it: charges one draft against the grant's cap and the org's cap, and answers 0, or the seconds until midnight UTC when a cap is used up.
--
-- The org's cap is the sum of the counters of every grant of the org, a revoked one included, so disconnecting and connecting the app again does not start the day over. One charge at a time per org
-- (a transaction advisory lock) so two grants at once cannot both pass the org's count. The charge runs in its own short transaction, before the command: the draft's write context may insert a draft
-- post and its channels and nothing else (it cannot update a grant), so the counter cannot share its transaction; an attempt that fails afterwards still counts, which only makes a looping client
-- reach the cap sooner. A grant that is unknown, of another org or revoked raises MCP_INVALID (22023), and so does a bad cap. Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

ALTER TABLE ludy_kernel.agent_grant ADD COLUMN IF NOT EXISTS drafts_day date;
ALTER TABLE ludy_kernel.agent_grant ADD COLUMN IF NOT EXISTS drafts_used integer NOT NULL DEFAULT 0;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'ludy_kernel.agent_grant'::regclass AND conname = 'agent_grant_drafts_used_check') THEN
    ALTER TABLE ludy_kernel.agent_grant ADD CONSTRAINT agent_grant_drafts_used_check CHECK (drafts_used >= 0);
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION ludy_kernel.mcp_drafts_charge(p_grant_id uuid, p_org_id uuid, p_grant_cap integer, p_org_cap integer)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_today date := (v_now AT TIME ZONE 'UTC')::date;
  v_grant_used integer;
  v_org_used bigint;
  v_wait integer;
BEGIN
  IF p_grant_id IS NULL OR p_org_id IS NULL OR p_grant_cap IS NULL OR p_grant_cap NOT BETWEEN 1 AND 100000
     OR p_org_cap IS NULL OR p_org_cap NOT BETWEEN 1 AND 1000000 THEN
    RAISE EXCEPTION 'MCP_INVALID' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('mcp.drafts:' || p_org_id::text, 0));
  SELECT CASE WHEN g.drafts_day = v_today THEN g.drafts_used ELSE 0 END INTO v_grant_used
  FROM ludy_kernel.agent_grant g
  WHERE g.org_id = p_org_id AND g.id = p_grant_id AND g.revoked_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MCP_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT COALESCE(pg_catalog.sum(CASE WHEN g.drafts_day = v_today THEN g.drafts_used ELSE 0 END), 0) INTO v_org_used
  FROM ludy_kernel.agent_grant g
  WHERE g.org_id = p_org_id;
  IF v_grant_used >= p_grant_cap OR v_org_used >= p_org_cap THEN
    -- The seconds to the next midnight UTC, at least one.
    v_wait := GREATEST(1, pg_catalog.ceil(pg_catalog.date_part('epoch', (((v_today + 1)::timestamp AT TIME ZONE 'UTC') - v_now)))::integer);
    RETURN v_wait;
  END IF;
  UPDATE ludy_kernel.agent_grant g
  SET drafts_used = CASE WHEN g.drafts_day = v_today THEN g.drafts_used + 1 ELSE 1 END,
      drafts_day = v_today
  WHERE g.org_id = p_org_id AND g.id = p_grant_id;
  RETURN 0;
END
$$;

REVOKE ALL ON FUNCTION ludy_kernel.mcp_drafts_charge(uuid, uuid, integer, integer) FROM PUBLIC;
DO $$
DECLARE
  v_role name;
BEGIN
  FOR v_role IN
    SELECT rolname
    FROM pg_catalog.pg_roles
    WHERE (rolname LIKE 'ludy\_%' ESCAPE '\' OR rolname LIKE 'crove\_%' ESCAPE '\')
      AND rolname <> current_user
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_kernel.mcp_drafts_charge(uuid, uuid, integer, integer) FROM %I', v_role);
  END LOOP;
END
$$;
GRANT EXECUTE ON FUNCTION ludy_kernel.mcp_drafts_charge(uuid, uuid, integer, integer) TO ludy_app;
