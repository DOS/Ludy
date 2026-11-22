-- SPDX-License-Identifier: AGPL-3.0-only
-- Rebrand internal core PostgreSQL schemas (`ludy_kernel`, `ludy_meta`, `ludy_jobs`), cluster roles (`ludy_*`
-- with one-way `crove_*` transition aliases), runtime GUCs (`ludy.*` with dual read of `crove.*` during rollout),
-- advisory lock namespace, event triggers, and LISTEN/NOTIFY channels per ADR-0054 (#3970, parent #1682).
-- Idempotent and non-superuser-safe; applied migrations stay untouched.
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. Ludy roles and one-way transition aliasing (`crove_<r>` -> `ludy_<r>`)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_role text;
  v_legacy text;
  v_is_super boolean;
  v_shared boolean := false;
  v_public_temp boolean := false;
  v_deploy_tbl regclass;
  v_db text := pg_catalog.current_database();
BEGIN
  SELECT COALESCE(r.rolsuper, false) INTO v_is_super FROM pg_catalog.pg_roles r WHERE r.rolname = current_user;
  v_is_super := COALESCE(v_is_super, false);

  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'ludy_tenant') THEN
    CREATE ROLE ludy_tenant NOLOGIN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'ludy_app') THEN
    CREATE ROLE ludy_app LOGIN INHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
  IF v_is_super OR pg_catalog.pg_has_role(current_user, 'ludy_app', 'MEMBER WITH ADMIN OPTION') THEN
    ALTER ROLE ludy_app SET search_path = pg_catalog, pg_temp;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'ludy_worker') THEN
    CREATE ROLE ludy_worker LOGIN INHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
  IF v_is_super OR pg_catalog.pg_has_role(current_user, 'ludy_worker', 'MEMBER WITH ADMIN OPTION') THEN
    ALTER ROLE ludy_worker SET search_path = pg_catalog, pg_temp;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'ludy_prober') THEN
    CREATE ROLE ludy_prober LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'ludy_prober'
      AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication OR rolinherit OR NOT rolcanlogin)
  ) THEN
    RAISE EXCEPTION 'role ludy_prober must be LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members m
    JOIN pg_catalog.pg_roles r ON r.oid = m.member
    WHERE r.rolname = 'ludy_prober'
  ) THEN
    RAISE EXCEPTION 'role ludy_prober must hold no role memberships';
  END IF;
  IF v_is_super OR pg_catalog.pg_has_role(current_user, 'ludy_prober', 'MEMBER WITH ADMIN OPTION') THEN
    ALTER ROLE ludy_prober SET search_path = pg_catalog, pg_temp;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'ludy_reporter') THEN
    CREATE ROLE ludy_reporter LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'ludy_reporter'
      AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication OR rolinherit OR NOT rolcanlogin)
  ) THEN
    RAISE EXCEPTION 'role ludy_reporter must be LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members m
    JOIN pg_catalog.pg_roles r ON r.oid = m.member
    WHERE r.rolname = 'ludy_reporter'
  ) THEN
    RAISE EXCEPTION 'role ludy_reporter must hold no role memberships';
  END IF;
  IF v_is_super OR pg_catalog.pg_has_role(current_user, 'ludy_reporter', 'MEMBER WITH ADMIN OPTION') THEN
    ALTER ROLE ludy_reporter SET search_path = pg_catalog, pg_temp;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'ludy_auth_reader') THEN
    CREATE ROLE ludy_auth_reader NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'ludy_auth_reader'
      AND (rolsuper OR rolbypassrls OR rolcanlogin OR rolcreaterole OR rolcreatedb OR rolinherit)
  ) THEN
    RAISE EXCEPTION 'role ludy_auth_reader must be NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'ludy_definer_tenant') THEN
    CREATE ROLE ludy_definer_tenant NOLOGIN INHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'ludy_definer_tenant'
      AND (rolsuper OR rolbypassrls OR rolcanlogin OR rolcreaterole OR rolcreatedb OR NOT rolinherit)
  ) THEN
    RAISE EXCEPTION 'role ludy_definer_tenant must be NOLOGIN INHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'ludy_definer_einvoice') THEN
    CREATE ROLE ludy_definer_einvoice NOLOGIN INHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'ludy_definer_einvoice'
      AND (rolsuper OR rolbypassrls OR rolcanlogin OR rolcreaterole OR rolcreatedb OR NOT rolinherit)
  ) THEN
    RAISE EXCEPTION 'role ludy_definer_einvoice must be NOLOGIN INHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE';
  END IF;

  FOREACH v_role IN ARRAY ARRAY['ludy_app', 'ludy_worker', 'ludy_definer_tenant', 'ludy_definer_einvoice'] LOOP
    IF NOT pg_catalog.pg_has_role(v_role, 'ludy_tenant', 'MEMBER') THEN
      EXECUTE pg_catalog.format('GRANT ludy_tenant TO %I', v_role);
    END IF;
  END LOOP;

  IF NOT v_is_super THEN
    FOR v_role IN
      SELECT unnest(ARRAY[
        'ludy_definer_tenant', 'ludy_definer_einvoice', 'ludy_auth_reader',
        'crove_definer_tenant', 'crove_definer_einvoice', 'crove_auth_reader'
      ])
    LOOP
      IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = v_role)
         AND pg_catalog.pg_has_role(current_user, v_role, 'MEMBER WITH ADMIN OPTION')
         AND NOT (pg_catalog.pg_has_role(current_user, v_role, 'USAGE') AND pg_catalog.pg_has_role(current_user, v_role, 'SET')) THEN
        EXECUTE pg_catalog.format('GRANT %I TO %I WITH INHERIT TRUE, SET TRUE', v_role, current_user);
      END IF;
    END LOOP;
  END IF;

  -- One-way aliasing: legacy crove_<r> roles inherit their ludy_<r> twins while rolling out (#3970 -> #3972).
  -- Never grant crove_<r> to ludy_<r>. Exclude prober and reporter: both stay membership-free (cluster-wide
  -- drift guards in 20261015234500 and 20261019020000 require zero memberships on crove_prober / crove_reporter,
  -- and Section 3 mirrors their USAGE/EXECUTE grants directly onto ludy_prober / ludy_reporter).
  FOREACH v_role IN ARRAY ARRAY['tenant', 'app', 'worker', 'auth_reader', 'definer_tenant', 'definer_einvoice'] LOOP
    v_legacy := 'crove_' || v_role;
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = v_legacy)
       AND NOT pg_catalog.pg_has_role(v_legacy, 'ludy_' || v_role, 'MEMBER') THEN
      EXECUTE pg_catalog.format('GRANT %I TO %I WITH INHERIT TRUE', 'ludy_' || v_role, v_legacy);
    END IF;
  END LOOP;

  -- Keep every crove_* and ludy_* runtime role free of TEMPORARY in owned databases (skip cleanly in
  -- shared-database mode, when PUBLIC still holds TEMPORARY, or when not DB owner). Required on reused
  -- clusters (e.g. multi-DB CI shards) where immutable 20261015120000 granted TEMPORARY to pre-existing ludy_* roles.
  v_deploy_tbl := COALESCE(
    pg_catalog.to_regclass('ludy_meta.deployment'),
    pg_catalog.to_regclass('crove_meta.deployment')
  );
  IF v_deploy_tbl IS NOT NULL THEN
    EXECUTE pg_catalog.format(
      'SELECT COALESCE(bool_or(d.value = ''true''), false) FROM %s d WHERE d.key = ''shared_database''',
      v_deploy_tbl
    ) INTO v_shared;
  END IF;
  SELECT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_database d,
         LATERAL pg_catalog.aclexplode(COALESCE(d.datacl, pg_catalog.acldefault('d', d.datdba))) a
    WHERE d.datname = v_db
      AND a.grantee = 0
      AND a.privilege_type = 'TEMPORARY'
  ) INTO v_public_temp;

  IF NOT v_shared
     AND NOT v_public_temp
     AND (
       v_is_super
       OR pg_catalog.pg_has_role(
            current_user,
            (SELECT d.datdba FROM pg_catalog.pg_database d WHERE d.datname = v_db),
            'USAGE'
          )
     ) THEN
    FOR v_role IN
      SELECT r.rolname
      FROM pg_catalog.pg_roles r
      WHERE r.rolname = ANY (ARRAY[
        'ludy_tenant', 'ludy_app', 'ludy_worker', 'ludy_prober', 'ludy_reporter', 'ludy_auth_reader',
        'ludy_definer_tenant', 'ludy_definer_einvoice', 'ludy_definer_system',
        'crove_tenant', 'crove_app', 'crove_worker', 'crove_prober', 'crove_reporter', 'crove_auth_reader',
        'crove_definer_tenant', 'crove_definer_einvoice', 'crove_definer_system'
      ])
        AND r.rolname <> current_user
        AND NOT r.rolsuper
        AND pg_catalog.has_database_privilege(r.oid, v_db, 'TEMPORARY')
    LOOP
      EXECUTE pg_catalog.format('REVOKE TEMPORARY ON DATABASE %I FROM %I', v_db, v_role);
    END LOOP;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1b & 2. Transition-safe ddl_watch() + agent_write_guard() across core schema
