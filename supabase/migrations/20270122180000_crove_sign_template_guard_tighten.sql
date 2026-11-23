-- SPDX-License-Identifier: AGPL-3.0-only
-- eSign Slice 2a follow-up (#3566, step 2 of 2 after #4014):
-- tighten crove_sign.template_guard() so raw SQL INSERT or UPDATE with inspect_status = 'passed'
-- requires page_count IS NOT NULL and a matching inspected same-org source PDF in crove_kernel.file,
-- preserving all existing status, immutability, archive, and detected_tags_json checks from 20270108110000.

SET LOCAL lock_timeout = '2s';

-- Normalize any hypothetical legacy row where inspect_status was marked 'passed' without page_count
-- before tightening template_guard() (also revokes any active direct link via template_direct_link_sync_on_template).
UPDATE crove_sign.template
SET inspect_status = 'pending',
    status = CASE WHEN status = 'active' THEN 'draft' ELSE status END,
    updated_at = pg_catalog.now()
WHERE inspect_status = 'passed'
  AND page_count IS NULL;

CREATE OR REPLACE FUNCTION crove_sign.template_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_actor text := crove_kernel.ctx_actor_type();
  v_old jsonb;
  v_new jsonb;
  v_keep text[] := ARRAY['version', 'updated_at'];
BEGIN
  IF v_actor IS NULL OR v_actor = 'system' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    IF NEW.inspect_status = 'passed' AND NEW.page_count IS NULL THEN
      RAISE EXCEPTION 'SIGN_TEMPLATE_SYSTEM_ONLY' USING ERRCODE = '42501', DETAIL = 'passed template inspection requires page_count';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'active' THEN
      RAISE EXCEPTION 'SIGN_TEMPLATE_ACTIVE' USING ERRCODE = '42501', DETAIL = 'active template must be archived instead of deleted';
    END IF;
    IF OLD.status = 'archived' THEN
      RAISE EXCEPTION 'SIGN_TEMPLATE_ARCHIVED' USING ERRCODE = '42501', DETAIL = 'archived template cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.org_id IS DISTINCT FROM crove_kernel.ctx_org_id() THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.inspect_status = 'failed' OR NEW.inspect_error IS NOT NULL THEN
      RAISE EXCEPTION 'SIGN_TEMPLATE_SYSTEM_ONLY' USING ERRCODE = '42501', DETAIL = 'template inspection errors are system-managed';
    END IF;
    IF NEW.inspect_status = 'passed'
       OR NEW.page_count IS NOT NULL
       OR NEW.page_dimensions_json IS NOT NULL
       OR NEW.detected_tags_json IS NOT NULL THEN
      IF NEW.inspect_status <> 'passed'
         OR NEW.page_count IS NULL
         OR NOT EXISTS (
           SELECT 1 FROM crove_kernel.file f
           WHERE f.org_id = NEW.org_id
             AND f.id = NEW.source_file_id
             AND f.storage_key = NEW.source_storage_key
             AND f.generation IS NOT DISTINCT FROM NEW.source_generation
             AND f.sha256 = NEW.source_sha256
             AND f.content_type = 'application/pdf'
         )
         OR NOT (
           EXISTS (
             SELECT 1 FROM crove_sign.envelope e
             WHERE e.org_id = NEW.org_id
               AND e.inspect_status = 'passed'
               AND e.page_count IS NOT NULL
               AND e.page_count IS NOT DISTINCT FROM NEW.page_count
               AND e.page_dimensions_json IS NOT DISTINCT FROM NEW.page_dimensions_json
               AND e.detected_tags_json IS NOT DISTINCT FROM NEW.detected_tags_json
               AND e.source_file_id = NEW.source_file_id
               AND e.source_storage_key = NEW.source_storage_key
               AND e.source_generation = NEW.source_generation
               AND e.source_sha256 = NEW.source_sha256
           )
           OR EXISTS (
             SELECT 1 FROM crove_sign.template t
             WHERE t.org_id = NEW.org_id
               AND t.inspect_status = 'passed'
               AND t.page_count IS NOT NULL
               AND t.page_count IS NOT DISTINCT FROM NEW.page_count
               AND t.page_dimensions_json IS NOT DISTINCT FROM NEW.page_dimensions_json
               AND t.detected_tags_json IS NOT DISTINCT FROM NEW.detected_tags_json
               AND t.source_file_id = NEW.source_file_id
               AND t.source_storage_key = NEW.source_storage_key
               AND t.source_generation = NEW.source_generation
               AND t.source_sha256 = NEW.source_sha256
           )
         ) THEN
        RAISE EXCEPTION 'SIGN_TEMPLATE_SYSTEM_ONLY' USING ERRCODE = '42501', DETAIL = 'template inspection metadata must match an inspected same-org source document';
      END IF;
    END IF;
    IF NEW.status = 'active' AND (NEW.inspect_status <> 'passed' OR NEW.page_count IS NULL) THEN
      RAISE EXCEPTION 'SIGN_TEMPLATE_NOT_INSPECTED' USING ERRCODE = '42501', DETAIL = 'source PDF must pass inspection before template becomes active';
    END IF;
    IF NEW.status = 'archived' AND NEW.archived_at IS NULL THEN
      RAISE EXCEPTION 'SIGN_TEMPLATE_ARCHIVE_INVALID' USING ERRCODE = '42501', DETAIL = 'archived template requires archived_at timestamp';
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE by tenant user
  v_old := pg_catalog.to_jsonb(OLD) - v_keep;
  v_new := pg_catalog.to_jsonb(NEW) - v_keep;
  IF v_old IS NOT DISTINCT FROM v_new THEN
    RETURN NEW;
  END IF;
  IF (NEW.org_id, NEW.id, NEW.source_file_id, NEW.source_storage_key, NEW.source_generation, NEW.source_sha256, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.org_id, OLD.id, OLD.source_file_id, OLD.source_storage_key, OLD.source_generation, OLD.source_sha256, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'SIGN_TEMPLATE_IMMUTABLE' USING ERRCODE = '42501', DETAIL = 'template identity and source document columns are immutable';
  END IF;
  IF (NEW.inspect_status, NEW.inspect_error, NEW.page_count, NEW.page_dimensions_json, NEW.detected_tags_json)
     IS DISTINCT FROM (OLD.inspect_status, OLD.inspect_error, OLD.page_count, OLD.page_dimensions_json, OLD.detected_tags_json) THEN
    RAISE EXCEPTION 'SIGN_TEMPLATE_SYSTEM_ONLY' USING ERRCODE = '42501', DETAIL = 'template inspection metadata is system-managed';
  END IF;
  IF OLD.status = 'archived' THEN
    RAISE EXCEPTION 'SIGN_TEMPLATE_ARCHIVED' USING ERRCODE = '42501', DETAIL = 'archived template cannot be modified';
  END IF;
  IF NEW.status = 'active' AND (OLD.inspect_status <> 'passed' OR OLD.page_count IS NULL) THEN
    RAISE EXCEPTION 'SIGN_TEMPLATE_NOT_INSPECTED' USING ERRCODE = '42501', DETAIL = 'source PDF must pass inspection before template becomes active';
  END IF;
  IF NEW.status NOT IN ('draft', 'archived') AND NEW.inspect_status = 'passed' AND NEW.page_count IS NULL THEN
    RAISE EXCEPTION 'SIGN_TEMPLATE_SYSTEM_ONLY' USING ERRCODE = '42501', DETAIL = 'passed template inspection requires page_count';
  END IF;
  IF NEW.status = 'archived' AND NEW.archived_at IS NULL THEN
    RAISE EXCEPTION 'SIGN_TEMPLATE_ARCHIVE_INVALID' USING ERRCODE = '42501', DETAIL = 'archived template requires archived_at timestamp';
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION crove_sign.template_guard()
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
