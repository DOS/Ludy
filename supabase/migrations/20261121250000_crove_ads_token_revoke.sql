-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove Ads W2-1 (issue #2296, ADR-0043 point 4, ADR-0025 amendment of 2026-11-03): the revoke at the platform of the token of a closed ads
-- connection. Closing an ads write connection (or an ads read connection whose token holds a spend permission) used to drop the sealed token and
-- leave the person's permissions valid at Meta, and the pause of what Ludy had launched could not run at all. The owner approved, on 2026-11-03, that Ludy
-- keeps a sealed copy of that one token for at most seven days, used only to revoke the permissions at the platform. Nothing here calls a platform and
-- nothing spends: the worker does the call. Idempotent; applied files stay untouched.
--
-- crove_ads.ad_token_revoke   the obligation and its visible state: which connection's token, how many tries, when the next one is due, how it ended
--                             (done: the platform removed the permissions, or no longer accepts the token; gave_up: ten tries or seven days passed, and
--                             the screen says to remove the app in the platform's settings). Ids, states, counts and error codes only, never the token.
--                             Tenant roles read it; nobody writes it but the definers below (the system's command records an outcome through one).
--
-- crove_ads.ad_token_seal     the sealed copy: the same envelope the credential table held (same key, same binding to org, provider and account), one
--                             row per obligation. Definer-only machinery like crove_kernel.credential: no grant to any role. It is opened by one
--                             worker-only definer (token_seal_get), and it ends in the same statement that ends the obligation (the guard
--                             deletes it when the state leaves 'pending'), or at once by the org's purge.
--
-- crove_ads.token_hold        a BEFORE DELETE trigger on crove_kernel.credential: whatever path drops the credential of such a connection (the
--                             owner's switch-off, an account's disconnect, a replaced connection, a link that was refused, the system closing the
--                             connection of a member who left) copies the envelope into the seal first, in the same transaction, and opens the
--                             obligation. Not held: a platform's own data deletion (the person already removed the app at the platform), an org
--                             that is not active (the purge wipes), a read connection whose recorded scopes hold no spend permission (the
--                             fail-safe close of a reading connection is local), and any provider that is not an ad one.
--
-- crove_ads.ad_token_revoke_guard   holds the row whatever path reaches it: born pending with no tries; its identity never changes; a settled
--                             obligation never changes again; done needs the try that did it; gave_up(attempts) needs the tenth try and gave_up(age)
--                             the seventh day; and whatever ends the obligation deletes the sealed copy.
--
-- The worker's definers (each refuses a login that is not a member of crove_worker):
--   token_revoke_due     claims the due obligations (a lease of ten minutes, so a crashed worker's try is found again) and names them by id.
--   token_seal_get       opens one pending obligation's sealed copy, for one call: DELETE /me/permissions.
--   token_revoke_settle  records the outcome of a try (the policy is modules/ads/src/token-revoke.ts).
--   token_revoke_expire  settles the obligations past their age without a try and wipes their copies.
--   write_orphans        lists the active write connections whose connector is no longer an owner or admin (a removed member's), to be closed so the
--                        revoke runs and the copy is wiped; the sweep closes them with the kernel's system command (20261121250200 adds the check
--                        that command asks the database under the row's lock).
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_ads.ad_token_revoke (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  -- The closed connection the token belonged to (it stays as history; the purge deletes this row first).
  connection_id uuid NOT NULL,
  -- The ad account the connection served, when it was attached to one (no foreign key: erasing an account leaves the obligation).
  ad_account_id uuid,
  provider text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9]{1,30}_ads$'),
  external_account_id text NOT NULL CHECK (pg_catalog.length(external_account_id) BETWEEN 1 AND 200),
  -- The write token, or the read token of the same app that holds a spend permission.
  kind text NOT NULL CHECK (kind IN ('write', 'read_spend')),
  -- Why the connection closed, as its status reason says (a code, never a sentence).
  reason text NOT NULL CHECK (reason ~ '^[a-z][a-z_]{1,39}$'),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'done', 'gave_up')),
  how_done text CHECK (how_done IN ('revoked', 'already_invalid', 'sandbox')),
  give_up text CHECK (give_up IN ('attempts', 'age')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 10),
  next_attempt_at timestamptz DEFAULT pg_catalog.now(),
  last_error_kind text CHECK (last_error_kind IN ('rate_limited', 'transient', 'permission', 'bad_request', 'unknown')),
  last_error_code text CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Za-z0-9_.]{1,64}$'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  settled_at timestamptz,
  PRIMARY KEY (org_id, id),
  CONSTRAINT ad_token_revoke_connection_fk FOREIGN KEY (org_id, connection_id) REFERENCES crove_kernel.channel_connection (org_id, id),
  -- Pending means due at some time and not settled; done names how, gave_up names why, and only those two are settled.
  CONSTRAINT ad_token_revoke_pending_ck CHECK ((state = 'pending') = (settled_at IS NULL) AND (state = 'pending') = (next_attempt_at IS NOT NULL)),
  CONSTRAINT ad_token_revoke_done_ck CHECK ((state = 'done') = (how_done IS NOT NULL)),
  CONSTRAINT ad_token_revoke_gave_up_ck CHECK ((state = 'gave_up') = (give_up IS NOT NULL))
);
-- One obligation per closed connection: a second drop of the same connection's credential changes nothing.
CREATE UNIQUE INDEX IF NOT EXISTS ad_token_revoke_connection_uq ON crove_ads.ad_token_revoke (org_id, connection_id);
-- The screen lists an account's obligations.
CREATE INDEX IF NOT EXISTS ad_token_revoke_account_idx ON crove_ads.ad_token_revoke (org_id, ad_account_id) WHERE ad_account_id IS NOT NULL;
-- The worker's claim and the age sweep look at the pending ones only.
CREATE INDEX IF NOT EXISTS ad_token_revoke_pending_idx ON crove_ads.ad_token_revoke (next_attempt_at, created_at) WHERE state = 'pending';

SELECT crove_kernel.apply_tenant_rls('crove_ads.ad_token_revoke');
-- Tenant roles read it and nothing else: every write is a definer's.
REVOKE INSERT, UPDATE, DELETE ON crove_ads.ad_token_revoke FROM crove_tenant;

CREATE TABLE IF NOT EXISTS crove_ads.ad_token_seal (
  org_id uuid NOT NULL,
  revoke_id uuid NOT NULL,
  -- Which credential key sealed the envelope, for rotation (a rotation keeps the previous key for seven days at least).
  key_id text NOT NULL CHECK (key_id ~ '^[A-Za-z0-9_.-]{1,64}$'),
  envelope bytea NOT NULL CHECK (pg_catalog.octet_length(envelope) BETWEEN 1 AND 65536),
  sealed_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, revoke_id),
  CONSTRAINT ad_token_seal_revoke_fk FOREIGN KEY (org_id, revoke_id) REFERENCES crove_ads.ad_token_revoke (org_id, id) ON DELETE CASCADE
);
ALTER TABLE crove_ads.ad_token_seal ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON crove_ads.ad_token_seal FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
SELECT crove_kernel.agent_write_guard_install('crove_ads.ad_token_seal');

