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
-- crove_ads.write_connection_guard   fires for every role on a change of either column: a connection attached or changed by a signed-in
--                        owner alone (an admin, a member, an agent and the system are refused: the owner connects), and cleared by an owner or
--                        an admin or by the system (the commands that close it and the platform's deletion callback).
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
END $$;
-- One account per write connection, and the index the composite foreign key needs (led by org_id).
CREATE UNIQUE INDEX IF NOT EXISTS ad_account_write_connection_uq ON crove_ads.ad_account (org_id, write_connection_id) WHERE write_connection_id IS NOT NULL;
GRANT UPDATE (write_connection_id, write_granted_by_hash) ON crove_ads.ad_account TO crove_tenant;

CREATE OR REPLACE FUNCTION crove_ads.write_connection_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_actor text := crove_kernel.ctx_actor_type();
  v_user uuid := crove_kernel.ctx_user_id();
  v_role text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.write_connection_id IS NOT DISTINCT FROM OLD.write_connection_id AND NEW.write_granted_by_hash IS NOT DISTINCT FROM OLD.write_granted_by_hash THEN
    RETURN NEW;
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
  ELSIF v_role IS DISTINCT FROM 'owner' THEN
    -- An attaching or a replacing: the owner alone.
    RAISE EXCEPTION 'ADS_WRITE_CONNECTION_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_ads.write_connection_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

DROP TRIGGER IF EXISTS write_connection_guard ON crove_ads.ad_account;
CREATE TRIGGER write_connection_guard BEFORE INSERT OR UPDATE OF write_connection_id, write_granted_by_hash ON crove_ads.ad_account
  FOR EACH ROW EXECUTE FUNCTION crove_ads.write_connection_guard();
ALTER TABLE crove_ads.ad_account ENABLE ALWAYS TRIGGER write_connection_guard;
