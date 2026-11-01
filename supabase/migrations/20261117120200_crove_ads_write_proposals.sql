-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove Ads W0a-2 (issue #2294, ADR-0043 point 1, plan docs/plan/ads-write.md section 10): what opens the way to spend becomes a
-- proposal. Nothing here calls a platform and nothing spends. Idempotent; applied files stay untouched.
--
-- crove_kernel.approval_command_policy   gains the four ads commands that open the way to spend, `ads.write.enable`,
--                                        `ads.account.enable_write`, `ads.cap.set` and `ads.launches.unblock`: an owner or an
--                                        admin approves (Q2), no approval permission, four-eyes with the one-person path (P10),
--                                        and none of them posts to the ledger (`ledger` false). Kept equal to approval.ts
--                                        (POLICIES) by apps/kernel/test/invariant/proposal-approve-gate.db.test.ts.
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
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.approval_command_policy(p_command text, OUT roles text[], OUT permission text, OUT four_eyes boolean, OUT ledger boolean)
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  WITH kind AS (
    SELECT p_command IN ('finance.purchase.record', 'finance.journal.reverse', 'finance.voucher.record',
                         'finance.journal_voucher.record', 'finance.closing.record', 'finance.depreciation.record') AS is_ledger,
           p_command IN ('ads.write.enable', 'ads.account.enable_write', 'ads.cap.set', 'ads.launches.unblock') AS is_ads
  )
  SELECT CASE WHEN k.is_ledger OR k.is_ads THEN ARRAY['owner', 'admin']::text[] ELSE ARRAY[]::text[] END,
         CASE WHEN k.is_ledger THEN 'finance.proposal.approve' END,
         true,
         k.is_ledger
  FROM kind k
$$;
REVOKE ALL ON FUNCTION crove_kernel.approval_command_policy(text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

CREATE OR REPLACE FUNCTION crove_ads.approved_execution(p_command text, p_match jsonb DEFAULT NULL, p_amount numeric DEFAULT NULL) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1
    FROM crove_kernel.proposal p
    WHERE p.org_id = crove_kernel.ctx_org_id()
      AND p.command = p_command
      AND p.status = 'approved'
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
  NEW.id := crove_kernel.uuid_v7();
  NEW.set_by := COALESCE(v_user, NEW.set_by);
  NEW.set_at := pg_catalog.clock_timestamp();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_ads.cap_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- The one-argument stub of W0a-1 (always false) is gone: the guards above call the real function.
DROP FUNCTION IF EXISTS crove_ads.approved_execution(text);
