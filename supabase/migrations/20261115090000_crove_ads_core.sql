-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove Ads (issue #2217, plan docs/plan/ads.md sections 5 to 7, ADR-0040): the ad accounts an org connected and the
-- daily spend and results the platforms report for them, read only. Idempotent; applied files stay untouched.
--
-- crove_ads.ad_account    one row per connected ad account. The connection is a row of crove_kernel.channel_connection
--                         (provider `sandbox_ads` first, `meta_ads` and the others later) with its credential sealed in
--                         crove_kernel.credential (ADR-0025); this row holds what Ads decides about it: the legal entity
--                         whose books the account belongs to, the expense account the books strip compares with, the
--                         action type that counts as "a result", and the sync cursors. The currency and the time zone are
--                         the platform's, written by the first sync; null before it. An owner or admin links and
--                         configures; the worker's sync writes the rest.
-- crove_ads.ad_spend_day  one row per account, level (the account or one of its campaigns), object and day: the platform's
--                         own figures in the account's currency and in its time zone's days, never converted. Only the
--                         worker's sync command writes figures. A day inside the platform's revision window is rewritten
--                         in place by the next read; a settled day (on or before the account's settled_through) is not
--                         read again. `reach` is the platform's count of people for that day and is not additive. No
--                         personal data: an object's name is text the owner typed on the platform (plan section 9).
-- crove_ads.ad_sync_run   one row per sync of an account: the window it read, how it ended, and when to try again after a
--                         rate limit. Insert-only; crove_ads.sync_runs_prune removes what is older than 90 days.
--
-- Every row carries its legal entity and sits under the RESTRICTIVE le_scope policy beside the tenant policy, as the
-- finance tables do: an actor reads and writes only the entities its sealed context names. A figure's entity is its
-- account's (composite foreign key, ON UPDATE CASCADE: moving an account to another entity moves its history with it).
-- The worker's queue ads-sync runs an account's sync; crove_ads.ads_due lists the active accounts of active orgs for its
-- hourly sweep, for the worker login alone.
SET LOCAL lock_timeout = '2s';

CREATE SCHEMA IF NOT EXISTS crove_ads;
GRANT USAGE ON SCHEMA crove_ads TO crove_tenant;

CREATE TABLE IF NOT EXISTS crove_ads.ad_account (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  legal_entity_id uuid NOT NULL,
  channel_connection_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_]{0,31}$'),
  external_account_id text NOT NULL CHECK (pg_catalog.length(external_account_id) BETWEEN 1 AND 200),
  name text NOT NULL CHECK (pg_catalog.length(name) BETWEEN 1 AND 200),
  -- The platform's, from the first sync: ISO 4217 and an IANA zone name.
  currency text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  time_zone text CHECK (time_zone IS NULL OR pg_catalog.length(time_zone) BETWEEN 1 AND 64),
  -- The chart account whose ledger total the books strip shows beside the platform's spend; the app offers the entity's
  -- accounts, and Finance answers for a code it does not have. Null: no strip yet.
  expense_account_code text CHECK (expense_account_code IS NULL OR expense_account_code ~ '^[0-9]{3,10}(\.[A-Z0-9]{1,20})?$'),
  -- Which key of a row's results counts as a result (the platform's action type); null: none chosen, no cost per result.
  result_kind text CHECK (result_kind IS NULL OR pg_catalog.length(result_kind) BETWEEN 1 AND 100),
  -- The first day a sync reads (13 months back from the link), the last day known to be final, and the last day a sync
  -- read.
  backfill_from date NOT NULL,
  settled_through date,
  synced_through date,
  last_requested_at timestamptz,
  last_run_at timestamptz,
  last_error_kind text CHECK (last_error_kind IS NULL OR last_error_kind IN ('token_expired', 'permission', 'bad_request', 'rate_limited', 'transient', 'unknown')),
  -- After a rate limit: not before this time.
  next_run_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT ad_account_external_uq UNIQUE (org_id, provider, external_account_id),
  CONSTRAINT ad_account_connection_uq UNIQUE (org_id, channel_connection_id),
  -- The target of the figures' composite key, so a figure cannot name another entity than its account.
  CONSTRAINT ad_account_entity_uq UNIQUE (org_id, id, legal_entity_id),
  CONSTRAINT ad_account_connection_fk FOREIGN KEY (org_id, channel_connection_id) REFERENCES crove_kernel.channel_connection (org_id, id),
  CONSTRAINT ad_account_entity_fk FOREIGN KEY (org_id, legal_entity_id) REFERENCES crove_kernel.legal_entity (org_id, id)
);
-- Entity first, as the finance tables' entity indexes are.
CREATE INDEX IF NOT EXISTS ad_account_entity_idx ON crove_ads.ad_account (legal_entity_id, org_id);