-- The guard of the obligation, whatever path reaches it.
CREATE OR REPLACE FUNCTION crove_ads.ad_token_revoke_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'pending' OR NEW.attempts <> 0 OR NEW.how_done IS NOT NULL OR NEW.give_up IS NOT NULL OR NEW.last_error_kind IS NOT NULL OR NEW.last_error_code IS NOT NULL OR NEW.settled_at IS NOT NULL THEN
      RAISE EXCEPTION 'ADS_REVOKE_FORBIDDEN' USING ERRCODE = '42501', DETAIL = 'an obligation is born pending, with no tries';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.org_id, NEW.id, NEW.connection_id, NEW.ad_account_id, NEW.provider, NEW.external_account_id, NEW.kind, NEW.reason, NEW.created_at)
     IS DISTINCT FROM (OLD.org_id, OLD.id, OLD.connection_id, OLD.ad_account_id, OLD.provider, OLD.external_account_id, OLD.kind, OLD.reason, OLD.created_at) THEN
    RAISE EXCEPTION 'ADS_REVOKE_FORBIDDEN' USING ERRCODE = '42501', DETAIL = 'an obligation keeps its connection, its token kind and its reason';
  END IF;
  IF NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF OLD.state <> 'pending' THEN
    RAISE EXCEPTION 'ADS_REVOKE_FORBIDDEN' USING ERRCODE = '42501', DETAIL = 'a settled obligation never changes';
  END IF;
  -- A try is counted once, never taken back; a claim (the lease) moves the next time only.
  IF NEW.attempts NOT IN (OLD.attempts, OLD.attempts + 1) THEN
    RAISE EXCEPTION 'ADS_REVOKE_FORBIDDEN' USING ERRCODE = '42501', DETAIL = 'tries are counted one at a time';
  END IF;
  IF NEW.state = 'done' AND NEW.attempts <> OLD.attempts + 1 THEN
    RAISE EXCEPTION 'ADS_REVOKE_FORBIDDEN' USING ERRCODE = '42501', DETAIL = 'done needs the try that did it';
  END IF;
  -- A copy is never given up on without the tenth try or the seventh day (a few minutes of slack for a clock that differs from the database's).
  IF NEW.state = 'gave_up' AND NOT (
    (NEW.give_up = 'attempts' AND NEW.attempts >= 10)
    OR (NEW.give_up = 'age' AND pg_catalog.clock_timestamp() - OLD.created_at >= pg_catalog.make_interval(days => 7) - pg_catalog.make_interval(mins => 5))
  ) THEN
    RAISE EXCEPTION 'ADS_REVOKE_FORBIDDEN' USING ERRCODE = '42501', DETAIL = 'a copy is kept until the tenth try or the seventh day';
  END IF;
  IF NEW.state <> 'pending' THEN
    NEW.settled_at := pg_catalog.clock_timestamp();
    NEW.next_attempt_at := NULL;
    -- Whatever ends the obligation ends the copy, in the same statement.
    DELETE FROM crove_ads.ad_token_seal s WHERE s.org_id = NEW.org_id AND s.revoke_id = NEW.id;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_ads.ad_token_revoke_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

DROP TRIGGER IF EXISTS ad_token_revoke_guard ON crove_ads.ad_token_revoke;
CREATE TRIGGER ad_token_revoke_guard BEFORE INSERT OR UPDATE ON crove_ads.ad_token_revoke FOR EACH ROW EXECUTE FUNCTION crove_ads.ad_token_revoke_guard();
ALTER TABLE crove_ads.ad_token_revoke ENABLE ALWAYS TRIGGER ad_token_revoke_guard;

-- The hold: the credential of such a connection is copied into the seal, in the transaction that drops it, before it goes.
CREATE OR REPLACE FUNCTION crove_ads.token_hold() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_connection crove_kernel.channel_connection%ROWTYPE;
  v_kind text;
  v_revoke uuid;
BEGIN
  SELECT c.* INTO v_connection FROM crove_kernel.channel_connection c WHERE c.org_id = OLD.org_id AND c.id = OLD.connection_id;
  IF NOT FOUND THEN
    RETURN OLD;
  END IF;
  -- The token that can change campaigns: a write connection's, or a read connection's whose recorded scopes hold a spend permission.
  IF v_connection.provider IN ('metawrite_ads', 'sandboxwrite_ads') THEN
    v_kind := 'write';
  ELSIF v_connection.provider ~ '^[a-z][a-z0-9]{1,30}_ads$' AND v_connection.scopes && ARRAY['ads_management', 'business_management']::text[] THEN
    v_kind := 'read_spend';
  ELSE
    RETURN OLD;
  END IF;
  -- The platform's own data deletion: the person removed the app, so nothing is left to revoke. An org being closed: the purge wipes.
  IF v_connection.status_reason IS NOT DISTINCT FROM 'platform_deletion' THEN
    RETURN OLD;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM crove_kernel.tenant t WHERE t.org_id = OLD.org_id AND t.status = 'active') THEN
    RETURN OLD;
  END IF;
  INSERT INTO crove_ads.ad_token_revoke AS r (org_id, connection_id, ad_account_id, provider, external_account_id, kind, reason)
  VALUES (
    OLD.org_id, OLD.connection_id,
    (SELECT a.id FROM crove_ads.ad_account a WHERE a.org_id = OLD.org_id AND (a.write_connection_id = OLD.connection_id OR a.channel_connection_id = OLD.connection_id) ORDER BY a.id LIMIT 1),
    v_connection.provider, v_connection.external_account_id, v_kind,
    CASE WHEN v_connection.status_reason ~ '^[a-z][a-z_]{1,39}$' THEN v_connection.status_reason ELSE 'other' END)
  ON CONFLICT (org_id, connection_id) DO NOTHING
  RETURNING r.id INTO v_revoke;
  IF v_revoke IS NOT NULL THEN
    INSERT INTO crove_ads.ad_token_seal (org_id, revoke_id, key_id, envelope) VALUES (OLD.org_id, v_revoke, OLD.key_id, OLD.envelope);
  END IF;
  RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION crove_ads.token_hold() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