--         renames (#3970 B2) and atomic rename (`crove_kernel`, `crove_meta`,
--         `crove_jobs` -> `ludy_*`)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_awg_orig text;
  v_awg_tmp text;
BEGIN
  IF pg_catalog.to_regprocedure('crove_kernel.ddl_watch()') IS NOT NULL THEN
    EXECUTE $q$
      CREATE OR REPLACE FUNCTION crove_kernel.ddl_watch() RETURNS event_trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
      DECLARE
        v_start timestamptz;
        v_role text := NULLIF(pg_catalog.current_setting('role'), 'none');
        v_auth_admin boolean;
        v_shared boolean := false;
        v_ludy_role boolean;
        v_concerns boolean := true;
        v_in_pipeline boolean := false;
        v_meta_deploy regclass := COALESCE(
          pg_catalog.to_regclass('ludy_meta.deployment'),
          pg_catalog.to_regclass('crove_meta.deployment')
        );
        v_meta_pipeline regclass := COALESCE(
          pg_catalog.to_regclass('ludy_meta.pipeline_session'),
          pg_catalog.to_regclass('crove_meta.pipeline_session')
        );
        v_ddl_event regclass := COALESCE(
          pg_catalog.to_regclass('ludy_kernel.ddl_event'),
          pg_catalog.to_regclass('crove_kernel.ddl_event')
        );
      BEGIN
        IF v_meta_deploy IS NOT NULL THEN
          EXECUTE pg_catalog.format(
            'SELECT COALESCE(bool_or(d.value = ''true''), false) FROM %s d WHERE d.key = ''shared_database''',
            v_meta_deploy
          ) INTO v_shared;
        END IF;

        v_ludy_role := SESSION_USER::text = ANY (ARRAY[
                        'ludy_tenant', 'ludy_app', 'ludy_worker', 'ludy_prober', 'ludy_reporter', 'ludy_auth_reader', 'ludy_definer_tenant', 'ludy_definer_system', 'ludy_definer_einvoice',
                        'crove_tenant', 'crove_app', 'crove_worker', 'crove_prober', 'crove_reporter', 'crove_auth_reader', 'crove_definer_tenant', 'crove_definer_system', 'crove_definer_einvoice'
                      ])
                    OR COALESCE(v_role, '') = ANY (ARRAY[
                        'ludy_tenant', 'ludy_app', 'ludy_worker', 'ludy_prober', 'ludy_reporter', 'ludy_auth_reader', 'ludy_definer_tenant', 'ludy_definer_system', 'ludy_definer_einvoice',
                        'crove_tenant', 'crove_app', 'crove_worker', 'crove_prober', 'crove_reporter', 'crove_auth_reader', 'crove_definer_tenant', 'crove_definer_system', 'crove_definer_einvoice'
                      ]);

        SELECT a.backend_start INTO v_start FROM pg_catalog.pg_stat_activity a WHERE a.pid = pg_catalog.pg_backend_pid();
        IF v_meta_pipeline IS NOT NULL THEN
          EXECUTE pg_catalog.format(
            'SELECT EXISTS (SELECT 1 FROM %s m WHERE m.pid = $1 AND m.backend_start = $2)',
            v_meta_pipeline
          ) INTO v_in_pipeline USING pg_catalog.pg_backend_pid(), v_start;
          IF v_in_pipeline THEN
            RETURN;
          END IF;
        END IF;

        v_auth_admin := v_role IS NULL AND EXISTS (
          SELECT 1 FROM pg_catalog.pg_namespace n JOIN pg_catalog.pg_roles r ON r.oid = n.nspowner
          WHERE n.nspname = 'auth' AND r.rolname = SESSION_USER AND NOT r.rolsuper
        );

        IF v_shared AND NOT v_ludy_role THEN
          BEGIN
            IF TG_EVENT = 'sql_drop' THEN
              SELECT EXISTS (
                SELECT 1 FROM pg_catalog.pg_event_trigger_dropped_objects() d
                WHERE d.original AND NOT d.is_temporary
                  AND (d.schema_name LIKE 'ludy\_%' OR d.schema_name LIKE 'crove\_%'
                       OR (d.object_type = 'schema' AND (d.object_identity LIKE 'ludy\_%' OR d.object_identity LIKE 'crove\_%'))
                       OR d.object_identity LIKE 'ludy\_%.%' OR d.object_identity LIKE 'crove\_%.%'
                       OR d.object_identity LIKE '% on ludy\_%.%' OR d.object_identity LIKE '% on crove\_%.%')
              ) INTO v_concerns;
            ELSE
              SELECT EXISTS (
                SELECT 1 FROM pg_catalog.pg_event_trigger_ddl_commands() c
                WHERE c.schema_name LIKE 'ludy\_%' OR c.schema_name LIKE 'crove\_%'
                   OR (c.object_type = 'schema' AND (c.object_identity LIKE 'ludy\_%' OR c.object_identity LIKE 'crove\_%'))
                   OR c.object_identity LIKE 'ludy\_%.%' OR c.object_identity LIKE 'crove\_%.%'
                   OR c.object_identity LIKE '% on ludy\_%.%' OR c.object_identity LIKE '% on crove\_%.%'
                   OR c.object_identity LIKE '% in schema ludy\_%' OR c.object_identity LIKE '% in schema crove\_%'
              ) INTO v_concerns;
            END IF;
          EXCEPTION WHEN OTHERS THEN
            RAISE WARNING 'crove_kernel.ddl_watch could not tell whether a statement concerns Ludy (%): %', SQLSTATE, SQLERRM;
            v_concerns := false;
          END;
          IF NOT v_concerns THEN
            RETURN;
          END IF;
        END IF;

        IF v_ddl_event IS NOT NULL THEN
          IF TG_EVENT = 'sql_drop' THEN
            EXECUTE pg_catalog.format('INSERT INTO %s ', v_ddl_event) ||
              '(session_role, set_role, command_tag, object_type, schema_name, object_identity, ' ||
              ' backend_pid, backend_start, client_addr) ' ||
              'SELECT SESSION_USER, $1, $2, d.object_type, d.schema_name, pg_catalog.left(d.object_identity, 500), ' ||
              '       pg_catalog.pg_backend_pid(), $3, pg_catalog.inet_client_addr() ' ||
              'FROM pg_catalog.pg_event_trigger_dropped_objects() d ' ||
              'WHERE d.original AND NOT d.is_temporary AND NOT ($4 AND d.schema_name IS NOT DISTINCT FROM ''auth'') ' ||
              '  AND (NOT $5 OR $6 ' ||
              '       OR d.schema_name LIKE ''ludy\_%'' OR d.schema_name LIKE ''crove\_%'' ' ||
              '       OR (d.object_type = ''schema'' AND (d.object_identity LIKE ''ludy\_%'' OR d.object_identity LIKE ''crove\_%'')) ' ||
              '       OR d.object_identity LIKE ''ludy\_%.%'' OR d.object_identity LIKE ''crove\_%.%'' ' ||
              '       OR d.object_identity LIKE ''% on ludy\_%.%'' OR d.object_identity LIKE ''% on crove\_%.%'')'
              USING v_role, TG_TAG, v_start, v_auth_admin, v_shared, v_ludy_role;
          ELSE
            EXECUTE pg_catalog.format('INSERT INTO %s ', v_ddl_event) ||
              '(session_role, set_role, command_tag, object_type, schema_name, object_identity, ' ||
              ' backend_pid, backend_start, client_addr) ' ||
              'SELECT SESSION_USER, $1, c.command_tag, c.object_type, c.schema_name, pg_catalog.left(c.object_identity, 500), ' ||
              '       pg_catalog.pg_backend_pid(), $2, pg_catalog.inet_client_addr() ' ||
              'FROM pg_catalog.pg_event_trigger_ddl_commands() c ' ||
              'WHERE c.schema_name IS DISTINCT FROM ''pg_temp'' AND NOT c.in_extension ' ||
              '  AND NOT ($3 AND c.schema_name IS NOT DISTINCT FROM ''auth'') ' ||
              '  AND (NOT $4 OR $5 ' ||
              '       OR c.schema_name LIKE ''ludy\_%'' OR c.schema_name LIKE ''crove\_%'' ' ||
              '       OR (c.object_type = ''schema'' AND (c.object_identity LIKE ''ludy\_%'' OR c.object_identity LIKE ''crove\_%'')) ' ||
              '       OR c.object_identity LIKE ''ludy\_%.%'' OR c.object_identity LIKE ''crove\_%.%'' ' ||
              '       OR c.object_identity LIKE ''% on ludy\_%.%'' OR c.object_identity LIKE ''% on crove\_%.%'' ' ||
              '       OR c.object_identity LIKE ''% in schema ludy\_%'' OR c.object_identity LIKE ''% in schema crove\_%'')'
              USING v_role, v_start, v_auth_admin, v_shared, v_ludy_role;
          END IF;
        END IF;
      END $fn$
    $q$;
    EXECUTE 'REVOKE ALL ON FUNCTION crove_kernel.ddl_watch() FROM PUBLIC';
  END IF;

  IF pg_catalog.to_regprocedure('crove_kernel.agent_write_guard()') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM pg_catalog.pg_event_trigger
       WHERE evtname IN ('crove_ddl_watch', 'crove_ddl_watch_drop')
     ) THEN
    v_awg_orig := pg_catalog.pg_get_functiondef('crove_kernel.agent_write_guard()'::pg_catalog.regprocedure);
    v_awg_tmp := pg_catalog.regexp_replace(
      v_awg_orig,
      'v_ctx\s+jsonb\s*:=\s*crove_kernel\.ctx_verified\(\)\s*;',
      'v_ctx jsonb;'
    );
    v_awg_tmp := pg_catalog.regexp_replace(
      v_awg_tmp,
      '\mBEGIN\M',
      E'BEGIN\n  EXECUTE pg_catalog.format(''SELECT %s'', COALESCE(pg_catalog.to_regprocedure(''ludy_kernel.ctx_verified()''), pg_catalog.to_regprocedure(''crove_kernel.ctx_verified()''))) INTO v_ctx;'
    );
    IF v_awg_tmp IS DISTINCT FROM v_awg_orig THEN
      EXECUTE v_awg_tmp;
    END IF;
  END IF;

  IF pg_catalog.to_regnamespace('crove_kernel') IS NOT NULL AND pg_catalog.to_regnamespace('ludy_kernel') IS NULL THEN
