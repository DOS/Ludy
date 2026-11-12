-- SPDX-License-Identifier: AGPL-3.0-only
-- ADR-0049 decision 1, amended 2026-11-12 (#3029, owner decision of the same day): a member's Vy may have one live run PER FEATURE, so another use of Vy no longer cancels a transcription
-- that is still running. The org-chart agents keep one running run per agent (ADR-0029 section 5). Idempotent; applied files stay untouched.
--   ai_run.feature                  the feature a member_vy run is for ('notes.summary', 'meetings.transcribe', ...), NULL for an org-chart agent's run. Same format as member_vy_result.feature.
--                                   The module cannot key the rule: meetings.transcribe and meetings.summary share the module 'meetings', and so do the two notes features.
--   ai_run_one_running_agent_uq     (org_id, agent_id) WHERE running AND feature IS NULL: the old rule, kept for the org-chart agents (and as the safe fallback for a run with no feature).
--   ai_run_one_running_feature_uq   (org_id, agent_id, feature) WHERE running AND feature IS NOT NULL: one running run of a member's Vy per feature. A race between two starts of one
--                                   feature fails on this index (23505), which kernel.member_vy.run.start turns into VY_RUN_BUSY.
--   ai_run_one_running_uq           dropped, after the two above exist, so there is no moment without a rule. ai_run is not one of the hot tables, so a plain CREATE INDEX is right.
--   ai_run_member_vy_bind           restated from 20261211070000 with two more rules: a member_vy run needs a non-null feature at insert, an org-chart agent's run has none, and the feature never
--                                   changes (the trigger now also fires OF feature). Without it a member could blank or change the feature of their own run and so get around the rule.
--   member_vy_result_bind           restated from 20261128140000: the result's feature must equal its run's feature (so the run's feature is the result's, and the two cannot drift).
-- The 4-hour bound of a run and the audit-id binding are per run and stay as they were.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_kernel.ai_run ADD COLUMN IF NOT EXISTS feature text;

DO $chk$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'crove_kernel.ai_run'::pg_catalog.regclass AND conname = 'ai_run_feature_format') THEN
    ALTER TABLE crove_kernel.ai_run
      ADD CONSTRAINT ai_run_feature_format CHECK (feature IS NULL OR feature ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$') NOT VALID;
  END IF;
END
$chk$;
ALTER TABLE crove_kernel.ai_run VALIDATE CONSTRAINT ai_run_feature_format;

-- The runs that exist take the feature of their result row (one result row per run). A run whose result was already purged keeps NULL: it is finished, or a lapsed run that
-- only the safe fallback index below still covers. This runs before the bind trigger is restated, so the trigger does not see it.
UPDATE crove_kernel.ai_run r SET feature = v.feature
FROM crove_kernel.member_vy_result v
WHERE v.org_id = r.org_id AND v.run_id = r.id AND r.feature IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ai_run_one_running_agent_uq ON crove_kernel.ai_run (org_id, agent_id) WHERE status = 'running' AND feature IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ai_run_one_running_feature_uq ON crove_kernel.ai_run (org_id, agent_id, feature) WHERE status = 'running' AND feature IS NOT NULL;
DROP INDEX IF EXISTS crove_kernel.ai_run_one_running_uq;

CREATE OR REPLACE FUNCTION crove_kernel.ai_run_member_vy_bind() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_member uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- The agent and the feature of a run never change.
    IF NEW.agent_id IS DISTINCT FROM OLD.agent_id OR NEW.feature IS DISTINCT FROM OLD.feature THEN
      RAISE EXCEPTION 'MEMBER_VY_RUN_BINDING' USING ERRCODE = '42501';
    END IF;
    -- A member_vy run keeps the 4-hour bound counted from its ORIGINAL start: the start never moves, and the expiry never goes past it plus 4
    -- hours (moving both timestamps forward would otherwise stretch the run).
    IF (NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.started_at IS DISTINCT FROM OLD.started_at)
       AND EXISTS (SELECT 1 FROM crove_kernel.agent a WHERE a.org_id = NEW.org_id AND a.id = NEW.agent_id AND a.kind = 'member_vy')
       AND (NEW.started_at IS DISTINCT FROM OLD.started_at OR NEW.expires_at > OLD.started_at + interval '4 hours') THEN
      RAISE EXCEPTION 'MEMBER_VY_RUN_EXPIRY' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT a.member_user_id INTO v_member FROM crove_kernel.agent a
  WHERE a.org_id = NEW.org_id AND a.id = NEW.agent_id AND a.kind = 'member_vy';
  IF v_member IS NOT NULL THEN
    IF crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' OR crove_kernel.ctx_org_id() IS DISTINCT FROM NEW.org_id
       OR v_member IS DISTINCT FROM crove_kernel.ctx_user_id() THEN
      RAISE EXCEPTION 'MEMBER_VY_RUN_BINDING' USING ERRCODE = '42501';
    END IF;
    IF NEW.expires_at > NEW.started_at + interval '4 hours' THEN
      RAISE EXCEPTION 'MEMBER_VY_RUN_EXPIRY' USING ERRCODE = '23514';
    END IF;
    -- A run of a member's Vy is for one feature: the rule of one running run per feature needs it.
    IF NEW.feature IS NULL THEN
      RAISE EXCEPTION 'MEMBER_VY_RUN_FEATURE' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.feature IS NOT NULL THEN
    -- An org-chart agent's run has no feature: it keeps one running run per agent.
    RAISE EXCEPTION 'MEMBER_VY_RUN_FEATURE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.ai_run_member_vy_bind() FROM PUBLIC;

DROP TRIGGER IF EXISTS member_vy_bind ON crove_kernel.ai_run;
CREATE TRIGGER member_vy_bind BEFORE INSERT OR UPDATE OF agent_id, feature, started_at, expires_at ON crove_kernel.ai_run
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.ai_run_member_vy_bind();

CREATE OR REPLACE FUNCTION crove_kernel.member_vy_result_bind() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM crove_kernel.ai_run r
    JOIN crove_kernel.agent a ON a.org_id = r.org_id AND a.id = r.agent_id
    WHERE r.org_id = NEW.org_id AND r.id = NEW.run_id AND a.kind = 'member_vy' AND a.member_user_id = NEW.member_user_id AND r.feature = NEW.feature) THEN
    -- Worded as the row-level refusal it is (a result is the member's alone, and belongs to its own run and feature), with the reason in the hint.
    RAISE EXCEPTION 'new row violates row-level security policy for table "member_vy_result"' USING ERRCODE = '42501', HINT = 'MEMBER_VY_RESULT_RUN_MISMATCH';
  END IF;
  IF NEW.created_at > pg_catalog.now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'MEMBER_VY_RESULT_CREATED_IN_FUTURE' USING ERRCODE = '23514';
  END IF;
  IF NEW.expires_at > LEAST(NEW.created_at, pg_catalog.now()) + interval '31 days' THEN
    RAISE EXCEPTION 'MEMBER_VY_RESULT_EXPIRY_TOO_LONG' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.member_vy_result_bind() FROM PUBLIC;
DROP TRIGGER IF EXISTS member_vy_result_bind ON crove_kernel.member_vy_result;
CREATE TRIGGER member_vy_result_bind BEFORE INSERT OR UPDATE OF member_user_id, run_id, feature, created_at, expires_at ON crove_kernel.member_vy_result
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.member_vy_result_bind();
