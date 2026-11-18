-- SPDX-License-Identifier: AGPL-3.0-only
-- Notes v2 E3 (#3562, docs/plan/notes-v2.md section 3.1 and 3.4, ADR-0037): quick note templates
-- (crove_notes.note_template, private to their author or shared with the org) and rolling 20-snapshot
-- note version history (crove_notes.note_version, inheriting parent crove_notes.note visibility).
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- crove_notes.note_template
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS crove_notes.note_template (
  org_id         uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id             uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  author_user_id uuid NOT NULL,
  visibility     text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'org')),
  name           text NOT NULL CHECK (pg_catalog.btrim(name) <> '' AND pg_catalog.char_length(name) <= 120),
  title          text NOT NULL DEFAULT '' CHECK (pg_catalog.char_length(title) <= 200),
  body           text NOT NULL DEFAULT '' CHECK (pg_catalog.char_length(body) <= 100000),
  tags           text[] NOT NULL DEFAULT '{}'::text[] CHECK (pg_catalog.cardinality(tags) <= 20),
  revision       integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id)
);

CREATE INDEX IF NOT EXISTS note_template_author_idx
  ON crove_notes.note_template (org_id, author_user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS note_template_visibility_idx
  ON crove_notes.note_template (org_id, visibility, updated_at DESC);

SELECT crove_kernel.apply_tenant_rls('crove_notes.note_template');

REVOKE ALL ON crove_notes.note_template FROM PUBLIC, crove_worker, crove_app, crove_definer_tenant;
REVOKE UPDATE ON crove_notes.note_template FROM crove_tenant;
GRANT SELECT, INSERT, DELETE ON crove_notes.note_template TO crove_tenant;
GRANT UPDATE (visibility, name, title, body, tags, revision, updated_at)
  ON crove_notes.note_template TO crove_tenant;

-- Private templates are read only by their author in a user context; shared ('org') templates are read by whole-org
-- active owners, admins and members, and by the system context for org offboarding export. Viewers, scoped members
-- and all agent contexts (including member_vy) read 0 rows unless they are the author in a user context.
DROP POLICY IF EXISTS note_template_read ON crove_notes.note_template;
CREATE POLICY note_template_read ON crove_notes.note_template AS RESTRICTIVE FOR SELECT TO crove_tenant
  USING (
    (SELECT crove_kernel.ctx_agent_id()) IS NULL
    AND (
      author_user_id = (SELECT crove_kernel.ctx_user_id())
      OR (
        visibility = 'org'
        AND (
          (SELECT crove_kernel.ctx_user_id()) IS NULL
          OR (
            '*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[])
            AND EXISTS (
              SELECT 1 FROM crove_kernel.tenant_member m
               WHERE m.org_id = note_template.org_id
                 AND m.user_id = (SELECT crove_kernel.ctx_user_id())
                 AND m.role IN ('owner', 'admin', 'member')
            )
          )
        )
      )
    )
  );

DROP POLICY IF EXISTS note_template_insert ON crove_notes.note_template;
CREATE POLICY note_template_insert ON crove_notes.note_template AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK (
    (SELECT crove_kernel.ctx_agent_id()) IS NULL
    AND author_user_id = (SELECT crove_kernel.ctx_user_id())
    AND EXISTS (
      SELECT 1 FROM crove_kernel.tenant_member m
       WHERE m.org_id = note_template.org_id
         AND m.user_id = (SELECT crove_kernel.ctx_user_id())
         AND m.role IN ('owner', 'admin', 'member')
    )
  );

DROP POLICY IF EXISTS note_template_update ON crove_notes.note_template;
CREATE POLICY note_template_update ON crove_notes.note_template AS RESTRICTIVE FOR UPDATE TO crove_tenant
  USING (
    (SELECT crove_kernel.ctx_agent_id()) IS NULL
    AND (
      (
        author_user_id = (SELECT crove_kernel.ctx_user_id())
        AND EXISTS (
          SELECT 1 FROM crove_kernel.tenant_member m
           WHERE m.org_id = note_template.org_id
             AND m.user_id = (SELECT crove_kernel.ctx_user_id())
             AND m.role IN ('owner', 'admin', 'member')
        )
      )
      OR (
        visibility = 'org'
        AND '*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[])
        AND EXISTS (
          SELECT 1 FROM crove_kernel.tenant_member m
           WHERE m.org_id = note_template.org_id
             AND m.user_id = (SELECT crove_kernel.ctx_user_id())
             AND m.role IN ('owner', 'admin')
        )
      )
    )
  )
  WITH CHECK (
    (SELECT crove_kernel.ctx_agent_id()) IS NULL
    AND (
      (
        author_user_id = (SELECT crove_kernel.ctx_user_id())
        AND EXISTS (
          SELECT 1 FROM crove_kernel.tenant_member m
           WHERE m.org_id = note_template.org_id
             AND m.user_id = (SELECT crove_kernel.ctx_user_id())
             AND m.role IN ('owner', 'admin', 'member')
        )
      )
      OR (
        visibility = 'org'
        AND '*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[])
        AND EXISTS (
          SELECT 1 FROM crove_kernel.tenant_member m
           WHERE m.org_id = note_template.org_id
             AND m.user_id = (SELECT crove_kernel.ctx_user_id())
             AND m.role IN ('owner', 'admin')
        )
      )
    )
  );

DROP POLICY IF EXISTS note_template_delete ON crove_notes.note_template;
CREATE POLICY note_template_delete ON crove_notes.note_template AS RESTRICTIVE FOR DELETE TO crove_tenant
  USING (
    (SELECT crove_kernel.ctx_agent_id()) IS NULL
    AND (
      (
        author_user_id = (SELECT crove_kernel.ctx_user_id())
        AND EXISTS (
          SELECT 1 FROM crove_kernel.tenant_member m
           WHERE m.org_id = note_template.org_id
             AND m.user_id = (SELECT crove_kernel.ctx_user_id())
             AND m.role IN ('owner', 'admin', 'member')
        )
      )
      OR (
        visibility = 'org'
        AND '*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[])
        AND EXISTS (
          SELECT 1 FROM crove_kernel.tenant_member m
           WHERE m.org_id = note_template.org_id
             AND m.user_id = (SELECT crove_kernel.ctx_user_id())
             AND m.role IN ('owner', 'admin')
        )
      )
    )
  );

-- Stream invalidation hints scoped strictly to the template's audience (author alone when private, +shared when org).
DROP TRIGGER IF EXISTS stream_hint ON crove_notes.note_template;
CREATE TRIGGER stream_hint AFTER INSERT OR UPDATE ON crove_notes.note_template
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.stream_notify('note', 'id');
DROP TRIGGER IF EXISTS stream_hint_delete ON crove_notes.note_template;
CREATE TRIGGER stream_hint_delete AFTER DELETE ON crove_notes.note_template
  REFERENCING OLD TABLE AS gone
  FOR EACH STATEMENT EXECUTE FUNCTION crove_notes.stream_notify_deleted('note', 'id');

-- ---------------------------------------------------------------------------
-- crove_notes.note_version (rolling 20-snapshot history per note)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS crove_notes.note_version (
  org_id         uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id             uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  note_id        uuid NOT NULL,
  author_user_id uuid NOT NULL,
  revision       integer NOT NULL CHECK (revision >= 1),
  title          text NOT NULL DEFAULT '' CHECK (pg_catalog.char_length(title) <= 200),
  body           text NOT NULL DEFAULT '' CHECK (pg_catalog.char_length(body) <= 100000),
  tags           text[] NOT NULL DEFAULT '{}'::text[] CHECK (pg_catalog.cardinality(tags) <= 20),
  tainted        boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT note_version_note_fk
    FOREIGN KEY (org_id, note_id) REFERENCES crove_notes.note (org_id, id) ON DELETE CASCADE,
  CONSTRAINT note_version_note_revision_uq
    UNIQUE (org_id, note_id, revision)
);

CREATE INDEX IF NOT EXISTS note_version_lookup_idx
  ON crove_notes.note_version (org_id, note_id, revision DESC, id DESC);

SELECT crove_kernel.apply_tenant_rls('crove_notes.note_version');

REVOKE ALL ON crove_notes.note_version FROM PUBLIC, crove_worker, crove_app, crove_definer_tenant;
REVOKE UPDATE ON crove_notes.note_version FROM crove_tenant;
GRANT SELECT, INSERT, DELETE ON crove_notes.note_version TO crove_tenant;

DROP POLICY IF EXISTS note_version_read ON crove_notes.note_version;
CREATE POLICY note_version_read ON crove_notes.note_version AS RESTRICTIVE FOR SELECT TO crove_tenant
  USING (
    (SELECT crove_kernel.ctx_agent_id()) IS NULL
    AND EXISTS (
      SELECT 1 FROM crove_notes.note n
       WHERE n.org_id = note_version.org_id
         AND n.id = note_version.note_id
    )
  );

DROP POLICY IF EXISTS note_version_insert ON crove_notes.note_version;
CREATE POLICY note_version_insert ON crove_notes.note_version AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK (
    (SELECT crove_kernel.ctx_agent_id()) IS NULL
    AND author_user_id = (SELECT crove_kernel.ctx_user_id())
    AND EXISTS (
      SELECT 1 FROM crove_kernel.tenant_member m
       WHERE m.org_id = note_version.org_id
         AND m.user_id = (SELECT crove_kernel.ctx_user_id())
         AND m.role IN ('owner', 'admin', 'member')
    )
    AND EXISTS (
      SELECT 1 FROM crove_notes.note n
       WHERE n.org_id = note_version.org_id
         AND n.id = note_version.note_id
         AND n.author_user_id = (SELECT crove_kernel.ctx_user_id())
    )
  );

DROP POLICY IF EXISTS note_version_delete ON crove_notes.note_version;
CREATE POLICY note_version_delete ON crove_notes.note_version AS RESTRICTIVE FOR DELETE TO crove_tenant
  USING (
    (SELECT crove_kernel.ctx_agent_id()) IS NULL
    AND EXISTS (
      SELECT 1 FROM crove_notes.note n
       WHERE n.org_id = note_version.org_id
         AND n.id = note_version.note_id
         AND (
           (
             n.author_user_id = (SELECT crove_kernel.ctx_user_id())
             AND EXISTS (
               SELECT 1 FROM crove_kernel.tenant_member m
                WHERE m.org_id = note_version.org_id
                  AND m.user_id = (SELECT crove_kernel.ctx_user_id())
                  AND m.role IN ('owner', 'admin', 'member')
             )
           )
           OR (
             n.visibility = 'org'
             AND '*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[])
             AND EXISTS (
               SELECT 1 FROM crove_kernel.tenant_member m
                WHERE m.org_id = note_version.org_id
                  AND m.user_id = (SELECT crove_kernel.ctx_user_id())
                  AND m.role IN ('owner', 'admin')
             )
           )
         )
    )
  );

-- Automatic 20-snapshot retention per note: keeps at most the newest 20 revisions per (org_id, note_id).
CREATE OR REPLACE FUNCTION crove_notes.note_version_prune() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  DELETE FROM crove_notes.note_version v
   WHERE v.org_id = NEW.org_id
     AND v.note_id = NEW.note_id
     AND v.id IN (
       SELECT old.id
         FROM crove_notes.note_version old
        WHERE old.org_id = NEW.org_id
          AND old.note_id = NEW.note_id
        ORDER BY old.revision DESC, old.created_at DESC, old.id DESC
        OFFSET 20
     );
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION crove_notes.note_version_prune() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

DROP TRIGGER IF EXISTS a_prune_versions ON crove_notes.note_version;
CREATE TRIGGER a_prune_versions AFTER INSERT ON crove_notes.note_version
  FOR EACH ROW EXECUTE FUNCTION crove_notes.note_version_prune();

-- ---------------------------------------------------------------------------
-- Offboarding counts, former-member purge, and PDPL definers
-- ---------------------------------------------------------------------------

-- Counts private templates per author (never text), for owners, admins and the org export's system context.
CREATE OR REPLACE FUNCTION crove_notes.private_template_counts()
RETURNS TABLE (org_id uuid, author_user_id uuid, templates bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'NOTES_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF crove_kernel.ctx_actor_type() = 'system' THEN
    IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
      RAISE EXCEPTION 'NOTES_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
  ELSIF crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' OR NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m
    WHERE m.org_id = v_org AND m.user_id = crove_kernel.ctx_user_id() AND m.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'NOTES_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT tpl.org_id, tpl.author_user_id, pg_catalog.count(*)
    FROM crove_notes.note_template tpl
    WHERE tpl.org_id = v_org AND tpl.visibility = 'private'
    GROUP BY tpl.org_id, tpl.author_user_id
    ORDER BY tpl.author_user_id;
END $$;
REVOKE ALL ON FUNCTION crove_notes.private_template_counts() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_notes.private_template_counts() TO crove_tenant;

CREATE OR REPLACE FUNCTION crove_notes.former_members_due(p_limit integer)
RETURNS TABLE (org_id uuid, user_id uuid, recorded boolean) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') OR crove_kernel.ctx_actor_type() IS NOT NULL THEN
    RAISE EXCEPTION 'NOTES_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT f.org_id, f.user_id, f.recorded FROM (
      SELECT d.org_id, d.user_id, EXISTS (
          SELECT 1 FROM crove_kernel.audit_event a
          WHERE a.org_id = d.org_id AND a.command = 'kernel.member.remove' AND a.outcome = 'ok' AND a.target_id = d.user_id
        ) AS recorded
      FROM (
          SELECT n.org_id, n.author_user_id AS user_id FROM crove_notes.note n WHERE n.visibility = 'private'
          UNION
          SELECT tpl.org_id, tpl.author_user_id FROM crove_notes.note_template tpl WHERE tpl.visibility = 'private'
          UNION
          SELECT t.org_id, t.owner_user_id FROM crove_notes.todo t
          UNION
          SELECT l.org_id, l.owner_user_id FROM crove_notes.todo_list l
        ) AS d
      WHERE NOT EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = d.org_id AND m.user_id = d.user_id)
        AND NOT EXISTS (
          SELECT 1 FROM crove_kernel.audit_event a
          WHERE a.org_id = d.org_id AND a.occurred_at > pg_catalog.now() - interval '30 days'
            AND a.command = 'kernel.member.remove' AND a.outcome = 'ok' AND a.target_id = d.user_id)) AS f
    ORDER BY f.recorded DESC, f.org_id, f.user_id LIMIT LEAST(GREATEST(p_limit, 1), 1000);
