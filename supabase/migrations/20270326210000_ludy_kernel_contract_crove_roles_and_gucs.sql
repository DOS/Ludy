-- SPDX-License-Identifier: AGPL-3.0-only
-- Stage 7 (#3972, ADR-0054): revoke cluster-wide crove_* -> ludy_* role memberships, clear passwords on
-- legacy crove_* login roles, revoke direct privileges on ludy_* objects, and remove legacy crove.* GUC and
-- crove_* ddl_watch fallbacks once Phase 3 cutover is complete. Requires all databases and services sharing
-- the PostgreSQL cluster to run on ludy_* logins before applying. Legacy crove_* role definitions and
-- crove_prober/crove_reporter LOGIN attributes remain in place so immutable pre-cutover migrations still replay.

-- ---------------------------------------------------------------------------
-- 1. Revoke ludy_* role transition memberships (by exact grantor), clear
--    passwords on legacy crove_* logins, and revoke remaining crove_* object
--    ACLs across ludy_* schemas (including prober and reporter direct grants
--    retained during the Stage 7 transition).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_login text;
  v_remaining text;
  v_is_super boolean;
  v_default_acls text;
  v_owned text;
  r record;
  v_ludy_roles constant text[] := ARRAY[
    'ludy_tenant',
    'ludy_app',
    'ludy_worker',
    'ludy_prober',
    'ludy_reporter',
    'ludy_auth_reader',
    'ludy_definer_tenant',
    'ludy_definer_einvoice',
    'ludy_definer_system'
  ];
  v_legacy_roles constant text[] := ARRAY[
    'crove_tenant',
    'crove_app',
    'crove_worker',
    'crove_prober',
    'crove_reporter',
    'crove_auth_reader',
    'crove_definer_tenant',
    'crove_definer_einvoice',
    'crove_definer_system'
  ];
BEGIN
  FOR r IN
    SELECT tgt.rolname AS target_role, mem.rolname AS member_role, gr.rolname AS grantor_role
    FROM pg_catalog.pg_auth_members am
    JOIN pg_catalog.pg_roles tgt ON tgt.oid = am.roleid
    JOIN pg_catalog.pg_roles mem ON mem.oid = am.member
    JOIN pg_catalog.pg_roles gr ON gr.oid = am.grantor
    WHERE mem.rolname = ANY (v_legacy_roles)
      AND tgt.rolname = ANY (v_ludy_roles)
    ORDER BY tgt.rolname, mem.rolname, gr.rolname
  LOOP
    EXECUTE pg_catalog.format('REVOKE %I FROM %I GRANTED BY %I', r.target_role, r.member_role, r.grantor_role);
  END LOOP;

  SELECT pg_catalog.string_agg(
           pg_catalog.format('%s -> %s', mem.rolname, tgt.rolname),
           ', ' ORDER BY tgt.rolname, mem.rolname
         )
  INTO v_remaining
  FROM pg_catalog.pg_roles mem
  CROSS JOIN pg_catalog.pg_roles tgt
  WHERE mem.rolname = ANY (v_legacy_roles)
    AND tgt.rolname = ANY (v_ludy_roles)
    AND (
      pg_catalog.pg_has_role(mem.oid, tgt.oid, 'MEMBER')
      OR pg_catalog.pg_has_role(mem.oid, tgt.oid, 'USAGE')
      OR pg_catalog.pg_has_role(mem.oid, tgt.oid, 'SET')
    );
  IF v_remaining IS NOT NULL THEN
    RAISE EXCEPTION 'stage 7 contraction failed: legacy crove_* role still has effective membership in ludy_* (%): revoke direct or indirect role grants before retrying', v_remaining;
  END IF;

  -- Invalidate passwords on legacy login roles while preserving LOGIN for historical migration replay.
  -- Setting PASSWORD NULL VALID UNTIL '-infinity' plus the cluster Stage 7 marker lets a non-superuser
  -- runner without ADMIN OPTION on a pre-existing role verify a privileged Stage 7 run already cleared
  -- the password when pg_catalog.pg_authid is unreadable (while checking rolpassword IS NULL directly
  -- whenever pg_authid is readable).
  FOREACH v_login IN ARRAY ARRAY['crove_app', 'crove_worker', 'crove_prober', 'crove_reporter'] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = v_login) THEN
      IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = current_user AND rolsuper)
         OR (
           EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = current_user AND rolcreaterole)
           AND pg_catalog.pg_has_role(current_user, v_login, 'MEMBER WITH ADMIN OPTION')
         ) THEN
        EXECUTE pg_catalog.format('ALTER ROLE %I WITH PASSWORD NULL VALID UNTIL ''-infinity''', v_login);
      ELSIF pg_catalog.has_table_privilege(current_user, 'pg_catalog.pg_authid', 'SELECT') THEN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_catalog.pg_authid
          WHERE rolname = v_login
            AND rolpassword IS NULL
            AND rolvaliduntil IS NOT NULL
            AND rolvaliduntil <= '1970-01-01 00:00:00+00'::timestamptz
        ) THEN
          RAISE EXCEPTION
            'stage 7 contraction failed: role % cannot clear or verify cleared password on % (requires superuser or CREATEROLE with ADMIN OPTION on %); run ALTER ROLE % WITH PASSWORD NULL VALID UNTIL ''-infinity'' as the role owner or superuser before retrying',
            current_user, v_login, v_login, v_login;
        END IF;
      ELSIF NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_roles ro
        JOIN pg_catalog.pg_roles marker ON marker.rolname = 'crove_tenant'
        WHERE ro.rolname = v_login
          AND ro.rolvaliduntil IS NOT NULL
          AND ro.rolvaliduntil <= '1970-01-01 00:00:00+00'::timestamptz
          AND pg_catalog.shobj_description(marker.oid, 'pg_authid') = 'ludy:stage7-contracted'
      ) THEN
        RAISE EXCEPTION
          'stage 7 contraction failed: role % cannot clear or verify cleared password on % (requires superuser or CREATEROLE with ADMIN OPTION on %); run ALTER ROLE % WITH PASSWORD NULL VALID UNTIL ''-infinity'' (or complete Stage 7 as superuser/role owner) before retrying',
          current_user, v_login, v_login, v_login;
      END IF;
    END IF;
  END LOOP;

  -- Column ACLs first so table-level REVOKE never clears attacl independently.
  FOR r IN
    SELECT DISTINCT n.nspname AS schema_name, c.relname, att.attname, gr.rolname AS grantee, a.privilege_type
    FROM pg_catalog.pg_attribute att
    JOIN pg_catalog.pg_class c ON c.oid = att.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(att.attacl) a
    JOIN pg_catalog.pg_roles gr ON gr.oid = a.grantee
    WHERE n.nspname LIKE 'ludy\_%'
      AND att.attnum > 0 AND NOT att.attisdropped
      AND gr.rolname = ANY (v_legacy_roles)
    ORDER BY n.nspname, c.relname, att.attname, gr.rolname, a.privilege_type
  LOOP
    EXECUTE pg_catalog.format('REVOKE %s (%I) ON %I.%I FROM %I', r.privilege_type, r.attname, r.schema_name, r.relname, r.grantee);
  END LOOP;

  -- Table, view, materialized view, and foreign table ACLs.
  FOR r IN
    SELECT DISTINCT n.nspname AS schema_name, c.relname, gr.rolname AS grantee, a.privilege_type
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
    JOIN pg_catalog.pg_roles gr ON gr.oid = a.grantee
    WHERE n.nspname LIKE 'ludy\_%'
      AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND gr.rolname = ANY (v_legacy_roles)
    ORDER BY n.nspname, c.relname, gr.rolname, a.privilege_type
  LOOP
    EXECUTE pg_catalog.format('REVOKE %s ON TABLE %I.%I FROM %I', r.privilege_type, r.schema_name, r.relname, r.grantee);
  END LOOP;

  -- Sequence ACLs.
  FOR r IN
    SELECT DISTINCT n.nspname AS schema_name, c.relname, gr.rolname AS grantee, a.privilege_type
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
    JOIN pg_catalog.pg_roles gr ON gr.oid = a.grantee
    WHERE n.nspname LIKE 'ludy\_%'
      AND c.relkind = 'S'
      AND gr.rolname = ANY (v_legacy_roles)
    ORDER BY n.nspname, c.relname, gr.rolname, a.privilege_type
  LOOP
    EXECUTE pg_catalog.format('REVOKE %s ON SEQUENCE %I.%I FROM %I', r.privilege_type, r.schema_name, r.relname, r.grantee);
  END LOOP;

  -- Routine ACLs (ON ROUTINE handles functions, aggregates, procedures, and window functions).
  FOR r IN
    SELECT DISTINCT p.oid::pg_catalog.regprocedure::text AS fn_sig,
           gr.rolname AS grantee,
           a.privilege_type
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) a
    JOIN pg_catalog.pg_roles gr ON gr.oid = a.grantee
    WHERE n.nspname LIKE 'ludy\_%'
      AND a.grantee <> p.proowner
      AND gr.rolname = ANY (v_legacy_roles)
    ORDER BY p.oid::pg_catalog.regprocedure::text, gr.rolname, a.privilege_type
  LOOP
    EXECUTE pg_catalog.format('REVOKE %s ON ROUTINE %s FROM %I', r.privilege_type, r.fn_sig, r.grantee);
  END LOOP;

  -- Type and domain ACLs.
  FOR r IN
    SELECT DISTINCT n.nspname AS schema_name, t.typname, gr.rolname AS grantee, a.privilege_type
    FROM pg_catalog.pg_type t
    JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(t.typacl) a
    JOIN pg_catalog.pg_roles gr ON gr.oid = a.grantee
    WHERE n.nspname LIKE 'ludy\_%'
      AND t.typacl IS NOT NULL
      AND a.grantee <> t.typowner
      AND gr.rolname = ANY (v_legacy_roles)
    ORDER BY n.nspname, t.typname, gr.rolname, a.privilege_type
  LOOP
    EXECUTE pg_catalog.format('REVOKE %s ON TYPE %I.%I FROM %I', r.privilege_type, r.schema_name, r.typname, r.grantee);
  END LOOP;

  -- Schema ACLs last.
  FOR r IN
    SELECT DISTINCT n.nspname AS schema_name, gr.rolname AS grantee, a.privilege_type
    FROM pg_catalog.pg_namespace n
    CROSS JOIN LATERAL pg_catalog.aclexplode(n.nspacl) a
    JOIN pg_catalog.pg_roles gr ON gr.oid = a.grantee
    WHERE n.nspname LIKE 'ludy\_%'
      AND gr.rolname = ANY (v_legacy_roles)
    ORDER BY n.nspname, gr.rolname, a.privilege_type
  LOOP
    EXECUTE pg_catalog.format('REVOKE %s ON SCHEMA %I FROM %I', r.privilege_type, r.schema_name, r.grantee);
  END LOOP;

  -- Default privilege entries (pg_default_acl) across ludy_* schemas and global defaults for every grantor.
  SELECT COALESCE(ro.rolsuper, false) INTO v_is_super
  FROM pg_catalog.pg_roles ro WHERE ro.rolname = current_user;
  v_is_super := COALESCE(v_is_super, false);
  FOR r IN
    SELECT DISTINCT ow.rolname AS owner_role,
           n.nspname AS schema_name,
           CASE d.defaclobjtype
             WHEN 'r' THEN 'TABLES'
             WHEN 'S' THEN 'SEQUENCES'
             WHEN 'f' THEN 'FUNCTIONS'
             WHEN 'T' THEN 'TYPES'
             WHEN 'n' THEN 'SCHEMAS'
             ELSE NULL
           END AS obj_kind,
           gr.rolname AS grantee
    FROM pg_catalog.pg_default_acl d
    LEFT JOIN pg_catalog.pg_namespace n ON n.oid = d.defaclnamespace
    JOIN pg_catalog.pg_roles ow ON ow.oid = d.defaclrole
    CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) a
    JOIN pg_catalog.pg_roles gr ON gr.oid = a.grantee
    WHERE (d.defaclnamespace = 0 OR n.nspname LIKE 'ludy\_%')
      AND gr.rolname = ANY (v_legacy_roles)
      AND (v_is_super OR ow.rolname = current_user OR pg_catalog.pg_has_role(current_user, ow.oid, 'SET'))
    ORDER BY ow.rolname, n.nspname NULLS FIRST, obj_kind, gr.rolname
  LOOP
    IF r.obj_kind IS NOT NULL THEN
      IF r.schema_name IS NOT NULL THEN
        EXECUTE pg_catalog.format(
          'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I REVOKE ALL ON %s FROM %I',
          r.owner_role, r.schema_name, r.obj_kind, r.grantee
        );
      ELSE
        EXECUTE pg_catalog.format(
          'ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE ALL ON %s FROM %I',
          r.owner_role, r.obj_kind, r.grantee
        );
      END IF;
    END IF;
  END LOOP;

  SELECT pg_catalog.string_agg(desc_text, ', ' ORDER BY desc_text)
  INTO v_default_acls
  FROM (
    SELECT DISTINCT pg_catalog.format(
      '%s on %s in %s -> %s',
      ow.rolname,
      CASE d.defaclobjtype
        WHEN 'r' THEN 'TABLES'
        WHEN 'S' THEN 'SEQUENCES'
        WHEN 'f' THEN 'FUNCTIONS'
        WHEN 'T' THEN 'TYPES'
        WHEN 'n' THEN 'SCHEMAS'
        ELSE d.defaclobjtype::text
      END,
      COALESCE(n.nspname, 'all schemas'),
      gr.rolname
    ) AS desc_text
    FROM pg_catalog.pg_default_acl d
    LEFT JOIN pg_catalog.pg_namespace n ON n.oid = d.defaclnamespace
    JOIN pg_catalog.pg_roles ow ON ow.oid = d.defaclrole
    CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) a
    JOIN pg_catalog.pg_roles gr ON gr.oid = a.grantee
    WHERE (d.defaclnamespace = 0 OR n.nspname LIKE 'ludy\_%')
      AND gr.rolname = ANY (v_legacy_roles)
  ) remaining_defaults;
  IF v_default_acls IS NOT NULL THEN
    RAISE EXCEPTION
      'stage 7 contraction failed: default privileges still grant to legacy crove_* roles (%): revoke via ALTER DEFAULT PRIVILEGES FOR ROLE <owner> as the granting role or superuser before retrying',
      v_default_acls;
  END IF;

  -- Verify no legacy crove_* role owns any ludy_* schema or object (login roles own nothing; owners keep implicit ACLs).
  SELECT pg_catalog.string_agg(owned_desc, ', ' ORDER BY owned_desc)
  INTO v_owned
  FROM (
    SELECT pg_catalog.format('schema %s (owner %s)', n.nspname, ow.rolname) AS owned_desc
    FROM pg_catalog.pg_namespace n
    JOIN pg_catalog.pg_roles ow ON ow.oid = n.nspowner
    WHERE n.nspname LIKE 'ludy\_%'
      AND ow.rolname = ANY (v_legacy_roles)
    UNION ALL
    SELECT pg_catalog.format('%s %I.%I (owner %s)', CASE WHEN c.relkind = 'S' THEN 'sequence' ELSE 'relation' END, n.nspname, c.relname, ow.rolname)
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_roles ow ON ow.oid = c.relowner
    WHERE n.nspname LIKE 'ludy\_%'
      AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
      AND ow.rolname = ANY (v_legacy_roles)
    UNION ALL
    SELECT pg_catalog.format('routine %s (owner %s)', p.oid::pg_catalog.regprocedure::text, ow.rolname)
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_catalog.pg_roles ow ON ow.oid = p.proowner
    WHERE n.nspname LIKE 'ludy\_%'
      AND ow.rolname = ANY (v_legacy_roles)
    UNION ALL
    SELECT pg_catalog.format('type %I.%I (owner %s)', n.nspname, t.typname, ow.rolname)
    FROM pg_catalog.pg_type t
    JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
    JOIN pg_catalog.pg_roles ow ON ow.oid = t.typowner
    WHERE n.nspname LIKE 'ludy\_%'
      AND (
        t.typrelid = 0
        OR EXISTS (SELECT 1 FROM pg_catalog.pg_class rc WHERE rc.oid = t.typrelid AND rc.relkind = 'c')
      )
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_type elem WHERE elem.typarray = t.oid)
      AND ow.rolname = ANY (v_legacy_roles)
  ) owned_rows;
  IF v_owned IS NOT NULL THEN
    RAISE EXCEPTION
      'stage 7 contraction failed: legacy crove_* role still owns ludy_* objects (%): reassign ownership to a canonical ludy_* or database owner role before retrying',
      v_owned;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Contract legacy crove_* / crove.* compatibility branches in ludy_kernel
