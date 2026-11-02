-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove Ads W0b (issue #2294, ADR-0043 points 3 and 4, plan docs/plan/ads-write.md section 5.1): the write connection of an ad account.
-- Nothing here calls a platform and nothing spends. Idempotent; applied files stay untouched.
--
-- crove_ads.ad_account   gains `write_connection_id`, the channel connection (its provider `metawrite_ads` or `sandboxwrite_ads`, its own
--                        sealed token) that can change campaigns for this account, and `write_granted_by_hash`, the keyed hash of the
--                        platform user who granted it (the platform's data deletion callback finds the accounts a person granted by it;
--                        kept apart from `granted_by_hash`, which a read link overwrites and which can differ when the write app is not the
--                        read app). Null: the account is read only. The connection is in the org of the account (a composite foreign key),
--                        is never the read connection, and is attached to one account only. A write connection that was closed stays
--                        referenced (its status is the record); a new one replaces it.
-- crove_ads.write_connection_guard   fires for every role on a change of either column and on the removal of an account row. A connection
--                        is attached or replaced by a signed-in owner alone (an admin, a member, an agent and the system are refused: the
--                        owner connects), only while the org's switch is on, and only a live connection of the account's own write twin
--                        (provider `<x>write_ads` for the account of `<x>_ads`, the same platform account). It is cleared or replaced by an
--                        owner, an admin or the system, but only once the old connection is closed, so no row ever forgets a sealed token that
--                        is still open. An account row is removed only with its write connection closed (the system's org purge and erasure
--                        close or drop it themselves).
-- crove_ads.deletion_request_claim_write   finds, for the requests the first claim returned, the accounts whose write connection alone a
--                        person granted (`write_granted_by_hash`), so the platform's data deletion request closes a write-only grant as
--                        well and the relay forgets the write connection of an account it does not erase.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_ads.ad_account ADD COLUMN IF NOT EXISTS write_connection_id uuid;
ALTER TABLE crove_ads.ad_account ADD COLUMN IF NOT EXISTS write_granted_by_hash text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'ad_account_write_connection_fk' AND conrelid = 'crove_ads.ad_account'::regclass) THEN
    ALTER TABLE crove_ads.ad_account ADD CONSTRAINT ad_account_write_connection_fk
      FOREIGN KEY (org_id, write_connection_id) REFERENCES crove_kernel.channel_connection (org_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'ad_account_write_connection_distinct_ck' AND conrelid = 'crove_ads.ad_account'::regclass) THEN
    ALTER TABLE crove_ads.ad_account ADD CONSTRAINT ad_account_write_connection_distinct_ck CHECK (write_connection_id IS DISTINCT FROM channel_connection_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'ad_account_write_granted_by_hash_ck' AND conrelid = 'crove_ads.ad_account'::regclass) THEN
    ALTER TABLE crove_ads.ad_account ADD CONSTRAINT ad_account_write_granted_by_hash_ck CHECK (write_granted_by_hash IS NULL OR write_granted_by_hash ~ '^[0-9a-f]{64}$');
  END IF;
  -- A grantor is recorded only with the connection it granted.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'ad_account_write_hash_needs_connection_ck' AND conrelid = 'crove_ads.ad_account'::regclass) THEN
    ALTER TABLE crove_ads.ad_account ADD CONSTRAINT ad_account_write_hash_needs_connection_ck CHECK (write_granted_by_hash IS NULL OR write_connection_id IS NOT NULL);
  END IF;
END $$;
-- One account per write connection, and the index the composite foreign key needs (led by org_id).
CREATE UNIQUE INDEX IF NOT EXISTS ad_account_write_connection_uq ON crove_ads.ad_account (org_id, write_connection_id) WHERE write_connection_id IS NOT NULL;
-- The platform's data deletion request finds the accounts a person granted write access to by this hash.
CREATE INDEX IF NOT EXISTS ad_account_write_granted_by_hash_idx ON crove_ads.ad_account (write_granted_by_hash) WHERE write_granted_by_hash IS NOT NULL;
GRANT UPDATE (write_connection_id, write_granted_by_hash) ON crove_ads.ad_account TO crove_tenant;

