-- SPDX-License-Identifier: AGPL-3.0-only
-- The per-grant daily row budget of the MCP endpoint (#2975, ADR-0051).
--
-- A grant may read only so many rows of business data a day, however fast it asks, so one connected AI app cannot walk
-- the whole customer list out in a few calls. The endpoint checks the budget before a tool runs and charges the rows
-- the tool returned after it ran (a call that starts under the budget may end over it by at most one answer, which a
-- tool caps at 50 rows). The day is the UTC day. The counter lives on the grant, so it dies with it and a revoke
-- resets nothing the person could use.
--
--   rows_day / rows_used   the UTC day the counter is for, and the rows charged on that day. A new day starts at zero.
--   mcp_rows_charge        the endpoint's one door to it: charges p_rows (0 only reads) and answers the rows left today.

ALTER TABLE crove_kernel.agent_grant ADD COLUMN IF NOT EXISTS rows_day date;
ALTER TABLE crove_kernel.agent_grant ADD COLUMN IF NOT EXISTS rows_used integer NOT NULL DEFAULT 0;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'crove_kernel.agent_grant'::regclass AND conname = 'agent_grant_rows_used_check') THEN
    ALTER TABLE crove_kernel.agent_grant ADD CONSTRAINT agent_grant_rows_used_check CHECK (rows_used >= 0);
  END IF;
END $$;

-- Charges p_rows against the grant's budget of the UTC day and answers how many rows are left (never below 0). p_rows = 0 charges nothing
-- and only reads, so the endpoint can refuse a call before running it. A grant that is unknown, of another org or revoked raises
-- MCP_INVALID (22023); a bad count or budget does too.
CREATE OR REPLACE FUNCTION crove_kernel.mcp_rows_charge(p_grant_id uuid, p_org_id uuid, p_rows integer, p_budget integer)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_today date := (pg_catalog.clock_timestamp() AT TIME ZONE 'UTC')::date;
  v_used integer;
BEGIN
  IF p_grant_id IS NULL OR p_org_id IS NULL OR p_rows IS NULL OR p_rows NOT BETWEEN 0 AND 1000
     OR p_budget IS NULL OR p_budget NOT BETWEEN 1 AND 10000000 THEN
    RAISE EXCEPTION 'MCP_INVALID' USING ERRCODE = '22023';
  END IF;
  IF p_rows = 0 THEN
    SELECT CASE WHEN g.rows_day = v_today THEN g.rows_used ELSE 0 END INTO v_used
    FROM crove_kernel.agent_grant g WHERE g.org_id = p_org_id AND g.id = p_grant_id AND g.revoked_at IS NULL;
  ELSE
    UPDATE crove_kernel.agent_grant g
    SET rows_used = CASE WHEN g.rows_day = v_today THEN (CASE WHEN g.rows_used > 2000000000 THEN g.rows_used ELSE g.rows_used + p_rows END) ELSE p_rows END,
        rows_day = v_today
    WHERE g.org_id = p_org_id AND g.id = p_grant_id AND g.revoked_at IS NULL
    RETURNING g.rows_used INTO v_used;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MCP_INVALID' USING ERRCODE = '22023';
  END IF;
  RETURN CASE WHEN v_used >= p_budget THEN 0 ELSE p_budget - v_used END;
END $$;

REVOKE ALL ON FUNCTION crove_kernel.mcp_rows_charge(uuid, uuid, integer, integer) FROM PUBLIC;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE 'crove\_%' AND rolname <> current_user LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION crove_kernel.mcp_rows_charge(uuid, uuid, integer, integer) FROM %I', r.rolname);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION crove_kernel.mcp_rows_charge(uuid, uuid, integer, integer) TO crove_app;
