-- SPDX-License-Identifier: AGPL-3.0-only
-- eSign Slice 5d (#4442, docs/plan/esign.md):
-- SME contract playbook checklist rules (crove_sign.playbook_rule) and per-envelope playbook evaluation
-- findings (crove_sign.playbook_check) with cited redline suggestions, deterministic AI-off evaluation,
-- manual override support, and restrictive envelope confidentiality inheritance (hr_contract + meeting_minutes).

SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. Bounded keyword array validator for playbook_rule.match_keywords
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION crove_sign.is_valid_playbook_keywords(p_keywords text[])
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_len integer;
  v_valid_count integer;
BEGIN
  IF p_keywords IS NULL THEN
    RETURN false;
  END IF;

  IF pg_catalog.array_ndims(p_keywords) IS NULL THEN
    RETURN true;
  END IF;

  IF pg_catalog.array_ndims(p_keywords) <> 1 THEN
    RETURN false;
  END IF;

  v_len := pg_catalog.cardinality(p_keywords);
  IF v_len > 25 THEN
    RETURN false;
  END IF;

  SELECT pg_catalog.count(*) FILTER (
    WHERE kw IS NOT NULL
      AND pg_catalog.length(kw) BETWEEN 1 AND 120
      AND kw = pg_catalog.btrim(kw)
      AND kw !~ '[[:cntrl:]]'
  )::integer
  INTO v_valid_count
  FROM pg_catalog.unnest(p_keywords) AS kw;

  RETURN v_valid_count = v_len;
END $$;

REVOKE ALL ON FUNCTION crove_sign.is_valid_playbook_keywords(text[])
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_sign.is_valid_playbook_keywords(text[])
  TO ludy_tenant, ludy_app, ludy_worker;

-- ---------------------------------------------------------------------------
-- 2. Org-editable SME contract playbook checklist rules (owner/admin write, READERS select)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS crove_sign.playbook_rule (
  org_id uuid NOT NULL REFERENCES ludy_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT ludy_kernel.uuid_v7(),
  title text NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(title)) BETWEEN 1 AND 200),
  guidance text NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(guidance)) BETWEEN 1 AND 2000),
  severity text NOT NULL DEFAULT 'warn' CHECK (severity IN ('info', 'warn', 'critical')),
  match_keywords text[] NOT NULL DEFAULT ARRAY[]::text[] CHECK (crove_sign.is_valid_playbook_keywords(match_keywords)),
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES ludy_kernel.user_account (id),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id)
);

CREATE INDEX IF NOT EXISTS playbook_rule_org_active_created_idx
  ON crove_sign.playbook_rule (org_id, active, created_at ASC, id ASC);

CREATE INDEX IF NOT EXISTS playbook_rule_created_by_idx
  ON crove_sign.playbook_rule (created_by)
  WHERE created_by IS NOT NULL;

CREATE OR REPLACE FUNCTION crove_sign.playbook_rule_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  NEW.updated_at := pg_catalog.now();
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION crove_sign.playbook_rule_touch_updated_at()
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;

DROP TRIGGER IF EXISTS playbook_rule_touch_updated_at ON crove_sign.playbook_rule;
CREATE TRIGGER playbook_rule_touch_updated_at
  BEFORE UPDATE ON crove_sign.playbook_rule
  FOR EACH ROW
  EXECUTE FUNCTION crove_sign.playbook_rule_touch_updated_at();

SELECT ludy_kernel.apply_tenant_rls('crove_sign.playbook_rule');

-- Restrict rule mutations to owner and admin (or system/agent so agent_write_guard fires AGENT_FORBIDDEN while members/viewers read org rules).
DROP POLICY IF EXISTS writer_insert ON crove_sign.playbook_rule;
CREATE POLICY writer_insert ON crove_sign.playbook_rule AS RESTRICTIVE FOR INSERT TO ludy_tenant
  WITH CHECK (
    (SELECT ludy_kernel.ctx_actor_type()) IN ('system', 'agent')
    OR EXISTS (
      SELECT 1 FROM ludy_kernel.tenant_member m
      WHERE m.org_id = playbook_rule.org_id
        AND m.user_id = (SELECT ludy_kernel.ctx_user_id())
        AND m.role IN ('owner', 'admin')
    )
  );

DROP POLICY IF EXISTS writer_update ON crove_sign.playbook_rule;
CREATE POLICY writer_update ON crove_sign.playbook_rule AS RESTRICTIVE FOR UPDATE TO ludy_tenant
  USING (
    (SELECT ludy_kernel.ctx_actor_type()) IN ('system', 'agent')
    OR EXISTS (
      SELECT 1 FROM ludy_kernel.tenant_member m
      WHERE m.org_id = playbook_rule.org_id
        AND m.user_id = (SELECT ludy_kernel.ctx_user_id())
        AND m.role IN ('owner', 'admin')
    )
  )
  WITH CHECK (
    (SELECT ludy_kernel.ctx_actor_type()) IN ('system', 'agent')
    OR EXISTS (
      SELECT 1 FROM ludy_kernel.tenant_member m
      WHERE m.org_id = playbook_rule.org_id
        AND m.user_id = (SELECT ludy_kernel.ctx_user_id())
        AND m.role IN ('owner', 'admin')
    )
  );

