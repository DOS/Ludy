-- SPDX-License-Identifier: AGPL-3.0-only
-- eSign Slice 2a (#3526 / #3510): reusable templates, Approver/CC template roles,
-- normalized template fields, and definer-only direct signing link capability tokens.

SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. Core Slice 2a tables
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS crove_sign.template (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  title text NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(title)) BETWEEN 1 AND 300),
  description text CHECK (description IS NULL OR pg_catalog.length(description) <= 2000),
  routing_mode text NOT NULL DEFAULT 'parallel' CHECK (routing_mode IN ('parallel', 'sequential')),
  subject text CHECK (subject IS NULL OR pg_catalog.length(subject) <= 300),
  message text CHECK (message IS NULL OR pg_catalog.length(message) <= 5000),
  expires_in_hours integer CHECK (expires_in_hours IS NULL OR (expires_in_hours >= 1 AND expires_in_hours <= 8760)),
  source_file_id uuid NOT NULL,
  source_storage_key text NOT NULL CHECK (pg_catalog.length(source_storage_key) BETWEEN 1 AND 512),
  source_generation text NOT NULL CHECK (pg_catalog.length(source_generation) BETWEEN 1 AND 1028),
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  inspect_status text NOT NULL DEFAULT 'pending' CHECK (inspect_status IN ('pending', 'passed', 'failed')),
  inspect_error text CHECK (inspect_error IS NULL OR pg_catalog.length(inspect_error) <= 500),
  page_count integer CHECK (page_count IS NULL OR (page_count >= 1 AND page_count <= 200)),
  page_dimensions_json jsonb,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'archived')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  archived_at timestamptz,
  archived_by uuid REFERENCES crove_kernel.user_account (id),
  created_by uuid NOT NULL REFERENCES crove_kernel.user_account (id),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT template_source_file_fk FOREIGN KEY (org_id, source_file_id) REFERENCES crove_kernel.file (org_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS template_org_status_created_idx
  ON crove_sign.template (org_id, status, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS template_org_sha256_idx
  ON crove_sign.template (org_id, source_sha256);
CREATE INDEX IF NOT EXISTS template_source_file_idx
  ON crove_sign.template (org_id, source_file_id);
CREATE INDEX IF NOT EXISTS template_pending_inspect_idx
  ON crove_sign.template (updated_at, org_id, id)
  WHERE inspect_status = 'pending' AND status IN ('draft', 'active');

CREATE TABLE IF NOT EXISTS crove_sign.template_role (
  org_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  template_id uuid NOT NULL,
  role_key text NOT NULL CHECK (role_key ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  signer_role text NOT NULL DEFAULT 'signer' CHECK (signer_role IN ('signer', 'approver', 'cc')),
  role_label text NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(role_label)) BETWEEN 1 AND 120),
  routing_order integer NOT NULL DEFAULT 1 CHECK (routing_order >= 1 AND routing_order <= 100),
  delivery_mode text NOT NULL DEFAULT 'link' CHECK (delivery_mode IN ('link', 'email')),
  require_email_otp boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT template_role_template_id_id_uq UNIQUE (org_id, template_id, id),
  CONSTRAINT template_role_template_key_uq UNIQUE (org_id, template_id, role_key),
  CONSTRAINT template_role_template_fk FOREIGN KEY (org_id, template_id) REFERENCES crove_sign.template (org_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS template_role_template_order_idx
  ON crove_sign.template_role (org_id, template_id, routing_order, id);

CREATE TABLE IF NOT EXISTS crove_sign.template_field (
  org_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  template_id uuid NOT NULL,
  template_role_id uuid NOT NULL,
  field_type text NOT NULL CHECK (field_type IN ('signature', 'initials', 'date', 'text', 'checkbox')),
  page_number integer NOT NULL CHECK (page_number >= 1 AND page_number <= 200),
  x_norm numeric(8,6) NOT NULL CHECK (x_norm >= 0 AND x_norm < 1),
  y_norm numeric(8,6) NOT NULL CHECK (y_norm >= 0 AND y_norm < 1),
  w_norm numeric(8,6) NOT NULL CHECK (w_norm > 0 AND w_norm <= 1),
  h_norm numeric(8,6) NOT NULL CHECK (h_norm > 0 AND h_norm <= 1),
  label text CHECK (label IS NULL OR pg_catalog.length(label) <= 200),
  required boolean NOT NULL DEFAULT true,
  font_size_pt integer CHECK (font_size_pt IS NULL OR (font_size_pt >= 6 AND font_size_pt <= 72)),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT template_field_bounds_check CHECK (x_norm + w_norm <= 1.000000 AND y_norm + h_norm <= 1.000000),
  CONSTRAINT template_field_template_fk FOREIGN KEY (org_id, template_id) REFERENCES crove_sign.template (org_id, id) ON DELETE CASCADE,
  CONSTRAINT template_field_role_fk FOREIGN KEY (org_id, template_id, template_role_id) REFERENCES crove_sign.template_role (org_id, template_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS template_field_template_idx
  ON crove_sign.template_field (org_id, template_id, page_number, id);
CREATE INDEX IF NOT EXISTS template_field_role_idx
  ON crove_sign.template_field (org_id, template_id, template_role_id);

CREATE TABLE IF NOT EXISTS crove_sign.template_direct_link (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  template_id uuid NOT NULL,
  token_sha256 text NOT NULL CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
  enabled boolean NOT NULL DEFAULT false,
  require_email_otp boolean NOT NULL DEFAULT false,
  revoked_at timestamptz,
  revoked_by uuid REFERENCES crove_kernel.user_account (id),
  last_rotated_at timestamptz,
  created_by uuid NOT NULL REFERENCES crove_kernel.user_account (id),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT template_direct_link_template_fk FOREIGN KEY (org_id, template_id) REFERENCES crove_sign.template (org_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS template_direct_link_sha256_uq
  ON crove_sign.template_direct_link (token_sha256);
CREATE UNIQUE INDEX IF NOT EXISTS template_direct_link_active_template_uq
  ON crove_sign.template_direct_link (org_id, template_id)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS template_direct_link_template_idx
  ON crove_sign.template_direct_link (org_id, template_id);

-- ---------------------------------------------------------------------------
-- 2. Row-level security and write policies
-- ---------------------------------------------------------------------------

SELECT crove_kernel.apply_tenant_rls('crove_sign.template');
SELECT crove_kernel.apply_tenant_rls('crove_sign.template_role');
SELECT crove_kernel.apply_tenant_rls('crove_sign.template_field');

DO $$
DECLARE
  v_t text;
  v_write_check text := '((SELECT crove_kernel.ctx_actor_type()) IN (''system'', ''agent'') OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = %s.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN (''owner'', ''admin'', ''member'')))';
BEGIN
  FOREACH v_t IN ARRAY ARRAY['crove_sign.template', 'crove_sign.template_role', 'crove_sign.template_field'] LOOP
    EXECUTE pg_catalog.format('DROP POLICY IF EXISTS writer_insert ON %s', v_t);
    EXECUTE pg_catalog.format('CREATE POLICY writer_insert ON %s AS RESTRICTIVE FOR INSERT TO crove_tenant WITH CHECK ' || v_write_check, v_t, pg_catalog.split_part(v_t, '.', 2));
    EXECUTE pg_catalog.format('DROP POLICY IF EXISTS writer_update ON %s', v_t);
    EXECUTE pg_catalog.format(
      'CREATE POLICY writer_update ON %s AS RESTRICTIVE FOR UPDATE TO crove_tenant USING ' || v_write_check || ' WITH CHECK ' || v_write_check,
      v_t, pg_catalog.split_part(v_t, '.', 2), pg_catalog.split_part(v_t, '.', 2)
    );
    EXECUTE pg_catalog.format('DROP POLICY IF EXISTS writer_delete ON %s', v_t);
    EXECUTE pg_catalog.format('CREATE POLICY writer_delete ON %s AS RESTRICTIVE FOR DELETE TO crove_tenant USING ' || v_write_check, v_t, pg_catalog.split_part(v_t, '.', 2));
  END LOOP;
END $$;

ALTER TABLE crove_sign.template_direct_link ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON crove_sign.template_direct_link FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
SELECT crove_kernel.agent_write_guard_install('crove_sign.template_direct_link');

-- ---------------------------------------------------------------------------
-- 3. Guard triggers (no-op UPDATE probes allowed for rls-matrix)
-- ---------------------------------------------------------------------------

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
    IF NEW.page_count IS NOT NULL OR NEW.page_dimensions_json IS NOT NULL THEN
      IF NEW.inspect_status <> 'passed' OR NEW.page_count IS NULL OR NOT (
        EXISTS (
          SELECT 1 FROM crove_sign.envelope e
          WHERE e.org_id = NEW.org_id
            AND e.inspect_status = 'passed'
            AND e.page_count IS NOT DISTINCT FROM NEW.page_count
            AND e.page_dimensions_json IS NOT DISTINCT FROM NEW.page_dimensions_json
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
  IF (NEW.inspect_status, NEW.inspect_error, NEW.page_count, NEW.page_dimensions_json)
     IS DISTINCT FROM (OLD.inspect_status, OLD.inspect_error, OLD.page_count, OLD.page_dimensions_json) THEN
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

DROP TRIGGER IF EXISTS template_guard ON crove_sign.template;
CREATE TRIGGER template_guard BEFORE INSERT OR UPDATE OR DELETE ON crove_sign.template
  FOR EACH ROW EXECUTE FUNCTION crove_sign.template_guard();

CREATE OR REPLACE FUNCTION crove_sign.template_role_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_actor text := crove_kernel.ctx_actor_type();
  v_tpl_id uuid := COALESCE(OLD.template_id, NEW.template_id);
  v_org uuid := COALESCE(OLD.org_id, NEW.org_id);
  v_tpl_status text;
BEGIN
  IF v_actor IS NULL OR v_actor = 'system' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.org_id IS DISTINCT FROM crove_kernel.ctx_org_id() THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND (pg_catalog.to_jsonb(OLD) - ARRAY['updated_at']) IS NOT DISTINCT FROM (pg_catalog.to_jsonb(NEW) - ARRAY['updated_at']) THEN
    RETURN NEW;
  END IF;
  SELECT t.status INTO v_tpl_status FROM crove_sign.template t WHERE t.org_id = v_org AND t.id = v_tpl_id FOR SHARE;
  IF v_tpl_status IS NULL OR v_tpl_status NOT IN ('draft', 'active') THEN
    RAISE EXCEPTION 'SIGN_TEMPLATE_ARCHIVED' USING ERRCODE = '42501', DETAIL = 'template roles can only be modified while template is draft or active';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.org_id, NEW.id, NEW.template_id, NEW.created_at) IS DISTINCT FROM (OLD.org_id, OLD.id, OLD.template_id, OLD.created_at) THEN
      RAISE EXCEPTION 'SIGN_TEMPLATE_ROLE_IMMUTABLE' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS template_role_guard ON crove_sign.template_role;
CREATE TRIGGER template_role_guard BEFORE INSERT OR UPDATE OR DELETE ON crove_sign.template_role
  FOR EACH ROW EXECUTE FUNCTION crove_sign.template_role_guard();

CREATE OR REPLACE FUNCTION crove_sign.template_field_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_actor text := crove_kernel.ctx_actor_type();
  v_tpl_id uuid := COALESCE(OLD.template_id, NEW.template_id);
  v_org uuid := COALESCE(OLD.org_id, NEW.org_id);
  v_tpl_status text;
BEGIN
  IF v_actor IS NULL OR v_actor = 'system' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.org_id IS DISTINCT FROM crove_kernel.ctx_org_id() THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND (pg_catalog.to_jsonb(OLD) - ARRAY['updated_at']) IS NOT DISTINCT FROM (pg_catalog.to_jsonb(NEW) - ARRAY['updated_at']) THEN
    RETURN NEW;
  END IF;
  SELECT t.status INTO v_tpl_status FROM crove_sign.template t WHERE t.org_id = v_org AND t.id = v_tpl_id FOR SHARE;
  IF v_tpl_status IS NULL OR v_tpl_status NOT IN ('draft', 'active') THEN
    RAISE EXCEPTION 'SIGN_TEMPLATE_ARCHIVED' USING ERRCODE = '42501', DETAIL = 'template fields can only be modified while template is draft or active';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.org_id, NEW.id, NEW.template_id, NEW.created_at) IS DISTINCT FROM (OLD.org_id, OLD.id, OLD.template_id, OLD.created_at) THEN
      RAISE EXCEPTION 'SIGN_TEMPLATE_FIELD_IMMUTABLE' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS template_field_guard ON crove_sign.template_field;
CREATE TRIGGER template_field_guard BEFORE INSERT OR UPDATE OR DELETE ON crove_sign.template_field
  FOR EACH ROW EXECUTE FUNCTION crove_sign.template_field_guard();

REVOKE ALL ON FUNCTION crove_sign.template_guard(), crove_sign.template_role_guard(), crove_sign.template_field_guard()
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- ---------------------------------------------------------------------------
-- 4. SECURITY DEFINER helpers for template instantiation & direct links
-- ---------------------------------------------------------------------------

-- Copies verified PDF inspection metadata from an already-inspected template to a freshly created draft
-- envelope sharing the exact source file triple (org_id, source_file_id, source_storage_key, source_generation, source_sha256).
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

  SELECT t.id, t.status, t.inspect_status, t.page_count, t.page_dimensions_json,
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
      updated_at = pg_catalog.now()
  WHERE org_id = v_org AND id = p_envelope_id;

  PERFORM pg_catalog.set_config('crove.sign_template_inherit', '', true);

  RETURN true;
END $$;

REVOKE ALL ON FUNCTION crove_sign.template_inherit_inspect(uuid, uuid)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.template_inherit_inspect(uuid, uuid) TO crove_tenant;

-- Restate envelope_guard from 20270104060000_crove_sign_core.sql with one addition: allowing
-- template_inherit_inspect (owned by the migration role with transaction-local GUC) to promote
-- pending draft envelopes whose source document byte-matches an already-inspected template in the same org.
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
       OR NEW.page_count IS NOT NULL OR NEW.page_dimensions_json IS NOT NULL OR NEW.seal_status IS NOT NULL
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
     AND (pg_catalog.to_jsonb(OLD) - ARRAY['inspect_status', 'inspect_error', 'page_count', 'page_dimensions_json', 'updated_at'])
         IS NOT DISTINCT FROM (pg_catalog.to_jsonb(NEW) - ARRAY['inspect_status', 'inspect_error', 'page_count', 'page_dimensions_json', 'updated_at']) THEN
    RETURN NEW;
  END IF;
  IF (NEW.inspect_status, NEW.inspect_error, NEW.page_count, NEW.page_dimensions_json,
      NEW.seal_status, NEW.sealed_file_id, NEW.sealed_storage_key, NEW.sealed_generation, NEW.sealed_sha256,
      NEW.certificate_file_id, NEW.certificate_storage_key, NEW.certificate_generation, NEW.certificate_sha256,
      NEW.certificate_code, NEW.completed_at, NEW.declined_at, NEW.expired_at)
     IS DISTINCT FROM (OLD.inspect_status, OLD.inspect_error, OLD.page_count, OLD.page_dimensions_json,
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

-- Read non-secret direct-link metadata for one template (never exposes token_sha256).
CREATE OR REPLACE FUNCTION crove_sign.template_direct_link_state(
  p_template_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_actor text := crove_kernel.ctx_actor_type();
  v_user uuid := crove_kernel.ctx_user_id();
  v_row record;
BEGIN
  IF v_org IS NULL OR v_actor IS NULL OR p_template_id IS NULL THEN
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
      WHERE m.org_id = v_org AND m.user_id = v_user
    ) THEN
      RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
  END IF;

  SELECT l.id, l.enabled, l.require_email_otp, l.last_rotated_at, l.created_at, l.updated_at
  INTO v_row
  FROM crove_sign.template_direct_link l
  WHERE l.org_id = v_org AND l.template_id = p_template_id AND l.revoked_at IS NULL
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'id', v_row.id,
    'enabled', v_row.enabled,
    'requireEmailOtp', v_row.require_email_otp,
    'lastRotatedAt', v_row.last_rotated_at,
    'createdAt', v_row.created_at,
    'updatedAt', v_row.updated_at
  );
END $$;

REVOKE ALL ON FUNCTION crove_sign.template_direct_link_state(uuid)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.template_direct_link_state(uuid) TO crove_tenant;

-- Enable, update OTP mode, or disable direct signing links on an active 1-non-CC-role template (A1).
-- Disabling revokes any active link token immediately; enabling mints a fresh hashed capability row.
CREATE OR REPLACE FUNCTION crove_sign.template_direct_link_set(
  p_template_id uuid,
  p_enabled boolean,
  p_require_email_otp boolean DEFAULT false,
  p_token_sha256 text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_actor text := crove_kernel.ctx_actor_type();
  v_user uuid := crove_kernel.ctx_user_id();
  v_now timestamptz := pg_catalog.now();
  v_tpl record;
  v_non_cc_count integer;
  v_existing record;
  v_creator uuid;
  v_link_id uuid;
  v_revoked_count integer := 0;
BEGIN
  IF v_org IS NULL OR v_actor IS NULL OR p_template_id IS NULL OR p_enabled IS NULL THEN
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

  SELECT t.id, t.status, t.inspect_status, t.page_count, t.created_by
  INTO v_tpl
  FROM crove_sign.template t
  WHERE t.org_id = v_org AND t.id = p_template_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SIGN_TEMPLATE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  v_creator := COALESCE(v_user, v_tpl.created_by);

  IF NOT p_enabled THEN
    WITH revoked AS (
      UPDATE crove_sign.template_direct_link
      SET enabled = false,
          revoked_at = v_now,
          revoked_by = v_user,
          updated_at = v_now
      WHERE org_id = v_org AND template_id = p_template_id AND revoked_at IS NULL
      RETURNING id
    )
    SELECT pg_catalog.count(*)::integer INTO v_revoked_count FROM revoked;

    RETURN pg_catalog.jsonb_build_object(
      'id', NULL,
      'enabled', false,
      'requireEmailOtp', COALESCE(p_require_email_otp, false),
      'minted', false,
      'revokedCount', v_revoked_count,
      'lastRotatedAt', NULL
    );
  END IF;

  IF v_tpl.status <> 'active' THEN
    RAISE EXCEPTION 'SIGN_TEMPLATE_NOT_ACTIVE' USING ERRCODE = '42501';
  END IF;
  IF v_tpl.inspect_status <> 'passed' OR v_tpl.page_count IS NULL THEN
    RAISE EXCEPTION 'SIGN_TEMPLATE_NOT_INSPECTED' USING ERRCODE = '42501';
  END IF;

  SELECT pg_catalog.count(*)::integer
  INTO v_non_cc_count
  FROM crove_sign.template_role r
  WHERE r.org_id = v_org AND r.template_id = p_template_id AND r.signer_role <> 'cc';

  IF v_non_cc_count <> 1 THEN
    RAISE EXCEPTION 'SIGN_DIRECT_LINK_SINGLE_ROLE_REQUIRED' USING ERRCODE = '22023';
  END IF;

  SELECT l.id, l.enabled, l.require_email_otp, l.last_rotated_at
  INTO v_existing
  FROM crove_sign.template_direct_link l
  WHERE l.org_id = v_org AND l.template_id = p_template_id AND l.revoked_at IS NULL
  FOR UPDATE;

  IF FOUND AND v_existing.enabled AND p_token_sha256 IS NULL THEN
    UPDATE crove_sign.template_direct_link
    SET require_email_otp = COALESCE(p_require_email_otp, false),
        updated_at = v_now
    WHERE org_id = v_org AND id = v_existing.id;

    RETURN pg_catalog.jsonb_build_object(
      'id', v_existing.id,
      'enabled', true,
      'requireEmailOtp', COALESCE(p_require_email_otp, false),
      'minted', false,
      'revokedCount', 0,
      'lastRotatedAt', v_existing.last_rotated_at
    );
  END IF;

  IF p_token_sha256 IS NULL OR p_token_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'SIGN_INVALID_TOKEN_HASH' USING ERRCODE = '22023';
  END IF;

  IF FOUND THEN
    UPDATE crove_sign.template_direct_link
    SET enabled = false,
        revoked_at = v_now,
        revoked_by = v_user,
        updated_at = v_now
    WHERE org_id = v_org AND template_id = p_template_id AND revoked_at IS NULL;
    v_revoked_count := 1;
  END IF;

  INSERT INTO crove_sign.template_direct_link (
    org_id, template_id, token_sha256, enabled, require_email_otp, created_by, created_at, updated_at
  ) VALUES (
    v_org, p_template_id, p_token_sha256, true, COALESCE(p_require_email_otp, false), v_creator, v_now, v_now
  )
  RETURNING id INTO v_link_id;

  RETURN pg_catalog.jsonb_build_object(
    'id', v_link_id,
    'enabled', true,
    'requireEmailOtp', COALESCE(p_require_email_otp, false),
    'minted', true,
    'revokedCount', v_revoked_count,
    'lastRotatedAt', NULL
  );
END $$;

REVOKE ALL ON FUNCTION crove_sign.template_direct_link_set(uuid, boolean, boolean, text)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.template_direct_link_set(uuid, boolean, boolean, text) TO crove_tenant;

-- Always revokes any previous non-revoked direct link token hash and mints a fresh one (A1).
CREATE OR REPLACE FUNCTION crove_sign.template_direct_link_rotate(
  p_template_id uuid,
  p_token_sha256 text,
  p_require_email_otp boolean DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_actor text := crove_kernel.ctx_actor_type();
  v_user uuid := crove_kernel.ctx_user_id();
  v_now timestamptz := pg_catalog.now();
  v_tpl record;
  v_non_cc_count integer;
  v_prev_otp boolean;
  v_revoked_count integer := 0;
  v_creator uuid;
  v_link_id uuid;
  v_effective_otp boolean;
BEGIN
  IF v_org IS NULL OR v_actor IS NULL OR p_template_id IS NULL THEN
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
  IF p_token_sha256 IS NULL OR p_token_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'SIGN_INVALID_TOKEN_HASH' USING ERRCODE = '22023';
  END IF;

  SELECT t.id, t.status, t.inspect_status, t.page_count, t.created_by
  INTO v_tpl
  FROM crove_sign.template t
  WHERE t.org_id = v_org AND t.id = p_template_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SIGN_TEMPLATE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_tpl.status <> 'active' THEN
    RAISE EXCEPTION 'SIGN_TEMPLATE_NOT_ACTIVE' USING ERRCODE = '42501';
  END IF;
  IF v_tpl.inspect_status <> 'passed' OR v_tpl.page_count IS NULL THEN
    RAISE EXCEPTION 'SIGN_TEMPLATE_NOT_INSPECTED' USING ERRCODE = '42501';
  END IF;

  SELECT pg_catalog.count(*)::integer
  INTO v_non_cc_count
  FROM crove_sign.template_role r
  WHERE r.org_id = v_org AND r.template_id = p_template_id AND r.signer_role <> 'cc';

  IF v_non_cc_count <> 1 THEN
    RAISE EXCEPTION 'SIGN_DIRECT_LINK_SINGLE_ROLE_REQUIRED' USING ERRCODE = '22023';
  END IF;

  SELECT l.require_email_otp
  INTO v_prev_otp
  FROM crove_sign.template_direct_link l
  WHERE l.org_id = v_org AND l.template_id = p_template_id AND l.revoked_at IS NULL
  FOR UPDATE;

  IF FOUND THEN
    UPDATE crove_sign.template_direct_link
    SET enabled = false,
        revoked_at = v_now,
        revoked_by = v_user,
        updated_at = v_now
    WHERE org_id = v_org AND template_id = p_template_id AND revoked_at IS NULL;
    v_revoked_count := 1;
  END IF;

  v_effective_otp := COALESCE(p_require_email_otp, v_prev_otp, false);
  v_creator := COALESCE(v_user, v_tpl.created_by);

  INSERT INTO crove_sign.template_direct_link (
    org_id, template_id, token_sha256, enabled, require_email_otp, last_rotated_at, created_by, created_at, updated_at
  ) VALUES (
    v_org, p_template_id, p_token_sha256, true, v_effective_otp, v_now, v_creator, v_now, v_now
  )
  RETURNING id INTO v_link_id;

  RETURN pg_catalog.jsonb_build_object(
    'id', v_link_id,
    'enabled', true,
    'requireEmailOtp', v_effective_otp,
    'minted', true,
    'revokedCount', v_revoked_count,
    'lastRotatedAt', v_now
  );
END $$;

REVOKE ALL ON FUNCTION crove_sign.template_direct_link_rotate(uuid, text, boolean)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.template_direct_link_rotate(uuid, text, boolean) TO crove_tenant;

-- Revoke any non-revoked direct link for a template (called on archive or non-CC role count change).
CREATE OR REPLACE FUNCTION crove_sign.template_direct_link_revoke_for_template(
  p_template_id uuid
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_actor text := crove_kernel.ctx_actor_type();
  v_user uuid := crove_kernel.ctx_user_id();
  v_now timestamptz := pg_catalog.now();
  v_count integer := 0;
BEGIN
  IF v_org IS NULL OR v_actor IS NULL OR p_template_id IS NULL THEN
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

  WITH updated AS (
    UPDATE crove_sign.template_direct_link
    SET enabled = false,
        revoked_at = v_now,
        revoked_by = v_user,
        updated_at = v_now
    WHERE org_id = v_org AND template_id = p_template_id AND revoked_at IS NULL
    RETURNING id
  )
  SELECT pg_catalog.count(*)::integer INTO v_count FROM updated;

  RETURN v_count;
END $$;

REVOKE ALL ON FUNCTION crove_sign.template_direct_link_revoke_for_template(uuid)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.template_direct_link_revoke_for_template(uuid) TO crove_tenant;

-- DB-level enforcement of A1 direct-link invariants across direct tenant SQL writes.
CREATE OR REPLACE FUNCTION crove_sign.template_direct_link_sync_on_template() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF (NEW.status <> 'active' OR NEW.inspect_status <> 'passed')
     AND EXISTS (
       SELECT 1 FROM crove_sign.template_direct_link l
       WHERE l.org_id = NEW.org_id AND l.template_id = NEW.id AND l.revoked_at IS NULL
     ) THEN
    UPDATE crove_sign.template_direct_link
    SET enabled = false,
        revoked_at = pg_catalog.now(),
        revoked_by = crove_kernel.ctx_user_id(),
        updated_at = pg_catalog.now()
    WHERE org_id = NEW.org_id AND template_id = NEW.id AND revoked_at IS NULL;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS template_direct_link_sync_on_template ON crove_sign.template;
CREATE TRIGGER template_direct_link_sync_on_template
  AFTER UPDATE OF status, inspect_status ON crove_sign.template
  FOR EACH ROW
  WHEN (NEW.status <> 'active' OR NEW.inspect_status <> 'passed')
  EXECUTE FUNCTION crove_sign.template_direct_link_sync_on_template();

CREATE OR REPLACE FUNCTION crove_sign.template_direct_link_sync_on_role() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := COALESCE(NEW.org_id, OLD.org_id);
  v_tpl_id uuid := COALESCE(NEW.template_id, OLD.template_id);
  v_non_cc_count integer;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.signer_role IS NOT DISTINCT FROM NEW.signer_role THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM crove_sign.template_direct_link l
    WHERE l.org_id = v_org AND l.template_id = v_tpl_id AND l.revoked_at IS NULL
  ) THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM crove_sign.template t WHERE t.org_id = v_org AND t.id = v_tpl_id) THEN
    RETURN NULL;
  END IF;
  SELECT pg_catalog.count(*)::integer
  INTO v_non_cc_count
  FROM crove_sign.template_role r
  WHERE r.org_id = v_org AND r.template_id = v_tpl_id AND r.signer_role <> 'cc';

  IF v_non_cc_count <> 1 THEN
    UPDATE crove_sign.template_direct_link
    SET enabled = false,
        revoked_at = pg_catalog.now(),
        revoked_by = crove_kernel.ctx_user_id(),
        updated_at = pg_catalog.now()
    WHERE org_id = v_org AND template_id = v_tpl_id AND revoked_at IS NULL;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS template_direct_link_sync_on_role ON crove_sign.template_role;
CREATE TRIGGER template_direct_link_sync_on_role
  AFTER INSERT OR UPDATE OF signer_role OR DELETE ON crove_sign.template_role
  FOR EACH ROW
  EXECUTE FUNCTION crove_sign.template_direct_link_sync_on_role();

REVOKE ALL ON FUNCTION crove_sign.template_direct_link_sync_on_template(), crove_sign.template_direct_link_sync_on_role()
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- Worker recovery candidate lookup for templates awaiting PDF inspection while Sign is on.
CREATE OR REPLACE FUNCTION crove_sign.template_work_recovery_candidates(
  p_older_than timestamptz,
  p_limit integer DEFAULT 100,
  p_org_id uuid DEFAULT NULL,
  p_after_updated_at timestamptz DEFAULT NULL,
  p_after_org_id uuid DEFAULT NULL,
  p_after_template_id uuid DEFAULT NULL
)
RETURNS TABLE(org_id uuid, template_id uuid, updated_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500);
  v_has_cursor boolean := p_after_updated_at IS NOT NULL
    AND p_after_org_id IS NOT NULL
    AND p_after_template_id IS NOT NULL;
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'SIGN_RECOVERY_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF (p_after_updated_at IS NULL) <> (p_after_org_id IS NULL)
     OR (p_after_updated_at IS NULL) <> (p_after_template_id IS NULL) THEN
    RAISE EXCEPTION 'SIGN_RECOVERY_INVALID_CURSOR' USING ERRCODE = '22023';
  END IF;
  IF p_older_than IS NULL THEN
    RAISE EXCEPTION 'SIGN_CUTOFF_REQUIRED' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT t.org_id, t.id AS template_id, t.updated_at
  FROM crove_sign.template t
  JOIN crove_kernel.tenant tn ON tn.org_id = t.org_id
  WHERE tn.status = 'active'
    AND (p_org_id IS NULL OR t.org_id = p_org_id)
    AND crove_kernel.org_app_on(t.org_id, 'sign')
    AND t.status IN ('draft', 'active')
    AND t.inspect_status = 'pending'
    AND t.updated_at <= p_older_than
    AND (NOT v_has_cursor OR (t.updated_at, t.org_id, t.id) > (p_after_updated_at, p_after_org_id, p_after_template_id))
  ORDER BY t.updated_at ASC, t.org_id ASC, t.id ASC
  LIMIT v_limit;
END $$;

REVOKE ALL ON FUNCTION crove_sign.template_work_recovery_candidates(timestamptz, integer, uuid, timestamptz, uuid, uuid)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.template_work_recovery_candidates(timestamptz, integer, uuid, timestamptz, uuid, uuid) TO crove_worker;
