-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove kernel: customer email as conversations in Hộp thư (issue #2439, docs/plan/conversations.md section 6.7). Idempotent; applied files stay untouched.
--
-- Email is a third kind of conversation, `email`, next to comment threads and private messages: a thread is the mails that name each other
-- in Message-ID, In-Reply-To and References, shown as chat bubbles; the stored body is text (HTML never reaches the database as markup).
--   1. The kind set of every table that carries it (the thread, its messages, attachments, drafts and the "is replying" marker) takes
--      'email'. The sets are replaced in place, validated afterwards so no table is locked for a scan.
--   2. conversation.subject: the line the sender wrote (personal data, classed pii in the manifest), shown in the thread header.
--   3. conversation_message.email_refs: the Message-IDs a mail names in In-Reply-To and References, ids and no text. A mail joins the
--      thread that holds any of them as external_message_id (the unique key of every channel), within one org and one channel.
--   4. conversation_access: an email thread is private like a direct message (mail to a business is private): owners and admins, and members
--      holding kernel.conversation.direct.read, within the channel limit. conversation_readers (the worker's notify list) already treats every
--      kind but a comment thread that way.
SET LOCAL lock_timeout = '2s';

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.conrelid::regclass AS tbl, c.conname
    FROM pg_catalog.pg_constraint c
    WHERE c.contype = 'c'
      AND c.conrelid IN (
        'crove_kernel.conversation'::regclass,
        'crove_kernel.conversation_message'::regclass,
        'crove_kernel.conversation_attachment'::regclass,
        'crove_kernel.conversation_draft'::regclass,
        'crove_kernel.conversation_composing'::regclass)
      AND pg_catalog.pg_get_constraintdef(c.oid) = 'CHECK ((kind = ANY (ARRAY[''comment_thread''::text, ''direct''::text])))'
  LOOP
    EXECUTE pg_catalog.format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
    EXECUTE pg_catalog.format('ALTER TABLE %s ADD CONSTRAINT %I CHECK (kind IN (''comment_thread'', ''direct'', ''email'')) NOT VALID', r.tbl, r.conname);
    EXECUTE pg_catalog.format('ALTER TABLE %s VALIDATE CONSTRAINT %I', r.tbl, r.conname);
  END LOOP;
END $$;

ALTER TABLE crove_kernel.conversation ADD COLUMN IF NOT EXISTS subject text;
ALTER TABLE crove_kernel.conversation DROP CONSTRAINT IF EXISTS conversation_subject_length;
ALTER TABLE crove_kernel.conversation ADD CONSTRAINT conversation_subject_length CHECK (subject IS NULL OR pg_catalog.length(subject) BETWEEN 1 AND 300);

ALTER TABLE crove_kernel.conversation_message ADD COLUMN IF NOT EXISTS email_refs text[] NOT NULL DEFAULT '{}';
ALTER TABLE crove_kernel.conversation_message DROP CONSTRAINT IF EXISTS conversation_message_email_refs_size;
ALTER TABLE crove_kernel.conversation_message ADD CONSTRAINT conversation_message_email_refs_size CHECK (pg_catalog.cardinality(email_refs) <= 50);

CREATE OR REPLACE FUNCTION crove_kernel.conversation_access(p_kind text, p_connection_id uuid, p_write boolean)
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE crove_kernel.ctx_actor_type()
    WHEN 'system' THEN true
    WHEN 'user' THEN COALESCE((
      SELECT CASE
        WHEN m.role IN ('owner', 'admin') THEN true
        WHEN p_write AND m.role = 'viewer' THEN false
        WHEN p_kind IN ('direct', 'email') AND NOT crove_kernel.ctx_has_permission('kernel.conversation.direct.read') THEN false
        WHEN p_kind NOT IN ('direct', 'comment_thread', 'email') THEN false
        ELSE NOT EXISTS (SELECT 1 FROM crove_kernel.channel_access a WHERE a.org_id = m.org_id AND a.user_id = m.user_id)
          OR EXISTS (SELECT 1 FROM crove_kernel.channel_access a
                     WHERE a.org_id = m.org_id AND a.user_id = m.user_id AND a.channel_connection_id = p_connection_id)
      END
      FROM crove_kernel.tenant_member m
      WHERE m.org_id = crove_kernel.ctx_org_id() AND m.user_id = crove_kernel.ctx_user_id()), false)
    ELSE false
  END
$$;
REVOKE ALL ON FUNCTION crove_kernel.conversation_access(text, uuid, boolean) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.conversation_access(text, uuid, boolean) TO crove_tenant;

-- Erasing or purging an email thread also drops the subject and the text of the replies sent on it (the guard lets a column only be nulled).
GRANT UPDATE (subject, payload) ON crove_kernel.mail_message TO crove_tenant;
