-- SPDX-License-Identifier: AGPL-3.0-only
-- eSign Slice 3a (#3811, docs/plan/esign.md, ADR-0047):
-- shared meeting minutes handoff (source_kind = 'meeting_minutes') with strict meeting-reader
-- and shared-minutes confidentiality across PostgreSQL RLS policies, SECURITY DEFINER helpers,
-- sign file reads, and organization snapshot export filtering.

SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. Extend crove_sign.envelope source_kind constraint for meeting_minutes
-- ---------------------------------------------------------------------------

ALTER TABLE crove_sign.envelope DROP CONSTRAINT IF EXISTS envelope_source_kind_check;
ALTER TABLE crove_sign.envelope
  ADD CONSTRAINT envelope_source_kind_check
  CHECK (source_kind IN ('standalone', 'crm_quote', 'crm_order', 'hr_contract', 'project_acceptance', 'meeting_minutes'));

ALTER TABLE crove_sign.envelope DROP CONSTRAINT IF EXISTS envelope_meeting_minutes_source_id_check;
ALTER TABLE crove_sign.envelope
  ADD CONSTRAINT envelope_meeting_minutes_source_id_check
  CHECK (source_kind <> 'meeting_minutes' OR source_id IS NOT NULL);

-- ---------------------------------------------------------------------------
-- 2. Reader-scoped meeting minutes authorization helpers in crove_sign
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION crove_sign.is_meeting_minutes_reader(
  p_org_id uuid,
  p_meeting_id uuid
) RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_actor text := crove_kernel.ctx_actor_type();
  v_user uuid := crove_kernel.ctx_user_id();
  v_vis text;
  v_recorder uuid;
BEGIN
  IF v_org IS NULL OR p_org_id IS DISTINCT FROM v_org OR p_meeting_id IS NULL THEN
    RETURN false;
  END IF;
  IF v_actor IS DISTINCT FROM 'user' OR v_user IS NULL THEN
    RETURN false;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m
    WHERE m.org_id = v_org
      AND m.user_id = v_user
      AND m.role IN ('owner', 'admin', 'member')
  ) THEN
    RETURN false;
  END IF;

  SELECT mtg.visibility, mtg.recorder_user_id
  INTO v_vis, v_recorder
  FROM crove_meetings.meeting mtg
  WHERE mtg.org_id = v_org
    AND mtg.id = p_meeting_id
    AND (
      mtg.text_retention_date IS NULL
      OR mtg.text_retention_date > (pg_catalog.now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
    );

  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF v_recorder = v_user THEN
    RETURN true;
  END IF;
  IF v_vis = 'org' AND '*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) THEN
    RETURN true;
  END IF;

  RETURN EXISTS (
    SELECT 1 FROM crove_meetings.meeting_reader r
    WHERE r.org_id = v_org
      AND r.meeting_id = p_meeting_id
      AND r.user_id = v_user
  );
END $$;

-- Internal definer-only helper: invoked only by crove_sign SECURITY DEFINER functions.
REVOKE ALL ON FUNCTION crove_sign.is_meeting_minutes_reader(uuid, uuid)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

CREATE OR REPLACE FUNCTION crove_sign.has_shared_meeting_minutes(
  p_org_id uuid,
  p_meeting_id uuid
) RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
BEGIN
  IF v_org IS NULL OR p_org_id IS DISTINCT FROM v_org OR p_meeting_id IS NULL THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1 FROM crove_meetings.meeting_result mr
    WHERE mr.org_id = v_org
      AND mr.meeting_id = p_meeting_id
      AND mr.stage = 'published'
  ) OR EXISTS (
    SELECT 1 FROM crove_meetings.action_item ai
    WHERE ai.org_id = v_org
      AND ai.meeting_id = p_meeting_id
      AND ai.stage = 'published'
  );
END $$;

-- Internal definer-only helper: invoked only after reader checks pass inside crove_sign definers.
REVOKE ALL ON FUNCTION crove_sign.has_shared_meeting_minutes(uuid, uuid)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- Returns 0 when the meeting does not exist in the org, meetings is disabled, or the caller is not a reader (404);
-- returns 1 when the caller is a reader of the meeting but minutes have not been shared yet (409);
-- returns 2 when the caller may create a meeting_minutes signing envelope.
CREATE OR REPLACE FUNCTION crove_sign.check_meeting_minutes_source(
  p_meeting_id uuid
) RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
BEGIN
  IF v_org IS NULL OR p_meeting_id IS NULL THEN
    RETURN 0;
  END IF;
  IF NOT crove_kernel.org_app_on(v_org, 'meetings') THEN
    RETURN 0;
  END IF;
  IF NOT crove_sign.is_meeting_minutes_reader(v_org, p_meeting_id) THEN
    RETURN 0;
  END IF;
  IF NOT crove_sign.has_shared_meeting_minutes(v_org, p_meeting_id) THEN
    RETURN 1;
  END IF;
  RETURN 2;
END $$;

REVOKE ALL ON FUNCTION crove_sign.check_meeting_minutes_source(uuid)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.check_meeting_minutes_source(uuid) TO crove_tenant;

CREATE OR REPLACE FUNCTION crove_sign.can_create_meeting_minutes_envelope(
  p_org_id uuid,
  p_meeting_id uuid
) RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_org_id IS NULL OR p_org_id IS DISTINCT FROM crove_kernel.ctx_org_id() THEN
    RETURN false;
  END IF;
  RETURN crove_sign.check_meeting_minutes_source(p_meeting_id) = 2;
END $$;

REVOKE ALL ON FUNCTION crove_sign.can_create_meeting_minutes_envelope(uuid, uuid)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.can_create_meeting_minutes_envelope(uuid, uuid) TO crove_tenant;

CREATE OR REPLACE FUNCTION crove_sign.can_access_meeting_minutes_envelope(
  p_org_id uuid,
  p_meeting_id uuid,
  p_created_by uuid
) RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_actor text := crove_kernel.ctx_actor_type();
  v_user uuid := crove_kernel.ctx_user_id();
BEGIN
  IF v_org IS NULL OR p_org_id IS DISTINCT FROM v_org OR v_actor IS NULL THEN
    RETURN false;
  END IF;
  IF v_actor = 'system' THEN
    RETURN true;
  END IF;
  IF v_actor <> 'user' OR v_user IS NULL THEN
    RETURN false;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m
    WHERE m.org_id = v_org
      AND m.user_id = v_user
  ) THEN
    RETURN false;
  END IF;
  IF p_created_by IS NOT NULL AND v_user = p_created_by THEN
    RETURN true;
  END IF;
  IF p_meeting_id IS NULL THEN
    RETURN false;
  END IF;

  RETURN crove_sign.is_meeting_minutes_reader(v_org, p_meeting_id)
    AND crove_sign.has_shared_meeting_minutes(v_org, p_meeting_id);
