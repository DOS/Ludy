-- SPDX-License-Identifier: AGPL-3.0-only
-- Notes v2 E1 (#3559): notebooks and 2-level stacks (stack_name -> notebook),
-- private to their author or shared with whole-org writers (ADR-0037), plus
-- crove_notes.note.notebook_id with strict visibility and existence-oracle guards.
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- crove_notes.notebook
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS crove_notes.notebook (
  org_id         uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  author_user_id uuid NOT NULL,
  visibility     text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'org')),
  name           text NOT NULL CHECK (pg_catalog.btrim(name) <> '' AND pg_catalog.char_length(name) <= 120),
  stack_name     text CHECK (stack_name IS NULL OR (pg_catalog.btrim(stack_name) <> '' AND pg_catalog.char_length(stack_name) <= 80)),
  pinned         boolean NOT NULL DEFAULT false,
  sort_key       text COLLATE "C" NOT NULL DEFAULT 'a0' CHECK (pg_catalog.btrim(sort_key) <> '' AND pg_catalog.char_length(sort_key) <= 128 AND sort_key ~ '^[0-9A-Za-z]{1,128}$'),
  revision       integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id)
);

CREATE INDEX IF NOT EXISTS notebook_author_idx
  ON crove_notes.notebook (org_id, author_user_id, sort_key);

CREATE INDEX IF NOT EXISTS notebook_org_visibility_idx
  ON crove_notes.notebook (org_id, visibility, sort_key)
  WHERE visibility = 'org';

SELECT crove_kernel.apply_tenant_rls('crove_notes.notebook');

REVOKE ALL ON crove_notes.notebook FROM PUBLIC, crove_worker, crove_app, crove_definer_tenant;
REVOKE UPDATE ON crove_notes.notebook FROM crove_tenant;
GRANT SELECT, INSERT, DELETE ON crove_notes.notebook TO crove_tenant;
GRANT UPDATE (visibility, name, stack_name, pinned, sort_key, revision, updated_at)
  ON crove_notes.notebook TO crove_tenant;

-- Keep crove_notes.notebook out of crove_kernel.member_vy_table (MEMBER_VY_READS = false):
-- every policy enforces ctx_agent_id() IS NULL and keys user checks to ctx_user_id().
DROP POLICY IF EXISTS notebook_read ON crove_notes.notebook;
CREATE POLICY notebook_read ON crove_notes.notebook AS RESTRICTIVE FOR SELECT TO crove_tenant
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
               WHERE m.org_id = notebook.org_id
                 AND m.user_id = (SELECT crove_kernel.ctx_user_id())
                 AND m.role IN ('owner', 'admin', 'member')
            )
          )
        )
      )
    )
  );

