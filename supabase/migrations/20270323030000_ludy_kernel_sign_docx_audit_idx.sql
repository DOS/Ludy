-- SPDX-License-Identifier: AGPL-3.0-only
-- crove:concurrent-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_event_sign_docx_job_idx ON ludy_kernel.audit_event (org_id, (detail ->> 'jobId'), id DESC) WHERE command IN ('sign.docx_convert.request', 'sign.docx_convert.complete') AND outcome = 'ok';