SELECT crove_kernel.apply_tenant_rls('crove_ads.ad_account');
-- An account is linked once and never deleted by a tenant role (history is deleted by its own command, and the org purge
-- deletes as the table owner). The org, the connection's provider, the platform's account id and the creation time never
-- change; the connection may (a reconnect after a disconnect keeps the history).
REVOKE UPDATE, DELETE ON crove_ads.ad_account FROM crove_tenant;
GRANT UPDATE (legal_entity_id, channel_connection_id, name, currency, time_zone, expense_account_code, result_kind, settled_through, synced_through, last_requested_at, last_run_at, last_error_kind, next_run_at, updated_at)
  ON crove_ads.ad_account TO crove_tenant;

CREATE TABLE IF NOT EXISTS crove_ads.ad_spend_day (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  ad_account_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  level text NOT NULL CHECK (level IN ('account', 'campaign')),
  external_object_id text NOT NULL CHECK (pg_catalog.length(external_object_id) BETWEEN 1 AND 200),
  object_name text NOT NULL DEFAULT '' CHECK (pg_catalog.length(object_name) <= 300),
  day date NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  spend numeric NOT NULL CHECK (spend >= 0),
  impressions bigint NOT NULL CHECK (impressions >= 0),
  clicks bigint NOT NULL CHECK (clicks >= 0),
  reach bigint CHECK (reach IS NULL OR reach >= 0),
  -- The platform's action types and their counts as decimal strings, at most 50.
  results jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (pg_catalog.jsonb_typeof(results) = 'object'),
  fetched_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  settled_at timestamptz,
  PRIMARY KEY (org_id, id),
  CONSTRAINT ad_spend_day_key_uq UNIQUE (org_id, ad_account_id, level, external_object_id, day),
  CONSTRAINT ad_spend_day_account_fk FOREIGN KEY (org_id, ad_account_id, legal_entity_id)
    REFERENCES crove_ads.ad_account (org_id, id, legal_entity_id) ON UPDATE CASCADE ON DELETE CASCADE
);
-- The summary reads an account's days in order; the foreign key's own index.
CREATE INDEX IF NOT EXISTS ad_spend_day_account_idx ON crove_ads.ad_spend_day (org_id, ad_account_id, legal_entity_id, day);

SELECT crove_kernel.apply_tenant_rls('crove_ads.ad_spend_day');
-- The sync rewrites a day's figures in place and removes a day the platform no longer reports; the account and the
-- object never change.
REVOKE UPDATE ON crove_ads.ad_spend_day FROM crove_tenant;
GRANT UPDATE (object_name, currency, spend, impressions, clicks, reach, results, fetched_at, settled_at) ON crove_ads.ad_spend_day TO crove_tenant;

CREATE TABLE IF NOT EXISTS crove_ads.ad_sync_run (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  ad_account_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('ok', 'failed')),
  window_from date,
  window_to date,
  rows_written integer NOT NULL DEFAULT 0 CHECK (rows_written >= 0),
  error_kind text CHECK (error_kind IS NULL OR error_kind IN ('token_expired', 'permission', 'bad_request', 'rate_limited', 'transient', 'unknown')),
  error_code text CHECK (error_code IS NULL OR pg_catalog.length(error_code) <= 100),
  retry_at timestamptz,
  started_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  finished_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT ad_sync_run_account_fk FOREIGN KEY (org_id, ad_account_id, legal_entity_id)
    REFERENCES crove_ads.ad_account (org_id, id, legal_entity_id) ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ad_sync_run_account_idx ON crove_ads.ad_sync_run (org_id, ad_account_id, legal_entity_id, started_at DESC);
CREATE INDEX IF NOT EXISTS ad_sync_run_started_idx ON crove_ads.ad_sync_run (started_at);

SELECT crove_kernel.apply_tenant_rls('crove_ads.ad_sync_run');
-- A run is written once and never changed; the prune below deletes the old ones.
REVOKE UPDATE, DELETE ON crove_ads.ad_sync_run FROM crove_tenant;

-- The legal-entity scope, RESTRICTIVE so it narrows the tenant policy and never widens it.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['crove_ads.ad_account', 'crove_ads.ad_spend_day', 'crove_ads.ad_sync_run'] LOOP
    EXECUTE pg_catalog.format('DROP POLICY IF EXISTS le_scope ON %s', t);
    EXECUTE pg_catalog.format(
      'CREATE POLICY le_scope ON %s AS RESTRICTIVE FOR ALL TO crove_tenant '
      'USING (''*'' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[])) '
      'WITH CHECK (''*'' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]))', t);
  END LOOP;
END $$;