-- ludy:contract adr=0054
    ALTER SCHEMA crove_kernel RENAME TO ludy_kernel;
  END IF;
  IF pg_catalog.to_regnamespace('crove_meta') IS NOT NULL AND pg_catalog.to_regnamespace('ludy_meta') IS NULL THEN
-- ludy:contract adr=0054
-- migration-lint: cross-module ADR-0054 core schema cutover
    ALTER SCHEMA crove_meta RENAME TO ludy_meta;
  END IF;
  IF pg_catalog.to_regnamespace('crove_jobs') IS NOT NULL AND pg_catalog.to_regnamespace('ludy_jobs') IS NULL THEN
-- ludy:contract adr=0054
-- migration-lint: cross-module ADR-0054 core schema cutover
    ALTER SCHEMA crove_jobs RENAME TO ludy_jobs;
  END IF;

  IF v_awg_orig IS NOT NULL THEN
    EXECUTE pg_catalog.regexp_replace(v_awg_orig, '\ycrove_(kernel|meta|jobs)\y', 'ludy_\1', 'g');
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Transfer explicit definer routine owners (`crove_*` -> `ludy_*`) BEFORE
--    ACL transfer so proowner updates cleanly, and keep temporary CREATE grants
--    scoped strictly to this block.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT n.nspname AS schema_name,
           CASE pg_catalog.pg_get_userbyid(p.proowner)
             WHEN 'crove_definer_tenant' THEN 'ludy_definer_tenant'
             WHEN 'crove_definer_einvoice' THEN 'ludy_definer_einvoice'
             WHEN 'crove_auth_reader' THEN 'ludy_auth_reader'
           END AS target_owner
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE (n.nspname LIKE 'ludy\_%' OR n.nspname LIKE 'crove\_%')
      AND pg_catalog.pg_get_userbyid(p.proowner) IN ('crove_definer_tenant', 'crove_definer_einvoice', 'crove_auth_reader')
  LOOP
    EXECUTE pg_catalog.format('GRANT CREATE ON SCHEMA %I TO %I', r.schema_name, r.target_owner);
  END LOOP;

  FOR r IN
    SELECT p.oid::pg_catalog.regprocedure::text AS fn_sig,
           pg_catalog.pg_get_userbyid(p.proowner) AS old_owner
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE (n.nspname LIKE 'ludy\_%' OR n.nspname LIKE 'crove\_%')
      AND pg_catalog.pg_get_userbyid(p.proowner) IN ('crove_definer_tenant', 'crove_definer_einvoice', 'crove_auth_reader')
    ORDER BY 1
  LOOP
    IF r.old_owner = 'crove_definer_tenant' THEN
      EXECUTE pg_catalog.format('ALTER FUNCTION %s OWNER TO ludy_definer_tenant', r.fn_sig);
    ELSIF r.old_owner = 'crove_definer_einvoice' THEN
      EXECUTE pg_catalog.format('ALTER FUNCTION %s OWNER TO ludy_definer_einvoice', r.fn_sig);
    ELSIF r.old_owner = 'crove_auth_reader' THEN
      EXECUTE pg_catalog.format('ALTER FUNCTION %s OWNER TO ludy_auth_reader', r.fn_sig);
    END IF;
  END LOOP;

  FOR r IN
    SELECT n.nspname AS schema_name
    FROM pg_catalog.pg_namespace n
    WHERE n.nspname LIKE 'ludy\_%' OR n.nspname LIKE 'crove\_%'
  LOOP
    EXECUTE pg_catalog.format('REVOKE CREATE ON SCHEMA %I FROM ludy_definer_tenant, ludy_definer_einvoice, ludy_auth_reader', r.schema_name);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Transfer ACLs from `crove_<r>` to `ludy_<r>` (revoking redundant direct
--    grants on inheriting crove_<r> roles while preserving NOINHERIT
--    crove_prober / crove_reporter) and update RLS `TO` clauses
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r record;
  v_target text;
  v_suffix text;
  v_roles text[];
  v_pol_role oid;
  v_pol_name text;
  n int;
  v_role_map jsonb := jsonb_build_object(
    'crove_tenant', 'ludy_tenant',
    'crove_app', 'ludy_app',
    'crove_worker', 'ludy_worker',
    'crove_prober', 'ludy_prober',
    'crove_reporter', 'ludy_reporter',
    'crove_auth_reader', 'ludy_auth_reader',
    'crove_definer_tenant', 'ludy_definer_tenant',
    'crove_definer_einvoice', 'ludy_definer_einvoice'
  );
