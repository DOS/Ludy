-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove CRM (issue #3423): bound the `crm_deal` stream hints of a statement that writes many deals, as 20270322000000_crove_kernel_party_stream_hints_bounded.sql does for contacts. The row-level trigger of
-- 20270105010000_crove_crm_stream_hints.sql sent one NOTIFY per deal, so a member's removal (owner_user_id set to NULL on each deal they owned) held PostgreSQL's cluster-wide NOTIFY lock for each.
-- Now INSERT and UPDATE are statement-level triggers with a transition table, sending through crove_kernel.stream_hint_bounded (the first 20 hints of a transaction name their deal, the 21st names the nil id,
-- which a stream reads as "many deals changed", the rest send nothing). The delete trigger (one hint per org and statement) stays. Hint payloads hold ids only. Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_crm.deal_stream_hint() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_hint record;
BEGIN
  -- Only as the statement triggers below: AFTER INSERT or UPDATE with the new rows as `new_rows`.
  IF TG_LEVEL <> 'STATEMENT' OR TG_OP NOT IN ('INSERT', 'UPDATE') OR TG_NARGS <> 0 THEN
    RAISE EXCEPTION 'STREAM_HINT_INVALID' USING ERRCODE = '22023';
  END IF;
  FOR v_hint IN
    SELECT x.org_id, x.id FROM (
      SELECT n.org_id, n.id, pg_catalog.row_number() OVER (PARTITION BY n.org_id ORDER BY n.id) AS rn
      FROM new_rows n WHERE n.org_id IS NOT NULL AND n.id IS NOT NULL
    ) x WHERE x.rn <= 22 ORDER BY x.org_id, x.id
  LOOP
    PERFORM crove_kernel.stream_hint_bounded('crm_deal', v_hint.org_id, v_hint.id);
  END LOOP;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION crove_crm.deal_stream_hint() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant, crove_prober;

DROP TRIGGER IF EXISTS stream_hint ON crove_crm.deal;
DROP TRIGGER IF EXISTS stream_hint_insert ON crove_crm.deal;
CREATE TRIGGER stream_hint_insert AFTER INSERT ON crove_crm.deal
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION crove_crm.deal_stream_hint();
DROP TRIGGER IF EXISTS stream_hint_update ON crove_crm.deal;
CREATE TRIGGER stream_hint_update AFTER UPDATE ON crove_crm.deal
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION crove_crm.deal_stream_hint();
