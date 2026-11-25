-- SPDX-License-Identifier: AGPL-3.0-only
-- Ludy HR Stage 5D follow-up (#4487): dedicated append-only candidate stage-entry transition history
-- so recruiting funnel BI accurately attributes rejected-from-later-stage and skipped-stage flows.
-- Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint con
    JOIN pg_catalog.pg_class rel ON rel.oid = con.conrelid
    JOIN pg_catalog.pg_namespace ns ON ns.oid = rel.relnamespace
    WHERE ns.nspname = 'ludy_hr'
      AND rel.relname = 'candidate'
      AND con.conname = 'candidate_entity_id_uq'
  ) THEN
    ALTER TABLE ludy_hr.candidate
      ADD CONSTRAINT candidate_entity_id_uq UNIQUE (org_id, legal_entity_id, id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS ludy_hr.candidate_stage_transition (
  org_id uuid NOT NULL REFERENCES ludy_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT ludy_kernel.uuid_v7(),
  seq bigint GENERATED ALWAYS AS IDENTITY,
  legal_entity_id uuid NOT NULL,
  candidate_id uuid NOT NULL,
  from_stage text CHECK (from_stage IS NULL OR from_stage IN ('applied', 'screening', 'interview', 'offer', 'hired', 'rejected')),
  to_stage text NOT NULL CHECK (to_stage IN ('applied', 'screening', 'interview', 'offer', 'hired', 'rejected')),
  occurred_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT candidate_stage_transition_entity_fk FOREIGN KEY (org_id, legal_entity_id) REFERENCES ludy_kernel.legal_entity (org_id, id),
  CONSTRAINT candidate_stage_transition_candidate_fk FOREIGN KEY (org_id, legal_entity_id, candidate_id) REFERENCES ludy_hr.candidate (org_id, legal_entity_id, id),
  CONSTRAINT candidate_stage_transition_distinct_ck CHECK (from_stage IS NULL OR from_stage <> to_stage)
);

CREATE INDEX IF NOT EXISTS candidate_stage_transition_cand_idx
  ON ludy_hr.candidate_stage_transition (org_id, legal_entity_id, candidate_id, occurred_at, seq);

CREATE INDEX IF NOT EXISTS candidate_stage_transition_stage_idx
  ON ludy_hr.candidate_stage_transition (org_id, legal_entity_id, to_stage, candidate_id);

CREATE OR REPLACE FUNCTION ludy_hr.candidate_stage_transition_legal_entity_fill() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_entity uuid;
BEGIN
  IF NEW.legal_entity_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  SELECT c.legal_entity_id INTO v_entity
    FROM ludy_hr.candidate c
   WHERE c.org_id = NEW.org_id AND c.id = NEW.candidate_id;
  NEW.legal_entity_id := v_entity;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ludy_hr.candidate_stage_transition_legal_entity_fill() FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;

DROP TRIGGER IF EXISTS b_legal_entity ON ludy_hr.candidate_stage_transition;
CREATE TRIGGER b_legal_entity
  BEFORE INSERT ON ludy_hr.candidate_stage_transition
  FOR EACH ROW EXECUTE FUNCTION ludy_hr.candidate_stage_transition_legal_entity_fill();
ALTER TABLE ludy_hr.candidate_stage_transition ENABLE ALWAYS TRIGGER b_legal_entity;

CREATE OR REPLACE FUNCTION ludy_hr.candidate_stage_transition_append_only() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_purger oid := (SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.oid = 'ludy_kernel.org_purge(integer)'::pg_catalog.regprocedure);
BEGIN
  IF TG_OP = 'DELETE'
     AND (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = CURRENT_USER) = v_purger
     AND pg_catalog.current_setting('ludy.org_purge', true) = OLD.org_id::text THEN
    IF pg_catalog.pg_has_role(SESSION_USER, 'ludy_worker', 'MEMBER')
       AND ludy_kernel.ctx_actor_type() = 'system'
       AND ludy_kernel.ctx_org_id() = OLD.org_id
       AND EXISTS (SELECT 1 FROM ludy_kernel.tenant t WHERE t.org_id = OLD.org_id AND t.status = 'offboarding') THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION 'table %.% is append-only', TG_TABLE_SCHEMA, TG_TABLE_NAME USING ERRCODE = '42501';
END $$;
REVOKE ALL ON FUNCTION ludy_hr.candidate_stage_transition_append_only() FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;

DROP TRIGGER IF EXISTS append_only_row ON ludy_hr.candidate_stage_transition;
CREATE TRIGGER append_only_row
  BEFORE UPDATE OR DELETE ON ludy_hr.candidate_stage_transition
  FOR EACH ROW EXECUTE FUNCTION ludy_hr.candidate_stage_transition_append_only();
ALTER TABLE ludy_hr.candidate_stage_transition ENABLE ALWAYS TRIGGER append_only_row;

DROP TRIGGER IF EXISTS append_only_truncate ON ludy_hr.candidate_stage_transition;
CREATE TRIGGER append_only_truncate
  BEFORE TRUNCATE ON ludy_hr.candidate_stage_transition
  FOR EACH STATEMENT EXECUTE FUNCTION ludy_kernel.reject_mutation();
ALTER TABLE ludy_hr.candidate_stage_transition ENABLE ALWAYS TRIGGER append_only_truncate;

SELECT ludy_kernel.apply_tenant_rls('ludy_hr.candidate_stage_transition');
REVOKE ALL ON TABLE ludy_hr.candidate_stage_transition FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT SELECT, INSERT ON TABLE ludy_hr.candidate_stage_transition TO ludy_tenant;

DROP POLICY IF EXISTS le_scope ON ludy_hr.candidate_stage_transition;
CREATE POLICY le_scope ON ludy_hr.candidate_stage_transition
  AS RESTRICTIVE FOR ALL TO ludy_tenant
  USING ('*' = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[]))
  WITH CHECK ('*' = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[]));

