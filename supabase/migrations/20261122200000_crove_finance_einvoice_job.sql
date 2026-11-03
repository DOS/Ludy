-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #2502, ADR-0044 points 4 and 5): the job that sends an approved draft to its provider, asks about it and stores what comes back. Idempotent; applied files
-- stay untouched.
--
-- The queue finance-einvoice-issue runs one draft: begin the call (finance.einvoice.job_begin writes the external_call row before anything is sent), send or ask the provider,
-- record the answer (finance.einvoice.job_record), and on `issued` store the signed XML as evidence and put it through the intake. The outbox event
-- finance.einvoice_issue_requested queues a draft the moment it is approved; the sweep below queues the ones whose time to ask has come.
-- crove_finance.einvoice_due(after_org, after_draft, limit): the drafts of active orgs that are `submitting` or `pending` and due, or `issued` with no signed XML stored yet, in key
-- order, for the worker's sweep, which pages through them all; the worker login's alone. A draft is due when its next check time has come, or when it has been `submitting` for a
-- minute with no check time (a job that never ran: the event was lost, or the worker was down); an issued one when its evidence is still to store.
SET LOCAL lock_timeout = '2s';

-- One job per draft at a time: the exclusive policy refuses a second job under the same singleton key while one is waiting, running or being retried (a standard queue
-- ignores the key, so the event and the sweep could both put a draft to the provider at once).
SELECT crove_jobs.create_queue('finance-einvoice-issue', '{"policy":"exclusive","deadLetter":"kernel-job.dlq"}'::jsonb);

CREATE OR REPLACE FUNCTION crove_finance.einvoice_due(p_after_org uuid, p_after_draft uuid, p_limit int)
RETURNS TABLE (org_id uuid, draft_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT d.org_id, d.id
  FROM crove_finance.einvoice_draft d
  JOIN crove_kernel.tenant t ON t.org_id = d.org_id AND t.status = 'active'
  WHERE ((d.state IN ('submitting', 'pending')
          AND ((d.next_check_at IS NOT NULL AND d.next_check_at <= pg_catalog.now())
               OR (d.next_check_at IS NULL AND d.state = 'submitting' AND d.submitted_at <= pg_catalog.now() - interval '1 minute')))
         OR (d.state = 'issued' AND d.signed_file_id IS NULL AND d.issued_at <= pg_catalog.now() - interval '10 seconds'))
    AND (p_after_org IS NULL OR (d.org_id, d.id) > (p_after_org, p_after_draft))
  ORDER BY d.org_id, d.id
  LIMIT LEAST(GREATEST(p_limit, 1), 1000)
$$;
REVOKE ALL ON FUNCTION crove_finance.einvoice_due(uuid, uuid, int) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_finance.einvoice_due(uuid, uuid, int) TO crove_worker;