BEGIN
  -- 4a. Schema ACLs
  FOR r IN
    SELECT n.nspname AS schema_name, gr.rolname AS grantee, a.privilege_type, a.is_grantable
    FROM pg_catalog.pg_namespace n
    CROSS JOIN LATERAL pg_catalog.aclexplode(n.nspacl) a
    JOIN pg_catalog.pg_roles gr ON gr.oid = a.grantee
    WHERE (n.nspname LIKE 'ludy\_%' OR n.nspname LIKE 'crove\_%')
      AND v_role_map ? gr.rolname
    ORDER BY n.nspname, gr.rolname, a.privilege_type
  LOOP
    v_target := v_role_map ->> r.grantee;
    v_suffix := CASE WHEN r.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END;
    EXECUTE pg_catalog.format('GRANT %s ON SCHEMA %I TO %I%s', r.privilege_type, r.schema_name, v_target, v_suffix);
    IF r.grantee NOT IN ('crove_prober', 'crove_reporter') THEN
      EXECUTE pg_catalog.format('REVOKE %s ON SCHEMA %I FROM %I', r.privilege_type, r.schema_name, r.grantee);
    END IF;
  END LOOP;

  -- 4b. Column-level ACLs BEFORE table/view ACLs so table-level REVOKE never clears attacl before copy
  FOR r IN
    SELECT n.nspname AS schema_name, c.relname, att.attname, gr.rolname AS grantee, a.privilege_type, a.is_grantable
    FROM pg_catalog.pg_attribute att
    JOIN pg_catalog.pg_class c ON c.oid = att.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(att.attacl) a
    JOIN pg_catalog.pg_roles gr ON gr.oid = a.grantee
    WHERE (n.nspname LIKE 'ludy\_%' OR n.nspname LIKE 'crove\_%')
      AND att.attnum > 0 AND NOT att.attisdropped
      AND v_role_map ? gr.rolname
    ORDER BY n.nspname, c.relname, att.attname, gr.rolname, a.privilege_type
  LOOP
    v_target := v_role_map ->> r.grantee;
    v_suffix := CASE WHEN r.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END;
    EXECUTE pg_catalog.format('GRANT %s (%I) ON %I.%I TO %I%s', r.privilege_type, r.attname, r.schema_name, r.relname, v_target, v_suffix);
    IF r.grantee NOT IN ('crove_prober', 'crove_reporter') THEN
      EXECUTE pg_catalog.format('REVOKE %s (%I) ON %I.%I FROM %I', r.privilege_type, r.attname, r.schema_name, r.relname, r.grantee);
    END IF;
  END LOOP;

  -- 4c. Table, view, materialized view, foreign table ACLs
  FOR r IN
    SELECT n.nspname AS schema_name, c.relname, gr.rolname AS grantee, a.privilege_type, a.is_grantable
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
    JOIN pg_catalog.pg_roles gr ON gr.oid = a.grantee
    WHERE (n.nspname LIKE 'ludy\_%' OR n.nspname LIKE 'crove\_%')
      AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND v_role_map ? gr.rolname
    ORDER BY n.nspname, c.relname, gr.rolname, a.privilege_type
  LOOP
    v_target := v_role_map ->> r.grantee;
    v_suffix := CASE WHEN r.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END;
    EXECUTE pg_catalog.format('GRANT %s ON TABLE %I.%I TO %I%s', r.privilege_type, r.schema_name, r.relname, v_target, v_suffix);
    IF r.grantee NOT IN ('crove_prober', 'crove_reporter') THEN
      EXECUTE pg_catalog.format('REVOKE %s ON TABLE %I.%I FROM %I', r.privilege_type, r.schema_name, r.relname, r.grantee);
    END IF;
  END LOOP;

  -- 4d. Sequence ACLs
  FOR r IN
    SELECT n.nspname AS schema_name, c.relname, gr.rolname AS grantee, a.privilege_type, a.is_grantable
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
    JOIN pg_catalog.pg_roles gr ON gr.oid = a.grantee
    WHERE (n.nspname LIKE 'ludy\_%' OR n.nspname LIKE 'crove\_%')
      AND c.relkind = 'S'
      AND v_role_map ? gr.rolname
    ORDER BY n.nspname, c.relname, gr.rolname, a.privilege_type
  LOOP
    v_target := v_role_map ->> r.grantee;
    v_suffix := CASE WHEN r.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END;
    EXECUTE pg_catalog.format('GRANT %s ON SEQUENCE %I.%I TO %I%s', r.privilege_type, r.schema_name, r.relname, v_target, v_suffix);
    IF r.grantee NOT IN ('crove_prober', 'crove_reporter') THEN
      EXECUTE pg_catalog.format('REVOKE %s ON SEQUENCE %I.%I FROM %I', r.privilege_type, r.schema_name, r.relname, r.grantee);
    END IF;
  END LOOP;

  -- 4e. Routine ACLs
  FOR r IN
    SELECT p.oid::pg_catalog.regprocedure::text AS fn_sig,
           CASE WHEN p.prokind = 'p' THEN 'PROCEDURE' WHEN p.prokind = 'a' THEN 'AGGREGATE' ELSE 'FUNCTION' END AS kind,
           gr.rolname AS grantee,
           a.privilege_type,
           a.is_grantable
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) a
    JOIN pg_catalog.pg_roles gr ON gr.oid = a.grantee
    WHERE (n.nspname LIKE 'ludy\_%' OR n.nspname LIKE 'crove\_%')
      AND a.grantee <> p.proowner
      AND v_role_map ? gr.rolname
    ORDER BY p.oid::pg_catalog.regprocedure::text, gr.rolname, a.privilege_type
  LOOP
    v_target := v_role_map ->> r.grantee;
    v_suffix := CASE WHEN r.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END;
    EXECUTE pg_catalog.format('GRANT %s ON %s %s TO %I%s', r.privilege_type, r.kind, r.fn_sig, v_target, v_suffix);
    IF r.grantee NOT IN ('crove_prober', 'crove_reporter') THEN
      EXECUTE pg_catalog.format('REVOKE %s ON %s %s FROM %I', r.privilege_type, r.kind, r.fn_sig, r.grantee);
    END IF;
  END LOOP;

  -- 4f. Default privileges in ludy_jobs for pg-boss runtime partitions
  IF pg_catalog.to_regnamespace('ludy_jobs') IS NOT NULL THEN
    -- migration-lint: cross-module ADR-0054 pg-boss jobs default privileges
    ALTER DEFAULT PRIVILEGES IN SCHEMA ludy_jobs GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ludy_worker;
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'crove_worker') THEN
      -- migration-lint: cross-module ADR-0054 pg-boss jobs default privileges
      ALTER DEFAULT PRIVILEGES IN SCHEMA ludy_jobs REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM crove_worker;
    END IF;
  END IF;

  -- 4g. Update RLS policies targeting legacy crove_<r> roles so ludy_<r> sessions (and inherited crove_<r> sessions) match
  FOR r IN
    SELECT p.oid, n.nspname AS schema_name, c.relname AS table_name, p.polname, p.polroles
    FROM pg_catalog.pg_policy p
    JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE (n.nspname LIKE 'ludy\_%' OR n.nspname LIKE 'crove\_%')
      AND EXISTS (
        SELECT 1 FROM pg_catalog.unnest(p.polroles) oid_el
        JOIN pg_catalog.pg_roles pr ON pr.oid = oid_el
        WHERE v_role_map ? pr.rolname
      )
    ORDER BY n.nspname, c.relname, p.polname
  LOOP
    v_roles := ARRAY[]::text[];
    FOREACH v_pol_role IN ARRAY r.polroles LOOP
      IF v_pol_role = 0 THEN
        v_roles := pg_catalog.array_append(v_roles, 'PUBLIC');
      ELSE
        SELECT pr.rolname INTO v_pol_name FROM pg_catalog.pg_roles pr WHERE pr.oid = v_pol_role;
        IF v_role_map ? v_pol_name THEN
          v_roles := pg_catalog.array_append(v_roles, pg_catalog.quote_ident(v_role_map ->> v_pol_name));
        ELSE
          v_roles := pg_catalog.array_append(v_roles, pg_catalog.quote_ident(v_pol_name));
        END IF;
      END IF;
    END LOOP;
    n := 0;
    LOOP
      BEGIN
        PERFORM pg_catalog.set_config('lock_timeout', '2s', true);
        EXECUTE pg_catalog.format(
          'ALTER POLICY %I ON %I.%I TO %s',
          r.polname,
          r.schema_name,
          r.table_name,
          pg_catalog.array_to_string(v_roles, ', ')
        );
        EXIT;
      EXCEPTION WHEN lock_not_available THEN
        n := n + 1;
        IF n >= 15 THEN
          RAISE;
        END IF;
        PERFORM pg_catalog.pg_sleep(1 + pg_catalog.random());
      END;
    END LOOP;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 5. Restate SQL routine bodies from crove_* core identifiers to ludy_*
--    (while preserving module crove_<module> schemas and Category B strings)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r record;
  v_def text;
  v_new_def text;
