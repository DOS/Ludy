-- SPDX-License-Identifier: AGPL-3.0-only
-- eSign Slice 6c (#4722, docs/research/esign-slice6-proposal.md section 3.3):
-- multi-document signing packet (1-5 PDFs per envelope, per-document field targeting,
-- lazy doc 1 materialization, confidentiality & export guards, and unified public ceremony).
-- Idempotent; applied files stay untouched.

SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. ludy_sign.envelope_document table, constraints, indexes, and RLS
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ludy_sign.envelope_document (
  org_id uuid NOT NULL REFERENCES ludy_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT ludy_kernel.uuid_v7(),
  envelope_id uuid NOT NULL,
  doc_index smallint NOT NULL CHECK (doc_index BETWEEN 1 AND 5),
  title text NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(title)) BETWEEN 1 AND 300),
  file_id uuid NOT NULL,
  storage_key text NOT NULL CHECK (pg_catalog.length(storage_key) BETWEEN 1 AND 512),
  generation text NOT NULL CHECK (pg_catalog.length(generation) BETWEEN 1 AND 1028),
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  inspect_status text NOT NULL DEFAULT 'pending' CHECK (inspect_status IN ('pending', 'passed', 'failed')),
  inspect_error text CHECK (inspect_error IS NULL OR pg_catalog.length(inspect_error) <= 500),
  page_count integer CHECK (page_count IS NULL OR (page_count >= 1 AND page_count <= 200)),
  page_dimensions_json jsonb,
  detected_tags_json jsonb,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT envelope_document_org_envelope_id_uq UNIQUE (org_id, envelope_id, id),
  CONSTRAINT envelope_document_envelope_index_uq UNIQUE (org_id, envelope_id, doc_index) DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT envelope_document_envelope_fk FOREIGN KEY (org_id, envelope_id) REFERENCES ludy_sign.envelope (org_id, id) ON DELETE CASCADE,
  CONSTRAINT envelope_document_file_fk FOREIGN KEY (org_id, file_id) REFERENCES ludy_kernel.file (org_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS envelope_document_envelope_idx
  ON ludy_sign.envelope_document (org_id, envelope_id, doc_index, id);

CREATE INDEX IF NOT EXISTS envelope_document_file_idx
  ON ludy_sign.envelope_document (org_id, file_id);

CREATE INDEX IF NOT EXISTS envelope_document_inspect_pending_idx
  ON ludy_sign.envelope_document (org_id, updated_at, id)
  WHERE inspect_status = 'pending';

-- ---------------------------------------------------------------------------
-- 2. Extend confidentiality helpers before adding envelope_document RLS policies
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION ludy_sign.can_attach_confidential_source_file(
  p_org_id uuid,
  p_file_id uuid,
  p_source_kind text,
  p_source_id uuid,
  p_envelope_created_at timestamptz,
  p_allow_template boolean DEFAULT false
) RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
BEGIN
  IF v_org IS NULL OR p_org_id IS DISTINCT FROM v_org OR p_file_id IS NULL THEN
    RETURN false;
  END IF;
  IF p_source_kind NOT IN ('hr_contract', 'meeting_minutes') THEN
    RETURN false;
  END IF;

  IF EXISTS (
    SELECT 1 FROM ludy_sign.template t
    WHERE t.org_id = v_org AND t.source_file_id = p_file_id
  ) THEN
    IF NOT COALESCE(p_allow_template, false) THEN
      RETURN false;
    END IF;
    RETURN p_envelope_created_at IS NOT NULL AND EXISTS (
      SELECT 1 FROM ludy_sign.template t2
      WHERE t2.org_id = v_org
        AND t2.source_file_id = p_file_id
        AND t2.status <> 'archived'
        AND t2.created_at <= p_envelope_created_at
    );
  END IF;

  RETURN NOT EXISTS (
    SELECT 1 FROM ludy_sign.envelope e
    WHERE e.org_id = v_org
      AND (
        e.source_file_id = p_file_id
        OR EXISTS (
          SELECT 1 FROM ludy_sign.envelope_document ed
          WHERE ed.org_id = e.org_id
            AND ed.envelope_id = e.id
            AND ed.file_id = p_file_id
        )
      )
      AND (e.source_kind <> p_source_kind OR e.source_id IS DISTINCT FROM p_source_id)
  );
END $$;

CREATE OR REPLACE FUNCTION ludy_sign.can_attach_template_source(
  p_org_id uuid,
  p_template_id uuid,
  p_file_id uuid,
  p_storage_key text
) RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
BEGIN
  IF v_org IS NULL OR p_org_id IS DISTINCT FROM v_org OR p_file_id IS NULL OR p_storage_key IS NULL THEN
    RETURN false;
  END IF;

  RETURN NOT EXISTS (
    SELECT 1 FROM ludy_sign.envelope e
    WHERE e.org_id = v_org
      AND e.source_kind IN ('hr_contract', 'meeting_minutes')
      AND (
        (
          (e.source_file_id = p_file_id OR e.source_storage_key = p_storage_key)
          AND NOT EXISTS (
            SELECT 1 FROM ludy_sign.template t
            WHERE t.org_id = v_org
              AND t.id IS DISTINCT FROM p_template_id
              AND t.source_file_id = e.source_file_id
              AND t.source_storage_key = e.source_storage_key
              AND t.created_at <= e.created_at
          )
        )
        OR EXISTS (
          SELECT 1 FROM ludy_sign.envelope_document ed
          WHERE ed.org_id = e.org_id
            AND ed.envelope_id = e.id
            AND (ed.file_id = p_file_id OR ed.storage_key = p_storage_key)
            AND NOT EXISTS (
              SELECT 1 FROM ludy_sign.template t
              WHERE t.org_id = v_org
                AND t.id IS DISTINCT FROM p_template_id
                AND t.source_file_id = ed.file_id
                AND t.source_storage_key = ed.storage_key
                AND t.created_at <= e.created_at
            )
        )
      )
  );
END $$;

-- Check confidential packet document attachability against the parent envelope.
CREATE OR REPLACE FUNCTION ludy_sign.can_attach_envelope_document_file(
  p_org_id uuid,
  p_envelope_id uuid,
  p_file_id uuid,
  p_storage_key text
) RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_source_kind text;
  v_source_id uuid;
  v_source_file_id uuid;
  v_source_storage_key text;
  v_created_at timestamptz;
BEGIN
  IF v_org IS NULL
     OR p_org_id IS DISTINCT FROM v_org
     OR p_envelope_id IS NULL
     OR p_file_id IS NULL
     OR p_storage_key IS NULL THEN
    RETURN false;
  END IF;

  SELECT e.source_kind, e.source_id, e.source_file_id, e.source_storage_key, e.created_at
  INTO v_source_kind, v_source_id, v_source_file_id, v_source_storage_key, v_created_at
  FROM ludy_sign.envelope e
  WHERE e.org_id = v_org
    AND e.id = p_envelope_id;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF v_source_kind IN ('hr_contract', 'meeting_minutes') THEN
    -- Doc 1 lazy materialization mirrors the parent envelope (which envelope RLS already gates).
    IF p_file_id = v_source_file_id AND p_storage_key = v_source_storage_key THEN
      RETURN true;
    END IF;

    IF NOT ludy_sign.can_attach_confidential_source_file(
      v_org,
      p_file_id,
      v_source_kind,
      v_source_id,
      v_created_at,
      true
    ) THEN
      RETURN false;
    END IF;

    -- Also block mismatched storage_key reuse from an unrelated confidential envelope or document.
    RETURN NOT EXISTS (
      SELECT 1 FROM ludy_sign.envelope e
      WHERE e.org_id = v_org
        AND e.source_kind IN ('hr_contract', 'meeting_minutes')
        AND (e.source_kind <> v_source_kind OR e.source_id IS DISTINCT FROM v_source_id)
        AND (
          (
            (e.source_file_id = p_file_id OR e.source_storage_key = p_storage_key)
            AND NOT EXISTS (
              SELECT 1 FROM ludy_sign.template t
              WHERE t.org_id = v_org
                AND t.status <> 'archived'
                AND t.source_file_id = e.source_file_id
                AND t.source_storage_key = e.source_storage_key
                AND t.created_at <= e.created_at
            )
          )
          OR EXISTS (
            SELECT 1 FROM ludy_sign.envelope_document ed
            WHERE ed.org_id = e.org_id
              AND ed.envelope_id = e.id
              AND (ed.file_id = p_file_id OR ed.storage_key = p_storage_key)
              AND NOT EXISTS (
                SELECT 1 FROM ludy_sign.template t
                WHERE t.org_id = v_org
                  AND t.status <> 'archived'
                  AND t.source_file_id = ed.file_id
                  AND t.source_storage_key = ed.storage_key
                  AND t.created_at <= e.created_at
              )
          )
        )
    );
  END IF;

  -- Non-confidential parent envelope: refuse any file_id or storage_key referencing a confidential
  -- hr_contract or meeting_minutes envelope/document unless backed by a pre-existing non-archived template.
  RETURN NOT EXISTS (
    SELECT 1 FROM ludy_sign.envelope e
    WHERE e.org_id = v_org
      AND e.source_kind IN ('hr_contract', 'meeting_minutes')
      AND (
        (
          (e.source_file_id = p_file_id OR e.source_storage_key = p_storage_key)
          AND NOT EXISTS (
            SELECT 1 FROM ludy_sign.template t
            WHERE t.org_id = v_org
              AND t.status <> 'archived'
              AND t.source_file_id = e.source_file_id
              AND t.source_storage_key = e.source_storage_key
              AND t.created_at <= e.created_at
          )
        )
        OR EXISTS (
          SELECT 1 FROM ludy_sign.envelope_document ed
          WHERE ed.org_id = e.org_id
            AND ed.envelope_id = e.id
            AND (ed.file_id = p_file_id OR ed.storage_key = p_storage_key)
            AND NOT EXISTS (
              SELECT 1 FROM ludy_sign.template t
              WHERE t.org_id = v_org
                AND t.status <> 'archived'
                AND t.source_file_id = ed.file_id
                AND t.source_storage_key = ed.storage_key
                AND t.created_at <= e.created_at
            )
        )
      )
  );
END $$;

-- ---------------------------------------------------------------------------
-- 3. Tenant RLS and restrictive policies on ludy_sign.envelope_document
-- ---------------------------------------------------------------------------

SELECT ludy_kernel.apply_tenant_rls('ludy_sign.envelope_document');

DROP POLICY IF EXISTS writer_insert ON ludy_sign.envelope_document;
CREATE POLICY writer_insert ON ludy_sign.envelope_document AS RESTRICTIVE FOR INSERT TO ludy_tenant
  WITH CHECK (
    (SELECT ludy_kernel.ctx_actor_type()) IN ('system', 'agent')
    OR EXISTS (
      SELECT 1 FROM ludy_kernel.tenant_member m
      WHERE m.org_id = envelope_document.org_id
        AND m.user_id = (SELECT ludy_kernel.ctx_user_id())
        AND m.role IN ('owner', 'admin', 'member')
    )
  );

DROP POLICY IF EXISTS writer_update ON ludy_sign.envelope_document;
CREATE POLICY writer_update ON ludy_sign.envelope_document AS RESTRICTIVE FOR UPDATE TO ludy_tenant
  USING (
    (SELECT ludy_kernel.ctx_actor_type()) IN ('system', 'agent')
    OR EXISTS (
      SELECT 1 FROM ludy_kernel.tenant_member m
      WHERE m.org_id = envelope_document.org_id
        AND m.user_id = (SELECT ludy_kernel.ctx_user_id())
        AND m.role IN ('owner', 'admin', 'member')
    )
  )
  WITH CHECK (
    (SELECT ludy_kernel.ctx_actor_type()) IN ('system', 'agent')
    OR EXISTS (
      SELECT 1 FROM ludy_kernel.tenant_member m
      WHERE m.org_id = envelope_document.org_id
        AND m.user_id = (SELECT ludy_kernel.ctx_user_id())
        AND m.role IN ('owner', 'admin', 'member')
    )
  );

DROP POLICY IF EXISTS writer_delete ON ludy_sign.envelope_document;
CREATE POLICY writer_delete ON ludy_sign.envelope_document AS RESTRICTIVE FOR DELETE TO ludy_tenant
  USING (
    (SELECT ludy_kernel.ctx_actor_type()) IN ('system', 'agent')
    OR EXISTS (
      SELECT 1 FROM ludy_kernel.tenant_member m
      WHERE m.org_id = envelope_document.org_id
        AND m.user_id = (SELECT ludy_kernel.ctx_user_id())
        AND m.role IN ('owner', 'admin', 'member')
    )
  );

DROP POLICY IF EXISTS hr_contract_envelope_access ON ludy_sign.envelope_document;
CREATE POLICY hr_contract_envelope_access ON ludy_sign.envelope_document AS RESTRICTIVE FOR ALL TO ludy_tenant
  USING (
    EXISTS (
      SELECT 1 FROM ludy_sign.envelope e
      WHERE e.org_id = envelope_document.org_id
        AND e.id = envelope_document.envelope_id
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM ludy_sign.envelope e
      WHERE e.org_id = envelope_document.org_id
        AND e.id = envelope_document.envelope_id
    )
  );

DROP POLICY IF EXISTS confidential_source_insert ON ludy_sign.envelope_document;
CREATE POLICY confidential_source_insert ON ludy_sign.envelope_document AS RESTRICTIVE FOR INSERT TO ludy_tenant
  WITH CHECK (
    (SELECT ludy_kernel.ctx_actor_type()) = 'system'
    OR ludy_sign.can_attach_envelope_document_file(
      envelope_document.org_id,
      envelope_document.envelope_id,
      envelope_document.file_id,
      envelope_document.storage_key
    )
  );

DROP POLICY IF EXISTS confidential_source_update ON ludy_sign.envelope_document;
CREATE POLICY confidential_source_update ON ludy_sign.envelope_document AS RESTRICTIVE FOR UPDATE TO ludy_tenant
  WITH CHECK (
    (SELECT ludy_kernel.ctx_actor_type()) = 'system'
    OR ludy_sign.can_attach_envelope_document_file(
      envelope_document.org_id,
      envelope_document.envelope_id,
      envelope_document.file_id,
      envelope_document.storage_key
    )
  );

-- ---------------------------------------------------------------------------
-- 4. Nullable ludy_sign.field.document_id (NULL = doc 1 backward-compatible)
-- ---------------------------------------------------------------------------

ALTER TABLE ludy_sign.field
  ADD COLUMN IF NOT EXISTS document_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint c
    JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'ludy_sign'
      AND t.relname = 'field'
      AND c.conname = 'field_document_fk'
  ) THEN
    ALTER TABLE ludy_sign.field
      ADD CONSTRAINT field_document_fk
      FOREIGN KEY (org_id, document_id)
      REFERENCES ludy_sign.envelope_document (org_id, id)
      ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS field_document_fk_idx
  ON ludy_sign.field (org_id, document_id);

CREATE INDEX IF NOT EXISTS field_envelope_document_idx
  ON ludy_sign.field (org_id, envelope_id, document_id, page_number, id)
  WHERE document_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 5. Draft/system guards & packet aggregate sync
-- ---------------------------------------------------------------------------

