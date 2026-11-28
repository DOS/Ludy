-- SPDX-License-Identifier: AGPL-3.0-only
-- Ludy finance (issue #5311, follow-up of #1403 TT99 books phase B): ludy_finance.set_books_regime() takes the advisory lock of the
-- org's tax profile before it reads the profile. Idempotent; applied files stay untouched.
--
-- 20270403120000 guards the month a fiscal year ends while an org keeps Circular 99 books. An org with no tax_profile row yet has no
-- row for this function's FOR SHARE to wait on, so its first save (an INSERT of a month other than 12) could commit next to its
-- first switch. kernel.tax_profile.save already takes pg_advisory_xact_lock(hashtext('ludy_kernel.tax_profile:' || org)) first; the
-- switch now takes the same lock before reading the profile, and the guard takes it when the month changes (a re-entrant lock for
-- the save command). Whoever comes second waits for the first to commit and then reads its rows.
--
-- This restates set_books_regime() exactly as 20270403080000 defines it, apart from the one PERFORM line marked #5311. Its grants
-- are restated as the original (EXECUTE for ludy_tenant only). No other function and no table change.
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
  v_pending uuid[];
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
  -- #5311: the lock kernel.tax_profile.save takes, before the profile is read, so a first save (an INSERT, there is no row to lock yet)
  -- and this switch are serialized: the second reads what the first committed. Same key on both sides, taken first, so no deadlock.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('ludy_kernel.tax_profile:' || v_org::text));
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
  -- Posting proposals waiting for approval and dated from the switch on (or with no date) are not carried across it.
  v_pending := ludy_finance.books_pending_proposals(v_org, v_entity, p_effective_from);
  IF v_pending IS NOT NULL THEN
    RAISE EXCEPTION 'BOOKS_PENDING_PROPOSALS' USING DETAIL = pg_catalog.json_build_object('proposalIds', v_pending)::text;
  END IF;
  -- The guard (BOOKS_REGIME_IN_USE) refuses when an entry of the entity falls on or after the date.
  INSERT INTO ludy_finance.legal_entity_books (org_id, legal_entity_id, regime, chart_version, effective_from, created_by)
  VALUES (v_org, v_entity, 'tt99', '2026.1', p_effective_from, ludy_kernel.ctx_user_id());
  RETURN p_effective_from;
END $$;

REVOKE ALL ON FUNCTION ludy_finance.set_books_regime(uuid, date) FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION ludy_finance.set_books_regime(uuid, date) TO ludy_tenant;