END $$;
REVOKE ALL ON FUNCTION crove_notes.former_members_due(integer) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_notes.former_members_due(integer) TO crove_worker;

CREATE OR REPLACE FUNCTION crove_notes.member_items_purge(p_user uuid)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_n bigint;
  v_tpl bigint;
  v_t bigint;
  v_l bigint;
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'NOTES_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF v_org IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'system' THEN
    RAISE EXCEPTION 'NOTES_SYSTEM_CONTEXT' USING ERRCODE = '42501';
  END IF;
  PERFORM crove_kernel.membership_lock(v_org, p_user);
  IF EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = v_org AND m.user_id = p_user) THEN
    RETURN 0;
  END IF;
  IF EXISTS (
    SELECT 1 FROM crove_kernel.audit_event a
    WHERE a.org_id = v_org AND a.occurred_at > pg_catalog.now() - interval '30 days'
      AND a.command = 'kernel.member.remove' AND a.outcome = 'ok' AND a.target_id = p_user
  ) THEN
    RETURN 0;
  END IF;
  DELETE FROM crove_notes.todo t WHERE t.org_id = v_org AND t.owner_user_id = p_user;
  GET DIAGNOSTICS v_t = ROW_COUNT;
  DELETE FROM crove_notes.todo_list l WHERE l.org_id = v_org AND l.owner_user_id = p_user;
  GET DIAGNOSTICS v_l = ROW_COUNT;
  -- Deleting private notes cascades their crove_notes.note_version snapshots via note_version_note_fk.
  DELETE FROM crove_notes.note n WHERE n.org_id = v_org AND n.author_user_id = p_user AND n.visibility = 'private';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  DELETE FROM crove_notes.note_template tpl WHERE tpl.org_id = v_org AND tpl.author_user_id = p_user AND tpl.visibility = 'private';
  GET DIAGNOSTICS v_tpl = ROW_COUNT;
  RETURN v_n + v_tpl + v_t + v_l;