BEGIN
  FOR r IN
    SELECT p.oid, p.oid::pg_catalog.regprocedure::text AS fn_sig, pg_catalog.pg_get_userbyid(p.proowner) AS owner_name, n.nspname AS schema_name
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE (n.nspname LIKE 'ludy\_%' OR n.nspname LIKE 'crove\_%')
      AND p.prokind IN ('f', 'p')
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_depend d
        WHERE d.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass AND d.objid = p.oid AND d.deptype = 'e'
      )
    ORDER BY p.oid
  LOOP
    v_def := pg_catalog.pg_get_functiondef(r.oid);
    v_new_def := v_def;
    v_new_def := pg_catalog.regexp_replace(v_new_def, '\ycrove_(kernel|meta|jobs)\y', 'ludy_\1', 'g');
    v_new_def := pg_catalog.regexp_replace(
      v_new_def,
      '\ycrove_(tenant|app|worker|prober|reporter|auth_reader|definer_tenant|definer_einvoice|definer_system)\y',
      'ludy_\1',
      'g'
    );
    v_new_def := pg_catalog.regexp_replace(v_new_def, '\ycrove_(stream|outbox|ddl_watch|ddl_watch_drop)\y', 'ludy_\1', 'g');
    v_new_def := pg_catalog.regexp_replace(
      v_new_def,
      '\ycrove\.(ctx|ctx_seal|org_id|user_id|org_purge|org_purge_hold|outbox_purge|inbound_rotate_limit_per_day|inbound_rotate_limit_total|org_create_limit_per_day|org_create_limit_total|prober_modules|tainted_line_keys)(?![[:alnum:]_.])',
      'ludy.\1',
      'g'
    );
    v_new_def := pg_catalog.replace(v_new_def, '1129467734', '1280656473');
    v_new_def := pg_catalog.replace(
      v_new_def,
      'IF NOT (pg_catalog.pg_has_role(SESSION_USER, ''ludy_reporter'', ''MEMBER'') OR pg_catalog.pg_has_role(SESSION_USER, ''ludy_reporter'', ''MEMBER'')) THEN',
      'IF NOT (pg_catalog.pg_has_role(SESSION_USER, ''ludy_reporter'', ''MEMBER'') OR pg_catalog.pg_has_role(SESSION_USER, ''crove_reporter'', ''MEMBER'')) THEN'
    );
    v_new_def := pg_catalog.replace(
      v_new_def,
      'IF NOT pg_catalog.pg_has_role(SESSION_USER, ''ludy_reporter'', ''MEMBER'') THEN',
      'IF NOT (pg_catalog.pg_has_role(SESSION_USER, ''ludy_reporter'', ''MEMBER'') OR pg_catalog.pg_has_role(SESSION_USER, ''crove_reporter'', ''MEMBER'')) THEN'
    );
    v_new_def := pg_catalog.replace(
      v_new_def,
      'IF (current_user = session_user OR current_user IN (''ludy_tenant'', ''ludy_tenant''))',
      'IF (current_user = session_user OR current_user IN (''ludy_tenant'', ''crove_tenant''))'
    );
    v_new_def := pg_catalog.replace(
      v_new_def,
      'IF (current_user = session_user OR current_user = ''ludy_tenant'')',
      'IF (current_user = session_user OR current_user IN (''ludy_tenant'', ''crove_tenant''))'
    );
    IF v_new_def IS DISTINCT FROM v_def THEN
      EXECUTE v_new_def;
    END IF;
  END LOOP;
END $$;

-- Explicit core security overrides:
-- 5a. ludy_kernel.ddl_watch(): accept both ludy_* and legacy crove_* roles and track both ludy_* and
--     remaining crove_<module>.* objects until #3971 / #3972.
CREATE OR REPLACE FUNCTION ludy_kernel.ddl_watch() RETURNS event_trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_start timestamptz;
  v_role text := NULLIF(pg_catalog.current_setting('role'), 'none');
  v_auth_admin boolean;
  v_shared boolean := false;
  v_ludy_role boolean;
  v_concerns boolean := true;
BEGIN
  IF pg_catalog.to_regclass('ludy_meta.deployment') IS NOT NULL THEN
    SELECT COALESCE(bool_or(d.value = 'true'), false) INTO v_shared FROM ludy_meta.deployment d WHERE d.key = 'shared_database';
  END IF;
  v_ludy_role := SESSION_USER::text = ANY (ARRAY[
                  'ludy_tenant', 'ludy_app', 'ludy_worker', 'ludy_prober', 'ludy_reporter', 'ludy_auth_reader', 'ludy_definer_tenant', 'ludy_definer_system', 'ludy_definer_einvoice',
                  'crove_tenant', 'crove_app', 'crove_worker', 'crove_prober', 'crove_reporter', 'crove_auth_reader', 'crove_definer_tenant', 'crove_definer_system', 'crove_definer_einvoice'
                ])
              OR COALESCE(v_role, '') = ANY (ARRAY[
                  'ludy_tenant', 'ludy_app', 'ludy_worker', 'ludy_prober', 'ludy_reporter', 'ludy_auth_reader', 'ludy_definer_tenant', 'ludy_definer_system', 'ludy_definer_einvoice',
                  'crove_tenant', 'crove_app', 'crove_worker', 'crove_prober', 'crove_reporter', 'crove_auth_reader', 'crove_definer_tenant', 'crove_definer_system', 'crove_definer_einvoice'
                ]);

  SELECT a.backend_start INTO v_start FROM pg_catalog.pg_stat_activity a WHERE a.pid = pg_catalog.pg_backend_pid();
  IF EXISTS (
    SELECT 1 FROM ludy_meta.pipeline_session m
    WHERE m.pid = pg_catalog.pg_backend_pid() AND m.backend_start = v_start
  ) THEN
    RETURN;
  END IF;
  v_auth_admin := v_role IS NULL AND EXISTS (
    SELECT 1 FROM pg_catalog.pg_namespace n JOIN pg_catalog.pg_roles r ON r.oid = n.nspowner
    WHERE n.nspname = 'auth' AND r.rolname = SESSION_USER AND NOT r.rolsuper
  );

  IF v_shared AND NOT v_ludy_role THEN
    BEGIN
      IF TG_EVENT = 'sql_drop' THEN
        SELECT EXISTS (
          SELECT 1 FROM pg_catalog.pg_event_trigger_dropped_objects() d
          WHERE d.original AND NOT d.is_temporary
            AND (d.schema_name LIKE 'ludy\_%' OR d.schema_name LIKE 'crove\_%'
                 OR (d.object_type = 'schema' AND (d.object_identity LIKE 'ludy\_%' OR d.object_identity LIKE 'crove\_%'))
                 OR d.object_identity LIKE 'ludy\_%.%' OR d.object_identity LIKE 'crove\_%.%'
                 OR d.object_identity LIKE '% on ludy\_%.%' OR d.object_identity LIKE '% on crove\_%.%')
        ) INTO v_concerns;
      ELSE
        SELECT EXISTS (
          SELECT 1 FROM pg_catalog.pg_event_trigger_ddl_commands() c
          WHERE c.schema_name LIKE 'ludy\_%' OR c.schema_name LIKE 'crove\_%'
             OR (c.object_type = 'schema' AND (c.object_identity LIKE 'ludy\_%' OR c.object_identity LIKE 'crove\_%'))
             OR c.object_identity LIKE 'ludy\_%.%' OR c.object_identity LIKE 'crove\_%.%'
             OR c.object_identity LIKE '% on ludy\_%.%' OR c.object_identity LIKE '% on crove\_%.%'
             OR c.object_identity LIKE '% in schema ludy\_%' OR c.object_identity LIKE '% in schema crove\_%'
        ) INTO v_concerns;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'ludy_kernel.ddl_watch could not tell whether a statement concerns Ludy (%): %', SQLSTATE, SQLERRM;
      v_concerns := false;
    END;
    IF NOT v_concerns THEN
      RETURN;
    END IF;
  END IF;

  IF TG_EVENT = 'sql_drop' THEN
    INSERT INTO ludy_kernel.ddl_event (session_role, set_role, command_tag, object_type, schema_name, object_identity,
                                        backend_pid, backend_start, client_addr)
    SELECT SESSION_USER, v_role, TG_TAG, d.object_type, d.schema_name, pg_catalog.left(d.object_identity, 500),
           pg_catalog.pg_backend_pid(), v_start, pg_catalog.inet_client_addr()
    FROM pg_catalog.pg_event_trigger_dropped_objects() d
    WHERE d.original AND NOT d.is_temporary AND NOT (v_auth_admin AND d.schema_name IS NOT DISTINCT FROM 'auth')
      AND (NOT v_shared OR v_ludy_role
           OR d.schema_name LIKE 'ludy\_%' OR d.schema_name LIKE 'crove\_%'
           OR (d.object_type = 'schema' AND (d.object_identity LIKE 'ludy\_%' OR d.object_identity LIKE 'crove\_%'))
           OR d.object_identity LIKE 'ludy\_%.%' OR d.object_identity LIKE 'crove\_%.%'
           OR d.object_identity LIKE '% on ludy\_%.%' OR d.object_identity LIKE '% on crove\_%.%');
  ELSE
    INSERT INTO ludy_kernel.ddl_event (session_role, set_role, command_tag, object_type, schema_name, object_identity,
                                        backend_pid, backend_start, client_addr)
    SELECT SESSION_USER, v_role, c.command_tag, c.object_type, c.schema_name, pg_catalog.left(c.object_identity, 500),
           pg_catalog.pg_backend_pid(), v_start, pg_catalog.inet_client_addr()
    FROM pg_catalog.pg_event_trigger_ddl_commands() c
    WHERE c.schema_name IS DISTINCT FROM 'pg_temp' AND NOT c.in_extension
      AND NOT (v_auth_admin AND c.schema_name IS NOT DISTINCT FROM 'auth')
      AND (NOT v_shared OR v_ludy_role
           OR c.schema_name LIKE 'ludy\_%' OR c.schema_name LIKE 'crove\_%'
           OR (c.object_type = 'schema' AND (c.object_identity LIKE 'ludy\_%' OR c.object_identity LIKE 'crove\_%'))
           OR c.object_identity LIKE 'ludy\_%.%' OR c.object_identity LIKE 'crove\_%.%'
           OR c.object_identity LIKE '% on ludy\_%.%' OR c.object_identity LIKE '% on crove\_%.%'
           OR c.object_identity LIKE '% in schema ludy\_%' OR c.object_identity LIKE '% in schema crove\_%');
  END IF;
