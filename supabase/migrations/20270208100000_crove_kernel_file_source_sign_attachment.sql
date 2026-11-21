-- SPDX-License-Identifier: AGPL-3.0-only
-- Add 'sign_attachment' to crove_kernel.file source CHECK constraint for verified supporting documents
-- uploaded by signers during public eSign ceremonies (Slice 4b, #3818, ADR-0013).
-- Stored in the create-only file store and excluded from Finance OCR extraction and Inbox views.
-- Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_kernel.file DROP CONSTRAINT IF EXISTS file_source_check;
ALTER TABLE crove_kernel.file
  ADD CONSTRAINT file_source_check CHECK (
    source IN (
      'upload',
      'email',
      'social',
      'import',
      'meeting_audio',
      'meeting_video',
      'sign_document',
      'sign_sealed',
      'sign_certificate',
      'sign_attachment',
      'agreement'
    )
  );
