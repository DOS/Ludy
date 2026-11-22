-- SPDX-License-Identifier: AGPL-3.0-only
-- Stage 5D HR recruiting (#4446): candidate acquisition source and hire timestamp
-- for deterministic recruiting funnel BI analytics and Engage invite attribution.

SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_hr.candidate
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'direct',
  ADD COLUMN IF NOT EXISTS hired_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'crove_hr.candidate'::regclass
      AND conname = 'candidate_source_check'
  ) THEN
    ALTER TABLE crove_hr.candidate
      ADD CONSTRAINT candidate_source_check
      CHECK (source IN ('direct', 'zalo_oa', 'facebook', 'referral', 'job_board', 'other'));
  END IF;
END
$$;

UPDATE crove_hr.candidate
SET hired_at = updated_at
WHERE hired_employee_id IS NOT NULL
  AND hired_at IS NULL;

CREATE INDEX IF NOT EXISTS candidate_analytics_idx
  ON crove_hr.candidate (org_id, legal_entity_id, stage, source, created_at)
  WHERE erased_at IS NULL;

GRANT UPDATE (source, hired_at)
  ON crove_hr.candidate TO ludy_tenant;

-- Dead-lettered pg-boss queue for worker-side CV parsing in crove-extract (gate T12).
SELECT ludy_jobs.create_queue('hr-cv-extract', '{"policy":"standard","deadLetter":"kernel-job.dlq"}'::jsonb);
