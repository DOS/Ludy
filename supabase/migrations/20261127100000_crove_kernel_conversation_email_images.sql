-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove kernel conversations: images from customer email (issue #2758, docs/plan/conversations.md section 6.7, follow-up of #2439).
-- Idempotent; applied files stay untouched.
--
-- A mail's image bytes are in the worker's hands when the mail is parsed, so nothing is fetched from an address. The store's rule stays
-- "the row is made first and the blob written after": the intake reserves a pending conversation_attachment row WITHOUT a source address,
-- the worker writes the bytes under the row's reserved key and records them (attachment_record, unchanged), so a row always names its
-- blob and no blob is written that no row names.
--   1. conversation_attachment_state: a pending row may have no source_url (a stored row still never has one).
--   2. conversation_attachment_due: it hands out only pending rows WITH an address (a mail's reserved row is never fetched), and it drops
--      a reserved row whose bytes never arrived (the worker died between the intake and the write) after an hour; the delete trigger
--      queues its blob key as for every deleted row.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_kernel.conversation_attachment DROP CONSTRAINT IF EXISTS conversation_attachment_state;
ALTER TABLE crove_kernel.conversation_attachment ADD CONSTRAINT conversation_attachment_state CHECK (
  (state = 'pending' AND stored_at IS NULL AND generation IS NULL AND sha256 IS NULL AND content_type IS NULL AND size_bytes IS NULL)
  OR (state = 'stored' AND source_url IS NULL AND stored_at IS NOT NULL AND generation IS NOT NULL AND sha256 IS NOT NULL AND content_type IS NOT NULL AND size_bytes IS NOT NULL)) NOT VALID;
ALTER TABLE crove_kernel.conversation_attachment VALIDATE CONSTRAINT conversation_attachment_state;

CREATE OR REPLACE FUNCTION crove_kernel.conversation_attachment_due(p_limit integer, p_retry_seconds integer)
RETURNS TABLE (org_id uuid, attachment_id uuid, connection_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'CONVERSATION_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  DELETE FROM crove_kernel.conversation_attachment a
  WHERE a.state = 'pending'
    AND ((a.source_url IS NOT NULL AND a.created_at < pg_catalog.now() - pg_catalog.make_interval(days => 6))
         OR (a.source_url IS NULL AND a.created_at < pg_catalog.now() - pg_catalog.make_interval(hours => 1))
         OR (a.fetch_attempts >= 5 AND a.requested_at < pg_catalog.now() - pg_catalog.make_interval(secs => GREATEST(p_retry_seconds, 1))));
  RETURN QUERY
  SELECT a.org_id, a.id, a.channel_connection_id
  FROM crove_kernel.conversation_attachment a
  JOIN crove_kernel.tenant t ON t.org_id = a.org_id AND t.status = 'active'
  JOIN crove_kernel.channel_connection c ON c.org_id = a.org_id AND c.id = a.channel_connection_id AND c.status = 'active'
  WHERE a.state = 'pending'
    AND a.source_url IS NOT NULL
    AND (a.requested_at IS NULL OR a.requested_at < pg_catalog.now() - pg_catalog.make_interval(secs => GREATEST(p_retry_seconds, 1)))
  ORDER BY a.created_at, a.id
  LIMIT LEAST(GREATEST(p_limit, 1), 1000);
END $$;

REVOKE ALL ON FUNCTION crove_kernel.conversation_attachment_due(integer, integer) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.conversation_attachment_due(integer, integer) TO crove_worker;