END $$;

REVOKE ALL ON FUNCTION crove_sign.can_access_meeting_minutes_envelope(uuid, uuid, uuid)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.can_access_meeting_minutes_envelope(uuid, uuid, uuid) TO crove_tenant;

-- ---------------------------------------------------------------------------
-- 3. Snapshot export helpers (ADR-0047 point 7): exclude attendees-only
--    meeting_minutes envelopes, child rows, and files from owner org exports.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION crove_sign.is_exportable_envelope(
  p_org_id uuid,
  p_source_kind text,
  p_source_id uuid
) RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_actor text := crove_kernel.ctx_actor_type();
  v_user uuid := crove_kernel.ctx_user_id();
BEGIN
  IF v_org IS NULL OR p_org_id IS DISTINCT FROM v_org OR v_actor IS NULL THEN
    RETURN false;
  END IF;
  IF v_actor <> 'system' THEN
    IF v_actor <> 'user' OR v_user IS NULL OR NOT EXISTS (
      SELECT 1 FROM crove_kernel.tenant_member m
      WHERE m.org_id = v_org AND m.user_id = v_user AND m.role = 'owner'
    ) THEN
      RETURN false;
    END IF;
  END IF;

  IF p_source_kind IS DISTINCT FROM 'meeting_minutes' THEN
    RETURN true;
  END IF;
  IF p_source_id IS NULL THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1 FROM crove_meetings.meeting mtg
    WHERE mtg.org_id = v_org
      AND mtg.id = p_source_id
      AND mtg.visibility = 'org'
      AND (
        mtg.text_retention_date IS NULL
        OR mtg.text_retention_date > (pg_catalog.now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
      )
  ) AND crove_sign.has_shared_meeting_minutes(v_org, p_source_id);
END $$;

REVOKE ALL ON FUNCTION crove_sign.is_exportable_envelope(uuid, text, uuid)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.is_exportable_envelope(uuid, text, uuid) TO crove_tenant;

CREATE OR REPLACE FUNCTION crove_sign.is_exportable_envelope_id(
  p_org_id uuid,
  p_envelope_id uuid
) RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_source_kind text;
  v_source_id uuid;
BEGIN
  IF p_org_id IS NULL OR p_org_id IS DISTINCT FROM crove_kernel.ctx_org_id() OR p_envelope_id IS NULL THEN
    RETURN false;
  END IF;

  SELECT e.source_kind, e.source_id
  INTO v_source_kind, v_source_id
  FROM crove_sign.envelope e
  WHERE e.org_id = p_org_id AND e.id = p_envelope_id;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  RETURN crove_sign.is_exportable_envelope(p_org_id, v_source_kind, v_source_id);
END $$;

REVOKE ALL ON FUNCTION crove_sign.is_exportable_envelope_id(uuid, uuid)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.is_exportable_envelope_id(uuid, uuid) TO crove_tenant;

