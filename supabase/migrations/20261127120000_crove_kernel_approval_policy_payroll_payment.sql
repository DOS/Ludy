-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove approval policy for the payment of a pay run's obligation (issue #2532, ADR-0046): finance.payroll_payment.record is an R3 ledger proposal command, a payment voucher built from the frozen run
-- (the net pay or a remittance): the roles that post approve (owner, admin) and a member holding finance.proposal.approve through an org-wide assignment, four-eyes with the one-person
-- path (P10), and a ledger effect required before the proposal moves to 'executed' (crove_finance.ledger_effect_recorded, 20261127110000). Kept equal to approval.ts (POLICIES,
-- APPROVAL_POLICY_VERSION 10) by apps/kernel/test/invariant/proposal-approve-gate.db.test.ts.
--
-- crove_kernel.approval_command_policy  the policy table, with the new command in the ledger list: the body of 20261126130000 with the command added (the signature and OUT columns are unchanged).
-- crove_kernel.proposal_co_authors_guard  the body of 20261126170000 with the new command in the list of commands whose proposals may carry co-authors: the person who approved the run is a co-author of the payment of
--                                        its net pay and its remittances, as of its posting (#2736), so four-eyes holds them back (co-authors only restrict, never grant). The trigger itself is unchanged.
-- Idempotent; applied files stay untouched. approval_command_live is unchanged: the posting is judged on the snapshot of the members at the request, like every other ledger command.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.approval_command_policy(p_command text, OUT roles text[], OUT permission text, OUT four_eyes boolean, OUT ledger boolean)
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  WITH kind AS (
    SELECT p_command IN ('finance.purchase.record', 'finance.journal.reverse', 'finance.voucher.record',
                         'finance.journal_voucher.record', 'finance.closing.record', 'finance.depreciation.record', 'finance.stock.close_period',
                         'finance.stock.count_confirm', 'finance.payroll_posting.record', 'finance.payroll_payment.record') AS is_ledger,
           p_command IN ('ads.write.enable', 'ads.account.enable_write', 'ads.cap.set', 'ads.launches.unblock', 'ads.campaign.launch') AS is_ads,
           p_command IN ('finance.einvoice.issue') AS is_einvoice
  )
  SELECT CASE WHEN k.is_ledger OR k.is_ads OR k.is_einvoice THEN ARRAY['owner', 'admin']::text[] ELSE ARRAY[]::text[] END,
         CASE WHEN k.is_ledger THEN 'finance.proposal.approve' END,
         true,
         k.is_ledger
  FROM kind k
$$;
REVOKE ALL ON FUNCTION crove_kernel.approval_command_policy(text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

CREATE OR REPLACE FUNCTION crove_kernel.proposal_co_authors_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_staff boolean;
BEGIN
  SELECT r.rolsuper
         OR pg_catalog.pg_has_role(r.oid, (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID), 'USAGE')
         OR pg_catalog.pg_has_role(CURRENT_USER, (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID), 'USAGE')
    INTO v_staff
  FROM pg_catalog.pg_roles r WHERE r.rolname = SESSION_USER;
  IF COALESCE(v_staff, false) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.co_authors IS NULL THEN
      RETURN NEW;
    END IF;
    IF NEW.status IS DISTINCT FROM 'pending'
       OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user'
       OR NEW.command <> ALL (ARRAY['finance.payroll_posting.record', 'finance.payroll_payment.record'])
       OR pg_catalog.array_ndims(NEW.co_authors) IS DISTINCT FROM 1
       OR pg_catalog.cardinality(NEW.co_authors) NOT BETWEEN 1 AND 10
       OR pg_catalog.array_position(NEW.co_authors, NULL) IS NOT NULL
       -- An id zod's z.uuid() refuses (not RFC 9562) is refused here too, as proposal_approval_decide reads authors; a null one is refused above.
       OR EXISTS (SELECT 1 FROM pg_catalog.unnest(NEW.co_authors) AS c WHERE c::text !~ '^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$') THEN
      RAISE EXCEPTION 'PROPOSAL_STATUS_TRANSITION' USING ERRCODE = '23514',
        DETAIL = pg_catalog.json_build_object('to', NEW.status, 'frozen', 'co_authors')::text;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.co_authors IS DISTINCT FROM OLD.co_authors THEN
    RAISE EXCEPTION 'PROPOSAL_STATUS_TRANSITION' USING ERRCODE = '23514',
      DETAIL = pg_catalog.json_build_object('from', OLD.status, 'frozen', 'co_authors')::text;
  END IF;
  RETURN NEW;
END $$;
-- A trigger function only; nobody calls it directly.
REVOKE ALL ON FUNCTION crove_kernel.proposal_co_authors_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