END $$;
REVOKE ALL ON FUNCTION crove_notes.member_items_purge(uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_notes.member_items_purge(uuid) TO crove_worker;

CREATE OR REPLACE FUNCTION crove_notes.private_matches(p_kind text, p_value text)
RETURNS TABLE (author_user_id uuid, notes bigint, todos bigint) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
BEGIN
  IF v_org IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' OR NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m
    WHERE m.org_id = v_org AND m.user_id = crove_kernel.ctx_user_id() AND m.role = 'owner'
  ) THEN
    RAISE EXCEPTION 'NOTES_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  PERFORM crove_kernel.text_mention_pattern(p_kind, p_value);
  RETURN QUERY
    WITH found AS (
      SELECT n.author_user_id AS author, 1 AS note, 0 AS todo
        FROM crove_notes.note n
       WHERE n.org_id = v_org AND n.visibility = 'private'
         AND (crove_kernel.text_mentions(n.title, p_kind, p_value)
              OR crove_kernel.text_mentions(n.body, p_kind, p_value)
              OR crove_kernel.text_mentions(pg_catalog.array_to_string(n.tags, ' '), p_kind, p_value)
              OR EXISTS (
                SELECT 1 FROM crove_notes.note_version v
                 WHERE v.org_id = n.org_id AND v.note_id = n.id
                   AND (crove_kernel.text_mentions(v.title, p_kind, p_value)
                        OR crove_kernel.text_mentions(v.body, p_kind, p_value)
                        OR crove_kernel.text_mentions(pg_catalog.array_to_string(v.tags, ' '), p_kind, p_value))
              ))
      UNION ALL
      SELECT tpl.author_user_id, 1, 0
        FROM crove_notes.note_template tpl
       WHERE tpl.org_id = v_org AND tpl.visibility = 'private'
         AND (crove_kernel.text_mentions(tpl.name, p_kind, p_value)
              OR crove_kernel.text_mentions(tpl.title, p_kind, p_value)
              OR crove_kernel.text_mentions(tpl.body, p_kind, p_value)
              OR crove_kernel.text_mentions(pg_catalog.array_to_string(tpl.tags, ' '), p_kind, p_value))
      UNION ALL
      SELECT t.owner_user_id, 0, 1
        FROM crove_notes.todo t
       WHERE t.org_id = v_org
         AND (crove_kernel.text_mentions(t.title, p_kind, p_value)
              OR crove_kernel.text_mentions(t.details, p_kind, p_value)
              OR crove_kernel.text_mentions(t.checklist::text, p_kind, p_value)
              OR crove_kernel.text_mentions(pg_catalog.array_to_string(t.tags, ' '), p_kind, p_value))
      UNION ALL
      SELECT l.owner_user_id, 0, 1
        FROM crove_notes.todo_list l
       WHERE l.org_id = v_org
         AND (crove_kernel.text_mentions(l.name, p_kind, p_value)
              OR EXISTS (
                SELECT 1 FROM pg_catalog.jsonb_array_elements(l.sections) AS s(sec)
                WHERE crove_kernel.text_mentions(s.sec ->> 'name', p_kind, p_value)
              ))
    )
    SELECT f.author, pg_catalog.sum(f.note)::bigint, pg_catalog.sum(f.todo)::bigint
      FROM found f
     GROUP BY f.author
     ORDER BY f.author;