DROP POLICY IF EXISTS writer_delete ON crove_sign.playbook_rule;
CREATE POLICY writer_delete ON crove_sign.playbook_rule AS RESTRICTIVE FOR DELETE TO ludy_tenant
  USING (
    (SELECT ludy_kernel.ctx_actor_type()) IN ('system', 'agent')
    OR EXISTS (
      SELECT 1 FROM ludy_kernel.tenant_member m
      WHERE m.org_id = playbook_rule.org_id
        AND m.user_id = (SELECT ludy_kernel.ctx_user_id())
        AND m.role IN ('owner', 'admin')
    )
  );

-- ---------------------------------------------------------------------------
-- 3. Per-envelope playbook evaluation findings (inherits crove_sign.envelope confidentiality)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS crove_sign.playbook_check (
  org_id uuid NOT NULL REFERENCES ludy_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT ludy_kernel.uuid_v7(),
  envelope_id uuid NOT NULL,
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  mode text NOT NULL DEFAULT 'deterministic' CHECK (mode IN ('ai', 'deterministic', 'manual')),
  findings_json jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (pg_catalog.jsonb_typeof(findings_json) = 'array'),
  prompt_version text CHECK (
    prompt_version IS NULL OR (pg_catalog.length(pg_catalog.btrim(prompt_version)) BETWEEN 1 AND 32)
  ),
  created_by uuid REFERENCES ludy_kernel.user_account (id),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT playbook_check_envelope_unique UNIQUE (org_id, envelope_id),
  CONSTRAINT playbook_check_envelope_fk FOREIGN KEY (org_id, envelope_id)
    REFERENCES crove_sign.envelope (org_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS playbook_check_created_by_idx
  ON crove_sign.playbook_check (created_by)
  WHERE created_by IS NOT NULL;

CREATE OR REPLACE FUNCTION crove_sign.playbook_check_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  NEW.updated_at := pg_catalog.now();
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION crove_sign.playbook_check_touch_updated_at()
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;

DROP TRIGGER IF EXISTS playbook_check_touch_updated_at ON crove_sign.playbook_check;
CREATE TRIGGER playbook_check_touch_updated_at
  BEFORE UPDATE ON crove_sign.playbook_check
  FOR EACH ROW
  EXECUTE FUNCTION crove_sign.playbook_check_touch_updated_at();

SELECT ludy_kernel.apply_tenant_rls('crove_sign.playbook_check');

-- Restrict mutations to owner, admin, member (or system/agent so agent_write_guard fires AGENT_FORBIDDEN while viewer stays read-only).
DROP POLICY IF EXISTS writer_insert ON crove_sign.playbook_check;
CREATE POLICY writer_insert ON crove_sign.playbook_check AS RESTRICTIVE FOR INSERT TO ludy_tenant
  WITH CHECK (
    (SELECT ludy_kernel.ctx_actor_type()) IN ('system', 'agent')
    OR EXISTS (
      SELECT 1 FROM ludy_kernel.tenant_member m
      WHERE m.org_id = playbook_check.org_id
        AND m.user_id = (SELECT ludy_kernel.ctx_user_id())
        AND m.role IN ('owner', 'admin', 'member')
    )
  );

DROP POLICY IF EXISTS writer_update ON crove_sign.playbook_check;
CREATE POLICY writer_update ON crove_sign.playbook_check AS RESTRICTIVE FOR UPDATE TO ludy_tenant
  USING (
    (SELECT ludy_kernel.ctx_actor_type()) IN ('system', 'agent')
    OR EXISTS (
      SELECT 1 FROM ludy_kernel.tenant_member m
      WHERE m.org_id = playbook_check.org_id
        AND m.user_id = (SELECT ludy_kernel.ctx_user_id())
        AND m.role IN ('owner', 'admin', 'member')
    )
  )
  WITH CHECK (
    (SELECT ludy_kernel.ctx_actor_type()) IN ('system', 'agent')
    OR EXISTS (
      SELECT 1 FROM ludy_kernel.tenant_member m
      WHERE m.org_id = playbook_check.org_id
        AND m.user_id = (SELECT ludy_kernel.ctx_user_id())
        AND m.role IN ('owner', 'admin', 'member')
    )
  );

DROP POLICY IF EXISTS writer_delete ON crove_sign.playbook_check;
CREATE POLICY writer_delete ON crove_sign.playbook_check AS RESTRICTIVE FOR DELETE TO ludy_tenant
  USING (
    (SELECT ludy_kernel.ctx_actor_type()) IN ('system', 'agent')
    OR EXISTS (
      SELECT 1 FROM ludy_kernel.tenant_member m
      WHERE m.org_id = playbook_check.org_id
        AND m.user_id = (SELECT ludy_kernel.ctx_user_id())
        AND m.role IN ('owner', 'admin', 'member')
    )
  );

-- Inherit all confidentiality policies on crove_sign.envelope (hr_contract, ADR-0047 meeting_minutes, etc.) across all operations.
DROP POLICY IF EXISTS hr_contract_envelope_access ON crove_sign.playbook_check;
CREATE POLICY hr_contract_envelope_access ON crove_sign.playbook_check AS RESTRICTIVE FOR ALL TO ludy_tenant
  USING (
    EXISTS (
      SELECT 1 FROM crove_sign.envelope e
      WHERE e.org_id = playbook_check.org_id AND e.id = playbook_check.envelope_id
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM crove_sign.envelope e
      WHERE e.org_id = playbook_check.org_id AND e.id = playbook_check.envelope_id
    )
  );
