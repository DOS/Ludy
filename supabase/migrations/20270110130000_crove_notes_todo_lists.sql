-- SPDX-License-Identifier: AGPL-3.0-only
-- Notes v2 T1 (#3558): personal to-do lists, sections, P1-P4 priorities and #tags,
-- strictly private to each owner (ADR-0037).
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- Validation helpers (immutable, strict search_path)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION crove_notes.todo_list_sections_valid(p_sections jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog, pg_temp AS $$
  SELECT pg_catalog.jsonb_typeof(p_sections) = 'array'
     AND pg_catalog.jsonb_array_length(p_sections) <= 50
     AND NOT EXISTS (
       SELECT 1
         FROM pg_catalog.jsonb_array_elements(p_sections) AS el(item)
        WHERE pg_catalog.jsonb_typeof(el.item) <> 'object'
           OR NOT (el.item ? 'id' AND el.item ? 'name')
           OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(el.item)) <> 2
           OR pg_catalog.jsonb_typeof(el.item -> 'id') <> 'string'
           OR pg_catalog.jsonb_typeof(el.item -> 'name') <> 'string'
           OR NOT ((el.item ->> 'id') ~ '^[0-9A-Za-z_-]{1,64}$')
           OR pg_catalog.char_length(el.item ->> 'name') > 100
           OR pg_catalog.char_length(pg_catalog.btrim(el.item ->> 'name')) < 1
     )
     AND (
       SELECT pg_catalog.count(DISTINCT el.item ->> 'id')
         FROM pg_catalog.jsonb_array_elements(p_sections) AS el(item)
     ) = pg_catalog.jsonb_array_length(p_sections);
$$;
REVOKE ALL ON FUNCTION crove_notes.todo_list_sections_valid(jsonb) FROM PUBLIC, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_notes.todo_list_sections_valid(jsonb) TO crove_tenant;

CREATE OR REPLACE FUNCTION crove_notes.todo_tags_valid(p_tags text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog, pg_temp AS $$
  SELECT COALESCE(pg_catalog.array_length(p_tags, 1), 0) <= 20
     AND NOT EXISTS (
       SELECT 1
         FROM pg_catalog.unnest(p_tags) AS t(v)
        WHERE t.v IS NULL
           OR pg_catalog.char_length(pg_catalog.btrim(t.v)) < 1
           OR pg_catalog.char_length(t.v) > 40
           OR t.v <> pg_catalog.btrim(t.v)
           OR t.v <> pg_catalog.lower(t.v)
     )
     AND (
       SELECT pg_catalog.count(DISTINCT t.v)
         FROM pg_catalog.unnest(p_tags) AS t(v)
     ) = COALESCE(pg_catalog.array_length(p_tags, 1), 0);
$$;
REVOKE ALL ON FUNCTION crove_notes.todo_tags_valid(text[]) FROM PUBLIC, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_notes.todo_tags_valid(text[]) TO crove_tenant;

-- ---------------------------------------------------------------------------
-- crove_notes.todo_list (personal lists with inline sections)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS crove_notes.todo_list (
  org_id        uuid NOT NULL,
  id            uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  owner_user_id uuid NOT NULL,
  name          text NOT NULL,
  color         text,
  sections      jsonb NOT NULL DEFAULT '[]'::jsonb,
  sort_key      text COLLATE "C" NOT NULL,
  revision      integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  PRIMARY KEY (org_id, id),
  CONSTRAINT todo_list_org_fk
    FOREIGN KEY (org_id) REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  CONSTRAINT todo_list_owner_fk
    FOREIGN KEY (owner_user_id) REFERENCES crove_kernel.user_account (id) ON DELETE CASCADE,
  CONSTRAINT todo_list_name_chk
    CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  CONSTRAINT todo_list_color_chk
    CHECK (color ~ '^(?:[a-z0-9_-]{1,32}|#[0-9a-fA-F]{6})$'),
  CONSTRAINT todo_list_sections_chk
    CHECK (crove_notes.todo_list_sections_valid(sections)),
  CONSTRAINT todo_list_sort_key_chk
    CHECK (sort_key ~ '^[0-9A-Za-z]{1,200}$'),
  CONSTRAINT todo_list_revision_chk
    CHECK (revision >= 1)
);

CREATE INDEX IF NOT EXISTS todo_list_owner_idx
  ON crove_notes.todo_list (org_id, owner_user_id, sort_key)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS todo_list_deleted_idx
  ON crove_notes.todo_list (deleted_at)
  WHERE deleted_at IS NOT NULL;

SELECT crove_kernel.apply_tenant_rls('crove_notes.todo_list');

REVOKE ALL ON crove_notes.todo_list FROM PUBLIC, crove_worker, crove_app, crove_definer_tenant;
REVOKE UPDATE, DELETE ON crove_notes.todo_list FROM crove_tenant;
GRANT SELECT, INSERT ON crove_notes.todo_list TO crove_tenant;
GRANT UPDATE (name, color, sections, sort_key, revision, updated_at, deleted_at)
  ON crove_notes.todo_list TO crove_tenant;

-- Strictly private to its owner; system, org agents, member Vy, owners, admins and other members read 0 rows.
DROP POLICY IF EXISTS todo_list_read ON crove_notes.todo_list;
CREATE POLICY todo_list_read ON crove_notes.todo_list AS RESTRICTIVE FOR SELECT TO crove_tenant
  USING (
    owner_user_id = (SELECT crove_kernel.ctx_user_id())
    AND (SELECT crove_kernel.ctx_agent_id()) IS NULL
  );

DROP POLICY IF EXISTS todo_list_insert ON crove_notes.todo_list;
CREATE POLICY todo_list_insert ON crove_notes.todo_list AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK (
    owner_user_id = (SELECT crove_kernel.ctx_user_id())
    AND (SELECT crove_kernel.ctx_agent_id()) IS NULL
    AND EXISTS (
      SELECT 1 FROM crove_kernel.tenant_member m
       WHERE m.org_id = todo_list.org_id
         AND m.user_id = (SELECT crove_kernel.ctx_user_id())
         AND m.role IN ('owner', 'admin', 'member')
    )
  );

DROP POLICY IF EXISTS todo_list_update ON crove_notes.todo_list;
CREATE POLICY todo_list_update ON crove_notes.todo_list AS RESTRICTIVE FOR UPDATE TO crove_tenant
  USING (
    owner_user_id = (SELECT crove_kernel.ctx_user_id())
    AND (SELECT crove_kernel.ctx_agent_id()) IS NULL
    AND EXISTS (
      SELECT 1 FROM crove_kernel.tenant_member m
       WHERE m.org_id = todo_list.org_id
         AND m.user_id = (SELECT crove_kernel.ctx_user_id())
         AND m.role IN ('owner', 'admin', 'member')
    )
  )
  WITH CHECK (
    owner_user_id = (SELECT crove_kernel.ctx_user_id())
    AND (SELECT crove_kernel.ctx_agent_id()) IS NULL
    AND EXISTS (
      SELECT 1 FROM crove_kernel.tenant_member m
       WHERE m.org_id = todo_list.org_id
         AND m.user_id = (SELECT crove_kernel.ctx_user_id())
         AND m.role IN ('owner', 'admin', 'member')
    )
  );

DROP POLICY IF EXISTS todo_list_delete ON crove_notes.todo_list;
CREATE POLICY todo_list_delete ON crove_notes.todo_list AS RESTRICTIVE FOR DELETE TO crove_tenant
  USING (
    owner_user_id = (SELECT crove_kernel.ctx_user_id())
    AND (SELECT crove_kernel.ctx_agent_id()) IS NULL
    AND EXISTS (
      SELECT 1 FROM crove_kernel.tenant_member m
       WHERE m.org_id = todo_list.org_id
         AND m.user_id = (SELECT crove_kernel.ctx_user_id())
         AND m.role IN ('owner', 'admin', 'member')
    )
  );

-- Stream hints (#69, #3558): cross-tab live sync for private personal to-do lists, routed only to owner_user_id.
DROP TRIGGER IF EXISTS stream_hint ON crove_notes.todo_list;
CREATE TRIGGER stream_hint AFTER INSERT OR UPDATE ON crove_notes.todo_list
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.stream_notify('todo', 'id');
DROP TRIGGER IF EXISTS stream_hint_delete ON crove_notes.todo_list;
CREATE TRIGGER stream_hint_delete AFTER DELETE ON crove_notes.todo_list
  REFERENCING OLD TABLE AS gone
  FOR EACH STATEMENT EXECUTE FUNCTION crove_notes.stream_notify_deleted('todo', 'id');

-- ---------------------------------------------------------------------------
-- crove_notes.todo: priority, tags, list_id, section_id
-- ---------------------------------------------------------------------------

ALTER TABLE crove_notes.todo
  ADD COLUMN IF NOT EXISTS priority smallint NOT NULL DEFAULT 4,
  ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS list_id uuid,
  ADD COLUMN IF NOT EXISTS section_id text;

ALTER TABLE crove_notes.todo DROP CONSTRAINT IF EXISTS todo_priority_chk;
ALTER TABLE crove_notes.todo ADD CONSTRAINT todo_priority_chk
  CHECK (priority BETWEEN 1 AND 4);

ALTER TABLE crove_notes.todo DROP CONSTRAINT IF EXISTS todo_tags_chk;
ALTER TABLE crove_notes.todo ADD CONSTRAINT todo_tags_chk
  CHECK (crove_notes.todo_tags_valid(tags));

ALTER TABLE crove_notes.todo DROP CONSTRAINT IF EXISTS todo_section_needs_list_chk;
ALTER TABLE crove_notes.todo ADD CONSTRAINT todo_section_needs_list_chk
  CHECK (section_id IS NULL OR list_id IS NOT NULL);

ALTER TABLE crove_notes.todo DROP CONSTRAINT IF EXISTS todo_list_fk;
ALTER TABLE crove_notes.todo ADD CONSTRAINT todo_list_fk
  FOREIGN KEY (org_id, list_id) REFERENCES crove_notes.todo_list (org_id, id) ON DELETE SET NULL (list_id);

CREATE INDEX IF NOT EXISTS todo_list_id_idx
  ON crove_notes.todo (org_id, list_id);

CREATE INDEX IF NOT EXISTS todo_tags_gin_idx
  ON crove_notes.todo USING gin (tags);

GRANT UPDATE (priority, tags, list_id, section_id) ON crove_notes.todo TO crove_tenant;

-- Verify list ownership, live state (deleted_at IS NULL) and section_id membership.
CREATE OR REPLACE FUNCTION crove_notes.todo_list_integrity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_owner uuid;
  v_deleted timestamptz;
  v_sections jsonb;
BEGIN
  IF NEW.list_id IS NULL THEN
    IF TG_OP = 'UPDATE'
       AND OLD.list_id IS NOT NULL
       AND NEW.section_id IS NOT NULL
       AND NEW.section_id IS NOT DISTINCT FROM OLD.section_id THEN
      NEW.section_id := NULL;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT'
     OR NEW.list_id IS DISTINCT FROM OLD.list_id
     OR NEW.section_id IS DISTINCT FROM OLD.section_id
     OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id THEN
    SELECT l.owner_user_id, l.deleted_at, l.sections
      INTO v_owner, v_deleted, v_sections
      FROM crove_notes.todo_list l
     WHERE l.org_id = NEW.org_id
       AND l.id = NEW.list_id
       FOR SHARE;

    IF NOT FOUND OR v_owner IS DISTINCT FROM NEW.owner_user_id THEN
      RAISE EXCEPTION 'todo list is not accessible for this to-do' USING ERRCODE = '42501';
    END IF;
    IF v_deleted IS NOT NULL THEN
      RAISE EXCEPTION 'todo list is not accessible for this to-do' USING ERRCODE = '42501';
    END IF;
    IF NEW.section_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.jsonb_array_elements(v_sections) AS s(sec)
       WHERE s.sec ->> 'id' = NEW.section_id
    ) THEN
      RAISE EXCEPTION 'todo section_id does not exist in todo_list.sections' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_notes.todo_list_integrity() FROM PUBLIC;

DROP TRIGGER IF EXISTS a_todo_list_integrity ON crove_notes.todo;
CREATE TRIGGER a_todo_list_integrity BEFORE INSERT OR UPDATE ON crove_notes.todo
  FOR EACH ROW EXECUTE FUNCTION crove_notes.todo_list_integrity();

-- Existence-oracle protection on todo write policies for list_id (matches source_note_id and task_id).
DROP POLICY IF EXISTS todo_insert ON crove_notes.todo;
CREATE POLICY todo_insert ON crove_notes.todo AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK (
    owner_user_id = (SELECT crove_kernel.ctx_user_id())
    AND (source_note_id IS NULL OR EXISTS (SELECT 1 FROM crove_notes.note n WHERE n.org_id = todo.org_id AND n.id = todo.source_note_id))
    AND (task_id IS NULL OR EXISTS (SELECT 1 FROM crove_kernel.task k WHERE k.org_id = todo.org_id AND k.id = todo.task_id))
    AND (list_id IS NULL OR EXISTS (SELECT 1 FROM crove_notes.todo_list l WHERE l.org_id = todo.org_id AND l.id = todo.list_id))
  );

DROP POLICY IF EXISTS todo_update ON crove_notes.todo;
CREATE POLICY todo_update ON crove_notes.todo AS RESTRICTIVE FOR UPDATE TO crove_tenant
  USING (owner_user_id = (SELECT crove_kernel.ctx_user_id()))
  WITH CHECK (
    owner_user_id = (SELECT crove_kernel.ctx_user_id())
    AND (task_id IS NULL OR EXISTS (SELECT 1 FROM crove_kernel.task k WHERE k.org_id = todo.org_id AND k.id = todo.task_id))
    AND (list_id IS NULL OR EXISTS (SELECT 1 FROM crove_notes.todo_list l WHERE l.org_id = todo.org_id AND l.id = todo.list_id))
  );

-- Fold #tags into todo.search alongside title, details and checklist.
CREATE OR REPLACE FUNCTION crove_notes.todo_search() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  NEW.search := crove_kernel.search_vector(
    NEW.title || ' ' || pg_catalog.array_to_string(coalesce(NEW.tags, '{}'::text[]), ' ') || ' '
    || coalesce(NEW.details, '') || ' '
    || coalesce((SELECT pg_catalog.string_agg(s.step ->> 'text', ' ') FROM pg_catalog.jsonb_array_elements(NEW.checklist) AS s(step)), '')
  );
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_notes.todo_search() FROM PUBLIC;

DROP TRIGGER IF EXISTS b_search ON crove_notes.todo;
CREATE TRIGGER b_search BEFORE INSERT OR UPDATE OF title, details, checklist, tags ON crove_notes.todo
  FOR EACH ROW EXECUTE FUNCTION crove_notes.todo_search();

-- Backfill search vector on existing todos if tags existed (no-op on empty tags, safe).
-- Wait: existing todo rows already have search populated for title/details/checklist and default tags='{}'.

-- ---------------------------------------------------------------------------
-- Trash, former-member purge, and PDPL definers extended for todo_list and todo.tags
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION crove_notes.trash_due(p_before timestamptz, p_limit integer)
RETURNS TABLE (org_id uuid) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') OR crove_kernel.ctx_actor_type() IS NOT NULL THEN
    RAISE EXCEPTION 'NOTES_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT d.org_id FROM (
      SELECT n.org_id FROM crove_notes.note n WHERE n.deleted_at IS NOT NULL AND n.deleted_at < p_before
      UNION
      SELECT t.org_id FROM crove_notes.todo t WHERE t.deleted_at IS NOT NULL AND t.deleted_at < p_before
      UNION
      SELECT l.org_id FROM crove_notes.todo_list l WHERE l.deleted_at IS NOT NULL AND l.deleted_at < p_before
    ) AS d
    ORDER BY 1 LIMIT LEAST(GREATEST(p_limit, 1), 1000);
END $$;
REVOKE ALL ON FUNCTION crove_notes.trash_due(timestamptz, integer) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_notes.trash_due(timestamptz, integer) TO crove_worker;

CREATE OR REPLACE FUNCTION crove_notes.trash_empty(p_before timestamptz)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_before timestamptz := LEAST(COALESCE(p_before, '-infinity'::timestamptz), pg_catalog.now() - interval '30 days');
  v_n bigint;
  v_t bigint;
  v_l bigint;
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'NOTES_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF v_org IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'system' THEN
    RAISE EXCEPTION 'NOTES_SYSTEM_CONTEXT' USING ERRCODE = '42501';
  END IF;
  DELETE FROM crove_notes.note n WHERE n.org_id = v_org AND n.deleted_at IS NOT NULL AND n.deleted_at < v_before;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  DELETE FROM crove_notes.todo t WHERE t.org_id = v_org AND t.deleted_at IS NOT NULL AND t.deleted_at < v_before;
  GET DIAGNOSTICS v_t = ROW_COUNT;
  DELETE FROM crove_notes.todo_list l WHERE l.org_id = v_org AND l.deleted_at IS NOT NULL AND l.deleted_at < v_before;
  GET DIAGNOSTICS v_l = ROW_COUNT;
  RETURN v_n + v_t + v_l;
END $$;
REVOKE ALL ON FUNCTION crove_notes.trash_empty(timestamptz) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_notes.trash_empty(timestamptz) TO crove_worker;

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
  RETURN v_n + v_t + v_l;
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
BEGIN
  IF v_org IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' OR NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m
    WHERE m.org_id = v_org AND m.user_id = crove_kernel.ctx_user_id() AND m.role = 'owner'
  ) THEN
    RAISE EXCEPTION 'NOTES_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  PERFORM crove_kernel.text_mention_pattern(p_kind, p_value);
  v_key := crove_notes.private_notice_key_of(v_org, p_kind, p_value);

  -- Erase matched notes and todos first so todo_list deletion below only triggers ON DELETE SET NULL on surviving todos.
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

  v_items := v_items || v_lists;

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