END $$;
REVOKE ALL ON FUNCTION crove_notes.private_matches(text, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_notes.private_matches(text, text) TO crove_tenant;

CREATE OR REPLACE FUNCTION crove_notes.private_notice_items(p_kind text, p_value text)
RETURNS TABLE (item_type text, item_id uuid, author_user_id uuid, revision integer) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
BEGIN
  IF v_org IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' OR NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m
    WHERE m.org_id = v_org AND m.user_id = crove_kernel.ctx_user_id() AND m.role = 'owner'
  ) THEN
    RAISE EXCEPTION 'NOTES_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  PERFORM crove_kernel.text_mention_pattern(p_kind, p_value);
  RETURN QUERY
    SELECT 'note'::text, n.id, n.author_user_id, n.revision
      FROM crove_notes.note n
     WHERE n.org_id = v_org AND n.visibility = 'private'
       AND (crove_kernel.text_mentions(n.title, p_kind, p_value)
            OR crove_kernel.text_mentions(n.body, p_kind, p_value)
            OR crove_kernel.text_mentions(pg_catalog.array_to_string(n.tags, ' '), p_kind, p_value)
            OR EXISTS (
              SELECT 1 FROM crove_notes.note_version v
               WHERE v.org_id = n.org_id AND v.note_id = n.id
                 AND (crove_kernel.text_mentions(v.title, p_kind, p_value)
                      OR crove_kernel.text_mentions(v.body, p_kind, p_value)
                      OR crove_kernel.text_mentions(pg_catalog.array_to_string(v.tags, ' '), p_kind, p_value))
            ))
    UNION ALL
    SELECT 'note_template'::text, tpl.id, tpl.author_user_id, tpl.revision
      FROM crove_notes.note_template tpl
     WHERE tpl.org_id = v_org AND tpl.visibility = 'private'
       AND (crove_kernel.text_mentions(tpl.name, p_kind, p_value)
            OR crove_kernel.text_mentions(tpl.title, p_kind, p_value)
            OR crove_kernel.text_mentions(tpl.body, p_kind, p_value)
            OR crove_kernel.text_mentions(pg_catalog.array_to_string(tpl.tags, ' '), p_kind, p_value))
    UNION ALL
    SELECT 'todo'::text, t.id, t.owner_user_id, t.revision
      FROM crove_notes.todo t
     WHERE t.org_id = v_org
       AND (crove_kernel.text_mentions(t.title, p_kind, p_value)
            OR crove_kernel.text_mentions(t.details, p_kind, p_value)
            OR crove_kernel.text_mentions(t.checklist::text, p_kind, p_value)
            OR crove_kernel.text_mentions(pg_catalog.array_to_string(t.tags, ' '), p_kind, p_value))
    UNION ALL
    SELECT 'todo_list'::text, l.id, l.owner_user_id, l.revision
      FROM crove_notes.todo_list l
     WHERE l.org_id = v_org
       AND (crove_kernel.text_mentions(l.name, p_kind, p_value)
            OR EXISTS (
              SELECT 1 FROM pg_catalog.jsonb_array_elements(l.sections) AS s(sec)
              WHERE crove_kernel.text_mentions(s.sec ->> 'name', p_kind, p_value)
            ))
    ORDER BY 1, 2;