-- Synchronize parent draft envelope inspect aggregate whenever envelope_document rows change.
CREATE OR REPLACE FUNCTION ludy_sign.envelope_document_sync()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := COALESCE(NEW.org_id, OLD.org_id);
  v_env_id uuid := COALESCE(NEW.envelope_id, OLD.envelope_id);
  v_env_status text;
  v_doc_count integer := 0;
  v_failed_error text;
  v_has_pending boolean := false;
  v_has_unpaged boolean := false;
  v_sum_pages integer := 0;
  v_dims jsonb := '[]'::jsonb;
  v_doc1_tags jsonb;
  v_next_status text;
  v_next_error text;
  v_next_pages integer;
  v_next_dims jsonb;
BEGIN
  IF v_org IS NULL OR v_env_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT e.status
  INTO v_env_status
  FROM ludy_sign.envelope e
  WHERE e.org_id = v_org
    AND e.id = v_env_id
  FOR UPDATE;

  IF NOT FOUND OR v_env_status IS DISTINCT FROM 'draft' THEN
    RETURN NULL;
  END IF;

  SELECT pg_catalog.count(*)::integer
  INTO v_doc_count
  FROM ludy_sign.envelope_document ed
  WHERE ed.org_id = v_org
    AND ed.envelope_id = v_env_id;

  IF v_doc_count = 0 THEN
    RETURN NULL;
  END IF;

  SELECT ed.inspect_error
  INTO v_failed_error
  FROM ludy_sign.envelope_document ed
  WHERE ed.org_id = v_org
    AND ed.envelope_id = v_env_id
    AND ed.inspect_status = 'failed'
  ORDER BY ed.doc_index ASC, ed.id ASC
  LIMIT 1;

  SELECT
    EXISTS (
      SELECT 1 FROM ludy_sign.envelope_document ed
      WHERE ed.org_id = v_org AND ed.envelope_id = v_env_id AND ed.inspect_status = 'pending'
    ),
    EXISTS (
      SELECT 1 FROM ludy_sign.envelope_document ed
      WHERE ed.org_id = v_org AND ed.envelope_id = v_env_id AND ed.page_count IS NULL
    ),
    COALESCE((
      SELECT pg_catalog.sum(ed.page_count)::integer
      FROM ludy_sign.envelope_document ed
      WHERE ed.org_id = v_org AND ed.envelope_id = v_env_id
    ), 0)
  INTO v_has_pending, v_has_unpaged, v_sum_pages;

  SELECT ed.detected_tags_json
  INTO v_doc1_tags
  FROM ludy_sign.envelope_document ed
  WHERE ed.org_id = v_org
    AND ed.envelope_id = v_env_id
  ORDER BY ed.doc_index ASC, ed.id ASC
  LIMIT 1;

  IF v_failed_error IS NOT NULL THEN
    v_next_status := 'failed';
    v_next_error := v_failed_error;
    v_next_pages := NULL;
    v_next_dims := NULL;
  ELSIF EXISTS (
    SELECT 1 FROM ludy_sign.envelope_document ed
    WHERE ed.org_id = v_org AND ed.envelope_id = v_env_id AND ed.inspect_status = 'failed'
  ) THEN
    v_next_status := 'failed';
    v_next_error := 'Tài liệu PDF không vượt qua kiểm tra';
    v_next_pages := NULL;
    v_next_dims := NULL;
  ELSIF v_has_pending OR v_has_unpaged THEN
    v_next_status := 'pending';
    v_next_error := NULL;
    v_next_pages := NULL;
    v_next_dims := NULL;
  ELSIF v_sum_pages < 1 OR v_sum_pages > 200 THEN
    v_next_status := 'failed';
    v_next_error := 'Tổng số trang của bộ tài liệu vượt quá giới hạn 200 trang';
    v_next_pages := NULL;
    v_next_dims := NULL;
  ELSE
    SELECT COALESCE(pg_catalog.jsonb_agg(elem ORDER BY ed.doc_index ASC, ord ASC), '[]'::jsonb)
    INTO v_dims
    FROM ludy_sign.envelope_document ed
    CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(COALESCE(ed.page_dimensions_json, '[]'::jsonb)) WITH ORDINALITY AS t(elem, ord)
    WHERE ed.org_id = v_org
      AND ed.envelope_id = v_env_id;

    v_next_status := 'passed';
    v_next_error := NULL;
    v_next_pages := v_sum_pages;
    v_next_dims := v_dims;
  END IF;

  PERFORM pg_catalog.set_config('ludy.sign_doc_sync', v_env_id::text, true);
  BEGIN
    UPDATE ludy_sign.envelope e
    SET inspect_status = v_next_status,
        inspect_error = v_next_error,
        page_count = v_next_pages,
        page_dimensions_json = v_next_dims,
        detected_tags_json = v_doc1_tags,
        updated_at = pg_catalog.now()
    WHERE e.org_id = v_org
      AND e.id = v_env_id
      AND e.status = 'draft';
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_catalog.set_config('ludy.sign_doc_sync', '', true);
    RAISE;
  END;
  PERFORM pg_catalog.set_config('ludy.sign_doc_sync', '', true);

  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION ludy_sign.envelope_document_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_actor text := ludy_kernel.ctx_actor_type();
  v_org uuid := COALESCE(OLD.org_id, NEW.org_id);
  v_env_id uuid := COALESCE(OLD.envelope_id, NEW.envelope_id);
  v_env_status text;
  v_env_sealed_file_id uuid;
  v_env_source_file_id uuid;
  v_env_source_storage_key text;
  v_env_source_generation text;
  v_env_source_sha256 text;
  v_env_inspect_status text;
  v_env_inspect_error text;
  v_env_page_count integer;
  v_env_page_dimensions_json jsonb;
  v_env_detected_tags_json jsonb;
  v_cleanup_owner oid := (SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.oid = 'ludy_sign.cleanup_meeting_minutes_envelopes(uuid,uuid,boolean,uuid[])'::pg_catalog.regprocedure);
  v_cur_role oid := (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = CURRENT_USER);
BEGIN
  IF v_actor IS NULL OR v_actor = 'system' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.org_id IS DISTINCT FROM ludy_kernel.ctx_org_id() THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND (pg_catalog.to_jsonb(OLD) - ARRAY['updated_at'])
         IS NOT DISTINCT FROM (pg_catalog.to_jsonb(NEW) - ARRAY['updated_at']) THEN
    RETURN NEW;
  END IF;

  SELECT
    e.status,
    e.sealed_file_id,
    e.source_file_id,
    e.source_storage_key,
    e.source_generation,
    e.source_sha256,
    e.inspect_status,
    e.inspect_error,
    e.page_count,
    e.page_dimensions_json,
    e.detected_tags_json
  INTO
    v_env_status,
    v_env_sealed_file_id,
    v_env_source_file_id,
    v_env_source_storage_key,
    v_env_source_generation,
    v_env_source_sha256,
    v_env_inspect_status,
    v_env_inspect_error,
    v_env_page_count,
    v_env_page_dimensions_json,
    v_env_detected_tags_json
  FROM ludy_sign.envelope e
  WHERE e.org_id = v_org
    AND e.id = v_env_id
  FOR UPDATE;

  IF TG_OP = 'DELETE' THEN
    IF v_env_status = 'draft' THEN
      RETURN OLD;
    END IF;
    IF v_env_status IS DISTINCT FROM 'completed'
       AND v_env_sealed_file_id IS NULL
       AND v_cleanup_owner IS NOT NULL
       AND v_cur_role = v_cleanup_owner
       AND pg_catalog.current_setting('ludy.sign_meeting_cleanup', true) = OLD.org_id::text THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'ENVELOPE_FROZEN' USING ERRCODE = '42501', DETAIL = 'documents cannot change after envelope leaves draft';
  END IF;

  IF v_env_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'ENVELOPE_FROZEN' USING ERRCODE = '42501', DETAIL = 'documents cannot change after envelope leaves draft';
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- Doc 1 lazy materialization mirrors the parent envelope's immutable source columns.
    IF (
      NEW.doc_index = 1
      AND NEW.file_id = v_env_source_file_id
      AND NEW.storage_key = v_env_source_storage_key
      AND NEW.generation = v_env_source_generation
      AND NEW.source_sha256 = v_env_source_sha256
      AND (
        (
          NEW.inspect_status = 'pending'
          AND NEW.inspect_error IS NULL
          AND NEW.page_count IS NULL
          AND NEW.page_dimensions_json IS NULL
          AND NEW.detected_tags_json IS NULL
        )
        OR (
          NEW.inspect_status IS NOT DISTINCT FROM v_env_inspect_status
          AND NEW.inspect_error IS NOT DISTINCT FROM v_env_inspect_error
          AND NEW.page_count IS NOT DISTINCT FROM v_env_page_count
          AND NEW.page_dimensions_json IS NOT DISTINCT FROM v_env_page_dimensions_json
          AND NEW.detected_tags_json IS NOT DISTINCT FROM v_env_detected_tags_json
        )
      )
    ) THEN
      RETURN NEW;
    END IF;

    IF NOT (
      NEW.inspect_status = 'pending'
      AND NEW.inspect_error IS NULL
      AND NEW.page_count IS NULL
      AND NEW.page_dimensions_json IS NULL
      AND NEW.detected_tags_json IS NULL
    ) THEN
      RAISE EXCEPTION 'ENVELOPE_DOCUMENT_SYSTEM_ONLY' USING ERRCODE = '42501', DETAIL = 'new packet documents start pending inspection unless lazily materialized from the draft envelope';
    END IF;

    -- Every newly attached packet document must bind storage_key, generation, and sha256 to a real sign_document PDF row.
    IF NOT EXISTS (
      SELECT 1 FROM ludy_kernel.file f
      WHERE f.org_id = NEW.org_id
        AND f.id = NEW.file_id
        AND f.source = 'sign_document'
        AND f.content_type = 'application/pdf'
        AND f.storage_key = NEW.storage_key
        AND f.generation = NEW.generation
        AND f.sha256 = NEW.source_sha256
    ) THEN
      RAISE EXCEPTION 'ENVELOPE_DOCUMENT_INVALID_FILE' USING ERRCODE = '42501', DETAIL = 'envelope document must match an uploaded PDF sign_document file row';
    END IF;

    RETURN NEW;
  END IF;

  -- UPDATE by tenant user while envelope is draft
  IF (NEW.org_id, NEW.id, NEW.envelope_id, NEW.file_id, NEW.storage_key, NEW.generation, NEW.source_sha256, NEW.created_at)
     IS DISTINCT FROM (OLD.org_id, OLD.id, OLD.envelope_id, OLD.file_id, OLD.storage_key, OLD.generation, OLD.source_sha256, OLD.created_at) THEN
    RAISE EXCEPTION 'ENVELOPE_DOCUMENT_IMMUTABLE' USING ERRCODE = '42501', DETAIL = 'document identity and source file columns are immutable';
  END IF;

  IF (NEW.inspect_status, NEW.inspect_error, NEW.page_count, NEW.page_dimensions_json, NEW.detected_tags_json)
     IS DISTINCT FROM (OLD.inspect_status, OLD.inspect_error, OLD.page_count, OLD.page_dimensions_json, OLD.detected_tags_json) THEN
    RAISE EXCEPTION 'ENVELOPE_DOCUMENT_SYSTEM_ONLY' USING ERRCODE = '42501', DETAIL = 'document inspection metadata is system-managed';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS envelope_document_guard ON ludy_sign.envelope_document;
CREATE TRIGGER envelope_document_guard
  BEFORE INSERT OR UPDATE OR DELETE ON ludy_sign.envelope_document
  FOR EACH ROW
  EXECUTE FUNCTION ludy_sign.envelope_document_guard();

DROP TRIGGER IF EXISTS envelope_document_sync ON ludy_sign.envelope_document;
CREATE TRIGGER envelope_document_sync
  AFTER INSERT OR UPDATE OR DELETE ON ludy_sign.envelope_document
  FOR EACH ROW
  EXECUTE FUNCTION ludy_sign.envelope_document_sync();

-- Update envelope_guard() to allow draft inspect sync from envelope_document_sync()
-- and verify every packet document passed inspection (<= 200 total pages) on send.
CREATE OR REPLACE FUNCTION ludy_sign.envelope_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_actor text := ludy_kernel.ctx_actor_type();
  v_old jsonb;
  v_new jsonb;
  v_keep text[] := ARRAY['version', 'updated_at'];
  v_cur_role oid := (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = CURRENT_USER);
  v_inherit_owner oid := (SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.oid = 'ludy_sign.template_inherit_inspect(uuid,uuid)'::pg_catalog.regprocedure);
  v_correct_owner oid := (SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.oid = 'ludy_sign.correct_signer_recipient(uuid,uuid,text,text,text,text,boolean,timestamptz)'::pg_catalog.regprocedure);
  v_cleanup_owner oid := (SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.oid = 'ludy_sign.cleanup_meeting_minutes_envelopes(uuid,uuid,boolean,uuid[])'::pg_catalog.regprocedure);
  v_doc_sync_owner oid := (SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.oid = 'ludy_sign.envelope_document_sync()'::pg_catalog.regprocedure);
  v_packet_pages integer := 0;