DROP TRIGGER IF EXISTS token_hold ON crove_kernel.credential;
CREATE TRIGGER token_hold BEFORE DELETE ON crove_kernel.credential FOR EACH ROW EXECUTE FUNCTION crove_ads.token_hold();
ALTER TABLE crove_kernel.credential ENABLE ALWAYS TRIGGER token_hold;

-- The worker claims the due obligations: pending, due, a lease of ten minutes on each (the next try's time moves ahead, so a second worker passes
-- it by and a crashed one's is found again). Answers ids and the provider, never anything sealed.
CREATE OR REPLACE FUNCTION crove_ads.token_revoke_due(p_limit integer) RETURNS TABLE (org_id uuid, id uuid, provider text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'ADS_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  WITH due AS (
    SELECT r.org_id, r.id FROM crove_ads.ad_token_revoke r
    WHERE r.state = 'pending' AND r.next_attempt_at <= pg_catalog.now()
    ORDER BY r.next_attempt_at, r.id
    LIMIT LEAST(GREATEST(p_limit, 1), 100)
    FOR UPDATE SKIP LOCKED
  )
  UPDATE crove_ads.ad_token_revoke r SET next_attempt_at = pg_catalog.now() + pg_catalog.make_interval(mins => 10)
  FROM due WHERE r.org_id = due.org_id AND r.id = due.id
  RETURNING r.org_id, r.id, r.provider;
END $$;

-- The sealed copy of one pending obligation, for the worker, for one call. Not the connector's membership: a member who left does not end the
-- obligation, the revoke is tried first. Raises ADS_SEAL_GONE (P0002) when the obligation is not pending or holds no copy.
CREATE OR REPLACE FUNCTION crove_ads.token_seal_get(p_org uuid, p_revoke uuid) RETURNS TABLE (key_id text, envelope bytea, provider text, external_account_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'ADS_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT s.key_id, s.envelope, r.provider, r.external_account_id
    FROM crove_ads.ad_token_revoke r JOIN crove_ads.ad_token_seal s ON s.org_id = r.org_id AND s.revoke_id = r.id
    WHERE r.org_id = p_org AND r.id = p_revoke AND r.state = 'pending';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ADS_SEAL_GONE' USING ERRCODE = 'P0002';
  END IF;
END $$;

-- Records the outcome of one try (worker login only): the policy computes it (modules/ads/src/token-revoke.ts), the guard holds it to the rules.
CREATE OR REPLACE FUNCTION crove_ads.token_revoke_settle(
  p_org uuid, p_id uuid, p_state text, p_attempts integer, p_next timestamptz, p_how text, p_give_up text, p_error_kind text, p_error_code text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'ADS_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  UPDATE crove_ads.ad_token_revoke r
  SET state = p_state, attempts = p_attempts, next_attempt_at = p_next, how_done = p_how, give_up = p_give_up,
      last_error_kind = COALESCE(p_error_kind, r.last_error_kind), last_error_code = COALESCE(p_error_code, r.last_error_code)
  WHERE r.org_id = p_org AND r.id = p_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ADS_REVOKE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
END $$;

-- The obligations past their age, settled without a try and their copies wiped (worker login only). Answers how many.
CREATE OR REPLACE FUNCTION crove_ads.token_revoke_expire() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_n integer;
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'ADS_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  UPDATE crove_ads.ad_token_revoke r SET state = 'gave_up', give_up = 'age', next_attempt_at = NULL
  WHERE r.state = 'pending' AND r.created_at <= pg_catalog.now() - pg_catalog.make_interval(days => 7);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

-- The active write connections whose connector is no longer an owner or admin of the org (removed, demoted or disabled), after a key, in key order
-- (worker login only): the sweep closes each with the kernel's system command, which asks crove_kernel.channel_connector_gone again under the row's lock
-- (the same test), so the revoke runs and the credential is wiped. An expired or failed connection is not listed: its token is no longer accepted.
CREATE OR REPLACE FUNCTION crove_ads.write_orphans(p_after_org uuid, p_after_id uuid, p_limit integer) RETURNS TABLE (org_id uuid, connection_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'ADS_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT c.org_id, c.id
  FROM crove_kernel.channel_connection c
  JOIN crove_kernel.tenant t ON t.org_id = c.org_id AND t.status = 'active'
  WHERE c.provider IN ('metawrite_ads', 'sandboxwrite_ads') AND c.status = 'active'
    AND (p_after_org IS NULL OR (c.org_id, c.id) > (p_after_org, p_after_id))
    AND NOT EXISTS (
      SELECT 1 FROM crove_kernel.tenant_member m JOIN crove_kernel.user_account u ON u.id = m.user_id
      WHERE m.org_id = c.org_id AND m.user_id = c.connected_by AND m.role IN ('owner', 'admin') AND u.disabled_at IS NULL
    )
  ORDER BY c.org_id, c.id
  LIMIT LEAST(GREATEST(p_limit, 1), 500);
END $$;

REVOKE ALL ON FUNCTION crove_ads.token_revoke_due(integer), crove_ads.token_seal_get(uuid, uuid),
  crove_ads.token_revoke_settle(uuid, uuid, text, integer, timestamptz, text, text, text, text), crove_ads.token_revoke_expire(),
  crove_ads.write_orphans(uuid, uuid, integer) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_ads.token_revoke_due(integer), crove_ads.token_seal_get(uuid, uuid),
  crove_ads.token_revoke_settle(uuid, uuid, text, integer, timestamptz, text, text, text, text), crove_ads.token_revoke_expire(),
  crove_ads.write_orphans(uuid, uuid, integer) TO crove_worker;

-- The job's queue: no data at all (a sweep on a schedule).
SELECT crove_jobs.create_queue('ads-revoke', '{"policy":"standard","deadLetter":"kernel-job.dlq"}'::jsonb);
