-- SPDX-License-Identifier: AGPL-3.0-only
-- The DDL watch in a shared database (issue #2284, docs/runbooks/shared-database.md). Idempotent; applied files stay
-- untouched.
--
-- crove_kernel.ddl_watch() is attached by event triggers that fire on every DDL statement of the whole database. In a
-- database that other systems own schemas in (Ludy Cloud inside DOS's Supabase project) it must neither record nor alert
-- their DDL. `migrate` writes the mode to crove_meta.deployment (`shared_database`, true or false) on every run, and the
-- function reads it:
--   false (no row, no table: the owned database, every self-host)  exactly the behavior of 20261029210000.
--   true                          records only DDL that concerns Ludy: an object in a `crove_*` schema (or a `crove_*` schema
--                                 itself), or any statement run by a `crove_*` role, whatever it touches. A foreign role's
--                                 DDL in its own schemas leaves no row and no alert, and a foreign role that touches a
--                                 `crove_*` object is recorded like anyone else.
-- A trigger, policy or rule on a `crove_*` table, and a default privilege or extension in a `crove_*` schema, are recorded by their identity. A statement with no schema and no object identity (a GRANT) is attributed by its role only, so a foreign role's GRANT on
-- a Ludy object cannot be told from one on its own; the privileges a foreign role holds on Ludy's objects are taken back and
-- checked by `migrate` instead.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.ddl_watch() RETURNS event_trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_start timestamptz;
  v_role text := NULLIF(pg_catalog.current_setting('role'), 'none');
  v_auth_admin boolean;
  v_shared boolean := false;
  v_ludy_role boolean;
BEGIN
  -- A database nothing has set the mode in is an owned one. to_regclass first: the table is the runner's, created on its
  -- first run, and a statement must never fail for its absence.
  IF pg_catalog.to_regclass('crove_meta.deployment') IS NOT NULL THEN
    SELECT COALESCE(bool_or(d.value = 'true'), false) INTO v_shared FROM crove_meta.deployment d WHERE d.key = 'shared_database';
  END IF;
  v_ludy_role := SESSION_USER::text LIKE 'crove\_%' OR COALESCE(v_role, '') LIKE 'crove\_%';

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

  -- In a shared database the watch never fails another system's statement: an error while recording is a warning there.
  -- The owned database re-raises it, as before (a failure here fails the DDL statement, so nothing escapes unrecorded).
  BEGIN
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
  EXCEPTION WHEN OTHERS THEN
    IF NOT v_shared THEN
      RAISE;
    END IF;
    RAISE WARNING 'crove_kernel.ddl_watch could not record a statement (%): %', SQLSTATE, SQLERRM;
  END;
END $$;
-- An event trigger function cannot be called directly; no role needs EXECUTE to have it fire.
REVOKE ALL ON FUNCTION crove_kernel.ddl_watch() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
