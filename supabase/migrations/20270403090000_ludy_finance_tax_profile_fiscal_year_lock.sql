-- SPDX-License-Identifier: AGPL-3.0-only
-- Ludy finance (issue #5311, follow-up of #1403 TT99 books phase B): the month a fiscal year ends cannot change while an
-- org keeps Circular 99 books. Idempotent; applied files stay untouched.
--
-- ludy_finance.set_books_regime() (20270403080000) refuses an org whose fiscal year does not end in December, and reads
-- ludy_kernel.tax_profile.fiscal_year_end_month FOR SHARE, so the setting cannot change under a choice in flight. Nothing
-- stopped the setting from changing afterwards: a Circular 99 row starts on a 1 January, so an org that moved its year end to
-- March after the switch would keep a row that no longer starts a fiscal year, and year closing (December only) would
-- close the wrong months. This trigger closes that:
--
--   ludy_finance.tax_profile_fiscal_year_guard() RETURNS trigger, BEFORE INSERT OR UPDATE OF fiscal_year_end_month ON
--   ludy_kernel.tax_profile, FOR EACH ROW.
--       The month changes when an UPDATE sets another month, or an INSERT (the first save of an org that has no row, whose
--       month is December until then) names a month other than 12. A change is refused, FISCAL_YEAR_END_LOCKED (P0001), while
--       any ludy_finance.legal_entity_books row of the org has regime tt99. Saving the same month with other fields changed
--       is not a change and passes. A TT133 org changes it freely, and back.
--
-- It is the guard of the table, not of one command: kernel.tax_profile.save (packages/kernel/src/tax-calendar.ts) maps the error
-- to a domain error with words, and any other writer meets the same refusal. The function is in the finance schema, with the
-- rule it enforces and next to legal_entity_books_guard, which reads the same setting; the trigger is on the kernel table (the
-- waiver below), which is why the change is also reviewed by the shared core.
--
-- SECURITY DEFINER, keeping the migration owner as the other books functions do: it reads legal_entity_books for the row's org
-- (NEW.org_id, an explicit filter) whatever the writer's grants and row security allow, and search_path is pinned. EXECUTE is
-- revoked from every role: only the trigger fires the function, and being SECURITY DEFINER it runs as its owner. No role gets a new
-- privilege on any table. The trigger is ENABLE ALWAYS, as the other guards of the books (b_legal_entity on legal_entity_books): a
-- session_replication_role of replica, which only a superuser sets, does not skip it.
--
-- One case is not serialized: an org with no tax_profile row yet whose first save (a month other than 12) runs at the same time
-- as its first switch. An UPDATE of an existing row waits for set_books_regime()'s FOR SHARE on that row and then sees its
-- committed row; the other order is refused by set_books_regime() itself.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION ludy_finance.tax_profile_fiscal_year_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.fiscal_year_end_month IS NOT DISTINCT FROM OLD.fiscal_year_end_month THEN
    RETURN NEW;
  END IF;
  -- The first row of an org starts from the default (December): keeping it changes nothing.
  IF TG_OP = 'INSERT' AND NEW.fiscal_year_end_month = 12 THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM ludy_finance.legal_entity_books b WHERE b.org_id = NEW.org_id AND b.regime = 'tt99') THEN
    RAISE EXCEPTION 'FISCAL_YEAR_END_LOCKED' USING ERRCODE = 'P0001',
      DETAIL = pg_catalog.format('the org keeps Circular 99 books, which start on a 1 January: the month its fiscal year ends stays %s',
        CASE WHEN TG_OP = 'UPDATE' THEN OLD.fiscal_year_end_month::text ELSE '12' END);
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ludy_finance.tax_profile_fiscal_year_guard() FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;

-- migration-lint: cross-module the guard of the fiscal-year month is a finance rule (Circular 99 books start on a 1 January) on the kernel's tax profile (#5311)
DROP TRIGGER IF EXISTS tax_profile_fiscal_year_guard ON ludy_kernel.tax_profile;
-- migration-lint: cross-module the guard of the fiscal-year month is a finance rule (Circular 99 books start on a 1 January) on the kernel's tax profile (#5311)
CREATE TRIGGER tax_profile_fiscal_year_guard BEFORE INSERT OR UPDATE OF fiscal_year_end_month ON ludy_kernel.tax_profile
  FOR EACH ROW EXECUTE FUNCTION ludy_finance.tax_profile_fiscal_year_guard();
-- migration-lint: cross-module the guard of the fiscal-year month is a finance rule (Circular 99 books start on a 1 January) on the kernel's tax profile (#5311)
ALTER TABLE ludy_kernel.tax_profile ENABLE ALWAYS TRIGGER tax_profile_fiscal_year_guard;