--    functions while preserving exact function ACLs and search_path pinning.
-- ---------------------------------------------------------------------------
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
                  'ludy_tenant', 'ludy_app', 'ludy_worker', 'ludy_prober', 'ludy_reporter', 'ludy_auth_reader', 'ludy_definer_tenant', 'ludy_definer_system', 'ludy_definer_einvoice'
                ])
              OR COALESCE(v_role, '') = ANY (ARRAY[
                  'ludy_tenant', 'ludy_app', 'ludy_worker', 'ludy_prober', 'ludy_reporter', 'ludy_auth_reader', 'ludy_definer_tenant', 'ludy_definer_system', 'ludy_definer_einvoice'
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
            AND (d.schema_name LIKE 'ludy\_%'
                 OR (d.object_type = 'schema' AND d.object_identity LIKE 'ludy\_%')
                 OR d.object_identity LIKE 'ludy\_%.%'
                 OR d.object_identity LIKE '% on ludy\_%.%')
        ) INTO v_concerns;
      ELSE
        SELECT EXISTS (
          SELECT 1 FROM pg_catalog.pg_event_trigger_ddl_commands() c
          WHERE c.schema_name LIKE 'ludy\_%'
             OR (c.object_type = 'schema' AND c.object_identity LIKE 'ludy\_%')
             OR c.object_identity LIKE 'ludy\_%.%'
             OR c.object_identity LIKE '% on ludy\_%.%'
             OR c.object_identity LIKE '% in schema ludy\_%'
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
           OR d.schema_name LIKE 'ludy\_%'
           OR (d.object_type = 'schema' AND d.object_identity LIKE 'ludy\_%')
           OR d.object_identity LIKE 'ludy\_%.%'
           OR d.object_identity LIKE '% on ludy\_%.%');
  ELSE
    INSERT INTO ludy_kernel.ddl_event (session_role, set_role, command_tag, object_type, schema_name, object_identity,
                                        backend_pid, backend_start, client_addr)
    SELECT SESSION_USER, v_role, c.command_tag, c.object_type, c.schema_name, pg_catalog.left(c.object_identity, 500),
           pg_catalog.pg_backend_pid(), v_start, pg_catalog.inet_client_addr()
    FROM pg_catalog.pg_event_trigger_ddl_commands() c
    WHERE c.schema_name IS DISTINCT FROM 'pg_temp' AND NOT c.in_extension
      AND NOT (v_auth_admin AND c.schema_name IS NOT DISTINCT FROM 'auth')
      AND (NOT v_shared OR v_ludy_role
           OR c.schema_name LIKE 'ludy\_%'
           OR (c.object_type = 'schema' AND c.object_identity LIKE 'ludy\_%')
           OR c.object_identity LIKE 'ludy\_%.%'
           OR c.object_identity LIKE '% on ludy\_%.%'
           OR c.object_identity LIKE '% in schema ludy\_%');
  END IF;
END $$;
REVOKE ALL ON FUNCTION ludy_kernel.ddl_watch() FROM PUBLIC;

CREATE OR REPLACE FUNCTION ludy_kernel.ctx_verified()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_ctx text := nullif(pg_catalog.current_setting('ludy.ctx', true), '');
  v_seal text := nullif(pg_catalog.current_setting('ludy.ctx_seal', true), '');
BEGIN
  IF v_ctx IS NULL AND v_seal IS NULL THEN
    RETURN NULL;
  END IF;
  IF v_ctx IS NULL OR v_seal IS NULL OR v_seal IS DISTINCT FROM ludy_kernel.ctx_mac(v_ctx) THEN
    RAISE EXCEPTION 'CONTEXT_SEAL_INVALID' USING ERRCODE = '42501';
  END IF;
  RETURN v_ctx::jsonb;
END $$;
REVOKE ALL ON FUNCTION ludy_kernel.ctx_verified() FROM PUBLIC;

CREATE OR REPLACE FUNCTION ludy_kernel.context_reentry_guard()
RETURNS void LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  c_namespace constant int := 1280656473;
  v_pid int := pg_catalog.pg_backend_pid();
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_locks l
    WHERE l.locktype = 'advisory'
      AND l.classid = c_namespace::oid
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
     OR nullif(pg_catalog.current_setting('ludy.user_id', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'CONTEXT_REENTRY' USING ERRCODE = '42501';
  END IF;
  IF NOT pg_catalog.pg_try_advisory_xact_lock(c_namespace, v_pid) THEN
    RAISE EXCEPTION 'CONTEXT_REENTRY' USING ERRCODE = '42501';
  END IF;
END $$;
REVOKE ALL ON FUNCTION ludy_kernel.context_reentry_guard() FROM PUBLIC;

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
    COALESCE(pg_catalog.current_setting('ludy.prober_modules', true), ''),
    ','
  );
BEGIN
  checked_at := pg_catalog.now();

  SELECT pg_catalog.count(*)::int INTO outbox_pending
  FROM (SELECT 1 FROM ludy_kernel.outbox_pending LIMIT 10000) s;
  SELECT EXTRACT(EPOCH FROM checked_at - p.enqueued_at)::double precision INTO outbox_oldest_age_seconds
  FROM ludy_kernel.outbox_pending p
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
        AND (v_worked IS NULL OR pg_catalog.split_part(j.name, '-', 1) <> ALL (ARRAY['finance', 'social', 'ads', 'crm', 'notes', 'meetings', 'sign', 'hr'])
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
GRANT EXECUTE ON FUNCTION ludy_kernel.health(integer) TO ludy_prober;

CREATE OR REPLACE FUNCTION ludy_kernel.create_or_replay_org(p_user_id uuid, p_slug text, p_name text, p_idempotency_key text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid;
  v_slug text := p_slug;
  v_per_day_raw text := NULLIF(pg_catalog.current_setting('ludy.org_create_limit_per_day', true), '');
  v_total_raw text := NULLIF(pg_catalog.current_setting('ludy.org_create_limit_total', true), '');
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
GRANT EXECUTE ON FUNCTION ludy_kernel.create_or_replay_org(uuid, text, text, text) TO ludy_app;

CREATE OR REPLACE FUNCTION ludy_kernel.inbound_rotate()
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_user uuid := ludy_kernel.ctx_user_id();
  v_per_day_raw text := NULLIF(pg_catalog.current_setting('ludy.inbound_rotate_limit_per_day', true), '');
  v_total_raw text := NULLIF(pg_catalog.current_setting('ludy.inbound_rotate_limit_total', true), '');
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
GRANT EXECUTE ON FUNCTION ludy_kernel.inbound_rotate() TO ludy_app;

CREATE OR REPLACE FUNCTION ludy_kernel.conversation_address_rotate()
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_user uuid := ludy_kernel.ctx_user_id();
  v_per_day_raw text := NULLIF(pg_catalog.current_setting('ludy.inbound_rotate_limit_per_day', true), '');
  v_total_raw text := NULLIF(pg_catalog.current_setting('ludy.inbound_rotate_limit_total', true), '');
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
GRANT EXECUTE ON FUNCTION ludy_kernel.conversation_address_rotate() TO ludy_app;

-- ---------------------------------------------------------------------------
-- 3. Remove remaining crove_reporter / crove_tenant compatibility branches
--    introduced during the 20270315090000 function rewrites while preserving
--    exact owners, volatility, and grants.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_proc regprocedure;
  v_def text;
  v_new_def text;
BEGIN
  v_proc := pg_catalog.to_regprocedure('ludy_kernel.usage_weekly(integer, boolean, text)');
  IF v_proc IS NOT NULL THEN
    v_def := pg_catalog.pg_get_functiondef(v_proc);
    v_new_def := pg_catalog.replace(
      v_def,
      'IF NOT (pg_catalog.pg_has_role(SESSION_USER, ''ludy_reporter'', ''MEMBER'') OR pg_catalog.pg_has_role(SESSION_USER, ''crove_reporter'', ''MEMBER'')) THEN',
      'IF NOT pg_catalog.pg_has_role(SESSION_USER, ''ludy_reporter'', ''MEMBER'') THEN'
    );
    IF v_new_def IS DISTINCT FROM v_def THEN
      EXECUTE v_new_def;
    END IF;
  END IF;

  v_proc := pg_catalog.to_regprocedure('ludy_kernel.member_has_permission(uuid, uuid, text)');
  IF v_proc IS NOT NULL THEN
    v_def := pg_catalog.pg_get_functiondef(v_proc);
    v_new_def := pg_catalog.replace(
      v_def,
      'IF (current_user = session_user OR current_user IN (''ludy_tenant'', ''crove_tenant''))',
      'IF (current_user = session_user OR current_user = ''ludy_tenant'')'
    );
    IF v_new_def IS DISTINCT FROM v_def THEN
      EXECUTE v_new_def;
    END IF;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Record an explicit cluster-wide Stage 7 marker inside this transaction so
--    20270315090000 replays never misinterpret single-role expiration before
--    Stage 7 commits or lose cluster contraction status after single-role drift.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_marker constant text := 'ludy:stage7-contracted';
  v_role_oid oid;
BEGIN
  SELECT oid INTO v_role_oid FROM pg_catalog.pg_roles WHERE rolname = 'crove_tenant';
  IF v_role_oid IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = current_user AND rolsuper)
       OR (
         EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = current_user AND rolcreaterole)
         AND pg_catalog.pg_has_role(current_user, 'crove_tenant', 'MEMBER WITH ADMIN OPTION')
       ) THEN
      COMMENT ON ROLE crove_tenant IS 'ludy:stage7-contracted';
    ELSIF pg_catalog.shobj_description(v_role_oid, 'pg_authid') IS DISTINCT FROM v_marker THEN
      RAISE EXCEPTION
        'stage 7 contraction failed: role % cannot record cluster Stage 7 marker on crove_tenant (requires superuser or CREATEROLE with ADMIN OPTION on crove_tenant); run COMMENT ON ROLE crove_tenant IS ''%'' as the role owner or superuser before retrying',
        current_user, v_marker;
    END IF;
  END IF;
END $$;