-- Which legal entity a new row belongs to (trigger b_legal_entity, as the finance tables'): an account takes the entity the
-- writer names or, naming none, the org's default entity as the writer sees it; a figure or a run takes its account's. It
-- runs as the writer, through the writer's own policies, so a writer limited to other entities finds no default entity
-- and le_scope refuses the row; and it is enabled ALWAYS, so it fires in replica mode as well. The composite foreign keys
-- then keep every figure and run in its account's entity.
CREATE OR REPLACE FUNCTION crove_ads.legal_entity_fill() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_entity uuid;
BEGIN
  IF NEW.legal_entity_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF TG_NARGS = 1 THEN
    SELECT a.legal_entity_id INTO v_entity FROM crove_ads.ad_account a
    WHERE a.org_id = NEW.org_id AND a.id = (pg_catalog.to_jsonb(NEW) ->> TG_ARGV[0])::uuid;
  ELSE
    SELECT e.id INTO v_entity FROM crove_kernel.legal_entity e WHERE e.org_id = NEW.org_id AND e.is_default;
  END IF;
  NEW.legal_entity_id := v_entity;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_ads.legal_entity_fill() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

DROP TRIGGER IF EXISTS b_legal_entity ON crove_ads.ad_account;
CREATE TRIGGER b_legal_entity BEFORE INSERT ON crove_ads.ad_account FOR EACH ROW EXECUTE FUNCTION crove_ads.legal_entity_fill();
ALTER TABLE crove_ads.ad_account ENABLE ALWAYS TRIGGER b_legal_entity;
DROP TRIGGER IF EXISTS b_legal_entity ON crove_ads.ad_spend_day;
CREATE TRIGGER b_legal_entity BEFORE INSERT ON crove_ads.ad_spend_day FOR EACH ROW EXECUTE FUNCTION crove_ads.legal_entity_fill('ad_account_id');
ALTER TABLE crove_ads.ad_spend_day ENABLE ALWAYS TRIGGER b_legal_entity;
DROP TRIGGER IF EXISTS b_legal_entity ON crove_ads.ad_sync_run;
CREATE TRIGGER b_legal_entity BEFORE INSERT ON crove_ads.ad_sync_run FOR EACH ROW EXECUTE FUNCTION crove_ads.legal_entity_fill('ad_account_id');
ALTER TABLE crove_ads.ad_sync_run ENABLE ALWAYS TRIGGER b_legal_entity;

-- The worker's queue: one account's sync, queued by the outbox relay when an account is linked or a refresh asked for, and
-- every hour for every active account. Stately, with the singleton key <org>:<queue>:<connection> (job-keys.ts): at most one
-- queued and one active job per account, so a link, a refresh and the sweep never read one account twice at once.
SELECT crove_jobs.create_queue('ads-sync', '{"policy":"stately","deadLetter":"kernel-job.dlq"}'::jsonb);

-- The active ad accounts of active orgs after a key, in key order, for the worker's hourly sweep, which pages through
-- them all (the worker login's alone, as crove_finance.bank_feeds_due). An account waits for its next_run_at after a rate
-- limit, and a connection that is not active (expired, revoked) is skipped.
CREATE OR REPLACE FUNCTION crove_ads.ads_due(p_after_org uuid, p_after_id uuid, p_limit int)
RETURNS TABLE (org_id uuid, connection_id uuid, provider text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT a.org_id, a.channel_connection_id, a.provider
  FROM crove_ads.ad_account a
  JOIN crove_kernel.channel_connection c ON c.org_id = a.org_id AND c.id = a.channel_connection_id AND c.status = 'active'
  JOIN crove_kernel.tenant t ON t.org_id = a.org_id AND t.status = 'active'
  WHERE (a.next_run_at IS NULL OR a.next_run_at <= pg_catalog.now())
    AND (p_after_org IS NULL OR (a.org_id, a.channel_connection_id) > (p_after_org, p_after_id))
  ORDER BY a.org_id, a.channel_connection_id
  LIMIT LEAST(GREATEST(p_limit, 1), 1000)
$$;
REVOKE ALL ON FUNCTION crove_ads.ads_due(uuid, uuid, int) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_ads.ads_due(uuid, uuid, int) TO crove_worker;

-- Removes the sync runs of every org older than p_before (the worker login's alone, from the daily sweep: 90 days), as
-- the retention sweep does for its tables. Returns how many it removed.
CREATE OR REPLACE FUNCTION crove_ads.sync_runs_prune(p_before timestamptz)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_n bigint;
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'ADS_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  DELETE FROM crove_ads.ad_sync_run r WHERE r.started_at < p_before;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;
REVOKE ALL ON FUNCTION crove_ads.sync_runs_prune(timestamptz) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_ads.sync_runs_prune(timestamptz) TO crove_worker;
