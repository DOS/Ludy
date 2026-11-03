-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove Ads W2-1 (issue #2296, ADR-0043 point 4, ADR-0025 amendment of 2026-11-03): the revoke at the platform of the token of a closed ads connection.
-- Closing an ads write connection (or an ads read connection whose token holds a spend permission) used to drop the sealed token and leave the person's
-- permissions valid at Meta, and the pause of what Ludy had launched could not run at all. The owner approved, on 2026-11-03, that Ludy keeps a sealed copy
-- of that one token for at most seven days, used only to revoke the permissions at the platform, for Meta's ads providers (metawrite_ads, and meta_ads with a
-- recorded spend permission) and the offline sandbox; another platform needs its own decision. Nothing here calls a platform and nothing spends: the worker
-- does the call. Idempotent; applied files stay untouched.
--
-- crove_ads.ad_token_revoke   the obligation and its visible state: which connection's token, how many tries, when the next one is due, how it ended
--                             (done: the platform removed the permissions, the person had removed the app, another live connection of the same person needs
--                             the grant, or the account was connected again; gave_up: ten tries, seven days, or the finding that nothing can be revoked from
--                             the copy, and the screen says to remove the app in the platform's settings). Ids, states, counts and error codes only, never the
--                             token. Tenant roles read it; nobody writes it but the definers below, and none deletes. It keeps the connection's id with no
--                             foreign key: a copy must outlive a connection row that is deleted (a cascade, an erasure), and must not stop its deletion.
--
-- crove_ads.ad_token_seal     the sealed copy: the same envelope the credential table held (same key, same binding to org, provider and account), one
--                             row per obligation, and the lease of the sweep that is working on it (an expiry and a fencing token, which tenant roles cannot
--                             read). Definer-only machinery like crove_kernel.credential: no grant to any role. It is opened by one worker-only definer
--                             (token_seal_get), and it ends in the same statement that ends the obligation (the guard deletes it when the state leaves
--                             'pending'), or at once by the org's purge.
--
-- The hold               two BEFORE DELETE triggers, both SECURITY DEFINER and owned by the installer, with no grant to any role: token_hold on
--                             crove_kernel.credential, token_hold_connection on crove_kernel.channel_connection (a deleted connection row cascades to its
--                             credential, whose own trigger no longer finds the row). Whatever path drops the credential of such a connection (the owner's
--                             switch-off, an account's disconnect, a link that was refused, the system closing the connection of a member who left, a cascade)
--                             copies the envelope into the seal first, in the same statement, so a live credential is never copied, and opens the obligation,
--                             once per connection (a unique index). It skips every provider outside the list above, a platform's own data deletion (the
--                             person already removed the app), a read connection whose recorded scopes hold no spend permission, and an org that is not active
--                             (it takes the tenant row FOR SHARE, in the purge's lock order, so a close racing the purge either finishes first and the purge
--                             wipes it, or finds the org closed and holds nothing). An UPDATE of the credential (a reseal during a key rotation) holds nothing.
--
-- crove_ads.token_reconnected an AFTER INSERT trigger on crove_kernel.credential: a credential sealed for a new ads connection of an account whose earlier
--                             connection has a pending revoke cancels that revoke (done, how reconnected) and wipes its copy in the same transaction, since
--                             Meta's permission belongs to the person and the app and the revoke would cut the grant the person has just given again.
--                             (Not on UPDATE: a reseal of the key during a rotation updates the row and is no reconnect.)
--
-- crove_ads.ad_token_revoke_guard   holds the row whatever path reaches it: born pending with no tries; its identity never changes; a settled obligation
--                             never changes again; tries are counted one at a time (by token_seal_get only, when the copy is opened); done needs a try
--                             (except when no call was made: shared grant, reconnected); gave_up by attempts needs the tenth try and by age the seventh
--                             day (unrevocable is the finding that nothing can be revoked from the copy); and whatever ends the obligation deletes the
--                             sealed copy.
--
-- The worker's definers (each refuses a login that is not a member of crove_worker):
--   token_revoke_due      claims the due obligations: a lease of ten minutes and a fencing token on each, and names them by id, provider and token.
--   token_grant_shared    a boolean and nothing else: whether another live connection of the same grantor (the keyed hash of the platform user), in any
--                         org, needs the grant, so the revoke is not called (it would cut that connection too).
--   token_seal_get        in the org's system context: opens one pending, claimed obligation's sealed copy for one call, with the claim's token, and counts
--                         the try as it opens (so a crash or a retry is counted); consumes the claim; refuses an obligation that is not pending, is seven
--                         days old or has used its ten tries.
--   token_revoke_settle   records the outcome of a try, with the claim's token: a run that stalled past its lease and was claimed again by a newer one is
--                         refused (ADS_REVOKE_STALE), so it cannot record over the newer run; and sweeps what is past its age or its tries.
--   token_revoke_expire   settles the obligations past seven days or ten tries and wipes their copies (also run by a sweep that has no egress, so the age
--                         limit does not depend on the revoke job).
--   write_orphans         lists the active write connections whose connector is no longer an owner or admin (a removed member's), to be closed so the
--                         revoke runs and the copy is wiped; the sweep closes them with the kernel's system command (20261122070000 adds the check that
--                         command asks the database under the row's lock).
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_ads.ad_token_revoke (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  -- The closed connection the token belonged to (its id only: the row may be gone, and a pending revoke must not stop its deletion nor go with it).
  connection_id uuid NOT NULL,
  -- The ad account the connection served, when it was attached to one (no foreign key: erasing an account leaves the obligation).
  ad_account_id uuid,
  provider text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9]{1,30}_ads$'),
  external_account_id text NOT NULL CHECK (pg_catalog.length(external_account_id) BETWEEN 1 AND 200),
  -- The write token, or the read token of the same app that holds a spend permission.
  kind text NOT NULL CHECK (kind IN ('write', 'read_spend')),
  -- Why the connection closed, as its status reason says (a code, never a sentence).
  reason text NOT NULL CHECK (reason ~ '^[a-z][a-z_]{1,39}$'),
  -- The keyed hash of the platform user who granted the connection (the account's recorded one), when it is known: the revoke is per person and app, so it
  -- is not called while another live connection of the same hash needs the grant. Never the platform's id of the person.
  grantor_hash text CHECK (grantor_hash IS NULL OR pg_catalog.length(grantor_hash) BETWEEN 8 AND 200),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'done', 'gave_up')),
  how_done text CHECK (how_done IN ('revoked', 'already_invalid', 'sandbox', 'shared_grant', 'reconnected')),
  give_up text CHECK (give_up IN ('attempts', 'age', 'unrevocable')),
  -- The tries made, counted when the copy is opened (token_seal_get), so a crash, a retry and a failed call all count.
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 10),
  next_attempt_at timestamptz DEFAULT pg_catalog.now(),
  last_error_kind text CHECK (last_error_kind IN ('rate_limited', 'transient', 'permission', 'bad_request', 'unknown')),
  last_error_code text CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Za-z0-9_.]{1,64}$'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  settled_at timestamptz,
  PRIMARY KEY (org_id, id),
  -- Pending means due at some time and not settled; done names how, gave_up names why, and only those two are settled.
  CONSTRAINT ad_token_revoke_pending_ck CHECK ((state = 'pending') = (settled_at IS NULL) AND (state = 'pending') = (next_attempt_at IS NOT NULL)),
  CONSTRAINT ad_token_revoke_done_ck CHECK ((state = 'done') = (how_done IS NOT NULL)),
  CONSTRAINT ad_token_revoke_gave_up_ck CHECK ((state = 'gave_up') = (give_up IS NOT NULL))
);
-- One obligation per closed connection: a second drop of the same connection's credential changes nothing.
CREATE UNIQUE INDEX IF NOT EXISTS ad_token_revoke_connection_uq ON crove_ads.ad_token_revoke (org_id, connection_id);
-- The screen lists an account's obligations.
CREATE INDEX IF NOT EXISTS ad_token_revoke_account_idx ON crove_ads.ad_token_revoke (org_id, ad_account_id) WHERE ad_account_id IS NOT NULL;
-- A reconnect looks for the pending obligations of the same account and provider.
CREATE INDEX IF NOT EXISTS ad_token_revoke_target_idx ON crove_ads.ad_token_revoke (org_id, provider, external_account_id) WHERE state = 'pending';
-- The worker's claim and the sweeps look at the pending ones only.
CREATE INDEX IF NOT EXISTS ad_token_revoke_pending_idx ON crove_ads.ad_token_revoke (next_attempt_at, created_at) WHERE state = 'pending';