DROP POLICY IF EXISTS owner_admin ON ludy_hr.candidate_stage_transition;
CREATE POLICY owner_admin ON ludy_hr.candidate_stage_transition
  AS RESTRICTIVE FOR ALL TO ludy_tenant
  USING ((SELECT ludy_kernel.ctx_actor_type()) = 'user' AND EXISTS (SELECT 1 FROM ludy_kernel.tenant_member m WHERE m.org_id = candidate_stage_transition.org_id AND m.user_id = (SELECT ludy_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin')))
  WITH CHECK ((SELECT ludy_kernel.ctx_actor_type()) = 'user' AND EXISTS (SELECT 1 FROM ludy_kernel.tenant_member m WHERE m.org_id = candidate_stage_transition.org_id AND m.user_id = (SELECT ludy_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin')));

-- Backfill initial 'applied' and current non-applied stage rows for any existing candidates.
INSERT INTO ludy_hr.candidate_stage_transition (
  org_id,
  legal_entity_id,
  candidate_id,
  from_stage,
  to_stage,
  occurred_at,
  created_by,
  created_at
)
SELECT
  c.org_id,
  c.legal_entity_id,
  c.id,
  NULL,
  'applied',
  c.created_at,
  c.created_by,
  c.created_at
FROM ludy_hr.candidate c
WHERE NOT EXISTS (
  SELECT 1
  FROM ludy_hr.candidate_stage_transition t
  WHERE t.org_id = c.org_id AND t.candidate_id = c.id
)
ORDER BY c.created_at, c.id;

INSERT INTO ludy_hr.candidate_stage_transition (
  org_id,
  legal_entity_id,
  candidate_id,
  from_stage,
  to_stage,
  occurred_at,
  created_by,
  created_at
)
SELECT
  c.org_id,
  c.legal_entity_id,
  c.id,
  'applied',
  c.stage,
  GREATEST(
    c.created_at,
    COALESCE(CASE WHEN c.stage = 'hired' THEN c.hired_at END, c.updated_at, c.created_at)
  ),
  c.created_by,
  GREATEST(
    c.created_at,
    COALESCE(CASE WHEN c.stage = 'hired' THEN c.hired_at END, c.updated_at, c.created_at)
  )
FROM ludy_hr.candidate c
WHERE c.stage <> 'applied'
  AND NOT EXISTS (
    SELECT 1
    FROM ludy_hr.candidate_stage_transition t
    WHERE t.org_id = c.org_id AND t.candidate_id = c.id AND t.to_stage = c.stage
  )
ORDER BY c.created_at, c.id;
