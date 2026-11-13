-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #2519, ADR-0045 point 7): the job that pulls a marketplace connection's orders. Idempotent; applied files stay untouched.
--
-- The queue finance-marketplace-poll runs one connection: open the credential, ask the provider for the orders since the connection's cursor, write them as a CSV in the layout of the
-- platform's own report and ingest it as a file (kernel.file.ingest), then record the cursor and the state (finance.marketplace_connection.record_poll). The outbox event
-- finance.marketplace_poll_requested queues a connection the moment an owner or admin asks; the sweep queues every active one. The poll never confirms: the file is read, staged and
-- decided by a member exactly as an uploaded one.
-- crove_finance.marketplace_poll_due(after_org, after_id, limit): the marketplace connections of active orgs whose channel connection is active, in key order, for the worker's sweep,
-- which pages through them all; the worker login's alone.
SET LOCAL lock_timeout = '2s';

-- One job per connection at a time: the exclusive policy refuses a second job under the same singleton key while one is waiting, running or being retried.
SELECT crove_jobs.create_queue('finance-marketplace-poll', '{"policy":"exclusive","deadLetter":"kernel-job.dlq"}'::jsonb);

CREATE OR REPLACE FUNCTION crove_finance.marketplace_poll_due(p_after_org uuid, p_after_id uuid, p_limit int)
RETURNS TABLE (org_id uuid, id uuid, provider text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT m.org_id, m.id, m.provider
  FROM crove_finance.marketplace_connection m
  JOIN crove_kernel.channel_connection c ON c.org_id = m.org_id AND c.id = m.channel_connection_id AND c.status = 'active'
  JOIN crove_kernel.tenant t ON t.org_id = m.org_id AND t.status = 'active'
  WHERE (p_after_org IS NULL OR (m.org_id, m.id) > (p_after_org, p_after_id))
  ORDER BY m.org_id, m.id
  LIMIT LEAST(GREATEST(p_limit, 1), 1000)
$$;
REVOKE ALL ON FUNCTION crove_finance.marketplace_poll_due(uuid, uuid, int) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_finance.marketplace_poll_due(uuid, uuid, int) TO crove_worker;