BEGIN
  IF v_actor IS NULL OR v_actor = 'system' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'ENVELOPE_FROZEN' USING ERRCODE = '42501', DETAIL = 'only a draft envelope can be deleted';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.org_id IS DISTINCT FROM ludy_kernel.ctx_org_id() THEN
      RETURN NEW;
    END IF;
    IF NEW.status <> 'draft' OR NEW.inspect_status <> 'pending' OR NEW.inspect_error IS NOT NULL
       OR NEW.direct_link_id IS NOT NULL
       OR NEW.page_count IS NOT NULL OR NEW.page_dimensions_json IS NOT NULL OR NEW.detected_tags_json IS NOT NULL
       OR NEW.seal_status IS NOT NULL
       OR NEW.sealed_file_id IS NOT NULL OR NEW.sealed_storage_key IS NOT NULL
       OR NEW.sealed_generation IS NOT NULL OR NEW.sealed_sha256 IS NOT NULL
       OR NEW.certificate_file_id IS NOT NULL OR NEW.certificate_storage_key IS NOT NULL
       OR NEW.certificate_generation IS NOT NULL OR NEW.certificate_sha256 IS NOT NULL
       OR NEW.certificate_code IS NOT NULL OR NEW.sent_at IS NOT NULL OR NEW.completed_at IS NOT NULL
       OR NEW.declined_at IS NOT NULL OR NEW.decline_acknowledged_at IS NOT NULL OR NEW.decline_acknowledged_by IS NOT NULL
       OR NEW.voided_at IS NOT NULL OR NEW.voided_by IS NOT NULL
       OR NEW.void_reason IS NOT NULL OR NEW.expired_at IS NOT NULL
       OR NEW.retained_org_visible IS NOT NULL OR NEW.retained_reader_ids IS NOT NULL THEN
      RAISE EXCEPTION 'ENVELOPE_FORBIDDEN' USING ERRCODE = '42501', DETAIL = 'an envelope starts as an uninspected draft without sealing or completion data';
    END IF;
    IF NEW.share_summary_with_signers IS TRUE OR NEW.shared_summary_json IS NOT NULL THEN
      IF v_actor <> 'user'
         OR ludy_kernel.ctx_agent_id() IS NOT NULL
         OR ludy_kernel.ctx_user_id() IS NULL
         OR NOT EXISTS (
           SELECT 1 FROM ludy_kernel.tenant_member m
           WHERE m.org_id = NEW.org_id
             AND m.user_id = ludy_kernel.ctx_user_id()
             AND m.role IN ('owner', 'admin', 'member')
             AND (m.role IN ('owner', 'admin') OR m.user_id = NEW.created_by)
         ) THEN
        RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501', DETAIL = 'only the envelope creator, owner, or admin can set the counterparty summary';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.org_id IS DISTINCT FROM ludy_kernel.ctx_org_id() THEN
    RETURN NEW;
  END IF;
  v_old := pg_catalog.to_jsonb(OLD) - v_keep;
  v_new := pg_catalog.to_jsonb(NEW) - v_keep;
  IF v_old IS NOT DISTINCT FROM v_new THEN
    RETURN NEW;
  END IF;
  IF (NEW.org_id, NEW.id, NEW.created_by, NEW.created_at,
      NEW.source_kind, NEW.source_id, NEW.source_revision, NEW.direct_link_id, NEW.source_file_id, NEW.source_storage_key, NEW.source_generation, NEW.source_sha256)
     IS DISTINCT FROM (OLD.org_id, OLD.id, OLD.created_by, OLD.created_at,
      OLD.source_kind, OLD.source_id, OLD.source_revision, OLD.direct_link_id, OLD.source_file_id, OLD.source_storage_key, OLD.source_generation, OLD.source_sha256) THEN
    RAISE EXCEPTION 'ENVELOPE_IMMUTABLE' USING ERRCODE = '42501', DETAIL = 'envelope identity and source document columns are immutable';
  END IF;
  IF OLD.status = 'draft'
     AND NEW.status = 'draft'
     AND v_inherit_owner IS NOT NULL
     AND v_cur_role = v_inherit_owner
     AND pg_catalog.current_setting('crove.sign_template_inherit', true) IS NOT DISTINCT FROM NEW.id::text
     AND OLD.inspect_status = 'pending'
     AND NEW.inspect_status = 'passed'
     AND NEW.page_count IS NOT NULL
     AND (pg_catalog.to_jsonb(OLD) - ARRAY['inspect_status', 'inspect_error', 'page_count', 'page_dimensions_json', 'detected_tags_json', 'updated_at'])
         IS NOT DISTINCT FROM (pg_catalog.to_jsonb(NEW) - ARRAY['inspect_status', 'inspect_error', 'page_count', 'page_dimensions_json', 'detected_tags_json', 'updated_at']) THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'draft'
     AND NEW.status = 'draft'
     AND v_doc_sync_owner IS NOT NULL
     AND v_cur_role = v_doc_sync_owner
     AND pg_catalog.current_setting('ludy.sign_doc_sync', true) = NEW.id::text
     AND (pg_catalog.to_jsonb(OLD) - ARRAY['inspect_status', 'inspect_error', 'page_count', 'page_dimensions_json', 'detected_tags_json', 'updated_at'])
         IS NOT DISTINCT FROM (pg_catalog.to_jsonb(NEW) - ARRAY['inspect_status', 'inspect_error', 'page_count', 'page_dimensions_json', 'detected_tags_json', 'updated_at']) THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'completed'
     AND NEW.status = 'completed'
     AND NEW.sealed_file_id IS NULL
     AND OLD.sealed_file_id IS NULL
     AND v_correct_owner IS NOT NULL
     AND v_cur_role = v_correct_owner
     AND pg_catalog.current_setting('crove.sign_correct_signer', true) = NEW.id::text
     AND (pg_catalog.to_jsonb(OLD) - ARRAY['completed_at', 'version', 'updated_at'])
         IS NOT DISTINCT FROM (pg_catalog.to_jsonb(NEW) - ARRAY['completed_at', 'version', 'updated_at']) THEN
    RETURN NEW;
  END IF;
  IF v_cleanup_owner IS NOT NULL
     AND v_cur_role = v_cleanup_owner
     AND pg_catalog.current_setting('ludy.sign_meeting_cleanup', true) = NEW.org_id::text
     AND OLD.source_kind = 'meeting_minutes' THEN
    IF OLD.status = 'completed'
       AND NEW.status = 'completed'
       AND OLD.retained_org_visible IS NULL
       AND OLD.retained_reader_ids IS NULL
       AND NEW.retained_org_visible IS NOT NULL
       AND NEW.retained_reader_ids IS NOT NULL
       AND (pg_catalog.to_jsonb(OLD) - ARRAY['retained_org_visible', 'retained_reader_ids', 'updated_at'])
           IS NOT DISTINCT FROM (pg_catalog.to_jsonb(NEW) - ARRAY['retained_org_visible', 'retained_reader_ids', 'updated_at']) THEN
      RETURN NEW;
    END IF;
    IF OLD.status <> 'completed'
       AND OLD.sealed_file_id IS NULL
       AND (
         (OLD.status IN ('draft', 'sent', 'in_progress')
          AND NEW.status = 'voided'
          AND NEW.voided_at IS NOT NULL
          AND NEW.void_reason = 'meeting_deleted')
         OR (OLD.status IN ('voided', 'expired', 'declined')
             AND NEW.status = OLD.status
             AND NEW.voided_at IS NOT DISTINCT FROM OLD.voided_at
             AND NEW.void_reason IS NULL)
       )
       AND NEW.title = '[Erased meeting minutes]'
       AND NEW.subject IS NULL
       AND NEW.message IS NULL
       AND NEW.inspect_error IS NULL
       AND NEW.detected_tags_json IS NULL
       AND NEW.share_summary_with_signers IS FALSE
       AND NEW.shared_summary_json IS NULL
       AND NEW.retained_org_visible IS NULL
       AND NEW.retained_reader_ids IS NULL
       AND (pg_catalog.to_jsonb(OLD) - ARRAY[
             'status', 'voided_at', 'void_reason', 'title', 'subject', 'message',
             'inspect_error', 'detected_tags_json', 'share_summary_with_signers',
             'shared_summary_json', 'version', 'updated_at'
           ])
           IS NOT DISTINCT FROM (pg_catalog.to_jsonb(NEW) - ARRAY[
             'status', 'voided_at', 'void_reason', 'title', 'subject', 'message',
             'inspect_error', 'detected_tags_json', 'share_summary_with_signers',
             'shared_summary_json', 'version', 'updated_at'
           ]) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF (NEW.inspect_status, NEW.inspect_error, NEW.page_count, NEW.page_dimensions_json, NEW.detected_tags_json,
      NEW.seal_status, NEW.sealed_file_id, NEW.sealed_storage_key, NEW.sealed_generation, NEW.sealed_sha256,
      NEW.certificate_file_id, NEW.certificate_storage_key, NEW.certificate_generation, NEW.certificate_sha256,
      NEW.certificate_code, NEW.completed_at, NEW.declined_at, NEW.expired_at,
      NEW.retained_org_visible, NEW.retained_reader_ids)
     IS DISTINCT FROM (OLD.inspect_status, OLD.inspect_error, OLD.page_count, OLD.page_dimensions_json, OLD.detected_tags_json,
      OLD.seal_status, OLD.sealed_file_id, OLD.sealed_storage_key, OLD.sealed_generation, OLD.sealed_sha256,
      OLD.certificate_file_id, OLD.certificate_storage_key, OLD.certificate_generation, OLD.certificate_sha256,
      OLD.certificate_code, OLD.completed_at, OLD.declined_at, OLD.expired_at,
      OLD.retained_org_visible, OLD.retained_reader_ids) THEN
    RAISE EXCEPTION 'ENVELOPE_SYSTEM_ONLY' USING ERRCODE = '42501', DETAIL = 'inspection, sealed, and completion metadata are system-managed';
  END IF;
  IF (NEW.share_summary_with_signers, NEW.shared_summary_json)
     IS DISTINCT FROM (OLD.share_summary_with_signers, OLD.shared_summary_json) THEN
    IF v_actor <> 'user'
       OR ludy_kernel.ctx_agent_id() IS NOT NULL
       OR ludy_kernel.ctx_user_id() IS NULL
       OR NOT EXISTS (
         SELECT 1 FROM ludy_kernel.tenant_member m
         WHERE m.org_id = NEW.org_id
           AND m.user_id = ludy_kernel.ctx_user_id()
           AND m.role IN ('owner', 'admin', 'member')
           AND (m.role IN ('owner', 'admin') OR m.user_id = OLD.created_by)
       ) THEN
      RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501', DETAIL = 'only the envelope creator, owner, or admin can update the counterparty summary';
    END IF;
  END IF;
  IF OLD.status = 'declined' AND NEW.status = 'declined' THEN
    IF OLD.decline_acknowledged_at IS NOT NULL
       OR NEW.decline_acknowledged_at IS NULL
       OR NEW.decline_acknowledged_by IS DISTINCT FROM ludy_kernel.ctx_user_id()
       OR (pg_catalog.to_jsonb(OLD) - ARRAY['decline_acknowledged_at', 'decline_acknowledged_by', 'version', 'updated_at'])
          IS DISTINCT FROM (pg_catalog.to_jsonb(NEW) - ARRAY['decline_acknowledged_at', 'decline_acknowledged_by', 'version', 'updated_at']) THEN
      RAISE EXCEPTION 'ENVELOPE_FROZEN' USING ERRCODE = '42501', DETAIL = 'only decline acknowledgment metadata can change once on a declined envelope';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status IN ('draft', 'sent', 'in_progress') AND NEW.status = 'voided' THEN
    IF NEW.voided_at IS NULL OR (pg_catalog.to_jsonb(OLD) - ARRAY['status', 'voided_at', 'voided_by', 'void_reason', 'version', 'updated_at'])
       IS DISTINCT FROM (pg_catalog.to_jsonb(NEW) - ARRAY['status', 'voided_at', 'voided_by', 'void_reason', 'version', 'updated_at']) THEN
      RAISE EXCEPTION 'ENVELOPE_FROZEN' USING ERRCODE = '42501', DETAIL = 'only void metadata can change when voiding';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'draft' THEN
    IF NEW.status = 'draft' THEN
      IF (NEW.sent_at, NEW.voided_at, NEW.voided_by, NEW.void_reason, NEW.decline_acknowledged_at, NEW.decline_acknowledged_by)
         IS DISTINCT FROM (OLD.sent_at, OLD.voided_at, OLD.voided_by, OLD.void_reason, OLD.decline_acknowledged_at, OLD.decline_acknowledged_by) THEN
        RAISE EXCEPTION 'ENVELOPE_SYSTEM_ONLY' USING ERRCODE = '42501', DETAIL = 'lifecycle timestamps cannot be modified on a draft';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW.status = 'sent' THEN
      IF OLD.inspect_status <> 'passed' THEN
        RAISE EXCEPTION 'ENVELOPE_NOT_INSPECTED' USING ERRCODE = '42501', DETAIL = 'source PDF must pass inspection before sending';
      END IF;
      IF EXISTS (
        SELECT 1 FROM ludy_sign.envelope_document ed
        WHERE ed.org_id = NEW.org_id
          AND ed.envelope_id = NEW.id
          AND (ed.inspect_status <> 'passed' OR ed.page_count IS NULL)
      ) THEN
        RAISE EXCEPTION 'ENVELOPE_NOT_INSPECTED' USING ERRCODE = '42501', DETAIL = 'all packet documents must pass inspection before sending';
      END IF;
      SELECT COALESCE(pg_catalog.sum(ed.page_count)::integer, 0)
      INTO v_packet_pages
      FROM ludy_sign.envelope_document ed
      WHERE ed.org_id = NEW.org_id
        AND ed.envelope_id = NEW.id;
      IF v_packet_pages > 200 THEN
        RAISE EXCEPTION 'ENVELOPE_NOT_INSPECTED' USING ERRCODE = '42501', DETAIL = 'packet page count exceeds 200 pages';
      END IF;
      IF NEW.sent_at IS NULL OR (pg_catalog.to_jsonb(OLD) - ARRAY['status', 'sent_at', 'version', 'updated_at'])
         IS DISTINCT FROM (pg_catalog.to_jsonb(NEW) - ARRAY['status', 'sent_at', 'version', 'updated_at']) THEN
        RAISE EXCEPTION 'ENVELOPE_FROZEN' USING ERRCODE = '42501', DETAIL = 'only status and sent_at can change when sending';
      END IF;
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'ENVELOPE_INVALID_TRANSITION' USING ERRCODE = '42501', DETAIL = 'draft envelope can only move to sent or voided';
  END IF;
  IF OLD.status IN ('sent', 'in_progress') AND NEW.status = OLD.status THEN
    IF (pg_catalog.to_jsonb(OLD) - ARRAY['share_summary_with_signers', 'shared_summary_json', 'version', 'updated_at'])
       IS NOT DISTINCT FROM (pg_catalog.to_jsonb(NEW) - ARRAY['share_summary_with_signers', 'shared_summary_json', 'version', 'updated_at']) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'ENVELOPE_FROZEN' USING ERRCODE = '42501', DETAIL = 'envelope is frozen after leaving draft';
END $$;

-- Update field_guard(): validate non-null document_id belongs to the same (org_id, envelope_id)
-- and page_number stays within that document's inspected page_count when known.
CREATE OR REPLACE FUNCTION ludy_sign.field_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_actor text := ludy_kernel.ctx_actor_type();
  v_env_id uuid := COALESCE(OLD.envelope_id, NEW.envelope_id);
  v_org uuid := COALESCE(OLD.org_id, NEW.org_id);
  v_env_status text;
  v_env_sealed_file_id uuid;
  v_doc_env_id uuid;
  v_doc_page_count integer;
  v_erase_owner oid := (SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.oid = 'ludy_sign.personal_erase_unsealed_signers(text,text)'::pg_catalog.regprocedure);
  v_kyc_erase_owner oid := (SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.oid = 'ludy_sign.personal_data_erase_kyc_check_summary(text,text)'::pg_catalog.regprocedure);
  v_preserve_owner oid := (SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.oid = 'ludy_sign.preserve_draft_field_text_defaults(uuid,jsonb)'::pg_catalog.regprocedure);
  v_cleanup_owner oid := (SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.oid = 'ludy_sign.cleanup_meeting_minutes_envelopes(uuid,uuid,boolean,uuid[])'::pg_catalog.regprocedure);
  v_cur_role oid := (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = CURRENT_USER);
