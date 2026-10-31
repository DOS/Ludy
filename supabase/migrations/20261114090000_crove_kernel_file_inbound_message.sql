-- SPDX-License-Identifier: AGPL-3.0-only
-- The mail a stored attachment came in (issue #2196, after #2191). Idempotent; applied files stay untouched.
--
-- crove_kernel.file.inbound_message_id  the mail (crove_kernel.inbound_message) whose attachment this file was when it
--                                       first arrived by email; null for an upload, for a file that arrived before this
--                                       column, and for a file whose mail is gone. Set once, when the row is inserted, by
--                                       the receive path (kernel.inbound.receive, a system command); a file stored again
--                                       with the same bytes keeps the link of its first arrival. It lets the Inbox tell a
--                                       member who sent a bank statement they are asked to import, from the mail's
--                                       from_address, which personal-data erasure clears with the mail.
-- crove_kernel.file_guard               as before, a file reference never changes; the link joins the columns that never
--                                       change, except that it goes to null (never to another mail) when its mail is
--                                       deleted, which is the foreign key's own action (the org purge deletes mails).
-- The key is (org_id, inbound_message_id) -> inbound_message (org_id, id), so a file can never name another org's mail.
-- ON DELETE SET NULL (inbound_message_id) clears only the link: org_id stays.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_kernel.file ADD COLUMN IF NOT EXISTS inbound_message_id uuid;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'crove_kernel.file'::regclass AND conname = 'file_inbound_message_fk') THEN
    -- NOT VALID: added without scanning the file table under its exclusive lock; validated below with a lighter one.
    ALTER TABLE crove_kernel.file ADD CONSTRAINT file_inbound_message_fk
      FOREIGN KEY (org_id, inbound_message_id) REFERENCES crove_kernel.inbound_message (org_id, id) ON DELETE SET NULL (inbound_message_id) NOT VALID;
  END IF;
END $$;
ALTER TABLE crove_kernel.file VALIDATE CONSTRAINT file_inbound_message_fk;
CREATE INDEX IF NOT EXISTS file_inbound_message_idx ON crove_kernel.file (org_id, inbound_message_id);

CREATE OR REPLACE FUNCTION crove_kernel.file_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (NEW.id, NEW.sha256, NEW.storage_key, NEW.generation, NEW.filename, NEW.content_type, NEW.size_bytes, NEW.source,
      NEW.created_by, NEW.created_at, NEW.duration_ms)
     IS DISTINCT FROM (OLD.id, OLD.sha256, OLD.storage_key, OLD.generation, OLD.filename, OLD.content_type, OLD.size_bytes,
      OLD.source, OLD.created_by, OLD.created_at, OLD.duration_ms) THEN
    RAISE EXCEPTION 'FILE_IMMUTABLE' USING ERRCODE = '42501', DETAIL = 'a file reference (key, generation, sha256) never changes';
  END IF;
  -- pg_trigger_depth() > 1: the update is the foreign key's own action (ON DELETE SET NULL), not a statement of a role.
  IF NEW.inbound_message_id IS DISTINCT FROM OLD.inbound_message_id
     AND NOT (NEW.inbound_message_id IS NULL AND pg_catalog.pg_trigger_depth() > 1) THEN
    RAISE EXCEPTION 'FILE_IMMUTABLE' USING ERRCODE = '42501', DETAIL = 'the mail a file came in is recorded once, and cleared only when the mail is deleted';
  END IF;
  IF (NEW.image_width, NEW.image_height) IS DISTINCT FROM (OLD.image_width, OLD.image_height)
     AND NOT (OLD.image_width IS NULL AND OLD.image_height IS NULL
              AND NEW.image_width IS NOT NULL AND NEW.image_height IS NOT NULL
              AND crove_kernel.ctx_actor_type() IS NOT DISTINCT FROM 'system') THEN
    RAISE EXCEPTION 'FILE_IMMUTABLE' USING ERRCODE = '42501', DETAIL = 'an image size is recorded once, by the system';
  END IF;
  IF (NEW.held_until, NEW.hold_attempted_at, NEW.hold_attempts, NEW.hold_error)
     IS DISTINCT FROM (OLD.held_until, OLD.hold_attempted_at, OLD.hold_attempts, OLD.hold_error)
     AND NOT (crove_kernel.ctx_actor_type() IS NOT DISTINCT FROM 'system'
              AND (OLD.held_until IS NULL OR coalesce(NEW.held_until >= OLD.held_until, false))) THEN
    RAISE EXCEPTION 'FILE_IMMUTABLE' USING ERRCODE = '42501', DETAIL = 'a retention hold is recorded by the system and never shortened';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.file_guard() FROM PUBLIC;
