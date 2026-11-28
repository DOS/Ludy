-- SPDX-License-Identifier: AGPL-3.0-only
-- Ludy finance (issue #1403, TT99 books phase B, slice B1): the owner chooses Circular 99 for an entity's books, and takes
-- back a choice nobody has used yet. Idempotent; applied files stay untouched.
--
-- ludy_finance.legal_entity_books is read only for every runtime role (20261103020000: INSERT, UPDATE and DELETE revoked
-- from the tenant role), so until now only a migration could make an entity keep TT99 books. Two functions are the one
-- write path, in the shape of lock_period and unlock_period (20261106140000):
--
--   ludy_finance.set_books_regime(p_legal_entity_id uuid, p_effective_from date) RETURNS date
--       An owner adds the row (regime tt99, chart version 2026.1) from p_effective_from, the first day of a fiscal year, and
--       gets the date back. Refused, each a named error, in this order:
--         BOOKS_DATE_INVALID               22023  not a 1 January, or before 2026-01-01 (Circular 99 Art. 31(1): fiscal
--                                                 years starting on or after that date)
--         BOOKS_FISCAL_YEAR_UNSUPPORTED    P0001  the org's fiscal year does not end in December (year closing in the app
--                                                 closes 31 December only)
--         (a repeat of the same row is answered, nothing is written)
--         BOOKS_ALREADY_TT99               P0001  the books in force on that date are not TT133 2026.1 (only that switch
--                                                 is in scope; going back needs a re-notification and a year, TT133 Art. 3.1)
--         BOOKS_LATER_ROW                  P0001  the entity has a books row starting after that date
--         BOOKS_OPENING_ENTRY_BLOCKS       23514  an opening entry dated the day before exists, reversed or not. It is under
--                                                 TT133 (the chart of the day after, 20270403010000), and the guard counts it
--                                                 under this row, reversed or not (a reversal of an opening entry is dated
--                                                 on the opening's own date), so reversing it does not free that 1 January.
--                                                 The detail names the entry and the next 1 January that is free.
--         BOOKS_REGIME_IN_USE              23514  an entry of the entity dated on or after the date: the guard, unchanged,
--                                                 is the last word.
--   ludy_finance.cancel_books_regime(p_legal_entity_id uuid, p_effective_from date) RETURNS boolean
--       An owner or an admin deletes that tt99 row while no entry of the entity falls under it (the guard decides, again
--       BOOKS_REGIME_IN_USE), so a wrong choice for a year to come is undone until the year is used. A row that is not there,
--       or is not a tt99 row, is BOOKS_NOT_FOUND (P0001): TT133, which every entity without a row keeps, is never deleted.
--
-- Both are SECURITY DEFINER and keep the migration owner, as lock_period and unlock_period do: the owner already writes the
-- table, so no role gets a new privilege on it (a login role, ludy_definer_tenant included, still cannot insert, update or
-- delete a row), and the functions see every entry of the entity, so the guard cannot miss what an entity-scoped caller
-- cannot see. Each, in order:
--   - the org comes from ludy_kernel.ctx_org_id(), else NO_CONTEXT (42501);
--   - the caller's membership row is locked FOR SHARE first (#1348), then assert_period_lock_role names the roles that may
--     (an owner for set, an owner or an admin for cancel) and refuses every actor that is not a person (PERIOD_LOCK_FORBIDDEN,
--     42501);
--   - the entity is resolved through the caller's entity scope by period_lock_entity (LEGAL_ENTITY_NOT_ALLOWED, 42501);
--   - the org's tax profile is read FOR SHARE (set only), so the fiscal-year end cannot change under the choice;
--   - the entity's period_lock row is taken FOR UPDATE, the row every posting reads before it writes (the guard takes it
--     too), before anything about the entity's entries is read.
-- The command that calls them is finance.books.set_regime (R3, owner only) and finance.books.cancel_regime (R3, owner or
-- admin), in modules/finance/src/books-regime.ts. check_account_ref and legal_entity_books_guard are not touched.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION ludy_finance.set_books_regime(p_legal_entity_id uuid, p_effective_from date) RETURNS date
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_entity uuid;
  v_end_month smallint;
  v_regime text;
  v_version text;
  v_from date;
  v_later date;
  v_opening_id uuid;
  v_opening_date date;
  v_opening_reversed boolean;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  -- The caller's membership first (#1348), as lock_period and unlock_period take it: a revoke or demotion that committed
  -- before is read by the checks below, and one that starts later waits for this transaction.
  PERFORM 1 FROM ludy_kernel.tenant_member m WHERE m.org_id = v_org AND m.user_id = ludy_kernel.ctx_user_id() FOR SHARE;
  PERFORM ludy_finance.assert_period_lock_role(ARRAY['owner']);
  v_entity := ludy_finance.period_lock_entity(v_org, p_legal_entity_id);
  IF p_effective_from IS NULL OR pg_catalog.date_part('month', p_effective_from) <> 1 OR pg_catalog.date_part('day', p_effective_from) <> 1
     OR p_effective_from < DATE '2026-01-01' THEN
    RAISE EXCEPTION 'BOOKS_DATE_INVALID' USING ERRCODE = '22023',
      DETAIL = pg_catalog.json_build_object('effectiveFrom', p_effective_from)::text;
  END IF;
  SELECT t.fiscal_year_end_month INTO v_end_month FROM ludy_kernel.tax_profile t WHERE t.org_id = v_org FOR SHARE;
  IF coalesce(v_end_month, 12) <> 12 THEN
    RAISE EXCEPTION 'BOOKS_FISCAL_YEAR_UNSUPPORTED' USING DETAIL = pg_catalog.json_build_object('fiscalYearEndMonth', v_end_month)::text;
  END IF;
  -- The entity's books and entries are held until this commits: no posting reads them, and none is written, in between.
  INSERT INTO ludy_finance.period_lock (org_id, legal_entity_id) VALUES (v_org, v_entity) ON CONFLICT (org_id, legal_entity_id) DO NOTHING;
  PERFORM 1 FROM ludy_finance.period_lock p WHERE p.org_id = v_org AND p.legal_entity_id = v_entity FOR UPDATE;
  -- The same choice again is answered, not written twice.
  IF EXISTS (SELECT 1 FROM ludy_finance.legal_entity_books b
             WHERE b.org_id = v_org AND b.legal_entity_id = v_entity AND b.effective_from = p_effective_from AND b.regime = 'tt99' AND b.chart_version = '2026.1') THEN
    RETURN p_effective_from;
  END IF;
  SELECT b.regime, b.chart_version, b.effective_from INTO v_regime, v_version, v_from FROM ludy_finance.legal_entity_books b
  WHERE b.org_id = v_org AND b.legal_entity_id = v_entity AND b.effective_from <= p_effective_from
  ORDER BY b.effective_from DESC LIMIT 1;
  IF FOUND AND (v_regime, v_version) <> ('tt133', '2026.1') THEN
    RAISE EXCEPTION 'BOOKS_ALREADY_TT99' USING DETAIL = pg_catalog.json_build_object('regime', v_regime, 'chartVersion', v_version, 'since', v_from)::text;
  END IF;
  SELECT min(b.effective_from) INTO v_later FROM ludy_finance.legal_entity_books b
  WHERE b.org_id = v_org AND b.legal_entity_id = v_entity AND b.effective_from > p_effective_from;
  IF v_later IS NOT NULL THEN
    RAISE EXCEPTION 'BOOKS_LATER_ROW' USING DETAIL = pg_catalog.json_build_object('effectiveFrom', p_effective_from, 'laterFrom', v_later)::text;
  END IF;
  -- An opening entry of the day before is under TT133 and counted under this row, reversed or not.
  SELECT e.id, e.entry_date, EXISTS (SELECT 1 FROM ludy_finance.journal_entry r WHERE r.org_id = e.org_id AND r.reverses_entry_id = e.id)
  INTO v_opening_id, v_opening_date, v_opening_reversed
  FROM ludy_finance.journal_entry e
  WHERE e.org_id = v_org AND e.legal_entity_id = v_entity AND e.source_type = 'finance.opening_balance'
    AND e.reverses_entry_id IS NULL AND e.entry_date = p_effective_from - 1
  ORDER BY e.id LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'BOOKS_OPENING_ENTRY_BLOCKS' USING ERRCODE = '23514',
      DETAIL = pg_catalog.json_build_object('entryId', v_opening_id, 'entryDate', v_opening_date, 'reversed', v_opening_reversed,
                                            'nextEffectiveFrom', (p_effective_from + pg_catalog.make_interval(years => 1))::date)::text;
  END IF;
  -- The guard (BOOKS_REGIME_IN_USE) refuses when an entry of the entity falls on or after the date.
  INSERT INTO ludy_finance.legal_entity_books (org_id, legal_entity_id, regime, chart_version, effective_from, created_by)
  VALUES (v_org, v_entity, 'tt99', '2026.1', p_effective_from, ludy_kernel.ctx_user_id());
  RETURN p_effective_from;
