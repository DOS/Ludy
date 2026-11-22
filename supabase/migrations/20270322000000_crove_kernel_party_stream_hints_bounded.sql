-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove kernel (issue #3423, found in the reviews of #3422 and #3293): bound the `crm_party` stream hints. The party triggers of 20270105010100_crove_kernel_party_stream_hints.sql are row level, so a
-- contact import (up to 2000 parties, one INSERT per party and more updates), the org purge's party updates (the duplicate_of reset, the erase of the contact fields, company_id set to NULL by its foreign
-- key) each sent one NOTIFY per row while holding PostgreSQL's cluster-wide NOTIFY lock, the problem #1992 solved for notes.
-- Now the party triggers are statement level, with transition tables, and send through one helper that keeps a count per org and type in the transaction (a transaction-local setting, gone with it): the
-- first 20 hints of a transaction name their party as before (`<org> crm_party <party id>`), the 21st names no party but the nil id, which a stream reads as "many contacts changed" and re-reads every
-- contact view, and the rest send nothing. So a transaction sends at most 21 notifications per org and type, whatever it writes, and a single change still names its own party.
-- The trigger functions are SECURITY DEFINER, so the helper, which names the org it notifies, is callable by nobody else (a tenant login could otherwise send a hint to another org's streams); the helper
-- itself is not. The same rule for what a contact screen shows as before: INSERT, and an UPDATE that changes the kind, name, tax code, address, email, phone, company link, duplicate mark or version. Hint payloads hold
-- ids only. The helper is also used by the deals' triggers (20270322000100_crove_crm_deal_stream_hints_bounded.sql). Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

-- One bounded hint: the party or deal id while the transaction has sent fewer than 20 of this type for this org, the nil id as the 21st, nothing after.
CREATE OR REPLACE FUNCTION crove_kernel.stream_hint_bounded(p_type text, p_org uuid, p_id uuid) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_key text;
  v_n integer;
BEGIN
  IF p_type NOT IN ('crm_party', 'crm_deal') THEN
    RAISE EXCEPTION 'STREAM_HINT_INVALID' USING ERRCODE = '22023';
  END IF;
  -- A row without its org or id sends nothing (fail closed, as stream_notify).
  IF p_org IS NULL OR p_id IS NULL THEN
    RETURN;
  END IF;
  v_key := 'crove.hint_' || p_type || '_' || pg_catalog.replace(p_org::text, '-', '');
  -- A value that is not a plain count (a placeholder set by raw SQL) counts as none, so a write never fails on it.
  v_n := COALESCE(CASE WHEN pg_catalog.current_setting(v_key, true) ~ '^[0-9]{1,6}$' THEN pg_catalog.current_setting(v_key, true)::integer END, 0);
  IF v_n < 20 THEN
    PERFORM pg_catalog.pg_notify('crove_stream', p_org::text || ' ' || p_type || ' ' || p_id::text);
  ELSIF v_n = 20 THEN
    PERFORM pg_catalog.pg_notify('crove_stream', p_org::text || ' ' || p_type || ' 00000000-0000-0000-0000-000000000000');
  ELSE
    RETURN;
  END IF;
  PERFORM pg_catalog.set_config(v_key, (v_n + 1)::text, true);
END $$;
REVOKE ALL ON FUNCTION crove_kernel.stream_hint_bounded(text, uuid, uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant, crove_prober;

-- INSERT: the new rows are `new_rows`. At most 22 per org are looked at: the helper stops after the 21st, so a bigger statement costs no more.
CREATE OR REPLACE FUNCTION crove_kernel.party_stream_hint_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_hint record;
BEGIN
  -- Only as the statement trigger below: AFTER INSERT with the new rows as `new_rows`, named ('crm_party', 'id') like every hint trigger, which the invariant suite reads (its scan finds the triggers that send on
  -- crove_stream by their function's text, so the word stays here).
  IF TG_LEVEL <> 'STATEMENT' OR TG_OP <> 'INSERT' OR TG_NARGS <> 2 OR TG_ARGV[0] <> 'crm_party' OR TG_ARGV[1] <> 'id' THEN
    RAISE EXCEPTION 'STREAM_HINT_INVALID' USING ERRCODE = '22023';
  END IF;
  FOR v_hint IN
    SELECT x.org_id, x.id FROM (
      SELECT n.org_id, n.id, pg_catalog.row_number() OVER (PARTITION BY n.org_id ORDER BY n.id) AS rn
      FROM new_rows n WHERE n.org_id IS NOT NULL AND n.id IS NOT NULL
    ) x WHERE x.rn <= 22 ORDER BY x.org_id, x.id
  LOOP
    PERFORM crove_kernel.stream_hint_bounded('crm_party', v_hint.org_id, v_hint.id);
  END LOOP;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.party_stream_hint_insert() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant, crove_prober;

-- UPDATE: the rows before and after are `old_rows` and `new_rows`; only a row whose contact details, link, mark or version changed is a hint (the party's primary key joins them).
CREATE OR REPLACE FUNCTION crove_kernel.party_stream_hint_update() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_hint record;
BEGIN
  -- Named ('crm_party', 'id'); crove_stream is the channel (see the insert function).
  IF TG_LEVEL <> 'STATEMENT' OR TG_OP <> 'UPDATE' OR TG_NARGS <> 2 OR TG_ARGV[0] <> 'crm_party' OR TG_ARGV[1] <> 'id' THEN
    RAISE EXCEPTION 'STREAM_HINT_INVALID' USING ERRCODE = '22023';
  END IF;
  FOR v_hint IN
    SELECT x.org_id, x.id FROM (
      SELECT n.org_id, n.id, pg_catalog.row_number() OVER (PARTITION BY n.org_id ORDER BY n.id) AS rn
      FROM new_rows n JOIN old_rows o ON o.org_id = n.org_id AND o.id = n.id
      WHERE n.org_id IS NOT NULL AND n.id IS NOT NULL
        AND (o.kind, o.name, o.tax_code, o.address, o.email, o.phone, o.company_id, o.duplicate_of, o.version)
            IS DISTINCT FROM (n.kind, n.name, n.tax_code, n.address, n.email, n.phone, n.company_id, n.duplicate_of, n.version)
    ) x WHERE x.rn <= 22 ORDER BY x.org_id, x.id
  LOOP
    PERFORM crove_kernel.stream_hint_bounded('crm_party', v_hint.org_id, v_hint.id);
  END LOOP;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.party_stream_hint_update() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant, crove_prober;

DROP TRIGGER IF EXISTS stream_hint ON crove_kernel.party;
CREATE TRIGGER stream_hint AFTER INSERT ON crove_kernel.party
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION crove_kernel.party_stream_hint_insert('crm_party', 'id');
DROP TRIGGER IF EXISTS stream_hint_update ON crove_kernel.party;
CREATE TRIGGER stream_hint_update AFTER UPDATE ON crove_kernel.party
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION crove_kernel.party_stream_hint_update('crm_party', 'id');
