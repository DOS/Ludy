-- SPDX-License-Identifier: AGPL-3.0-only
-- ADR-0054 (#1682, #3971): rename all 9 module schemas (`crove_<module>` -> `ludy_<module>`),
-- restate PL/pgSQL/SQL routine bodies and parent trigger definitions referencing module schemas,
-- and update `ludy_kernel` catalog table registries.

-- ---------------------------------------------------------------------------
-- 1. Rename all 9 module schemas atomically and idempotently
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF pg_catalog.to_regnamespace('crove_finance') IS NOT NULL AND pg_catalog.to_regnamespace('ludy_finance') IS NULL THEN
-- ludy:contract adr=0054
-- migration-lint: cross-module ADR-0054 module schema cutover
    ALTER SCHEMA crove_finance RENAME TO ludy_finance;
  END IF;
  IF pg_catalog.to_regnamespace('crove_hr') IS NOT NULL AND pg_catalog.to_regnamespace('ludy_hr') IS NULL THEN
-- ludy:contract adr=0054
-- migration-lint: cross-module ADR-0054 module schema cutover
    ALTER SCHEMA crove_hr RENAME TO ludy_hr;
  END IF;
  IF pg_catalog.to_regnamespace('crove_crm') IS NOT NULL AND pg_catalog.to_regnamespace('ludy_crm') IS NULL THEN
-- ludy:contract adr=0054
-- migration-lint: cross-module ADR-0054 module schema cutover
    ALTER SCHEMA crove_crm RENAME TO ludy_crm;
  END IF;
  IF pg_catalog.to_regnamespace('crove_social') IS NOT NULL AND pg_catalog.to_regnamespace('ludy_social') IS NULL THEN
-- ludy:contract adr=0054
-- migration-lint: cross-module ADR-0054 module schema cutover
    ALTER SCHEMA crove_social RENAME TO ludy_social;
  END IF;
  IF pg_catalog.to_regnamespace('crove_ads') IS NOT NULL AND pg_catalog.to_regnamespace('ludy_ads') IS NULL THEN
-- ludy:contract adr=0054
-- migration-lint: cross-module ADR-0054 module schema cutover
    ALTER SCHEMA crove_ads RENAME TO ludy_ads;
  END IF;
  IF pg_catalog.to_regnamespace('crove_notes') IS NOT NULL AND pg_catalog.to_regnamespace('ludy_notes') IS NULL THEN
-- ludy:contract adr=0054
-- migration-lint: cross-module ADR-0054 module schema cutover
    ALTER SCHEMA crove_notes RENAME TO ludy_notes;
  END IF;
  IF pg_catalog.to_regnamespace('crove_projects') IS NOT NULL AND pg_catalog.to_regnamespace('ludy_projects') IS NULL THEN
-- ludy:contract adr=0054
-- migration-lint: cross-module ADR-0054 module schema cutover
    ALTER SCHEMA crove_projects RENAME TO ludy_projects;
  END IF;
  IF pg_catalog.to_regnamespace('crove_meetings') IS NOT NULL AND pg_catalog.to_regnamespace('ludy_meetings') IS NULL THEN
-- ludy:contract adr=0054
-- migration-lint: cross-module ADR-0054 module schema cutover
    ALTER SCHEMA crove_meetings RENAME TO ludy_meetings;
  END IF;
  IF pg_catalog.to_regnamespace('crove_sign') IS NOT NULL AND pg_catalog.to_regnamespace('ludy_sign') IS NULL THEN
-- ludy:contract adr=0054
-- migration-lint: cross-module ADR-0054 module schema cutover
    ALTER SCHEMA crove_sign RENAME TO ludy_sign;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Restate PL/pgSQL and SQL routine bodies from crove_<module> to ludy_<module>
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r record;
  v_def text;
  v_new_def text;
  v_is_super boolean := (SELECT rl.rolsuper FROM pg_catalog.pg_roles rl WHERE rl.rolname = current_user);
  v_role text;
BEGIN
  IF NOT v_is_super THEN
    FOR v_role IN
      SELECT unnest(ARRAY['ludy_definer_tenant', 'ludy_definer_einvoice', 'ludy_auth_reader'])
    LOOP
      IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles rl WHERE rl.rolname = v_role)
         AND pg_catalog.pg_has_role(current_user, v_role, 'MEMBER WITH ADMIN OPTION')
         AND NOT (pg_catalog.pg_has_role(current_user, v_role, 'USAGE') AND pg_catalog.pg_has_role(current_user, v_role, 'SET')) THEN
        EXECUTE pg_catalog.format('GRANT %I TO %I WITH INHERIT TRUE, SET TRUE', v_role, current_user);
      END IF;
    END LOOP;
  END IF;

  FOR r IN
    SELECT p.oid
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname LIKE 'ludy\_%'
      AND p.prokind IN ('f', 'p')
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_depend d
        WHERE d.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass AND d.objid = p.oid AND d.deptype = 'e'
      )
    ORDER BY p.oid
  LOOP
    v_def := pg_catalog.pg_get_functiondef(r.oid);
    v_new_def := pg_catalog.regexp_replace(
      v_def,
      '\ycrove_(finance|hr|crm|social|ads|notes|projects|meetings|sign)\y',
      'ludy_\1',
      'g'
    );
    IF v_new_def IS DISTINCT FROM v_def THEN
      EXECUTE v_new_def;
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Rewrite parent trigger literal arguments referencing renamed module schemas
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r record;
  v_new_def text;
  n int;
