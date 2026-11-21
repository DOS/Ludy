-- Conformance smoke (plan §5.4 "Tenant conventions", §10 G3, issue #1627): catalog meta-tests over every crove_*
-- schema after every migration. The full rule set, with its reasoned exceptions and its broken fixtures, is
-- packages/db/test/invariant/conformance.db.test.ts (#1200); the hardening guard in packages/db/src/migrate.ts already
-- refuses an unpinned function at deploy. These are the rules that hold with no exception today, in pgTAP. A gate file:
-- `_*.test.sql` is a protected path.
SELECT plan(6);

SELECT is((
  SELECT pg_catalog.count(*)
  FROM pg_catalog.unnest(
    CASE
      WHEN pg_catalog.to_regnamespace('ludy_kernel') IS NOT NULL
        THEN ARRAY['ludy_app', 'ludy_worker', 'ludy_tenant', 'ludy_definer_tenant', 'ludy_auth_reader']
      ELSE ARRAY['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant', 'crove_auth_reader']
    END
  ) AS expected(name)
  JOIN pg_catalog.pg_roles r ON r.rolname = expected.name
  WHERE NOT r.rolsuper AND NOT r.rolbypassrls
), 5::bigint, 'the five runtime roles exist, none a superuser or with BYPASSRLS');

SELECT is_empty($$
  SELECT pg_catalog.format('%I.%I', n.nspname, c.relname)
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p') AND (n.nspname LIKE 'crove\_%' OR n.nspname LIKE 'ludy\_%') AND NOT c.relrowsecurity
    AND EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
                WHERE a.attrelid = c.oid AND a.attname = 'org_id' AND a.attnum > 0 AND NOT a.attisdropped)$$,
  'every table with org_id has row-level security on');

SELECT is_empty($$
  SELECT pg_catalog.format('%I.%I owned by %s', n.nspname, c.relname, pg_catalog.pg_get_userbyid(c.relowner))
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_catalog.pg_roles r ON r.rolname IN (
    'crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant', 'crove_auth_reader',
    'ludy_app', 'ludy_worker', 'ludy_tenant', 'ludy_definer_tenant', 'ludy_auth_reader'
  )
  WHERE c.relkind IN ('r', 'p') AND (n.nspname LIKE 'crove\_%' OR n.nspname LIKE 'ludy\_%')
    AND pg_catalog.pg_has_role(r.oid, c.relowner, 'MEMBER')
    AND EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
                WHERE a.attrelid = c.oid AND a.attname = 'org_id' AND a.attnum > 0 AND NOT a.attisdropped)$$,
  'no runtime role owns, or acts as the owner of, a table with org_id');

SELECT is_empty($$
  SELECT pg_catalog.format('%I.%I', n.nspname, c.relname)
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition AND (n.nspname LIKE 'crove\_%' OR n.nspname LIKE 'ludy\_%')
    AND EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
                WHERE a.attrelid = c.oid AND a.attname = 'org_id' AND a.attnum > 0 AND NOT a.attisdropped)
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint p
                    WHERE p.conrelid = c.oid AND p.contype = 'p' AND p.conkey[1] = (
                      SELECT a.attnum FROM pg_catalog.pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'org_id'))
    AND pg_catalog.format('%I.%I', n.nspname, c.relname) NOT IN ('crove_kernel.outbox_pending', 'ludy_kernel.outbox_pending')$$,
  'the primary key of every table with org_id leads with org_id, but the global outbox hand-off queue');

SELECT is_empty($$
  SELECT pg_catalog.format('%I.%I.%I', n.nspname, c.relname, a.attname)
  FROM pg_catalog.pg_attribute a
  JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition AND (n.nspname LIKE 'crove\_%' OR n.nspname LIKE 'ludy\_%')
    AND n.nspname NOT IN ('crove_jobs', 'ludy_jobs')
    AND a.attnum > 0 AND NOT a.attisdropped
    AND a.atttypid IN ('pg_catalog.timestamp'::pg_catalog.regtype, 'pg_catalog._timestamp'::pg_catalog.regtype)$$,
  'no Crove column is timestamp without time zone (pg-boss''s crove_jobs is its own)');

SELECT is_empty($$
  SELECT p.oid::pg_catalog.regprocedure::text
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE (n.nspname LIKE 'crove\_%' OR n.nspname LIKE 'ludy\_%') AND p.prokind IN ('f', 'p')
    AND (n.nspname NOT IN ('crove_jobs', 'ludy_jobs') OR p.prosecdef)
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                    WHERE d.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass AND d.objid = p.oid AND d.deptype = 'e')
    AND p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::text[]$$,
  'every Crove function pins search_path = pg_catalog, pg_temp and sets nothing else');

SELECT * FROM finish();
