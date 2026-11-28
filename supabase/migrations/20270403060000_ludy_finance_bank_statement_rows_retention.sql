-- SPDX-License-Identifier: AGPL-3.0-only
-- Retention of the parsed rows of a decided bank statement (#2195, the pattern of #2516 step C-2b3 and ADR-0045 point 8, without its original-file step). A bank statement a member read in
-- the Inbox is first staged: the extraction run keeps its parsed rows (counterparty names, descriptions, amounts, the other side's account numbers) so the member can look at them before
-- deciding. A decision (finance.bank.statement_confirm or statement_reject, through kernel.extraction.statement_state) does not edit that run: it inserts a NEW, finished version of the file
-- whose result is the summary only (file name, the org's own account number, counts, totals, the import id). The staged versions stay older than it, still holding the rows.
-- This migration deletes those OLDER versions 90 days after the decision. extraction_guard is untouched: a finished version still never changes, and a tenant role still has no DELETE on
-- extraction; only the worker-only definers below delete, as the marketplace retention does.
--
--   1. ludy_finance.bank_statement_rows_due(days, limit)          worker only: the decided statements whose staged rows are older than `days` (never fewer than 90).
--   2. ludy_finance.bank_statement_rows_apply(org, file, days)    system context of the same org: deletes the older bank_statement versions of one file, after the same checks again
--                                                                 under the file row's lock; the decision version, the file row, its original bytes and the audit rows stay.
-- Only kind bank_statement is reachable (a marketplace report or an invoice file is never listed or touched), only a file whose NEWEST version is a decided summary (imported or rejected;
-- a statement still staged is kept whatever its age, and a re-read that staged it again makes it undue), never a file under an evidence hold (held_until), and only an org whose tenant is
-- active or offboarding and whose finance app is on (an org that switched finance off waits; the sweep catches up when it is turned on again, and an offboarding purge removes everything anyway).
-- A file is listed only while an older bank_statement version exists, so a second run finds nothing to do. The lines already booked (finance.bank_line) are not touched.
SET LOCAL lock_timeout = '2s';

-- The decided statements whose rows are due, oldest decision first. Ids only; the worker runs the rest in each file's own org.
CREATE OR REPLACE FUNCTION ludy_finance.bank_statement_rows_due(p_days integer, p_limit integer)
RETURNS TABLE (org_id uuid, file_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (NOT pg_catalog.pg_has_role(SESSION_USER, 'ludy_worker', 'MEMBER')) OR ludy_kernel.ctx_actor_type() IS NOT NULL THEN
    RAISE EXCEPTION 'BANK_STATEMENT_ROWS_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF p_days IS NULL OR p_days < 90 THEN
    RAISE EXCEPTION 'BANK_STATEMENT_ROWS_TOO_SHORT' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT x.org_id, x.file_id
  FROM ludy_kernel.extraction x
  JOIN ludy_kernel.file f ON f.org_id = x.org_id AND f.id = x.file_id
  JOIN ludy_kernel.tenant t ON t.org_id = x.org_id AND t.status IN ('active', 'offboarding')
  WHERE x.method = 'unsupported' AND x.status = 'done'
    AND (x.result ->> 'kind') = 'bank_statement'
    AND (x.result -> 'summary' ->> 'state') IN ('imported', 'rejected')
    AND x.completed_at < pg_catalog.now() - pg_catalog.make_interval(days => p_days)
    AND f.held_until IS NULL
    AND ludy_kernel.org_app_on(x.org_id, 'finance')
    AND NOT EXISTS (SELECT 1 FROM ludy_kernel.extraction n WHERE n.org_id = x.org_id AND n.file_id = x.file_id AND n.version > x.version)
    AND EXISTS (SELECT 1 FROM ludy_kernel.extraction o WHERE o.org_id = x.org_id AND o.file_id = x.file_id AND o.version < x.version AND (o.result ->> 'kind') = 'bank_statement')
  ORDER BY x.completed_at, x.file_id
  LIMIT LEAST(GREATEST(p_limit, 1), 1000);
END;
$$;
REVOKE ALL ON FUNCTION ludy_finance.bank_statement_rows_due(integer, integer) FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION ludy_finance.bank_statement_rows_due(integer, integer) TO ludy_worker;

-- Deletes the staged versions of one due statement. It checks the same conditions as the list again under the file row's lock (kernel.extraction.statement_state and a re-read lock the same row,
-- so a decision and this cannot interleave), so it can neither run early, nor touch another kind, a statement still staged, or a file under hold. applied is false when the file is not (or no
-- longer) due; versions counts the extraction versions deleted. Inside the system command finance.bank.statement_rows_purge.
CREATE OR REPLACE FUNCTION ludy_finance.bank_statement_rows_apply(p_org_id uuid, p_file_id uuid, p_days integer)
RETURNS TABLE (applied boolean, versions integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_latest integer;
  v_deleted integer;
BEGIN
  IF (NOT pg_catalog.pg_has_role(SESSION_USER, 'ludy_worker', 'MEMBER'))
     OR ludy_kernel.ctx_actor_type() IS DISTINCT FROM 'system'
     OR ludy_kernel.ctx_org_id() IS DISTINCT FROM p_org_id THEN
    RAISE EXCEPTION 'BANK_STATEMENT_ROWS_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF p_days IS NULL OR p_days < 90 THEN
    RAISE EXCEPTION 'BANK_STATEMENT_ROWS_TOO_SHORT' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM ludy_kernel.file f
  WHERE f.org_id = p_org_id AND f.id = p_file_id AND f.held_until IS NULL
  FOR UPDATE OF f;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 0;
    RETURN;
  END IF;
  SELECT x.version INTO v_latest
  FROM ludy_kernel.extraction x
  WHERE x.org_id = p_org_id AND x.file_id = p_file_id
    AND x.version = (SELECT pg_catalog.max(e.version) FROM ludy_kernel.extraction e WHERE e.org_id = p_org_id AND e.file_id = p_file_id)
    AND x.method = 'unsupported' AND x.status = 'done'
    AND (x.result ->> 'kind') = 'bank_statement'
    AND (x.result -> 'summary' ->> 'state') IN ('imported', 'rejected')
    AND x.completed_at < pg_catalog.now() - pg_catalog.make_interval(days => p_days);
  IF v_latest IS NULL THEN
    RETURN QUERY SELECT false, 0;
    RETURN;
  END IF;
  DELETE FROM ludy_kernel.extraction x
  WHERE x.org_id = p_org_id AND x.file_id = p_file_id AND x.version < v_latest
    AND (x.result ->> 'kind') = 'bank_statement';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN QUERY SELECT v_deleted > 0, v_deleted;
END;
$$;
REVOKE ALL ON FUNCTION ludy_finance.bank_statement_rows_apply(uuid, uuid, integer) FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION ludy_finance.bank_statement_rows_apply(uuid, uuid, integer) TO ludy_worker;