BEGIN
  FOR r IN
    SELECT n.nspname AS schema_name,
           cl.relname AS table_name,
           tg.tgname,
           tg.tgenabled,
           pg_catalog.pg_get_triggerdef(tg.oid) AS def
    FROM pg_catalog.pg_trigger tg
    JOIN pg_catalog.pg_class cl ON cl.oid = tg.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = cl.relnamespace
    WHERE NOT tg.tgisinternal
      AND tg.tgparentid = 0
      AND n.nspname LIKE 'ludy\_%'
      AND pg_catalog.pg_get_triggerdef(tg.oid) ~ '\ycrove_(finance|hr|crm|social|ads|notes|projects|meetings|sign)\y'
    ORDER BY 1, 2, 3
  LOOP
    v_new_def := pg_catalog.regexp_replace(
      r.def,
      '\ycrove_(finance|hr|crm|social|ads|notes|projects|meetings|sign)\y',
      'ludy_\1',
      'g'
    );
    IF v_new_def IS DISTINCT FROM r.def THEN
      n := 0;
      LOOP
        BEGIN
          PERFORM pg_catalog.set_config('lock_timeout', '2s', true);
          EXECUTE pg_catalog.format('DROP TRIGGER %I ON %I.%I', r.tgname, r.schema_name, r.table_name);
          EXECUTE v_new_def;
          IF r.tgenabled = 'A' THEN
            EXECUTE pg_catalog.format('ALTER TABLE %I.%I ENABLE ALWAYS TRIGGER %I', r.schema_name, r.table_name, r.tgname);
          ELSIF r.tgenabled = 'R' THEN
            EXECUTE pg_catalog.format('ALTER TABLE %I.%I ENABLE REPLICA TRIGGER %I', r.schema_name, r.table_name, r.tgname);
          ELSIF r.tgenabled = 'D' THEN
            EXECUTE pg_catalog.format('ALTER TABLE %I.%I DISABLE TRIGGER %I', r.schema_name, r.table_name, r.tgname);
          END IF;
          EXIT;
        EXCEPTION WHEN lock_not_available THEN
          n := n + 1;
          IF n >= 15 THEN
            RAISE;
          END IF;
          PERFORM pg_catalog.pg_sleep(1 + pg_catalog.random());
        END;
      END LOOP;
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Update module table references stored in ludy_kernel registries
-- ---------------------------------------------------------------------------
UPDATE ludy_kernel.member_vy_table
   SET table_name = pg_catalog.regexp_replace(table_name, '^crove_(finance|hr|crm|social|ads|notes|projects|meetings|sign)\.', 'ludy_\1.')
 WHERE table_name ~ '^crove_(finance|hr|crm|social|ads|notes|projects|meetings|sign)\.';

UPDATE ludy_kernel.mcp_member_table
   SET table_name = pg_catalog.regexp_replace(table_name, '^crove_(finance|hr|crm|social|ads|notes|projects|meetings|sign)\.', 'ludy_\1.')
 WHERE table_name ~ '^crove_(finance|hr|crm|social|ads|notes|projects|meetings|sign)\.';
