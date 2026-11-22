-- SPDX-License-Identifier: AGPL-3.0-only
-- crove:concurrent-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_event_hr_cv_job_idx ON crove_kernel.audit_event (org_id, (detail ->> 'jobId'), id DESC) WHERE command IN ('hr.recruiting.cv_extract.request', 'hr.recruiting.cv_extract.complete') AND outcome = 'ok';
