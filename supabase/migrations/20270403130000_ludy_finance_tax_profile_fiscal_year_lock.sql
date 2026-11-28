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
--       month is December until then) names a month other than 12. A change to a month other than December is refused,
--       FISCAL_YEAR_END_LOCKED (P0001), while any ludy_finance.legal_entity_books row of the org has regime tt99. A change to
--       December is always allowed, it is the only value Circular 99 books accept, so a row left under another month can be
--       repaired without cancelling the books. Saving the same month with other fields changed is not a change and passes.
--       A TT133 org changes the month freely, and back.
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
-- The race with the first switch: an org with no tax_profile row has no row to lock, so a first save of month 3 (an INSERT) could
-- commit next to a first set_books_regime() that read no row and took December. Both sides now take the transaction advisory lock
-- the save command already takes, pg_advisory_xact_lock(hashtext('ludy_kernel.tax_profile:' || org)), before they read or write the
-- month: this guard when the month changes to another than December (the lock is re-entrant, so the save command, which holds it
-- already, does not wait for itself), and set_books_regime() (restated in 20270403140000) before it reads the profile. The save, or
-- the switch, that comes second waits for the first to commit and then reads its committed rows. Any other writer that updates an
-- existing row without the lock first can meet a deadlock with a switch; PostgreSQL ends one of the two (40P01) and the refusal
-- is never a silent pass.
--
-- Circular 99 books are new (the Settings card to choose them came with phase B2 of #1403), so no org is expected to hold a
-- row under another month than December; the block at the end says so out loud if one does.
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
  -- December is the only month Circular 99 books accept (and the default of a first row): moving to it, or keeping it on a first
  -- row, is never refused, which also lets a row that is under another month be repaired.
  IF NEW.fiscal_year_end_month = 12 THEN
    RETURN NEW;
  END IF;
  -- Same key as kernel.tax_profile.save and set_books_regime(): whoever comes second sees what the first committed.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('ludy_kernel.tax_profile:' || NEW.org_id::text));
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

-- migration-lint: cross-module read-only check of the kernel's tax profile against the finance books; it changes nothing (#5311)
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT t.org_id, t.fiscal_year_end_month FROM ludy_kernel.tax_profile t
           WHERE t.fiscal_year_end_month <> 12 AND EXISTS (SELECT 1 FROM ludy_finance.legal_entity_books b WHERE b.org_id = t.org_id AND b.regime = 'tt99')
  LOOP
    RAISE NOTICE 'org % keeps Circular 99 books but its fiscal year ends in month %: save the month as 12 to repair it', r.org_id, r.fiscal_year_end_month;
  END LOOP;
END $$;