END $$;
REVOKE ALL ON FUNCTION ludy_kernel.ddl_watch() FROM PUBLIC;

-- 5b. Sealed context verification and re-entry guard: read paired `ludy.*` or `crove.*` during rollout
--     (fail closed on half-pairs or mixed prefixes), reject both namespaces on re-entry.
CREATE OR REPLACE FUNCTION ludy_kernel.ctx_verified()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_ludy_ctx text := nullif(pg_catalog.current_setting('ludy.ctx', true), '');
  v_ludy_seal text := nullif(pg_catalog.current_setting('ludy.ctx_seal', true), '');
  v_crove_ctx text := nullif(pg_catalog.current_setting('crove.ctx', true), '');
  v_crove_seal text := nullif(pg_catalog.current_setting('crove.ctx_seal', true), '');
BEGIN
  IF (v_ludy_ctx IS NOT NULL OR v_ludy_seal IS NOT NULL)
     AND (v_crove_ctx IS NOT NULL OR v_crove_seal IS NOT NULL) THEN
    RAISE EXCEPTION 'CONTEXT_SEAL_INVALID' USING ERRCODE = '42501';
  END IF;
  IF v_ludy_ctx IS NOT NULL OR v_ludy_seal IS NOT NULL THEN
    IF v_ludy_ctx IS NULL OR v_ludy_seal IS NULL OR v_ludy_seal IS DISTINCT FROM ludy_kernel.ctx_mac(v_ludy_ctx) THEN
      RAISE EXCEPTION 'CONTEXT_SEAL_INVALID' USING ERRCODE = '42501';
    END IF;
    RETURN v_ludy_ctx::jsonb;
  END IF;
  IF v_crove_ctx IS NOT NULL OR v_crove_seal IS NOT NULL THEN
    IF v_crove_ctx IS NULL OR v_crove_seal IS NULL OR v_crove_seal IS DISTINCT FROM ludy_kernel.ctx_mac(v_crove_ctx) THEN
      RAISE EXCEPTION 'CONTEXT_SEAL_INVALID' USING ERRCODE = '42501';
    END IF;
    RETURN v_crove_ctx::jsonb;
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION ludy_kernel.ctx_verified() FROM PUBLIC;

