-- SPDX-License-Identifier: AGPL-3.0-only
-- eSign Slice 5e (#4443, docs/plan/esign.md, owner instruction 2026-11-22):
-- sender-side signer KYC attachment verification checks bound to an envelope, an attachment field,
-- and a verified sign_attachment file, with restrictive envelope/field RLS inheritance and owner PDPL erasure.

SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_sign.kyc_check (
  org_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT ludy_kernel.uuid_v7(),
  envelope_id uuid NOT NULL,
  field_id uuid NOT NULL,
  file_id uuid NOT NULL,
  file_sha256 text NOT NULL CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'matched', 'mismatch', 'needs_review')),
  mode text NOT NULL CHECK (mode IN ('deterministic', 'ai', 'manual')),
  findings_json jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (pg_catalog.jsonb_typeof(findings_json) = 'object'),
  checked_by uuid REFERENCES ludy_kernel.user_account (id),
  checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT kyc_check_field_unique UNIQUE (org_id, field_id),
  CONSTRAINT kyc_check_envelope_fk FOREIGN KEY (org_id, envelope_id)
    REFERENCES crove_sign.envelope (org_id, id) ON DELETE CASCADE,
  CONSTRAINT kyc_check_field_fk FOREIGN KEY (org_id, field_id)
    REFERENCES crove_sign.field (org_id, id) ON DELETE CASCADE,
  CONSTRAINT kyc_check_file_fk FOREIGN KEY (org_id, file_id)
    REFERENCES ludy_kernel.file (org_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS kyc_check_org_envelope_idx
  ON crove_sign.kyc_check (org_id, envelope_id);

CREATE INDEX IF NOT EXISTS kyc_check_org_status_idx
  ON crove_sign.kyc_check (org_id, status);

CREATE INDEX IF NOT EXISTS kyc_check_org_file_idx
  ON crove_sign.kyc_check (org_id, file_id);

CREATE OR REPLACE FUNCTION crove_sign.kyc_check_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  NEW.updated_at := pg_catalog.now();
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION crove_sign.kyc_check_touch_updated_at()
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;

DROP TRIGGER IF EXISTS kyc_check_touch_updated_at ON crove_sign.kyc_check;
CREATE TRIGGER kyc_check_touch_updated_at
  BEFORE UPDATE ON crove_sign.kyc_check
  FOR EACH ROW
  EXECUTE FUNCTION crove_sign.kyc_check_touch_updated_at();

-- Enforce that kyc_check.field_id belongs to kyc_check.envelope_id and has field_type = 'attachment'.
-- Runs as an AFTER constraint trigger so RLS WITH CHECK (42501) always precedes trigger checks for tenant roles.
CREATE OR REPLACE FUNCTION crove_sign.kyc_check_verify_field()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM crove_sign.field f
    WHERE f.org_id = NEW.org_id
      AND f.envelope_id = NEW.envelope_id
      AND f.id = NEW.field_id
      AND f.field_type = 'attachment'
  ) THEN
    RAISE EXCEPTION 'KYC_CHECK_FIELD_MISMATCH' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

REVOKE ALL ON FUNCTION crove_sign.kyc_check_verify_field()
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;

DROP TRIGGER IF EXISTS kyc_check_verify_field ON crove_sign.kyc_check;
CREATE CONSTRAINT TRIGGER kyc_check_verify_field
  AFTER INSERT OR UPDATE ON crove_sign.kyc_check
  FOR EACH ROW
  EXECUTE FUNCTION crove_sign.kyc_check_verify_field();

SELECT ludy_kernel.apply_tenant_rls('crove_sign.kyc_check');

-- Restrict mutations to owner, admin, member (or system/agent so agent_write_guard fires AGENT_FORBIDDEN while viewer stays read-only).
DROP POLICY IF EXISTS writer_insert ON crove_sign.kyc_check;
CREATE POLICY writer_insert ON crove_sign.kyc_check AS RESTRICTIVE FOR INSERT TO ludy_tenant
  WITH CHECK (
    (SELECT ludy_kernel.ctx_actor_type()) IN ('system', 'agent')
    OR EXISTS (
      SELECT 1 FROM ludy_kernel.tenant_member m
      WHERE m.org_id = kyc_check.org_id
        AND m.user_id = (SELECT ludy_kernel.ctx_user_id())
        AND m.role IN ('owner', 'admin', 'member')
    )
  );

