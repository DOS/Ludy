-- SPDX-License-Identifier: AGPL-3.0-only
-- P0 forward fix: merge ludy_sign.field_guard() carve-outs from
-- 20270318080000_ludy_sign_slice5_followups.sql (v_kyc_erase_owner / ludy.sign_kyc_erase UPDATE)
-- and 20270318120000_ludy_sign_meeting_minutes_lifecycle.sql (v_cleanup_owner / ludy.sign_meeting_cleanup DELETE),
-- which collided when #4639 replaced field_guard() after #4616 merged.

SET LOCAL lock_timeout = '2s';

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
  IF TG_OP = 'UPDATE'
     AND NEW.field_type = 'text'
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

REVOKE ALL ON FUNCTION ludy_sign.field_guard()
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
      'REVOKE ALL ON FUNCTION ludy_sign.field_guard() FROM %I',
      r.rolname
    );
  END LOOP;
END $$;