CREATE OR REPLACE FUNCTION ludy_kernel.context_reentry_guard()
RETURNS void LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  c_namespace constant int := 1280656473;
  c_legacy_namespace constant int := 1129467734;
  v_pid int := pg_catalog.pg_backend_pid();
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_locks l
    WHERE l.locktype = 'advisory'
      AND l.classid IN (c_namespace::oid, c_legacy_namespace::oid)
      AND l.objid = v_pid::oid
      AND l.objsubid = 2
      AND l.pid = v_pid
      AND l.granted
  ) THEN
    RAISE EXCEPTION 'CONTEXT_REENTRY' USING ERRCODE = '42501';
  END IF;
  IF nullif(pg_catalog.current_setting('ludy.ctx', true), '') IS NOT NULL
     OR nullif(pg_catalog.current_setting('ludy.ctx_seal', true), '') IS NOT NULL
     OR nullif(pg_catalog.current_setting('ludy.org_id', true), '') IS NOT NULL
     OR nullif(pg_catalog.current_setting('ludy.user_id', true), '') IS NOT NULL
     OR nullif(pg_catalog.current_setting('crove.ctx', true), '') IS NOT NULL
     OR nullif(pg_catalog.current_setting('crove.ctx_seal', true), '') IS NOT NULL
     OR nullif(pg_catalog.current_setting('crove.org_id', true), '') IS NOT NULL
     OR nullif(pg_catalog.current_setting('crove.user_id', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'CONTEXT_REENTRY' USING ERRCODE = '42501';
  END IF;
  IF NOT pg_catalog.pg_try_advisory_xact_lock(c_namespace, v_pid) THEN
    RAISE EXCEPTION 'CONTEXT_REENTRY' USING ERRCODE = '42501';
  END IF;
END $$;
REVOKE ALL ON FUNCTION ludy_kernel.context_reentry_guard() FROM PUBLIC;

-- 5c. Runtime rate-limit and prober GUC readers: read ludy.* first with legacy crove.* fallback.
CREATE OR REPLACE FUNCTION ludy_kernel.health(p_dead_letter_window_seconds integer DEFAULT 3600)
 RETURNS TABLE(checked_at timestamp with time zone, outbox_pending integer, outbox_oldest_age_seconds double precision, inbound_pending integer, inbound_oldest_age_seconds double precision, jobs_schema_present boolean, jobs_queued integer, job_oldest_queued_age_seconds double precision, dead_letter_count integer, worker_heartbeat_age_seconds double precision)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_window interval := pg_catalog.make_interval(secs => LEAST(GREATEST(COALESCE(p_dead_letter_window_seconds, 3600), 60), 604800));
  v_worked text[];
  v_expected text[] := pg_catalog.string_to_array(
    COALESCE(NULLIF(pg_catalog.current_setting('ludy.prober_modules', true), ''), pg_catalog.current_setting('crove.prober_modules', true), ''),
    ','
  );
BEGIN
  checked_at := pg_catalog.now();

  SELECT pg_catalog.count(*)::int INTO outbox_pending
  FROM (SELECT 1 FROM ludy_kernel.outbox_pending LIMIT 10000) s;
  SELECT EXTRACT(EPOCH FROM checked_at - e.created_at)::double precision INTO outbox_oldest_age_seconds
  FROM ludy_kernel.outbox_pending p
  JOIN ludy_kernel.outbox_event e ON e.org_id = p.org_id AND e.id = p.event_id
  ORDER BY p.seq LIMIT 1;

  SELECT pg_catalog.count(*)::int INTO inbound_pending
  FROM (SELECT 1 FROM ludy_kernel.inbound_pending LIMIT 10000) s;
  SELECT EXTRACT(EPOCH FROM checked_at - i.received_at)::double precision INTO inbound_oldest_age_seconds
  FROM ludy_kernel.inbound_pending i ORDER BY i.seq LIMIT 1;

  IF NOT EXISTS (SELECT 1 FROM ludy_kernel.worker_heartbeat h WHERE h.beat_at > checked_at - interval '1 hour' AND h.modules IS NULL) THEN
    SELECT pg_catalog.array_agg(DISTINCT m) INTO v_worked
    FROM ludy_kernel.worker_heartbeat h, pg_catalog.unnest(h.modules) m
    WHERE h.beat_at > checked_at - interval '7 days';
  END IF;

  jobs_schema_present := pg_catalog.to_regclass('ludy_jobs.job') IS NOT NULL;
  IF jobs_schema_present THEN
    SELECT pg_catalog.count(*)::int, EXTRACT(EPOCH FROM checked_at - pg_catalog.min(q.start_after))::double precision
    INTO jobs_queued, job_oldest_queued_age_seconds
    FROM (
      SELECT j.start_after FROM ludy_jobs.job j
      WHERE j.state IN ('created', 'retry') AND j.start_after <= checked_at
        AND (v_worked IS NULL OR pg_catalog.split_part(j.name, '-', 1) <> ALL (ARRAY['finance', 'social', 'ads', 'crm', 'notes', 'meetings', 'sign'])
             OR pg_catalog.split_part(j.name, '-', 1) = ANY (v_worked)
             OR pg_catalog.split_part(j.name, '-', 1) = ANY (v_expected))
      ORDER BY j.start_after LIMIT 10000
    ) q;
    SELECT pg_catalog.count(*)::int INTO dead_letter_count
    FROM (
      SELECT 1 FROM ludy_jobs.job j
      WHERE j.state = 'failed' AND COALESCE(j.completed_on, j.created_on) > checked_at - v_window
      LIMIT 10000
    ) d;
  END IF;

  SELECT EXTRACT(EPOCH FROM checked_at - pg_catalog.max(h.beat_at))::double precision INTO worker_heartbeat_age_seconds
  FROM ludy_kernel.worker_heartbeat h;

  RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION ludy_kernel.health(integer) FROM PUBLIC;

CREATE OR REPLACE FUNCTION ludy_kernel.create_or_replay_org(p_user_id uuid, p_slug text, p_name text, p_idempotency_key text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid;
  v_slug text := p_slug;
  v_per_day_raw text := COALESCE(
    NULLIF(pg_catalog.current_setting('ludy.org_create_limit_per_day', true), ''),
    NULLIF(pg_catalog.current_setting('crove.org_create_limit_per_day', true), '')
  );
  v_total_raw text := COALESCE(
    NULLIF(pg_catalog.current_setting('ludy.org_create_limit_total', true), ''),
    NULLIF(pg_catalog.current_setting('crove.org_create_limit_total', true), '')
  );
  v_per_day integer;
  v_total integer;
  v_recent integer;
  v_all integer;
  v_oldest timestamptz;
  v_lock_timeout text := pg_catalog.current_setting('lock_timeout');
BEGIN
  IF (v_per_day_raw IS NOT NULL AND v_per_day_raw !~ '^[1-9][0-9]{0,5}$')
     OR (v_total_raw IS NOT NULL AND v_total_raw !~ '^[1-9][0-9]{0,5}$') THEN
    RAISE EXCEPTION 'ORG_CREATE_LIMIT_INVALID' USING ERRCODE = '22023';
  END IF;
  v_per_day := COALESCE(v_per_day_raw::integer, 5);
  v_total := COALESCE(v_total_raw::integer, 20);

  PERFORM pg_catalog.set_config('lock_timeout', '3s', true);
  BEGIN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('kernel.org.create:' || p_user_id::text, 0));
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION 'ORG_CREATE_RATE_LIMITED' USING ERRCODE = 'P0001',
      DETAIL = pg_catalog.json_build_object('rule', 'org_create_busy', 'retryAfterSeconds', 1)::text;
  END;
  PERFORM pg_catalog.set_config('lock_timeout', v_lock_timeout, true);
  IF p_idempotency_key IS NOT NULL THEN
    SELECT k.org_id INTO v_org
    FROM ludy_kernel.idempotency_key k
    WHERE k.actor_key = 'user:' || p_user_id::text AND k.key = p_idempotency_key AND k.command = 'kernel.org.create';
    IF v_org IS NOT NULL THEN
      RETURN v_org;
    END IF;
  END IF;

  SELECT pg_catalog.count(*)::integer,
         (pg_catalog.count(*) FILTER (WHERE t.created_at > pg_catalog.now() - interval '24 hours'))::integer,
         pg_catalog.min(t.created_at) FILTER (WHERE t.created_at > pg_catalog.now() - interval '24 hours')
    INTO v_all, v_recent, v_oldest
  FROM ludy_kernel.tenant t
  WHERE t.created_by = p_user_id;
  IF v_all >= v_total THEN
    RAISE EXCEPTION 'ORG_CREATE_RATE_LIMITED' USING ERRCODE = 'P0001',
      DETAIL = pg_catalog.json_build_object('rule', 'org_create_total', 'limit', v_total)::text;
  END IF;
  IF v_recent >= v_per_day THEN
    RAISE EXCEPTION 'ORG_CREATE_RATE_LIMITED' USING ERRCODE = 'P0001',
      DETAIL = pg_catalog.json_build_object(
        'rule', 'org_create_per_day',
        'limit', v_per_day,
        'retryAfterSeconds', GREATEST(1, pg_catalog.ceil(
          pg_catalog.date_part('epoch', v_oldest + interval '24 hours' - pg_catalog.now())))::integer)::text;
  END IF;

  FOR attempt IN 1..5 LOOP
    INSERT INTO ludy_kernel.tenant (slug, name, created_by) VALUES (v_slug, p_name, p_user_id)
    ON CONFLICT (slug) DO NOTHING
    RETURNING org_id INTO v_org;
    EXIT WHEN v_org IS NOT NULL;
    v_slug := pg_catalog.left(p_slug, 40) || '-' || pg_catalog.left(ludy_kernel.random_token(), 4);
  END LOOP;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'ORG_SLUG_TAKEN' USING ERRCODE = '23505';
  END IF;
  INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES (v_org, p_user_id, 'owner');
  INSERT INTO ludy_kernel.legal_entity (org_id, name, is_default, created_by) VALUES (v_org, p_name, true, p_user_id);
  RETURN v_org;
END $$;
REVOKE ALL ON FUNCTION ludy_kernel.create_or_replay_org(uuid, text, text, text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION ludy_kernel.inbound_rotate()
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_user uuid := ludy_kernel.ctx_user_id();
  v_per_day_raw text := COALESCE(
    NULLIF(pg_catalog.current_setting('ludy.inbound_rotate_limit_per_day', true), ''),
    NULLIF(pg_catalog.current_setting('crove.inbound_rotate_limit_per_day', true), '')
  );
  v_total_raw text := COALESCE(
    NULLIF(pg_catalog.current_setting('ludy.inbound_rotate_limit_total', true), ''),
    NULLIF(pg_catalog.current_setting('crove.inbound_rotate_limit_total', true), '')
  );
  v_per_day integer;
  v_total integer;
  v_recent integer;
  v_all integer;
  v_oldest timestamptz;
  v_now timestamptz;
  v_lock_timeout text := pg_catalog.current_setting('lock_timeout');
  v_token text;
  v_active boolean := false;
BEGIN
  IF v_org IS NULL OR v_user IS NULL THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  IF (v_per_day_raw IS NOT NULL AND v_per_day_raw !~ '^[1-9][0-9]{0,5}$')
     OR (v_total_raw IS NOT NULL AND v_total_raw !~ '^[1-9][0-9]{0,5}$') THEN
    RAISE EXCEPTION 'INBOUND_ROTATE_LIMIT_INVALID' USING ERRCODE = '22023';
  END IF;
  v_per_day := COALESCE(v_per_day_raw::integer, 3);
  v_total := COALESCE(v_total_raw::integer, 50);

  PERFORM pg_catalog.set_config('lock_timeout', '3s', true);
  BEGIN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('kernel.inbound.rotate:' || v_org::text, 0));
    PERFORM 1 FROM ludy_kernel.tenant t WHERE t.org_id = v_org AND t.status = 'active' FOR UPDATE;
    v_active := FOUND;
  EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
    RAISE EXCEPTION 'INBOUND_ROTATE_RATE_LIMITED' USING ERRCODE = 'P0001',
      DETAIL = pg_catalog.json_build_object('rule', 'inbound_rotate_busy', 'retryAfterSeconds', 1)::text;
  END;
  PERFORM pg_catalog.set_config('lock_timeout', v_lock_timeout, true);

  IF NOT v_active THEN
    RAISE EXCEPTION 'TENANT_NOT_ACTIVE' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM ludy_kernel.tenant_member m WHERE m.org_id = v_org AND m.user_id = v_user AND m.role = 'owner'
  ) THEN
    RAISE EXCEPTION 'INBOUND_ROTATE_OWNER_ONLY' USING ERRCODE = '42501';
  END IF;

  v_now := pg_catalog.clock_timestamp();
  SELECT (pg_catalog.count(*) FILTER (WHERE a.retired_at IS NOT NULL))::integer,
         (pg_catalog.count(*) FILTER (WHERE a.retired_at > v_now - interval '24 hours'))::integer
    INTO v_all, v_recent
  FROM ludy_kernel.inbound_address a
  WHERE a.org_id = v_org AND a.kind = 'document';
  IF v_all >= v_total THEN
    RAISE EXCEPTION 'INBOUND_ROTATE_RATE_LIMITED' USING ERRCODE = 'P0001',
      DETAIL = pg_catalog.json_build_object('rule', 'inbound_rotate_total', 'limit', v_total)::text;
  END IF;
  IF v_recent >= v_per_day THEN
    SELECT a.retired_at INTO v_oldest
    FROM ludy_kernel.inbound_address a
    WHERE a.org_id = v_org AND a.kind = 'document' AND a.retired_at > v_now - interval '24 hours'
    ORDER BY a.retired_at DESC
    OFFSET v_per_day - 1 LIMIT 1;
    RAISE EXCEPTION 'INBOUND_ROTATE_RATE_LIMITED' USING ERRCODE = 'P0001',
      DETAIL = pg_catalog.json_build_object(
        'rule', 'inbound_rotate_per_day',
        'limit', v_per_day,
        'retryAfterSeconds', GREATEST(1, pg_catalog.ceil(
          pg_catalog.date_part('epoch', v_oldest + interval '24 hours' - v_now)))::integer)::text;
  END IF;

  UPDATE ludy_kernel.inbound_address SET retired_at = v_now WHERE org_id = v_org AND kind = 'document' AND retired_at IS NULL;
  FOR attempt IN 1..5 LOOP
    INSERT INTO ludy_kernel.inbound_address (org_id, token) VALUES (v_org, ludy_kernel.random_token())
    ON CONFLICT (token) DO NOTHING
    RETURNING token INTO v_token;
    EXIT WHEN v_token IS NOT NULL;
  END LOOP;
  IF v_token IS NULL THEN
    RAISE EXCEPTION 'INBOUND_TOKEN_EXHAUSTED' USING ERRCODE = '23505';
  END IF;
  UPDATE ludy_kernel.tenant SET inbound_token = v_token WHERE org_id = v_org;
  RETURN v_token;
END $$;
REVOKE ALL ON FUNCTION ludy_kernel.inbound_rotate() FROM PUBLIC;

CREATE OR REPLACE FUNCTION ludy_kernel.conversation_address_rotate()
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_user uuid := ludy_kernel.ctx_user_id();
  v_per_day_raw text := COALESCE(
    NULLIF(pg_catalog.current_setting('ludy.inbound_rotate_limit_per_day', true), ''),
    NULLIF(pg_catalog.current_setting('crove.inbound_rotate_limit_per_day', true), '')
  );
  v_total_raw text := COALESCE(
    NULLIF(pg_catalog.current_setting('ludy.inbound_rotate_limit_total', true), ''),
    NULLIF(pg_catalog.current_setting('crove.inbound_rotate_limit_total', true), '')
  );
  v_per_day integer;
  v_total integer;
  v_recent integer;
  v_all integer;
  v_oldest timestamptz;
  v_now timestamptz;
  v_lock_timeout text := pg_catalog.current_setting('lock_timeout');
  v_token text;
  v_active boolean := false;
BEGIN
  IF v_org IS NULL OR v_user IS NULL THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  IF (v_per_day_raw IS NOT NULL AND v_per_day_raw !~ '^[1-9][0-9]{0,5}$')
     OR (v_total_raw IS NOT NULL AND v_total_raw !~ '^[1-9][0-9]{0,5}$') THEN
    RAISE EXCEPTION 'INBOUND_ROTATE_LIMIT_INVALID' USING ERRCODE = '22023';
  END IF;
  v_per_day := COALESCE(v_per_day_raw::integer, 3);
  v_total := COALESCE(v_total_raw::integer, 50);

  PERFORM pg_catalog.set_config('lock_timeout', '3s', true);
  BEGIN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('kernel.conversation.address_rotate:' || v_org::text, 0));
    PERFORM 1 FROM ludy_kernel.tenant t WHERE t.org_id = v_org AND t.status = 'active' FOR UPDATE;
    v_active := FOUND;
  EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
    RAISE EXCEPTION 'INBOUND_ROTATE_RATE_LIMITED' USING ERRCODE = 'P0001',
      DETAIL = pg_catalog.json_build_object('rule', 'inbound_rotate_busy', 'retryAfterSeconds', 1)::text;
  END;
  PERFORM pg_catalog.set_config('lock_timeout', v_lock_timeout, true);

  IF NOT v_active THEN
    RAISE EXCEPTION 'TENANT_NOT_ACTIVE' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM ludy_kernel.tenant_member m WHERE m.org_id = v_org AND m.user_id = v_user AND m.role = 'owner'
  ) THEN
    RAISE EXCEPTION 'INBOUND_ROTATE_OWNER_ONLY' USING ERRCODE = '42501';
  END IF;

  v_now := pg_catalog.clock_timestamp();
  SELECT (pg_catalog.count(*) FILTER (WHERE a.retired_at IS NOT NULL))::integer,
         (pg_catalog.count(*) FILTER (WHERE a.retired_at > v_now - interval '24 hours'))::integer
    INTO v_all, v_recent
  FROM ludy_kernel.inbound_address a
  WHERE a.org_id = v_org AND a.kind = 'conversation';
  IF v_all >= v_total THEN
    RAISE EXCEPTION 'INBOUND_ROTATE_RATE_LIMITED' USING ERRCODE = 'P0001',
      DETAIL = pg_catalog.json_build_object('rule', 'inbound_rotate_total', 'limit', v_total)::text;
  END IF;
  IF v_recent >= v_per_day THEN
    SELECT a.retired_at INTO v_oldest
    FROM ludy_kernel.inbound_address a
    WHERE a.org_id = v_org AND a.kind = 'conversation' AND a.retired_at > v_now - interval '24 hours'
    ORDER BY a.retired_at DESC
    OFFSET v_per_day - 1 LIMIT 1;
    RAISE EXCEPTION 'INBOUND_ROTATE_RATE_LIMITED' USING ERRCODE = 'P0001',
      DETAIL = pg_catalog.json_build_object(
        'rule', 'inbound_rotate_per_day',
        'limit', v_per_day,
        'retryAfterSeconds', GREATEST(1, pg_catalog.ceil(
          pg_catalog.date_part('epoch', v_oldest + interval '24 hours' - v_now)))::integer)::text;
  END IF;

  UPDATE ludy_kernel.inbound_address SET retired_at = v_now WHERE org_id = v_org AND kind = 'conversation' AND retired_at IS NULL;
  FOR attempt IN 1..5 LOOP
    INSERT INTO ludy_kernel.inbound_address (org_id, token, kind) VALUES (v_org, ludy_kernel.random_token(), 'conversation')
    ON CONFLICT (token) DO NOTHING
    RETURNING token INTO v_token;
    EXIT WHEN v_token IS NOT NULL;
  END LOOP;
  IF v_token IS NULL THEN
    RAISE EXCEPTION 'INBOUND_TOKEN_EXHAUSTED' USING ERRCODE = '23505';
  END IF;
  UPDATE ludy_kernel.tenant SET conversation_token = v_token WHERE org_id = v_org;
  RETURN v_token;