BEGIN
  IF v_actor IS NULL OR v_actor = 'system' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.org_id IS DISTINCT FROM ludy_kernel.ctx_org_id() THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND (pg_catalog.to_jsonb(OLD) - ARRAY['updated_at']) IS NOT DISTINCT FROM (pg_catalog.to_jsonb(NEW) - ARRAY['updated_at']) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.org_id, NEW.id, NEW.envelope_id, NEW.created_at) IS DISTINCT FROM (OLD.org_id, OLD.id, OLD.envelope_id, OLD.created_at) THEN
    RAISE EXCEPTION 'FIELD_IMMUTABLE' USING ERRCODE = '42501';
  END IF;
  SELECT e.status, e.sealed_file_id INTO v_env_status, v_env_sealed_file_id
  FROM ludy_sign.envelope e WHERE e.org_id = v_org AND e.id = v_env_id FOR SHARE;
  IF TG_OP = 'DELETE' THEN
    IF v_env_status = 'draft' THEN
      RETURN OLD;
    END IF;
    IF v_env_status IS DISTINCT FROM 'completed'
       AND v_env_sealed_file_id IS NULL
       AND v_cleanup_owner IS NOT NULL
       AND v_cur_role = v_cleanup_owner
       AND pg_catalog.current_setting('ludy.sign_meeting_cleanup', true) = OLD.org_id::text THEN
      RETURN OLD;
    END IF;
    IF v_env_status IN ('voided', 'expired', 'declined')
       AND v_env_sealed_file_id IS NULL
       AND v_cur_role = v_erase_owner
       AND pg_catalog.current_setting('crove.sign_personal_erase', true) = OLD.org_id::text
       AND v_actor = 'user'
       AND ludy_kernel.ctx_agent_id() IS NULL
       AND ludy_kernel.ctx_org_id() = OLD.org_id
       AND EXISTS (
         SELECT 1 FROM ludy_kernel.tenant_member m
         WHERE m.org_id = OLD.org_id AND m.user_id = ludy_kernel.ctx_user_id() AND m.role = 'owner'
       ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'ENVELOPE_FROZEN' USING ERRCODE = '42501', DETAIL = 'fields cannot change after envelope is sent';
  END IF;
  IF TG_OP = 'UPDATE'
     AND v_env_status IN ('draft', 'voided', 'expired', 'declined')
     AND v_env_sealed_file_id IS NULL
     AND v_kyc_erase_owner IS NOT NULL
     AND v_cur_role = v_kyc_erase_owner
     AND pg_catalog.current_setting('ludy.sign_kyc_erase', true) = OLD.org_id::text
     AND v_actor = 'user'
     AND ludy_kernel.ctx_agent_id() IS NULL
     AND ludy_kernel.ctx_org_id() = OLD.org_id
     AND EXISTS (
       SELECT 1 FROM ludy_kernel.tenant_member m
       WHERE m.org_id = OLD.org_id AND m.user_id = ludy_kernel.ctx_user_id() AND m.role = 'owner'
     )
     AND OLD.field_type = 'attachment'
     AND NEW.field_type = 'attachment'
     AND NEW.attachment_file_id IS NULL
     AND NEW.attachment_filename IS NULL
     AND NEW.attachment_content_type IS NULL
     AND NEW.attachment_size_bytes IS NULL
     AND NEW.attachment_sha256 IS NULL
     AND NEW.filled_at IS NULL
     AND (pg_catalog.to_jsonb(OLD) - ARRAY[
       'attachment_file_id', 'attachment_filename', 'attachment_content_type',
       'attachment_size_bytes', 'attachment_sha256', 'filled_at', 'updated_at'
     ]) IS NOT DISTINCT FROM (pg_catalog.to_jsonb(NEW) - ARRAY[
       'attachment_file_id', 'attachment_filename', 'attachment_content_type',
       'attachment_size_bytes', 'attachment_sha256', 'filled_at', 'updated_at'
     ]) THEN
    RETURN NEW;
  END IF;
  IF v_env_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'ENVELOPE_FROZEN' USING ERRCODE = '42501', DETAIL = 'fields cannot change after envelope is sent';
  END IF;
  IF NEW.document_id IS NOT NULL THEN
    SELECT ed.envelope_id, ed.page_count
    INTO v_doc_env_id, v_doc_page_count
    FROM ludy_sign.envelope_document ed
    WHERE ed.org_id = v_org
      AND ed.id = NEW.document_id
    FOR SHARE;
    IF NOT FOUND OR v_doc_env_id IS DISTINCT FROM v_env_id THEN
      RAISE EXCEPTION 'FIELD_INVALID_DOCUMENT' USING ERRCODE = '23514', DETAIL = 'field document_id must belong to the same envelope';
    END IF;
    IF v_doc_page_count IS NOT NULL AND NEW.page_number > v_doc_page_count THEN
      RAISE EXCEPTION 'FIELD_PAGE_OUT_OF_RANGE' USING ERRCODE = '23514', DETAIL = 'field page_number exceeds inspected document page_count';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW.field_type = 'text'
     AND OLD.field_type = 'text'
     AND NEW.filled_at IS NULL
     AND NEW.value_checked IS NULL
     AND NEW.signature_png_base64 IS NULL
     AND NEW.attachment_file_id IS NULL
     AND v_cur_role = v_preserve_owner
     AND pg_catalog.current_setting('ludy.sign_preserve_text_defaults', true) = NEW.envelope_id::text THEN
    RETURN NEW;
  END IF;
  IF NEW.value_text IS NOT NULL
     OR NEW.value_checked IS NOT NULL
     OR NEW.signature_png_base64 IS NOT NULL
     OR NEW.attachment_file_id IS NOT NULL
     OR NEW.attachment_filename IS NOT NULL
     OR NEW.attachment_content_type IS NOT NULL
     OR NEW.attachment_size_bytes IS NOT NULL
     OR NEW.attachment_sha256 IS NOT NULL
     OR NEW.filled_at IS NOT NULL THEN
    RAISE EXCEPTION 'FIELD_SYSTEM_ONLY' USING ERRCODE = '42501', DETAIL = 'field values and attachments are filled only through public signing';
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- 6. Extend file visibility, exportability, and meeting-deletion cleanup
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION ludy_sign.can_read_sign_file(p_file_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_actor text := ludy_kernel.ctx_actor_type();
  v_user uuid := ludy_kernel.ctx_user_id();
  v_role text;
BEGIN
  IF v_org IS NULL OR v_actor IS NULL OR p_file_id IS NULL THEN
    RETURN false;
  END IF;
  IF v_actor = 'system' THEN
    RETURN true;
  END IF;
  IF v_actor <> 'user' OR v_user IS NULL THEN
    RETURN false;
  END IF;

  SELECT m.role INTO v_role
  FROM ludy_kernel.tenant_member m
  WHERE m.org_id = v_org AND m.user_id = v_user;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF EXISTS (
    SELECT 1 FROM ludy_kernel.file f
    WHERE f.org_id = v_org
      AND f.id = p_file_id
      AND f.source = 'sign_attachment'
  ) AND NOT EXISTS (
    SELECT 1 FROM ludy_sign.field fld
    WHERE fld.org_id = v_org
      AND fld.attachment_file_id = p_file_id
  ) THEN
    RETURN false;
  END IF;

  IF EXISTS (
    SELECT 1 FROM ludy_sign.envelope e
    WHERE e.org_id = v_org
      AND (
        e.sealed_file_id = p_file_id
        OR e.certificate_file_id = p_file_id
        OR EXISTS (
          SELECT 1 FROM ludy_sign.ca_signing_request r
          WHERE r.org_id = e.org_id
            AND r.envelope_id = e.id
            AND r.pades_file_id = p_file_id
        )
        OR EXISTS (
          SELECT 1 FROM ludy_sign.field fld
          WHERE fld.org_id = e.org_id
            AND fld.envelope_id = e.id
            AND fld.attachment_file_id = p_file_id
        )
      )
      AND (
        (e.source_kind = 'hr_contract' AND v_role NOT IN ('owner', 'admin') AND e.created_by <> v_user)
        OR (
          e.source_kind = 'meeting_minutes'
          AND NOT ludy_sign.can_access_meeting_minutes_envelope_row(
            v_org,
            e.source_id,
            e.created_by,
            e.status,
            e.retained_org_visible,
            e.retained_reader_ids
          )
        )
      )
  ) THEN
    RETURN false;
  END IF;

  IF EXISTS (
    SELECT 1 FROM ludy_sign.envelope e
    WHERE e.org_id = v_org
      AND (
        e.sealed_file_id = p_file_id
        OR e.certificate_file_id = p_file_id
        OR EXISTS (
          SELECT 1 FROM ludy_sign.ca_signing_request r
          WHERE r.org_id = e.org_id
            AND r.envelope_id = e.id
            AND r.pades_file_id = p_file_id
        )
        OR EXISTS (
          SELECT 1 FROM ludy_sign.field fld
          WHERE fld.org_id = e.org_id
            AND fld.envelope_id = e.id
            AND fld.attachment_file_id = p_file_id
        )
      )
  ) THEN
    RETURN true;
  END IF;

  IF EXISTS (
    SELECT 1 FROM ludy_sign.template t
    WHERE t.org_id = v_org
      AND t.source_file_id = p_file_id
  ) AND NOT EXISTS (
    SELECT 1 FROM ludy_sign.envelope e
    WHERE e.org_id = v_org
      AND (
        e.source_file_id = p_file_id
        OR EXISTS (
          SELECT 1 FROM ludy_sign.envelope_document ed
          WHERE ed.org_id = e.org_id
            AND ed.envelope_id = e.id
            AND ed.file_id = p_file_id
        )
      )
      AND e.source_kind IN ('hr_contract', 'meeting_minutes')
      AND NOT EXISTS (
        SELECT 1 FROM ludy_sign.template t2
        WHERE t2.org_id = v_org
          AND t2.source_file_id = p_file_id
          AND t2.created_at <= e.created_at
      )
  ) THEN
    RETURN true;
  END IF;

  IF EXISTS (
    SELECT 1 FROM ludy_sign.envelope e
    WHERE e.org_id = v_org
      AND (
        e.source_file_id = p_file_id
        OR EXISTS (
          SELECT 1 FROM ludy_sign.envelope_document ed
          WHERE ed.org_id = e.org_id
            AND ed.envelope_id = e.id
            AND ed.file_id = p_file_id
        )
      )
      AND (
        (e.source_kind = 'hr_contract' AND v_role NOT IN ('owner', 'admin') AND e.created_by <> v_user)
        OR (
          e.source_kind = 'meeting_minutes'
          AND NOT ludy_sign.can_access_meeting_minutes_envelope_row(
            v_org,
            e.source_id,
            e.created_by,
            e.status,
            e.retained_org_visible,
            e.retained_reader_ids
          )
        )
      )
  ) THEN
    RETURN false;
  END IF;

  IF EXISTS (
    SELECT 1 FROM ludy_sign.envelope e
    WHERE e.org_id = v_org
      AND (
        e.source_file_id = p_file_id
        OR EXISTS (
          SELECT 1 FROM ludy_sign.envelope_document ed
          WHERE ed.org_id = e.org_id
            AND ed.envelope_id = e.id
            AND ed.file_id = p_file_id
        )
      )
  ) THEN
    RETURN true;
  END IF;

  RETURN EXISTS (
    SELECT 1 FROM ludy_kernel.file f
    WHERE f.org_id = v_org
      AND f.id = p_file_id
      AND f.source = 'sign_document'
      AND f.created_by = v_user
  );
END $$;

CREATE OR REPLACE FUNCTION ludy_sign.is_exportable_sign_file(
  p_org_id uuid,
  p_file_id uuid,
  p_source text
) RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_actor text := ludy_kernel.ctx_actor_type();
  v_user uuid := ludy_kernel.ctx_user_id();
BEGIN
  IF v_org IS NULL OR p_org_id IS DISTINCT FROM v_org OR p_file_id IS NULL OR v_actor IS NULL THEN
    RETURN false;
  END IF;
  IF v_actor <> 'system' THEN
    IF v_actor <> 'user' OR v_user IS NULL OR NOT EXISTS (
      SELECT 1 FROM ludy_kernel.tenant_member m
      WHERE m.org_id = v_org AND m.user_id = v_user AND m.role = 'owner'
    ) THEN
      RETURN false;
    END IF;
  END IF;

  IF p_source IS DISTINCT FROM 'sign_document'
     AND p_source IS DISTINCT FROM 'sign_sealed'
     AND p_source IS DISTINCT FROM 'sign_certificate'
     AND p_source IS DISTINCT FROM 'sign_attachment'
     AND NOT EXISTS (
       SELECT 1 FROM ludy_sign.envelope e
       WHERE e.org_id = v_org
         AND (
           e.source_file_id = p_file_id
           OR EXISTS (
             SELECT 1 FROM ludy_sign.envelope_document ed
             WHERE ed.org_id = e.org_id
               AND ed.envelope_id = e.id
               AND ed.file_id = p_file_id
           )
           OR e.sealed_file_id = p_file_id
           OR e.certificate_file_id = p_file_id
           OR EXISTS (
             SELECT 1 FROM ludy_sign.ca_signing_request r
             WHERE r.org_id = e.org_id
               AND r.envelope_id = e.id
               AND r.pades_file_id = p_file_id
           )
           OR EXISTS (
             SELECT 1 FROM ludy_sign.field fld
             WHERE fld.org_id = e.org_id
               AND fld.envelope_id = e.id
               AND fld.attachment_file_id = p_file_id
           )
         )
     ) THEN
    RETURN true;
  END IF;

  IF p_source = 'sign_attachment'
     AND NOT EXISTS (
       SELECT 1 FROM ludy_sign.field fld
       WHERE fld.org_id = v_org
         AND fld.attachment_file_id = p_file_id
     ) THEN
    RETURN false;
  END IF;

  IF EXISTS (
    SELECT 1 FROM ludy_sign.envelope e
    WHERE e.org_id = v_org
      AND (
        e.sealed_file_id = p_file_id
        OR e.certificate_file_id = p_file_id
        OR EXISTS (
          SELECT 1 FROM ludy_sign.ca_signing_request r
          WHERE r.org_id = e.org_id
            AND r.envelope_id = e.id
            AND r.pades_file_id = p_file_id
        )
        OR EXISTS (
          SELECT 1 FROM ludy_sign.field fld
          WHERE fld.org_id = e.org_id
            AND fld.envelope_id = e.id
            AND fld.attachment_file_id = p_file_id
        )
      )
      AND NOT ludy_sign.is_exportable_envelope_id(v_org, e.id)
  ) THEN
    RETURN false;
  END IF;

  IF EXISTS (
    SELECT 1 FROM ludy_sign.envelope e
    WHERE e.org_id = v_org
      AND (
        e.sealed_file_id = p_file_id
        OR e.certificate_file_id = p_file_id
        OR EXISTS (
          SELECT 1 FROM ludy_sign.ca_signing_request r
          WHERE r.org_id = e.org_id
            AND r.envelope_id = e.id
            AND r.pades_file_id = p_file_id
        )
        OR EXISTS (
          SELECT 1 FROM ludy_sign.field fld
          WHERE fld.org_id = e.org_id
            AND fld.envelope_id = e.id
            AND fld.attachment_file_id = p_file_id
        )
      )
  ) THEN
    RETURN true;
  END IF;

  IF EXISTS (
    SELECT 1 FROM ludy_sign.template t
    WHERE t.org_id = v_org
      AND t.source_file_id = p_file_id
  ) AND NOT EXISTS (
    SELECT 1 FROM ludy_sign.envelope e
    WHERE e.org_id = v_org
      AND (
        e.source_file_id = p_file_id
        OR EXISTS (
          SELECT 1 FROM ludy_sign.envelope_document ed
          WHERE ed.org_id = e.org_id
            AND ed.envelope_id = e.id
            AND ed.file_id = p_file_id
        )
      )
      AND NOT ludy_sign.is_exportable_envelope_id(v_org, e.id)
      AND NOT EXISTS (
        SELECT 1 FROM ludy_sign.template t2
        WHERE t2.org_id = v_org
          AND t2.source_file_id = p_file_id
          AND t2.created_at <= e.created_at
      )
  ) THEN
    RETURN true;
  END IF;

  IF EXISTS (
    SELECT 1 FROM ludy_sign.envelope e
    WHERE e.org_id = v_org
      AND (
        e.source_file_id = p_file_id
        OR EXISTS (
          SELECT 1 FROM ludy_sign.envelope_document ed
          WHERE ed.org_id = e.org_id
            AND ed.envelope_id = e.id
            AND ed.file_id = p_file_id
        )
      )
      AND NOT ludy_sign.is_exportable_envelope_id(v_org, e.id)
      AND NOT EXISTS (
        SELECT 1 FROM ludy_sign.envelope e2
        WHERE e2.org_id = v_org
          AND (
            e2.source_file_id = p_file_id
            OR EXISTS (
              SELECT 1 FROM ludy_sign.envelope_document ed2
              WHERE ed2.org_id = e2.org_id
                AND ed2.envelope_id = e2.id
                AND ed2.file_id = p_file_id
            )
          )
          AND e2.source_kind = e.source_kind
          AND e2.source_id IS NOT DISTINCT FROM e.source_id
          AND ludy_sign.is_exportable_envelope_id(v_org, e2.id)
      )
  ) THEN
    RETURN false;
  END IF;

  IF EXISTS (
    SELECT 1 FROM ludy_sign.envelope e
    WHERE e.org_id = v_org
      AND (
        e.source_file_id = p_file_id
        OR EXISTS (
          SELECT 1 FROM ludy_sign.envelope_document ed
          WHERE ed.org_id = e.org_id
            AND ed.envelope_id = e.id
            AND ed.file_id = p_file_id
        )
      )
  ) THEN
    RETURN true;
  END IF;

  RETURN EXISTS (
    SELECT 1 FROM ludy_kernel.file f
    JOIN ludy_kernel.tenant_member m
      ON m.org_id = f.org_id AND m.user_id = f.created_by
    WHERE f.org_id = v_org
      AND f.id = p_file_id
      AND f.source = 'sign_document'
      AND m.role = 'owner'
  );
END $$;

CREATE OR REPLACE FUNCTION ludy_sign.cleanup_meeting_minutes_envelopes(
  p_org_id uuid,
  p_meeting_id uuid,
  p_org_visible boolean,
  p_reader_ids uuid[]
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_ctx_org uuid := ludy_kernel.ctx_org_id();
  v_now timestamptz := pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp());
  v_occurred_iso text := pg_catalog.to_char(v_now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_completed_ids uuid[] := '{}'::uuid[];
  v_unsigned_ids uuid[] := '{}'::uuid[];
  v_env record;
  v_next_seq integer;
  v_prev_hash text;
  v_prev_json text;
  v_canonical text;
  v_event_hash text;
BEGIN
  IF p_org_id IS NULL OR p_meeting_id IS NULL THEN
    RETURN;
  END IF;
  IF v_ctx_org IS NOT NULL AND v_ctx_org IS DISTINCT FROM p_org_id THEN
    RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF pg_catalog.current_setting('ludy.org_purge', true) = p_org_id::text THEN
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM ludy_sign.envelope e
    WHERE e.org_id = p_org_id
      AND e.source_kind = 'meeting_minutes'
      AND e.source_id = p_meeting_id
  ) THEN
    RETURN;
  END IF;

  FOR v_env IN
    SELECT e.id, e.status, e.source_sha256, e.retained_reader_ids
    FROM ludy_sign.envelope e
    WHERE e.org_id = p_org_id
      AND e.source_kind = 'meeting_minutes'
      AND e.source_id = p_meeting_id
    ORDER BY e.id
    FOR UPDATE OF e
  LOOP
    IF v_env.status = 'completed' THEN
      v_completed_ids := pg_catalog.array_append(v_completed_ids, v_env.id);
    ELSE
      v_unsigned_ids := pg_catalog.array_append(v_unsigned_ids, v_env.id);
    END IF;
  END LOOP;

  IF pg_catalog.array_length(v_completed_ids, 1) IS NULL
     AND pg_catalog.array_length(v_unsigned_ids, 1) IS NULL THEN
    RETURN;
  END IF;

  PERFORM pg_catalog.set_config('ludy.sign_meeting_cleanup', p_org_id::text, true);
  BEGIN
    IF COALESCE(pg_catalog.array_length(v_completed_ids, 1), 0) > 0 THEN
      UPDATE ludy_sign.envelope e
      SET retained_org_visible = COALESCE(e.retained_org_visible, COALESCE(p_org_visible, false)),
          retained_reader_ids = COALESCE(e.retained_reader_ids, COALESCE(p_reader_ids, ARRAY[]::uuid[])),
          updated_at = v_now
      WHERE e.org_id = p_org_id
        AND e.id = ANY (v_completed_ids)
        AND e.status = 'completed'
        AND e.retained_reader_ids IS NULL;
    END IF;

    IF COALESCE(pg_catalog.array_length(v_unsigned_ids, 1), 0) > 0 THEN
      -- Canonical lock order: envelope -> signer -> signing_token -> field -> signing_otp -> remaining children.
      PERFORM 1 FROM ludy_sign.signer s WHERE s.org_id = p_org_id AND s.envelope_id = ANY (v_unsigned_ids) ORDER BY s.id FOR UPDATE;
      PERFORM 1 FROM ludy_sign.signing_token t WHERE t.org_id = p_org_id AND t.envelope_id = ANY (v_unsigned_ids) ORDER BY t.id FOR UPDATE;
      PERFORM 1 FROM ludy_sign.field f WHERE f.org_id = p_org_id AND f.envelope_id = ANY (v_unsigned_ids) ORDER BY f.id FOR UPDATE;
      PERFORM 1
      FROM ludy_sign.signing_otp o
      JOIN ludy_sign.signer s ON s.org_id = o.org_id AND s.id = o.signer_id
      WHERE o.org_id = p_org_id AND s.envelope_id = ANY (v_unsigned_ids)
      ORDER BY o.id
      FOR UPDATE OF o;
      PERFORM 1 FROM ludy_sign.ai_analysis a WHERE a.org_id = p_org_id AND a.envelope_id = ANY (v_unsigned_ids) ORDER BY a.id FOR UPDATE;
      PERFORM 1 FROM ludy_sign.playbook_check p WHERE p.org_id = p_org_id AND p.envelope_id = ANY (v_unsigned_ids) ORDER BY p.id FOR UPDATE;
      PERFORM 1 FROM ludy_sign.kyc_check k WHERE k.org_id = p_org_id AND k.envelope_id = ANY (v_unsigned_ids) ORDER BY k.id FOR UPDATE;
      PERFORM 1 FROM ludy_sign.ca_signing_request c WHERE c.org_id = p_org_id AND c.envelope_id = ANY (v_unsigned_ids) ORDER BY c.id FOR UPDATE;
      PERFORM 1 FROM ludy_sign.envelope_obligation eo WHERE eo.org_id = p_org_id AND eo.envelope_id = ANY (v_unsigned_ids) ORDER BY eo.id FOR UPDATE;
      PERFORM 1 FROM ludy_sign.envelope_document ed WHERE ed.org_id = p_org_id AND ed.envelope_id = ANY (v_unsigned_ids) ORDER BY ed.id FOR UPDATE;

      FOR v_env IN
        SELECT e.id, e.status, e.source_sha256
        FROM ludy_sign.envelope e
        WHERE e.org_id = p_org_id
          AND e.id = ANY (v_unsigned_ids)
          AND e.status IN ('draft', 'sent', 'in_progress')
        ORDER BY e.id
      LOOP
        SELECT COALESCE(se.seq, 0) + 1, se.event_hash
        INTO v_next_seq, v_prev_hash
        FROM ludy_sign.signing_event se
        WHERE se.org_id = p_org_id
          AND se.envelope_id = v_env.id
        ORDER BY se.seq DESC
        LIMIT 1;
        IF NOT FOUND THEN
          v_next_seq := 1;
          v_prev_hash := NULL;
        END IF;

        v_prev_json := CASE WHEN v_prev_hash IS NULL THEN 'null' ELSE '"' || v_prev_hash || '"' END;
        v_canonical :=
          '{"actorId":null,"actorLabel":"system:meetings_cleanup","actorType":"system"'
          || ',"documentSha256":"' || v_env.source_sha256 || '"'
          || ',"envelopeId":"' || v_env.id::text || '"'
          || ',"eventType":"envelope_voided"'
          || ',"ipHash":null'
          || ',"occurredAt":"' || v_occurred_iso || '"'
          || ',"orgId":"' || p_org_id::text || '"'
          || ',"payloadJson":{"reason":"meeting_deleted"}'
          || ',"prevEventHash":' || v_prev_json
          || ',"seq":' || v_next_seq::text
          || ',"signerId":null,"userAgent":null}';
        v_event_hash := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_canonical, 'UTF8')), 'hex');

        INSERT INTO ludy_sign.signing_event (
          org_id, envelope_id, signer_id, host_user_id, seq, event_type,
          actor_type, actor_id, actor_label, document_sha256,
          prev_event_hash, event_hash, payload_json, ip_hash, user_agent, occurred_at
        )
        VALUES (
          p_org_id, v_env.id, NULL, NULL, v_next_seq, 'envelope_voided',
          'system', NULL, 'system:meetings_cleanup', v_env.source_sha256,
          v_prev_hash, v_event_hash, '{"reason":"meeting_deleted"}'::jsonb, NULL, NULL, v_now
        );
      END LOOP;

      DELETE FROM ludy_sign.signing_otp o
      USING ludy_sign.signer s
      WHERE o.org_id = p_org_id
        AND s.org_id = o.org_id
        AND s.id = o.signer_id
        AND s.envelope_id = ANY (v_unsigned_ids);

      DELETE FROM ludy_sign.signing_token t
      WHERE t.org_id = p_org_id
        AND t.envelope_id = ANY (v_unsigned_ids);

      DELETE FROM ludy_sign.kyc_check k
      WHERE k.org_id = p_org_id
        AND k.envelope_id = ANY (v_unsigned_ids);

      DELETE FROM ludy_sign.ca_signing_request c
      WHERE c.org_id = p_org_id
        AND c.envelope_id = ANY (v_unsigned_ids);

      DELETE FROM ludy_sign.playbook_check p
      WHERE p.org_id = p_org_id
        AND p.envelope_id = ANY (v_unsigned_ids);

      DELETE FROM ludy_sign.ai_analysis a
      WHERE a.org_id = p_org_id
        AND a.envelope_id = ANY (v_unsigned_ids);

      DELETE FROM ludy_sign.envelope_obligation eo
      WHERE eo.org_id = p_org_id
        AND eo.envelope_id = ANY (v_unsigned_ids);

      DELETE FROM ludy_sign.field f
      WHERE f.org_id = p_org_id
        AND f.envelope_id = ANY (v_unsigned_ids);

      DELETE FROM ludy_sign.envelope_document ed
      WHERE ed.org_id = p_org_id
        AND ed.envelope_id = ANY (v_unsigned_ids);

      DELETE FROM ludy_sign.signer s
      WHERE s.org_id = p_org_id
        AND s.envelope_id = ANY (v_unsigned_ids);

      UPDATE ludy_sign.envelope e
      SET status = CASE WHEN e.status IN ('draft', 'sent', 'in_progress') THEN 'voided' ELSE e.status END,
          voided_at = CASE WHEN e.status IN ('draft', 'sent', 'in_progress') THEN COALESCE(e.voided_at, v_now) ELSE e.voided_at END,
          void_reason = CASE WHEN e.status IN ('draft', 'sent', 'in_progress') THEN 'meeting_deleted' ELSE NULL END,
          title = '[Erased meeting minutes]',
          subject = NULL,
          message = NULL,
          inspect_error = NULL,
          detected_tags_json = NULL,
          share_summary_with_signers = false,
          shared_summary_json = NULL,
          version = e.version + 1,
          updated_at = v_now
      WHERE e.org_id = p_org_id
        AND e.id = ANY (v_unsigned_ids)
        AND e.status <> 'completed';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_catalog.set_config('ludy.sign_meeting_cleanup', '', true);
    RAISE;
  END;

  PERFORM pg_catalog.set_config('ludy.sign_meeting_cleanup', '', true);
