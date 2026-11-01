-- SPDX-License-Identifier: AGPL-3.0-only
-- The DDL watch in a shared database (issue #2284, docs/runbooks/shared-database.md). Idempotent; applied files stay
-- untouched.
--
-- crove_kernel.ddl_watch() is attached by event triggers that fire on every DDL statement of the whole database. In a
-- database that other systems own schemas in (Ludy Cloud inside DOS's Supabase project) it must neither record nor alert
-- their DDL, and must never fail it. `migrate` writes the mode to crove_meta.deployment (`shared_database`, true or false)
-- on every run, and the function reads it:
--   false (no row, no table: the owned database, every self-host)  exactly the behavior of 20261029210000.
--   true  records only DDL that concerns Ludy: an object in a `crove_*` schema (a trigger, policy or rule on one, a default
--         privilege or an extension in one, or a `crove_*` schema itself), or any statement run by one of Ludy's own roles
--         (the eight the migrations create, by name: another system's role called crove_something is not one), whatever it
--         touches. A foreign role's DDL in its own schemas leaves no row and no alert; a foreign role that touches a `crove_*`
--         object is recorded like anyone else.
-- For a statement of a foreign role the only thing that runs before that decision is the check of whether it concerns Ludy,
-- and an error in that check is a warning, so another system's DDL never fails because of this function. A Ludy role's
-- statement, and any statement that does concern a `crove_*` object, is recorded by the INSERT below, and a failure there fails
-- the statement, as in an owned database. A statement with no schema and no object identity (a GRANT) is attributed by its role
-- only: a foreign role's GRANT on a Ludy object cannot be told from one on its own, so `migrate` takes the privileges a foreign
-- role holds on Ludy's objects back and checks them instead.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.ddl_watch() RETURNS event_trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_start timestamptz;
  v_role text := NULLIF(pg_catalog.current_setting('role'), 'none');
  v_auth_admin boolean;
  v_shared boolean := false;
  v_ludy_role boolean;
  v_concerns boolean := true;
BEGIN
  -- A database nothing has set the mode in is an owned one. to_regclass first: the table is the runner's, created on its
  -- first run, and a statement must never fail for its absence.
  IF pg_catalog.to_regclass('crove_meta.deployment') IS NOT NULL THEN
    SELECT COALESCE(bool_or(d.value = 'true'), false) INTO v_shared FROM crove_meta.deployment d WHERE d.key = 'shared_database';
  END IF;
  -- Ludy's own roles, by name (the roles the migrations create); a role of another system named crove_something is not one.
  v_ludy_role := SESSION_USER::text = ANY (ARRAY['crove_tenant', 'crove_app', 'crove_worker', 'crove_prober', 'crove_reporter', 'crove_auth_reader', 'crove_definer_tenant', 'crove_definer_system'])
              OR COALESCE(v_role, '') = ANY (ARRAY['crove_tenant', 'crove_app', 'crove_worker', 'crove_prober', 'crove_reporter', 'crove_auth_reader', 'crove_definer_tenant', 'crove_definer_system']);

  SELECT a.backend_start INTO v_start FROM pg_catalog.pg_stat_activity a WHERE a.pid = pg_catalog.pg_backend_pid();
  IF EXISTS (
    SELECT 1 FROM crove_meta.pipeline_session m
    WHERE m.pid = pg_catalog.pg_backend_pid() AND m.backend_start = v_start
  ) THEN
    RETURN;
  END IF;
  -- Supabase Auth's role: its objects in `auth` only (see 20261029210000).
  v_auth_admin := v_role IS NULL AND EXISTS (
    SELECT 1 FROM pg_catalog.pg_namespace n JOIN pg_catalog.pg_roles r ON r.oid = n.nspowner
    WHERE n.nspname = 'auth' AND r.rolname = SESSION_USER AND NOT r.rolsuper
  );

  -- In a shared database a statement of another system's role that concerns nothing of Ludy's is never recorded, and nothing here
  -- may fail it: the check of whether it concerns Ludy is the only part that runs for it, and an error in that check is a
  -- warning. Anything else (a Ludy role, any statement on a `crove_*` object) is recorded by the statements below, and a failure
  -- there fails the statement, as in an owned database (nothing escapes unrecorded).
  IF v_shared AND NOT v_ludy_role THEN
    BEGIN
      IF TG_EVENT = 'sql_drop' THEN
        SELECT EXISTS (
          SELECT 1 FROM pg_catalog.pg_event_trigger_dropped_objects() d
          WHERE d.original AND NOT d.is_temporary
            AND (d.schema_name LIKE 'crove\_%'
                 OR (d.object_type = 'schema' AND d.object_identity LIKE 'crove\_%')
                 OR d.object_identity LIKE 'crove\_%.%'
                 OR d.object_identity LIKE '% on crove\_%.%')
        ) INTO v_concerns;
      ELSE
        SELECT EXISTS (
          SELECT 1 FROM pg_catalog.pg_event_trigger_ddl_commands() c
          WHERE c.schema_name LIKE 'crove\_%'
             OR (c.object_type = 'schema' AND c.object_identity LIKE 'crove\_%')
             OR c.object_identity LIKE 'crove\_%.%'
             OR c.object_identity LIKE '% on crove\_%.%'
             OR c.object_identity LIKE '% in schema crove\_%'
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

  IF TG_EVENT = 'sql_drop' THEN
    INSERT INTO crove_kernel.ddl_event (session_role, set_role, command_tag, object_type, schema_name, object_identity,
                                        backend_pid, backend_start, client_addr)
    SELECT SESSION_USER, v_role, TG_TAG, d.object_type, d.schema_name, pg_catalog.left(d.object_identity, 500),
           pg_catalog.pg_backend_pid(), v_start, pg_catalog.inet_client_addr()
    FROM pg_catalog.pg_event_trigger_dropped_objects() d
    WHERE d.original AND NOT d.is_temporary AND NOT (v_auth_admin AND d.schema_name IS NOT DISTINCT FROM 'auth')
      AND (NOT v_shared OR v_ludy_role
           OR d.schema_name LIKE 'crove\_%'
           OR (d.object_type = 'schema' AND d.object_identity LIKE 'crove\_%')
           OR d.object_identity LIKE 'crove\_%.%'
           OR d.object_identity LIKE '% on crove\_%.%');
  ELSE
    INSERT INTO crove_kernel.ddl_event (session_role, set_role, command_tag, object_type, schema_name, object_identity,
                                        backend_pid, backend_start, client_addr)
    SELECT SESSION_USER, v_role, c.command_tag, c.object_type, c.schema_name, pg_catalog.left(c.object_identity, 500),
           pg_catalog.pg_backend_pid(), v_start, pg_catalog.inet_client_addr()
    FROM pg_catalog.pg_event_trigger_ddl_commands() c
    WHERE c.schema_name IS DISTINCT FROM 'pg_temp' AND NOT c.in_extension
      AND NOT (v_auth_admin AND c.schema_name IS NOT DISTINCT FROM 'auth')
      AND (NOT v_shared OR v_ludy_role
           OR c.schema_name LIKE 'crove\_%'
           OR (c.object_type = 'schema' AND c.object_identity LIKE 'crove\_%')
           OR c.object_identity LIKE 'crove\_%.%'
           OR c.object_identity LIKE '% on crove\_%.%'
           OR c.object_identity LIKE '% in schema crove\_%');
  END IF;
END $$;
-- An event trigger function cannot be called directly; no role needs EXECUTE to have it fire.
REVOKE ALL ON FUNCTION crove_kernel.ddl_watch() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
