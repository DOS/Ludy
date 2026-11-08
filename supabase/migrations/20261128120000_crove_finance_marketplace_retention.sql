-- SPDX-License-Identifier: AGPL-3.0-only
-- Retention of the original file of a decided marketplace report (#2516 step C-2b3, ADR-0045 point 8): the file a seller dropped in the Inbox (an order report or an income
-- report) is deleted 90 days after a member imported or skipped it, together with the per-order amounts the staged read kept in crove_kernel.extraction. What stays is the
-- file row (its sha256, name and size, so the same bytes are still recognised) and the decision's extraction version (the summary: counts, totals, the settlement it made).
-- "Deleted" is what the store's delete does: on a versioned bucket (the production one, with Object Lock) the current object gets a delete marker and the noncurrent version stays until the
-- store-side fix (#2789). So every reader of a file's bytes refuses a file with original_deleted_at set, whatever the store still holds.
--
--   1. (20261128110000_crove_kernel_file_original_deleted.sql)  crove_kernel.file.original_deleted_at, set once, only by the definer below (a trigger refuses any other change).
--   2. crove_finance.marketplace_retention_due(days, limit)        worker only: the decided reports of the two marketplace kinds older than `days` (never fewer than 90).
--   3. crove_finance.marketplace_retention_key(org, file, days)    system context, same org: the blob key of one due file, and whether another file row names it.
--   4. crove_finance.marketplace_retention_apply(org, file, days)  system context, same org: marks the original deleted and deletes the OLDER extraction versions of the file
--                                                                  (the staged ones, which hold the lines); the decision version stays.
-- Only a DECIDED report (summary state imported or rejected, on the file's latest version) is ever due: a report still staged is kept whatever its age. A file under an evidence hold
-- (held_until set) or named by a purchase document as its source (source_file_id) is never due. Only the two kinds
-- marketplace_orders and marketplace_income are reachable: a bank statement or an invoice file is never listed, keyed or applied. The worker deletes the blob first, then
-- calls apply, so a crash in between repeats and never leaves a row pointing nowhere unseen. extraction_guard is untouched: finished versions are still never updated.
SET LOCAL lock_timeout = '2s';

-- The decided reports whose original is due, oldest decision first. Ids and a kind only; the worker runs the rest in each file's own org.
CREATE OR REPLACE FUNCTION crove_finance.marketplace_retention_due(p_days integer, p_limit integer)
RETURNS TABLE (org_id uuid, file_id uuid, kind text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER')) OR crove_kernel.ctx_actor_type() IS NOT NULL THEN
    RAISE EXCEPTION 'MARKETPLACE_RETENTION_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF p_days IS NULL OR p_days < 90 THEN
    RAISE EXCEPTION 'MARKETPLACE_RETENTION_TOO_SHORT' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT f.org_id, f.id, (x.result ->> 'kind')
  FROM crove_kernel.file f
  JOIN crove_kernel.tenant t ON t.org_id = f.org_id AND t.status IN ('active', 'offboarding')
  JOIN LATERAL (
    SELECT e.method, e.status, e.result, e.completed_at
    FROM crove_kernel.extraction e
    WHERE e.org_id = f.org_id AND e.file_id = f.id
    ORDER BY e.version DESC
    LIMIT 1
  ) x ON true
  WHERE f.original_deleted_at IS NULL
    AND f.held_until IS NULL
    AND NOT EXISTS (SELECT 1 FROM crove_finance.purchase_document pd WHERE pd.org_id = f.org_id AND pd.source_file_id = f.id)
    AND x.method = 'unsupported' AND x.status = 'done'
    AND (x.result ->> 'kind') IN ('marketplace_orders', 'marketplace_income')
    AND (x.result -> 'summary' ->> 'state') IN ('imported', 'rejected')
    AND x.completed_at < pg_catalog.now() - pg_catalog.make_interval(days => p_days)
  ORDER BY x.completed_at, f.id
  LIMIT LEAST(GREATEST(p_limit, 1), 1000);
END;
$$;
REVOKE ALL ON FUNCTION crove_finance.marketplace_retention_due(integer, integer) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_finance.marketplace_retention_due(integer, integer) TO crove_worker;

-- The blob key of one file that is due (nothing for any other file: a bank statement, an invoice, a report still staged, an original already deleted), and whether another file
-- row names the same key, in which case the worker leaves the object. Inside the system query finance.marketplace_retention.key, in the file's own org.
CREATE OR REPLACE FUNCTION crove_finance.marketplace_retention_key(p_org_id uuid, p_file_id uuid, p_days integer)
RETURNS TABLE (storage_key text, shared boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER'))
     OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'system'
     OR crove_kernel.ctx_org_id() IS DISTINCT FROM p_org_id THEN
    RAISE EXCEPTION 'MARKETPLACE_RETENTION_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF p_days IS NULL OR p_days < 90 THEN
    RAISE EXCEPTION 'MARKETPLACE_RETENTION_TOO_SHORT' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT f.storage_key,
         EXISTS (SELECT 1 FROM crove_kernel.file o WHERE o.storage_key = f.storage_key AND (o.org_id, o.id) <> (f.org_id, f.id))
  FROM crove_kernel.file f
  JOIN LATERAL (
    SELECT e.method, e.status, e.result, e.completed_at
    FROM crove_kernel.extraction e
    WHERE e.org_id = f.org_id AND e.file_id = f.id
    ORDER BY e.version DESC
    LIMIT 1
  ) x ON true
  WHERE f.org_id = p_org_id AND f.id = p_file_id AND f.original_deleted_at IS NULL
    AND f.held_until IS NULL
    AND NOT EXISTS (SELECT 1 FROM crove_finance.purchase_document pd WHERE pd.org_id = f.org_id AND pd.source_file_id = f.id)
    AND x.method = 'unsupported' AND x.status = 'done'
    AND (x.result ->> 'kind') IN ('marketplace_orders', 'marketplace_income')
    AND (x.result -> 'summary' ->> 'state') IN ('imported', 'rejected')
    AND x.completed_at < pg_catalog.now() - pg_catalog.make_interval(days => p_days);
END;
$$;
REVOKE ALL ON FUNCTION crove_finance.marketplace_retention_key(uuid, uuid, integer) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_finance.marketplace_retention_key(uuid, uuid, integer) TO crove_worker;

-- Marks one due file's original deleted (the worker deleted the object first) and deletes the older extraction versions of the file that hold the staged lines; the latest version,
-- the decision's, stays. It checks the same conditions as the list again under the file row's lock, so it can neither run early nor touch another kind or a report still staged.
-- applied is false when the file is not (or no longer) due; versions counts the extraction versions deleted. Inside the system command finance.marketplace_retention.apply.
CREATE OR REPLACE FUNCTION crove_finance.marketplace_retention_apply(p_org_id uuid, p_file_id uuid, p_days integer)
RETURNS TABLE (applied boolean, versions integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_latest integer;
  v_deleted integer;
BEGIN
  IF (NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER'))
     OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'system'
     OR crove_kernel.ctx_org_id() IS DISTINCT FROM p_org_id THEN
    RAISE EXCEPTION 'MARKETPLACE_RETENTION_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF p_days IS NULL OR p_days < 90 THEN
    RAISE EXCEPTION 'MARKETPLACE_RETENTION_TOO_SHORT' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM crove_kernel.file f
  WHERE f.org_id = p_org_id AND f.id = p_file_id AND f.original_deleted_at IS NULL AND f.held_until IS NULL
    AND NOT EXISTS (SELECT 1 FROM crove_finance.purchase_document pd WHERE pd.org_id = f.org_id AND pd.source_file_id = f.id)
  FOR UPDATE OF f;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 0;
    RETURN;
  END IF;
  SELECT x.version INTO v_latest
  FROM crove_kernel.extraction x
  WHERE x.org_id = p_org_id AND x.file_id = p_file_id
    AND x.version = (SELECT pg_catalog.max(e.version) FROM crove_kernel.extraction e WHERE e.org_id = p_org_id AND e.file_id = p_file_id)
    AND x.method = 'unsupported' AND x.status = 'done'
    AND (x.result ->> 'kind') IN ('marketplace_orders', 'marketplace_income')
    AND (x.result -> 'summary' ->> 'state') IN ('imported', 'rejected')
    AND x.completed_at < pg_catalog.now() - pg_catalog.make_interval(days => p_days);
  IF v_latest IS NULL THEN
    RETURN QUERY SELECT false, 0;
    RETURN;
  END IF;
  DELETE FROM crove_kernel.extraction x
  WHERE x.org_id = p_org_id AND x.file_id = p_file_id AND x.version < v_latest
    AND (x.result ->> 'kind') IN ('marketplace_orders', 'marketplace_income');
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  UPDATE crove_kernel.file f SET original_deleted_at = pg_catalog.now() WHERE f.org_id = p_org_id AND f.id = p_file_id;
  RETURN QUERY SELECT true, v_deleted;
END;
$$;
REVOKE ALL ON FUNCTION crove_finance.marketplace_retention_apply(uuid, uuid, integer) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_finance.marketplace_retention_apply(uuid, uuid, integer) TO crove_worker;