CREATE OR REPLACE FUNCTION crove_sign.is_exportable_sign_file(
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
  v_org uuid := crove_kernel.ctx_org_id();
  v_actor text := crove_kernel.ctx_actor_type();
  v_user uuid := crove_kernel.ctx_user_id();
BEGIN
  IF v_org IS NULL OR p_org_id IS DISTINCT FROM v_org OR p_file_id IS NULL OR v_actor IS NULL THEN
    RETURN false;
  END IF;
  IF v_actor <> 'system' THEN
    IF v_actor <> 'user' OR v_user IS NULL OR NOT EXISTS (
      SELECT 1 FROM crove_kernel.tenant_member m
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
       SELECT 1 FROM crove_sign.envelope e
       WHERE e.org_id = v_org
         AND (
           e.source_file_id = p_file_id
           OR e.sealed_file_id = p_file_id
           OR e.certificate_file_id = p_file_id
           OR EXISTS (
             SELECT 1 FROM crove_sign.ca_signing_request r
             WHERE r.org_id = e.org_id
               AND r.envelope_id = e.id
               AND r.pades_file_id = p_file_id
           )
           OR EXISTS (
             SELECT 1 FROM crove_sign.field fld
             WHERE fld.org_id = e.org_id
               AND fld.envelope_id = e.id
               AND fld.attachment_file_id = p_file_id
           )
         )
     ) THEN
    RETURN true;
  END IF;

  -- Superseded or PDPL-erased sign_attachment files (no longer referenced by any field row) stay out of org exports.
  IF p_source = 'sign_attachment'
     AND NOT EXISTS (
       SELECT 1 FROM crove_sign.field fld
       WHERE fld.org_id = v_org
         AND fld.attachment_file_id = p_file_id
     ) THEN
    RETURN false;
  END IF;

  -- 1. Deny sealed PDFs, PAdES PDFs, completion certificates, and supporting attachments of non-exportable envelopes first.
  IF EXISTS (
    SELECT 1 FROM crove_sign.envelope e
    WHERE e.org_id = v_org
      AND (
        e.sealed_file_id = p_file_id
        OR e.certificate_file_id = p_file_id
        OR EXISTS (
          SELECT 1 FROM crove_sign.ca_signing_request r
          WHERE r.org_id = e.org_id
            AND r.envelope_id = e.id
            AND r.pades_file_id = p_file_id
        )
        OR EXISTS (
          SELECT 1 FROM crove_sign.field fld
          WHERE fld.org_id = e.org_id
            AND fld.envelope_id = e.id
            AND fld.attachment_file_id = p_file_id
        )
      )
      AND NOT crove_sign.is_exportable_envelope(v_org, e.source_kind, e.source_id)
  ) THEN
    RETURN false;
  END IF;

  IF EXISTS (
    SELECT 1 FROM crove_sign.envelope e
    WHERE e.org_id = v_org
      AND (
        e.sealed_file_id = p_file_id
        OR e.certificate_file_id = p_file_id
        OR EXISTS (
          SELECT 1 FROM crove_sign.ca_signing_request r
          WHERE r.org_id = e.org_id
            AND r.envelope_id = e.id
            AND r.pades_file_id = p_file_id
        )
        OR EXISTS (
          SELECT 1 FROM crove_sign.field fld
          WHERE fld.org_id = e.org_id
            AND fld.envelope_id = e.id
            AND fld.attachment_file_id = p_file_id
        )
      )
  ) THEN
    RETURN true;
  END IF;

  -- 2. Blank organization-wide template PDFs stay exportable even after instantiating a
  --    confidential envelope from that template, provided the template existed at or before
  --    the confidential envelope was created.
  IF EXISTS (
    SELECT 1 FROM crove_sign.template t
    WHERE t.org_id = v_org
      AND t.source_file_id = p_file_id
  ) AND NOT EXISTS (
    SELECT 1 FROM crove_sign.envelope e
    WHERE e.org_id = v_org
      AND e.source_file_id = p_file_id
      AND NOT crove_sign.is_exportable_envelope(v_org, e.source_kind, e.source_id)
      AND NOT EXISTS (
        SELECT 1 FROM crove_sign.template t2
        WHERE t2.org_id = v_org
          AND t2.source_file_id = p_file_id
          AND t2.created_at <= e.created_at
      )
  ) THEN
    RETURN true;
  END IF;

  -- 3. Deny dedicated source PDFs attached to any non-exportable confidential envelope.
  IF EXISTS (
    SELECT 1 FROM crove_sign.envelope e
    WHERE e.org_id = v_org
      AND e.source_file_id = p_file_id
      AND NOT crove_sign.is_exportable_envelope(v_org, e.source_kind, e.source_id)
  ) THEN
    RETURN false;
  END IF;

  IF EXISTS (
    SELECT 1 FROM crove_sign.envelope e
    WHERE e.org_id = v_org
      AND e.source_file_id = p_file_id
  ) THEN
    RETURN true;
  END IF;

  -- Unattached sign_document files uploaded by non-owners stay private until attached.
  RETURN EXISTS (
    SELECT 1 FROM crove_kernel.file f
    JOIN crove_kernel.tenant_member m
      ON m.org_id = f.org_id AND m.user_id = f.created_by
    WHERE f.org_id = v_org
      AND f.id = p_file_id
      AND f.source = 'sign_document'
      AND m.role = 'owner'
  );
END $$;

REVOKE ALL ON FUNCTION crove_sign.is_exportable_sign_file(uuid, uuid, text)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.is_exportable_sign_file(uuid, uuid, text) TO crove_tenant;

-- ---------------------------------------------------------------------------
-- 4. Restrictive RLS policies for source_kind = 'meeting_minutes' on envelope
--    Child tables (signer, field, ai_analysis, signing_event) already require
--    EXISTS (SELECT 1 FROM crove_sign.envelope e ...) via restrictive policies.
-- ---------------------------------------------------------------------------

-- Prevents reverse source_file_id lockout when creating a confidential envelope (hr_contract / meeting_minutes):
--   - When p_allow_template = false (sign.envelope.create), rejects any source_file_id already referenced by
--     a crove_sign.template (templates must be instantiated via sign.template.instantiate) or by any
--     crove_sign.envelope with a different (source_kind, source_id).
--   - When p_allow_template = true (meeting_minutes_insert RLS, which also covers sign.template.instantiate),
--     allows pre-existing non-archived template PDFs (protected by t2.created_at <= e.created_at in
--     can_read_sign_file / is_exportable_sign_file) while rejecting any non-template source_file_id already
--     referenced by another envelope with a different (source_kind, source_id) or a backdated timestamp.
CREATE OR REPLACE FUNCTION crove_sign.can_attach_confidential_source_file(
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
  v_org uuid := crove_kernel.ctx_org_id();
BEGIN
  IF v_org IS NULL OR p_org_id IS DISTINCT FROM v_org OR p_file_id IS NULL THEN
    RETURN false;
  END IF;
  IF p_source_kind NOT IN ('hr_contract', 'meeting_minutes') THEN
    RETURN false;
  END IF;

  IF EXISTS (
    SELECT 1 FROM crove_sign.template t
    WHERE t.org_id = v_org AND t.source_file_id = p_file_id
  ) THEN
    IF NOT COALESCE(p_allow_template, false) THEN
      RETURN false;
    END IF;
    RETURN p_envelope_created_at IS NOT NULL AND EXISTS (
      SELECT 1 FROM crove_sign.template t2
      WHERE t2.org_id = v_org
        AND t2.source_file_id = p_file_id
        AND t2.status <> 'archived'
        AND t2.created_at <= p_envelope_created_at
    );
  END IF;

  RETURN NOT EXISTS (
    SELECT 1 FROM crove_sign.envelope e
    WHERE e.org_id = v_org
      AND e.source_file_id = p_file_id
      AND (e.source_kind <> p_source_kind OR e.source_id IS DISTINCT FROM p_source_id)
  );
END $$;

REVOKE ALL ON FUNCTION crove_sign.can_attach_confidential_source_file(uuid, uuid, text, uuid, timestamptz, boolean)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.can_attach_confidential_source_file(uuid, uuid, text, uuid, timestamptz, boolean) TO crove_tenant;

DROP POLICY IF EXISTS meeting_minutes_select ON crove_sign.envelope;
CREATE POLICY meeting_minutes_select ON crove_sign.envelope AS RESTRICTIVE FOR SELECT TO crove_tenant
  USING (
    source_kind <> 'meeting_minutes'
    OR crove_sign.can_access_meeting_minutes_envelope(org_id, source_id, created_by)
  );

DROP POLICY IF EXISTS meeting_minutes_insert ON crove_sign.envelope;
CREATE POLICY meeting_minutes_insert ON crove_sign.envelope AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK (
    source_kind <> 'meeting_minutes'
    OR (SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR (
      (SELECT crove_kernel.ctx_actor_type()) = 'user'
      AND created_by = (SELECT crove_kernel.ctx_user_id())
      AND source_id IS NOT NULL
      AND crove_sign.can_create_meeting_minutes_envelope(org_id, source_id)
      AND crove_sign.can_attach_confidential_source_file(org_id, source_file_id, 'meeting_minutes', source_id, created_at, true)
    )
  );

DROP POLICY IF EXISTS meeting_minutes_update ON crove_sign.envelope;
CREATE POLICY meeting_minutes_update ON crove_sign.envelope AS RESTRICTIVE FOR UPDATE TO crove_tenant
  USING (
    source_kind <> 'meeting_minutes'
    OR crove_sign.can_access_meeting_minutes_envelope(org_id, source_id, created_by)
  )
  WITH CHECK (
    source_kind <> 'meeting_minutes'
    OR crove_sign.can_access_meeting_minutes_envelope(org_id, source_id, created_by)
  );

DROP POLICY IF EXISTS meeting_minutes_delete ON crove_sign.envelope;
CREATE POLICY meeting_minutes_delete ON crove_sign.envelope AS RESTRICTIVE FOR DELETE TO crove_tenant
  USING (
    source_kind <> 'meeting_minutes'
    OR crove_sign.can_access_meeting_minutes_envelope(org_id, source_id, created_by)
  );

-- Prevents raw crove_tenant INSERT on crove_sign.template from attaching a dedicated confidential
-- hr_contract or meeting_minutes PDF (closing direct-SQL exfiltration via template_direct_link_* / public_hub_*).
CREATE OR REPLACE FUNCTION crove_sign.can_attach_template_source(
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
  v_org uuid := crove_kernel.ctx_org_id();
BEGIN
  IF v_org IS NULL OR p_org_id IS DISTINCT FROM v_org OR p_file_id IS NULL OR p_storage_key IS NULL THEN
    RETURN false;
  END IF;

  RETURN NOT EXISTS (
    SELECT 1 FROM crove_sign.envelope e
    WHERE e.org_id = v_org
      AND e.source_kind IN ('hr_contract', 'meeting_minutes')
      AND (e.source_file_id = p_file_id OR e.source_storage_key = p_storage_key)
      AND NOT EXISTS (
        SELECT 1 FROM crove_sign.template t
        WHERE t.org_id = v_org
          AND t.id IS DISTINCT FROM p_template_id
          AND t.source_file_id = e.source_file_id
          AND t.source_storage_key = e.source_storage_key
          AND t.created_at <= e.created_at
      )
  );
END $$;

REVOKE ALL ON FUNCTION crove_sign.can_attach_template_source(uuid, uuid, uuid, text)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.can_attach_template_source(uuid, uuid, uuid, text) TO crove_tenant;

DROP POLICY IF EXISTS template_confidential_source_insert ON crove_sign.template;
CREATE POLICY template_confidential_source_insert ON crove_sign.template AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK (
    (SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR crove_sign.can_attach_template_source(org_id, id, source_file_id, source_storage_key)
  );

-- ---------------------------------------------------------------------------
-- 5. Sign file read authorization helper (deny-first for confidential files)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION crove_sign.can_read_sign_file(p_file_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_actor text := crove_kernel.ctx_actor_type();
  v_user uuid := crove_kernel.ctx_user_id();
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
  FROM crove_kernel.tenant_member m
  WHERE m.org_id = v_org AND m.user_id = v_user;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  -- Superseded or PDPL-erased sign_attachment files (no longer referenced by any field row) are unreadable to all users (#3818).
  IF EXISTS (
    SELECT 1 FROM crove_kernel.file f
    WHERE f.org_id = v_org
      AND f.id = p_file_id
      AND f.source = 'sign_attachment'
  ) AND NOT EXISTS (
    SELECT 1 FROM crove_sign.field fld
    WHERE fld.org_id = v_org
      AND fld.attachment_file_id = p_file_id
  ) THEN
    RETURN false;
  END IF;

  -- Deny-first on sealed PDFs, PAdES PDFs, completion certificates, and supporting attachments of inaccessible confidential envelopes.
  IF EXISTS (
    SELECT 1 FROM crove_sign.envelope e
    WHERE e.org_id = v_org
      AND (
        e.sealed_file_id = p_file_id
        OR e.certificate_file_id = p_file_id
        OR EXISTS (
          SELECT 1 FROM crove_sign.ca_signing_request r
          WHERE r.org_id = e.org_id
            AND r.envelope_id = e.id
            AND r.pades_file_id = p_file_id
        )
        OR EXISTS (
          SELECT 1 FROM crove_sign.field fld
          WHERE fld.org_id = e.org_id
            AND fld.envelope_id = e.id
            AND fld.attachment_file_id = p_file_id
        )
      )
      AND (
        (e.source_kind = 'hr_contract' AND v_role NOT IN ('owner', 'admin') AND e.created_by <> v_user)
        OR (e.source_kind = 'meeting_minutes' AND NOT crove_sign.can_access_meeting_minutes_envelope(v_org, e.source_id, e.created_by))
      )
  ) THEN
    RETURN false;
  END IF;

  IF EXISTS (
    SELECT 1 FROM crove_sign.envelope e
    WHERE e.org_id = v_org
      AND (
        e.sealed_file_id = p_file_id
        OR e.certificate_file_id = p_file_id
        OR EXISTS (
          SELECT 1 FROM crove_sign.ca_signing_request r
          WHERE r.org_id = e.org_id
            AND r.envelope_id = e.id
            AND r.pades_file_id = p_file_id
        )
        OR EXISTS (
          SELECT 1 FROM crove_sign.field fld
          WHERE fld.org_id = e.org_id
            AND fld.envelope_id = e.id
            AND fld.attachment_file_id = p_file_id
        )
      )
  ) THEN
    RETURN true;
  END IF;

  -- Blank organization-wide template PDFs stay readable by workspace members even after
  -- instantiating a confidential envelope from that template, provided the template existed
  -- at or before the confidential envelope was created.
  IF EXISTS (
    SELECT 1 FROM crove_sign.template t
    WHERE t.org_id = v_org
      AND t.source_file_id = p_file_id
  ) AND NOT EXISTS (
    SELECT 1 FROM crove_sign.envelope e
    WHERE e.org_id = v_org
      AND e.source_file_id = p_file_id
      AND e.source_kind IN ('hr_contract', 'meeting_minutes')
      AND NOT EXISTS (
        SELECT 1 FROM crove_sign.template t2
        WHERE t2.org_id = v_org
          AND t2.source_file_id = p_file_id
          AND t2.created_at <= e.created_at
      )
  ) THEN
    RETURN true;
  END IF;

  -- Deny-first on source PDFs attached to any confidential envelope the caller cannot access,
  -- preventing privilege escalation by attaching the same file to a standalone envelope.
  IF EXISTS (
    SELECT 1 FROM crove_sign.envelope e
    WHERE e.org_id = v_org
      AND e.source_file_id = p_file_id
      AND (
        (e.source_kind = 'hr_contract' AND v_role NOT IN ('owner', 'admin') AND e.created_by <> v_user)
        OR (e.source_kind = 'meeting_minutes' AND NOT crove_sign.can_access_meeting_minutes_envelope(v_org, e.source_id, e.created_by))
      )
  ) THEN
    RETURN false;
  END IF;

  IF EXISTS (
    SELECT 1 FROM crove_sign.envelope e
    WHERE e.org_id = v_org
      AND e.source_file_id = p_file_id
  ) THEN
    RETURN true;
  END IF;

  -- Unattached sign_document files are readable only by their uploader until attached to an envelope or template.
  RETURN EXISTS (
    SELECT 1 FROM crove_kernel.file f
    WHERE f.org_id = v_org
      AND f.id = p_file_id
      AND f.source = 'sign_document'
      AND f.created_by = v_user
  );
END $$;

REVOKE ALL ON FUNCTION crove_sign.can_read_sign_file(uuid)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.can_read_sign_file(uuid) TO crove_tenant;

-- ---------------------------------------------------------------------------
-- 6. Harden crove_tenant SECURITY DEFINER helpers for meeting_minutes
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION crove_sign.mint_signing_token(
  p_envelope_id uuid,
  p_signer_id uuid,
  p_token_sha256 text,
  p_expires_at timestamptz
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_actor text := crove_kernel.ctx_actor_type();
  v_user uuid := crove_kernel.ctx_user_id();
  v_now timestamptz := pg_catalog.now();
  v_role text;
  v_env_status text;
  v_env_creator uuid;
  v_env_source_kind text;
  v_env_source_id uuid;
  v_signer_status text;
  v_token_id uuid;
BEGIN
  IF v_org IS NULL OR v_actor IS NULL THEN
    RAISE EXCEPTION 'SIGN_CONTEXT_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF v_actor NOT IN ('user', 'system') THEN
    RAISE EXCEPTION 'SIGN_FORBIDDEN_ACTOR' USING ERRCODE = '42501';
  END IF;
  IF v_actor = 'user' THEN
    IF v_user IS NULL THEN
      RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    SELECT m.role INTO v_role
    FROM crove_kernel.tenant_member m
    WHERE m.org_id = v_org AND m.user_id = v_user AND m.role IN ('owner', 'admin', 'member');
    IF NOT FOUND THEN
      RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF p_token_sha256 IS NULL OR p_token_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'SIGN_INVALID_TOKEN_HASH' USING ERRCODE = '22023';
  END IF;
  IF p_expires_at IS NULL OR p_expires_at <= v_now THEN
    RAISE EXCEPTION 'SIGN_INVALID_EXPIRY' USING ERRCODE = '22023';
  END IF;

  SELECT e.status, e.created_by, e.source_kind, e.source_id
  INTO v_env_status, v_env_creator, v_env_source_kind, v_env_source_id
  FROM crove_sign.envelope e
  WHERE e.org_id = v_org AND e.id = p_envelope_id
  FOR SHARE;
  IF v_env_status IS NULL OR v_env_status NOT IN ('sent', 'in_progress') THEN
    RAISE EXCEPTION 'ENVELOPE_NOT_ACTIVE' USING ERRCODE = '42501';
  END IF;
  IF v_actor = 'user'
     AND v_env_source_kind = 'hr_contract'
     AND v_user IS DISTINCT FROM v_env_creator
     AND v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'ENVELOPE_NOT_ACTIVE' USING ERRCODE = '42501';
  END IF;
  IF v_actor = 'user'
     AND v_env_source_kind = 'meeting_minutes'
     AND NOT crove_sign.can_access_meeting_minutes_envelope(v_org, v_env_source_id, v_env_creator) THEN
    RAISE EXCEPTION 'ENVELOPE_NOT_ACTIVE' USING ERRCODE = '42501';
  END IF;

  SELECT s.status INTO v_signer_status
  FROM crove_sign.signer s
  WHERE s.org_id = v_org AND s.id = p_signer_id AND s.envelope_id = p_envelope_id
  FOR UPDATE;
  IF v_signer_status IS NULL OR v_signer_status NOT IN ('pending', 'viewed') THEN
    RAISE EXCEPTION 'SIGNER_NOT_LIVE' USING ERRCODE = '42501';
  END IF;

  UPDATE crove_sign.signing_token t
  SET revoked_at = v_now,
      revoked_by = COALESCE(v_user, v_env_creator)
  WHERE t.org_id = v_org
    AND t.signer_id = p_signer_id
    AND t.revoked_at IS NULL
    AND t.used_at IS NULL;

  UPDATE crove_sign.signing_otp o
  SET invalidated_at = v_now
  WHERE o.org_id = v_org
    AND o.signer_id = p_signer_id
    AND o.invalidated_at IS NULL
    AND o.verified_at IS NULL;

  INSERT INTO crove_sign.signing_token (org_id, envelope_id, signer_id, token_sha256, expires_at, created_by)
  VALUES (v_org, p_envelope_id, p_signer_id, p_token_sha256, p_expires_at, COALESCE(v_user, v_env_creator))
  RETURNING id INTO v_token_id;

  RETURN v_token_id;
END $$;

REVOKE ALL ON FUNCTION crove_sign.mint_signing_token(uuid, uuid, text, timestamptz)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.mint_signing_token(uuid, uuid, text, timestamptz) TO crove_tenant;

-- Restated from 20270208000000 (#3820) to enforce ADR-0047 reader-scoped meeting_minutes confidentiality
-- (zero-oracle ENVELOPE_NOT_ACTIVE parity even for non-reader owners/admins) alongside hr_contract confidentiality.
CREATE OR REPLACE FUNCTION crove_sign.mint_in_person_signing_token(
  p_envelope_id uuid,
  p_signer_id uuid,
  p_token_sha256 text,
  p_expires_at timestamptz
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_actor text := crove_kernel.ctx_actor_type();
  v_user uuid := crove_kernel.ctx_user_id();
  v_now timestamptz := pg_catalog.now();
  v_role text;
  v_env_status text;
  v_env_creator uuid;
  v_env_source_kind text;
  v_env_source_id uuid;
  v_env_expires_at timestamptz;
  v_signer_status text;
  v_signer_role text;
  v_token_id uuid;
BEGIN
  IF v_org IS NULL OR v_actor IS DISTINCT FROM 'user' OR crove_kernel.ctx_agent_id() IS NOT NULL OR v_user IS NULL THEN
    RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF NOT crove_kernel.org_app_on(v_org, 'sign') THEN
    RAISE EXCEPTION 'SIGN_APP_DISABLED' USING ERRCODE = '42501';
  END IF;

  SELECT m.role INTO v_role
  FROM crove_kernel.tenant_member m
  WHERE m.org_id = v_org
    AND m.user_id = v_user
    AND m.role IN ('owner', 'admin', 'member');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  IF p_token_sha256 IS NULL OR p_token_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'SIGN_INVALID_TOKEN_HASH' USING ERRCODE = '22023';
  END IF;
  IF p_expires_at IS NULL OR p_expires_at <= v_now OR p_expires_at > v_now + interval '2 hours' + interval '5 minutes' THEN
    RAISE EXCEPTION 'SIGN_INVALID_EXPIRY' USING ERRCODE = '22023';
  END IF;

  SELECT e.status, e.created_by, e.source_kind, e.source_id, e.expires_at
  INTO v_env_status, v_env_creator, v_env_source_kind, v_env_source_id, v_env_expires_at
  FROM crove_sign.envelope e
  WHERE e.org_id = v_org AND e.id = p_envelope_id
  FOR SHARE;
  IF v_env_status IS NULL OR v_env_status NOT IN ('sent', 'in_progress') THEN
    RAISE EXCEPTION 'ENVELOPE_NOT_ACTIVE' USING ERRCODE = '42501';
  END IF;
  IF v_env_expires_at IS NOT NULL AND v_env_expires_at <= v_now THEN
    RAISE EXCEPTION 'ENVELOPE_NOT_ACTIVE' USING ERRCODE = '42501';
  END IF;
  IF v_env_source_kind = 'hr_contract'
     AND v_user IS DISTINCT FROM v_env_creator
     AND v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'ENVELOPE_NOT_ACTIVE' USING ERRCODE = '42501';
  END IF;
  IF v_env_source_kind = 'meeting_minutes'
     AND NOT crove_sign.can_access_meeting_minutes_envelope(v_org, v_env_source_id, v_env_creator) THEN
    RAISE EXCEPTION 'ENVELOPE_NOT_ACTIVE' USING ERRCODE = '42501';
  END IF;

  SELECT s.status, s.signer_role
  INTO v_signer_status, v_signer_role
  FROM crove_sign.signer s
  WHERE s.org_id = v_org AND s.id = p_signer_id AND s.envelope_id = p_envelope_id
  FOR UPDATE;
  IF v_signer_status IS NULL OR v_signer_role = 'cc' OR v_signer_status NOT IN ('pending', 'viewed') THEN
    RAISE EXCEPTION 'SIGNER_NOT_LIVE' USING ERRCODE = '42501';
  END IF;

  UPDATE crove_sign.signing_token t
  SET revoked_at = v_now,
      revoked_by = v_user
  WHERE t.org_id = v_org
    AND t.signer_id = p_signer_id
    AND t.revoked_at IS NULL
    AND t.used_at IS NULL;

  UPDATE crove_sign.signing_otp o
  SET invalidated_at = v_now
  WHERE o.org_id = v_org
    AND o.signer_id = p_signer_id
    AND o.invalidated_at IS NULL
    AND o.verified_at IS NULL;

  INSERT INTO crove_sign.signing_token (
    org_id, envelope_id, signer_id, token_sha256, expires_at, in_person_host_user_id, created_by, created_at
  )
  VALUES (
    v_org, p_envelope_id, p_signer_id, p_token_sha256, p_expires_at, v_user, v_user, v_now
  )
  RETURNING id INTO v_token_id;

  RETURN v_token_id;
END $$;

REVOKE ALL ON FUNCTION crove_sign.mint_in_person_signing_token(uuid, uuid, text, timestamptz)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.mint_in_person_signing_token(uuid, uuid, text, timestamptz) TO crove_tenant;

CREATE OR REPLACE FUNCTION crove_sign.revoke_envelope_tokens(p_envelope_id uuid) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_actor text := crove_kernel.ctx_actor_type();
  v_user uuid := crove_kernel.ctx_user_id();
  v_now timestamptz := pg_catalog.now();
  v_role text;
  v_env_creator uuid;
  v_env_source_kind text;
  v_env_source_id uuid;
  v_count integer := 0;
BEGIN
  IF v_org IS NULL OR v_actor IS NULL THEN
    RAISE EXCEPTION 'SIGN_CONTEXT_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF v_actor NOT IN ('user', 'system') THEN
    RAISE EXCEPTION 'SIGN_FORBIDDEN_ACTOR' USING ERRCODE = '42501';
  END IF;
  IF v_actor = 'user' THEN
    IF v_user IS NULL THEN
      RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    SELECT m.role INTO v_role
    FROM crove_kernel.tenant_member m
    WHERE m.org_id = v_org AND m.user_id = v_user AND m.role IN ('owner', 'admin', 'member');
    IF NOT FOUND THEN
      RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501';
    END IF;

    SELECT e.created_by, e.source_kind, e.source_id
    INTO v_env_creator, v_env_source_kind, v_env_source_id
    FROM crove_sign.envelope e
    WHERE e.org_id = v_org AND e.id = p_envelope_id
    FOR SHARE;
    IF NOT FOUND THEN
      RETURN 0;
    END IF;
    IF v_env_source_kind = 'hr_contract'
       AND v_user IS DISTINCT FROM v_env_creator
       AND v_role NOT IN ('owner', 'admin') THEN
      RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    -- Return 0 (identical to NOT FOUND) for inaccessible meeting_minutes envelopes so non-readers cannot probe UUIDs.
    IF v_env_source_kind = 'meeting_minutes'
       AND NOT crove_sign.can_access_meeting_minutes_envelope(v_org, v_env_source_id, v_env_creator) THEN
      RETURN 0;
    END IF;
  END IF;

  WITH revoked AS (
    UPDATE crove_sign.signing_token t
    SET revoked_at = v_now,
        revoked_by = v_user
    WHERE t.org_id = v_org
      AND t.envelope_id = p_envelope_id
      AND t.revoked_at IS NULL
      AND t.used_at IS NULL
    RETURNING t.id
  )
  SELECT pg_catalog.count(*)::integer INTO v_count FROM revoked;

  UPDATE crove_sign.signing_otp o
  SET invalidated_at = v_now
  FROM crove_sign.signing_token t
  WHERE o.org_id = v_org
    AND t.org_id = o.org_id
    AND t.id = o.signing_token_id
    AND t.envelope_id = p_envelope_id
    AND o.invalidated_at IS NULL
    AND o.verified_at IS NULL;

  RETURN v_count;
END $$;

REVOKE ALL ON FUNCTION crove_sign.revoke_envelope_tokens(uuid)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.revoke_envelope_tokens(uuid) TO crove_tenant;

CREATE OR REPLACE FUNCTION crove_sign.template_inherit_inspect(
  p_template_id uuid,
  p_envelope_id uuid
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_actor text := crove_kernel.ctx_actor_type();
  v_user uuid := crove_kernel.ctx_user_id();
  v_role text;
  v_tpl record;
  v_env record;
BEGIN
  IF v_org IS NULL OR v_actor IS NULL THEN
    RAISE EXCEPTION 'SIGN_CONTEXT_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF v_actor NOT IN ('user', 'system') THEN
    RAISE EXCEPTION 'SIGN_FORBIDDEN_ACTOR' USING ERRCODE = '42501';
  END IF;
  IF NOT crove_kernel.org_app_on(v_org, 'sign') THEN
    RAISE EXCEPTION 'SIGN_APP_DISABLED' USING ERRCODE = '42501';
  END IF;
  IF v_actor = 'user' THEN
    IF v_user IS NULL THEN
      RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    SELECT m.role INTO v_role
    FROM crove_kernel.tenant_member m
    WHERE m.org_id = v_org AND m.user_id = v_user AND m.role IN ('owner', 'admin', 'member');
    IF NOT FOUND THEN
      RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
  END IF;

  SELECT t.id, t.status, t.inspect_status, t.page_count, t.page_dimensions_json, t.detected_tags_json,
         t.source_file_id, t.source_storage_key, t.source_generation, t.source_sha256
  INTO v_tpl
  FROM crove_sign.template t
  WHERE t.org_id = v_org AND t.id = p_template_id
  FOR SHARE;

  IF NOT FOUND OR v_tpl.status NOT IN ('draft', 'active') OR v_tpl.inspect_status <> 'passed' OR v_tpl.page_count IS NULL THEN
    RETURN false;
  END IF;

  SELECT e.id, e.status, e.inspect_status, e.source_kind, e.source_id, e.created_by,
         e.source_file_id, e.source_storage_key, e.source_generation, e.source_sha256
  INTO v_env
  FROM crove_sign.envelope e
  WHERE e.org_id = v_org AND e.id = p_envelope_id
  FOR UPDATE;

  IF NOT FOUND OR v_env.status <> 'draft' OR v_env.inspect_status <> 'pending' THEN
    RETURN false;
  END IF;
  IF v_actor = 'user'
     AND v_env.source_kind = 'hr_contract'
     AND v_user IS DISTINCT FROM v_env.created_by
     AND v_role NOT IN ('owner', 'admin') THEN
    RETURN false;
  END IF;
  IF v_actor = 'user'
     AND v_env.source_kind = 'meeting_minutes'
     AND NOT crove_sign.can_access_meeting_minutes_envelope(v_org, v_env.source_id, v_env.created_by) THEN
    RETURN false;
  END IF;
  IF v_env.source_file_id IS DISTINCT FROM v_tpl.source_file_id
     OR v_env.source_storage_key IS DISTINCT FROM v_tpl.source_storage_key
     OR v_env.source_generation IS DISTINCT FROM v_tpl.source_generation
     OR v_env.source_sha256 IS DISTINCT FROM v_tpl.source_sha256 THEN
    RAISE EXCEPTION 'SIGN_TEMPLATE_SOURCE_MISMATCH' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_catalog.set_config('crove.sign_template_inherit', p_envelope_id::text, true);

  UPDATE crove_sign.envelope
  SET inspect_status = 'passed',
      inspect_error = NULL,
      page_count = v_tpl.page_count,
      page_dimensions_json = v_tpl.page_dimensions_json,
      detected_tags_json = v_tpl.detected_tags_json,
      updated_at = pg_catalog.now()
  WHERE org_id = v_org AND id = p_envelope_id;

  PERFORM pg_catalog.set_config('crove.sign_template_inherit', '', true);

  RETURN true;
END $$;

REVOKE ALL ON FUNCTION crove_sign.template_inherit_inspect(uuid, uuid)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.template_inherit_inspect(uuid, uuid) TO crove_tenant;

-- Restated from 20270202120000 (#3819) to enforce ADR-0047 reader-scoped meeting_minutes confidentiality
-- (404 parity even for non-reader owners/admins) alongside hr_contract confidentiality.
CREATE OR REPLACE FUNCTION crove_sign.correct_signer_recipient(
  p_envelope_id uuid,
  p_signer_id uuid,
  p_name text,
  p_email text,
  p_phone text,
  p_delivery_mode text,
  p_require_email_otp boolean,
  p_now timestamptz DEFAULT pg_catalog.now()
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_actor text := crove_kernel.ctx_actor_type();
  v_user uuid := crove_kernel.ctx_user_id();
  v_agent uuid := crove_kernel.ctx_agent_id();
  v_now timestamptz := COALESCE(p_now, pg_catalog.now());
  v_role text;
  v_env record;
  v_signer record;
  v_name text := NULLIF(pg_catalog.btrim(pg_catalog.regexp_replace(COALESCE(p_name, ''), '[[:cntrl:]]+', ' ', 'g')), '');
  v_email text := NULLIF(pg_catalog.lower(pg_catalog.btrim(COALESCE(p_email, ''))), '');
  v_phone text := NULLIF(pg_catalog.btrim(pg_catalog.regexp_replace(COALESCE(p_phone, ''), '[[:cntrl:]]+', ' ', 'g')), '');
  v_delivery_mode text := pg_catalog.btrim(COALESCE(p_delivery_mode, ''));
  v_require_otp boolean := false;
  v_next_status text;
  v_next_version integer;
  v_revoked_tokens integer := 0;
  v_invalidated_otps integer := 0;
  v_to_hash text;
  v_suppressed boolean := false;
BEGIN
  IF v_org IS NULL OR v_actor IS DISTINCT FROM 'user' OR v_agent IS NOT NULL OR v_user IS NULL THEN
    RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  IF NOT crove_kernel.org_app_on(v_org, 'sign') THEN
    RAISE EXCEPTION 'MODULE_OFF' USING ERRCODE = '42501';
  END IF;

  SELECT m.role INTO v_role
  FROM crove_kernel.tenant_member m
  WHERE m.org_id = v_org
    AND m.user_id = v_user;

  IF v_role IS NULL OR v_role NOT IN ('owner', 'admin', 'member') THEN
    RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  IF p_envelope_id IS NULL OR p_signer_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found', 'target', 'envelope');
  END IF;

  -- Canonical lock order: envelope -> signer -> signing_token -> signing_otp.
  SELECT e.*
  INTO v_env
  FROM crove_sign.envelope e
  WHERE e.org_id = v_org
    AND e.id = p_envelope_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found', 'target', 'envelope');
  END IF;

  -- Enforce strict HR contract confidentiality (404 parity for non-privileged non-creators).
  IF v_env.source_kind = 'hr_contract'
     AND v_role NOT IN ('owner', 'admin')
     AND v_env.created_by IS DISTINCT FROM v_user THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found', 'target', 'envelope');
  END IF;

  -- Enforce ADR-0047 reader-scoped meeting_minutes confidentiality (404 parity even for non-reader owners/admins).
  IF v_env.source_kind = 'meeting_minutes'
     AND NOT crove_sign.can_access_meeting_minutes_envelope(v_org, v_env.source_id, v_env.created_by) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found', 'target', 'envelope');
  END IF;

  IF v_role NOT IN ('owner', 'admin') AND v_env.created_by IS DISTINCT FROM v_user THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'SIGN_FORBIDDEN',
      'httpStatus', 403,
      'message', 'Only the envelope creator, owner, or admin can correct a recipient'
    );
  END IF;

  IF v_env.status NOT IN ('sent', 'in_progress') THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'SIGN_ENVELOPE_NOT_ACTIVE',
      'httpStatus', 409,
      'message', 'Recipients can only be corrected while the envelope is sent or in progress'
    );
  END IF;

  IF v_env.expires_at IS NOT NULL AND v_env.expires_at <= v_now THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'SIGN_ENVELOPE_EXPIRED',
      'httpStatus', 409,
      'message', 'Envelope has expired'
    );
  END IF;

  SELECT s.*
  INTO v_signer
  FROM crove_sign.signer s
  WHERE s.org_id = v_org
    AND s.envelope_id = v_env.id
    AND s.id = p_signer_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found', 'target', 'signer');
  END IF;

  v_require_otp := COALESCE(p_require_email_otp, v_signer.require_email_otp);

  IF v_signer.status NOT IN ('waiting', 'pending', 'viewed') THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'SIGN_SIGNER_ALREADY_COMPLETED',
      'httpStatus', 409,
      'message', 'Cannot correct a recipient who has already signed or declined'
    );
  END IF;

  IF v_name IS NULL OR pg_catalog.length(v_name) > 200 THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'VALIDATION',
      'httpStatus', 422,
      'message', 'Recipient name must be between 1 and 200 characters'
    );
  END IF;

  IF v_delivery_mode NOT IN ('link', 'email') THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'VALIDATION',
      'httpStatus', 422,
      'message', 'Invalid delivery mode'
    );
  END IF;

  IF v_signer.signer_role = 'cc' AND v_require_otp THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'SIGN_INVALID_SIGNER',
      'httpStatus', 422,
      'message', 'CC recipients cannot require email OTP'
    );
  END IF;

  IF v_email IS NOT NULL AND NOT crove_sign.is_single_mail_address(v_email) THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'VALIDATION',
      'httpStatus', 422,
      'message', 'Invalid recipient email address'
    );
  END IF;

  IF (v_delivery_mode = 'email' OR v_require_otp) AND v_email IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'SIGN_EMAIL_REQUIRED',
      'httpStatus', 422,
      'message', 'Email address is required for email delivery or email OTP'
    );
  END IF;

  IF (v_delivery_mode = 'email' OR v_require_otp) AND v_email IS NOT NULL THEN
    v_to_hash := crove_kernel.mail_address_hash(v_email);
    IF v_to_hash IS NULL THEN
      RETURN pg_catalog.jsonb_build_object(
        'status', 'error',
        'code', 'SIGN_EMAIL_SUPPRESSED',
        'httpStatus', 422,
        'message', 'Recipient email address cannot receive invitations'
      );
    END IF;
    SELECT EXISTS (
      SELECT 1
      FROM crove_kernel.mail_suppression ms
      WHERE ms.org_id = v_org
        AND ms.to_hash = v_to_hash
        AND ms.scope = 'all'
        AND ms.lifted_at IS NULL
    )
    INTO v_suppressed;
    IF v_suppressed THEN
      RETURN pg_catalog.jsonb_build_object(
        'status', 'error',
        'code', 'SIGN_EMAIL_SUPPRESSED',
        'httpStatus', 422,
        'message', 'Recipient email address is suppressed'
      );
    END IF;
  END IF;

  IF v_phone IS NOT NULL AND (pg_catalog.length(v_phone) < 6 OR pg_catalog.length(v_phone) > 32) THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'error',
      'code', 'VALIDATION',
      'httpStatus', 422,
      'message', 'Phone number must be between 6 and 32 characters'
    );
  END IF;

  PERFORM 1
  FROM crove_sign.signing_token t
  WHERE t.org_id = v_org
    AND t.signer_id = v_signer.id
    AND t.revoked_at IS NULL
    AND t.used_at IS NULL
  ORDER BY t.id
  FOR UPDATE;

  PERFORM 1
  FROM crove_sign.signing_otp o
  WHERE o.org_id = v_org
    AND o.signer_id = v_signer.id
    AND o.invalidated_at IS NULL
  ORDER BY o.id
  FOR UPDATE;

  UPDATE crove_sign.signing_token t
  SET revoked_at = v_now,
      revoked_by = v_user
  WHERE t.org_id = v_org
    AND t.signer_id = v_signer.id
    AND t.revoked_at IS NULL
    AND t.used_at IS NULL;
  GET DIAGNOSTICS v_revoked_tokens = ROW_COUNT;

  UPDATE crove_sign.signing_otp o
  SET invalidated_at = v_now
  WHERE o.org_id = v_org
    AND o.signer_id = v_signer.id
    AND o.invalidated_at IS NULL;
  GET DIAGNOSTICS v_invalidated_otps = ROW_COUNT;

  v_next_status := CASE WHEN v_signer.status = 'viewed' THEN 'pending' ELSE v_signer.status END;
  v_next_version := v_env.version + 1;

  PERFORM pg_catalog.set_config('crove.sign_correct_signer', v_signer.id::text, true);
  PERFORM pg_catalog.set_config('crove.sign_correct_envelope', v_env.id::text, true);

  UPDATE crove_sign.signer s
  SET name = v_name,
      email = v_email,
      phone = v_phone,
      delivery_mode = v_delivery_mode,
      require_email_otp = v_require_otp,
      status = v_next_status,
      viewed_at = NULL,
      otp_verified_at = NULL,
      token_last_reminded_at = NULL,
      updated_at = v_now
  WHERE s.org_id = v_org
    AND s.envelope_id = v_env.id
    AND s.id = v_signer.id;

  UPDATE crove_sign.envelope e
  SET version = v_next_version,
      updated_at = v_now
  WHERE e.org_id = v_org
    AND e.id = v_env.id;

  PERFORM pg_catalog.set_config('crove.sign_correct_signer', '', true);
  PERFORM pg_catalog.set_config('crove.sign_correct_envelope', '', true);

  RETURN pg_catalog.jsonb_build_object(
    'status', 'ok',
    'envelopeId', v_env.id,
    'envelopeTitle', v_env.title,
    'envelopeExpiresAt', CASE WHEN v_env.expires_at IS NOT NULL
      THEN pg_catalog.to_char(v_env.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      ELSE NULL END,
    'sourceSha256', v_env.source_sha256,
    'version', v_next_version,
    'signerId', v_signer.id,
    'signerRole', v_signer.signer_role,
    'roleLabel', v_signer.role_label,
    'signerStatus', v_next_status,
    'name', v_name,
    'email', v_email,
    'phone', v_phone,
    'deliveryMode', v_delivery_mode,
    'requireEmailOtp', v_require_otp,
    'previousName', v_signer.name,
    'previousEmail', v_signer.email,
    'previousPhone', v_signer.phone,
    'previousDeliveryMode', v_signer.delivery_mode,
    'previousRequireEmailOtp', v_signer.require_email_otp,
    'revokedTokens', v_revoked_tokens,
    'invalidatedOtps', v_invalidated_otps
  );
END $$;

REVOKE ALL ON FUNCTION crove_sign.correct_signer_recipient(uuid, uuid, text, text, text, text, boolean, timestamptz)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.correct_signer_recipient(uuid, uuid, text, text, text, text, boolean, timestamptz)
  TO crove_tenant;
