-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove CRM (issue #3293, plan docs/plan/crm.md section 5 "Derived facts"): realtime hints for deals.
-- Idempotent; applied files stay untouched.
--
-- A deal board open in one browser never refreshed when another member moved a card, because no change of a deal
-- sent anything on crove_stream. Now the stream_notify trigger (20261018140000, 20261107030000) sends
-- `<org_id> crm_deal <deal id>`: the id only, never a title or an amount, and to the streams of that org alone, which
-- re-fetch through their normal authorized queries (RLS decides what a viewer reads). The table is not under le_scope,
-- so the hint names no legal entity. A stream of an org that has the crm app off drops it (apps/kernel/src/stream.ts,
-- HINT_APPS).
--
-- crove_crm.deal      INSERT, UPDATE and DELETE (a deal is deleted for real by its command). A delete sends one hint per
--                     org and statement, naming the first deleted id (as notes do, 20261107180000), so the org purge
--                     does not write one NOTIFY per deal while it holds PostgreSQL's cluster-wide NOTIFY lock.
-- The party's hints are in 20270105010100_crove_kernel_party_stream_hints.sql: the party table belongs to crove_kernel, and a
-- migration changes the schema of its own module.
SET LOCAL lock_timeout = '2s';

-- One hint per org for a statement that deletes deals (the transition table `gone`).
CREATE OR REPLACE FUNCTION crove_crm.stream_notify_deleted() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_hint record;
BEGIN
  -- Only as the statement trigger below: AFTER DELETE with the deleted rows as `gone`.
  IF TG_LEVEL <> 'STATEMENT' OR TG_OP <> 'DELETE' OR TG_NARGS <> 2 OR TG_ARGV[0] <> 'crm_deal' OR TG_ARGV[1] <> 'id' THEN
    RAISE EXCEPTION 'STREAM_HINT_INVALID' USING ERRCODE = '22023';
  END IF;
  -- A row without its org or id sends nothing (fail closed, as stream_notify).
  FOR v_hint IN
    SELECT g.org_id, pg_catalog.min(g.id::text) AS id
    FROM gone g
    WHERE g.org_id IS NOT NULL AND g.id IS NOT NULL
    GROUP BY g.org_id
    ORDER BY 1
  LOOP
    PERFORM pg_catalog.pg_notify('crove_stream', v_hint.org_id::text || ' crm_deal ' || v_hint.id);
  END LOOP;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION crove_crm.stream_notify_deleted() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant, crove_prober;

DROP TRIGGER IF EXISTS stream_hint ON crove_crm.deal;
CREATE TRIGGER stream_hint AFTER INSERT OR UPDATE ON crove_crm.deal
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.stream_notify('crm_deal', 'id');
DROP TRIGGER IF EXISTS stream_hint_delete ON crove_crm.deal;
CREATE TRIGGER stream_hint_delete AFTER DELETE ON crove_crm.deal
  REFERENCING OLD TABLE AS gone
  FOR EACH STATEMENT EXECUTE FUNCTION crove_crm.stream_notify_deleted('crm_deal', 'id');