END $$;
REVOKE ALL ON FUNCTION crove_notes.private_notice_items(text, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_notes.private_notice_items(text, text) TO crove_tenant;

CREATE OR REPLACE FUNCTION crove_notes.private_erase(p_kind text, p_value text)
RETURNS TABLE (author_user_id uuid, notes bigint, todos bigint, untold_notes bigint, untold_todos bigint, note_ids uuid[], todo_ids uuid[])
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_key text;
  v_items jsonb := '[]'::jsonb;
  v_templates jsonb := '[]'::jsonb;
  v_lists jsonb := '[]'::jsonb;
BEGIN
  IF v_org IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' OR NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m
    WHERE m.org_id = v_org AND m.user_id = crove_kernel.ctx_user_id() AND m.role = 'owner'
  ) THEN
    RAISE EXCEPTION 'NOTES_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  PERFORM crove_kernel.text_mention_pattern(p_kind, p_value);
  v_key := crove_notes.private_notice_key_of(v_org, p_kind, p_value);

  -- Global lock DAG: note[id ASC] -> note_template[id ASC] -> todo_list[id ASC] -> todo[id ASC] before any DELETE.
  PERFORM n.id
    FROM crove_notes.note n
   WHERE n.org_id = v_org AND n.visibility = 'private'
     AND (
       crove_kernel.text_mentions(n.title, p_kind, p_value)
       OR crove_kernel.text_mentions(n.body, p_kind, p_value)
       OR crove_kernel.text_mentions(pg_catalog.array_to_string(n.tags, ' '), p_kind, p_value)
       OR EXISTS (
         SELECT 1 FROM crove_notes.note_version v
          WHERE v.org_id = n.org_id AND v.note_id = n.id
            AND (crove_kernel.text_mentions(v.title, p_kind, p_value)
                 OR crove_kernel.text_mentions(v.body, p_kind, p_value)
                 OR crove_kernel.text_mentions(pg_catalog.array_to_string(v.tags, ' '), p_kind, p_value))
       )
     )
   ORDER BY n.id
   FOR UPDATE;

  PERFORM tpl.id
    FROM crove_notes.note_template tpl
   WHERE tpl.org_id = v_org AND tpl.visibility = 'private'
     AND (
       crove_kernel.text_mentions(tpl.name, p_kind, p_value)
       OR crove_kernel.text_mentions(tpl.title, p_kind, p_value)
       OR crove_kernel.text_mentions(tpl.body, p_kind, p_value)
       OR crove_kernel.text_mentions(pg_catalog.array_to_string(tpl.tags, ' '), p_kind, p_value)
     )
   ORDER BY tpl.id
   FOR UPDATE;

  PERFORM l.id
    FROM crove_notes.todo_list l
   WHERE l.org_id = v_org
     AND (
       crove_kernel.text_mentions(l.name, p_kind, p_value)
       OR EXISTS (
         SELECT 1 FROM pg_catalog.jsonb_array_elements(l.sections) AS s(sec)
         WHERE crove_kernel.text_mentions(s.sec ->> 'name', p_kind, p_value)
       )
       OR EXISTS (
         SELECT 1 FROM crove_notes.todo t
          WHERE t.org_id = v_org AND t.list_id = l.id
            AND (crove_kernel.text_mentions(t.title, p_kind, p_value)
                 OR crove_kernel.text_mentions(t.details, p_kind, p_value)
                 OR crove_kernel.text_mentions(t.checklist::text, p_kind, p_value)
                 OR crove_kernel.text_mentions(pg_catalog.array_to_string(t.tags, ' '), p_kind, p_value))
       )
     )
   ORDER BY l.id
   FOR UPDATE;

  PERFORM t.id
    FROM crove_notes.todo t
   WHERE t.org_id = v_org
     AND (
       crove_kernel.text_mentions(t.title, p_kind, p_value)
       OR crove_kernel.text_mentions(t.details, p_kind, p_value)
       OR crove_kernel.text_mentions(t.checklist::text, p_kind, p_value)
       OR crove_kernel.text_mentions(pg_catalog.array_to_string(t.tags, ' '), p_kind, p_value)
       OR EXISTS (
         SELECT 1 FROM crove_notes.todo_list l
          WHERE l.org_id = v_org AND l.id = t.list_id
            AND (crove_kernel.text_mentions(l.name, p_kind, p_value)
                 OR EXISTS (
                   SELECT 1 FROM pg_catalog.jsonb_array_elements(l.sections) AS s(sec)
                   WHERE crove_kernel.text_mentions(s.sec ->> 'name', p_kind, p_value)
                 ))
       )
     )
   ORDER BY t.id
   FOR UPDATE;

  -- Erase matched private notes (cascading their note_version snapshots), or erase matching note_version snapshots
  -- when the live note itself no longer mentions the value, alongside matched todos.
  WITH told AS (
    SELECT a.detail, a.actor_id FROM crove_kernel.audit_event a
     WHERE a.org_id = v_org AND a.command = 'kernel.personal_data.notify' AND a.outcome = 'ok'
       AND a.occurred_at <= pg_catalog.now() - interval '24 hours'
       AND pg_catalog.jsonb_typeof(a.detail) = 'object' AND a.detail ->> 'key' = v_key
  ),
  note_found AS (
    SELECT n.id, n.revision, n.author_user_id AS author,
           (crove_kernel.text_mentions(n.title, p_kind, p_value)
            OR crove_kernel.text_mentions(n.body, p_kind, p_value)
            OR crove_kernel.text_mentions(pg_catalog.array_to_string(n.tags, ' '), p_kind, p_value)) AS live_mentions,
           EXISTS (SELECT 1 FROM told
                    WHERE pg_catalog.jsonb_typeof(told.detail -> 'notes') = 'array' AND (told.detail -> 'notes') ? (n.id::text || ':' || n.revision::text)
                      AND crove_notes.private_notice_told(v_org, n.author_user_id, told.actor_id, told.detail ->> 'event')) AS named
      FROM crove_notes.note n
     WHERE n.org_id = v_org AND n.visibility = 'private'
       AND (crove_kernel.text_mentions(n.title, p_kind, p_value)
            OR crove_kernel.text_mentions(n.body, p_kind, p_value)
            OR crove_kernel.text_mentions(pg_catalog.array_to_string(n.tags, ' '), p_kind, p_value)
            OR EXISTS (
              SELECT 1 FROM crove_notes.note_version v
               WHERE v.org_id = n.org_id AND v.note_id = n.id
                 AND (crove_kernel.text_mentions(v.title, p_kind, p_value)
                      OR crove_kernel.text_mentions(v.body, p_kind, p_value)
                      OR crove_kernel.text_mentions(pg_catalog.array_to_string(v.tags, ' '), p_kind, p_value))
            ))
  ),
  todo_found AS (
    SELECT t.id, t.revision, t.owner_user_id AS author,
           EXISTS (SELECT 1 FROM told
                    WHERE pg_catalog.jsonb_typeof(told.detail -> 'todos') = 'array' AND (told.detail -> 'todos') ? (t.id::text || ':' || t.revision::text)
                      AND crove_notes.private_notice_told(v_org, t.owner_user_id, told.actor_id, told.detail ->> 'event')) AS named
      FROM crove_notes.todo t
     WHERE t.org_id = v_org
       AND (crove_kernel.text_mentions(t.title, p_kind, p_value)
            OR crove_kernel.text_mentions(t.details, p_kind, p_value)
            OR crove_kernel.text_mentions(t.checklist::text, p_kind, p_value)
            OR crove_kernel.text_mentions(pg_catalog.array_to_string(t.tags, ' '), p_kind, p_value))
  ),
  note_gone AS (
    DELETE FROM crove_notes.note n USING note_found f
     WHERE n.org_id = v_org AND n.id = f.id AND n.revision = f.revision AND f.named AND f.live_mentions
    RETURNING n.id, f.author
  ),
  version_only_gone AS (
    DELETE FROM crove_notes.note_version v USING note_found f
     WHERE v.org_id = v_org AND v.note_id = f.id AND f.named AND NOT f.live_mentions
       AND EXISTS (SELECT 1 FROM crove_notes.note n WHERE n.org_id = v_org AND n.id = f.id AND n.revision = f.revision)
       AND (crove_kernel.text_mentions(v.title, p_kind, p_value)
            OR crove_kernel.text_mentions(v.body, p_kind, p_value)
            OR crove_kernel.text_mentions(pg_catalog.array_to_string(v.tags, ' '), p_kind, p_value))
    RETURNING f.id, f.author
  ),
  note_erased AS (
    SELECT g.id, g.author FROM note_gone g
    UNION
    SELECT vg.id, vg.author FROM version_only_gone vg
  ),
  todo_gone AS (
    DELETE FROM crove_notes.todo t USING todo_found f
     WHERE t.org_id = v_org AND t.id = f.id AND t.revision = f.revision AND f.named
    RETURNING t.id, f.author
  ),
  counted AS (
    SELECT g.author, g.id, 'note'::text AS kind, true AS gone FROM note_erased g
    UNION ALL SELECT g.author, g.id, 'todo', true FROM todo_gone g
    UNION ALL SELECT f.author, f.id, 'note', false FROM note_found f WHERE NOT EXISTS (SELECT 1 FROM note_erased g WHERE g.id = f.id)
    UNION ALL SELECT f.author, f.id, 'todo', false FROM todo_found f WHERE NOT EXISTS (SELECT 1 FROM todo_gone g WHERE g.id = f.id)
  )
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'author', c.author, 'id', c.id, 'kind', c.kind, 'gone', c.gone
  )), '[]'::jsonb)
    INTO v_items
    FROM counted c;

  -- Erase matched private note templates in a separate statement.
  WITH told AS (
    SELECT a.detail, a.actor_id FROM crove_kernel.audit_event a
     WHERE a.org_id = v_org AND a.command = 'kernel.personal_data.notify' AND a.outcome = 'ok'
       AND a.occurred_at <= pg_catalog.now() - interval '24 hours'
       AND pg_catalog.jsonb_typeof(a.detail) = 'object' AND a.detail ->> 'key' = v_key
  ),
  tpl_found AS (
    SELECT tpl.id, tpl.revision, tpl.author_user_id AS author,
           EXISTS (SELECT 1 FROM told
                    WHERE pg_catalog.jsonb_typeof(told.detail -> 'note_templates') = 'array'
                      AND (told.detail -> 'note_templates') ? (tpl.id::text || ':' || tpl.revision::text)
                      AND crove_notes.private_notice_told(v_org, tpl.author_user_id, told.actor_id, told.detail ->> 'event')) AS named
      FROM crove_notes.note_template tpl
     WHERE tpl.org_id = v_org AND tpl.visibility = 'private'
       AND (crove_kernel.text_mentions(tpl.name, p_kind, p_value)
            OR crove_kernel.text_mentions(tpl.title, p_kind, p_value)
            OR crove_kernel.text_mentions(tpl.body, p_kind, p_value)
            OR crove_kernel.text_mentions(pg_catalog.array_to_string(tpl.tags, ' '), p_kind, p_value))
  ),
  tpl_gone AS (
    DELETE FROM crove_notes.note_template tpl USING tpl_found f
     WHERE tpl.org_id = v_org AND tpl.id = f.id AND tpl.revision = f.revision AND f.named
    RETURNING tpl.id, f.author
  ),
  tpl_counted AS (
    SELECT g.author, g.id, 'note'::text AS kind, true AS gone FROM tpl_gone g
    UNION ALL SELECT f.author, f.id, 'note', false FROM tpl_found f WHERE NOT EXISTS (SELECT 1 FROM tpl_gone g WHERE g.id = f.id)
  )
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'author', c.author, 'id', c.id, 'kind', c.kind, 'gone', c.gone
  )), '[]'::jsonb)
    INTO v_templates
    FROM tpl_counted c;

  -- Erase matched personal to-do lists in a separate statement after matching todos are already removed.
  WITH told AS (
    SELECT a.detail, a.actor_id FROM crove_kernel.audit_event a
     WHERE a.org_id = v_org AND a.command = 'kernel.personal_data.notify' AND a.outcome = 'ok'
       AND a.occurred_at <= pg_catalog.now() - interval '24 hours'
       AND pg_catalog.jsonb_typeof(a.detail) = 'object' AND a.detail ->> 'key' = v_key
  ),
  list_found AS (
    SELECT l.id, l.revision, l.owner_user_id AS author,
           EXISTS (SELECT 1 FROM told
                    WHERE pg_catalog.jsonb_typeof(told.detail -> 'todo_lists') = 'array'
                      AND (told.detail -> 'todo_lists') ? (l.id::text || ':' || l.revision::text)
                      AND crove_notes.private_notice_told(v_org, l.owner_user_id, told.actor_id, told.detail ->> 'event')) AS named
      FROM crove_notes.todo_list l
     WHERE l.org_id = v_org
       AND (crove_kernel.text_mentions(l.name, p_kind, p_value)
            OR EXISTS (
              SELECT 1 FROM pg_catalog.jsonb_array_elements(l.sections) AS s(sec)
              WHERE crove_kernel.text_mentions(s.sec ->> 'name', p_kind, p_value)
            ))
  ),
  list_gone AS (
    DELETE FROM crove_notes.todo_list l USING list_found f
     WHERE l.org_id = v_org AND l.id = f.id AND l.revision = f.revision AND f.named
    RETURNING l.id, f.author
  ),
  list_counted AS (
    SELECT g.author, g.id, 'todo'::text AS kind, true AS gone FROM list_gone g
    UNION ALL SELECT f.author, f.id, 'todo', false FROM list_found f WHERE NOT EXISTS (SELECT 1 FROM list_gone g WHERE g.id = f.id)
  )
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'author', c.author, 'id', c.id, 'kind', c.kind, 'gone', c.gone
  )), '[]'::jsonb)
    INTO v_lists
    FROM list_counted c;

  v_items := v_items || v_templates || v_lists;

  RETURN QUERY
    SELECT c.author,
           pg_catalog.count(*) FILTER (WHERE c.kind = 'note' AND c.gone),
           pg_catalog.count(*) FILTER (WHERE c.kind = 'todo' AND c.gone),
           pg_catalog.count(*) FILTER (WHERE c.kind = 'note' AND NOT c.gone),
           pg_catalog.count(*) FILTER (WHERE c.kind = 'todo' AND NOT c.gone),
           COALESCE(pg_catalog.array_agg(c.id ORDER BY c.id) FILTER (WHERE c.kind = 'note' AND c.gone), '{}'::uuid[]),
           COALESCE(pg_catalog.array_agg(c.id ORDER BY c.id) FILTER (WHERE c.kind = 'todo' AND c.gone), '{}'::uuid[])
      FROM pg_catalog.jsonb_to_recordset(v_items) AS c(author uuid, id uuid, kind text, gone boolean)
     GROUP BY c.author
     ORDER BY c.author;
END $$;
REVOKE ALL ON FUNCTION crove_notes.private_erase(text, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_notes.private_erase(text, text) TO crove_tenant;
