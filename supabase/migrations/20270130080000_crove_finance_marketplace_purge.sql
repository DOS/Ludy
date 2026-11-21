-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #4284, owner-line decision of 2026-11-21 on #4276, ADR-0045 point 8): the reports a marketplace connection's poll brought in that were NEVER booked are destroyed a short time after
-- the connection is gone, not after the 90 days of the decided reports (Lazada's terms ask for the platform's data to be destroyed within 14 days of revocation). Idempotent; applied files stay untouched.
--
-- What is "booked": a report whose latest extraction version is a marketplace read (marketplace_orders or marketplace_income) in the state `imported` (a member confirmed it: its orders became order lines and moved
-- stock, or its income became a settlement). Those, and everything derived from them, are never touched here (they keep the 90 days of the originals and the retention accounting law asks for). Never booked
-- is everything else a poll brought in: still waiting (`staged`), skipped (`rejected`), or never read. Also never touched: a file under an evidence hold (held_until), a file a purchase document names as its
-- source, and any file that is not a poll's own (a CSV upload whose reads are all marketplace reads, or none yet): a bank statement or an invoice is never reachable.
--
-- When the clock starts (the grace, 7 days, then runs): (a) the connection is disconnected (`unlink` removes the row), (b) its channel is revoked but the row was not removed (a disconnect that stopped between
-- its two steps), or (c) the channel has stayed `expired` (a refused refresh: the seller's revocation on the platform looks the same) for 30 days without a new authorization.
--
-- 1. The link between a connection and the files its poll ingested (crove_finance.marketplace_connection_file, #4250) used to CASCADE with the connection, so after a disconnect nothing said which files came from it.
--    Now the connection's removal sets the link's connection to NULL instead (ON DELETE SET NULL with the column list, so org_id stays), and a BEFORE DELETE trigger on the connection stamps `disconnected_at` on
--    its links just before. The link stays append-only for a tenant role (no grant changes); a BEFORE INSERT trigger keeps a written link honest (a connection, no time); the file's own foreign key still cascades.
--    No new table. A poll of a new connection that brings the same bytes again takes the orphan link over (marketplace_link_adopt), so what a live connection holds is never purged.
-- 2. crove_finance.marketplace_purge_candidates   the rule above, with the time, as a function nobody can call but the definers below (a view would be a relation with an org_id column
--                                                 outside the RLS matrix, which covers tables only); marketplace_purge_referenced names the files another table still points at.
-- 3. crove_finance.marketplace_purge_due(days, expired_days, limit)   worker only: the files due, oldest first.
-- 4. crove_finance.marketplace_purge_key(org, file, days, expired_days)    system context, same org: the blob key of one due file, and whether another file row names the same key.
-- 5. crove_finance.marketplace_purge_apply(org, file, days, expired_days) system context, same org: re-checks under the file's lock (a file another table references is skipped), resets the connection's poll position when the connection is still there (so
--                                                                 what was purged is read again from the start of the platform's window, never skipped), and DELETES the file row, which takes every extraction
--                                                                 version and the link with it: nothing of the report, not even its hash, stays, and the same bytes arriving again are a new file.
-- The worker deletes the object first, then calls apply, then deletes the object once more (the retention's own order): a crash in between repeats and never leaves a row whose object still exists.
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

-- A link is written for a connection that is there and carries no disconnect time: the only way a link loses its connection is the connection's removal (the trigger above), so no writer, whatever its
-- role, can plant an orphan link and make a file of its own a purge candidate.
CREATE OR REPLACE FUNCTION crove_finance.marketplace_connection_file_insert_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.marketplace_connection_id IS NULL OR NEW.disconnected_at IS NOT NULL THEN
    RAISE EXCEPTION 'MARKETPLACE_LINK_NEEDS_CONNECTION' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_finance.marketplace_connection_file_insert_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
DROP TRIGGER IF EXISTS marketplace_connection_file_insert_guard ON crove_finance.marketplace_connection_file;
CREATE TRIGGER marketplace_connection_file_insert_guard BEFORE INSERT ON crove_finance.marketplace_connection_file
  FOR EACH ROW EXECUTE FUNCTION crove_finance.marketplace_connection_file_insert_guard();
ALTER TABLE crove_finance.marketplace_connection_file ENABLE ALWAYS TRIGGER marketplace_connection_file_insert_guard;

-- A new connection's poll brought a file again that an earlier, removed connection had brought (the same bytes are one file): the link moves to the new connection, so the file is the live connection's
-- and the purge leaves it. Only an orphan link moves; the poll's own command calls it (system context, own org), and the foreign key refuses a connection of another org.
CREATE OR REPLACE FUNCTION crove_finance.marketplace_link_adopt(p_org_id uuid, p_connection_id uuid, p_file_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER'))
     OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'system'
     OR crove_kernel.ctx_org_id() IS DISTINCT FROM p_org_id THEN
    RAISE EXCEPTION 'MARKETPLACE_PURGE_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  -- The file's key-share lock waits for a purge that holds the row (which then deletes it: this poll fails and is tried again, ingesting the bytes as a new file) and makes a purge that starts later see
  -- the adopted link.
  PERFORM 1 FROM crove_kernel.file f WHERE f.org_id = p_org_id AND f.id = p_file_id FOR KEY SHARE OF f;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MARKETPLACE_FILE_PURGED' USING ERRCODE = '40001';
  END IF;
  UPDATE crove_finance.marketplace_connection_file l
     SET marketplace_connection_id = p_connection_id, disconnected_at = NULL
   WHERE l.org_id = p_org_id AND l.file_id = p_file_id AND l.marketplace_connection_id IS NULL;
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION crove_finance.marketplace_link_adopt(uuid, uuid, uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_finance.marketplace_link_adopt(uuid, uuid, uuid) TO crove_worker;

-- 2. The rule. Nothing for a link of a live connection (its channel is active): those are never candidates. `p_org_id` / `p_file_id` narrow it to one file (NULL: all). The clock: a link with no connection
-- counts from its disconnect, a revoked channel from its revocation, an expired channel from `p_expired_days` after it expired (that long without a new authorization counts as the seller's revocation); then
-- `p_days` of grace. No role can execute it: the definers below call it as the owner.
CREATE OR REPLACE FUNCTION crove_finance.marketplace_purge_candidates(p_org_id uuid, p_file_id uuid, p_days integer, p_expired_days integer)
RETURNS TABLE (org_id uuid, file_id uuid, storage_key text, marketplace_connection_id uuid, started_at timestamptz)
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT l.org_id,
         l.file_id,
         f.storage_key,
         l.marketplace_connection_id,
         COALESCE(l.disconnected_at, CASE WHEN ch.status = 'revoked' THEN ch.updated_at END, ch.updated_at)
  FROM crove_finance.marketplace_connection_file l
  JOIN crove_kernel.file f ON f.org_id = l.org_id AND f.id = l.file_id
  LEFT JOIN crove_finance.marketplace_connection c ON c.org_id = l.org_id AND c.id = l.marketplace_connection_id
  LEFT JOIN crove_kernel.channel_connection ch ON ch.org_id = c.org_id AND ch.id = c.channel_connection_id
  WHERE (p_org_id IS NULL OR l.org_id = p_org_id)
    AND (p_file_id IS NULL OR l.file_id = p_file_id)
    AND (l.marketplace_connection_id IS NULL OR ch.status IN ('revoked', 'expired'))
    AND (
      l.disconnected_at < pg_catalog.now() - pg_catalog.make_interval(days => p_days)
      OR (ch.status = 'revoked' AND ch.updated_at < pg_catalog.now() - pg_catalog.make_interval(days => p_days))
      OR (ch.status = 'expired' AND ch.updated_at < pg_catalog.now() - pg_catalog.make_interval(days => p_days + p_expired_days))
    )
    AND f.held_until IS NULL
    AND f.source = 'upload' AND f.content_type = 'text/csv'
    AND NOT EXISTS (SELECT 1 FROM crove_finance.purchase_document pd WHERE pd.org_id = f.org_id AND pd.source_file_id = f.id)
    -- Only marketplace reads (or none yet, or a read that did not finish): a file with any other finished read is not a poll's report.
    AND NOT EXISTS (
      SELECT 1 FROM crove_kernel.extraction x
      WHERE x.org_id = f.org_id AND x.file_id = f.id
        AND x.status = 'done'
        AND NOT (x.method = 'unsupported' AND (x.result ->> 'kind') IN ('marketplace_orders', 'marketplace_income'))
    )
    -- Booked: the latest version is a marketplace read a member imported.
    AND NOT EXISTS (
      SELECT 1 FROM crove_kernel.extraction x
      WHERE x.org_id = f.org_id AND x.file_id = f.id
        AND x.version = (SELECT pg_catalog.max(e.version) FROM crove_kernel.extraction e WHERE e.org_id = f.org_id AND e.file_id = f.id)
        AND x.method = 'unsupported' AND x.status = 'done'
        AND (x.result ->> 'kind') IN ('marketplace_orders', 'marketplace_income')
        AND (x.result -> 'summary' ->> 'state') = 'imported'
    );
$$;
REVOKE ALL ON FUNCTION crove_finance.marketplace_purge_candidates(uuid, uuid, integer, integer) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- Whether any other table still points at the file with a foreign key that would refuse its deletion (no action or restrict: a signing envelope, a post's media, a quote logo and the like). The poll never
-- links such a file; a member's own use of one is respected: the purge skips it, so its object is never deleted for a row that must stay. Read from the catalog, so a table added later is covered too.
CREATE OR REPLACE FUNCTION crove_finance.marketplace_purge_referenced(p_org_id uuid, p_file_id uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  r record;
  v_found boolean;
BEGIN
  FOR r IN
    SELECT c.conrelid::pg_catalog.regclass::text AS rel, oa.attname::text AS org_col, fa.attname::text AS file_col
    FROM pg_catalog.pg_constraint c
    JOIN pg_catalog.pg_attribute oa ON oa.attrelid = c.conrelid AND oa.attnum = c.conkey[1]
    JOIN pg_catalog.pg_attribute fa ON fa.attrelid = c.conrelid AND fa.attnum = c.conkey[2]
    WHERE c.contype = 'f' AND c.confrelid = 'crove_kernel.file'::pg_catalog.regclass
      AND c.confdeltype IN ('a', 'r') AND pg_catalog.array_length(c.conkey, 1) = 2
  LOOP
    EXECUTE pg_catalog.format('SELECT EXISTS (SELECT 1 FROM %s t WHERE t.%I = $1 AND t.%I = $2)', r.rel, r.org_col, r.file_col) INTO v_found USING p_org_id, p_file_id;
    IF v_found THEN
      RETURN true;
    END IF;
  END LOOP;
  RETURN false;
END;
$$;
REVOKE ALL ON FUNCTION crove_finance.marketplace_purge_referenced(uuid, uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- 3. The files due, ids only; the worker runs the rest in each file's own org. A file another table references is left to key and apply, which skip it (the check reads other tables per file).
CREATE OR REPLACE FUNCTION crove_finance.marketplace_purge_due(p_days integer, p_expired_days integer, p_limit integer)
RETURNS TABLE (org_id uuid, file_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER')) OR crove_kernel.ctx_actor_type() IS NOT NULL THEN
    RAISE EXCEPTION 'MARKETPLACE_PURGE_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF p_days IS NULL OR p_days < 1 OR p_days > 14 OR p_expired_days IS NULL OR p_expired_days < 1 OR p_expired_days > 90 THEN
    RAISE EXCEPTION 'MARKETPLACE_PURGE_DAYS' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT s.org_id, s.file_id
  FROM crove_finance.marketplace_purge_candidates(NULL, NULL, p_days, p_expired_days) s
  JOIN crove_kernel.tenant t ON t.org_id = s.org_id AND t.status IN ('active', 'offboarding')
  ORDER BY s.started_at, s.file_id
  LIMIT LEAST(GREATEST(p_limit, 1), 1000);
END;
$$;
REVOKE ALL ON FUNCTION crove_finance.marketplace_purge_due(integer, integer, integer) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_finance.marketplace_purge_due(integer, integer, integer) TO crove_worker;

-- 4. The blob key of one due file (nothing for any other file) and whether another file row names the same key, in which case the worker leaves the object. Inside a system query, in the file's own org.
CREATE OR REPLACE FUNCTION crove_finance.marketplace_purge_key(p_org_id uuid, p_file_id uuid, p_days integer, p_expired_days integer)
RETURNS TABLE (storage_key text, shared boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER'))
     OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'system'
     OR crove_kernel.ctx_org_id() IS DISTINCT FROM p_org_id THEN
    RAISE EXCEPTION 'MARKETPLACE_PURGE_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF p_days IS NULL OR p_days < 1 OR p_days > 14 OR p_expired_days IS NULL OR p_expired_days < 1 OR p_expired_days > 90 THEN
    RAISE EXCEPTION 'MARKETPLACE_PURGE_DAYS' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT s.storage_key,
         EXISTS (SELECT 1 FROM crove_kernel.file o WHERE o.storage_key = s.storage_key AND (o.org_id, o.id) <> (s.org_id, s.file_id))
  FROM crove_finance.marketplace_purge_candidates(p_org_id, p_file_id, p_days, p_expired_days) s
  WHERE NOT crove_finance.marketplace_purge_referenced(s.org_id, s.file_id);
END;
$$;
REVOKE ALL ON FUNCTION crove_finance.marketplace_purge_key(uuid, uuid, integer, integer) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_finance.marketplace_purge_key(uuid, uuid, integer, integer) TO crove_worker;

-- 5. Destroys one due file (the worker deleted the object first). It checks the rule again under the file row's lock, so it can neither run early nor touch a booked report. applied is false when the file is not
-- (or no longer) due; versions counts the extraction versions that went with the file. Inside the system command finance.marketplace_retention.apply, in its purge form.
CREATE OR REPLACE FUNCTION crove_finance.marketplace_purge_apply(p_org_id uuid, p_file_id uuid, p_days integer, p_expired_days integer)
RETURNS TABLE (applied boolean, versions integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_connection uuid;
  v_versions integer;
BEGIN
  IF (NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER'))
     OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'system'
     OR crove_kernel.ctx_org_id() IS DISTINCT FROM p_org_id THEN
    RAISE EXCEPTION 'MARKETPLACE_PURGE_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF p_days IS NULL OR p_days < 1 OR p_days > 14 OR p_expired_days IS NULL OR p_expired_days < 1 OR p_expired_days > 90 THEN
    RAISE EXCEPTION 'MARKETPLACE_PURGE_DAYS' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM crove_kernel.file f WHERE f.org_id = p_org_id AND f.id = p_file_id FOR UPDATE OF f;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 0;
    RETURN;
  END IF;
  SELECT s.marketplace_connection_id INTO v_connection
  FROM crove_finance.marketplace_purge_candidates(p_org_id, p_file_id, p_days, p_expired_days) s
  WHERE NOT crove_finance.marketplace_purge_referenced(s.org_id, s.file_id);
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 0;
    RETURN;
  END IF;
  -- The connection is still there (expired or revoked and not removed): the pages the cursor already passed are gone, so it reads again from the start of the platform's window.
  IF v_connection IS NOT NULL THEN
    UPDATE crove_finance.marketplace_connection c SET poll_cursor = NULL WHERE c.org_id = p_org_id AND c.id = v_connection;
  END IF;
  SELECT pg_catalog.count(*)::integer INTO v_versions FROM crove_kernel.extraction x WHERE x.org_id = p_org_id AND x.file_id = p_file_id;
  -- The extraction versions, the link and any column check go with the row (their foreign keys cascade).
  DELETE FROM crove_kernel.file f WHERE f.org_id = p_org_id AND f.id = p_file_id;
  RETURN QUERY SELECT true, v_versions;
END;
$$;
REVOKE ALL ON FUNCTION crove_finance.marketplace_purge_apply(uuid, uuid, integer, integer) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_finance.marketplace_purge_apply(uuid, uuid, integer, integer) TO crove_worker;
