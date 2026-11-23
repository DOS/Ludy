-- SPDX-License-Identifier: AGPL-3.0-only
-- eSign Slice 4e (#3821, docs/plan/esign.md, owner instruction 2026-11-19):
-- post-signature structured agreement terms, renewal notice windows, and milestone obligations per envelope,
-- with tainted AI proposal storage, NUMERIC(20,4) contract amounts, and restrictive envelope RLS inheritance.

SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_sign.envelope_obligation (
  org_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  envelope_id uuid NOT NULL,
  counterparty_name text CHECK (
    counterparty_name IS NULL OR (pg_catalog.length(pg_catalog.btrim(counterparty_name)) BETWEEN 1 AND 300)
  ),
  effective_date date,
  expiry_date date,
  renewal_notice_days integer CHECK (
    renewal_notice_days IS NULL OR (renewal_notice_days >= 0 AND renewal_notice_days <= 365)
  ),
  auto_renew boolean NOT NULL DEFAULT false,
  contract_value numeric(20, 4) CHECK (contract_value IS NULL OR contract_value >= 0),
  currency text NOT NULL DEFAULT 'VND' CHECK (currency ~ '^[A-Z]{3}$'),
  obligations_json jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (pg_catalog.jsonb_typeof(obligations_json) = 'array'),
  proposal_json jsonb CHECK (proposal_json IS NULL OR pg_catalog.jsonb_typeof(proposal_json) = 'object'),
  prompt_version text CHECK (
    prompt_version IS NULL OR (pg_catalog.length(pg_catalog.btrim(prompt_version)) BETWEEN 1 AND 32)
  ),
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'confirmed', 'dismissed')),
  confirmed_by uuid REFERENCES crove_kernel.user_account (id),
  confirmed_at timestamptz,
  created_by uuid REFERENCES crove_kernel.user_account (id),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT envelope_obligation_envelope_unique UNIQUE (org_id, envelope_id),
  CONSTRAINT envelope_obligation_envelope_fk FOREIGN KEY (org_id, envelope_id)
    REFERENCES crove_sign.envelope (org_id, id) ON DELETE CASCADE,
  CONSTRAINT envelope_obligation_date_order CHECK (
    effective_date IS NULL OR expiry_date IS NULL OR expiry_date >= effective_date
  )
);

CREATE INDEX IF NOT EXISTS envelope_obligation_org_status_expiry_idx
  ON crove_sign.envelope_obligation (org_id, status, expiry_date);

CREATE INDEX IF NOT EXISTS envelope_obligation_obligations_gin_idx
  ON crove_sign.envelope_obligation USING gin (obligations_json jsonb_path_ops);

CREATE OR REPLACE FUNCTION crove_sign.envelope_obligation_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  NEW.updated_at := pg_catalog.now();
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION crove_sign.envelope_obligation_touch_updated_at()
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

DROP TRIGGER IF EXISTS envelope_obligation_touch_updated_at ON crove_sign.envelope_obligation;
CREATE TRIGGER envelope_obligation_touch_updated_at
  BEFORE UPDATE ON crove_sign.envelope_obligation
  FOR EACH ROW
  EXECUTE FUNCTION crove_sign.envelope_obligation_touch_updated_at();

SELECT crove_kernel.apply_tenant_rls('crove_sign.envelope_obligation');

-- Restrict mutations to owner, admin, member (or system/agent so agent_write_guard fires AGENT_FORBIDDEN while viewer stays read-only).
DROP POLICY IF EXISTS writer_insert ON crove_sign.envelope_obligation;
CREATE POLICY writer_insert ON crove_sign.envelope_obligation AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK (
    (SELECT crove_kernel.ctx_actor_type()) IN ('system', 'agent')
    OR EXISTS (
      SELECT 1 FROM crove_kernel.tenant_member m
      WHERE m.org_id = envelope_obligation.org_id
        AND m.user_id = (SELECT crove_kernel.ctx_user_id())
        AND m.role IN ('owner', 'admin', 'member')
    )
  );

DROP POLICY IF EXISTS writer_update ON crove_sign.envelope_obligation;
CREATE POLICY writer_update ON crove_sign.envelope_obligation AS RESTRICTIVE FOR UPDATE TO crove_tenant
  USING (
    (SELECT crove_kernel.ctx_actor_type()) IN ('system', 'agent')
    OR EXISTS (
      SELECT 1 FROM crove_kernel.tenant_member m
      WHERE m.org_id = envelope_obligation.org_id
        AND m.user_id = (SELECT crove_kernel.ctx_user_id())
        AND m.role IN ('owner', 'admin', 'member')
    )
  )
  WITH CHECK (
    (SELECT crove_kernel.ctx_actor_type()) IN ('system', 'agent')
    OR EXISTS (
      SELECT 1 FROM crove_kernel.tenant_member m
      WHERE m.org_id = envelope_obligation.org_id
        AND m.user_id = (SELECT crove_kernel.ctx_user_id())
        AND m.role IN ('owner', 'admin', 'member')
    )
  );

DROP POLICY IF EXISTS writer_delete ON crove_sign.envelope_obligation;
CREATE POLICY writer_delete ON crove_sign.envelope_obligation AS RESTRICTIVE FOR DELETE TO crove_tenant
  USING (
    (SELECT crove_kernel.ctx_actor_type()) IN ('system', 'agent')
    OR EXISTS (
      SELECT 1 FROM crove_kernel.tenant_member m
      WHERE m.org_id = envelope_obligation.org_id
        AND m.user_id = (SELECT crove_kernel.ctx_user_id())
        AND m.role IN ('owner', 'admin', 'member')
    )
  );

-- Inherit all confidentiality policies on crove_sign.envelope (hr_contract, meeting_minutes, etc.) across all operations.
DROP POLICY IF EXISTS hr_contract_envelope_access ON crove_sign.envelope_obligation;
CREATE POLICY hr_contract_envelope_access ON crove_sign.envelope_obligation AS RESTRICTIVE FOR ALL TO crove_tenant
  USING (
    EXISTS (
      SELECT 1 FROM crove_sign.envelope e
      WHERE e.org_id = envelope_obligation.org_id AND e.id = envelope_obligation.envelope_id
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM crove_sign.envelope e
      WHERE e.org_id = envelope_obligation.org_id AND e.id = envelope_obligation.envelope_id
    )
  );
