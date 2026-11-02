-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove Ads W0a-2 (issue #2294, ADR-0043 point 1, plan docs/plan/ads-write.md section 10): what opens the way to spend becomes a
-- proposal. Nothing here calls a platform and nothing spends. Idempotent; applied files stay untouched.
--
-- crove_ads.approved_execution           the second way through the guards of 20261117120000, opened. It answers true only
--                                        while the statement runs inside the execution of an approved proposal: a proposal of
--                                        the org in context, for exactly this command, in the state `approved` (which the
--                                        runtime never commits: it is `executed` by the end of the transaction that approved
--                                        it), decided by the signed-in user of this context in this very transaction, and whose
--                                        payload names the change being written (the account, or the scope, period, currency
--                                        and amount of the cap). The system and agent contexts never pass: only a user decides
--                                        a proposal of a human-approved command, and `decided_by` is null on an agent's
--                                        approval. A raw statement outside that transaction finds no `approved` row; one
--                                        inside it can write only the change the approver was shown.
-- crove_ads.switch_guard, cap_guard      replaced to pass the change they guard to approved_execution.
--
-- The approval policy rows of the four ads commands are in 20261118170100_crove_kernel_approval_policy_ads.sql, a crove_kernel migration.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_ads.approved_execution(p_command text, p_match jsonb DEFAULT NULL, p_amount numeric DEFAULT NULL) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1
    FROM crove_kernel.proposal p
    WHERE p.org_id = crove_kernel.ctx_org_id()
      AND p.command = p_command
      AND p.status = 'approved'
      -- The revision that was approved: the status guard lets a content change through on a row that is not terminal when the
      -- revision grows, so an approved row whose payload was rewritten in the same transaction has moved past revision 1. Ads
      -- proposals have no reviser (no edit makes a new revision), and asking again is a new row at revision 1.
      AND p.revision = 1
      AND p.executed_command_id IS NOT NULL
      AND crove_kernel.ctx_actor_type() = 'user'
      AND p.decided_by IS NOT NULL
      AND p.decided_by = crove_kernel.ctx_user_id()
      AND p.decided_at = pg_catalog.now()
      AND (p_match IS NULL OR p.payload @> p_match)
      AND (p_amount IS NULL OR (p.payload ->> 'amount')::numeric = p_amount)
  )
$$;
REVOKE ALL ON FUNCTION crove_ads.approved_execution(text, jsonb, numeric) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

CREATE OR REPLACE FUNCTION crove_ads.switch_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_actor text := crove_kernel.ctx_actor_type();
  v_user uuid := crove_kernel.ctx_user_id();
  v_role text;
  v_open_commands text[] := ARRAY[]::text[];
  v_open_matches jsonb[] := ARRAY[]::jsonb[];
  v_closes boolean;
BEGIN
  IF TG_TABLE_NAME = 'ad_org_setting' THEN
    NEW.updated_by := CASE WHEN v_actor = 'user' THEN v_user END;
    NEW.updated_at := pg_catalog.clock_timestamp();
    IF NEW.write_enabled AND NOT COALESCE(OLD.write_enabled, false) THEN
      v_open_commands := pg_catalog.array_append(v_open_commands, 'ads.write.enable'::text);
      v_open_matches := pg_catalog.array_append(v_open_matches, NULL::jsonb);
    END IF;
    IF COALESCE(OLD.launches_blocked, false) AND NOT NEW.launches_blocked THEN
      v_open_commands := pg_catalog.array_append(v_open_commands, 'ads.launches.unblock'::text);
      v_open_matches := pg_catalog.array_append(v_open_matches, NULL::jsonb);
    END IF;
    v_closes := (COALESCE(OLD.write_enabled, false) AND NOT NEW.write_enabled) OR (NEW.launches_blocked AND NOT COALESCE(OLD.launches_blocked, false));
  ELSE
    IF NEW.write_enabled AND NOT COALESCE(OLD.write_enabled, false) THEN
      v_open_commands := pg_catalog.array_append(v_open_commands, 'ads.account.enable_write'::text);
      v_open_matches := pg_catalog.array_append(v_open_matches, pg_catalog.jsonb_build_object('adAccountId', NEW.id::text));
    END IF;
    v_closes := COALESCE(OLD.write_enabled, false) AND NOT NEW.write_enabled;
  END IF;
  IF pg_catalog.cardinality(v_open_commands) = 0 AND NOT v_closes THEN
    RETURN NEW;
  END IF;
  IF v_actor = 'user' AND v_user IS NOT NULL THEN
    SELECT m.role INTO v_role FROM crove_kernel.tenant_member m WHERE m.org_id = NEW.org_id AND m.user_id = v_user;
  END IF;
  -- A stop: an owner or an admin, signed in.
  IF v_closes AND v_role IS DISTINCT FROM 'owner' AND v_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'ADS_SWITCH_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  -- An opening: an owner, or else each opening needs the approved execution of its own command, for this very change.
  IF v_role IS DISTINCT FROM 'owner' THEN
    FOR i IN 1 .. pg_catalog.cardinality(v_open_commands) LOOP
      IF NOT crove_ads.approved_execution(v_open_commands[i], v_open_matches[i]) THEN
        RAISE EXCEPTION 'ADS_SWITCH_FORBIDDEN' USING ERRCODE = '42501';
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_ads.switch_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

