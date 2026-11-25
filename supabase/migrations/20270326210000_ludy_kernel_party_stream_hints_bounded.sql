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
-- payloads hold ids only. The helper is also used by the deals' triggers (20270326220000_ludy_crm_deal_stream_hints_bounded.sql). Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

-- Bounded hints for a statement batch: at most 20 distinct ids per org and type across the transaction, then the nil id on the 21st distinct id, nothing after.
-- Reads and writes the single transaction-local JSONB GUC (`ludy.stream_hint_counts`) once per statement so multi-org batches stay O(N) instead of rewriting the full map per row or org.
CREATE OR REPLACE FUNCTION ludy_kernel.stream_hint_bounded_batch(
  p_type text,
  p_orgs uuid[],
  p_ids uuid[]
) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_raw text;
  v_counts pg_catalog.jsonb;
  v_batch record;
  v_key text;
  v_entry pg_catalog.jsonb;
  v_ids text[];
  v_id uuid;
  v_id_text text;
  v_many boolean;
  v_dirty boolean;
  v_next pg_catalog.jsonb;
  v_patch_keys text[] := ARRAY[]::text[];
  v_patch_vals pg_catalog.jsonb[] := ARRAY[]::pg_catalog.jsonb[];
  v_patch pg_catalog.jsonb;
BEGIN
  IF p_type IS NULL OR p_type NOT IN ('crm_party', 'crm_deal') THEN
    RAISE EXCEPTION 'STREAM_HINT_INVALID' USING ERRCODE = '22023';
  END IF;
  -- Empty or null batches send nothing (fail closed, as stream_notify); mismatched or multi-dimensional arrays reject.
  IF p_orgs IS NULL OR p_ids IS NULL THEN
    RETURN;
  END IF;
  IF pg_catalog.cardinality(p_orgs) <> pg_catalog.cardinality(p_ids) THEN
    RAISE EXCEPTION 'STREAM_HINT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.cardinality(p_orgs) = 0 THEN
    RETURN;
  END IF;
  IF pg_catalog.array_ndims(p_orgs) <> 1 OR pg_catalog.array_ndims(p_ids) <> 1 THEN
    RAISE EXCEPTION 'STREAM_HINT_INVALID' USING ERRCODE = '22023';
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

  FOR v_batch IN
    SELECT t.org_id, pg_catalog.array_agg(t.id ORDER BY t.ord) AS ids
    FROM pg_catalog.unnest(p_orgs, p_ids) WITH ORDINALITY AS t(org_id, id, ord)
    WHERE t.org_id IS NOT NULL AND t.id IS NOT NULL
    GROUP BY t.org_id
    ORDER BY t.org_id
  LOOP
    v_key := p_type || ':' || v_batch.org_id::text;
    v_entry := pg_catalog.jsonb_extract_path(v_counts, v_key);
    IF v_entry = '"many"'::pg_catalog.jsonb THEN
      CONTINUE;
    END IF;

    v_ids := ARRAY[]::text[];
    IF v_entry IS NOT NULL THEN
      IF pg_catalog.jsonb_typeof(v_entry) = 'array'
         AND pg_catalog.jsonb_array_length(v_entry) <= 20
         AND NOT EXISTS (
           SELECT 1 FROM pg_catalog.jsonb_array_elements(v_entry) AS e(val)
           WHERE pg_catalog.jsonb_typeof(e.val) IS DISTINCT FROM 'string'
         )
         AND NOT EXISTS (
           SELECT 1 FROM pg_catalog.jsonb_array_elements_text(v_entry) AS s(txt)
           WHERE s.txt IS NULL OR s.txt !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         ) THEN
        SELECT COALESCE(pg_catalog.array_agg(s.txt ORDER BY s.ord), ARRAY[]::text[])
        INTO v_ids
        FROM pg_catalog.jsonb_array_elements_text(v_entry) WITH ORDINALITY AS s(txt, ord);
      END IF;
    END IF;

    v_many := false;
    v_dirty := false;
    FOREACH v_id IN ARRAY v_batch.ids LOOP
      v_id_text := v_id::text;
      IF v_id_text = ANY(v_ids) THEN
        CONTINUE;
      END IF;
      IF COALESCE(pg_catalog.cardinality(v_ids), 0) < 20 THEN
        PERFORM pg_catalog.pg_notify('ludy_stream', v_batch.org_id::text || ' ' || p_type || ' ' || v_id_text);
        v_ids := pg_catalog.array_append(v_ids, v_id_text);
        v_dirty := true;
      ELSE
        PERFORM pg_catalog.pg_notify('ludy_stream', v_batch.org_id::text || ' ' || p_type || ' 00000000-0000-0000-0000-000000000000');
        v_many := true;
        v_dirty := true;
        EXIT;
      END IF;
    END LOOP;

    IF v_dirty THEN
      IF v_many THEN
        v_next := '"many"'::pg_catalog.jsonb;
      ELSE
        v_next := pg_catalog.to_jsonb(v_ids);
      END IF;
      v_patch_keys := pg_catalog.array_append(v_patch_keys, v_key);
      v_patch_vals := pg_catalog.array_append(v_patch_vals, v_next);
    END IF;
  END LOOP;

  IF COALESCE(pg_catalog.cardinality(v_patch_keys), 0) > 0 THEN
    SELECT pg_catalog.jsonb_object_agg(u.k, u.v)
    INTO v_patch
    FROM pg_catalog.unnest(v_patch_keys, v_patch_vals) AS u(k, v);
    PERFORM pg_catalog.set_config(
      'ludy.stream_hint_counts',
      pg_catalog.jsonb_concat(v_counts, v_patch)::text,
      true
    );
  END IF;