SELECT crove_kernel.apply_tenant_rls('crove_ads.ad_token_revoke');
-- Tenant roles read it and nothing else: every write is a definer's, and none of them deletes a row.
REVOKE INSERT, UPDATE, DELETE ON crove_ads.ad_token_revoke FROM crove_tenant;

CREATE TABLE IF NOT EXISTS crove_ads.ad_token_seal (
  org_id uuid NOT NULL,
  revoke_id uuid NOT NULL,
  -- Which credential key sealed the envelope, for rotation (a rotation keeps the previous key for seven days at least).
  key_id text NOT NULL CHECK (key_id ~ '^[A-Za-z0-9_.-]{1,64}$'),
  envelope bytea NOT NULL CHECK (pg_catalog.octet_length(envelope) BETWEEN 1 AND 65536),
  sealed_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  -- The claim of the sweep that is working on it: it expires, and its token fences the answer (a run that stalled past its lease and was claimed again by
  -- a newer one cannot record over it). Set by token_revoke_due, consumed by token_seal_get (the lease), cleared by token_revoke_settle (the token).
  lease_until timestamptz,
  lease_token uuid,
  PRIMARY KEY (org_id, revoke_id),
  CONSTRAINT ad_token_seal_revoke_fk FOREIGN KEY (org_id, revoke_id) REFERENCES crove_ads.ad_token_revoke (org_id, id) ON DELETE CASCADE
);
ALTER TABLE crove_ads.ad_token_seal ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON crove_ads.ad_token_seal FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
SELECT crove_kernel.agent_write_guard_install('crove_ads.ad_token_seal');
-- The age sweep looks at the copies by age.
CREATE INDEX IF NOT EXISTS ad_token_seal_sealed_idx ON crove_ads.ad_token_seal (sealed_at);

