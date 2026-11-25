-- SPDX-License-Identifier: AGPL-3.0-only
-- Ludy CRM (issue #3423): bound the `crm_deal` stream hints of a statement that writes many deals, as 20270326210000_ludy_kernel_party_stream_hints_bounded.sql does for contacts. The row-level trigger of
-- 20270105010000_crove_crm_stream_hints.sql sent one NOTIFY per deal, so a member's removal (owner_user_id set to NULL on each deal they owned) held PostgreSQL's cluster-wide NOTIFY lock for each.
-- Now INSERT and UPDATE are statement-level triggers with a transition table, sending through ludy_kernel.stream_hint_bounded_batch (the first 20 distinct ids per org and type in a transaction name their deal,
-- the 21st names the nil id, which a stream reads as "many deals changed", and the rest send nothing). The window sort runs once over the statement's transition table and caps rows passed per org at 21. The delete
-- trigger (one hint per org and statement) stays. Hint payloads hold ids only. Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION ludy_crm.deal_stream_hint() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_orgs uuid[];
  v_ids uuid[];
BEGIN
  -- Only as the statement triggers below: AFTER INSERT or UPDATE with the new rows as `new_rows`, named ('crm_deal', 'id') like every hint trigger, which the invariant suite reads (its scan finds the
  -- triggers that send on ludy_stream by their function's text, so the word stays here).
  IF TG_LEVEL <> 'STATEMENT' OR TG_OP NOT IN ('INSERT', 'UPDATE') OR TG_NARGS <> 2 OR TG_ARGV[0] <> 'crm_deal' OR TG_ARGV[1] <> 'id' THEN
    RAISE EXCEPTION 'STREAM_HINT_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT
    pg_catalog.array_agg(x.org_id ORDER BY x.org_id, x.id),
    pg_catalog.array_agg(x.id ORDER BY x.org_id, x.id)
  INTO v_orgs, v_ids
  FROM (
    SELECT n.org_id, n.id, pg_catalog.row_number() OVER (PARTITION BY n.org_id ORDER BY n.id) AS rn
    FROM new_rows n WHERE n.org_id IS NOT NULL AND n.id IS NOT NULL
  ) x
  WHERE x.rn <= 21;
  IF v_orgs IS NOT NULL THEN
    PERFORM ludy_kernel.stream_hint_bounded_batch('crm_deal', v_orgs, v_ids);
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION ludy_crm.deal_stream_hint() FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant, ludy_definer_einvoice, ludy_auth_reader, ludy_prober, ludy_reporter;

DROP TRIGGER IF EXISTS stream_hint ON ludy_crm.deal;
DROP TRIGGER IF EXISTS stream_hint_insert ON ludy_crm.deal;
CREATE TRIGGER stream_hint_insert AFTER INSERT ON ludy_crm.deal
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION ludy_crm.deal_stream_hint('crm_deal', 'id');
DROP TRIGGER IF EXISTS stream_hint_update ON ludy_crm.deal;
CREATE TRIGGER stream_hint_update AFTER UPDATE ON ludy_crm.deal
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION ludy_crm.deal_stream_hint('crm_deal', 'id');