END $$;
REVOKE ALL ON FUNCTION ludy_kernel.conversation_address_rotate() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- 5h. Rewrite trigger literal arguments referencing renamed core schemas
--     (PostgreSQL updates OIDs on ALTER SCHEMA RENAME, not TG_ARGV strings)
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
      AND (n.nspname LIKE 'ludy\_%' OR n.nspname LIKE 'crove\_%')
      AND pg_catalog.pg_get_triggerdef(tg.oid) ~ '\ycrove_(kernel|meta|jobs)\y'
    ORDER BY 1, 2, 3
  LOOP
    v_new_def := pg_catalog.regexp_replace(r.def, '\ycrove_(kernel|meta|jobs)\y', 'ludy_\1', 'g');
    IF v_new_def IS DISTINCT FROM r.def THEN
      n := 0;
      LOOP
        BEGIN
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
-- 6. Migrate catalog table references in ludy_kernel.*
-- ---------------------------------------------------------------------------
UPDATE ludy_kernel.member_vy_table
   SET table_name = pg_catalog.replace(table_name, 'crove_kernel.', 'ludy_kernel.')
 WHERE table_name LIKE 'crove_kernel.%';

UPDATE ludy_kernel.mcp_member_table
   SET table_name = pg_catalog.replace(table_name, 'crove_kernel.', 'ludy_kernel.')
 WHERE table_name LIKE 'crove_kernel.%';
