-- SPDX-License-Identifier: AGPL-3.0-only
-- Notes v2 E2 (#3561, docs/plan/notes-v2.md V2-5, owner decision A3, ADR-0037):
-- isolated note attachments (<= 25 MiB), a full-text search vector of their own over file names
-- and extracted text (matched with the parent note's by the note search), narrow worker-only extraction definers, doomed blob queue for all
-- deletion paths, and PDPL private-item matching/notice/erasure coverage.
-- Never touches or references crove_kernel.file.
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- crove_notes.attachment (strictly isolated under parent note visibility)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS crove_notes.attachment (
  org_id         uuid NOT NULL,
  id             uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  note_id        uuid NOT NULL,
  author_user_id uuid NOT NULL,
  filename       text NOT NULL,
  content_type   text NOT NULL,
  size_bytes     integer NOT NULL,
  sha256         text NOT NULL,
  storage_key    text NOT NULL,
  extracted_text text,
  extract_status text NOT NULL DEFAULT 'pending',
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- The attachment's own search vector (file name and extracted text), written by its trigger. Kept here, not folded into
  -- crove_notes.note.search, so it stays behind this table's policy: a member's Vy reads their notes but none of their attachments.
  search         tsvector NOT NULL DEFAULT ''::tsvector,
  PRIMARY KEY (org_id, id),
  CONSTRAINT attachment_org_fk
    FOREIGN KEY (org_id) REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  CONSTRAINT attachment_note_fk
    FOREIGN KEY (org_id, note_id) REFERENCES crove_notes.note (org_id, id) ON DELETE CASCADE,
  CONSTRAINT attachment_filename_chk
    CHECK (pg_catalog.btrim(filename) <> '' AND pg_catalog.char_length(filename) <= 255),
  CONSTRAINT attachment_content_type_chk
    CHECK (pg_catalog.btrim(content_type) <> '' AND pg_catalog.char_length(content_type) <= 128),
  CONSTRAINT attachment_size_bytes_chk
    CHECK (size_bytes > 0 AND size_bytes <= 26214400),
  CONSTRAINT attachment_sha256_chk
    CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT attachment_storage_key_chk
    CHECK (storage_key = 'notes/' || org_id::text || '/' || id::text),
  CONSTRAINT attachment_extracted_text_chk
    CHECK (extracted_text IS NULL OR pg_catalog.char_length(extracted_text) <= 200000),
  CONSTRAINT attachment_extract_status_chk
    CHECK (extract_status IN ('pending', 'done', 'skipped', 'failed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS attachment_storage_key_uq
  ON crove_notes.attachment (org_id, storage_key);

CREATE INDEX IF NOT EXISTS attachment_note_idx
  ON crove_notes.attachment (org_id, note_id, created_at, id);

CREATE INDEX IF NOT EXISTS attachment_pending_idx
  ON crove_notes.attachment (created_at)
  WHERE extract_status = 'pending';

SELECT crove_kernel.apply_tenant_rls('crove_notes.attachment');

REVOKE ALL ON crove_notes.attachment FROM PUBLIC, crove_worker, crove_app, crove_definer_tenant;
REVOKE UPDATE ON crove_notes.attachment FROM crove_tenant;
GRANT SELECT, INSERT, DELETE ON crove_notes.attachment TO crove_tenant;

-- Read policy: inherits parent crove_notes.note visibility, and explicitly blocks all agent contexts
-- (not in crove_kernel.member_vy_table; MEMBER_VY_READS = false).
DROP POLICY IF EXISTS attachment_read ON crove_notes.attachment;
CREATE POLICY attachment_read ON crove_notes.attachment AS RESTRICTIVE FOR SELECT TO crove_tenant
  USING (
    (SELECT crove_kernel.ctx_agent_id()) IS NULL
    AND EXISTS (
      SELECT 1 FROM crove_notes.note n
       WHERE n.org_id = attachment.org_id
         AND n.id = attachment.note_id
    )
  );

-- Insert policy: active non-viewer (owner, admin, member), non-agent, and author of parent note.
DROP POLICY IF EXISTS attachment_insert ON crove_notes.attachment;
CREATE POLICY attachment_insert ON crove_notes.attachment AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK (
    (SELECT crove_kernel.ctx_agent_id()) IS NULL
    AND author_user_id = (SELECT crove_kernel.ctx_user_id())
    AND EXISTS (
      SELECT 1 FROM crove_kernel.tenant_member m
       WHERE m.org_id = attachment.org_id
         AND m.user_id = (SELECT crove_kernel.ctx_user_id())
         AND m.role IN ('owner', 'admin', 'member')
    )
    AND EXISTS (
      SELECT 1 FROM crove_notes.note n
       WHERE n.org_id = attachment.org_id
         AND n.id = attachment.note_id
         AND n.author_user_id = (SELECT crove_kernel.ctx_user_id())
    )
  );

-- Defense-in-depth update policy (UPDATE privilege is revoked from crove_tenant; worker extraction updates via definer).
DROP POLICY IF EXISTS attachment_update ON crove_notes.attachment;
CREATE POLICY attachment_update ON crove_notes.attachment AS RESTRICTIVE FOR UPDATE TO crove_tenant
  USING (
    (SELECT crove_kernel.ctx_agent_id()) IS NULL
    AND EXISTS (
      SELECT 1 FROM crove_kernel.tenant_member m
       WHERE m.org_id = attachment.org_id
         AND m.user_id = (SELECT crove_kernel.ctx_user_id())
         AND m.role IN ('owner', 'admin', 'member')
    )
    AND EXISTS (
      SELECT 1 FROM crove_notes.note n
       WHERE n.org_id = attachment.org_id
         AND n.id = attachment.note_id
         AND n.author_user_id = (SELECT crove_kernel.ctx_user_id())
    )
  )
  WITH CHECK (
    (SELECT crove_kernel.ctx_agent_id()) IS NULL
    AND EXISTS (
      SELECT 1 FROM crove_kernel.tenant_member m
       WHERE m.org_id = attachment.org_id
         AND m.user_id = (SELECT crove_kernel.ctx_user_id())
         AND m.role IN ('owner', 'admin', 'member')
    )
    AND EXISTS (
      SELECT 1 FROM crove_notes.note n
       WHERE n.org_id = attachment.org_id
         AND n.id = attachment.note_id
         AND n.author_user_id = (SELECT crove_kernel.ctx_user_id())
    )
  );

-- Delete policy: active non-viewer, non-agent, and either the parent note's author or an org owner/admin
-- with whole-org scope on a shared ('org') note (matching note_update / assertMayManage and PDPL shared-note erasure).
DROP POLICY IF EXISTS attachment_delete ON crove_notes.attachment;
CREATE POLICY attachment_delete ON crove_notes.attachment AS RESTRICTIVE FOR DELETE TO crove_tenant
  USING (
    (SELECT crove_kernel.ctx_agent_id()) IS NULL
    AND EXISTS (
      SELECT 1 FROM crove_kernel.tenant_member m
       WHERE m.org_id = attachment.org_id
         AND m.user_id = (SELECT crove_kernel.ctx_user_id())
         AND m.role IN ('owner', 'admin', 'member')
    )
    AND EXISTS (
      SELECT 1 FROM crove_notes.note n
       WHERE n.org_id = attachment.org_id
         AND n.id = attachment.note_id
         AND (
           n.author_user_id = (SELECT crove_kernel.ctx_user_id())
           OR (
             n.visibility = 'org'
             AND '*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[])
             AND EXISTS (
               SELECT 1 FROM crove_kernel.tenant_member m2
                WHERE m2.org_id = attachment.org_id
                  AND m2.user_id = (SELECT crove_kernel.ctx_user_id())
                  AND m2.role IN ('owner', 'admin')
             )
           )
         )
    )
  );

-- ---------------------------------------------------------------------------
-- Doomed blob queue (captures storage_key on every delete path, cascades included)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS crove_notes.attachment_blob_doomed (
  storage_key   text PRIMARY KEY CHECK (storage_key ~ '^notes/[0-9a-f-]{36}/[0-9a-f-]{36}$'),
  queued_at     timestamptz NOT NULL DEFAULT pg_catalog.now(),
  not_before    timestamptz NOT NULL DEFAULT pg_catalog.now(),
  claimed_until timestamptz,
  attempts      integer NOT NULL DEFAULT 0 CHECK (attempts >= 0)
);

CREATE INDEX IF NOT EXISTS attachment_blob_doomed_due_idx
  ON crove_notes.attachment_blob_doomed (not_before, queued_at);

REVOKE ALL ON crove_notes.attachment_blob_doomed FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
ALTER TABLE crove_notes.attachment_blob_doomed ENABLE ROW LEVEL SECURITY;
SELECT crove_kernel.agent_write_guard_install('crove_notes.attachment_blob_doomed');

CREATE OR REPLACE FUNCTION crove_notes.attachment_doom() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  INSERT INTO crove_notes.attachment_blob_doomed (storage_key, not_before)
  VALUES (OLD.storage_key, pg_catalog.now())
  ON CONFLICT (storage_key) DO NOTHING;
  RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION crove_notes.attachment_doom()
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

DROP TRIGGER IF EXISTS attachment_doom ON crove_notes.attachment;
CREATE TRIGGER attachment_doom AFTER DELETE ON crove_notes.attachment
  FOR EACH ROW EXECUTE FUNCTION crove_notes.attachment_doom();

CREATE OR REPLACE FUNCTION crove_notes.attachment_blob_claim(p_limit integer)
RETURNS TABLE (blob_key text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  -- The worker login's own sweep, outside any org, user or agent context (a Vy run on the worker login is refused).
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') OR crove_kernel.ctx_org_id() IS NOT NULL THEN
    RAISE EXCEPTION 'NOTES_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  WITH due AS (
    SELECT d.storage_key
      FROM crove_notes.attachment_blob_doomed d
     WHERE d.not_before <= pg_catalog.now()
       AND (d.claimed_until IS NULL OR d.claimed_until < pg_catalog.now())
     ORDER BY d.queued_at, d.storage_key
     LIMIT LEAST(GREATEST(p_limit, 1), 1000)
     FOR UPDATE SKIP LOCKED
  )
  UPDATE crove_notes.attachment_blob_doomed d
     SET claimed_until = pg_catalog.now() + pg_catalog.make_interval(mins => 5),
         attempts = d.attempts + 1
    FROM due
   WHERE d.storage_key = due.storage_key
  RETURNING d.storage_key;
END $$;

CREATE OR REPLACE FUNCTION crove_notes.attachment_blob_done(p_keys text[])
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') OR crove_kernel.ctx_org_id() IS NOT NULL THEN
    RAISE EXCEPTION 'NOTES_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  DELETE FROM crove_notes.attachment_blob_doomed d WHERE d.storage_key = ANY (p_keys);
END $$;

REVOKE ALL ON FUNCTION crove_notes.attachment_blob_claim(integer), crove_notes.attachment_blob_done(text[])
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_notes.attachment_blob_claim(integer), crove_notes.attachment_blob_done(text[])
  TO crove_worker;

-- ---------------------------------------------------------------------------
-- Full-text search of an attachment (file name and extracted text). The note search matches a note by its own vector
-- OR by one of its attachments' (modules/notes/src/notes.ts), the attachment read through this table's policy. The note's
-- own search vector and trigger are untouched, so editing a note never drops what its attachments add.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION crove_notes.attachment_search() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_names text := pg_catalog.left(COALESCE(NEW.filename, ''), 1024);
  v_texts text := pg_catalog.left(COALESCE(NEW.extracted_text, ''), 200000);
BEGIN
  BEGIN
    NEW.search := pg_catalog.setweight(crove_kernel.search_vector(v_names), 'C')
      || pg_catalog.setweight(pg_catalog.strip(crove_kernel.search_vector(v_texts)), 'D');
  EXCEPTION WHEN program_limit_exceeded THEN
    BEGIN
      NEW.search := pg_catalog.setweight(crove_kernel.search_vector(v_names), 'C')
        || pg_catalog.setweight(pg_catalog.strip(crove_kernel.search_vector(pg_catalog.left(v_texts, 32768))), 'D');
    EXCEPTION WHEN program_limit_exceeded THEN
      NEW.search := pg_catalog.setweight(crove_kernel.search_vector(v_names), 'C');
    END;
  END;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_notes.attachment_search()
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

DROP TRIGGER IF EXISTS b_search ON crove_notes.attachment;
CREATE TRIGGER b_search BEFORE INSERT OR UPDATE OF filename, extracted_text ON crove_notes.attachment
  FOR EACH ROW EXECUTE FUNCTION crove_notes.attachment_search();

CREATE INDEX IF NOT EXISTS attachment_search_idx
  ON crove_notes.attachment USING gin (search);

-- ---------------------------------------------------------------------------
-- Narrow worker-only extraction definers (never return note title, body or tags)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION crove_notes.attachment_for_extract(p_attachment_id uuid)
RETURNS TABLE (org_id uuid, id uuid, storage_key text, content_type text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'NOTES_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF v_org IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'system' THEN
    RAISE EXCEPTION 'NOTES_SYSTEM_CONTEXT' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT a.org_id, a.id, a.storage_key, a.content_type
      FROM crove_notes.attachment a
      JOIN crove_notes.note n ON n.org_id = a.org_id AND n.id = a.note_id
     WHERE a.org_id = v_org
       AND a.id = p_attachment_id
       AND a.extract_status = 'pending'
       AND n.deleted_at IS NULL;
END $$;

CREATE OR REPLACE FUNCTION crove_notes.attachment_record_extract(
  p_attachment_id uuid,
  p_status text,
  p_extracted_text text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_n bigint;
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'NOTES_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF v_org IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'system' THEN
    RAISE EXCEPTION 'NOTES_SYSTEM_CONTEXT' USING ERRCODE = '42501';
  END IF;
  IF p_status NOT IN ('done', 'skipped', 'failed') THEN
    RAISE EXCEPTION 'NOTES_EXTRACT_STATUS_INVALID' USING ERRCODE = '22023';
  END IF;

  UPDATE crove_notes.attachment a
     SET extract_status = p_status,
         extracted_text = CASE
           WHEN p_status = 'done' AND p_extracted_text IS NOT NULL AND pg_catalog.btrim(p_extracted_text) <> ''
             THEN pg_catalog.left(p_extracted_text, 200000)
           ELSE NULL
         END
   WHERE a.org_id = v_org
     AND a.id = p_attachment_id
     AND a.extract_status = 'pending';

  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n > 0;
END $$;

-- The attachments still waiting for their text 10 minutes after upload, outside the trash: the worker asks for them again
-- (a job dropped while Notes was off, or while the note was in the trash, is never sent twice otherwise). Ids only.
CREATE OR REPLACE FUNCTION crove_notes.attachment_extract_due(p_limit integer)
RETURNS TABLE (org_id uuid, id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') OR crove_kernel.ctx_org_id() IS NOT NULL THEN
    RAISE EXCEPTION 'NOTES_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT a.org_id, a.id
      FROM crove_notes.attachment a
      JOIN crove_notes.note n ON n.org_id = a.org_id AND n.id = a.note_id
     WHERE a.extract_status = 'pending'
       AND a.created_at < pg_catalog.now() - pg_catalog.make_interval(mins => 10)
       AND n.deleted_at IS NULL
     ORDER BY a.created_at, a.id
     LIMIT LEAST(GREATEST(p_limit, 1), 500);
END $$;
REVOKE ALL ON FUNCTION crove_notes.attachment_extract_due(integer)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_notes.attachment_extract_due(integer) TO crove_worker;

REVOKE ALL ON FUNCTION crove_notes.attachment_for_extract(uuid), crove_notes.attachment_record_extract(uuid, text, text)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_notes.attachment_for_extract(uuid), crove_notes.attachment_record_extract(uuid, text, text)
  TO crove_worker;

-- ---------------------------------------------------------------------------
-- PDPL private-item matching, notice and erasure extended for private attachments
-- (based verbatim on 20270111120000_crove_notes_todo_lists.sql, preserving todo_list)
-- ---------------------------------------------------------------------------

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
      SELECT n.author_user_id, 1, 0
        FROM crove_notes.attachment a
        JOIN crove_notes.note n ON n.org_id = a.org_id AND n.id = a.note_id
       WHERE a.org_id = v_org AND n.visibility = 'private'
         AND (crove_kernel.text_mentions(a.filename, p_kind, p_value)
              OR crove_kernel.text_mentions(a.extracted_text, p_kind, p_value))
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
    SELECT 'note_attachment'::text, a.id, n.author_user_id, CASE WHEN a.extract_status = 'done' THEN 2 ELSE 1 END
      FROM crove_notes.attachment a
      JOIN crove_notes.note n ON n.org_id = a.org_id AND n.id = a.note_id
     WHERE a.org_id = v_org AND n.visibility = 'private'
       AND (crove_kernel.text_mentions(a.filename, p_kind, p_value)
            OR crove_kernel.text_mentions(a.extracted_text, p_kind, p_value))
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
  v_attachments jsonb := '[]'::jsonb;
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

  -- Global lock DAG: todo_list[id ASC] -> todo[id ASC] before any DELETE so concurrent todoUpdate/todoComplete
  -- (which lock todo_list FOR SHARE before todo FOR UPDATE) and FK ON DELETE SET NULL stay deadlock-free.
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

  -- Erase matched notes and todos first so cascading attachments on deleted notes go cleanly.
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

  -- Erase matched private attachments on surviving private notes (triggering attachment_doom and search sync).
  WITH told AS (
    SELECT a.detail, a.actor_id FROM crove_kernel.audit_event a
     WHERE a.org_id = v_org AND a.command = 'kernel.personal_data.notify' AND a.outcome = 'ok'
       AND a.occurred_at <= pg_catalog.now() - interval '24 hours'
       AND pg_catalog.jsonb_typeof(a.detail) = 'object' AND a.detail ->> 'key' = v_key
  ),
  att_found AS (
    SELECT a.id, (CASE WHEN a.extract_status = 'done' THEN 2 ELSE 1 END) AS rev, n.author_user_id AS author,
           EXISTS (SELECT 1 FROM told
                    WHERE pg_catalog.jsonb_typeof(told.detail -> 'note_attachments') = 'array'
                      AND (told.detail -> 'note_attachments') ? (a.id::text || ':' || (CASE WHEN a.extract_status = 'done' THEN 2 ELSE 1 END)::text)
                      AND crove_notes.private_notice_told(v_org, n.author_user_id, told.actor_id, told.detail ->> 'event')) AS named
      FROM crove_notes.attachment a
      JOIN crove_notes.note n ON n.org_id = a.org_id AND n.id = a.note_id
     WHERE a.org_id = v_org AND n.visibility = 'private'
       AND (crove_kernel.text_mentions(a.filename, p_kind, p_value)
            OR crove_kernel.text_mentions(a.extracted_text, p_kind, p_value))
  ),
  att_gone AS (
    DELETE FROM crove_notes.attachment a USING att_found f
     WHERE a.org_id = v_org AND a.id = f.id
       AND (CASE WHEN a.extract_status = 'done' THEN 2 ELSE 1 END) = f.rev
       AND f.named
    RETURNING a.id, f.author
  ),
  att_counted AS (
    SELECT g.author, g.id, 'note'::text AS kind, true AS gone FROM att_gone g
    UNION ALL SELECT f.author, f.id, 'note', false FROM att_found f WHERE NOT EXISTS (SELECT 1 FROM att_gone g WHERE g.id = f.id)
  )
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'author', c.author, 'id', c.id, 'kind', c.kind, 'gone', c.gone
  )), '[]'::jsonb)
    INTO v_attachments
    FROM att_counted c;

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

  v_items := v_items || v_attachments || v_lists;

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

-- ---------------------------------------------------------------------------
-- Worker queue for asynchronous note attachment extraction
-- ---------------------------------------------------------------------------

SELECT crove_jobs.create_queue('notes-attachment-extract', '{"policy":"standard","deadLetter":"kernel-job.dlq"}'::jsonb);