DROP POLICY IF EXISTS writer_update ON crove_sign.kyc_check;
CREATE POLICY writer_update ON crove_sign.kyc_check AS RESTRICTIVE FOR UPDATE TO ludy_tenant
  USING (
    (SELECT ludy_kernel.ctx_actor_type()) IN ('system', 'agent')
    OR EXISTS (
      SELECT 1 FROM ludy_kernel.tenant_member m
      WHERE m.org_id = kyc_check.org_id
        AND m.user_id = (SELECT ludy_kernel.ctx_user_id())
        AND m.role IN ('owner', 'admin', 'member')
    )
  )
  WITH CHECK (
    (SELECT ludy_kernel.ctx_actor_type()) IN ('system', 'agent')
    OR EXISTS (
      SELECT 1 FROM ludy_kernel.tenant_member m
      WHERE m.org_id = kyc_check.org_id
        AND m.user_id = (SELECT ludy_kernel.ctx_user_id())
        AND m.role IN ('owner', 'admin', 'member')
    )
  );

DROP POLICY IF EXISTS writer_delete ON crove_sign.kyc_check;
CREATE POLICY writer_delete ON crove_sign.kyc_check AS RESTRICTIVE FOR DELETE TO ludy_tenant
  USING (
    (SELECT ludy_kernel.ctx_actor_type()) IN ('system', 'agent')
    OR EXISTS (
      SELECT 1 FROM ludy_kernel.tenant_member m
      WHERE m.org_id = kyc_check.org_id
        AND m.user_id = (SELECT ludy_kernel.ctx_user_id())
        AND m.role IN ('owner', 'admin', 'member')
    )
  );

-- Inherit all confidentiality policies on crove_sign.envelope and crove_sign.field (hr_contract, meeting_minutes, etc.)
-- and forbid pairing an envelope_id with another envelope's field_id or a non-attachment field.
DROP POLICY IF EXISTS hr_contract_envelope_access ON crove_sign.kyc_check;
CREATE POLICY hr_contract_envelope_access ON crove_sign.kyc_check AS RESTRICTIVE FOR ALL TO ludy_tenant
  USING (
    EXISTS (
      SELECT 1 FROM crove_sign.envelope e
      WHERE e.org_id = kyc_check.org_id AND e.id = kyc_check.envelope_id
    )
    AND EXISTS (
      SELECT 1 FROM crove_sign.field f
      WHERE f.org_id = kyc_check.org_id
        AND f.envelope_id = kyc_check.envelope_id
        AND f.id = kyc_check.field_id
        AND f.field_type = 'attachment'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM crove_sign.envelope e
      WHERE e.org_id = kyc_check.org_id AND e.id = kyc_check.envelope_id
    )
    AND EXISTS (
      SELECT 1 FROM crove_sign.field f
      WHERE f.org_id = kyc_check.org_id
        AND f.envelope_id = kyc_check.envelope_id
        AND f.id = kyc_check.field_id
        AND f.field_type = 'attachment'
    )
  );

-- Owner-only PDPL erasure helper (Law 91/2025/QH15, kernel.personal_data.erase): deletes every kyc_check row of the
-- caller's org whose findings_json quotes the requested email or digits, including rows on attendees-only meeting_minutes
-- envelopes that the owner cannot read directly, returning the deleted row count only.
CREATE OR REPLACE FUNCTION crove_sign.personal_data_erase_kyc_check(p_kind text, p_value text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_rows integer;
BEGIN
  IF v_org IS NULL
     OR ludy_kernel.ctx_actor_type() IS DISTINCT FROM 'user'
     OR ludy_kernel.ctx_agent_id() IS NOT NULL
     OR (ludy_kernel.ctx_verified() ->> 'role') IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'PERSONAL_DATA_OWNER_ONLY' USING ERRCODE = '42501';
  END IF;
  PERFORM ludy_kernel.text_mention_pattern(p_kind, p_value);
  DELETE FROM crove_sign.kyc_check k
   WHERE k.org_id = v_org
     AND ludy_kernel.text_mentions(k.findings_json::text, p_kind, p_value);
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END $$;

REVOKE ALL ON FUNCTION crove_sign.personal_data_erase_kyc_check(text, text)
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE 'ludy\_%' AND rolname <> current_user LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON FUNCTION crove_sign.personal_data_erase_kyc_check(text, text), crove_sign.kyc_check_touch_updated_at(), crove_sign.kyc_check_verify_field() FROM %I',
      r.rolname
    );
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION crove_sign.personal_data_erase_kyc_check(text, text) TO ludy_app;
