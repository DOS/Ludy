-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove CRM (issue #3293, plan docs/plan/crm.md section 5 "Derived facts"): realtime hints for deals and contacts.
-- Idempotent; applied files stay untouched.
--
-- A deal board open in one browser never refreshed when another member moved a card, because no change of a deal or a
-- party sent anything on crove_stream. Now the stream_notify trigger (20261018140000, 20261107030000) sends
-- `<org_id> crm_deal <deal id>` and `<org_id> crm_party <party id>`: the id only, never a title, an amount or a name,
-- and to the streams of that org alone, which re-fetch through their normal authorized queries (RLS decides what a
-- viewer reads). Neither table is under le_scope, so neither hint names a legal entity. A stream of an org that has
-- the crm app off drops both types (apps/kernel/src/stream.ts, HINT_APPS).
--
-- crove_crm.deal      INSERT, UPDATE and DELETE (a deal is deleted for real by its command). A delete sends one hint per
--                     org and statement, naming the first deleted id (as notes do, 20261107180000), so the org purge
--                     does not write one NOTIFY per deal while it holds PostgreSQL's cluster-wide NOTIFY lock.
-- crove_kernel.party  INSERT, and an UPDATE that changes what the contact screens and deal cards show: the kind, name,
--                     tax code, address, email, phone, company link or duplicate mark, or the version (a screen sends
--                     it back with an edit, so a stale one would fail with a conflict). Finance writes the same table
--                     (a verified flag), which a contact screen does not show, so that sends nothing.
--                     No DELETE trigger: a party is deleted only by the org purge.
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

DROP TRIGGER IF EXISTS stream_hint ON crove_kernel.party;
CREATE TRIGGER stream_hint AFTER INSERT ON crove_kernel.party
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.stream_notify('crm_party', 'id');
DROP TRIGGER IF EXISTS stream_hint_update ON crove_kernel.party;
CREATE TRIGGER stream_hint_update AFTER UPDATE ON crove_kernel.party
  FOR EACH ROW
  WHEN ((OLD.kind, OLD.name, OLD.tax_code, OLD.address, OLD.email, OLD.phone, OLD.company_id, OLD.duplicate_of, OLD.version)
        IS DISTINCT FROM (NEW.kind, NEW.name, NEW.tax_code, NEW.address, NEW.email, NEW.phone, NEW.company_id, NEW.duplicate_of, NEW.version))
  EXECUTE FUNCTION crove_kernel.stream_notify('crm_party', 'id');