END $$;

-- ---------------------------------------------------------------------------
-- 7. Public ceremony views, PDF lookup (1-arg & 2-arg), and packet submit
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION ludy_sign.public_record_view(
  p_token_sha256 text,
  p_ip_hash text DEFAULT NULL,
  p_user_agent text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_now timestamptz := pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp());
  v_lookup record;
  v_env record;
  v_signer record;
  v_tok record;
  v_tenant record;
  v_otp_verified boolean := false;
  v_in_person boolean := false;
  v_ip_hash text;
  v_ua text := pg_catalog.left(NULLIF(pg_catalog.btrim(pg_catalog.regexp_replace(COALESCE(p_user_agent, ''), '[[:cntrl:]]+', ' ', 'g')), ''), 500);
  v_actor_label text;
  v_fields jsonb := '[]'::jsonb;
  v_documents jsonb := '[]'::jsonb;
BEGIN
  IF p_token_sha256 IS NULL OR p_token_sha256 !~ '^[0-9a-f]{64}$' THEN
    RETURN NULL;
  END IF;

  SELECT tok.id AS token_id, tok.org_id, tok.envelope_id, tok.signer_id
  INTO v_lookup
  FROM ludy_sign.signing_token tok
  WHERE tok.token_sha256 = p_token_sha256;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT e.*
  INTO v_env
  FROM ludy_sign.envelope e
  WHERE e.org_id = v_lookup.org_id
    AND e.id = v_lookup.envelope_id
  FOR UPDATE;

  SELECT s.*
  INTO v_signer
  FROM ludy_sign.signer s
  WHERE s.org_id = v_lookup.org_id
    AND s.envelope_id = v_lookup.envelope_id
    AND s.id = v_lookup.signer_id
  FOR UPDATE;

  SELECT tok.*
  INTO v_tok
  FROM ludy_sign.signing_token tok
  WHERE tok.org_id = v_lookup.org_id
    AND tok.id = v_lookup.token_id
  FOR UPDATE;

  SELECT t.name, t.status
  INTO v_tenant
  FROM ludy_kernel.tenant t
  WHERE t.org_id = v_lookup.org_id;

  v_now := pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp());

  IF v_tenant.status IS DISTINCT FROM 'active'
     OR NOT ludy_kernel.org_app_on(v_lookup.org_id, 'sign')
     OR v_tok.revoked_at IS NOT NULL
     OR v_tok.used_at IS NOT NULL
     OR v_tok.expires_at <= v_now
     OR v_signer.signer_role = 'cc'
     OR v_signer.status NOT IN ('pending', 'viewed')
     OR v_env.status NOT IN ('sent', 'in_progress')
     OR (v_env.expires_at IS NOT NULL AND v_env.expires_at <= v_now) THEN
    RETURN NULL;
  END IF;

  v_in_person := v_tok.in_person_host_user_id IS NOT NULL;

  UPDATE ludy_sign.signing_token
  SET last_viewed_at = v_now
  WHERE org_id = v_lookup.org_id
    AND id = v_tok.id;

  IF v_signer.status = 'pending' THEN
    v_ip_hash := ludy_sign.public_keyed_ip_hash(v_lookup.org_id, p_ip_hash);
    v_actor_label := COALESCE(NULLIF(pg_catalog.btrim(pg_catalog.regexp_replace(COALESCE(v_signer.email, v_signer.name), '[[:cntrl:]]+', ' ', 'g')), ''), 'Signer');
    v_actor_label := pg_catalog.left(v_actor_label, 254);

    UPDATE ludy_sign.signer
    SET status = 'viewed',
        viewed_at = COALESCE(v_signer.viewed_at, v_now),
        signer_ip_hash = COALESCE(v_ip_hash, v_signer.signer_ip_hash),
        signer_user_agent = COALESCE(v_ua, v_signer.signer_user_agent),
        updated_at = v_now
    WHERE org_id = v_lookup.org_id
      AND id = v_signer.id;

    IF v_tok.in_person_host_user_id IS NOT NULL THEN
      PERFORM ludy_sign.public_append_event_with_host(
        v_lookup.org_id,
        v_env.id,
        v_signer.id,
        'signer_viewed',
        'signer',
        v_actor_label,
        v_env.source_sha256,
        pg_catalog.jsonb_build_object(
          'routingOrder', v_signer.routing_order,
          'hostUserId', v_tok.in_person_host_user_id::text
        ),
        v_ip_hash,
        v_ua,
        v_now,
        v_tok.in_person_host_user_id
      );
    ELSE
      PERFORM ludy_sign.public_append_event(
        v_lookup.org_id,
        v_env.id,
        v_signer.id,
        'signer_viewed',
        'signer',
        v_actor_label,
        v_env.source_sha256,
        pg_catalog.jsonb_build_object('routingOrder', v_signer.routing_order),
        v_ip_hash,
        v_ua,
        v_now
      );
    END IF;
  END IF;

  v_otp_verified := ludy_sign.public_otp_verified_at_for_token(v_lookup.org_id, v_signer.id, v_tok.id) IS NOT NULL;
  IF v_signer.require_email_otp AND NOT v_otp_verified THEN
    RETURN pg_catalog.jsonb_build_object(
      'state', 'otp_required',
      'orgName', v_tenant.name,
      'title', v_env.title,
      'maskedEmail', ludy_sign.mask_email(v_signer.email),
      'inPerson', v_in_person
    );
  END IF;

  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', d.id,
        'docIndex', d.doc_index,
        'title', d.title,
        'pageCount', COALESCE(d.page_count, 1),
        'pageDimensions', COALESCE(d.page_dimensions_json, '[]'::jsonb),
        'sourceSha256', d.source_sha256
      )
      ORDER BY d.doc_index ASC, d.id ASC
    ),
    '[]'::jsonb
  )
  INTO v_documents
  FROM ludy_sign.envelope_document d
  WHERE d.org_id = v_lookup.org_id
    AND d.envelope_id = v_env.id;

  IF pg_catalog.jsonb_array_length(v_documents) = 0 THEN
    v_documents := pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'id', NULL,
        'docIndex', 1,
        'title', v_env.title,
        'pageCount', COALESCE(v_env.page_count, 1),
        'pageDimensions', COALESCE(v_env.page_dimensions_json, '[]'::jsonb),
        'sourceSha256', v_env.source_sha256
      )
    );
  END IF;

  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', f.id,
        'documentId', f.document_id,
        'fieldType', f.field_type,
        'pageNumber', f.page_number,
        'xNorm', f.x_norm::text,
        'yNorm', f.y_norm::text,
        'wNorm', f.w_norm::text,
        'hNorm', f.h_norm::text,
        'label', f.label,
        'required', f.required,
        'fontSizePt', f.font_size_pt,
        'valueText', f.value_text,
        'options', f.options_json,
        'attachment', CASE WHEN f.attachment_file_id IS NOT NULL THEN pg_catalog.jsonb_build_object(
          'fileId', f.attachment_file_id,
          'filename', f.attachment_filename,
          'contentType', f.attachment_content_type,
          'sizeBytes', f.attachment_size_bytes,
          'sha256', f.attachment_sha256,
          'uploadedAt', CASE WHEN f.filled_at IS NOT NULL
            THEN pg_catalog.to_char(f.filled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
            ELSE NULL END
        ) ELSE NULL END
      )
      ORDER BY COALESCE(d.doc_index, 1) ASC, f.page_number, f.y_norm, f.x_norm, f.id
    ),
    '[]'::jsonb
  )
  INTO v_fields
  FROM ludy_sign.field f
  LEFT JOIN ludy_sign.envelope_document d
    ON d.org_id = f.org_id
   AND d.id = f.document_id
  WHERE f.org_id = v_lookup.org_id
    AND f.envelope_id = v_env.id
    AND f.signer_id = v_signer.id;

  RETURN pg_catalog.jsonb_build_object(
    'state', 'ready',
    'orgName', v_tenant.name,
    'title', v_env.title,
    'message', v_env.message,
    'signerName', v_signer.name,
    'roleLabel', v_signer.role_label,
    'signerRole', CASE WHEN v_signer.signer_role = 'approver' THEN 'approver' ELSE 'signer' END,
    'expiresAt', pg_catalog.to_char(v_tok.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'pageCount', COALESCE(v_env.page_count, 1),
    'pageDimensions', COALESCE(v_env.page_dimensions_json, '[]'::jsonb),
    'documents', v_documents,
    'requireEmailOtp', v_signer.require_email_otp,
    'otpVerified', v_otp_verified,
    'allowDelegation', (v_env.allow_delegation AND v_tok.in_person_host_user_id IS NULL AND v_signer.signer_role IN ('signer', 'approver') AND v_signer.delegation_count < 2),
    'delegationCount', v_signer.delegation_count,
    'delegatedFromName', v_signer.delegated_from_name,
    'inPerson', v_in_person,
    'fields', v_fields,
    'sharedSummary', CASE
      WHEN v_env.share_summary_with_signers AND v_env.shared_summary_json IS NOT NULL THEN v_env.shared_summary_json
      ELSE NULL
    END
  );
END $$;

-- 2-arg resolver for packet PDFs: resolves requested document strictly within token's envelope
-- after OTP verification (NULL defaults to doc 1 / envelope.source_*).
CREATE OR REPLACE FUNCTION ludy_sign.public_pdf_source(
  p_token_sha256 text,
  p_document_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_now timestamptz := pg_catalog.now();
  v_row record;
  v_doc record;
  v_otp_verified boolean := false;
  v_storage_key text;
  v_generation text;
  v_sha256 text;
BEGIN
  IF p_token_sha256 IS NULL OR p_token_sha256 !~ '^[0-9a-f]{64}$' THEN
    RETURN NULL;
  END IF;

  SELECT
    tok.id AS token_id,
    tok.org_id,
    tok.envelope_id,
    tok.signer_id,
    tok.expires_at AS token_expires_at,
    tok.used_at AS token_used_at,
    tok.revoked_at AS token_revoked_at,
    e.status AS envelope_status,
    e.expires_at AS envelope_expires_at,
    e.source_storage_key,
    e.source_generation,
    e.source_sha256,
    s.signer_role,
    s.status AS signer_status,
    s.require_email_otp,
    t.status AS tenant_status
  INTO v_row
  FROM ludy_sign.signing_token tok
  JOIN ludy_sign.envelope e
    ON e.org_id = tok.org_id
   AND e.id = tok.envelope_id
  JOIN ludy_sign.signer s
    ON s.org_id = tok.org_id
   AND s.id = tok.signer_id
   AND s.envelope_id = tok.envelope_id
  JOIN ludy_kernel.tenant t
    ON t.org_id = tok.org_id
  WHERE tok.token_sha256 = p_token_sha256;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF v_row.tenant_status IS DISTINCT FROM 'active'
     OR NOT ludy_kernel.org_app_on(v_row.org_id, 'sign')
     OR v_row.token_revoked_at IS NOT NULL
     OR v_row.token_used_at IS NOT NULL
     OR v_row.token_expires_at <= v_now
     OR v_row.signer_role = 'cc'
     OR v_row.signer_status NOT IN ('pending', 'viewed')
     OR v_row.envelope_status NOT IN ('sent', 'in_progress')
     OR (v_row.envelope_expires_at IS NOT NULL AND v_row.envelope_expires_at <= v_now) THEN
    RETURN NULL;
  END IF;

  v_otp_verified := ludy_sign.public_otp_verified_at_for_token(v_row.org_id, v_row.signer_id, v_row.token_id) IS NOT NULL;
  IF v_row.require_email_otp AND NOT v_otp_verified THEN
    RETURN pg_catalog.jsonb_build_object(
      'orgId', v_row.org_id,
      'otpRequired', true
    );
  END IF;

  IF p_document_id IS NOT NULL THEN
    SELECT d.id, d.storage_key, d.generation, d.source_sha256
    INTO v_doc
    FROM ludy_sign.envelope_document d
    WHERE d.org_id = v_row.org_id
      AND d.envelope_id = v_row.envelope_id
      AND d.id = p_document_id;

    IF NOT FOUND THEN
      RETURN NULL;
    END IF;
    v_storage_key := v_doc.storage_key;
    v_generation := v_doc.generation;
    v_sha256 := v_doc.source_sha256;
  ELSE
    SELECT d.id, d.storage_key, d.generation, d.source_sha256
    INTO v_doc
    FROM ludy_sign.envelope_document d
    WHERE d.org_id = v_row.org_id
      AND d.envelope_id = v_row.envelope_id
    ORDER BY d.doc_index ASC, d.id ASC
    LIMIT 1;

    IF FOUND THEN
      v_storage_key := v_doc.storage_key;
      v_generation := v_doc.generation;
      v_sha256 := v_doc.source_sha256;
    ELSE
      v_storage_key := v_row.source_storage_key;
      v_generation := v_row.source_generation;
      v_sha256 := v_row.source_sha256;
    END IF;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'orgId', v_row.org_id,
    'otpRequired', false,
    'envelopeId', v_row.envelope_id,
    'signerId', v_row.signer_id,
    'documentId', v_doc.id,
    'storageKey', v_storage_key,
    'generation', v_generation,
    'sha256', v_sha256
  );
END $$;

-- Preserve 1-arg public_pdf_source(text) for invariant checks and legacy callers;
-- keeps org_app_on(v_row.org_id, 'sign') directly in its body.
CREATE OR REPLACE FUNCTION ludy_sign.public_pdf_source(p_token_sha256 text) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_now timestamptz := pg_catalog.now();
  v_row record;
  v_doc record;
  v_otp_verified boolean := false;
  v_storage_key text;
  v_generation text;
  v_sha256 text;
BEGIN
  IF p_token_sha256 IS NULL OR p_token_sha256 !~ '^[0-9a-f]{64}$' THEN
    RETURN NULL;
  END IF;

  SELECT
    tok.id AS token_id,
    tok.org_id,
    tok.envelope_id,
    tok.signer_id,
    tok.expires_at AS token_expires_at,
    tok.used_at AS token_used_at,
    tok.revoked_at AS token_revoked_at,
    e.status AS envelope_status,
    e.expires_at AS envelope_expires_at,
    e.source_storage_key,
    e.source_generation,
    e.source_sha256,
    s.signer_role,
    s.status AS signer_status,
    s.require_email_otp,
    t.status AS tenant_status
  INTO v_row
  FROM ludy_sign.signing_token tok
  JOIN ludy_sign.envelope e
    ON e.org_id = tok.org_id
   AND e.id = tok.envelope_id
  JOIN ludy_sign.signer s
    ON s.org_id = tok.org_id
   AND s.id = tok.signer_id
   AND s.envelope_id = tok.envelope_id
  JOIN ludy_kernel.tenant t
    ON t.org_id = tok.org_id
  WHERE tok.token_sha256 = p_token_sha256;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF v_row.tenant_status IS DISTINCT FROM 'active'
     OR NOT ludy_kernel.org_app_on(v_row.org_id, 'sign')
     OR v_row.token_revoked_at IS NOT NULL
     OR v_row.token_used_at IS NOT NULL
     OR v_row.token_expires_at <= v_now
     OR v_row.signer_role = 'cc'
     OR v_row.signer_status NOT IN ('pending', 'viewed')
     OR v_row.envelope_status NOT IN ('sent', 'in_progress')
     OR (v_row.envelope_expires_at IS NOT NULL AND v_row.envelope_expires_at <= v_now) THEN
    RETURN NULL;
  END IF;

  v_otp_verified := ludy_sign.public_otp_verified_at_for_token(v_row.org_id, v_row.signer_id, v_row.token_id) IS NOT NULL;
  IF v_row.require_email_otp AND NOT v_otp_verified THEN
    RETURN pg_catalog.jsonb_build_object(
      'orgId', v_row.org_id,
      'otpRequired', true
    );
  END IF;

  SELECT d.id, d.storage_key, d.generation, d.source_sha256
  INTO v_doc
  FROM ludy_sign.envelope_document d
  WHERE d.org_id = v_row.org_id
    AND d.envelope_id = v_row.envelope_id
  ORDER BY d.doc_index ASC, d.id ASC
  LIMIT 1;

  IF FOUND THEN
    v_storage_key := v_doc.storage_key;
    v_generation := v_doc.generation;
    v_sha256 := v_doc.source_sha256;
  ELSE
    v_storage_key := v_row.source_storage_key;
    v_generation := v_row.source_generation;
    v_sha256 := v_row.source_sha256;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'orgId', v_row.org_id,
    'otpRequired', false,
    'envelopeId', v_row.envelope_id,
    'signerId', v_row.signer_id,
    'storageKey', v_storage_key,
    'generation', v_generation,
    'sha256', v_sha256
  );