END $$;

CREATE OR REPLACE FUNCTION ludy_finance.cancel_books_regime(p_legal_entity_id uuid, p_effective_from date) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_entity uuid;
  v_deleted integer;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM ludy_kernel.tenant_member m WHERE m.org_id = v_org AND m.user_id = ludy_kernel.ctx_user_id() FOR SHARE;
  PERFORM ludy_finance.assert_period_lock_role(ARRAY['owner', 'admin']);
  v_entity := ludy_finance.period_lock_entity(v_org, p_legal_entity_id);
  IF p_effective_from IS NULL THEN
    RAISE EXCEPTION 'BOOKS_DATE_INVALID' USING ERRCODE = '22023', DETAIL = pg_catalog.json_build_object('effectiveFrom', p_effective_from)::text;
  END IF;
  INSERT INTO ludy_finance.period_lock (org_id, legal_entity_id) VALUES (v_org, v_entity) ON CONFLICT (org_id, legal_entity_id) DO NOTHING;
  PERFORM 1 FROM ludy_finance.period_lock p WHERE p.org_id = v_org AND p.legal_entity_id = v_entity FOR UPDATE;
  -- Only a tt99 row of this org, this entity and this date; the guard refuses (BOOKS_REGIME_IN_USE) once an entry falls under it.
  DELETE FROM ludy_finance.legal_entity_books b
  WHERE b.org_id = v_org AND b.legal_entity_id = v_entity AND b.effective_from = p_effective_from AND b.regime = 'tt99';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  IF v_deleted = 0 THEN
    RAISE EXCEPTION 'BOOKS_NOT_FOUND' USING DETAIL = pg_catalog.json_build_object('effectiveFrom', p_effective_from)::text;
  END IF;
  RETURN true;
END $$;

REVOKE ALL ON FUNCTION ludy_finance.set_books_regime(uuid, date), ludy_finance.cancel_books_regime(uuid, date)
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION ludy_finance.set_books_regime(uuid, date), ludy_finance.cancel_books_regime(uuid, date) TO ludy_tenant;