DROP POLICY IF EXISTS notebook_insert ON crove_notes.notebook;
CREATE POLICY notebook_insert ON crove_notes.notebook AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK (
    (SELECT crove_kernel.ctx_agent_id()) IS NULL
    AND author_user_id = (SELECT crove_kernel.ctx_user_id())
    AND (visibility = 'private' OR '*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]))
    AND EXISTS (
      SELECT 1 FROM crove_kernel.tenant_member m
       WHERE m.org_id = notebook.org_id
         AND m.user_id = (SELECT crove_kernel.ctx_user_id())
         AND m.role IN ('owner', 'admin', 'member')
    )
  );

DROP POLICY IF EXISTS notebook_update ON crove_notes.notebook;
CREATE POLICY notebook_update ON crove_notes.notebook AS RESTRICTIVE FOR UPDATE TO crove_tenant
  USING (
    (SELECT crove_kernel.ctx_agent_id()) IS NULL
    AND (
      (
        author_user_id = (SELECT crove_kernel.ctx_user_id())
        AND EXISTS (
          SELECT 1 FROM crove_kernel.tenant_member m
           WHERE m.org_id = notebook.org_id
             AND m.user_id = (SELECT crove_kernel.ctx_user_id())
             AND m.role IN ('owner', 'admin', 'member')
        )
      )
      OR (
        visibility = 'org'
        AND '*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[])
        AND EXISTS (
          SELECT 1 FROM crove_kernel.tenant_member m
           WHERE m.org_id = notebook.org_id
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
        AND (visibility = 'private' OR '*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]))
        AND EXISTS (
          SELECT 1 FROM crove_kernel.tenant_member m
           WHERE m.org_id = notebook.org_id
             AND m.user_id = (SELECT crove_kernel.ctx_user_id())
             AND m.role IN ('owner', 'admin', 'member')
        )
      )
      OR (
        visibility = 'org'
        AND '*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[])
        AND EXISTS (
          SELECT 1 FROM crove_kernel.tenant_member m
           WHERE m.org_id = notebook.org_id
             AND m.user_id = (SELECT crove_kernel.ctx_user_id())
             AND m.role IN ('owner', 'admin')
        )
      )
    )
  );

DROP POLICY IF EXISTS notebook_delete ON crove_notes.notebook;
CREATE POLICY notebook_delete ON crove_notes.notebook AS RESTRICTIVE FOR DELETE TO crove_tenant
  USING (
    (SELECT crove_kernel.ctx_agent_id()) IS NULL
    AND (
      (
        author_user_id = (SELECT crove_kernel.ctx_user_id())
        AND EXISTS (
          SELECT 1 FROM crove_kernel.tenant_member m
           WHERE m.org_id = notebook.org_id
             AND m.user_id = (SELECT crove_kernel.ctx_user_id())
             AND m.role IN ('owner', 'admin', 'member')
        )
      )
      OR (
        visibility = 'org'
        AND '*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[])
        AND EXISTS (
          SELECT 1 FROM crove_kernel.tenant_member m
           WHERE m.org_id = notebook.org_id
             AND m.user_id = (SELECT crove_kernel.ctx_user_id())
             AND m.role IN ('owner', 'admin')
        )
      )
    )
  );

-- Stream hints (#69, #3559): private notebooks route only to @author_user_id;
-- shared ('org') notebooks route to @author_user_id+shared.
DROP TRIGGER IF EXISTS stream_hint ON crove_notes.notebook;
CREATE TRIGGER stream_hint AFTER INSERT OR UPDATE ON crove_notes.notebook
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.stream_notify('note', 'id');

DROP TRIGGER IF EXISTS stream_hint_delete ON crove_notes.notebook;
CREATE TRIGGER stream_hint_delete AFTER DELETE ON crove_notes.notebook
  REFERENCING OLD TABLE AS gone
  FOR EACH STATEMENT EXECUTE FUNCTION crove_notes.stream_notify_deleted('note', 'id');

-- ---------------------------------------------------------------------------
-- crove_notes.note.notebook_id and cross-visibility integrity guards
-- ---------------------------------------------------------------------------

ALTER TABLE crove_notes.note
  ADD COLUMN IF NOT EXISTS notebook_id uuid;

ALTER TABLE crove_notes.note DROP CONSTRAINT IF EXISTS note_notebook_fk;
ALTER TABLE crove_notes.note ADD CONSTRAINT note_notebook_fk
  FOREIGN KEY (org_id, notebook_id) REFERENCES crove_notes.notebook (org_id, id) ON DELETE SET NULL (notebook_id);

CREATE INDEX IF NOT EXISTS note_notebook_idx
  ON crove_notes.note (org_id, notebook_id)
  WHERE notebook_id IS NOT NULL;

GRANT UPDATE (notebook_id) ON crove_notes.note TO crove_tenant;

-- Enforce notebook accessibility with uniform 42501 refusal before visibility checks
-- so probing an unreadable private notebook_id yields zero existence oracle, and
-- refuse placing a shared ('org') note inside a 'private' notebook.
CREATE OR REPLACE FUNCTION crove_notes.note_notebook_integrity() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_vis text;
  v_author uuid;
  v_ctx_org uuid := crove_kernel.ctx_org_id();
  v_ctx_user uuid := crove_kernel.ctx_user_id();
  v_ctx_agent uuid := crove_kernel.ctx_agent_id();
  v_readable boolean;
BEGIN
  IF NEW.notebook_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT'
     OR NEW.notebook_id IS DISTINCT FROM OLD.notebook_id
     OR NEW.visibility IS DISTINCT FROM OLD.visibility
     OR NEW.author_user_id IS DISTINCT FROM OLD.author_user_id THEN
    SELECT b.visibility, b.author_user_id
      INTO v_vis, v_author
      FROM crove_notes.notebook b
     WHERE b.org_id = NEW.org_id
       AND b.id = NEW.notebook_id
       FOR SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'NOTES_NOTEBOOK_NOT_ACCESSIBLE' USING ERRCODE = '42501';
    END IF;

    IF v_ctx_org IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.notebook_id IS DISTINCT FROM OLD.notebook_id) THEN
      v_readable := v_ctx_agent IS NULL AND (
        v_author = v_ctx_user
        OR (
          v_vis = 'org'
          AND (
            v_ctx_user IS NULL
            OR (
              '*' = ANY ((crove_kernel.ctx_le_scope())::text[])
              AND EXISTS (
                SELECT 1 FROM crove_kernel.tenant_member m
                 WHERE m.org_id = NEW.org_id
                   AND m.user_id = v_ctx_user
                   AND m.role IN ('owner', 'admin', 'member')
              )
            )
          )
        )
      );
      IF NOT v_readable THEN
        RAISE EXCEPTION 'NOTES_NOTEBOOK_NOT_ACCESSIBLE' USING ERRCODE = '42501';
      END IF;
    END IF;

    IF v_vis = 'private' AND v_author IS DISTINCT FROM NEW.author_user_id THEN
      RAISE EXCEPTION 'NOTES_NOTEBOOK_NOT_ACCESSIBLE' USING ERRCODE = '42501';
    END IF;

    IF v_vis = 'private' AND NEW.visibility = 'org' THEN
      RAISE EXCEPTION 'NOTES_SHARED_NOTE_PRIVATE_NOTEBOOK' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_notes.note_notebook_integrity() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- Named b_* so crove_kernel's agent_write_guard fires first alphabetically on any agent write.
DROP TRIGGER IF EXISTS b_note_notebook_integrity ON crove_notes.note;
CREATE TRIGGER b_note_notebook_integrity BEFORE INSERT OR UPDATE OF visibility, notebook_id, author_user_id ON crove_notes.note
  FOR EACH ROW EXECUTE FUNCTION crove_notes.note_notebook_integrity();

-- Prevent turning a shared ('org') notebook 'private' while shared ('org') notes belong to it,
-- and silently detach any other member's private notes so no private note ever points to
-- another user's private notebook and zero existence oracle is leaked.
CREATE OR REPLACE FUNCTION crove_notes.notebook_visibility_integrity() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF OLD.visibility = 'org' AND NEW.visibility = 'private' THEN
    IF EXISTS (
      SELECT 1 FROM crove_notes.note n
       WHERE n.org_id = NEW.org_id
         AND n.notebook_id = NEW.id
         AND n.visibility = 'org'
    ) THEN
      RAISE EXCEPTION 'NOTES_NOTEBOOK_HAS_SHARED_NOTES' USING ERRCODE = '23514';
    END IF;

    UPDATE crove_notes.note
       SET notebook_id = NULL
     WHERE org_id = NEW.org_id
       AND notebook_id = NEW.id
       AND visibility = 'private'
       AND author_user_id IS DISTINCT FROM NEW.author_user_id;
  END IF;

  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_notes.notebook_visibility_integrity() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

DROP TRIGGER IF EXISTS b_notebook_visibility_integrity ON crove_notes.notebook;
CREATE TRIGGER b_notebook_visibility_integrity BEFORE UPDATE OF visibility ON crove_notes.notebook
  FOR EACH ROW EXECUTE FUNCTION crove_notes.notebook_visibility_integrity();

-- Existence-oracle parity on note write policies for notebook_id.
DROP POLICY IF EXISTS note_insert ON crove_notes.note;
CREATE POLICY note_insert ON crove_notes.note AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK (
    author_user_id = (SELECT crove_kernel.ctx_user_id())
    AND (notebook_id IS NULL OR EXISTS (SELECT 1 FROM crove_notes.notebook b WHERE b.org_id = note.org_id AND b.id = note.notebook_id))
  );

DROP POLICY IF EXISTS note_update ON crove_notes.note;
CREATE POLICY note_update ON crove_notes.note AS RESTRICTIVE FOR UPDATE TO crove_tenant
  USING (
    author_user_id = (SELECT crove_kernel.ctx_user_id())
    OR (visibility = 'org' AND '*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) AND EXISTS (
      SELECT 1 FROM crove_kernel.tenant_member m
      WHERE m.org_id = note.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin'))))
  WITH CHECK (
    (
      author_user_id = (SELECT crove_kernel.ctx_user_id())
      OR (visibility = 'org' AND '*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) AND EXISTS (
        SELECT 1 FROM crove_kernel.tenant_member m
        WHERE m.org_id = note.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin')))
    )
    AND (notebook_id IS NULL OR EXISTS (SELECT 1 FROM crove_notes.notebook b WHERE b.org_id = note.org_id AND b.id = note.notebook_id))
  );

-- ---------------------------------------------------------------------------
-- Offboarding, former-member purge, and PDPL definers extended for notebook
-- ---------------------------------------------------------------------------

-- Private notebook counts per author for owners/admins and the org offboarding export (system context on crove_worker).
CREATE OR REPLACE FUNCTION crove_notes.private_notebook_counts()
RETURNS TABLE (org_id uuid, author_user_id uuid, notebooks bigint)
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
  RETURN QUERY
    SELECT b.org_id, b.author_user_id, pg_catalog.count(*)
      FROM crove_notes.notebook b
     WHERE b.org_id = v_org AND b.visibility = 'private'
     GROUP BY b.org_id, b.author_user_id
     ORDER BY b.author_user_id;
END $$;
REVOKE ALL ON FUNCTION crove_notes.private_notebook_counts() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_notes.private_notebook_counts() TO crove_tenant;

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
          SELECT b.org_id, b.author_user_id FROM crove_notes.notebook b WHERE b.visibility = 'private'
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
  v_t bigint;
  v_l bigint;
  v_b bigint;
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
  DELETE FROM crove_notes.note n WHERE n.org_id = v_org AND n.author_user_id = p_user AND n.visibility = 'private';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  DELETE FROM crove_notes.notebook b WHERE b.org_id = v_org AND b.author_user_id = p_user AND b.visibility = 'private';
  GET DIAGNOSTICS v_b = ROW_COUNT;
  RETURN v_n + v_t + v_l + v_b;
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
              OR crove_kernel.text_mentions(pg_catalog.array_to_string(n.tags, ' '), p_kind, p_value))
      UNION ALL
      SELECT b.author_user_id, 1, 0
        FROM crove_notes.notebook b
       WHERE b.org_id = v_org AND b.visibility = 'private'
         AND (crove_kernel.text_mentions(b.name, p_kind, p_value)
              OR crove_kernel.text_mentions(b.stack_name, p_kind, p_value))
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
            OR crove_kernel.text_mentions(pg_catalog.array_to_string(n.tags, ' '), p_kind, p_value))
    UNION ALL
    SELECT 'notebook'::text, b.id, b.author_user_id, b.revision
      FROM crove_notes.notebook b
     WHERE b.org_id = v_org AND b.visibility = 'private'
       AND (crove_kernel.text_mentions(b.name, p_kind, p_value)
            OR crove_kernel.text_mentions(b.stack_name, p_kind, p_value))
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
  v_lists jsonb := '[]'::jsonb;
  v_notebooks jsonb := '[]'::jsonb;
BEGIN
  IF v_org IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' OR NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m
    WHERE m.org_id = v_org AND m.user_id = crove_kernel.ctx_user_id() AND m.role = 'owner'
  ) THEN
    RAISE EXCEPTION 'NOTES_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  PERFORM crove_kernel.text_mention_pattern(p_kind, p_value);
  v_key := crove_notes.private_notice_key_of(v_org, p_kind, p_value);

  -- Global lock DAG: notebook[id ASC] -> note[id ASC] and todo_list[id ASC] -> todo[id ASC]
  -- before any DELETE so concurrent commands and FK ON DELETE SET NULL stay deadlock-free.
  PERFORM b.id
    FROM crove_notes.notebook b
   WHERE b.org_id = v_org AND b.visibility = 'private'
     AND (
       crove_kernel.text_mentions(b.name, p_kind, p_value)
       OR crove_kernel.text_mentions(b.stack_name, p_kind, p_value)
       OR EXISTS (
         SELECT 1 FROM crove_notes.note n
          WHERE n.org_id = v_org AND n.notebook_id = b.id AND n.visibility = 'private'
            AND (crove_kernel.text_mentions(n.title, p_kind, p_value)
                 OR crove_kernel.text_mentions(n.body, p_kind, p_value)
                 OR crove_kernel.text_mentions(pg_catalog.array_to_string(n.tags, ' '), p_kind, p_value))
       )
     )
   ORDER BY b.id
   FOR UPDATE;

  PERFORM n.id
    FROM crove_notes.note n
   WHERE n.org_id = v_org AND n.visibility = 'private'
     AND (
       crove_kernel.text_mentions(n.title, p_kind, p_value)
       OR crove_kernel.text_mentions(n.body, p_kind, p_value)
       OR crove_kernel.text_mentions(pg_catalog.array_to_string(n.tags, ' '), p_kind, p_value)
       OR EXISTS (
         SELECT 1 FROM crove_notes.notebook b
          WHERE b.org_id = v_org AND b.id = n.notebook_id AND b.visibility = 'private'
            AND (crove_kernel.text_mentions(b.name, p_kind, p_value)
                 OR crove_kernel.text_mentions(b.stack_name, p_kind, p_value))
       )
     )
   ORDER BY n.id
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

  -- Erase matched notes and todos first so parent deletions below only set NULL on surviving children.
  WITH told AS (
    SELECT a.detail, a.actor_id FROM crove_kernel.audit_event a
     WHERE a.org_id = v_org AND a.command = 'kernel.personal_data.notify' AND a.outcome = 'ok'
       AND a.occurred_at <= pg_catalog.now() - interval '24 hours'
       AND pg_catalog.jsonb_typeof(a.detail) = 'object' AND a.detail ->> 'key' = v_key
  ),
  note_found AS (
    SELECT n.id, n.revision, n.author_user_id AS author,
           EXISTS (SELECT 1 FROM told
                    WHERE pg_catalog.jsonb_typeof(told.detail -> 'notes') = 'array' AND (told.detail -> 'notes') ? (n.id::text || ':' || n.revision::text)
                      AND crove_notes.private_notice_told(v_org, n.author_user_id, told.actor_id, told.detail ->> 'event')) AS named
      FROM crove_notes.note n
     WHERE n.org_id = v_org AND n.visibility = 'private'
       AND (crove_kernel.text_mentions(n.title, p_kind, p_value)
            OR crove_kernel.text_mentions(n.body, p_kind, p_value)
            OR crove_kernel.text_mentions(pg_catalog.array_to_string(n.tags, ' '), p_kind, p_value))
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
     WHERE n.org_id = v_org AND n.id = f.id AND n.revision = f.revision AND f.named
    RETURNING n.id, f.author
  ),
  todo_gone AS (
    DELETE FROM crove_notes.todo t USING todo_found f
     WHERE t.org_id = v_org AND t.id = f.id AND t.revision = f.revision AND f.named
    RETURNING t.id, f.author
  ),
  counted AS (
    SELECT g.author, g.id, 'note'::text AS kind, true AS gone FROM note_gone g
    UNION ALL SELECT g.author, g.id, 'todo', true FROM todo_gone g
    UNION ALL SELECT f.author, f.id, 'note', false FROM note_found f WHERE NOT EXISTS (SELECT 1 FROM note_gone g WHERE g.id = f.id)
    UNION ALL SELECT f.author, f.id, 'todo', false FROM todo_found f WHERE NOT EXISTS (SELECT 1 FROM todo_gone g WHERE g.id = f.id)
  )
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'author', c.author, 'id', c.id, 'kind', c.kind, 'gone', c.gone
  )), '[]'::jsonb)
    INTO v_items
    FROM counted c;

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

  -- Erase matched private notebooks in a separate statement after matching notes are already removed.
  WITH told AS (
    SELECT a.detail, a.actor_id FROM crove_kernel.audit_event a
     WHERE a.org_id = v_org AND a.command = 'kernel.personal_data.notify' AND a.outcome = 'ok'
       AND a.occurred_at <= pg_catalog.now() - interval '24 hours'
       AND pg_catalog.jsonb_typeof(a.detail) = 'object' AND a.detail ->> 'key' = v_key
  ),
  notebook_found AS (
    SELECT b.id, b.revision, b.author_user_id AS author,
           EXISTS (SELECT 1 FROM told
                    WHERE pg_catalog.jsonb_typeof(told.detail -> 'notebooks') = 'array'
                      AND (told.detail -> 'notebooks') ? (b.id::text || ':' || b.revision::text)
                      AND crove_notes.private_notice_told(v_org, b.author_user_id, told.actor_id, told.detail ->> 'event')) AS named
      FROM crove_notes.notebook b
     WHERE b.org_id = v_org AND b.visibility = 'private'
       AND (crove_kernel.text_mentions(b.name, p_kind, p_value)
            OR crove_kernel.text_mentions(b.stack_name, p_kind, p_value))
  ),
  notebook_gone AS (
    DELETE FROM crove_notes.notebook b USING notebook_found f
     WHERE b.org_id = v_org AND b.id = f.id AND b.revision = f.revision AND f.named
    RETURNING b.id, f.author
  ),
  notebook_counted AS (
    SELECT g.author, g.id, 'note'::text AS kind, true AS gone FROM notebook_gone g
    UNION ALL SELECT f.author, f.id, 'note', false FROM notebook_found f WHERE NOT EXISTS (SELECT 1 FROM notebook_gone g WHERE g.id = f.id)
  )
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'author', c.author, 'id', c.id, 'kind', c.kind, 'gone', c.gone
  )), '[]'::jsonb)
    INTO v_notebooks
    FROM notebook_counted c;

  v_items := v_items || v_lists || v_notebooks;

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
