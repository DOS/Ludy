-- SPDX-License-Identifier: AGPL-3.0-only
-- A file source for the signed agreement of an e-invoice correction (#2504, plan einvoice-issue.md section 3b, the accountant's answer to #2506 question 2): when a business buyer is
-- sent an adjusting or replacing invoice, both sides first sign an agreement ("biên bản thỏa thuận") that the seller attaches to the correction as an evidence file. It is a document
-- of the org, never an accounting document: stored with source 'agreement' it is not read by extraction and not shown in the Inbox. Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_kernel.file DROP CONSTRAINT IF EXISTS file_source_check;
ALTER TABLE crove_kernel.file
  ADD CONSTRAINT file_source_check CHECK (source IN ('upload', 'email', 'social', 'import', 'meeting_audio', 'meeting_video', 'sign_document', 'sign_sealed', 'sign_certificate', 'agreement'));

-- The staged upload of such a file carries the same purpose.
ALTER TABLE crove_kernel.file_upload DROP CONSTRAINT IF EXISTS file_upload_purpose_check;
ALTER TABLE crove_kernel.file_upload
  ADD CONSTRAINT file_upload_purpose_check CHECK (purpose IN ('document', 'social', 'import', 'meeting_audio', 'meeting_video', 'sign_document', 'agreement'));
