-- SPDX-License-Identifier: AGPL-3.0-only
-- eSign Slice 2a A3 (#3552): persist deterministic PDF text tags extracted inside crove-extract pdf_inspect
-- on crove_sign.envelope and crove_sign.template, guarded identically to page_dimensions_json.

SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_sign.envelope
  ADD COLUMN IF NOT EXISTS detected_tags_json jsonb;

ALTER TABLE crove_sign.template
  ADD COLUMN IF NOT EXISTS detected_tags_json jsonb;

ALTER TABLE crove_sign.signer
  ADD COLUMN IF NOT EXISTS role_key text
  CHECK (role_key IS NULL OR (pg_catalog.length(role_key) BETWEEN 1 AND 32 AND role_key ~ '^[a-z0-9_]+$'));

CREATE UNIQUE INDEX IF NOT EXISTS signer_envelope_role_key_uq
  ON crove_sign.signer (org_id, envelope_id, role_key)
  WHERE role_key IS NOT NULL;

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
    IF NEW.page_count IS NOT NULL OR NEW.page_dimensions_json IS NOT NULL OR NEW.detected_tags_json IS NOT NULL THEN
      IF NEW.inspect_status <> 'passed' OR NEW.page_count IS NULL OR NOT (
        EXISTS (
          SELECT 1 FROM crove_sign.envelope e
          WHERE e.org_id = NEW.org_id
            AND e.inspect_status = 'passed'
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
    IF NEW.status = 'active' AND NEW.inspect_status <> 'passed' THEN
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
  IF NEW.status = 'active' AND OLD.inspect_status <> 'passed' THEN
    RAISE EXCEPTION 'SIGN_TEMPLATE_NOT_INSPECTED' USING ERRCODE = '42501', DETAIL = 'source PDF must pass inspection before template becomes active';
  END IF;
  IF NEW.status = 'archived' AND NEW.archived_at IS NULL THEN
    RAISE EXCEPTION 'SIGN_TEMPLATE_ARCHIVE_INVALID' USING ERRCODE = '42501', DETAIL = 'archived template requires archived_at timestamp';
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION crove_sign.template_guard()
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

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
    IF v_user IS NULL OR NOT EXISTS (
      SELECT 1 FROM crove_kernel.tenant_member m
      WHERE m.org_id = v_org AND m.user_id = v_user AND m.role IN ('owner', 'admin', 'member')
    ) THEN
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

  SELECT e.id, e.status, e.inspect_status,
         e.source_file_id, e.source_storage_key, e.source_generation, e.source_sha256
  INTO v_env
  FROM crove_sign.envelope e
  WHERE e.org_id = v_org AND e.id = p_envelope_id
  FOR UPDATE;

  IF NOT FOUND OR v_env.status <> 'draft' OR v_env.inspect_status <> 'pending' THEN
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

CREATE OR REPLACE FUNCTION crove_sign.envelope_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_actor text := crove_kernel.ctx_actor_type();
  v_old jsonb;
  v_new jsonb;
  v_keep text[] := ARRAY['version', 'updated_at'];
  v_cur_role oid := (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = CURRENT_USER);
  v_inherit_owner oid := (SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.oid = 'crove_sign.template_inherit_inspect(uuid,uuid)'::pg_catalog.regprocedure);
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
    IF NEW.org_id IS DISTINCT FROM crove_kernel.ctx_org_id() THEN
      RETURN NEW;
    END IF;
    IF NEW.status <> 'draft' OR NEW.inspect_status <> 'pending' OR NEW.inspect_error IS NOT NULL
       OR NEW.page_count IS NOT NULL OR NEW.page_dimensions_json IS NOT NULL OR NEW.detected_tags_json IS NOT NULL
       OR NEW.seal_status IS NOT NULL
       OR NEW.sealed_file_id IS NOT NULL OR NEW.sealed_storage_key IS NOT NULL
       OR NEW.sealed_generation IS NOT NULL OR NEW.sealed_sha256 IS NOT NULL
       OR NEW.certificate_file_id IS NOT NULL OR NEW.certificate_storage_key IS NOT NULL
       OR NEW.certificate_generation IS NOT NULL OR NEW.certificate_sha256 IS NOT NULL
       OR NEW.certificate_code IS NOT NULL OR NEW.sent_at IS NOT NULL OR NEW.completed_at IS NOT NULL
       OR NEW.declined_at IS NOT NULL OR NEW.voided_at IS NOT NULL OR NEW.voided_by IS NOT NULL
       OR NEW.void_reason IS NOT NULL OR NEW.expired_at IS NOT NULL THEN
      RAISE EXCEPTION 'ENVELOPE_FORBIDDEN' USING ERRCODE = '42501', DETAIL = 'an envelope starts as an uninspected draft without sealing or completion data';
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE by tenant user
  IF NEW.org_id IS DISTINCT FROM crove_kernel.ctx_org_id() THEN
    RETURN NEW;
  END IF;
  v_old := pg_catalog.to_jsonb(OLD) - v_keep;
  v_new := pg_catalog.to_jsonb(NEW) - v_keep;
  IF v_old IS NOT DISTINCT FROM v_new THEN
    RETURN NEW;
  END IF;
  IF (NEW.org_id, NEW.id, NEW.created_by, NEW.created_at,
      NEW.source_kind, NEW.source_id, NEW.source_file_id, NEW.source_storage_key, NEW.source_generation, NEW.source_sha256)
     IS DISTINCT FROM (OLD.org_id, OLD.id, OLD.created_by, OLD.created_at,
      OLD.source_kind, OLD.source_id, OLD.source_file_id, OLD.source_storage_key, OLD.source_generation, OLD.source_sha256) THEN
    RAISE EXCEPTION 'ENVELOPE_IMMUTABLE' USING ERRCODE = '42501', DETAIL = 'envelope identity and source document columns are immutable';
  END IF;
  IF v_inherit_owner IS NOT NULL
     AND v_cur_role = v_inherit_owner
     AND pg_catalog.current_setting('crove.sign_template_inherit', true) IS NOT DISTINCT FROM NEW.id::text
     AND OLD.status = 'draft'
     AND NEW.status = 'draft'
     AND OLD.inspect_status = 'pending'
     AND NEW.inspect_status = 'passed'
     AND NEW.page_count IS NOT NULL
     AND (pg_catalog.to_jsonb(OLD) - ARRAY['inspect_status', 'inspect_error', 'page_count', 'page_dimensions_json', 'detected_tags_json', 'updated_at'])
         IS NOT DISTINCT FROM (pg_catalog.to_jsonb(NEW) - ARRAY['inspect_status', 'inspect_error', 'page_count', 'page_dimensions_json', 'detected_tags_json', 'updated_at']) THEN
    RETURN NEW;
  END IF;
  IF (NEW.inspect_status, NEW.inspect_error, NEW.page_count, NEW.page_dimensions_json, NEW.detected_tags_json,
      NEW.seal_status, NEW.sealed_file_id, NEW.sealed_storage_key, NEW.sealed_generation, NEW.sealed_sha256,
      NEW.certificate_file_id, NEW.certificate_storage_key, NEW.certificate_generation, NEW.certificate_sha256,
      NEW.certificate_code, NEW.completed_at, NEW.declined_at, NEW.expired_at)
     IS DISTINCT FROM (OLD.inspect_status, OLD.inspect_error, OLD.page_count, OLD.page_dimensions_json, OLD.detected_tags_json,
      OLD.seal_status, OLD.sealed_file_id, OLD.sealed_storage_key, OLD.sealed_generation, OLD.sealed_sha256,
      OLD.certificate_file_id, OLD.certificate_storage_key, OLD.certificate_generation, OLD.certificate_sha256,
      OLD.certificate_code, OLD.completed_at, OLD.declined_at, OLD.expired_at) THEN
    RAISE EXCEPTION 'ENVELOPE_SYSTEM_ONLY' USING ERRCODE = '42501', DETAIL = 'inspection, sealed, and completion metadata are system-managed';
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
      IF (NEW.sent_at, NEW.voided_at, NEW.voided_by, NEW.void_reason)
         IS DISTINCT FROM (OLD.sent_at, OLD.voided_at, OLD.voided_by, OLD.void_reason) THEN
        RAISE EXCEPTION 'ENVELOPE_SYSTEM_ONLY' USING ERRCODE = '42501', DETAIL = 'lifecycle timestamps cannot be modified on a draft';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW.status = 'sent' THEN
      IF OLD.inspect_status <> 'passed' THEN
        RAISE EXCEPTION 'ENVELOPE_NOT_INSPECTED' USING ERRCODE = '42501', DETAIL = 'source PDF must pass inspection before sending';
      END IF;
      IF NEW.sent_at IS NULL OR (pg_catalog.to_jsonb(OLD) - ARRAY['status', 'sent_at', 'version', 'updated_at'])
         IS DISTINCT FROM (pg_catalog.to_jsonb(NEW) - ARRAY['status', 'sent_at', 'version', 'updated_at']) THEN
        RAISE EXCEPTION 'ENVELOPE_FROZEN' USING ERRCODE = '42501', DETAIL = 'only status and sent_at can change when sending';
      END IF;
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'ENVELOPE_INVALID_TRANSITION' USING ERRCODE = '42501', DETAIL = 'draft envelope can only move to sent or voided';
  END IF;
  RAISE EXCEPTION 'ENVELOPE_FROZEN' USING ERRCODE = '42501', DETAIL = 'envelope is frozen after leaving draft';
END $$;

REVOKE ALL ON FUNCTION crove_sign.envelope_guard()
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