-- The guard of the obligation, whatever path reaches it.
CREATE OR REPLACE FUNCTION crove_ads.ad_token_revoke_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'pending' OR NEW.attempts <> 0 OR NEW.how_done IS NOT NULL OR NEW.give_up IS NOT NULL OR NEW.last_error_kind IS NOT NULL OR NEW.last_error_code IS NOT NULL
       OR NEW.settled_at IS NOT NULL THEN
      RAISE EXCEPTION 'ADS_REVOKE_FORBIDDEN' USING ERRCODE = '42501', DETAIL = 'an obligation is born pending, with no tries';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.org_id, NEW.id, NEW.connection_id, NEW.ad_account_id, NEW.provider, NEW.external_account_id, NEW.kind, NEW.reason, NEW.grantor_hash, NEW.created_at)
     IS DISTINCT FROM (OLD.org_id, OLD.id, OLD.connection_id, OLD.ad_account_id, OLD.provider, OLD.external_account_id, OLD.kind, OLD.reason, OLD.grantor_hash, OLD.created_at) THEN
    RAISE EXCEPTION 'ADS_REVOKE_FORBIDDEN' USING ERRCODE = '42501', DETAIL = 'an obligation keeps its connection, its token kind, its reason and its grantor';
  END IF;
  IF NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF OLD.state <> 'pending' THEN
    RAISE EXCEPTION 'ADS_REVOKE_FORBIDDEN' USING ERRCODE = '42501', DETAIL = 'a settled obligation never changes';
  END IF;
  -- A try is counted once, never taken back and never skipped.
  IF NEW.attempts NOT IN (OLD.attempts, OLD.attempts + 1) THEN
    RAISE EXCEPTION 'ADS_REVOKE_FORBIDDEN' USING ERRCODE = '42501', DETAIL = 'tries are counted one at a time';
  END IF;
  -- Done needs a try, except where no call was made: another live connection of the same person needs the grant, or the account was connected again.
  IF NEW.state = 'done' AND NEW.attempts < 1 AND NEW.how_done NOT IN ('shared_grant', 'reconnected') THEN
    RAISE EXCEPTION 'ADS_REVOKE_FORBIDDEN' USING ERRCODE = '42501', DETAIL = 'done needs the try that did it';
  END IF;
  -- A copy is never given up on without the tenth try or the seventh day (a few minutes of slack for a clock that differs from the database's), but for the
  -- finding that nothing can be revoked from it: a token the platform does not accept for a reason other than the person removing the app, a copy that
  -- cannot be opened, or a deployment with no way to call the platform. It is then wiped at once and the person is told to revoke by hand.
  IF NEW.state = 'gave_up' AND NOT (
    (NEW.give_up = 'attempts' AND NEW.attempts >= 10)
    OR (NEW.give_up = 'age' AND (
      pg_catalog.clock_timestamp() - OLD.created_at >= pg_catalog.make_interval(days => 7) - pg_catalog.make_interval(mins => 5)
      OR EXISTS (SELECT 1 FROM crove_ads.ad_token_seal s WHERE s.org_id = OLD.org_id AND s.revoke_id = OLD.id
                 AND pg_catalog.clock_timestamp() - s.sealed_at >= pg_catalog.make_interval(days => 7) - pg_catalog.make_interval(mins => 5))))
    OR NEW.give_up = 'unrevocable'
  ) THEN
    RAISE EXCEPTION 'ADS_REVOKE_FORBIDDEN' USING ERRCODE = '42501', DETAIL = 'a copy is kept until the tenth try, the seventh day or the finding that it cannot be revoked';
  END IF;
  IF NEW.state <> 'pending' THEN
    NEW.settled_at := pg_catalog.clock_timestamp();
    NEW.next_attempt_at := NULL;
    -- Whatever ends the obligation ends the copy (and the claim on it), in the same statement.
    DELETE FROM crove_ads.ad_token_seal s WHERE s.org_id = NEW.org_id AND s.revoke_id = NEW.id;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_ads.ad_token_revoke_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

DROP TRIGGER IF EXISTS ad_token_revoke_guard ON crove_ads.ad_token_revoke;
CREATE TRIGGER ad_token_revoke_guard BEFORE INSERT OR UPDATE ON crove_ads.ad_token_revoke FOR EACH ROW EXECUTE FUNCTION crove_ads.ad_token_revoke_guard();
ALTER TABLE crove_ads.ad_token_revoke ENABLE ALWAYS TRIGGER ad_token_revoke_guard;

-- The hold itself, for the two triggers below (no grant to any role): copies one credential into the seal and opens the obligation, once per connection.
CREATE OR REPLACE FUNCTION crove_ads.token_hold_row(
  p_org uuid, p_connection uuid, p_key_id text, p_envelope bytea, p_provider text, p_external text, p_scopes text[], p_status_reason text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_kind text;
  v_grantor text;
  v_revoke uuid;
BEGIN
  -- Meta's ads providers and the offline sandbox only (the owner approved the copy for those): the write connection's token, or the read connection's whose
  -- recorded scopes hold a spend permission. Any other provider, Social's included, gets no copy; the triggers run for every credential, so this skips and
  -- never refuses.
  IF p_provider IN ('metawrite_ads', 'sandboxwrite_ads') THEN
    v_kind := 'write';
  ELSIF p_provider = 'meta_ads' AND p_scopes && ARRAY['ads_management', 'business_management']::text[] THEN
    v_kind := 'read_spend';
  ELSE
    RETURN;
  END IF;
  -- The platform's own data deletion: the person removed the app, so nothing is left to revoke (the deletion request is honoured at once).
  IF p_status_reason IS NOT DISTINCT FROM 'platform_deletion' THEN
    RETURN;
  END IF;
  -- An org being closed: the purge wipes. The tenant row is taken FOR SHARE, the lock the purge's FOR UPDATE waits for, in the purge's order (the write
  -- fence first, then the row), so a close racing the purge finishes first, and the purge then deletes what it held, or finds the org closed and holds nothing.
  PERFORM 1 FROM crove_kernel.tenant t WHERE t.org_id = p_org AND t.status = 'active' FOR SHARE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  v_grantor := CASE v_kind
    WHEN 'write' THEN (SELECT a.write_granted_by_hash FROM crove_ads.ad_account a WHERE a.org_id = p_org AND a.write_connection_id = p_connection ORDER BY a.id LIMIT 1)
    ELSE (SELECT a.granted_by_hash FROM crove_ads.ad_account a WHERE a.org_id = p_org AND a.channel_connection_id = p_connection ORDER BY a.id LIMIT 1)
  END;
  INSERT INTO crove_ads.ad_token_revoke AS r (org_id, connection_id, ad_account_id, provider, external_account_id, kind, reason, grantor_hash)
  VALUES (
    p_org, p_connection,
    (SELECT a.id FROM crove_ads.ad_account a WHERE a.org_id = p_org AND (a.write_connection_id = p_connection OR a.channel_connection_id = p_connection) ORDER BY a.id LIMIT 1),
    p_provider, p_external, v_kind,
    CASE WHEN p_status_reason ~ '^[a-z][a-z_]{1,39}$' THEN p_status_reason ELSE 'other' END,
    v_grantor)
  ON CONFLICT (org_id, connection_id) DO NOTHING
  RETURNING r.id INTO v_revoke;
  IF v_revoke IS NOT NULL THEN
    INSERT INTO crove_ads.ad_token_seal (org_id, revoke_id, key_id, envelope) VALUES (p_org, v_revoke, p_key_id, p_envelope);
  END IF;
END $$;
REVOKE ALL ON FUNCTION crove_ads.token_hold_row(uuid, uuid, text, bytea, text, text, text[], text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- The credential is dropped: the hold, in the statement that drops it.
CREATE OR REPLACE FUNCTION crove_ads.token_hold() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_connection crove_kernel.channel_connection%ROWTYPE;
BEGIN
  SELECT c.* INTO v_connection FROM crove_kernel.channel_connection c WHERE c.org_id = OLD.org_id AND c.id = OLD.connection_id;
  -- The connection row is already gone when this is the cascade of its deletion: token_hold_connection held the copy before it went.
  IF FOUND THEN
    PERFORM crove_ads.token_hold_row(OLD.org_id, OLD.connection_id, OLD.key_id, OLD.envelope, v_connection.provider, v_connection.external_account_id, v_connection.scopes, v_connection.status_reason);
  END IF;
  RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION crove_ads.token_hold() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

DROP TRIGGER IF EXISTS token_hold ON crove_kernel.credential;
CREATE TRIGGER token_hold BEFORE DELETE ON crove_kernel.credential FOR EACH ROW EXECUTE FUNCTION crove_ads.token_hold();
ALTER TABLE crove_kernel.credential ENABLE ALWAYS TRIGGER token_hold;

-- The connection row is deleted (a connection is closed, never deleted, but an erasure or an operator's statement may): its credential goes with it by the
-- foreign key's cascade, after the connection row, so the copy is made here, while both exist.
CREATE OR REPLACE FUNCTION crove_ads.token_hold_connection() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_credential crove_kernel.credential%ROWTYPE;
BEGIN
  SELECT k.* INTO v_credential FROM crove_kernel.credential k WHERE k.org_id = OLD.org_id AND k.connection_id = OLD.id;
  IF FOUND THEN
    PERFORM crove_ads.token_hold_row(OLD.org_id, OLD.id, v_credential.key_id, v_credential.envelope, OLD.provider, OLD.external_account_id, OLD.scopes, OLD.status_reason);
  END IF;
  RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION crove_ads.token_hold_connection() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

DROP TRIGGER IF EXISTS token_hold ON crove_kernel.channel_connection;
CREATE TRIGGER token_hold BEFORE DELETE ON crove_kernel.channel_connection FOR EACH ROW EXECUTE FUNCTION crove_ads.token_hold_connection();
ALTER TABLE crove_kernel.channel_connection ENABLE ALWAYS TRIGGER token_hold;

-- A credential sealed for an ads connection cancels the pending revokes of the same account and provider that earlier connections left: the person has given
-- the permission again, and the revoke would cut it (Meta's permission belongs to the pair of the person and the app). The copy goes with it.
CREATE OR REPLACE FUNCTION crove_ads.token_reconnected() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_provider text;
  v_external text;
BEGIN
  SELECT c.provider, c.external_account_id INTO v_provider, v_external FROM crove_kernel.channel_connection c WHERE c.org_id = NEW.org_id AND c.id = NEW.connection_id;
  IF NOT FOUND OR v_provider NOT IN ('metawrite_ads', 'sandboxwrite_ads', 'meta_ads') THEN
    RETURN NEW;
  END IF;
  UPDATE crove_ads.ad_token_revoke r SET state = 'done', how_done = 'reconnected', next_attempt_at = NULL
  WHERE r.org_id = NEW.org_id AND r.state = 'pending' AND r.provider = v_provider AND r.external_account_id = v_external AND r.connection_id <> NEW.connection_id;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_ads.token_reconnected() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

DROP TRIGGER IF EXISTS token_reconnected ON crove_kernel.credential;
CREATE TRIGGER token_reconnected AFTER INSERT ON crove_kernel.credential FOR EACH ROW EXECUTE FUNCTION crove_ads.token_reconnected();
ALTER TABLE crove_kernel.credential ENABLE ALWAYS TRIGGER token_reconnected;

-- The obligations past seven days or past their ten tries, settled and their copies wiped (worker login only). A claim whose lease ran out with ten tries
-- used is such a one: the tenth open counted and the worker never recorded an answer. Answers how many.
CREATE OR REPLACE FUNCTION crove_ads.token_revoke_expire() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_age integer;
  v_tries integer;
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'ADS_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  UPDATE crove_ads.ad_token_revoke r SET state = 'gave_up', give_up = 'age'
  WHERE r.state = 'pending'
    AND (r.created_at <= pg_catalog.now() - pg_catalog.make_interval(days => 7)
         OR EXISTS (SELECT 1 FROM crove_ads.ad_token_seal s WHERE s.org_id = r.org_id AND s.revoke_id = r.id AND s.sealed_at <= pg_catalog.now() - pg_catalog.make_interval(days => 7)));
  GET DIAGNOSTICS v_age = ROW_COUNT;
  UPDATE crove_ads.ad_token_revoke r SET state = 'gave_up', give_up = 'attempts'
  WHERE r.state = 'pending' AND r.attempts >= 10 AND r.next_attempt_at <= pg_catalog.now()
    AND NOT EXISTS (SELECT 1 FROM crove_ads.ad_token_seal s WHERE s.org_id = r.org_id AND s.revoke_id = r.id AND s.lease_until > pg_catalog.now());
  GET DIAGNOSTICS v_tries = ROW_COUNT;
  RETURN v_age + v_tries;
END $$;

-- The worker claims the due obligations: pending, due, with tries left, not leased, a lease of ten minutes and a fencing token on each (so a second worker
-- passes it by, a crashed one's is found again, and the answer of a run that stalled past its lease is refused once a newer run has claimed it). Answers ids,
-- the provider and the token, never anything sealed.
CREATE OR REPLACE FUNCTION crove_ads.token_revoke_due(p_limit integer) RETURNS TABLE (org_id uuid, id uuid, provider text, lease_token uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'ADS_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  WITH due AS (
    SELECT r.org_id, r.id FROM crove_ads.ad_token_revoke r
    JOIN crove_ads.ad_token_seal s ON s.org_id = r.org_id AND s.revoke_id = r.id
    WHERE r.state = 'pending' AND r.attempts < 10 AND r.next_attempt_at <= pg_catalog.now() AND (s.lease_until IS NULL OR s.lease_until <= pg_catalog.now())
    ORDER BY r.next_attempt_at, r.id
    LIMIT LEAST(GREATEST(p_limit, 1), 100)
    FOR UPDATE OF r, s SKIP LOCKED
  )
  UPDATE crove_ads.ad_token_seal s SET lease_until = pg_catalog.now() + pg_catalog.make_interval(mins => 10), lease_token = pg_catalog.gen_random_uuid()
  FROM due WHERE s.org_id = due.org_id AND s.revoke_id = due.id
  RETURNING s.org_id, s.revoke_id, (SELECT x.provider FROM crove_ads.ad_token_revoke x WHERE x.org_id = s.org_id AND x.id = s.revoke_id), s.lease_token;
END $$;

-- Whether another live connection of the same grantor, in any org, needs the grant (worker login only): a boolean and nothing else, never another org's ids.
-- Meta's permission belongs to the pair of the person and the app, so revoking it for this connection also cuts theirs; the revoke is then not called, and
-- the obligation ends as done (shared grant). False when the grantor is not known. The connections counted are the live ones of the ad accounts of active
-- orgs that the same hash granted, for reading or for running ads, other than this obligation's own.
CREATE OR REPLACE FUNCTION crove_ads.token_grant_shared(p_org uuid, p_revoke uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_hash text;
  v_connection uuid;
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'ADS_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  SELECT r.grantor_hash, r.connection_id INTO v_hash, v_connection FROM crove_ads.ad_token_revoke r WHERE r.org_id = p_org AND r.id = p_revoke AND r.state = 'pending';
  IF NOT FOUND OR v_hash IS NULL THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM crove_ads.ad_account a
    JOIN crove_kernel.tenant t ON t.org_id = a.org_id AND t.status = 'active'
    JOIN crove_kernel.channel_connection c ON c.org_id = a.org_id AND c.status = 'active'
    WHERE ((a.granted_by_hash = v_hash AND c.id = a.channel_connection_id) OR (a.write_granted_by_hash = v_hash AND c.id = a.write_connection_id))
      AND NOT (a.org_id = p_org AND c.id = v_connection)
  );
END $$;

-- The sealed copy of one pending, claimed obligation, for the worker, in the org's system context, for one call, with the claim's token. It counts the try as
-- it opens (a crash after this, a retry of the job and a failed call all count) and consumes the claim's lease, so two jobs never open one copy. It refuses an
-- obligation that is not pending, is seven days old (by the obligation or by the copy) or has used its ten tries, even before a sweep wipes it. It does not
-- look at the connector: a member who left does not end the obligation, the revoke is tried first (ADR-0025's amendment). Raises ADS_SEAL_GONE (P0002),
-- ADS_SEAL_NOT_CLAIMED (55000).
CREATE OR REPLACE FUNCTION crove_ads.token_seal_get(p_org uuid, p_revoke uuid, p_token uuid) RETURNS TABLE (key_id text, envelope bytea, provider text, external_account_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_revoke crove_ads.ad_token_revoke%ROWTYPE;
  v_seal crove_ads.ad_token_seal%ROWTYPE;
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'ADS_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF crove_kernel.ctx_org_id() IS DISTINCT FROM p_org OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'system' THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_revoke FROM crove_ads.ad_token_revoke x WHERE x.org_id = p_org AND x.id = p_revoke FOR UPDATE;
  IF NOT FOUND OR v_revoke.state <> 'pending' OR v_revoke.attempts >= 10 THEN
    RAISE EXCEPTION 'ADS_SEAL_GONE' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_seal FROM crove_ads.ad_token_seal x WHERE x.org_id = p_org AND x.revoke_id = p_revoke FOR UPDATE;
  IF NOT FOUND OR v_revoke.created_at <= pg_catalog.now() - pg_catalog.make_interval(days => 7) OR v_seal.sealed_at <= pg_catalog.now() - pg_catalog.make_interval(days => 7) THEN
    RAISE EXCEPTION 'ADS_SEAL_GONE' USING ERRCODE = 'P0002';
  END IF;
  IF p_token IS NULL OR v_seal.lease_token IS DISTINCT FROM p_token OR v_seal.lease_until IS NULL OR v_seal.lease_until <= pg_catalog.now() THEN
    RAISE EXCEPTION 'ADS_SEAL_NOT_CLAIMED' USING ERRCODE = '55000';
  END IF;
  -- The lease is consumed (one open per claim) and the next time is the claim of a run that never answers: ten minutes, with this try counted.
  UPDATE crove_ads.ad_token_seal x SET lease_until = NULL WHERE x.org_id = p_org AND x.revoke_id = p_revoke;
  UPDATE crove_ads.ad_token_revoke x SET attempts = v_revoke.attempts + 1, next_attempt_at = pg_catalog.now() + pg_catalog.make_interval(mins => 10)
  WHERE x.org_id = p_org AND x.id = p_revoke;
  RETURN QUERY SELECT v_seal.key_id, v_seal.envelope, v_revoke.provider, v_revoke.external_account_id;
END $$;

-- Records the outcome of one try (worker login only), with the claim's token: the policy computes it (modules/ads/src/token-revoke.ts), the guard holds it to
-- the rules. The tries were counted when the copy was opened, so the count is not moved here. A token that is not the claim's current one (a run that stalled
-- past its lease, claimed again by a newer run, or answered already) is refused: ADS_REVOKE_STALE. It also settles what is past its age or its tries.
CREATE OR REPLACE FUNCTION crove_ads.token_revoke_settle(
  p_org uuid, p_id uuid, p_token uuid, p_state text, p_next timestamptz, p_how text, p_give_up text, p_error_kind text, p_error_code text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'ADS_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM crove_ads.ad_token_seal s WHERE s.org_id = p_org AND s.revoke_id = p_id AND p_token IS NOT NULL AND s.lease_token = p_token FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ADS_REVOKE_STALE' USING ERRCODE = '55000';
  END IF;
  UPDATE crove_ads.ad_token_revoke r
  SET state = p_state, next_attempt_at = p_next, how_done = p_how, give_up = p_give_up,
      last_error_kind = COALESCE(p_error_kind, r.last_error_kind), last_error_code = COALESCE(p_error_code, r.last_error_code)
  WHERE r.org_id = p_org AND r.id = p_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ADS_REVOKE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  -- Still pending: the claim is spent, so the same token cannot record twice (a settled obligation has no copy any more).
  UPDATE crove_ads.ad_token_seal s SET lease_token = NULL, lease_until = NULL WHERE s.org_id = p_org AND s.revoke_id = p_id;
  PERFORM crove_ads.token_revoke_expire();
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

REVOKE ALL ON FUNCTION crove_ads.token_revoke_due(integer), crove_ads.token_grant_shared(uuid, uuid), crove_ads.token_seal_get(uuid, uuid, uuid),
  crove_ads.token_revoke_settle(uuid, uuid, uuid, text, timestamptz, text, text, text, text), crove_ads.token_revoke_expire(),
  crove_ads.write_orphans(uuid, uuid, integer) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_ads.token_revoke_due(integer), crove_ads.token_grant_shared(uuid, uuid), crove_ads.token_seal_get(uuid, uuid, uuid),
  crove_ads.token_revoke_settle(uuid, uuid, uuid, text, timestamptz, text, text, text, text), crove_ads.token_revoke_expire(),
  crove_ads.write_orphans(uuid, uuid, integer) TO crove_worker;

-- The job's queue: no data at all (a sweep on a schedule, retried by the policy and never by the queue).
SELECT crove_jobs.create_queue('ads-revoke', '{"policy":"standard","deadLetter":"kernel-job.dlq"}'::jsonb);
