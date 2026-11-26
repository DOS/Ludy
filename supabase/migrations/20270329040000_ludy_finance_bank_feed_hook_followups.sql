-- SPDX-License-Identifier: AGPL-3.0-only
-- Tingee bank feed webhook review follow-ups (#4225, parent #4203, ADR-0039):
--   1. Maintain a fixed 17-row transactional backlog counter (ludy_finance.bank_feed_webhook_backlog:
--      slot 0 tracks cumulative inserts, slots 1..16 track cumulative deletes via SKIP LOCKED) via
--      statement triggers on ludy_finance.bank_feed_webhook_notice so bank_feed_hook_put_notice
--      atomically reserves the 10,000-row cap on slot 0 in O(1) without scanning 10k rows or
--      blocking across concurrent open claim batches.
--   2. Add unique index bank_feed_hook_id_uq on (id) and bank_feed_hook_reject_token_uq on
--      (COALESCE(reject_token, id)) so hook lookups in bank_feed_hook_put_notice and
--      bank_feed_hook_reject use index lookups rather than scanning ludy_finance.bank_feed_hook.
--   3. Decode JSON escapes (including \uXXXX and UTF-16 surrogate pairs) inside
--      ludy_finance.personal_data_erase_bank_feed_notice for valid JSON bodies only, keeping raw
--      text matching unchanged for non-JSON payloads.
--   4. Update ludy_finance.bank_feed_hook_claim to sweep expired >10m notices first (ADR-0039) and
--      then pop strictly at most p_limit remaining rows via LEFT JOIN (returning all-NULL placeholder
--      rows for stopped, closed, or Finance-off notices, matching bank_feed_notice_claim) so active
--      queues are never blocked by dead hooks or stop the relay loop early.
--   6. Add generation (integer, default 1, >= 1) and per-rotation reject_token (uuid, NULL until first
--      rotation) to ludy_finance.bank_feed_hook; advance generation, mint reject_token, and drop
--      waiting notices on every rotation path (including in-flight old callers and pre-upgrade rotated
--      hooks); return COALESCE(reject_token, id) as hook_id and trailing generation from
--      bank_feed_hook_claim; add generation-bound bank_feed_hook_reject(uuid, integer) plus 1-arg shim.
SET LOCAL lock_timeout = '2s';

-- Queue both locks up front within bounded lock_timeout subtransactions so steady
-- short-lived webhook lookups/reads cannot starve NOWAIT while cross-order cycles with
-- concurrent claim (notice -> hook) or put_notice (hook -> notice) abort and retry cleanly.
DO $$
DECLARE
  v_deadline constant timestamp with time zone := pg_catalog.clock_timestamp() + interval '2 seconds';
BEGIN
  LOOP
    BEGIN
      SET LOCAL lock_timeout = '500ms';
      LOCK TABLE ludy_finance.bank_feed_webhook_notice IN SHARE ROW EXCLUSIVE MODE;
      LOCK TABLE ludy_finance.bank_feed_hook IN ACCESS EXCLUSIVE MODE;
      EXIT;
    EXCEPTION
      WHEN lock_not_available OR deadlock_detected THEN
        IF pg_catalog.clock_timestamp() >= v_deadline THEN
          RAISE;
        END IF;
        PERFORM pg_catalog.pg_sleep(0.02);
    END;
  END LOOP;
END
$$;
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. Track hook generation, per-rotation reject_token, and id / reject_token indexes
-- ---------------------------------------------------------------------------
ALTER TABLE ludy_finance.bank_feed_hook
  ADD COLUMN IF NOT EXISTS generation integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS reject_token uuid;

ALTER TABLE ludy_finance.bank_feed_hook
  DROP CONSTRAINT IF EXISTS bank_feed_hook_generation_check,
  ADD CONSTRAINT bank_feed_hook_generation_check CHECK (generation >= 1);

-- Any hook already rotated prior to this migration gets a fresh token, and any
-- waiting notice received before that rotation is dropped so pre-rotation
-- notices stored before this upgrade cannot be claimed and counted against the
-- newly rotated key.
UPDATE ludy_finance.bank_feed_hook
SET reject_token = pg_catalog.gen_random_uuid()
WHERE rotated_at IS NOT NULL AND reject_token IS NULL;

DELETE FROM ludy_finance.bank_feed_webhook_notice n
USING ludy_finance.bank_feed_hook h
WHERE n.org_id = h.org_id
  AND n.hook_id = h.id
  AND h.rotated_at IS NOT NULL
  AND n.received_at <= h.rotated_at;

-- Index id directly so bank_feed_hook_put_notice avoids scanning the hook table by id alone.
CREATE UNIQUE INDEX IF NOT EXISTS bank_feed_hook_id_uq
  ON ludy_finance.bank_feed_hook (id);

-- Index the exact identifier that bank_feed_hook_claim returns and both
-- bank_feed_hook_reject overloads look up.
CREATE UNIQUE INDEX IF NOT EXISTS bank_feed_hook_reject_token_uq
  ON ludy_finance.bank_feed_hook ((COALESCE(reject_token, id)));

-- Guard any concurrent/in-flight rotation (including a pre-migration bank_feed_hook_set body resuming
-- after ALTER TABLE) so key_sha256 or rotated_at updates always advance generation and mint reject_token,
-- and skip stale counter/stop updates from an in-flight pre-migration bank_feed_hook_reject(uuid) on
-- any rotated hook once ALTER TABLE releases its lock.
CREATE OR REPLACE FUNCTION ludy_finance.bank_feed_hook_rotate_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.key_sha256 IS DISTINCT FROM OLD.key_sha256 OR NEW.rotated_at IS DISTINCT FROM OLD.rotated_at THEN
    NEW.generation := OLD.generation + 1;
    NEW.reject_token := pg_catalog.gen_random_uuid();
  ELSIF (NEW.rejected_count IS DISTINCT FROM OLD.rejected_count
         OR NEW.rejected_window_start IS DISTINCT FROM OLD.rejected_window_start
         OR NEW.stopped_at IS DISTINCT FROM OLD.stopped_at)
        AND (OLD.rotated_at IS NOT NULL OR OLD.reject_token IS NOT NULL OR OLD.generation > 1)
        AND pg_catalog.current_setting('ludy.bank_feed_reject_op', true) IS DISTINCT FROM '1' THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS bank_feed_hook_rotate_guard_trg ON ludy_finance.bank_feed_hook;
CREATE TRIGGER bank_feed_hook_rotate_guard_trg
  BEFORE UPDATE ON ludy_finance.bank_feed_hook
  FOR EACH ROW
  EXECUTE FUNCTION ludy_finance.bank_feed_hook_rotate_guard();

-- Drop waiting notices on every rotation path (including an in-flight pre-migration
-- bank_feed_hook_set call) so pre-rotation notices can never be claimed under the new generation.
CREATE OR REPLACE FUNCTION ludy_finance.bank_feed_hook_rotate_cleanup()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.key_sha256 IS DISTINCT FROM OLD.key_sha256 OR NEW.rotated_at IS DISTINCT FROM OLD.rotated_at THEN
    DELETE FROM ludy_finance.bank_feed_webhook_notice n
    WHERE n.org_id = NEW.org_id AND n.hook_id = NEW.id;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS bank_feed_hook_rotate_cleanup_trg ON ludy_finance.bank_feed_hook;
CREATE TRIGGER bank_feed_hook_rotate_cleanup_trg
  AFTER UPDATE OF key_sha256, rotated_at ON ludy_finance.bank_feed_hook
  FOR EACH ROW
  EXECUTE FUNCTION ludy_finance.bank_feed_hook_rotate_cleanup();

-- ---------------------------------------------------------------------------
-- 2. Increment generation and mint reject_token on rotation (triggers drop waiting notices)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ludy_finance.bank_feed_hook_set(p_connection uuid, p_key_sha256 text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_new boolean;
BEGIN
  IF v_org IS NULL OR ludy_kernel.ctx_actor_type() IS DISTINCT FROM 'user' OR NOT EXISTS (
    SELECT 1 FROM ludy_kernel.tenant_member m WHERE m.org_id = v_org AND m.user_id = ludy_kernel.ctx_user_id() AND m.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'BANK_FEED_HOOK_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_connection IS NULL OR p_key_sha256 IS NULL OR p_key_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'BANK_FEED_HOOK_INVALID' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM ludy_kernel.channel_connection c WHERE c.org_id = v_org AND c.id = p_connection AND c.status = 'active' AND c.provider ~ '^bank_[a-z0-9_]{1,27}$') THEN
    RAISE EXCEPTION 'BANK_FEED_HOOK_NOT_FOUND' USING ERRCODE = '22023';
  END IF;
  INSERT INTO ludy_finance.bank_feed_hook AS h (org_id, channel_connection_id, key_sha256)
  VALUES (v_org, p_connection, p_key_sha256)
  ON CONFLICT ON CONSTRAINT bank_feed_hook_connection_uq DO UPDATE SET
    key_sha256 = EXCLUDED.key_sha256,
    generation = h.generation + 1,
    reject_token = pg_catalog.gen_random_uuid(),
    rotated_at = pg_catalog.clock_timestamp(),
    rejected_count = 0,
    rejected_window_start = NULL,
    stopped_at = NULL
  RETURNING (xmax = 0) INTO v_new;
  RETURN v_new;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Fixed 17-row backlog counter and atomic index-backed bank_feed_hook_put_notice
-- ---------------------------------------------------------------------------
-- Global definer-only 17-row counter table (no org_id, matching bank_feed_notice_pending):
--   slot 0: cumulative inserts (locked FOR UPDATE by put_notice so concurrent calls race atomically on the 10,000th slot)
--   slots 1..16: sharded cumulative deletes as negative offsets (delete trigger grabs an unlocked slot via SKIP LOCKED so
--                up to 16 concurrent open claim batches never block one another or put_notice)
CREATE TABLE IF NOT EXISTS ludy_finance.bank_feed_webhook_backlog (
  slot smallint PRIMARY KEY CHECK (slot BETWEEN 0 AND 16),
  delta bigint NOT NULL DEFAULT 0
);
ALTER TABLE ludy_finance.bank_feed_webhook_backlog ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ludy_finance.bank_feed_webhook_backlog FROM PUBLIC;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT rolname FROM pg_catalog.pg_roles
    WHERE (rolname LIKE 'ludy\_%' OR rolname LIKE 'crove\_%') AND rolname <> current_user
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON ludy_finance.bank_feed_webhook_backlog FROM %I', r.rolname);
  END LOOP;
END $$;
SELECT ludy_kernel.agent_write_guard_install('ludy_finance.bank_feed_webhook_backlog');

CREATE OR REPLACE FUNCTION ludy_finance.bank_feed_webhook_backlog_on_insert()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_cnt bigint;
  v_added bigint;
  v_removed bigint;
BEGIN
  SELECT pg_catalog.count(*)::bigint INTO v_cnt FROM new_rows;
  IF COALESCE(v_cnt, 0) <= 0 THEN
    RETURN NULL;
  END IF;
  SELECT b.delta INTO v_added
  FROM ludy_finance.bank_feed_webhook_backlog b
  WHERE b.slot = 0
  FOR UPDATE;
  SELECT COALESCE(pg_catalog.sum(b.delta), 0)::bigint INTO v_removed
  FROM ludy_finance.bank_feed_webhook_backlog b
  WHERE b.slot BETWEEN 1 AND 16;
  -- Enforce the 10,000-row cap at the shared insert trigger too so an in-flight pre-migration
  -- bank_feed_hook_put_notice (whose old check was > 10000) cannot write row 10,001 after commit.
  IF COALESCE(v_added, 0) + COALESCE(v_removed, 0) + v_cnt > 10000 THEN
    RAISE EXCEPTION 'BANK_FEED_HOOK_BACKLOG_FULL' USING ERRCODE = '54000';
  END IF;
  UPDATE ludy_finance.bank_feed_webhook_backlog b
  SET delta = b.delta + v_cnt
  WHERE b.slot = 0;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION ludy_finance.bank_feed_webhook_backlog_on_delete()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_cnt bigint;
  v_slot smallint;
BEGIN
  SELECT pg_catalog.count(*)::bigint INTO v_cnt FROM old_rows;
  IF COALESCE(v_cnt, 0) <= 0 THEN
    RETURN NULL;
  END IF;
  SELECT s.slot INTO v_slot
  FROM ludy_finance.bank_feed_webhook_backlog s
  WHERE s.slot BETWEEN 1 AND 16
  ORDER BY ((s.slot - 1 + (pg_catalog.pg_backend_pid() & 15)) & 15), s.slot
  LIMIT 1
  FOR UPDATE OF s SKIP LOCKED;
  IF v_slot IS NULL THEN
    v_slot := (1 + (pg_catalog.pg_backend_pid() & 15))::smallint;
  END IF;
  UPDATE ludy_finance.bank_feed_webhook_backlog b
  SET delta = b.delta - v_cnt
  WHERE b.slot = v_slot;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION ludy_finance.bank_feed_webhook_backlog_on_truncate()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  UPDATE ludy_finance.bank_feed_webhook_backlog SET delta = 0;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS bank_feed_webhook_backlog_insert_trg ON ludy_finance.bank_feed_webhook_notice;
CREATE TRIGGER bank_feed_webhook_backlog_insert_trg
  AFTER INSERT ON ludy_finance.bank_feed_webhook_notice
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT
  EXECUTE FUNCTION ludy_finance.bank_feed_webhook_backlog_on_insert();

DROP TRIGGER IF EXISTS bank_feed_webhook_backlog_delete_trg ON ludy_finance.bank_feed_webhook_notice;
CREATE TRIGGER bank_feed_webhook_backlog_delete_trg
  AFTER DELETE ON ludy_finance.bank_feed_webhook_notice
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT
  EXECUTE FUNCTION ludy_finance.bank_feed_webhook_backlog_on_delete();

DROP TRIGGER IF EXISTS bank_feed_webhook_backlog_update_trg ON ludy_finance.bank_feed_webhook_notice;

DROP TRIGGER IF EXISTS bank_feed_webhook_backlog_truncate_trg ON ludy_finance.bank_feed_webhook_notice;
CREATE TRIGGER bank_feed_webhook_backlog_truncate_trg
  AFTER TRUNCATE ON ludy_finance.bank_feed_webhook_notice
  FOR EACH STATEMENT
  EXECUTE FUNCTION ludy_finance.bank_feed_webhook_backlog_on_truncate();

-- CREATE TRIGGER above holds SHARE ROW EXCLUSIVE on bank_feed_webhook_notice until COMMIT,
-- so seeding the 17 counter rows here cannot race any concurrent insert or delete.
INSERT INTO ludy_finance.bank_feed_webhook_backlog (slot, delta)
SELECT s.slot::smallint,
       CASE WHEN s.slot = 0 THEN (SELECT pg_catalog.count(*)::bigint FROM ludy_finance.bank_feed_webhook_notice) ELSE 0::bigint END
FROM pg_catalog.generate_series(0, 16) AS s(slot)
ON CONFLICT (slot) DO UPDATE SET delta = EXCLUDED.delta;

CREATE OR REPLACE FUNCTION ludy_finance.bank_feed_hook_put_notice(p_hook uuid, p_key_sha256 text, p_request_id text, p_timestamp text, p_signature text, p_body text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_org uuid;
  v_conn uuid;
  v_rows integer;
  v_hook_waiting integer;
  v_added bigint;
  v_removed bigint;
BEGIN
  IF p_hook IS NULL OR p_key_sha256 IS NULL OR p_key_sha256 !~ '^[0-9a-f]{64}$' OR p_request_id IS NULL OR pg_catalog.char_length(p_request_id) NOT BETWEEN 1 AND 100
     OR p_timestamp IS NULL OR pg_catalog.char_length(p_timestamp) NOT BETWEEN 1 AND 40
     OR p_signature IS NULL OR pg_catalog.char_length(p_signature) NOT BETWEEN 1 AND 256
     OR p_body IS NULL OR pg_catalog.octet_length(p_body) NOT BETWEEN 1 AND 16384 THEN
    RAISE EXCEPTION 'BANK_FEED_HOOK_INVALID' USING ERRCODE = '22P02';
  END IF;
  -- Lock parent tenant FOR SHARE before bank_feed_hook FOR UPDATE and before global slot 0 so an unrelated
  -- tenant UPDATE / FOR UPDATE stalls only that org without inverting lock order or stalling other orgs on slot 0.
  SELECT h.org_id INTO v_org
  FROM ludy_finance.bank_feed_hook h
  WHERE h.id = p_hook AND h.key_sha256 = p_key_sha256 AND h.stopped_at IS NULL;
  IF v_org IS NULL THEN
    RETURN 'gone';
  END IF;
  PERFORM 1
  FROM ludy_kernel.tenant t
  WHERE t.org_id = v_org AND t.status = 'active'
  FOR SHARE OF t;
  IF NOT FOUND THEN
    RETURN 'gone';
  END IF;
  -- Re-read org_app_on(t.org_id, 'finance') in a fresh READ COMMITTED statement after acquiring FOR SHARE so a
  -- concurrent kernel.org.set_app (or direct tenant apps_off update) is observed post-commit rather than pre-wait.
  PERFORM 1
  FROM ludy_kernel.tenant t
  WHERE t.org_id = v_org AND t.status = 'active' AND ludy_kernel.org_app_on(t.org_id, 'finance');
  IF NOT FOUND THEN
    RETURN 'gone';
  END IF;
  SELECT h.channel_connection_id INTO v_conn
  FROM ludy_finance.bank_feed_hook h
  WHERE h.org_id = v_org AND h.id = p_hook AND h.key_sha256 = p_key_sha256 AND h.stopped_at IS NULL
  FOR UPDATE OF h;
  IF NOT FOUND THEN
    RETURN 'gone';
  END IF;
  -- Lock the active connection FOR SHARE before waiting on global slot 0 so a concurrent revoke
  -- either finishes first (EPQ observes status <> 'active' and returns 'gone') or waits to commit.
  PERFORM 1
  FROM ludy_kernel.channel_connection c
  WHERE c.org_id = v_org AND c.id = v_conn AND c.status = 'active'
  FOR SHARE OF c;
  IF NOT FOUND THEN
    RETURN 'gone';
  END IF;
  -- A retry of a notice that is already waiting is acknowledged whatever the backlog (the provider stops retrying).
  IF EXISTS (SELECT 1 FROM ludy_finance.bank_feed_webhook_notice n WHERE n.org_id = v_org AND n.hook_id = p_hook AND n.request_id = p_request_id) THEN
    RETURN 'duplicate';
  END IF;
  SELECT pg_catalog.count(*)::integer INTO v_hook_waiting
  FROM (SELECT 1 FROM ludy_finance.bank_feed_webhook_notice n WHERE n.org_id = v_org AND n.hook_id = p_hook LIMIT 20) s;
  IF v_hook_waiting >= 20 THEN
    RETURN 'busy';
  END IF;
  -- Lock only slot 0 to serialize the 10,000th slot across concurrent put_notice calls, then read slots 1..16 locklessly
  -- as a fresh READ COMMITTED statement so open worker claim transactions on slots 1..16 never block inserts.
  SELECT b.delta INTO v_added
  FROM ludy_finance.bank_feed_webhook_backlog b
  WHERE b.slot = 0
  FOR UPDATE;
  SELECT COALESCE(pg_catalog.sum(b.delta), 0)::bigint INTO v_removed
  FROM ludy_finance.bank_feed_webhook_backlog b
  WHERE b.slot BETWEEN 1 AND 16;
  IF COALESCE(v_added, 0) + COALESCE(v_removed, 0) >= 10000 THEN
    RETURN 'busy';
  END IF;
  INSERT INTO ludy_finance.bank_feed_webhook_notice (org_id, hook_id, request_id, notice_timestamp, signature, body)
  VALUES (v_org, p_hook, p_request_id, p_timestamp, p_signature, p_body)
  ON CONFLICT ON CONSTRAINT bank_feed_webhook_notice_request_uq DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RETURN 'duplicate';
  END IF;
  UPDATE ludy_finance.bank_feed_hook h SET last_seen_at = pg_catalog.clock_timestamp() WHERE h.org_id = v_org AND h.id = p_hook;
  PERFORM pg_catalog.pg_notify('ludy_outbox', '');
  RETURN 'accepted';
END $$;

-- ---------------------------------------------------------------------------
-- 4. Bounded claim returning NULL placeholders for dropped rows + generation/reject_token
-- ---------------------------------------------------------------------------

-- ludy:contract adr=0039
DROP FUNCTION IF EXISTS ludy_finance.bank_feed_hook_claim(integer);
CREATE FUNCTION ludy_finance.bank_feed_hook_claim(p_limit integer)
RETURNS TABLE (org_id uuid, hook_id uuid, connection_id uuid, provider text, request_id text, notice_timestamp text, signature text, body text, generation integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_cutoff timestamptz;
BEGIN
  -- ADR-0039: sweep every notice older than 10 minutes first, separately from p_limit.
  PERFORM ludy_finance.bank_feed_hook_sweep();
  v_cutoff := pg_catalog.clock_timestamp() - interval '10 minutes';
  RETURN QUERY
  WITH claimed AS (
    DELETE FROM ludy_finance.bank_feed_webhook_notice n
    WHERE (n.org_id, n.id) IN (
      SELECT q.org_id, q.id
      FROM ludy_finance.bank_feed_webhook_notice q
      ORDER BY q.received_at, q.id
      LIMIT LEAST(GREATEST(COALESCE(p_limit, 1), 1), 1000)
      FOR UPDATE SKIP LOCKED
    )
    RETURNING n.org_id AS c_org, n.hook_id AS c_hook, n.request_id AS c_request, n.notice_timestamp AS c_timestamp, n.signature AS c_signature, n.body AS c_body, n.received_at AS c_received_at, n.id AS c_id
  )
  SELECT CASE WHEN cl.c_received_at >= v_cutoff AND t.org_id IS NOT NULL THEN cl.c_org END,
         CASE WHEN cl.c_received_at >= v_cutoff AND t.org_id IS NOT NULL THEN COALESCE(h.reject_token, h.id) END,
         CASE WHEN cl.c_received_at >= v_cutoff AND t.org_id IS NOT NULL THEN h.channel_connection_id END,
         CASE WHEN cl.c_received_at >= v_cutoff AND t.org_id IS NOT NULL THEN c.provider END,
         CASE WHEN cl.c_received_at >= v_cutoff AND t.org_id IS NOT NULL THEN cl.c_request END,
         CASE WHEN cl.c_received_at >= v_cutoff AND t.org_id IS NOT NULL THEN cl.c_timestamp END,
         CASE WHEN cl.c_received_at >= v_cutoff AND t.org_id IS NOT NULL THEN cl.c_signature END,
         CASE WHEN cl.c_received_at >= v_cutoff AND t.org_id IS NOT NULL THEN cl.c_body END,
         CASE WHEN cl.c_received_at >= v_cutoff AND t.org_id IS NOT NULL THEN h.generation END
  FROM claimed cl
  LEFT JOIN ludy_finance.bank_feed_hook h
    ON h.org_id = cl.c_org AND h.id = cl.c_hook AND h.stopped_at IS NULL
  LEFT JOIN ludy_kernel.channel_connection c
    ON c.org_id = h.org_id AND c.id = h.channel_connection_id AND c.status = 'active'
  LEFT JOIN ludy_kernel.tenant t
    ON t.org_id = c.org_id AND t.status = 'active' AND ludy_kernel.org_app_on(t.org_id, 'finance')
  ORDER BY cl.c_received_at, cl.c_id;
END $$;

-- ---------------------------------------------------------------------------
-- 5. Require matching generation in ludy_finance.bank_feed_hook_reject (and keep 1-arg shim)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ludy_finance.bank_feed_hook_reject(p_hook uuid, p_generation integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_stopped boolean;
BEGIN
  IF p_hook IS NULL OR p_generation IS NULL OR p_generation < 1 THEN
    RETURN false;
  END IF;
  PERFORM pg_catalog.set_config('ludy.bank_feed_reject_op', '1', true);
  BEGIN
    UPDATE ludy_finance.bank_feed_hook h SET
      rejected_count = CASE
        WHEN h.rejected_window_start IS NULL OR h.rejected_window_start < v_now - interval '1 hour' THEN 1
        ELSE h.rejected_count + 1
      END,
      rejected_window_start = CASE
        WHEN h.rejected_window_start IS NULL OR h.rejected_window_start < v_now - interval '1 hour' THEN v_now
        ELSE h.rejected_window_start
      END,
      stopped_at = CASE
        WHEN h.stopped_at IS NOT NULL THEN h.stopped_at
        WHEN (CASE WHEN h.rejected_window_start IS NULL OR h.rejected_window_start < v_now - interval '1 hour' THEN 1 ELSE h.rejected_count + 1 END) >= 10 THEN v_now
      END
    WHERE COALESCE(h.reject_token, h.id) = p_hook AND h.generation = p_generation
    RETURNING h.stopped_at IS NOT NULL INTO v_stopped;
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_catalog.set_config('ludy.bank_feed_reject_op', '', true);
    RAISE;
  END;
  PERFORM pg_catalog.set_config('ludy.bank_feed_reject_op', '', true);
  RETURN COALESCE(v_stopped, false);
END $$;

-- Compatibility shim for workers deployed prior to this migration (or rolled back to one):
-- resolves the per-rotation token claim returned in hook_id so stale pre-rotation rejections
-- stay ignored while current-generation rejections still stop at 10.
CREATE OR REPLACE FUNCTION ludy_finance.bank_feed_hook_reject(p_hook uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_generation integer;
BEGIN
  IF p_hook IS NULL THEN
    RETURN false;
  END IF;
  SELECT h.generation INTO v_generation
  FROM ludy_finance.bank_feed_hook h
  WHERE COALESCE(h.reject_token, h.id) = p_hook;
  IF v_generation IS NULL THEN
    RETURN false;
  END IF;
  RETURN ludy_finance.bank_feed_hook_reject(p_hook, v_generation);
END $$;

-- ---------------------------------------------------------------------------
-- 6. Decode JSON escapes (including \uXXXX and surrogate pairs) in bank feed notice erasure
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ludy_finance.bank_feed_notice_decode_escapes(p_text text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_parts text[];
  v_n integer;
  v_i integer;
  v_pending_bs boolean;
  v_part text;
  v_c1 text;
  v_hex text;
  v_bytes bytea;
  v_cp integer;
  v_lo_bytes bytea;
  v_lo integer;
  v_combined integer;
BEGIN
  IF pg_catalog.strpos(p_text, '\') = 0 THEN
    RETURN p_text;
  END IF;
  v_parts := pg_catalog.string_to_array(p_text, '\');
  v_n := pg_catalog.array_length(v_parts, 1);
  IF v_n IS NULL OR v_n <= 1 THEN
    RETURN p_text;
  END IF;
  -- Rewrite segments of v_parts in place and join once with array_to_string to stay O(n).
  v_pending_bs := true;
  v_i := 2;
  WHILE v_i <= v_n LOOP
    v_part := v_parts[v_i];
    IF NOT v_pending_bs THEN
      v_pending_bs := true;
    ELSIF v_part = '' THEN
      v_parts[v_i] := '\';
      -- When v_i < v_n, this empty segment lies between two consecutive backslashes (\\),
      -- consuming both; when v_i = v_n, it is a trailing lone backslash at end of text.
      v_pending_bs := false;
    ELSE
      v_c1 := pg_catalog.left(v_part, 1);
      IF v_c1 = '"' THEN
        v_parts[v_i] := '"' || pg_catalog.substr(v_part, 2);
      ELSIF v_c1 = '/' THEN
        v_parts[v_i] := '/' || pg_catalog.substr(v_part, 2);
      ELSIF v_c1 = 'b' THEN
        v_parts[v_i] := pg_catalog.chr(8) || pg_catalog.substr(v_part, 2);
      ELSIF v_c1 = 'f' THEN
        v_parts[v_i] := pg_catalog.chr(12) || pg_catalog.substr(v_part, 2);
      ELSIF v_c1 = 'n' THEN
        v_parts[v_i] := pg_catalog.chr(10) || pg_catalog.substr(v_part, 2);
      ELSIF v_c1 = 'r' THEN
        v_parts[v_i] := pg_catalog.chr(13) || pg_catalog.substr(v_part, 2);
      ELSIF v_c1 = 't' THEN
        v_parts[v_i] := pg_catalog.chr(9) || pg_catalog.substr(v_part, 2);
      ELSIF v_c1 = 'u' AND v_part ~ '^u[0-9A-Fa-f]{4}' THEN
        v_hex := pg_catalog.substr(v_part, 2, 4);
        v_bytes := pg_catalog.decode(v_hex, 'hex');
        v_cp := pg_catalog.get_byte(v_bytes, 0) * 256 + pg_catalog.get_byte(v_bytes, 1);
        IF v_cp BETWEEN 55296 AND 56319
           AND pg_catalog.length(v_part) = 5
           AND v_i < v_n
           AND v_parts[v_i + 1] ~ '^u[Dd][CcDdEeFf][0-9A-Fa-f]{2}' THEN
          v_lo_bytes := pg_catalog.decode(pg_catalog.substr(v_parts[v_i + 1], 2, 4), 'hex');
          v_lo := pg_catalog.get_byte(v_lo_bytes, 0) * 256 + pg_catalog.get_byte(v_lo_bytes, 1);
          v_combined := 65536 + ((v_cp - 55296) * 1024) + (v_lo - 56320);
          v_parts[v_i] := pg_catalog.chr(v_combined) || pg_catalog.substr(v_parts[v_i + 1], 6);
          v_parts[v_i + 1] := '';
          v_i := v_i + 1;
        ELSIF v_cp = 0 THEN
          -- PostgreSQL text cannot store NUL; use U+FFFD (never space, so adjacent digit groups stay separated).
          v_parts[v_i] := pg_catalog.chr(65533) || pg_catalog.substr(v_part, 6);
        ELSIF v_cp BETWEEN 55296 AND 57343 THEN
          -- Unpaired UTF-16 surrogate: emit U+FFFD replacement character rather than failing chr().
          v_parts[v_i] := pg_catalog.chr(65533) || pg_catalog.substr(v_part, 6);
        ELSE
          v_parts[v_i] := pg_catalog.chr(v_cp) || pg_catalog.substr(v_part, 6);
        END IF;
      ELSE
        -- Keep unrecognized escapes literal so malformed/non-JSON payloads stay intact.
        v_parts[v_i] := '\' || v_part;
      END IF;
      v_pending_bs := true;
    END IF;
    v_i := v_i + 1;
  END LOOP;
  RETURN pg_catalog.array_to_string(v_parts, '');
END $$;

CREATE OR REPLACE FUNCTION ludy_finance.bank_feed_is_deep_json(p_text text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_bytes bytea := pg_catalog.convert_to(p_text, 'UTF8');
  v_len integer := pg_catalog.octet_length(v_bytes);
  v_pos integer := 0;
  v_stack boolean[];
  v_depth integer := 0;
  v_mode text := 'VALUE';
  v_after_string text;
  v_b integer;
  v_esc integer;
  v_closed boolean;
  v_tok integer;
  v_hb integer;
  v_k integer;
BEGIN
  -- Linear O(n) iterative RFC 8259 validator over UTF-8 bytea (O(1) get_byte and boolean[] stack) used only when
  -- pg_input_is_valid hits max_stack_depth (54001), so deeply nested valid JSON still decodes \uXXXX escapes.
  WHILE v_pos < v_len LOOP
    IF v_mode = 'STRING' THEN
      v_pos := v_pos + 1;
      v_closed := false;
      WHILE v_pos < v_len LOOP
        v_b := pg_catalog.get_byte(v_bytes, v_pos);
        IF v_b = 34 THEN
          v_closed := true;
          v_pos := v_pos + 1;
          EXIT;
        ELSIF v_b = 92 THEN
          IF v_pos + 1 >= v_len THEN
            RETURN false;
          END IF;
          v_esc := pg_catalog.get_byte(v_bytes, v_pos + 1);
          IF v_esc IN (34, 92, 47, 98, 102, 110, 114, 116) THEN
            v_pos := v_pos + 2;
          ELSIF v_esc = 117 AND v_pos + 5 < v_len THEN
            FOR v_k IN 2..5 LOOP
              v_hb := pg_catalog.get_byte(v_bytes, v_pos + v_k);
              IF NOT ((v_hb BETWEEN 48 AND 57) OR (v_hb BETWEEN 65 AND 70) OR (v_hb BETWEEN 97 AND 102)) THEN
                RETURN false;
              END IF;
            END LOOP;
            v_pos := v_pos + 6;
          ELSE
            RETURN false;
          END IF;
        ELSIF v_b < 32 THEN
          RETURN false;
        ELSE
          v_pos := v_pos + 1;
        END IF;
      END LOOP;
      IF NOT v_closed THEN
        RETURN false;
      END IF;
      v_mode := v_after_string;
      CONTINUE;
    END IF;

    WHILE v_pos < v_len AND pg_catalog.get_byte(v_bytes, v_pos) IN (32, 9, 10, 13) LOOP
      v_pos := v_pos + 1;
    END LOOP;
    IF v_pos >= v_len THEN
      EXIT;
    END IF;
    v_b := pg_catalog.get_byte(v_bytes, v_pos);

    IF v_mode = 'ARRAY_FIRST' THEN
      IF v_b = 93 THEN
        v_depth := v_depth - 1;
        v_pos := v_pos + 1;
        v_mode := 'AFTER_VALUE';
      ELSE
        v_mode := 'VALUE';
      END IF;
      CONTINUE;
    ELSIF v_mode = 'KEY_OR_END' THEN
      IF v_b = 125 THEN
        v_depth := v_depth - 1;
        v_pos := v_pos + 1;
        v_mode := 'AFTER_VALUE';
      ELSE
        v_mode := 'KEY';
      END IF;
      CONTINUE;
    ELSIF v_mode = 'KEY' THEN
      IF v_b <> 34 THEN
        RETURN false;
      END IF;
      v_after_string := 'COLON';
      v_mode := 'STRING';
      CONTINUE;
    ELSIF v_mode = 'COLON' THEN
      IF v_b <> 58 THEN
        RETURN false;
      END IF;
      v_pos := v_pos + 1;
      v_mode := 'VALUE';
    ELSIF v_mode = 'VALUE' THEN
      IF v_b = 123 THEN
        v_depth := v_depth + 1;
        v_stack[v_depth] := true;
        v_pos := v_pos + 1;
        v_mode := 'KEY_OR_END';
      ELSIF v_b = 91 THEN
        v_depth := v_depth + 1;
        v_stack[v_depth] := false;
        v_pos := v_pos + 1;
        v_mode := 'ARRAY_FIRST';
      ELSIF v_b = 34 THEN
        v_after_string := 'AFTER_VALUE';
        v_mode := 'STRING';
        CONTINUE;
      ELSIF v_b = 116 AND v_pos + 3 < v_len AND pg_catalog.get_byte(v_bytes, v_pos + 1) = 114 AND pg_catalog.get_byte(v_bytes, v_pos + 2) = 117 AND pg_catalog.get_byte(v_bytes, v_pos + 3) = 101 THEN
        v_pos := v_pos + 4;
        v_mode := 'AFTER_VALUE';
      ELSIF v_b = 102 AND v_pos + 4 < v_len AND pg_catalog.get_byte(v_bytes, v_pos + 1) = 97 AND pg_catalog.get_byte(v_bytes, v_pos + 2) = 108 AND pg_catalog.get_byte(v_bytes, v_pos + 3) = 115 AND pg_catalog.get_byte(v_bytes, v_pos + 4) = 101 THEN
        v_pos := v_pos + 5;
        v_mode := 'AFTER_VALUE';
      ELSIF v_b = 110 AND v_pos + 3 < v_len AND pg_catalog.get_byte(v_bytes, v_pos + 1) = 117 AND pg_catalog.get_byte(v_bytes, v_pos + 2) = 108 AND pg_catalog.get_byte(v_bytes, v_pos + 3) = 108 THEN
        v_pos := v_pos + 4;
        v_mode := 'AFTER_VALUE';
      ELSIF v_b = 45 OR (v_b BETWEEN 48 AND 57) THEN
        IF v_b = 45 THEN
          v_pos := v_pos + 1;
          IF v_pos >= v_len THEN
            RETURN false;
          END IF;
          v_tok := pg_catalog.get_byte(v_bytes, v_pos);
        ELSE
          v_tok := v_b;
        END IF;
        IF v_tok = 48 THEN
          v_pos := v_pos + 1;
        ELSIF v_tok BETWEEN 49 AND 57 THEN
          v_pos := v_pos + 1;
          WHILE v_pos < v_len AND (pg_catalog.get_byte(v_bytes, v_pos) BETWEEN 48 AND 57) LOOP
            v_pos := v_pos + 1;
          END LOOP;
        ELSE
          RETURN false;
        END IF;
        IF v_pos < v_len AND pg_catalog.get_byte(v_bytes, v_pos) = 46 THEN
          v_pos := v_pos + 1;
          IF v_pos >= v_len OR NOT (pg_catalog.get_byte(v_bytes, v_pos) BETWEEN 48 AND 57) THEN
            RETURN false;
          END IF;
          WHILE v_pos < v_len AND (pg_catalog.get_byte(v_bytes, v_pos) BETWEEN 48 AND 57) LOOP
            v_pos := v_pos + 1;
          END LOOP;
        END IF;
        IF v_pos < v_len AND pg_catalog.get_byte(v_bytes, v_pos) IN (101, 69) THEN
          v_pos := v_pos + 1;
          IF v_pos < v_len AND pg_catalog.get_byte(v_bytes, v_pos) IN (43, 45) THEN
            v_pos := v_pos + 1;
          END IF;
          IF v_pos >= v_len OR NOT (pg_catalog.get_byte(v_bytes, v_pos) BETWEEN 48 AND 57) THEN
            RETURN false;
          END IF;
          WHILE v_pos < v_len AND (pg_catalog.get_byte(v_bytes, v_pos) BETWEEN 48 AND 57) LOOP
            v_pos := v_pos + 1;
          END LOOP;
        END IF;
        v_mode := 'AFTER_VALUE';
      ELSE
        RETURN false;
      END IF;
    ELSIF v_mode = 'AFTER_VALUE' THEN
      IF v_depth = 0 THEN
        RETURN false;
      END IF;
      IF v_b = 44 THEN
        v_pos := v_pos + 1;
        IF v_stack[v_depth] THEN
          v_mode := 'KEY';
        ELSE
          v_mode := 'VALUE';
        END IF;
      ELSIF v_b = 125 AND v_stack[v_depth] THEN
        v_depth := v_depth - 1;
        v_pos := v_pos + 1;
      ELSIF v_b = 93 AND NOT v_stack[v_depth] THEN
        v_depth := v_depth - 1;
        v_pos := v_pos + 1;
      ELSE
        RETURN false;
      END IF;
    END IF;
  END LOOP;
  RETURN v_mode = 'AFTER_VALUE' AND v_depth = 0;
END $$;

CREATE OR REPLACE FUNCTION ludy_finance.bank_feed_notice_search_text(p_body text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  -- Rows without backslashes have no escapes and skip JSON parsing completely.
  IF pg_catalog.strpos(p_body, '\') = 0 THEN
    RETURN p_body;
  END IF;
  IF pg_catalog.pg_input_is_valid(p_body, 'json') THEN
    RETURN ludy_finance.bank_feed_notice_decode_escapes(p_body);
  END IF;
  RETURN p_body;
EXCEPTION
  WHEN statement_too_complex OR program_limit_exceeded THEN
    -- Validate iteratively when pg_input_is_valid hits max_stack_depth (54001) so deeply nested valid JSON still decodes escapes.
    IF ludy_finance.bank_feed_is_deep_json(p_body) THEN
      RETURN ludy_finance.bank_feed_notice_decode_escapes(p_body);
    END IF;
    RETURN p_body;
END $$;

CREATE OR REPLACE FUNCTION ludy_finance.personal_data_erase_bank_feed_notice(p_kind text, p_value text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_rows integer;
BEGIN
  IF v_org IS NULL OR ludy_kernel.ctx_actor_type() IS DISTINCT FROM 'user' OR (ludy_kernel.ctx_verified() ->> 'role') IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'PERSONAL_DATA_OWNER_ONLY' USING ERRCODE = '42501';
  END IF;
  PERFORM ludy_kernel.text_mention_pattern(p_kind, p_value);
  DELETE FROM ludy_finance.bank_feed_webhook_notice n
  WHERE n.org_id = v_org
    AND ludy_kernel.text_mentions(ludy_finance.bank_feed_notice_search_text(n.body), p_kind, p_value);
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END $$;

-- ---------------------------------------------------------------------------
-- 7. Grants
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION
  ludy_finance.bank_feed_hook_rotate_guard(),
  ludy_finance.bank_feed_hook_rotate_cleanup(),
  ludy_finance.bank_feed_webhook_backlog_on_insert(),
  ludy_finance.bank_feed_webhook_backlog_on_delete(),
  ludy_finance.bank_feed_webhook_backlog_on_truncate(),
  ludy_finance.bank_feed_hook_set(uuid, text),
  ludy_finance.bank_feed_hook_put_notice(uuid, text, text, text, text, text),
  ludy_finance.bank_feed_hook_claim(integer),
  ludy_finance.bank_feed_hook_reject(uuid, integer),
  ludy_finance.bank_feed_hook_reject(uuid),
  ludy_finance.bank_feed_notice_decode_escapes(text),
  ludy_finance.bank_feed_is_deep_json(text),
  ludy_finance.bank_feed_notice_search_text(text),
  ludy_finance.personal_data_erase_bank_feed_notice(text, text)
FROM PUBLIC;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT rolname FROM pg_catalog.pg_roles
    WHERE (rolname LIKE 'ludy\_%' OR rolname LIKE 'crove\_%') AND rolname <> current_user
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON FUNCTION ludy_finance.bank_feed_hook_rotate_guard(), ludy_finance.bank_feed_hook_rotate_cleanup(), ludy_finance.bank_feed_webhook_backlog_on_insert(), ludy_finance.bank_feed_webhook_backlog_on_delete(), ludy_finance.bank_feed_webhook_backlog_on_truncate(), ludy_finance.bank_feed_hook_set(uuid, text), ludy_finance.bank_feed_hook_put_notice(uuid, text, text, text, text, text), ludy_finance.bank_feed_hook_claim(integer), ludy_finance.bank_feed_hook_reject(uuid, integer), ludy_finance.bank_feed_hook_reject(uuid), ludy_finance.bank_feed_notice_decode_escapes(text), ludy_finance.bank_feed_is_deep_json(text), ludy_finance.bank_feed_notice_search_text(text), ludy_finance.personal_data_erase_bank_feed_notice(text, text) FROM %I',
      r.rolname
    );
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION
  ludy_finance.bank_feed_hook_set(uuid, text),
  ludy_finance.bank_feed_hook_put_notice(uuid, text, text, text, text, text),
  ludy_finance.personal_data_erase_bank_feed_notice(text, text)
TO ludy_app;
GRANT EXECUTE ON FUNCTION
  ludy_finance.bank_feed_hook_claim(integer),
  ludy_finance.bank_feed_hook_reject(uuid, integer),
  ludy_finance.bank_feed_hook_reject(uuid)
TO ludy_worker;