END $$;

CREATE OR REPLACE FUNCTION ludy_sign.public_submit(
  p_token_sha256 text,
  p_consent_accepted boolean,
  p_signature_kind text,
  p_signature_typed_text text,
  p_fields jsonb,
  p_ip_hash text DEFAULT NULL,
  p_user_agent text DEFAULT NULL,
  p_message_id_domain text DEFAULT 'crove.invalid'
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_now timestamptz := pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp());
  v_lookup record;
  v_env record;
  v_signer record;
  v_tok record;
  v_tenant record;
  v_otp_verified boolean := false;
  v_field record;
  v_sub jsonb;
  v_sub_text text;
  v_sub_png text;
  v_raw_b64 text;
  v_png_bytes bytea;
  v_sub_checked boolean;
  v_saw_sig_png boolean := false;
  v_filled_count integer := 0;
  v_doc_count integer := 1;
  v_sig_kind text;
  v_typed_text text := pg_catalog.left(NULLIF(pg_catalog.btrim(COALESCE(p_signature_typed_text, '')), ''), 200);
  v_ip_hash text;
  v_ua text := pg_catalog.left(NULLIF(pg_catalog.btrim(pg_catalog.regexp_replace(COALESCE(p_user_agent, ''), '[[:cntrl:]]+', ' ', 'g')), ''), 500);
  v_actor_label text;
  v_total_signers integer := 0;
  v_remaining integer := 0;
  v_all_completed boolean := false;
  v_next_env_status text;
  v_next_order integer;
  v_outbox_id uuid;
  v_domain text := CASE WHEN p_message_id_domain IS NOT NULL AND pg_catalog.btrim(p_message_id_domain) ~ '^[A-Za-z0-9.-]{1,120}$'
    THEN pg_catalog.lower(pg_catalog.btrim(p_message_id_domain)) ELSE 'crove.invalid' END;
  v_org_name text;
  v_doc_title text;
  v_next_signer record;
  v_to_email text;
  v_to_hash text;
  v_suppressed boolean;
  v_invalid_field_count integer := 0;
  v_dup_field_count integer := 0;
