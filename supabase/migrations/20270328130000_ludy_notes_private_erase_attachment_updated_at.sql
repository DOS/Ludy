-- SPDX-License-Identifier: AGPL-3.0-only
-- Ludy Notes (#5035, #4213, PR #4820 follow-up): restate ludy_notes.private_erase(p_kind text, p_value text)
-- symmetrically with shared-note attachment erasure (packages/kernel/src/personal-data.ts):
-- lock attachment-matched parent notes in the single set-based note[id ASC] pass using FOR NO KEY UPDATE (so
-- FK FOR KEY SHARE inserts in todoComplete never block/deadlock, note -> attachment matches noteAttachmentDelete,
-- and concurrent private_erase serializes cleanly), then bump surviving parent updated_at monotonically.
-- Idempotent; preserves signature, security definer, search_path, return columns, and post-Stage-7 grants.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION ludy_notes.private_erase(p_kind text, p_value text)
RETURNS TABLE (author_user_id uuid, notes bigint, todos bigint, untold_notes bigint, untold_todos bigint, note_ids uuid[], todo_ids uuid[])
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_key text;
  v_items jsonb := '[]'::jsonb;
  v_attachments jsonb := '[]'::jsonb;
  v_touched_notes uuid[] := '{}'::uuid[];
  v_templates jsonb := '[]'::jsonb;
  v_lists jsonb := '[]'::jsonb;
  v_notebooks jsonb := '[]'::jsonb;
BEGIN
  IF v_org IS NULL OR ludy_kernel.ctx_actor_type() IS DISTINCT FROM 'user' OR NOT EXISTS (
    SELECT 1 FROM ludy_kernel.tenant_member m
    WHERE m.org_id = v_org AND m.user_id = ludy_kernel.ctx_user_id() AND m.role = 'owner'
  ) THEN
    RAISE EXCEPTION 'NOTES_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  PERFORM ludy_kernel.text_mention_pattern(p_kind, p_value);
  v_key := ludy_notes.private_notice_key_of(v_org, p_kind, p_value);

  -- Global lock DAG: single bounded org barrier ('notes.erase:<org>') -> notebook[id ASC] -> note[id ASC] ->
  -- note_template[id ASC] -> todo_list[id ASC] -> todo[id ASC] before any DELETE/UPDATE so concurrent notebook
  -- updates/moves (noteCreate/noteUpdate/noteSetVisibility/notebookUpdate/notebookDelete, which take a shared
  -- 'notes.erase:<org>' advisory lock) and FK ON DELETE SET NULL / CASCADE stay deadlock-free without holding
  -- unbounded per-notebook advisory locks.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('notes.erase:' || v_org::text, 0)
  );

  PERFORM b.id
    FROM ludy_notes.notebook b
   WHERE b.org_id = v_org AND b.visibility = 'private'
     AND (
       ludy_kernel.text_mentions(b.name, p_kind, p_value)
       OR ludy_kernel.text_mentions(b.stack_name, p_kind, p_value)
       OR EXISTS (
         SELECT 1 FROM ludy_notes.note n
          WHERE n.org_id = v_org AND n.notebook_id = b.id AND n.visibility = 'private'
            AND (ludy_kernel.text_mentions(n.title, p_kind, p_value)
                 OR ludy_kernel.text_mentions(n.body, p_kind, p_value)
                 OR ludy_kernel.text_mentions(pg_catalog.array_to_string(n.tags, ' '), p_kind, p_value)
                 OR EXISTS (
                   SELECT 1 FROM ludy_notes.note_version v
                    WHERE v.org_id = n.org_id AND v.note_id = n.id
                      AND (ludy_kernel.text_mentions(v.title, p_kind, p_value)
                           OR ludy_kernel.text_mentions(v.body, p_kind, p_value)
                           OR ludy_kernel.text_mentions(pg_catalog.array_to_string(v.tags, ' '), p_kind, p_value))
                 ))
       )
     )
   ORDER BY b.id
   FOR UPDATE;

  PERFORM n.id
    FROM ludy_notes.note n
   WHERE n.org_id = v_org AND n.visibility = 'private'
     AND (
       ludy_kernel.text_mentions(n.title, p_kind, p_value)
       OR ludy_kernel.text_mentions(n.body, p_kind, p_value)
       OR ludy_kernel.text_mentions(pg_catalog.array_to_string(n.tags, ' '), p_kind, p_value)
       OR EXISTS (
         SELECT 1 FROM ludy_notes.note_version v
          WHERE v.org_id = n.org_id AND v.note_id = n.id
            AND (ludy_kernel.text_mentions(v.title, p_kind, p_value)
                 OR ludy_kernel.text_mentions(v.body, p_kind, p_value)
                 OR ludy_kernel.text_mentions(pg_catalog.array_to_string(v.tags, ' '), p_kind, p_value))
       )
       OR EXISTS (
         SELECT 1 FROM ludy_notes.notebook b
          WHERE b.org_id = v_org AND b.id = n.notebook_id AND b.visibility = 'private'
            AND (ludy_kernel.text_mentions(b.name, p_kind, p_value)
                 OR ludy_kernel.text_mentions(b.stack_name, p_kind, p_value))
       )
       OR EXISTS (
         SELECT 1 FROM ludy_notes.attachment a
          WHERE a.org_id = n.org_id AND a.note_id = n.id
            AND (ludy_kernel.text_mentions(a.filename, p_kind, p_value)
                 OR ludy_kernel.text_mentions(a.extracted_text, p_kind, p_value))
       )
     )
   ORDER BY n.id
   FOR NO KEY UPDATE;

  PERFORM tpl.id
    FROM ludy_notes.note_template tpl
   WHERE tpl.org_id = v_org AND tpl.visibility = 'private'
     AND (
       ludy_kernel.text_mentions(tpl.name, p_kind, p_value)
       OR ludy_kernel.text_mentions(tpl.title, p_kind, p_value)
       OR ludy_kernel.text_mentions(tpl.body, p_kind, p_value)
       OR ludy_kernel.text_mentions(pg_catalog.array_to_string(tpl.tags, ' '), p_kind, p_value)
     )
   ORDER BY tpl.id
   FOR UPDATE;

  PERFORM l.id
    FROM ludy_notes.todo_list l
   WHERE l.org_id = v_org
     AND (
       ludy_kernel.text_mentions(l.name, p_kind, p_value)
       OR EXISTS (
         SELECT 1 FROM pg_catalog.jsonb_array_elements(l.sections) AS s(sec)
         WHERE ludy_kernel.text_mentions(s.sec ->> 'name', p_kind, p_value)
       )
       OR EXISTS (
         SELECT 1 FROM ludy_notes.todo t
          WHERE t.org_id = v_org AND t.list_id = l.id
            AND (ludy_kernel.text_mentions(t.title, p_kind, p_value)
                 OR ludy_kernel.text_mentions(t.details, p_kind, p_value)
                 OR ludy_kernel.text_mentions(t.checklist::text, p_kind, p_value)
                 OR ludy_kernel.text_mentions(pg_catalog.array_to_string(t.tags, ' '), p_kind, p_value))
       )
     )
   ORDER BY l.id
   FOR UPDATE;

  PERFORM t.id
    FROM ludy_notes.todo t
   WHERE t.org_id = v_org
     AND (
       ludy_kernel.text_mentions(t.title, p_kind, p_value)
       OR ludy_kernel.text_mentions(t.details, p_kind, p_value)
       OR ludy_kernel.text_mentions(t.checklist::text, p_kind, p_value)
       OR ludy_kernel.text_mentions(pg_catalog.array_to_string(t.tags, ' '), p_kind, p_value)
       OR EXISTS (
         SELECT 1 FROM ludy_notes.todo_list l
          WHERE l.org_id = v_org AND l.id = t.list_id
            AND (ludy_kernel.text_mentions(l.name, p_kind, p_value)
                 OR EXISTS (
                   SELECT 1 FROM pg_catalog.jsonb_array_elements(l.sections) AS s(sec)
                   WHERE ludy_kernel.text_mentions(s.sec ->> 'name', p_kind, p_value)
                 ))
       )
     )
   ORDER BY t.id
   FOR UPDATE;

  -- Erase matched private notes (cascading attachments via attachment_doom and note_version snapshots),
  -- or erase matching note_version snapshots when the live note itself no longer mentions the value, alongside todos.
  WITH told AS (
    SELECT a.detail, a.actor_id FROM ludy_kernel.audit_event a
     WHERE a.org_id = v_org AND a.command = 'kernel.personal_data.notify' AND a.outcome = 'ok'
       AND a.occurred_at <= pg_catalog.now() - interval '24 hours'
       AND pg_catalog.jsonb_typeof(a.detail) = 'object' AND a.detail ->> 'key' = v_key
  ),
  note_found AS (
    SELECT n.id, n.revision, n.author_user_id AS author,
           (ludy_kernel.text_mentions(n.title, p_kind, p_value)
            OR ludy_kernel.text_mentions(n.body, p_kind, p_value)
            OR ludy_kernel.text_mentions(pg_catalog.array_to_string(n.tags, ' '), p_kind, p_value)) AS live_mentions,
           EXISTS (SELECT 1 FROM told
                    WHERE pg_catalog.jsonb_typeof(told.detail -> 'notes') = 'array' AND (told.detail -> 'notes') ? (n.id::text || ':' || n.revision::text)
                      AND ludy_notes.private_notice_told(v_org, n.author_user_id, told.actor_id, told.detail ->> 'event')) AS named
      FROM ludy_notes.note n
     WHERE n.org_id = v_org AND n.visibility = 'private'
       AND (ludy_kernel.text_mentions(n.title, p_kind, p_value)
            OR ludy_kernel.text_mentions(n.body, p_kind, p_value)
            OR ludy_kernel.text_mentions(pg_catalog.array_to_string(n.tags, ' '), p_kind, p_value)
            OR EXISTS (
              SELECT 1 FROM ludy_notes.note_version v
               WHERE v.org_id = n.org_id AND v.note_id = n.id
                 AND (ludy_kernel.text_mentions(v.title, p_kind, p_value)
                      OR ludy_kernel.text_mentions(v.body, p_kind, p_value)
                      OR ludy_kernel.text_mentions(pg_catalog.array_to_string(v.tags, ' '), p_kind, p_value))
            ))
  ),
  todo_found AS (
    SELECT t.id, t.revision, t.owner_user_id AS author,
           EXISTS (SELECT 1 FROM told
                    WHERE pg_catalog.jsonb_typeof(told.detail -> 'todos') = 'array' AND (told.detail -> 'todos') ? (t.id::text || ':' || t.revision::text)
                      AND ludy_notes.private_notice_told(v_org, t.owner_user_id, told.actor_id, told.detail ->> 'event')) AS named
      FROM ludy_notes.todo t
     WHERE t.org_id = v_org
       AND (ludy_kernel.text_mentions(t.title, p_kind, p_value)
            OR ludy_kernel.text_mentions(t.details, p_kind, p_value)
            OR ludy_kernel.text_mentions(t.checklist::text, p_kind, p_value)
            OR ludy_kernel.text_mentions(pg_catalog.array_to_string(t.tags, ' '), p_kind, p_value))
  ),
  note_gone AS (
    DELETE FROM ludy_notes.note n USING note_found f
     WHERE n.org_id = v_org AND n.id = f.id AND n.revision = f.revision AND f.named AND f.live_mentions
    RETURNING n.id, f.author
  ),
  version_only_gone AS (
    DELETE FROM ludy_notes.note_version v USING note_found f
     WHERE v.org_id = v_org AND v.note_id = f.id AND f.named AND NOT f.live_mentions
       AND EXISTS (SELECT 1 FROM ludy_notes.note n WHERE n.org_id = v_org AND n.id = f.id AND n.revision = f.revision)
       AND (ludy_kernel.text_mentions(v.title, p_kind, p_value)
            OR ludy_kernel.text_mentions(v.body, p_kind, p_value)
            OR ludy_kernel.text_mentions(pg_catalog.array_to_string(v.tags, ' '), p_kind, p_value))
    RETURNING f.id, f.author
  ),
  note_erased AS (
    SELECT g.id, g.author FROM note_gone g
    UNION
    SELECT vg.id, vg.author FROM version_only_gone vg
  ),
  todo_gone AS (
    DELETE FROM ludy_notes.todo t USING todo_found f
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

  -- Erase matched private attachments on surviving private notes (triggering attachment_doom and search sync),
  -- then bump surviving parent notes' updated_at symmetrically with shared-note attachment erasure.
  WITH told AS (
    SELECT a.detail, a.actor_id FROM ludy_kernel.audit_event a
     WHERE a.org_id = v_org AND a.command = 'kernel.personal_data.notify' AND a.outcome = 'ok'
       AND a.occurred_at <= pg_catalog.now() - interval '24 hours'
       AND pg_catalog.jsonb_typeof(a.detail) = 'object' AND a.detail ->> 'key' = v_key
  ),
  att_found AS (
    SELECT a.id, a.note_id, (CASE WHEN a.extract_status = 'done' THEN 2 ELSE 1 END) AS rev, n.author_user_id AS author,
           EXISTS (SELECT 1 FROM told
                    WHERE pg_catalog.jsonb_typeof(told.detail -> 'note_attachments') = 'array'
                      AND (told.detail -> 'note_attachments') ? (a.id::text || ':' || (CASE WHEN a.extract_status = 'done' THEN 2 ELSE 1 END)::text)
                      AND ludy_notes.private_notice_told(v_org, n.author_user_id, told.actor_id, told.detail ->> 'event')) AS named
      FROM ludy_notes.attachment a
      JOIN ludy_notes.note n ON n.org_id = a.org_id AND n.id = a.note_id
     WHERE a.org_id = v_org AND n.visibility = 'private'
       AND (ludy_kernel.text_mentions(a.filename, p_kind, p_value)
            OR ludy_kernel.text_mentions(a.extracted_text, p_kind, p_value))
  ),
  att_gone AS (
    DELETE FROM ludy_notes.attachment a USING att_found f
     WHERE a.org_id = v_org AND a.id = f.id
       AND (CASE WHEN a.extract_status = 'done' THEN 2 ELSE 1 END) = f.rev
       AND f.named
    RETURNING a.id, a.note_id, f.author
  ),
  att_counted AS (
    SELECT g.author, g.id, 'note'::text AS kind, true AS gone FROM att_gone g
    UNION ALL SELECT f.author, f.id, 'note', false FROM att_found f WHERE NOT EXISTS (SELECT 1 FROM att_gone g WHERE g.id = f.id)
  )
  SELECT COALESCE((
           SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
             'author', c.author, 'id', c.id, 'kind', c.kind, 'gone', c.gone
           ))
             FROM att_counted c
         ), '[]'::jsonb),
         COALESCE((
           SELECT pg_catalog.array_agg(DISTINCT g.note_id ORDER BY g.note_id)
             FROM att_gone g
         ), '{}'::uuid[])
    INTO v_attachments, v_touched_notes;

  IF COALESCE(pg_catalog.array_length(v_touched_notes, 1), 0) > 0 THEN
    UPDATE ludy_notes.note n
       SET updated_at = GREATEST(n.updated_at, pg_catalog.clock_timestamp())
     WHERE n.org_id = v_org AND n.id = ANY (v_touched_notes);
  END IF;

  -- Erase matched private note templates in a separate statement.
  WITH told AS (
    SELECT a.detail, a.actor_id FROM ludy_kernel.audit_event a
     WHERE a.org_id = v_org AND a.command = 'kernel.personal_data.notify' AND a.outcome = 'ok'
       AND a.occurred_at <= pg_catalog.now() - interval '24 hours'
       AND pg_catalog.jsonb_typeof(a.detail) = 'object' AND a.detail ->> 'key' = v_key
  ),
  tpl_found AS (
    SELECT tpl.id, tpl.revision, tpl.author_user_id AS author,
           EXISTS (SELECT 1 FROM told
                    WHERE pg_catalog.jsonb_typeof(told.detail -> 'note_templates') = 'array'
                      AND (told.detail -> 'note_templates') ? (tpl.id::text || ':' || tpl.revision::text)
                      AND ludy_notes.private_notice_told(v_org, tpl.author_user_id, told.actor_id, told.detail ->> 'event')) AS named
      FROM ludy_notes.note_template tpl
     WHERE tpl.org_id = v_org AND tpl.visibility = 'private'
       AND (ludy_kernel.text_mentions(tpl.name, p_kind, p_value)
            OR ludy_kernel.text_mentions(tpl.title, p_kind, p_value)
            OR ludy_kernel.text_mentions(tpl.body, p_kind, p_value)
            OR ludy_kernel.text_mentions(pg_catalog.array_to_string(tpl.tags, ' '), p_kind, p_value))
  ),
  tpl_gone AS (
    DELETE FROM ludy_notes.note_template tpl USING tpl_found f
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
    SELECT a.detail, a.actor_id FROM ludy_kernel.audit_event a
     WHERE a.org_id = v_org AND a.command = 'kernel.personal_data.notify' AND a.outcome = 'ok'
       AND a.occurred_at <= pg_catalog.now() - interval '24 hours'
       AND pg_catalog.jsonb_typeof(a.detail) = 'object' AND a.detail ->> 'key' = v_key
  ),
  list_found AS (
    SELECT l.id, l.revision, l.owner_user_id AS author,
           EXISTS (SELECT 1 FROM told
                    WHERE pg_catalog.jsonb_typeof(told.detail -> 'todo_lists') = 'array'
                      AND (told.detail -> 'todo_lists') ? (l.id::text || ':' || l.revision::text)
                      AND ludy_notes.private_notice_told(v_org, l.owner_user_id, told.actor_id, told.detail ->> 'event')) AS named
      FROM ludy_notes.todo_list l
     WHERE l.org_id = v_org
       AND (ludy_kernel.text_mentions(l.name, p_kind, p_value)
            OR EXISTS (
              SELECT 1 FROM pg_catalog.jsonb_array_elements(l.sections) AS s(sec)
              WHERE ludy_kernel.text_mentions(s.sec ->> 'name', p_kind, p_value)
            ))
  ),
  list_gone AS (
    DELETE FROM ludy_notes.todo_list l USING list_found f
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
    SELECT a.detail, a.actor_id FROM ludy_kernel.audit_event a
     WHERE a.org_id = v_org AND a.command = 'kernel.personal_data.notify' AND a.outcome = 'ok'
       AND a.occurred_at <= pg_catalog.now() - interval '24 hours'
       AND pg_catalog.jsonb_typeof(a.detail) = 'object' AND a.detail ->> 'key' = v_key
  ),
  notebook_found AS (
    SELECT b.id, b.revision, b.author_user_id AS author,
           EXISTS (SELECT 1 FROM told
                    WHERE pg_catalog.jsonb_typeof(told.detail -> 'notebooks') = 'array'
                      AND (told.detail -> 'notebooks') ? (b.id::text || ':' || b.revision::text)
                      AND ludy_notes.private_notice_told(v_org, b.author_user_id, told.actor_id, told.detail ->> 'event')) AS named
      FROM ludy_notes.notebook b
     WHERE b.org_id = v_org AND b.visibility = 'private'
       AND (ludy_kernel.text_mentions(b.name, p_kind, p_value)
            OR ludy_kernel.text_mentions(b.stack_name, p_kind, p_value))
  ),
  notebook_gone AS (
    DELETE FROM ludy_notes.notebook b USING notebook_found f
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

  v_items := v_items || v_attachments || v_templates || v_lists || v_notebooks;

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

REVOKE ALL ON FUNCTION ludy_notes.private_erase(text, text) FROM PUBLIC;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE 'ludy\_%' AND rolname <> current_user LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_notes.private_erase(text, text) FROM %I', r.rolname);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION ludy_notes.private_erase(text, text) TO ludy_tenant;

-- Count-only owner definer reporting private note attachments still awaiting text extraction during PDPL erasure
-- without disclosing private filenames, text, note ids, or authors (#5035).
CREATE OR REPLACE FUNCTION ludy_notes.private_pending_attachment_count()
RETURNS bigint
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
BEGIN
  IF v_org IS NULL OR ludy_kernel.ctx_actor_type() IS DISTINCT FROM 'user' OR NOT EXISTS (
    SELECT 1 FROM ludy_kernel.tenant_member m
     WHERE m.org_id = v_org AND m.user_id = ludy_kernel.ctx_user_id() AND m.role = 'owner'
  ) THEN
    RAISE EXCEPTION 'NOTES_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN (
    SELECT pg_catalog.count(*)::bigint
      FROM ludy_notes.attachment a
      JOIN ludy_notes.note n ON n.org_id = a.org_id AND n.id = a.note_id
     WHERE a.org_id = v_org
       AND n.visibility = 'private'
       AND a.extract_status = 'pending'
  );
END $$;

REVOKE ALL ON FUNCTION ludy_notes.private_pending_attachment_count() FROM PUBLIC;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT rolname
      FROM pg_catalog.pg_roles
     WHERE (rolname LIKE 'ludy\_%' OR rolname LIKE 'crove\_%' OR rolname IN ('anon', 'authenticated', 'service_role'))
       AND rolname <> current_user
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_notes.private_pending_attachment_count() FROM %I', r.rolname);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION ludy_notes.private_pending_attachment_count() TO ludy_tenant;
