-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #4284, owner-line decision of 2026-11-21 on #4276, ADR-0045 point 8): the reports a marketplace connection's poll brought in that were NEVER booked are destroyed a short time after
-- the connection is disconnected, not after the 90 days of the decided reports (Lazada's terms ask for the platform's data to be destroyed within 14 days of revocation). Idempotent; applied files stay untouched.
--
-- What is "booked": a report whose latest extraction version is a marketplace read (marketplace_orders or marketplace_income) in the state `imported` (a member confirmed it: its orders became order lines and moved
-- stock, or its income became a settlement). Those, and everything derived from them, are never touched here (they keep the 90 days of the originals and the retention accounting law asks for). Never booked
-- is everything else a poll brought in: still waiting (`staged`), skipped (`rejected`), or never read. Also never touched: a file under an evidence hold (held_until) and a file a purchase document names as its source.
--
-- 1. The link between a connection and the files its poll ingested (crove_finance.marketplace_connection_file, #4250) used to CASCADE with the connection, so after a disconnect nothing said which files came from it.
--    Now the connection's removal sets the link's connection to NULL instead, and a BEFORE DELETE trigger on the connection stamps `disconnected_at` on its links just before. The link stays append-only for a
--    tenant role (no grant changes); the file's own foreign key still cascades. No new table.
-- 2. crove_finance.marketplace_purge_candidates(org, file, days)  the one place the rule above is written (internal: callable by the definers below only).
-- 3. crove_finance.marketplace_purge_due(days, limit)             worker only: the files due, oldest disconnect first (days between 1 and 14: never early, never later than the 14 days of the term).
-- 4. crove_finance.marketplace_purge_key(org, file, days)         system context, same org: the blob key of one due file, and whether another file row names the same key.
-- 5. crove_finance.marketplace_purge_apply(org, file, days)       system context, same org: re-checks under the file's lock, deletes EVERY extraction version of the file (the staged lines and the decision), marks
--                                                                 the original deleted through the existing guard (original_deleted_at, set once, only by the worker as the system) and removes the link, so a
--                                                                 later upload of the same bytes by a member is that member's own file again. The file row (generated name, size, sha256) stays, as for the 90 days.
-- The worker deletes the object first, then calls apply, then deletes the object once more (the retention's own order): a crash in between repeats and never leaves a marked file whose object still exists.
SET LOCAL lock_timeout = '2s';

-- 1. The link survives the connection.
ALTER TABLE crove_finance.marketplace_connection_file ALTER COLUMN marketplace_connection_id DROP NOT NULL;
ALTER TABLE crove_finance.marketplace_connection_file ADD COLUMN IF NOT EXISTS disconnected_at timestamptz;
ALTER TABLE crove_finance.marketplace_connection_file DROP CONSTRAINT IF EXISTS marketplace_connection_file_connection_fk;
ALTER TABLE crove_finance.marketplace_connection_file ADD CONSTRAINT marketplace_connection_file_connection_fk
  FOREIGN KEY (org_id, marketplace_connection_id) REFERENCES crove_finance.marketplace_connection (org_id, id) ON DELETE SET NULL (marketplace_connection_id);
-- A link with no connection says when the connection went: it is what the purge counts from.
ALTER TABLE crove_finance.marketplace_connection_file DROP CONSTRAINT IF EXISTS marketplace_connection_file_disconnected_ck;
ALTER TABLE crove_finance.marketplace_connection_file ADD CONSTRAINT marketplace_connection_file_disconnected_ck CHECK (marketplace_connection_id IS NOT NULL OR disconnected_at IS NOT NULL);
-- The purge lists the links of removed connections.
CREATE INDEX IF NOT EXISTS marketplace_connection_file_disconnected_idx ON crove_finance.marketplace_connection_file (disconnected_at) WHERE marketplace_connection_id IS NULL;

CREATE OR REPLACE FUNCTION crove_finance.marketplace_connection_link_stamp() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  UPDATE crove_finance.marketplace_connection_file l
     SET disconnected_at = pg_catalog.now()
   WHERE l.org_id = OLD.org_id AND l.marketplace_connection_id = OLD.id AND l.disconnected_at IS NULL;
  RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION crove_finance.marketplace_connection_link_stamp() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
DROP TRIGGER IF EXISTS marketplace_connection_link_stamp ON crove_finance.marketplace_connection;
CREATE TRIGGER marketplace_connection_link_stamp BEFORE DELETE ON crove_finance.marketplace_connection
  FOR EACH ROW EXECUTE FUNCTION crove_finance.marketplace_connection_link_stamp();

-- 2. The rule, written once. A candidate is a file linked to a connection that is gone for more than `days` days, never booked, not held and not a purchase document's source.
CREATE OR REPLACE FUNCTION crove_finance.marketplace_purge_candidates(p_org_id uuid, p_file_id uuid, p_days integer)
RETURNS TABLE (org_id uuid, file_id uuid, link_id uuid, storage_key text, disconnected_at timestamptz)
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT l.org_id, l.file_id, l.id, f.storage_key, l.disconnected_at
  FROM crove_finance.marketplace_connection_file l
  JOIN crove_kernel.file f ON f.org_id = l.org_id AND f.id = l.file_id
  WHERE l.marketplace_connection_id IS NULL
    AND l.disconnected_at < pg_catalog.now() - pg_catalog.make_interval(days => p_days)
    AND (p_org_id IS NULL OR l.org_id = p_org_id)
    AND (p_file_id IS NULL OR l.file_id = p_file_id)
    AND f.held_until IS NULL
    AND NOT EXISTS (SELECT 1 FROM crove_finance.purchase_document pd WHERE pd.org_id = f.org_id AND pd.source_file_id = f.id)
    -- Booked: the latest version is a marketplace read a member imported.
    AND NOT EXISTS (
      SELECT 1 FROM crove_kernel.extraction x
      WHERE x.org_id = f.org_id AND x.file_id = f.id
        AND x.version = (SELECT pg_catalog.max(e.version) FROM crove_kernel.extraction e WHERE e.org_id = f.org_id AND e.file_id = f.id)
        AND x.method = 'unsupported' AND x.status = 'done'
        AND (x.result ->> 'kind') IN ('marketplace_orders', 'marketplace_income')
        AND (x.result -> 'summary' ->> 'state') = 'imported'
    )
$$;
REVOKE ALL ON FUNCTION crove_finance.marketplace_purge_candidates(uuid, uuid, integer) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- 3. The files due, ids only; the worker runs the rest in each file's own org.
CREATE OR REPLACE FUNCTION crove_finance.marketplace_purge_due(p_days integer, p_limit integer)
RETURNS TABLE (org_id uuid, file_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER')) OR crove_kernel.ctx_actor_type() IS NOT NULL THEN
    RAISE EXCEPTION 'MARKETPLACE_PURGE_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF p_days IS NULL OR p_days < 1 OR p_days > 14 THEN
    RAISE EXCEPTION 'MARKETPLACE_PURGE_DAYS' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT c.org_id, c.file_id
  FROM crove_finance.marketplace_purge_candidates(NULL, NULL, p_days) c
  JOIN crove_kernel.tenant t ON t.org_id = c.org_id AND t.status IN ('active', 'offboarding')
  ORDER BY c.disconnected_at, c.file_id
  LIMIT LEAST(GREATEST(p_limit, 1), 1000);
END;
$$;
REVOKE ALL ON FUNCTION crove_finance.marketplace_purge_due(integer, integer) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_finance.marketplace_purge_due(integer, integer) TO crove_worker;

-- 4. The blob key of one due file (nothing for any other file) and whether another file row names the same key, in which case the worker leaves the object. Inside a system query, in the file's own org.
CREATE OR REPLACE FUNCTION crove_finance.marketplace_purge_key(p_org_id uuid, p_file_id uuid, p_days integer)
RETURNS TABLE (storage_key text, shared boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER'))
     OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'system'
     OR crove_kernel.ctx_org_id() IS DISTINCT FROM p_org_id THEN
    RAISE EXCEPTION 'MARKETPLACE_PURGE_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF p_days IS NULL OR p_days < 1 OR p_days > 14 THEN
    RAISE EXCEPTION 'MARKETPLACE_PURGE_DAYS' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT c.storage_key,
         EXISTS (SELECT 1 FROM crove_kernel.file o WHERE o.storage_key = c.storage_key AND (o.org_id, o.id) <> (c.org_id, c.file_id))
  FROM crove_finance.marketplace_purge_candidates(p_org_id, p_file_id, p_days) c;
END;
$$;
REVOKE ALL ON FUNCTION crove_finance.marketplace_purge_key(uuid, uuid, integer) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_finance.marketplace_purge_key(uuid, uuid, integer) TO crove_worker;

-- 5. Destroys one due file's read and marks its original deleted (the worker deleted the object first). It checks the rule again under the file row's lock, so it can neither run early nor touch a booked report.
-- applied is false when the file is not (or no longer) due; versions counts the extraction versions deleted. Inside the system command finance.marketplace_retention.apply, in its purge form.
CREATE OR REPLACE FUNCTION crove_finance.marketplace_purge_apply(p_org_id uuid, p_file_id uuid, p_days integer)
RETURNS TABLE (applied boolean, versions integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_deleted integer;
BEGIN
  IF (NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER'))
     OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'system'
     OR crove_kernel.ctx_org_id() IS DISTINCT FROM p_org_id THEN
    RAISE EXCEPTION 'MARKETPLACE_PURGE_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF p_days IS NULL OR p_days < 1 OR p_days > 14 THEN
    RAISE EXCEPTION 'MARKETPLACE_PURGE_DAYS' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM crove_kernel.file f WHERE f.org_id = p_org_id AND f.id = p_file_id FOR UPDATE OF f;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM crove_finance.marketplace_purge_candidates(p_org_id, p_file_id, p_days)) THEN
    RETURN QUERY SELECT false, 0;
    RETURN;
  END IF;
  DELETE FROM crove_kernel.extraction x WHERE x.org_id = p_org_id AND x.file_id = p_file_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  UPDATE crove_kernel.file f SET original_deleted_at = pg_catalog.now() WHERE f.org_id = p_org_id AND f.id = p_file_id AND f.original_deleted_at IS NULL;
  DELETE FROM crove_finance.marketplace_connection_file l WHERE l.org_id = p_org_id AND l.file_id = p_file_id AND l.marketplace_connection_id IS NULL;
  RETURN QUERY SELECT true, v_deleted;
END;
$$;
REVOKE ALL ON FUNCTION crove_finance.marketplace_purge_apply(uuid, uuid, integer) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_finance.marketplace_purge_apply(uuid, uuid, integer) TO crove_worker;