BEGIN
  IF p_token_sha256 IS NULL OR p_token_sha256 !~ '^[0-9a-f]{64}$' THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  SELECT tok.id AS token_id, tok.org_id, tok.envelope_id, tok.signer_id
  INTO v_lookup
  FROM ludy_sign.signing_token tok
  WHERE tok.token_sha256 = p_token_sha256;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  -- Canonical lock order: envelope -> signer (all envelope signers ORDER BY id) -> signing_token -> field (ORDER BY id).
  SELECT e.*
  INTO v_env
  FROM ludy_sign.envelope e
  WHERE e.org_id = v_lookup.org_id
    AND e.id = v_lookup.envelope_id
  FOR UPDATE;

  PERFORM 1
  FROM ludy_sign.signer s
  WHERE s.org_id = v_lookup.org_id
    AND s.envelope_id = v_lookup.envelope_id
  ORDER BY s.id
  FOR UPDATE;

  SELECT s.*
  INTO v_signer
  FROM ludy_sign.signer s
  WHERE s.org_id = v_lookup.org_id
    AND s.id = v_lookup.signer_id;

  SELECT tok.*
  INTO v_tok
  FROM ludy_sign.signing_token tok
  WHERE tok.org_id = v_lookup.org_id
    AND tok.id = v_lookup.token_id
  FOR UPDATE;

  SELECT t.name, t.status
  INTO v_tenant
  FROM ludy_kernel.tenant t
  WHERE t.org_id = v_lookup.org_id;

  v_now := pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp());

  IF v_tenant.status IS DISTINCT FROM 'active'
     OR NOT ludy_kernel.org_app_on(v_lookup.org_id, 'sign')
     OR v_tok.revoked_at IS NOT NULL
     OR v_tok.expires_at <= v_now
     OR v_signer.signer_role = 'cc'
     OR v_signer.status IN ('waiting', 'voided', 'expired')
     OR v_env.status IN ('draft', 'voided', 'expired')
     OR (v_tok.used_at IS NULL AND v_signer.status IN ('pending', 'viewed') AND v_env.expires_at IS NOT NULL AND v_env.expires_at <= v_now) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  IF v_tok.used_at IS NOT NULL OR v_signer.status IN ('signed', 'declined') OR v_env.status NOT IN ('sent', 'in_progress') THEN
    RETURN pg_catalog.jsonb_build_object('status', 'already_used');
  END IF;

  IF NOT COALESCE(p_consent_accepted, false) THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'SIGN_CONSENT_REQUIRED',
      'httpStatus', 422,
      'message', 'Electronic signature consent must be accepted before submitting'
    );
  END IF;

  v_otp_verified := ludy_sign.public_otp_verified_at_for_token(v_lookup.org_id, v_signer.id, v_tok.id) IS NOT NULL;
  IF v_signer.require_email_otp AND NOT v_otp_verified THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'SIGN_OTP_REQUIRED',
      'httpStatus', 403,
      'message', 'Email OTP verification is required before signing'
    );
  END IF;

  IF p_signature_kind IS NOT NULL AND p_signature_kind NOT IN ('draw', 'type') THEN
    RETURN pg_catalog.jsonb_build_object('status', 'error', 'code', 'VALIDATION', 'httpStatus', 422, 'message', 'Invalid signature kind');
  END IF;

  IF p_fields IS NULL OR pg_catalog.jsonb_typeof(p_fields) <> 'array' THEN
    RETURN pg_catalog.jsonb_build_object('status', 'error', 'code', 'VALIDATION', 'httpStatus', 422, 'message', 'fields must be an array');
  END IF;

  SELECT GREATEST(pg_catalog.count(*)::integer, 1)
  INTO v_doc_count
  FROM ludy_sign.envelope_document d
  WHERE d.org_id = v_lookup.org_id
    AND d.envelope_id = v_env.id;

  SELECT pg_catalog.count(*)::integer
  INTO v_invalid_field_count
  FROM pg_catalog.jsonb_array_elements(p_fields) elem
  WHERE pg_catalog.jsonb_typeof(elem) <> 'object'
     OR COALESCE(elem->>'fieldId', '') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
     OR NOT EXISTS (
       SELECT 1
       FROM ludy_sign.field f
       WHERE f.org_id = v_lookup.org_id
         AND f.envelope_id = v_env.id
         AND f.signer_id = v_signer.id
         AND f.id = (elem->>'fieldId')::uuid
     );

  IF v_invalid_field_count > 0 THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'SIGN_INVALID_FIELD',
      'httpStatus', 422,
      'message', 'Submitted field is not assigned to this signer'
    );
  END IF;

  SELECT pg_catalog.count(*)::integer
  INTO v_dup_field_count
  FROM (
    SELECT (elem->>'fieldId')::uuid AS fid
    FROM pg_catalog.jsonb_array_elements(p_fields) elem
    GROUP BY (elem->>'fieldId')::uuid
    HAVING pg_catalog.count(*) > 1
  ) dup;

  IF v_dup_field_count > 0 THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'SIGN_DUPLICATE_FIELD',
      'httpStatus', 422,
      'message', 'Duplicate submission for the same field'
    );
  END IF;

  -- Lock and validate required fields across ALL packet documents under the single consent action.
  FOR v_field IN
    SELECT f.*, d.doc_index AS doc_index, d.title AS doc_title
    FROM ludy_sign.field f
    LEFT JOIN ludy_sign.envelope_document d
      ON d.org_id = f.org_id
     AND d.id = f.document_id
    WHERE f.org_id = v_lookup.org_id
      AND f.envelope_id = v_env.id
      AND f.signer_id = v_signer.id
    ORDER BY COALESCE(d.doc_index, 1) ASC, f.id ASC
    FOR UPDATE OF f
  LOOP
    SELECT elem INTO v_sub
    FROM pg_catalog.jsonb_array_elements(p_fields) elem
    WHERE (elem->>'fieldId')::uuid = v_field.id
    LIMIT 1;

    IF v_field.field_type IN ('signature', 'stamp') THEN
      v_sub_png := NULLIF(v_sub->>'signaturePngBase64', '');
      v_sub_text := NULLIF(pg_catalog.btrim(COALESCE(v_sub->>'valueText', '')), '');
      IF v_sub_text IS NOT NULL AND pg_catalog.length(v_sub_text) > 2000 THEN
        RETURN pg_catalog.jsonb_build_object('status', 'error', 'code', 'VALIDATION', 'httpStatus', 422, 'message', 'Signature text exceeds maximum length');
      END IF;
      IF v_sub_png IS NOT NULL THEN
        v_raw_b64 := CASE
          WHEN v_sub_png LIKE 'data:image/png;base64,%' THEN pg_catalog.substr(v_sub_png, 23)
          WHEN v_sub_png LIKE 'data:%' THEN NULL
          ELSE v_sub_png
        END;
        IF v_raw_b64 IS NULL OR pg_catalog.length(v_raw_b64) > 360000 OR v_raw_b64 !~ '^[A-Za-z0-9+/]+={0,2}$' THEN
          RETURN pg_catalog.jsonb_build_object('status', 'error', 'code', 'SIGN_INVALID_SIGNATURE_PNG', 'httpStatus', 422, 'message', 'Signature or stamp PNG is malformed');
        END IF;
        BEGIN
          v_png_bytes := pg_catalog.decode(v_raw_b64, 'base64');
        EXCEPTION WHEN OTHERS THEN
          RETURN pg_catalog.jsonb_build_object('status', 'error', 'code', 'SIGN_INVALID_SIGNATURE_PNG', 'httpStatus', 422, 'message', 'Signature or stamp PNG base64 decode failed');
        END;
        IF pg_catalog.octet_length(v_png_bytes) < 45
           OR pg_catalog.octet_length(v_png_bytes) > 262144
           OR pg_catalog.substr(v_png_bytes, 1, 8) IS DISTINCT FROM '\x89504e470d0a1a0a'::bytea THEN
          RETURN pg_catalog.jsonb_build_object('status', 'error', 'code', 'SIGN_INVALID_SIGNATURE_PNG', 'httpStatus', 422, 'message', 'Signature or stamp payload does not contain a valid PNG image');
        END IF;
        v_saw_sig_png := true;
      ELSIF v_field.required THEN
        RETURN pg_catalog.jsonb_build_object(
          'status', 'error',
          'code', 'SIGN_FIELD_REQUIRED',
          'httpStatus', 422,
          'documentId', v_field.document_id,
          'message', CASE WHEN v_field.field_type = 'stamp'
            THEN 'Required stamp field is missing a PNG stamp'
            ELSE 'Required signature field is missing a PNG signature' END
        );
      END IF;
    ELSIF v_field.field_type = 'initials' THEN
      v_sub_png := NULLIF(v_sub->>'signaturePngBase64', '');
      v_sub_text := NULLIF(pg_catalog.btrim(COALESCE(v_sub->>'valueText', '')), '');
      IF v_sub_text IS NOT NULL AND pg_catalog.length(v_sub_text) > 2000 THEN
        RETURN pg_catalog.jsonb_build_object('status', 'error', 'code', 'VALIDATION', 'httpStatus', 422, 'message', 'Initials text exceeds maximum length');
      END IF;
      IF v_sub_png IS NOT NULL THEN
        v_raw_b64 := CASE
          WHEN v_sub_png LIKE 'data:image/png;base64,%' THEN pg_catalog.substr(v_sub_png, 23)
          WHEN v_sub_png LIKE 'data:%' THEN NULL
          ELSE v_sub_png
        END;
        IF v_raw_b64 IS NULL OR pg_catalog.length(v_raw_b64) > 360000 OR v_raw_b64 !~ '^[A-Za-z0-9+/]+={0,2}$' THEN
          RETURN pg_catalog.jsonb_build_object('status', 'error', 'code', 'SIGN_INVALID_SIGNATURE_PNG', 'httpStatus', 422, 'message', 'Initials PNG is malformed');
        END IF;
        BEGIN
          v_png_bytes := pg_catalog.decode(v_raw_b64, 'base64');
        EXCEPTION WHEN OTHERS THEN
          RETURN pg_catalog.jsonb_build_object('status', 'error', 'code', 'SIGN_INVALID_SIGNATURE_PNG', 'httpStatus', 422, 'message', 'Initials PNG base64 decode failed');
        END;
        IF pg_catalog.octet_length(v_png_bytes) < 45
           OR pg_catalog.octet_length(v_png_bytes) > 262144
           OR pg_catalog.substr(v_png_bytes, 1, 8) IS DISTINCT FROM '\x89504e470d0a1a0a'::bytea THEN
          RETURN pg_catalog.jsonb_build_object('status', 'error', 'code', 'SIGN_INVALID_SIGNATURE_PNG', 'httpStatus', 422, 'message', 'Initials payload does not contain a valid PNG image');
        END IF;
      END IF;
      IF v_sub_png IS NULL AND v_sub_text IS NULL AND v_field.required THEN
        RETURN pg_catalog.jsonb_build_object('status', 'error', 'code', 'SIGN_FIELD_REQUIRED', 'httpStatus', 422, 'documentId', v_field.document_id, 'message', 'Required initials field must be provided');
      END IF;
    ELSIF v_field.field_type = 'text' THEN
      IF v_sub IS NOT NULL AND v_sub ? 'valueText' THEN
        v_sub_text := NULLIF(pg_catalog.btrim(COALESCE(v_sub->>'valueText', '')), '');
      ELSE
        v_sub_text := NULLIF(pg_catalog.btrim(COALESCE(v_field.value_text, '')), '');
      END IF;
      IF v_sub_text IS NOT NULL AND pg_catalog.length(v_sub_text) > 2000 THEN
        RETURN pg_catalog.jsonb_build_object('status', 'error', 'code', 'VALIDATION', 'httpStatus', 422, 'message', 'Field text exceeds maximum length');
      END IF;
      IF v_sub_text IS NULL AND v_field.required THEN
        RETURN pg_catalog.jsonb_build_object('status', 'error', 'code', 'SIGN_FIELD_REQUIRED', 'httpStatus', 422, 'documentId', v_field.document_id, 'message', 'Required text or date field must not be empty');
      END IF;
    ELSIF v_field.field_type = 'date' THEN
      v_sub_text := NULLIF(pg_catalog.btrim(COALESCE(v_sub->>'valueText', '')), '');
      IF v_sub_text IS NOT NULL AND pg_catalog.length(v_sub_text) > 2000 THEN
        RETURN pg_catalog.jsonb_build_object('status', 'error', 'code', 'VALIDATION', 'httpStatus', 422, 'message', 'Field text exceeds maximum length');
      END IF;
      IF v_sub_text IS NULL AND v_field.required THEN
        RETURN pg_catalog.jsonb_build_object('status', 'error', 'code', 'SIGN_FIELD_REQUIRED', 'httpStatus', 422, 'documentId', v_field.document_id, 'message', 'Required text or date field must not be empty');
      END IF;
    ELSIF v_field.field_type = 'checkbox' THEN
      IF v_sub IS NOT NULL AND v_sub ? 'valueChecked' THEN
        IF pg_catalog.jsonb_typeof(v_sub->'valueChecked') <> 'boolean' THEN
          RETURN pg_catalog.jsonb_build_object('status', 'error', 'code', 'VALIDATION', 'httpStatus', 422, 'message', 'Checkbox value must be a boolean');
        END IF;
        v_sub_checked := (v_sub->>'valueChecked')::boolean;
        IF v_field.required AND v_sub_checked IS DISTINCT FROM true THEN
          RETURN pg_catalog.jsonb_build_object('status', 'error', 'code', 'SIGN_FIELD_REQUIRED', 'httpStatus', 422, 'documentId', v_field.document_id, 'message', 'Required checkbox field must be checked');
        END IF;
      ELSIF v_field.required THEN
        RETURN pg_catalog.jsonb_build_object('status', 'error', 'code', 'SIGN_FIELD_REQUIRED', 'httpStatus', 422, 'documentId', v_field.document_id, 'message', 'Required checkbox field must be checked');
      END IF;
    ELSIF v_field.field_type IN ('dropdown', 'radio') THEN
      v_sub_text := NULLIF(pg_catalog.btrim(COALESCE(v_sub->>'valueText', '')), '');
      IF v_sub_text IS NOT NULL THEN
        IF v_field.options_json IS NULL OR NOT EXISTS (
          SELECT 1
          FROM pg_catalog.jsonb_array_elements_text(v_field.options_json) AS opt(val)
          WHERE opt.val = v_sub_text
        ) THEN
          RETURN pg_catalog.jsonb_build_object(
            'status', 'error',
            'code', 'SIGN_INVALID_FIELD_OPTION',
            'httpStatus', 422,
            'message', 'Submitted choice is not among the allowed options for this field'
          );
        END IF;
      ELSIF v_field.required THEN
        RETURN pg_catalog.jsonb_build_object(
          'status', 'error',
          'code', 'SIGN_FIELD_REQUIRED',
          'httpStatus', 422,
          'documentId', v_field.document_id,
          'message', 'Required choice field must have a selected option'
        );
      END IF;
    ELSIF v_field.field_type = 'attachment' THEN
      IF v_field.required AND v_field.attachment_file_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object(
          'status', 'error',
          'code', 'SIGN_ATTACHMENT_REQUIRED',
          'httpStatus', 422,
          'documentId', v_field.document_id,
          'message', 'Required supporting attachment must be uploaded before submitting'
        );
      END IF;
    END IF;
  END LOOP;

  v_now := pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp());
  IF v_tok.expires_at <= v_now
     OR (v_env.expires_at IS NOT NULL AND v_env.expires_at <= v_now) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  UPDATE ludy_sign.signing_token
  SET used_at = v_now
  WHERE org_id = v_lookup.org_id
    AND id = v_tok.id
    AND used_at IS NULL
    AND revoked_at IS NULL
    AND expires_at > v_now;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'already_used');
  END IF;

  FOR v_field IN
    SELECT f.*
    FROM ludy_sign.field f
    WHERE f.org_id = v_lookup.org_id
      AND f.envelope_id = v_env.id
      AND f.signer_id = v_signer.id
    ORDER BY f.id
  LOOP
    SELECT elem INTO v_sub
    FROM pg_catalog.jsonb_array_elements(p_fields) elem
    WHERE (elem->>'fieldId')::uuid = v_field.id
    LIMIT 1;

    IF v_field.field_type = 'signature' THEN
      v_sub_png := NULLIF(v_sub->>'signaturePngBase64', '');
      IF v_sub_png IS NOT NULL THEN
        IF v_sub_png LIKE 'data:image/png;base64,%' THEN
          v_sub_png := pg_catalog.substr(v_sub_png, 23);
        END IF;
        v_filled_count := v_filled_count + 1;
        UPDATE ludy_sign.field
        SET signature_png_base64 = v_sub_png,
            value_text = COALESCE(v_typed_text, NULLIF(pg_catalog.btrim(COALESCE(v_sub->>'valueText', '')), '')),
            filled_at = v_now,
            updated_at = v_now
        WHERE org_id = v_lookup.org_id AND id = v_field.id;
      END IF;
    ELSIF v_field.field_type = 'stamp' THEN
      v_sub_png := NULLIF(v_sub->>'signaturePngBase64', '');
      IF v_sub_png IS NOT NULL THEN
        IF v_sub_png LIKE 'data:image/png;base64,%' THEN
          v_sub_png := pg_catalog.substr(v_sub_png, 23);
        END IF;
        v_filled_count := v_filled_count + 1;
        UPDATE ludy_sign.field
        SET signature_png_base64 = v_sub_png,
            value_text = NULLIF(pg_catalog.btrim(COALESCE(v_sub->>'valueText', '')), ''),
            filled_at = v_now,
            updated_at = v_now
        WHERE org_id = v_lookup.org_id AND id = v_field.id;
      END IF;
    ELSIF v_field.field_type = 'initials' THEN
      v_sub_png := NULLIF(v_sub->>'signaturePngBase64', '');
      IF v_sub_png IS NOT NULL AND v_sub_png LIKE 'data:image/png;base64,%' THEN
        v_sub_png := pg_catalog.substr(v_sub_png, 23);
      END IF;
      v_sub_text := NULLIF(pg_catalog.btrim(COALESCE(v_sub->>'valueText', '')), '');
      IF v_sub_png IS NOT NULL OR v_sub_text IS NOT NULL THEN
        v_filled_count := v_filled_count + 1;
        UPDATE ludy_sign.field
        SET signature_png_base64 = v_sub_png,
            value_text = v_sub_text,
            filled_at = v_now,
            updated_at = v_now
        WHERE org_id = v_lookup.org_id AND id = v_field.id;
      END IF;
    ELSIF v_field.field_type = 'text' THEN
      IF v_sub IS NOT NULL AND v_sub ? 'valueText' THEN
        v_sub_text := NULLIF(pg_catalog.btrim(COALESCE(v_sub->>'valueText', '')), '');
      ELSE
        v_sub_text := NULLIF(pg_catalog.btrim(COALESCE(v_field.value_text, '')), '');
      END IF;
      IF v_sub_text IS NOT NULL THEN
        v_filled_count := v_filled_count + 1;
        UPDATE ludy_sign.field
        SET value_text = v_sub_text,
            filled_at = v_now,
            updated_at = v_now
        WHERE org_id = v_lookup.org_id AND id = v_field.id;
      ELSIF v_field.value_text IS NOT NULL THEN
        UPDATE ludy_sign.field
        SET value_text = NULL,
            filled_at = NULL,
            updated_at = v_now
        WHERE org_id = v_lookup.org_id AND id = v_field.id;
      END IF;
    ELSIF v_field.field_type IN ('date', 'dropdown', 'radio') THEN
      v_sub_text := NULLIF(pg_catalog.btrim(COALESCE(v_sub->>'valueText', '')), '');
      IF v_sub_text IS NOT NULL THEN
        v_filled_count := v_filled_count + 1;
        UPDATE ludy_sign.field
        SET value_text = v_sub_text,
            filled_at = v_now,
            updated_at = v_now
        WHERE org_id = v_lookup.org_id AND id = v_field.id;
      END IF;
    ELSIF v_field.field_type = 'checkbox' THEN
      IF v_sub IS NOT NULL AND v_sub ? 'valueChecked' THEN
        v_filled_count := v_filled_count + 1;
        UPDATE ludy_sign.field
        SET value_checked = (v_sub->>'valueChecked')::boolean,
            filled_at = v_now,
            updated_at = v_now
        WHERE org_id = v_lookup.org_id AND id = v_field.id;
      END IF;
    ELSIF v_field.field_type = 'attachment' THEN
      IF v_field.attachment_file_id IS NOT NULL THEN
        v_filled_count := v_filled_count + 1;
      END IF;
    END IF;
  END LOOP;

  v_ip_hash := ludy_sign.public_keyed_ip_hash(v_lookup.org_id, p_ip_hash);
  v_sig_kind := COALESCE(p_signature_kind, CASE WHEN v_typed_text IS NOT NULL THEN 'type' WHEN v_saw_sig_png THEN 'draw' ELSE NULL END);

  UPDATE ludy_sign.signer
  SET status = 'signed',
      signed_at = v_now,
      consent_accepted_at = COALESCE(v_signer.consent_accepted_at, v_now),
      signature_kind = v_sig_kind,
      signature_typed_text = v_typed_text,
      signer_ip_hash = COALESCE(v_ip_hash, v_signer.signer_ip_hash),
      signer_user_agent = COALESCE(v_ua, v_signer.signer_user_agent),
      updated_at = v_now
  WHERE org_id = v_lookup.org_id
    AND id = v_signer.id;

  SELECT
    pg_catalog.count(*) FILTER (WHERE s.signer_role <> 'cc')::integer,
    pg_catalog.count(*) FILTER (WHERE s.signer_role <> 'cc' AND s.status <> 'signed')::integer
  INTO v_total_signers, v_remaining
  FROM ludy_sign.signer s
  WHERE s.org_id = v_lookup.org_id
    AND s.envelope_id = v_env.id;

  v_all_completed := v_remaining = 0;
  v_next_env_status := CASE WHEN v_all_completed THEN 'completed' ELSE 'in_progress' END;

  UPDATE ludy_sign.envelope
  SET status = v_next_env_status,
      completed_at = CASE WHEN v_all_completed THEN v_now ELSE completed_at END,
      version = v_env.version + 1,
      updated_at = v_now
  WHERE org_id = v_lookup.org_id
    AND id = v_env.id;

  v_actor_label := COALESCE(NULLIF(pg_catalog.btrim(pg_catalog.regexp_replace(COALESCE(v_signer.email, v_signer.name), '[[:cntrl:]]+', ' ', 'g')), ''), 'Signer');
  v_actor_label := pg_catalog.left(v_actor_label, 254);

  IF v_tok.in_person_host_user_id IS NOT NULL THEN
    PERFORM ludy_sign.public_append_event_with_host(
      v_lookup.org_id,
      v_env.id,
      v_signer.id,
      'in_person_signed',
      'signer',
      v_actor_label,
      v_env.source_sha256,
      pg_catalog.jsonb_build_object(
        'routingOrder', v_signer.routing_order,
        'signatureKind', v_sig_kind,
        'filledFields', v_filled_count,
        'documentCount', v_doc_count,
        'hostUserId', v_tok.in_person_host_user_id::text
      ),
      v_ip_hash,
      v_ua,
      v_now,
      v_tok.in_person_host_user_id
    );
  ELSE
    PERFORM ludy_sign.public_append_event(
      v_lookup.org_id,
      v_env.id,
      v_signer.id,
      'signer_signed',
      'signer',
      v_actor_label,
      v_env.source_sha256,
      pg_catalog.jsonb_build_object(
        'routingOrder', v_signer.routing_order,
        'signatureKind', v_sig_kind,
        'filledFields', v_filled_count,
        'documentCount', v_doc_count
      ),
      v_ip_hash,
      v_ua,
      v_now
    );
  END IF;

  PERFORM ludy_sign.webhook_enqueue_internal(
    v_lookup.org_id,
    v_env.id,
    'sign.signer.signed',
    v_next_env_status,
    v_now,
    v_signer.id,
    v_signer.signer_role,
    v_now,
    NULL,
    NULL,
    NULL
  );

  IF v_all_completed THEN
    PERFORM ludy_sign.public_append_event(
      v_lookup.org_id,
      v_env.id,
      NULL,
      'envelope_completed',
      'system',
      'system:sign-public',
      v_env.source_sha256,
      pg_catalog.jsonb_build_object('completedSignerCount', v_total_signers, 'documentCount', v_doc_count),
      NULL,
      NULL,
      v_now
    );

    INSERT INTO ludy_kernel.outbox_event (org_id, type, payload, actor_type)
    VALUES (
      v_lookup.org_id,
      'sign.envelope.seal_queued',
      pg_catalog.jsonb_build_object('envelopeId', v_env.id::text),
      'system'
    )
    RETURNING id INTO v_outbox_id;

    INSERT INTO ludy_kernel.outbox_pending (org_id, event_id)
    VALUES (v_lookup.org_id, v_outbox_id);

    PERFORM pg_catalog.pg_notify('ludy_outbox', '');
  ELSIF v_env.routing_mode = 'sequential' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM ludy_sign.signer s
      WHERE s.org_id = v_lookup.org_id
        AND s.envelope_id = v_env.id
        AND s.signer_role <> 'cc'
        AND s.status <> 'signed'
        AND s.routing_order <= v_signer.routing_order
    ) THEN
      SELECT pg_catalog.min(s.routing_order)
      INTO v_next_order
      FROM ludy_sign.signer s
      WHERE s.org_id = v_lookup.org_id
        AND s.envelope_id = v_env.id
        AND s.signer_role <> 'cc'
        AND s.status = 'waiting';

      IF v_next_order IS NOT NULL THEN
        v_org_name := COALESCE(NULLIF(pg_catalog.left(pg_catalog.btrim(pg_catalog.regexp_replace(v_tenant.name, '[[:cntrl:]]+', ' ', 'g')), 200), ''), 'Ludy');
        v_doc_title := COALESCE(NULLIF(pg_catalog.left(pg_catalog.btrim(pg_catalog.regexp_replace(v_env.title, '[[:cntrl:]]+', ' ', 'g')), 300), ''), 'Tai lieu');

        FOR v_next_signer IN
          UPDATE ludy_sign.signer s
          SET status = 'pending',
              updated_at = v_now
          WHERE s.org_id = v_lookup.org_id
            AND s.envelope_id = v_env.id
            AND s.signer_role <> 'cc'
            AND s.status = 'waiting'
            AND s.routing_order = v_next_order
          RETURNING s.id, s.delivery_mode, s.email, s.role_label
        LOOP
          IF v_next_signer.delivery_mode = 'email' AND v_next_signer.email IS NOT NULL THEN
            v_to_email := pg_catalog.lower(pg_catalog.btrim(v_next_signer.email));
            v_to_hash := ludy_kernel.mail_address_hash(v_to_email);
            IF v_to_hash IS NOT NULL THEN
              SELECT EXISTS (
                SELECT 1
                FROM ludy_kernel.mail_suppression ms
                WHERE ms.org_id = v_lookup.org_id
                  AND ms.to_hash = v_to_hash
                  AND ms.scope = 'all'
                  AND ms.lifted_at IS NULL
              )
              INTO v_suppressed;

              INSERT INTO ludy_kernel.mail_message (
                org_id, stream, source, source_id, template_key, to_address, to_hash,
                subject, payload, message_id_header, status, created_by
              )
              VALUES (
                v_lookup.org_id,
                'transactional',
                'sign.envelope.send',
                v_next_signer.id,
                'sign.invite',
                v_to_email,
                v_to_hash,
                pg_catalog.left('Moi ky: ' || v_doc_title, 300),
                pg_catalog.jsonb_build_object(
                  'lang', 'vi',
                  'orgName', v_org_name,
                  'envelopeId', v_env.id::text,
                  'signerId', v_next_signer.id::text,
                  'docTitle', v_doc_title,
                  'roleLabel', COALESCE(NULLIF(pg_catalog.left(pg_catalog.btrim(pg_catalog.regexp_replace(v_next_signer.role_label, '[[:cntrl:]]+', ' ', 'g')), 120), ''), 'Nguoi ky'),
                  'expiresAt', CASE WHEN v_env.expires_at IS NOT NULL
                    THEN pg_catalog.to_char(v_env.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
                    ELSE NULL END
                ),
                '<' || pg_catalog.gen_random_uuid()::text || '@' || v_domain || '>',
                CASE WHEN v_suppressed THEN 'suppressed' ELSE 'queued' END,
                NULL
              );
            END IF;
          END IF;
        END LOOP;
      END IF;
    END IF;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'ok',
    'signerId', v_signer.id,
    'signerStatus', 'signed',
    'envelopeStatus', v_next_env_status,
    'completed', v_all_completed,
    'inPerson', v_tok.in_person_host_user_id IS NOT NULL,
    'signedAt', pg_catalog.to_char(v_now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
END $$;

-- ---------------------------------------------------------------------------
-- 8. Least-privilege EXECUTE grants across all created and replaced functions
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION
  ludy_sign.can_attach_confidential_source_file(uuid, uuid, text, uuid, timestamptz, boolean),
  ludy_sign.can_attach_template_source(uuid, uuid, uuid, text),
  ludy_sign.can_attach_envelope_document_file(uuid, uuid, uuid, text),
  ludy_sign.envelope_document_sync(),
  ludy_sign.envelope_document_guard(),
  ludy_sign.envelope_guard(),
  ludy_sign.field_guard(),
  ludy_sign.can_read_sign_file(uuid),
  ludy_sign.is_exportable_sign_file(uuid, uuid, text),
  ludy_sign.cleanup_meeting_minutes_envelopes(uuid, uuid, boolean, uuid[]),
  ludy_sign.public_record_view(text, text, text),
  ludy_sign.public_pdf_source(text),
  ludy_sign.public_pdf_source(text, uuid),
  ludy_sign.public_submit(text, boolean, text, text, jsonb, text, text, text)
FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT rolname
    FROM pg_catalog.pg_roles
    WHERE (rolname LIKE 'ludy\_%' OR rolname LIKE 'crove\_%')
      AND rolname <> current_user
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON FUNCTION '
      || 'ludy_sign.can_attach_confidential_source_file(uuid, uuid, text, uuid, timestamptz, boolean), '
      || 'ludy_sign.can_attach_template_source(uuid, uuid, uuid, text), '
      || 'ludy_sign.can_attach_envelope_document_file(uuid, uuid, uuid, text), '
      || 'ludy_sign.envelope_document_sync(), '
      || 'ludy_sign.envelope_document_guard(), '
      || 'ludy_sign.envelope_guard(), '
      || 'ludy_sign.field_guard(), '
      || 'ludy_sign.can_read_sign_file(uuid), '
      || 'ludy_sign.is_exportable_sign_file(uuid, uuid, text), '
      || 'ludy_sign.cleanup_meeting_minutes_envelopes(uuid, uuid, boolean, uuid[]), '
      || 'ludy_sign.public_record_view(text, text, text), '
      || 'ludy_sign.public_pdf_source(text), '
      || 'ludy_sign.public_pdf_source(text, uuid), '
      || 'ludy_sign.public_submit(text, boolean, text, text, jsonb, text, text, text) '
      || 'FROM %I',
      r.rolname
    );
  END LOOP;
END $$;

GRANT EXECUTE ON FUNCTION
  ludy_sign.can_attach_confidential_source_file(uuid, uuid, text, uuid, timestamptz, boolean),
  ludy_sign.can_attach_template_source(uuid, uuid, uuid, text),
  ludy_sign.can_attach_envelope_document_file(uuid, uuid, uuid, text),
  ludy_sign.can_read_sign_file(uuid),
  ludy_sign.is_exportable_sign_file(uuid, uuid, text)
TO ludy_tenant;

GRANT EXECUTE ON FUNCTION
  ludy_sign.public_record_view(text, text, text),
  ludy_sign.public_pdf_source(text),
  ludy_sign.public_pdf_source(text, uuid),
  ludy_sign.public_submit(text, boolean, text, text, jsonb, text, text, text)
TO ludy_app;
