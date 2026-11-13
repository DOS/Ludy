-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove kernel conversations: an image whose bytes need the connection's token (issue #3131, plan docs/plan/conversations-channels.md section 4.1, WhatsApp).
-- Idempotent; applied files stay untouched.
--
-- Until now a customer's image reached the core as the platform's address (source_url) that the worker fetched through the egress guard. WhatsApp gives an
-- image as a media id: the address comes from a call made with the connection's token, lives five minutes, and must be fetched with the same token, so no
-- address can be stored for a later fetch and none that holds a token may ever be. The pending row now keeps, in a sibling column, a provider-scoped
-- reference (the media id) that is not a URL and holds no token. It is personal data like the address, and has the same life: kept only while pending,
-- cleared the moment the bytes are stored, deleted with the row at six days or after five failed tries (the id is downloadable for 7 days [O]), left out of
-- the export, never in a job (ids only), an event, an audit row or a log. The fetch job asks the provider's adapter to turn the reference into bytes with the
-- sealed credential, inside the job.
--   1. conversation_attachment.source_ref: new nullable column, a short token of characters that cannot be a URL or hold one (no slash, no query).
--   2. conversation_attachment_state: a pending row has at most one of source_url and source_ref (a mail's reserved row has neither); a stored row has neither.
--   3. UPDATE on source_ref is granted to the tenant role like source_url: the system context clears it when the bytes are stored.
--   4. conversation_attachment_due: hands out a pending row that has an address or a reference, and deletes one older than six days (an address or a
--      reference) or than an hour (a reserved row whose bytes never arrived), or tried five times.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_kernel.conversation_attachment ADD COLUMN IF NOT EXISTS source_ref text;

ALTER TABLE crove_kernel.conversation_attachment DROP CONSTRAINT IF EXISTS conversation_attachment_source_ref_check;
ALTER TABLE crove_kernel.conversation_attachment ADD CONSTRAINT conversation_attachment_source_ref_check CHECK (
  source_ref IS NULL OR (pg_catalog.length(source_ref) BETWEEN 1 AND 300 AND source_ref ~ '^[A-Za-z0-9._:=-]+$')) NOT VALID;
ALTER TABLE crove_kernel.conversation_attachment VALIDATE CONSTRAINT conversation_attachment_source_ref_check;

ALTER TABLE crove_kernel.conversation_attachment DROP CONSTRAINT IF EXISTS conversation_attachment_state;
ALTER TABLE crove_kernel.conversation_attachment ADD CONSTRAINT conversation_attachment_state CHECK (
  (state = 'pending' AND (source_url IS NULL OR source_ref IS NULL) AND stored_at IS NULL AND generation IS NULL AND sha256 IS NULL AND content_type IS NULL AND size_bytes IS NULL)
  OR (state = 'stored' AND source_url IS NULL AND source_ref IS NULL AND stored_at IS NOT NULL AND generation IS NOT NULL AND sha256 IS NOT NULL AND content_type IS NOT NULL AND size_bytes IS NOT NULL)) NOT VALID;
ALTER TABLE crove_kernel.conversation_attachment VALIDATE CONSTRAINT conversation_attachment_state;

GRANT UPDATE (source_ref) ON crove_kernel.conversation_attachment TO crove_tenant;

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
    AND (((a.source_url IS NOT NULL OR a.source_ref IS NOT NULL) AND a.created_at < pg_catalog.now() - pg_catalog.make_interval(days => 6))
         OR (a.source_url IS NULL AND a.source_ref IS NULL AND a.created_at < pg_catalog.now() - pg_catalog.make_interval(hours => 1))
         OR (a.fetch_attempts >= 5 AND a.requested_at < pg_catalog.now() - pg_catalog.make_interval(secs => GREATEST(p_retry_seconds, 1))));
  RETURN QUERY
  SELECT a.org_id, a.id, a.channel_connection_id
  FROM crove_kernel.conversation_attachment a
  JOIN crove_kernel.tenant t ON t.org_id = a.org_id AND t.status = 'active'
  JOIN crove_kernel.channel_connection c ON c.org_id = a.org_id AND c.id = a.channel_connection_id AND c.status = 'active'
  WHERE a.state = 'pending'
    AND (a.source_url IS NOT NULL OR a.source_ref IS NOT NULL)
    AND (a.requested_at IS NULL OR a.requested_at < pg_catalog.now() - pg_catalog.make_interval(secs => GREATEST(p_retry_seconds, 1)))
  ORDER BY a.created_at, a.id
  LIMIT LEAST(GREATEST(p_limit, 1), 1000);
END $$;

REVOKE ALL ON FUNCTION crove_kernel.conversation_attachment_due(integer, integer) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.conversation_attachment_due(integer, integer) TO crove_worker;