CREATE OR REPLACE FUNCTION crove_ads.write_connection_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_actor text := crove_kernel.ctx_actor_type();
  v_user uuid := crove_kernel.ctx_user_id();
  v_role text;
  v_status text;
  v_on boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- The row of an account goes only with its write connection closed. The system (the org purge, the platform's erasure) is trusted
    -- to close or drop it itself: the purge drops every credential of the org, the erasure closes the connection first.
    IF OLD.write_connection_id IS NOT NULL AND v_actor IS DISTINCT FROM 'system' THEN
      SELECT c.status INTO v_status FROM crove_kernel.channel_connection c WHERE c.org_id = OLD.org_id AND c.id = OLD.write_connection_id;
      IF v_status IS DISTINCT FROM 'revoked' THEN
        RAISE EXCEPTION 'ADS_WRITE_CONNECTION_OPEN' USING ERRCODE = '55000';
      END IF;
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.write_connection_id IS NOT DISTINCT FROM OLD.write_connection_id AND NEW.write_granted_by_hash IS NOT DISTINCT FROM OLD.write_granted_by_hash THEN
    RETURN NEW;
  END IF;
  -- A connection is replaced or cleared only once the old one is closed: no row forgets a sealed token that is still open.
  IF TG_OP = 'UPDATE' AND OLD.write_connection_id IS NOT NULL AND NEW.write_connection_id IS DISTINCT FROM OLD.write_connection_id THEN
    SELECT c.status INTO v_status FROM crove_kernel.channel_connection c WHERE c.org_id = OLD.org_id AND c.id = OLD.write_connection_id;
    IF v_status IS DISTINCT FROM 'revoked' THEN
      RAISE EXCEPTION 'ADS_WRITE_CONNECTION_OPEN' USING ERRCODE = '55000';
    END IF;
  END IF;
  -- A row made with no write connection, and a clearing by the system (the platform's deletion callback, a job), pass.
  IF NEW.write_connection_id IS NULL AND NEW.write_granted_by_hash IS NULL AND (TG_OP = 'INSERT' OR v_actor = 'system') THEN
    RETURN NEW;
  END IF;
  IF v_actor = 'user' AND v_user IS NOT NULL THEN
    SELECT m.role INTO v_role FROM crove_kernel.tenant_member m WHERE m.org_id = NEW.org_id AND m.user_id = v_user;
  END IF;
  IF NEW.write_connection_id IS NULL AND NEW.write_granted_by_hash IS NULL THEN
    -- A clearing: an owner or an admin.
    IF v_role IS DISTINCT FROM 'owner' AND v_role IS DISTINCT FROM 'admin' THEN
      RAISE EXCEPTION 'ADS_WRITE_CONNECTION_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  -- An attaching or a replacing: the owner alone.
  IF v_role IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'ADS_WRITE_CONNECTION_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  -- Only while the org's switch is on. The setting is read FOR SHARE, so a switch-off running at the same moment either commits first
  -- (and this refuses) or waits for this change and then closes the connection it attached.
  SELECT s.write_enabled INTO v_on FROM crove_ads.ad_org_setting s WHERE s.org_id = NEW.org_id ORDER BY s.id LIMIT 1 FOR SHARE;
  IF v_on IS NOT TRUE THEN
    RAISE EXCEPTION 'ADS_WRITE_OFF' USING ERRCODE = '55000';
  END IF;
  -- Only a live connection of this account's own write twin: the provider `<x>write_ads` of an account of `<x>_ads`, for the same platform account.
  IF NOT EXISTS (
    SELECT 1 FROM crove_kernel.channel_connection c
    WHERE c.org_id = NEW.org_id AND c.id = NEW.write_connection_id AND c.status = 'active'
      AND c.external_account_id = NEW.external_account_id AND c.provider = pg_catalog.left(NEW.provider, -4) || 'write_ads'
  ) THEN
    RAISE EXCEPTION 'ADS_WRITE_CONNECTION_INVALID' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_ads.write_connection_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

DROP TRIGGER IF EXISTS write_connection_guard ON crove_ads.ad_account;
CREATE TRIGGER write_connection_guard BEFORE INSERT OR UPDATE OF write_connection_id, write_granted_by_hash ON crove_ads.ad_account
  FOR EACH ROW EXECUTE FUNCTION crove_ads.write_connection_guard();
ALTER TABLE crove_ads.ad_account ENABLE ALWAYS TRIGGER write_connection_guard;
DROP TRIGGER IF EXISTS write_connection_delete_guard ON crove_ads.ad_account;
CREATE TRIGGER write_connection_delete_guard BEFORE DELETE ON crove_ads.ad_account
  FOR EACH ROW EXECUTE FUNCTION crove_ads.write_connection_guard();
ALTER TABLE crove_ads.ad_account ENABLE ALWAYS TRIGGER write_connection_delete_guard;

-- The platform's data deletion request (A3, R7) finds the accounts a person granted by the hash of the read grant (deletion_request_claim,
-- left as it is). A write grant has its own hash, so the worker asks for the accounts of the claimed codes whose write connection alone the
-- person granted: the relay closes and forgets that write connection and leaves the account, which another person's grant still reads. An
-- account the person granted for reading too is the first claim's: the relay erases it, which closes its write connection as well. The
-- codes are the ones the first claim returned, so both answers are about the same requests.
CREATE OR REPLACE FUNCTION crove_ads.deletion_request_claim_write(p_codes text[])
RETURNS TABLE (code text, org_id uuid, ad_account_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT q.code, a.org_id, a.id
  FROM crove_ads.deletion_request q
  JOIN crove_ads.ad_account a ON a.write_granted_by_hash = q.user_hash AND a.granted_by_hash IS DISTINCT FROM q.user_hash
  JOIN crove_kernel.tenant t ON t.org_id = a.org_id AND t.status IN ('active', 'offboarding')
  WHERE q.completed_at IS NULL AND q.code = ANY (p_codes[1:1000])
$$;
REVOKE ALL ON FUNCTION crove_ads.deletion_request_claim_write(text[]) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_ads.deletion_request_claim_write(text[]) TO crove_worker;
