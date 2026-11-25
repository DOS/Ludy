-- SPDX-License-Identifier: AGPL-3.0-only
-- Ludy kernel (issue #3423, found in the reviews of #3422 and #3293): bound the `crm_party` stream hints. The party triggers of 20270105010100_crove_kernel_party_stream_hints.sql are row level, so a
-- contact import (up to 2000 parties, one INSERT per party and more updates) and the org purge's party updates (the duplicate_of reset, the erase of contact fields, and company_id set to NULL by its foreign
-- key) each sent one NOTIFY per row while holding PostgreSQL's cluster-wide NOTIFY lock, the problem #1992 solved for notes.
-- Now the party triggers are statement level, with transition tables, and send through one helper that tracks distinct changed row ids per org and type in one static transaction-local JSONB GUC (`ludy.stream_hint_counts`,
-- avoiding per-org GUC entries in GUCMemoryContext across pooled backend lifetimes): the first 20 distinct ids of a transaction name their party as before (`<org> crm_party <party id>`), the 21st distinct id names no party but
-- the nil id, which a stream reads as "many contacts changed" and re-reads every contact view, and the rest send nothing. So a transaction sends at most 21 notifications per org and type, whatever it writes,
-- a multi-statement write to the same row (such as INSERT followed by company_id UPDATE during import) counts once toward the 20-row threshold, and a single change still names its own party.
-- The trigger functions are SECURITY DEFINER, so the helper, which names the org it notifies, is callable by nobody else (a tenant login could otherwise send a hint to another org's streams); the helper
-- itself is not. The same rule for what a contact screen shows as before: INSERT, and an UPDATE that changes the kind, name, tax code, address, email, phone, company link, duplicate mark or version. Hint
-- payloads hold ids only. The helper is also used by the deals' triggers (20270326170000_ludy_crm_deal_stream_hints_bounded.sql). Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

-- One bounded hint: the party or deal id while the transaction has seen fewer than 20 distinct ids of this type for this org, the nil id on the 21st distinct id, nothing after.
CREATE OR REPLACE FUNCTION ludy_kernel.stream_hint_bounded(p_type text, p_org uuid, p_id uuid) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_raw text;
  v_counts pg_catalog.jsonb;
  v_key text;
  v_entry pg_catalog.jsonb;
  v_ids pg_catalog.jsonb;
  v_id_text text;
  v_next pg_catalog.jsonb;
BEGIN
  IF p_type IS NULL OR p_type NOT IN ('crm_party', 'crm_deal') THEN
    RAISE EXCEPTION 'STREAM_HINT_INVALID' USING ERRCODE = '22023';
  END IF;
  -- A row without its org or id sends nothing (fail closed, as stream_notify).
  IF p_org IS NULL OR p_id IS NULL THEN
    RETURN;
  END IF;
  -- One static transaction-local JSONB map keyed by <type>:<org_id> avoids allocating per-org GUC entries
  -- in GUCMemoryContext across pooled backend lifetimes. Each entry holds at most 20 distinct row UUIDs or
  -- 'many' once the 21st distinct id triggers the nil sentinel. Empty, malformed, or out-of-range values fail
  -- closed to an empty list so writes never fail or get silenced.
  v_raw := NULLIF(pg_catalog.current_setting('ludy.stream_hint_counts', true), '');
  IF v_raw IS NOT NULL AND pg_catalog.pg_input_is_valid(v_raw, 'jsonb') THEN
    v_counts := v_raw::pg_catalog.jsonb;
    IF pg_catalog.jsonb_typeof(v_counts) IS DISTINCT FROM 'object' THEN
      v_counts := '{}'::pg_catalog.jsonb;
    END IF;
  ELSE
    v_counts := '{}'::pg_catalog.jsonb;
  END IF;
  v_key := p_type || ':' || p_org::text;
  v_entry := pg_catalog.jsonb_extract_path(v_counts, v_key);
  IF v_entry = '"many"'::pg_catalog.jsonb THEN
    RETURN;
  END IF;
  v_id_text := p_id::text;
  IF pg_catalog.jsonb_typeof(v_entry) = 'array'
     AND pg_catalog.jsonb_array_length(v_entry) <= 20
     AND NOT EXISTS (
       SELECT 1 FROM pg_catalog.jsonb_array_elements(v_entry) AS e(val)
       WHERE pg_catalog.jsonb_typeof(e.val) IS DISTINCT FROM 'string'
     )
     AND NOT EXISTS (
       SELECT 1 FROM pg_catalog.jsonb_array_elements_text(v_entry) AS t(txt)
       WHERE t.txt IS NULL OR t.txt !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     ) THEN
    v_ids := v_entry;
  ELSE
    v_ids := '[]'::pg_catalog.jsonb;
  END IF;
  IF pg_catalog.jsonb_exists(v_ids, v_id_text) THEN
    RETURN;
  END IF;
  IF pg_catalog.jsonb_array_length(v_ids) < 20 THEN
    PERFORM pg_catalog.pg_notify('ludy_stream', p_org::text || ' ' || p_type || ' ' || v_id_text);
    v_next := pg_catalog.jsonb_concat(v_ids, pg_catalog.jsonb_build_array(v_id_text));
  ELSE
    PERFORM pg_catalog.pg_notify('ludy_stream', p_org::text || ' ' || p_type || ' 00000000-0000-0000-0000-000000000000');
    v_next := '"many"'::pg_catalog.jsonb;
  END IF;
  PERFORM pg_catalog.set_config(
    'ludy.stream_hint_counts',
    pg_catalog.jsonb_set(v_counts, ARRAY[v_key], v_next, true)::text,
    true
  );
END $$;
REVOKE ALL ON FUNCTION ludy_kernel.stream_hint_bounded(text, uuid, uuid) FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant, ludy_definer_einvoice, ludy_auth_reader, ludy_prober, ludy_reporter;

-- INSERT: the new rows are `new_rows`. The window sort runs once over the statement's transition table and passes at most 21 rows per org to the helper (20 row ids + 1 nil sentinel).
CREATE OR REPLACE FUNCTION ludy_kernel.party_stream_hint_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_hint record;
BEGIN
  -- Only as the statement trigger below: AFTER INSERT with the new rows as `new_rows`, named ('crm_party', 'id') like every hint trigger, which the invariant suite reads (its scan finds the triggers that send on
  -- ludy_stream by their function's text, so the word stays here).
  IF TG_LEVEL <> 'STATEMENT' OR TG_OP <> 'INSERT' OR TG_NARGS <> 2 OR TG_ARGV[0] <> 'crm_party' OR TG_ARGV[1] <> 'id' THEN
    RAISE EXCEPTION 'STREAM_HINT_INVALID' USING ERRCODE = '22023';
  END IF;
  FOR v_hint IN
    SELECT x.org_id, x.id FROM (
      SELECT n.org_id, n.id, pg_catalog.row_number() OVER (PARTITION BY n.org_id ORDER BY n.id) AS rn
      FROM new_rows n WHERE n.org_id IS NOT NULL AND n.id IS NOT NULL
    ) x WHERE x.rn <= 21 ORDER BY x.org_id, x.id
  LOOP
    PERFORM ludy_kernel.stream_hint_bounded('crm_party', v_hint.org_id, v_hint.id);
  END LOOP;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION ludy_kernel.party_stream_hint_insert() FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant, ludy_definer_einvoice, ludy_auth_reader, ludy_prober, ludy_reporter;

-- UPDATE: the rows before and after are `old_rows` and `new_rows`; only a row whose contact details, link, mark or version changed is a hint (the party's primary key joins them).
-- The window sort runs once over the changed rows of the statement's transition table and passes at most 21 rows per org to the helper.
CREATE OR REPLACE FUNCTION ludy_kernel.party_stream_hint_update() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_hint record;
BEGIN
  -- Named ('crm_party', 'id'); ludy_stream is the channel (see the insert function).
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
    ) x WHERE x.rn <= 21 ORDER BY x.org_id, x.id
  LOOP
    PERFORM ludy_kernel.stream_hint_bounded('crm_party', v_hint.org_id, v_hint.id);
  END LOOP;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION ludy_kernel.party_stream_hint_update() FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant, ludy_definer_einvoice, ludy_auth_reader, ludy_prober, ludy_reporter;

DROP TRIGGER IF EXISTS stream_hint ON ludy_kernel.party;
CREATE TRIGGER stream_hint AFTER INSERT ON ludy_kernel.party
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION ludy_kernel.party_stream_hint_insert('crm_party', 'id');
DROP TRIGGER IF EXISTS stream_hint_update ON ludy_kernel.party;
CREATE TRIGGER stream_hint_update AFTER UPDATE ON ludy_kernel.party
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION ludy_kernel.party_stream_hint_update('crm_party', 'id');
