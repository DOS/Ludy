-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove eSign Slice 1a (docs/plan/esign.md, #3323): core schema, tables, RLS, guards, machinery token/OTP
-- definers, file source/upload purposes, pg-boss queues, and health check module array.
-- Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

CREATE SCHEMA IF NOT EXISTS crove_sign;
REVOKE ALL ON SCHEMA crove_sign FROM PUBLIC;
GRANT USAGE ON SCHEMA crove_sign TO crove_tenant, crove_worker;

-- ---------------------------------------------------------------------------
-- 1. Envelopes, signers, fields, AI analyses
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_sign.envelope (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  title text NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(title)) BETWEEN 1 AND 300),
  subject text CHECK (subject IS NULL OR pg_catalog.length(subject) <= 300),
  message text CHECK (message IS NULL OR pg_catalog.length(message) <= 5000),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'in_progress', 'completed', 'declined', 'voided', 'expired')),
  routing_mode text NOT NULL DEFAULT 'parallel' CHECK (routing_mode IN ('parallel', 'sequential')),
  source_kind text NOT NULL DEFAULT 'standalone' CHECK (source_kind IN ('standalone', 'crm_quote', 'crm_order', 'hr_contract')),
  source_id uuid,
  source_file_id uuid NOT NULL,
  source_storage_key text NOT NULL CHECK (pg_catalog.length(source_storage_key) BETWEEN 1 AND 512),
  source_generation text NOT NULL CHECK (pg_catalog.length(source_generation) BETWEEN 1 AND 1028),
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  inspect_status text NOT NULL DEFAULT 'pending' CHECK (inspect_status IN ('pending', 'passed', 'failed')),
  inspect_error text CHECK (inspect_error IS NULL OR pg_catalog.length(inspect_error) <= 500),
  page_count integer CHECK (page_count IS NULL OR (page_count >= 1 AND page_count <= 200)),
  page_dimensions_json jsonb,
  sealed_file_id uuid,
  sealed_storage_key text CHECK (sealed_storage_key IS NULL OR pg_catalog.length(sealed_storage_key) BETWEEN 1 AND 512),
  sealed_generation text CHECK (sealed_generation IS NULL OR pg_catalog.length(sealed_generation) BETWEEN 1 AND 1028),
  sealed_sha256 text CHECK (sealed_sha256 IS NULL OR sealed_sha256 ~ '^[0-9a-f]{64}$'),
  seal_status text CHECK (seal_status IS NULL OR seal_status IN ('pending', 'sealed', 'failed')),
  certificate_file_id uuid,
  certificate_storage_key text CHECK (certificate_storage_key IS NULL OR pg_catalog.length(certificate_storage_key) BETWEEN 1 AND 512),
  certificate_generation text CHECK (certificate_generation IS NULL OR pg_catalog.length(certificate_generation) BETWEEN 1 AND 1028),
  certificate_sha256 text CHECK (certificate_sha256 IS NULL OR certificate_sha256 ~ '^[0-9a-f]{64}$'),
  certificate_code text CHECK (certificate_code IS NULL OR pg_catalog.length(certificate_code) BETWEEN 1 AND 64),
  expires_at timestamptz,
  sent_at timestamptz,
  completed_at timestamptz,
  declined_at timestamptz,
  voided_at timestamptz,
  voided_by uuid REFERENCES crove_kernel.user_account (id),
  void_reason text CHECK (void_reason IS NULL OR pg_catalog.length(void_reason) <= 1000),
  expired_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid NOT NULL REFERENCES crove_kernel.user_account (id),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT envelope_source_file_fk FOREIGN KEY (org_id, source_file_id) REFERENCES crove_kernel.file (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT envelope_sealed_file_fk FOREIGN KEY (org_id, sealed_file_id) REFERENCES crove_kernel.file (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT envelope_certificate_file_fk FOREIGN KEY (org_id, certificate_file_id) REFERENCES crove_kernel.file (org_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS envelope_source_file_idx ON crove_sign.envelope (org_id, source_file_id);
CREATE INDEX IF NOT EXISTS envelope_sealed_file_idx ON crove_sign.envelope (org_id, sealed_file_id) WHERE sealed_file_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS envelope_certificate_file_idx ON crove_sign.envelope (org_id, certificate_file_id) WHERE certificate_file_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS envelope_status_updated_idx ON crove_sign.envelope (org_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS envelope_source_link_idx ON crove_sign.envelope (org_id, source_kind, source_id) WHERE source_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS envelope_certificate_code_uq ON crove_sign.envelope (org_id, certificate_code) WHERE certificate_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS envelope_expire_due_idx ON crove_sign.envelope (org_id, expires_at) WHERE status IN ('sent', 'in_progress') AND expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS envelope_inspect_pending_idx ON crove_sign.envelope (org_id, updated_at, id) WHERE status = 'draft' AND inspect_status = 'pending';
CREATE INDEX IF NOT EXISTS envelope_seal_pending_idx ON crove_sign.envelope (org_id, updated_at, id) WHERE status = 'completed' AND seal_status IS NULL;

CREATE TABLE IF NOT EXISTS crove_sign.signer (
  org_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  envelope_id uuid NOT NULL,
  routing_order integer NOT NULL DEFAULT 1 CHECK (routing_order >= 1 AND routing_order <= 100),
  signer_role text NOT NULL DEFAULT 'signer' CHECK (signer_role IN ('signer', 'approver', 'cc')),
  role_label text NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(role_label)) BETWEEN 1 AND 120),
  name text NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(name)) BETWEEN 1 AND 200),
  email text CHECK (email IS NULL OR (pg_catalog.length(email) BETWEEN 3 AND 254 AND pg_catalog.strpos(email, '@') > 1)),
  phone text CHECK (phone IS NULL OR pg_catalog.length(phone) BETWEEN 6 AND 32),
  delivery_mode text NOT NULL DEFAULT 'link' CHECK (delivery_mode IN ('link', 'email')),
  require_email_otp boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'pending', 'viewed', 'signed', 'declined', 'voided', 'expired')),
  token_last_reminded_at timestamptz,
  viewed_at timestamptz,
  signed_at timestamptz,
  declined_at timestamptz,
  decline_reason text CHECK (decline_reason IS NULL OR pg_catalog.length(decline_reason) <= 1000),
  otp_verified_at timestamptz,
  signature_kind text CHECK (signature_kind IS NULL OR signature_kind IN ('draw', 'type')),
  signature_typed_text text CHECK (signature_typed_text IS NULL OR pg_catalog.length(signature_typed_text) <= 200),
  signer_user_agent text CHECK (signer_user_agent IS NULL OR pg_catalog.length(signer_user_agent) <= 500),
  signer_ip_hash text CHECK (signer_ip_hash IS NULL OR signer_ip_hash ~ '^[0-9a-f]{64}$'),
  consent_accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT signer_org_envelope_id_uq UNIQUE (org_id, envelope_id, id),
  CONSTRAINT signer_email_required_check CHECK (email IS NOT NULL OR (delivery_mode = 'link' AND require_email_otp = false)),
  CONSTRAINT signer_envelope_fk FOREIGN KEY (org_id, envelope_id) REFERENCES crove_sign.envelope (org_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS signer_envelope_idx ON crove_sign.signer (org_id, envelope_id, routing_order, id);

CREATE TABLE IF NOT EXISTS crove_sign.field (
  org_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  envelope_id uuid NOT NULL,
  signer_id uuid NOT NULL,
  field_type text NOT NULL CHECK (field_type IN ('signature', 'initials', 'date', 'text', 'checkbox')),
  page_number integer NOT NULL CHECK (page_number >= 1 AND page_number <= 200),
  x_norm numeric(8,6) NOT NULL CHECK (x_norm >= 0 AND x_norm < 1),
  y_norm numeric(8,6) NOT NULL CHECK (y_norm >= 0 AND y_norm < 1),
  w_norm numeric(8,6) NOT NULL CHECK (w_norm > 0 AND w_norm <= 1),
  h_norm numeric(8,6) NOT NULL CHECK (h_norm > 0 AND h_norm <= 1),
  label text CHECK (label IS NULL OR pg_catalog.length(label) <= 200),
  required boolean NOT NULL DEFAULT true,
  proposed_by_ai boolean NOT NULL DEFAULT false,
  font_size_pt integer CHECK (font_size_pt IS NULL OR (font_size_pt >= 6 AND font_size_pt <= 72)),
  value_text text CHECK (value_text IS NULL OR pg_catalog.length(value_text) <= 2000),
  value_checked boolean,
  signature_png_base64 text CHECK (signature_png_base64 IS NULL OR pg_catalog.length(signature_png_base64) <= 360000),
  filled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT field_bounds_check CHECK (x_norm + w_norm <= 1.000000 AND y_norm + h_norm <= 1.000000),
  CONSTRAINT field_envelope_fk FOREIGN KEY (org_id, envelope_id) REFERENCES crove_sign.envelope (org_id, id) ON DELETE CASCADE,
  CONSTRAINT field_signer_fk FOREIGN KEY (org_id, envelope_id, signer_id) REFERENCES crove_sign.signer (org_id, envelope_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS field_envelope_idx ON crove_sign.field (org_id, envelope_id, page_number, id);
CREATE INDEX IF NOT EXISTS field_signer_idx ON crove_sign.field (org_id, signer_id);
CREATE INDEX IF NOT EXISTS field_envelope_signer_idx ON crove_sign.field (org_id, envelope_id, signer_id);

CREATE TABLE IF NOT EXISTS crove_sign.ai_analysis (
  org_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  envelope_id uuid NOT NULL,
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed')),
  proposed_fields_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  risk_clauses_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  summary_text text CHECK (summary_text IS NULL OR pg_catalog.length(summary_text) <= 20000),
  error_message text CHECK (error_message IS NULL OR pg_catalog.length(error_message) <= 1000),
  prompt_version text NOT NULL DEFAULT 'v1' CHECK (pg_catalog.length(prompt_version) BETWEEN 1 AND 32),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT ai_analysis_envelope_fk FOREIGN KEY (org_id, envelope_id) REFERENCES crove_sign.envelope (org_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS ai_analysis_envelope_idx ON crove_sign.ai_analysis (org_id, envelope_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 2. Machinery tables: signing_token and signing_otp (definer-only, zero runtime grants)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_sign.signing_token (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  envelope_id uuid NOT NULL,
  signer_id uuid NOT NULL,
  token_sha256 text NOT NULL CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_by uuid REFERENCES crove_kernel.user_account (id),
  used_at timestamptz,
  last_viewed_at timestamptz,
  created_by uuid NOT NULL REFERENCES crove_kernel.user_account (id),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT signing_token_envelope_fk FOREIGN KEY (org_id, envelope_id) REFERENCES crove_sign.envelope (org_id, id) ON DELETE CASCADE,
  CONSTRAINT signing_token_signer_fk FOREIGN KEY (org_id, signer_id) REFERENCES crove_sign.signer (org_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS signing_token_sha256_uq ON crove_sign.signing_token (token_sha256);
CREATE UNIQUE INDEX IF NOT EXISTS signing_token_active_signer_uq ON crove_sign.signing_token (org_id, signer_id) WHERE revoked_at IS NULL AND used_at IS NULL;
CREATE INDEX IF NOT EXISTS signing_token_envelope_idx ON crove_sign.signing_token (org_id, envelope_id);
CREATE INDEX IF NOT EXISTS signing_token_signer_idx ON crove_sign.signing_token (org_id, signer_id);

CREATE TABLE IF NOT EXISTS crove_sign.signing_otp (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  signer_id uuid NOT NULL,
  signing_token_id uuid NOT NULL,
  email text NOT NULL CHECK (pg_catalog.length(email) BETWEEN 3 AND 254),
  otp_sha256 text CHECK (otp_sha256 IS NULL OR otp_sha256 ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= 10),
  verified_at timestamptz,
  invalidated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT signing_otp_signer_fk FOREIGN KEY (org_id, signer_id) REFERENCES crove_sign.signer (org_id, id) ON DELETE CASCADE,
  CONSTRAINT signing_otp_token_fk FOREIGN KEY (org_id, signing_token_id) REFERENCES crove_sign.signing_token (org_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS signing_otp_signer_idx ON crove_sign.signing_otp (org_id, signer_id);
CREATE INDEX IF NOT EXISTS signing_otp_token_idx ON crove_sign.signing_otp (org_id, signing_token_id);

-- ---------------------------------------------------------------------------
-- 3. Append-only signing event ledger
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_sign.signing_event (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  envelope_id uuid NOT NULL,
  signer_id uuid,
  seq integer NOT NULL CHECK (seq >= 1),
  event_type text NOT NULL CHECK (pg_catalog.length(event_type) BETWEEN 1 AND 80),
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'signer', 'system', 'ai')),
  actor_id uuid,
  actor_label text NOT NULL CHECK (pg_catalog.length(actor_label) BETWEEN 1 AND 254),
  document_sha256 text NOT NULL CHECK (document_sha256 ~ '^[0-9a-f]{64}$'),
  prev_event_hash text CHECK (prev_event_hash IS NULL OR prev_event_hash ~ '^[0-9a-f]{64}$'),
  event_hash text NOT NULL CHECK (event_hash ~ '^[0-9a-f]{64}$'),
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip_hash text CHECK (ip_hash IS NULL OR ip_hash ~ '^[0-9a-f]{64}$'),
  user_agent text CHECK (user_agent IS NULL OR pg_catalog.length(user_agent) <= 500),
  occurred_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT signing_event_envelope_seq_uq UNIQUE (org_id, envelope_id, seq),
  CONSTRAINT signing_event_envelope_fk FOREIGN KEY (org_id, envelope_id) REFERENCES crove_sign.envelope (org_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS signing_event_signer_idx ON crove_sign.signing_event (org_id, signer_id) WHERE signer_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. RLS & privileges
-- ---------------------------------------------------------------------------
SELECT crove_kernel.apply_tenant_rls('crove_sign.envelope');
SELECT crove_kernel.apply_tenant_rls('crove_sign.signer');
SELECT crove_kernel.apply_tenant_rls('crove_sign.field');
SELECT crove_kernel.apply_tenant_rls('crove_sign.ai_analysis');
SELECT crove_kernel.apply_tenant_rls('crove_sign.signing_event', true);

-- Restrict tenant mutations to owner, admin, member (or system context); viewers stay read-only.
DO $$
DECLARE
  v_t text;
  -- Allow system and agent actors through RLS USING/WITH CHECK so agent_write_guard fires AGENT_FORBIDDEN while viewer role remains blocked.
  v_write_check text := '((SELECT crove_kernel.ctx_actor_type()) IN (''system'', ''agent'') OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = %s.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN (''owner'', ''admin'', ''member'')))';
BEGIN
  FOREACH v_t IN ARRAY ARRAY['crove_sign.envelope', 'crove_sign.signer', 'crove_sign.field', 'crove_sign.ai_analysis'] LOOP
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

DROP POLICY IF EXISTS writer_insert ON crove_sign.signing_event;
CREATE POLICY writer_insert ON crove_sign.signing_event AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) IN ('system', 'agent')
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = signing_event.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member')));

ALTER TABLE crove_sign.signing_token ENABLE ROW LEVEL SECURITY;
ALTER TABLE crove_sign.signing_otp ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON crove_sign.signing_token FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
REVOKE ALL ON crove_sign.signing_otp FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
SELECT crove_kernel.agent_write_guard_install('crove_sign.signing_token');
SELECT crove_kernel.agent_write_guard_install('crove_sign.signing_otp');

CREATE OR REPLACE FUNCTION crove_sign.signing_token_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF (NEW.org_id, NEW.id, NEW.envelope_id, NEW.signer_id, NEW.token_sha256, NEW.expires_at, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.org_id, OLD.id, OLD.envelope_id, OLD.signer_id, OLD.token_sha256, OLD.expires_at, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'SIGNING_TOKEN_IMMUTABLE' USING ERRCODE = '42501', DETAIL = 'signing_token identity and hash columns are immutable';
  END IF;
  IF OLD.used_at IS NOT NULL OR OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'SIGNING_TOKEN_FINAL' USING ERRCODE = '42501', DETAIL = 'used or revoked signing_token cannot be modified';
  END IF;
  IF NEW.used_at IS NOT NULL AND NEW.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'SIGNING_TOKEN_INVALID_STATE' USING ERRCODE = '42501', DETAIL = 'signing_token cannot be both used and revoked';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION crove_sign.signing_token_immutable() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

DROP TRIGGER IF EXISTS signing_token_immutable ON crove_sign.signing_token;
CREATE TRIGGER signing_token_immutable
  BEFORE UPDATE ON crove_sign.signing_token
  FOR EACH ROW
  EXECUTE FUNCTION crove_sign.signing_token_immutable();

-- ---------------------------------------------------------------------------
-- 5. Draft-only mutation guards & append-only ledger enforcement
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_sign.envelope_guard() RETURNS trigger
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
  -- Inspection, sealing, certificate, and completion columns are written only by system workers.
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

DROP TRIGGER IF EXISTS envelope_guard ON crove_sign.envelope;
CREATE TRIGGER envelope_guard BEFORE INSERT OR UPDATE OR DELETE ON crove_sign.envelope
  FOR EACH ROW EXECUTE FUNCTION crove_sign.envelope_guard();

CREATE OR REPLACE FUNCTION crove_sign.signer_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_actor text := crove_kernel.ctx_actor_type();
  v_env_id uuid := COALESCE(OLD.envelope_id, NEW.envelope_id);
  v_org uuid := COALESCE(OLD.org_id, NEW.org_id);
  v_env_status text;
BEGIN
  IF v_actor IS NULL OR v_actor = 'system' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.org_id IS DISTINCT FROM crove_kernel.ctx_org_id() THEN
    RETURN NEW;
  END IF;
  SELECT e.status INTO v_env_status FROM crove_sign.envelope e WHERE e.org_id = v_org AND e.id = v_env_id FOR SHARE;
  IF TG_OP = 'DELETE' THEN
    IF v_env_status IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'ENVELOPE_FROZEN' USING ERRCODE = '42501', DETAIL = 'signers can only be added or removed while envelope is draft';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF v_env_status IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'ENVELOPE_FROZEN' USING ERRCODE = '42501', DETAIL = 'signers can only be added or removed while envelope is draft';
    END IF;
    IF NEW.status <> 'waiting' THEN
      RAISE EXCEPTION 'SIGNER_INVALID_TRANSITION' USING ERRCODE = '42501', DETAIL = 'new signers on a draft envelope must start in waiting status';
    END IF;
    IF NEW.token_last_reminded_at IS NOT NULL OR NEW.viewed_at IS NOT NULL OR NEW.signed_at IS NOT NULL
       OR NEW.declined_at IS NOT NULL OR NEW.decline_reason IS NOT NULL OR NEW.otp_verified_at IS NOT NULL
       OR NEW.signature_kind IS NOT NULL OR NEW.signature_typed_text IS NOT NULL
       OR NEW.signer_user_agent IS NOT NULL OR NEW.signer_ip_hash IS NOT NULL
       OR NEW.consent_accepted_at IS NOT NULL THEN
      RAISE EXCEPTION 'SIGNER_SYSTEM_ONLY' USING ERRCODE = '42501', DETAIL = 'signing evidence columns are system-managed';
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE by tenant user
  IF (pg_catalog.to_jsonb(OLD) - ARRAY['updated_at']) IS NOT DISTINCT FROM (pg_catalog.to_jsonb(NEW) - ARRAY['updated_at']) THEN
    RETURN NEW;
  END IF;
  IF (NEW.org_id, NEW.id, NEW.envelope_id, NEW.created_at) IS DISTINCT FROM (OLD.org_id, OLD.id, OLD.envelope_id, OLD.created_at) THEN
    RAISE EXCEPTION 'SIGNER_IMMUTABLE' USING ERRCODE = '42501';
  END IF;
  IF (NEW.viewed_at, NEW.signed_at, NEW.declined_at, NEW.decline_reason, NEW.otp_verified_at,
      NEW.signature_kind, NEW.signature_typed_text, NEW.signer_user_agent, NEW.signer_ip_hash, NEW.consent_accepted_at)
     IS DISTINCT FROM (OLD.viewed_at, OLD.signed_at, OLD.declined_at, OLD.decline_reason, OLD.otp_verified_at,
      OLD.signature_kind, OLD.signature_typed_text, OLD.signer_user_agent, OLD.signer_ip_hash, OLD.consent_accepted_at) THEN
    RAISE EXCEPTION 'SIGNER_SYSTEM_ONLY' USING ERRCODE = '42501', DETAIL = 'signing evidence columns are system-managed';
  END IF;
  IF v_env_status = 'draft' THEN
    IF NEW.token_last_reminded_at IS DISTINCT FROM OLD.token_last_reminded_at THEN
      RAISE EXCEPTION 'SIGNER_SYSTEM_ONLY' USING ERRCODE = '42501', DETAIL = 'reminder timestamp cannot be set while envelope is draft';
    END IF;
    IF (NEW.routing_order, NEW.role_label, NEW.name, NEW.email, NEW.phone, NEW.delivery_mode, NEW.require_email_otp, NEW.status)
       IS DISTINCT FROM (OLD.routing_order, OLD.role_label, OLD.name, OLD.email, OLD.phone, OLD.delivery_mode, OLD.require_email_otp, OLD.status) THEN
      IF NEW.status <> 'waiting' THEN
        RAISE EXCEPTION 'SIGNER_INVALID_TRANSITION' USING ERRCODE = '42501';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF v_env_status IN ('sent', 'in_progress', 'voided') THEN
    -- Allow send activation (waiting -> pending), voiding (waiting/pending/viewed -> voided), or reminder stamp on live signer.
    IF (pg_catalog.to_jsonb(OLD) - ARRAY['status', 'token_last_reminded_at', 'updated_at'])
       IS DISTINCT FROM (pg_catalog.to_jsonb(NEW) - ARRAY['status', 'token_last_reminded_at', 'updated_at']) THEN
      RAISE EXCEPTION 'ENVELOPE_FROZEN' USING ERRCODE = '42501', DETAIL = 'signer identity and delivery cannot change after send';
    END IF;
    IF v_env_status = 'voided' THEN
      IF NEW.token_last_reminded_at IS DISTINCT FROM OLD.token_last_reminded_at
         OR NOT (OLD.status IN ('waiting', 'pending', 'viewed') AND NEW.status = 'voided') THEN
        RAISE EXCEPTION 'SIGNER_INVALID_TRANSITION' USING ERRCODE = '42501';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      IF NOT ((OLD.status = 'waiting' AND NEW.status = 'pending')
              OR (OLD.status IN ('waiting', 'pending', 'viewed') AND NEW.status = 'voided')) THEN
        RAISE EXCEPTION 'SIGNER_INVALID_TRANSITION' USING ERRCODE = '42501';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ENVELOPE_FROZEN' USING ERRCODE = '42501', DETAIL = 'signers are frozen after envelope leaves active state';
END $$;

DROP TRIGGER IF EXISTS signer_guard ON crove_sign.signer;
CREATE TRIGGER signer_guard BEFORE INSERT OR UPDATE OR DELETE ON crove_sign.signer
  FOR EACH ROW EXECUTE FUNCTION crove_sign.signer_guard();

CREATE OR REPLACE FUNCTION crove_sign.field_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_actor text := crove_kernel.ctx_actor_type();
  v_env_id uuid := COALESCE(OLD.envelope_id, NEW.envelope_id);
  v_org uuid := COALESCE(OLD.org_id, NEW.org_id);
  v_env_status text;
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
  IF TG_OP = 'UPDATE' AND (NEW.org_id, NEW.id, NEW.envelope_id, NEW.created_at) IS DISTINCT FROM (OLD.org_id, OLD.id, OLD.envelope_id, OLD.created_at) THEN
    RAISE EXCEPTION 'FIELD_IMMUTABLE' USING ERRCODE = '42501';
  END IF;
  SELECT e.status INTO v_env_status FROM crove_sign.envelope e WHERE e.org_id = v_org AND e.id = v_env_id FOR SHARE;
  IF v_env_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'ENVELOPE_FROZEN' USING ERRCODE = '42501', DETAIL = 'fields cannot change after envelope is sent';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF NEW.value_text IS NOT NULL OR NEW.value_checked IS NOT NULL OR NEW.signature_png_base64 IS NOT NULL OR NEW.filled_at IS NOT NULL THEN
    RAISE EXCEPTION 'FIELD_SYSTEM_ONLY' USING ERRCODE = '42501', DETAIL = 'field values are filled only through public signing';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS field_guard ON crove_sign.field;
CREATE TRIGGER field_guard BEFORE INSERT OR UPDATE OR DELETE ON crove_sign.field
  FOR EACH ROW EXECUTE FUNCTION crove_sign.field_guard();

CREATE OR REPLACE FUNCTION crove_sign.cleanup_org_stale(
  p_draft_cutoff timestamptz,
  p_secret_cutoff timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_otps integer := 0;
  v_tokens integer := 0;
  v_drafts integer := 0;
  v_events integer := 0;
  v_draft_ids uuid[];
BEGIN
  IF v_org IS NULL
     OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'system'
     OR NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'SIGN_CLEANUP_SYSTEM_CONTEXT' USING ERRCODE = '42501';
  END IF;

  -- Clean expired/used/invalidated OTPs older than cutoff (keep completed envelope & signing_event intact).
  DELETE FROM crove_sign.signing_otp o
  WHERE o.org_id = v_org
    AND LEAST(o.expires_at, COALESCE(o.invalidated_at, o.expires_at), COALESCE(o.verified_at, o.expires_at)) < p_secret_cutoff;
  GET DIAGNOSTICS v_otps = ROW_COUNT;

  -- Clean stale tokens older than cutoff (revoked, used, or expired).
  DELETE FROM crove_sign.signing_token t
  WHERE t.org_id = v_org
    AND COALESCE(t.revoked_at, t.used_at, t.expires_at) < p_secret_cutoff;
  GET DIAGNOSTICS v_tokens = ROW_COUNT;

  -- Lock abandoned draft envelopes before deleting their event chain so concurrent send cannot race.
  v_draft_ids := ARRAY(
    SELECT e.id FROM crove_sign.envelope e
    WHERE e.org_id = v_org AND e.status = 'draft' AND e.updated_at < p_draft_cutoff
    ORDER BY e.updated_at ASC, e.id ASC
    FOR UPDATE OF e SKIP LOCKED
  );
  IF COALESCE(pg_catalog.array_length(v_draft_ids, 1), 0) > 0 THEN
    PERFORM pg_catalog.set_config('crove.sign_cleanup', v_org::text, true);
    DELETE FROM crove_sign.signing_event ev
    WHERE ev.org_id = v_org AND ev.envelope_id = ANY (v_draft_ids);
    GET DIAGNOSTICS v_events = ROW_COUNT;
    PERFORM pg_catalog.set_config('crove.sign_cleanup', '', true);

    DELETE FROM crove_sign.envelope e
    WHERE e.org_id = v_org AND e.id = ANY (v_draft_ids) AND e.status = 'draft';
    GET DIAGNOSTICS v_drafts = ROW_COUNT;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'otps', v_otps,
    'tokens', v_tokens,
    'drafts', v_drafts,
    'draftEvents', v_events
  );
END $$;

REVOKE ALL ON FUNCTION crove_sign.cleanup_org_stale(timestamptz, timestamptz) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.cleanup_org_stale(timestamptz, timestamptz) TO crove_worker;

CREATE OR REPLACE FUNCTION crove_sign.signing_event_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_purge_owner oid := (SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.oid = 'crove_kernel.org_purge(integer)'::pg_catalog.regprocedure);
  v_cleanup_owner oid := (SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.oid = 'crove_sign.cleanup_org_stale(timestamptz,timestamptz)'::pg_catalog.regprocedure);
  v_cur_role oid := (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = CURRENT_USER);
BEGIN
  IF TG_OP = 'DELETE'
     AND v_cur_role = v_purge_owner
     AND pg_catalog.current_setting('crove.org_purge', true) = OLD.org_id::text
     AND pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER')
     AND crove_kernel.ctx_actor_type() = 'system'
     AND crove_kernel.ctx_org_id() = OLD.org_id
     AND EXISTS (SELECT 1 FROM crove_kernel.tenant t WHERE t.org_id = OLD.org_id AND t.status = 'offboarding') THEN
    RETURN OLD;
  END IF;

  IF TG_OP = 'DELETE'
     AND v_cur_role = v_cleanup_owner
     AND pg_catalog.current_setting('crove.sign_cleanup', true) = OLD.org_id::text
     AND pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER')
     AND crove_kernel.ctx_actor_type() = 'system'
     AND crove_kernel.ctx_org_id() = OLD.org_id
     AND EXISTS (SELECT 1 FROM crove_sign.envelope e WHERE e.org_id = OLD.org_id AND e.id = OLD.envelope_id AND e.status = 'draft') THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'table %.% is append-only', TG_TABLE_SCHEMA, TG_TABLE_NAME USING ERRCODE = '42501';
END $$;

DROP TRIGGER IF EXISTS append_only_row ON crove_sign.signing_event;
CREATE TRIGGER append_only_row BEFORE UPDATE OR DELETE ON crove_sign.signing_event
  FOR EACH ROW EXECUTE FUNCTION crove_sign.signing_event_append_only();

DROP TRIGGER IF EXISTS append_only_truncate ON crove_sign.signing_event;
CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON crove_sign.signing_event
  FOR EACH STATEMENT EXECUTE FUNCTION crove_kernel.reject_mutation();

-- ---------------------------------------------------------------------------
-- 6. Machinery definers for signing_token, signing_otp, and worker sweeps
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
  v_env_status text;
  v_env_creator uuid;
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
  IF p_expires_at IS NULL OR p_expires_at <= v_now THEN
    RAISE EXCEPTION 'SIGN_INVALID_EXPIRY' USING ERRCODE = '22023';
  END IF;

  SELECT e.status, e.created_by INTO v_env_status, v_env_creator
  FROM crove_sign.envelope e
  WHERE e.org_id = v_org AND e.id = p_envelope_id
  FOR SHARE;
  IF v_env_status IS NULL OR v_env_status NOT IN ('sent', 'in_progress') THEN
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

REVOKE ALL ON FUNCTION crove_sign.mint_signing_token(uuid, uuid, text, timestamptz) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.mint_signing_token(uuid, uuid, text, timestamptz) TO crove_tenant;

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
  v_count integer := 0;
BEGIN
  IF v_org IS NULL OR v_actor IS NULL THEN
    RAISE EXCEPTION 'SIGN_CONTEXT_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF v_actor NOT IN ('user', 'system') THEN
    RAISE EXCEPTION 'SIGN_FORBIDDEN_ACTOR' USING ERRCODE = '42501';
  END IF;
  IF v_actor = 'user' THEN
    IF v_user IS NULL OR NOT EXISTS (
      SELECT 1 FROM crove_kernel.tenant_member m
      WHERE m.org_id = v_org AND m.user_id = v_user AND m.role IN ('owner', 'admin', 'member')
    ) THEN
      RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501';
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

REVOKE ALL ON FUNCTION crove_sign.revoke_envelope_tokens(uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.revoke_envelope_tokens(uuid) TO crove_tenant;

CREATE OR REPLACE FUNCTION crove_sign.expire_sweep_due_orgs(p_limit integer DEFAULT 100)
RETURNS TABLE(org_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500);
  v_now timestamptz := pg_catalog.now();
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'SIGN_SWEEP_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT DISTINCT e.org_id
  FROM crove_sign.envelope e
  JOIN crove_kernel.tenant t ON t.org_id = e.org_id
  WHERE t.status = 'active'
    AND e.status IN ('sent', 'in_progress')
    AND e.expires_at IS NOT NULL
    AND e.expires_at <= v_now
  LIMIT v_limit;
END $$;

REVOKE ALL ON FUNCTION crove_sign.expire_sweep_due_orgs(integer) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.expire_sweep_due_orgs(integer) TO crove_worker;

CREATE OR REPLACE FUNCTION crove_sign.cleanup_due_orgs(
  p_draft_cutoff timestamptz,
  p_secret_cutoff timestamptz,
  p_limit integer DEFAULT 100
)
RETURNS TABLE(org_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500);
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'SIGN_CLEANUP_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT DISTINCT sub.org_id
  FROM (
    SELECT o.org_id FROM crove_sign.signing_otp o
    WHERE LEAST(o.expires_at, COALESCE(o.invalidated_at, o.expires_at), COALESCE(o.verified_at, o.expires_at)) < p_secret_cutoff
    UNION
    SELECT s.org_id FROM crove_sign.signing_token s
    WHERE COALESCE(s.revoked_at, s.used_at, s.expires_at) < p_secret_cutoff
    UNION
    SELECT e.org_id FROM crove_sign.envelope e
    WHERE e.status = 'draft' AND e.updated_at < p_draft_cutoff
  ) sub
  JOIN crove_kernel.tenant t ON t.org_id = sub.org_id
  WHERE t.status = 'active'
  LIMIT v_limit;
END $$;

REVOKE ALL ON FUNCTION crove_sign.cleanup_due_orgs(timestamptz, timestamptz, integer) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.cleanup_due_orgs(timestamptz, timestamptz, integer) TO crove_worker;

CREATE OR REPLACE FUNCTION crove_sign.personal_erase_otp(p_email text) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_deleted integer := 0;
BEGIN
  IF v_org IS NULL
    OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user'
    OR crove_kernel.ctx_agent_id() IS NOT NULL
    OR crove_kernel.ctx_user_id() IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM crove_kernel.tenant_member m
      WHERE m.org_id = v_org AND m.user_id = crove_kernel.ctx_user_id() AND m.role = 'owner'
    ) THEN
    RAISE EXCEPTION 'SIGN_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  IF p_email IS NULL OR pg_catalog.btrim(p_email) = '' THEN
    RETURN 0;
  END IF;

  DELETE FROM crove_sign.signing_otp
  WHERE org_id = v_org
    AND pg_catalog.lower(email) = pg_catalog.lower(pg_catalog.btrim(p_email));
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  RETURN v_deleted;
END $$;

REVOKE ALL ON FUNCTION crove_sign.personal_erase_otp(text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.personal_erase_otp(text) TO crove_tenant;

CREATE OR REPLACE FUNCTION crove_sign.work_recovery_candidates(
  p_older_than timestamptz,
  p_limit integer DEFAULT 100,
  p_org_id uuid DEFAULT NULL
)
RETURNS TABLE(work_kind text, org_id uuid, envelope_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500);
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'SIGN_RECOVERY_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT q.work_kind, q.org_id, q.envelope_id
  FROM (
    SELECT 'inspect'::text AS work_kind, e.org_id, e.id AS envelope_id, e.updated_at
    FROM crove_sign.envelope e
    JOIN crove_kernel.tenant t ON t.org_id = e.org_id
    WHERE t.status = 'active'
      AND (p_org_id IS NULL OR e.org_id = p_org_id)
      AND crove_kernel.org_app_on(e.org_id, 'sign')
      AND e.status = 'draft'
      AND e.inspect_status = 'pending'
      AND e.updated_at <= p_older_than
    UNION ALL
    SELECT 'seal'::text AS work_kind, e.org_id, e.id AS envelope_id, e.updated_at
    FROM crove_sign.envelope e
    JOIN crove_kernel.tenant t ON t.org_id = e.org_id
    WHERE t.status = 'active'
      AND (p_org_id IS NULL OR e.org_id = p_org_id)
      AND crove_kernel.org_app_on(e.org_id, 'sign')
      AND e.status = 'completed'
      AND e.seal_status IS NULL
      AND e.updated_at <= p_older_than
  ) q
  ORDER BY q.updated_at ASC, q.envelope_id ASC
  LIMIT v_limit;
END $$;

REVOKE ALL ON FUNCTION crove_sign.work_recovery_candidates(timestamptz, integer, uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.work_recovery_candidates(timestamptz, integer, uuid) TO crove_worker;

-- ---------------------------------------------------------------------------
-- 7. Queues
-- ---------------------------------------------------------------------------
SELECT crove_jobs.create_queue('sign-pdf-inspect', '{"policy":"standard","deadLetter":"kernel-job.dlq"}'::jsonb);
SELECT crove_jobs.create_queue('sign-pdf-seal', '{"policy":"standard","deadLetter":"kernel-job.dlq"}'::jsonb);
SELECT crove_jobs.create_queue('sign-expire-sweep', '{"policy":"standard","deadLetter":"kernel-job.dlq"}'::jsonb);
SELECT crove_jobs.create_queue('sign-cleanup', '{"policy":"standard","deadLetter":"kernel-job.dlq"}'::jsonb);

REVOKE ALL ON FUNCTION crove_sign.envelope_guard(), crove_sign.signer_guard(), crove_sign.field_guard(), crove_sign.signing_event_append_only()
FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