CREATE OR REPLACE FUNCTION crove_ads.cap_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_user uuid := CASE WHEN crove_kernel.ctx_actor_type() = 'user' THEN crove_kernel.ctx_user_id() END;
  v_role text;
  v_match jsonb;
  v_newest uuid;
  v_ms bigint;
  v_hex text;
BEGIN
  IF NEW.org_id IS DISTINCT FROM crove_kernel.ctx_org_id() THEN
    RETURN NEW;
  END IF;
  IF v_user IS NOT NULL THEN
    SELECT m.role INTO v_role FROM crove_kernel.tenant_member m WHERE m.org_id = NEW.org_id AND m.user_id = v_user;
  END IF;
  IF v_role IS DISTINCT FROM 'owner' THEN
    v_match := pg_catalog.jsonb_build_object('scope', NEW.scope, 'period', NEW.period, 'currency', NEW.currency);
    IF NEW.ad_account_id IS NOT NULL THEN
      v_match := v_match || pg_catalog.jsonb_build_object('adAccountId', NEW.ad_account_id::text);
    END IF;
    IF NOT crove_ads.approved_execution('ads.cap.set', v_match, NEW.amount) THEN
      RAISE EXCEPTION 'ADS_CAP_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
  END IF;
  -- "The latest cap" is the newest id, so the id is made strictly above every id the org has (two ids made in the same
  -- millisecond may sort either way). Wait for the next millisecond a few times; if the database clock is behind the newest id
  -- (it stepped back), continue from that id instead: its millisecond plus one, so a stop (a lowering) is never refused or held
  -- by the clock and the order of the caps still follows the order they were made in. The commands insert under the org's lock.
  FOR i IN 1 .. 5 LOOP
    NEW.id := crove_kernel.uuid_v7();
    EXIT WHEN NOT EXISTS (SELECT 1 FROM crove_ads.ad_spend_cap c WHERE c.org_id = NEW.org_id AND c.id >= NEW.id);
    IF i = 5 THEN
      SELECT c.id INTO v_newest FROM crove_ads.ad_spend_cap c WHERE c.org_id = NEW.org_id ORDER BY c.id DESC LIMIT 1;
      -- A uuid v7 begins with a 48-bit millisecond count, its first twelve hex digits.
      v_ms := ('x' || pg_catalog.substr(pg_catalog.replace(v_newest::text, '-', ''), 1, 12))::bit(48)::bigint + 1;
      v_hex := pg_catalog.lpad(pg_catalog.to_hex(v_ms), 12, '0') || pg_catalog.substr(pg_catalog.replace(NEW.id::text, '-', ''), 13);
      NEW.id := (pg_catalog.substr(v_hex, 1, 8) || '-' || pg_catalog.substr(v_hex, 9, 4) || '-' || pg_catalog.substr(v_hex, 13, 4) || '-' || pg_catalog.substr(v_hex, 17, 4) || '-' || pg_catalog.substr(v_hex, 21, 12))::uuid;
    ELSE
      PERFORM pg_catalog.pg_sleep(0.002);
    END IF;
  END LOOP;
  NEW.set_by := COALESCE(v_user, NEW.set_by);
  NEW.set_at := pg_catalog.clock_timestamp();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_ads.cap_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- The one-argument stub of W0a-1 (always false) is gone: the guards above, its only callers, now call the real function, and
-- nothing else in the code names the one-argument form.
-- crove:contract adr=0043
DROP FUNCTION IF EXISTS crove_ads.approved_execution(text);

-- An amount is a finite number above zero: `NaN` ranks above every number in PostgreSQL, so `amount > 0` alone accepts it, and
-- `Infinity` too. Only raw SQL reaches this (the contract admits decimal strings), which is what the guard is for.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'ad_spend_cap_amount_finite' AND conrelid = 'crove_ads.ad_spend_cap'::regclass) THEN
    ALTER TABLE crove_ads.ad_spend_cap ADD CONSTRAINT ad_spend_cap_amount_finite CHECK (amount < 'Infinity'::numeric AND amount <> 'NaN'::numeric);
  END IF;
END $$;
