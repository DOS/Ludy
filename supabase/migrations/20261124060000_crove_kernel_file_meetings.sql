-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove kernel: support meeting audio and video file sources and staged upload limit (#2576).
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_kernel.file DROP CONSTRAINT IF EXISTS file_source_check;
ALTER TABLE crove_kernel.file ADD CONSTRAINT file_source_check CHECK (source IN ('upload', 'email', 'social', 'import', 'meeting_audio', 'meeting_video'));

ALTER TABLE crove_kernel.file_upload DROP CONSTRAINT IF EXISTS file_upload_max_bytes;
ALTER TABLE crove_kernel.file_upload ADD CONSTRAINT file_upload_max_bytes CHECK (max_bytes BETWEEN 1 AND 2147483648);

ALTER TABLE crove_kernel.file_upload ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'document' CHECK (purpose IN ('document', 'social', 'import', 'meeting_audio', 'meeting_video'));