END $$;
REVOKE ALL ON FUNCTION ludy_kernel.stream_hint_bounded_batch(text, uuid[], uuid[]) FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant, ludy_definer_einvoice, ludy_auth_reader, ludy_prober, ludy_reporter;

-- One bounded hint: single-row wrapper over stream_hint_bounded_batch.
CREATE OR REPLACE FUNCTION ludy_kernel.stream_hint_bounded(p_type text, p_org uuid, p_id uuid) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_type IS NULL OR p_type NOT IN ('crm_party', 'crm_deal') THEN
    RAISE EXCEPTION 'STREAM_HINT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF p_org IS NULL OR p_id IS NULL THEN
    RETURN;
  END IF;
  PERFORM ludy_kernel.stream_hint_bounded_batch(p_type, ARRAY[p_org], ARRAY[p_id]);
END $$;
REVOKE ALL ON FUNCTION ludy_kernel.stream_hint_bounded(text, uuid, uuid) FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant, ludy_definer_einvoice, ludy_auth_reader, ludy_prober, ludy_reporter;

-- INSERT: the new rows are `new_rows`. The window sort runs once over the statement's transition table and passes at most 21 rows per org to the batch helper (20 row ids + 1 nil sentinel).
CREATE OR REPLACE FUNCTION ludy_kernel.party_stream_hint_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_orgs uuid[];
  v_ids uuid[];
BEGIN
  -- Only as the statement trigger below: AFTER INSERT with the new rows as `new_rows`, named ('crm_party', 'id') like every hint trigger, which the invariant suite reads (its scan finds the triggers that send on
  -- ludy_stream by their function's text, so the word stays here).
  IF TG_LEVEL <> 'STATEMENT' OR TG_OP <> 'INSERT' OR TG_NARGS <> 2 OR TG_ARGV[0] <> 'crm_party' OR TG_ARGV[1] <> 'id' THEN
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
    PERFORM ludy_kernel.stream_hint_bounded_batch('crm_party', v_orgs, v_ids);
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION ludy_kernel.party_stream_hint_insert() FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant, ludy_definer_einvoice, ludy_auth_reader, ludy_prober, ludy_reporter;

-- UPDATE: the rows before and after are `old_rows` and `new_rows`; only a row whose contact details, link, mark or version changed is a hint (the party's primary key joins them).
-- The window sort runs once over the changed rows of the statement's transition table and passes at most 21 rows per org to the batch helper.
CREATE OR REPLACE FUNCTION ludy_kernel.party_stream_hint_update() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_orgs uuid[];
  v_ids uuid[];
BEGIN
  -- Named ('crm_party', 'id'); ludy_stream is the channel (see the insert function).
  IF TG_LEVEL <> 'STATEMENT' OR TG_OP <> 'UPDATE' OR TG_NARGS <> 2 OR TG_ARGV[0] <> 'crm_party' OR TG_ARGV[1] <> 'id' THEN
    RAISE EXCEPTION 'STREAM_HINT_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT
    pg_catalog.array_agg(x.org_id ORDER BY x.org_id, x.id),
    pg_catalog.array_agg(x.id ORDER BY x.org_id, x.id)
  INTO v_orgs, v_ids
  FROM (
    SELECT n.org_id, n.id, pg_catalog.row_number() OVER (PARTITION BY n.org_id ORDER BY n.id) AS rn
    FROM new_rows n JOIN old_rows o ON o.org_id = n.org_id AND o.id = n.id
    WHERE n.org_id IS NOT NULL AND n.id IS NOT NULL
      AND (o.kind, o.name, o.tax_code, o.address, o.email, o.phone, o.company_id, o.duplicate_of, o.version)
          IS DISTINCT FROM (n.kind, n.name, n.tax_code, n.address, n.email, n.phone, n.company_id, n.duplicate_of, n.version)
  ) x
  WHERE x.rn <= 21;
  IF v_orgs IS NOT NULL THEN
    PERFORM ludy_kernel.stream_hint_bounded_batch('crm_party', v_orgs, v_ids);
  END IF;
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
