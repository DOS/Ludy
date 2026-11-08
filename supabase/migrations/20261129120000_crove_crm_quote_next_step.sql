-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove CRM quotes Q6 (issue #2699, docs/plan/crm-quotes.md section 7 item 6): the follow-up of a sent quote is a next step of its deal. Idempotent;
-- applied files stay untouched.
--   1. deal_next_step.reason takes two more fixed reasons, quote_unanswered (a quote was sent 5 days ago or more and is still waiting for an answer)
--      and quote_expiring (a sent quote is valid for 3 more days or fewer), and closed_reason takes quote_decided (the quote was accepted, declined,
--      replaced by a revision or deleted, so the step has nothing left to follow up). The sets are the product's (packages/db/src/schema.ts, compared
--      with these constraints by check-unions.db.test.ts). A step is still one per deal (deal_next_step_open_uq), raised by the daily rule alone.
--   2. crove_crm.deal_stale_orgs also lists the orgs with a sent quote on an open deal that the rule may follow up (a superset: the command applies the
--      exact days and everything else), so the nightly pass walks them too.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_crm.deal_next_step DROP CONSTRAINT IF EXISTS deal_next_step_reason_check;
ALTER TABLE crove_crm.deal_next_step ADD CONSTRAINT deal_next_step_reason_check CHECK (reason IN ('no_activity', 'past_close', 'quote_unanswered', 'quote_expiring')) NOT VALID;
ALTER TABLE crove_crm.deal_next_step VALIDATE CONSTRAINT deal_next_step_reason_check;

ALTER TABLE crove_crm.deal_next_step DROP CONSTRAINT IF EXISTS deal_next_step_closed_reason_check;
ALTER TABLE crove_crm.deal_next_step ADD CONSTRAINT deal_next_step_closed_reason_check
  CHECK (closed_reason IS NULL OR closed_reason IN ('deal_edited', 'deal_moved', 'deal_closed', 'quote_decided')) NOT VALID;
ALTER TABLE crove_crm.deal_next_step VALIDATE CONSTRAINT deal_next_step_closed_reason_check;

CREATE OR REPLACE FUNCTION crove_crm.deal_stale_orgs(p_after uuid, p_limit integer)
RETURNS TABLE (org_id uuid) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') OR crove_kernel.ctx_actor_type() IS NOT NULL THEN
    RAISE EXCEPTION 'CRM_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT o.org_id FROM (
    SELECT d.org_id
    FROM crove_crm.deal d
    JOIN crove_kernel.tenant t ON t.org_id = d.org_id AND t.status = 'active'
    WHERE d.closed_at IS NULL
      AND (p_after IS NULL OR d.org_id > p_after)
      AND (d.updated_at < pg_catalog.now() - pg_catalog.make_interval(days => 7)
           OR d.expected_close < (pg_catalog.now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date)
      -- Not a deal the command would pass over: one with an open step, or one whose step was resolved within the least N can be (7 days), so an org
      -- whose stale deals all have steps drops out of the list and the nightly pass does not walk it (or write its audit row) again.
      AND NOT EXISTS (SELECT 1 FROM crove_crm.deal_next_step n
                      WHERE n.org_id = d.org_id AND n.deal_id = d.id
                        AND (n.status = 'open' OR n.resolved_at > pg_catalog.now() - pg_catalog.make_interval(days => 7)))
    UNION
    -- A sent quote the rule may follow up (still valid, and sent 5 days ago or more or valid for 3 more days or fewer) on an open deal with no open step, and no step
    -- resolved in the last 7 days; and an open quote step whose quote is no longer waiting (to be closed).
    SELECT d.org_id
    FROM crove_crm.deal d
    JOIN crove_kernel.tenant t ON t.org_id = d.org_id AND t.status = 'active'
    WHERE d.closed_at IS NULL
      AND (p_after IS NULL OR d.org_id > p_after)
      AND ((EXISTS (SELECT 1 FROM crove_crm.quote q
                    WHERE q.org_id = d.org_id AND q.deal_id = d.id AND q.status = 'sent'
                      -- Still valid: a quote past its last day is not followed up (expiry is not stored, so it would stay `sent` and nag for ever).
                      AND q.valid_until >= (pg_catalog.now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
                      AND (q.sent_at < pg_catalog.now() - pg_catalog.make_interval(days => 5)
                           OR q.valid_until <= (pg_catalog.now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date + 3))
            AND NOT EXISTS (SELECT 1 FROM crove_crm.deal_next_step n
                            WHERE n.org_id = d.org_id AND n.deal_id = d.id
                              AND (n.status = 'open' OR n.resolved_at > pg_catalog.now() - pg_catalog.make_interval(days => 7))))
           OR EXISTS (SELECT 1 FROM crove_crm.deal_next_step n
                      WHERE n.org_id = d.org_id AND n.deal_id = d.id AND n.status = 'open' AND n.reason IN ('quote_unanswered', 'quote_expiring')
                        AND NOT EXISTS (SELECT 1 FROM crove_crm.quote q WHERE q.org_id = d.org_id AND q.deal_id = d.id AND q.status = 'sent')))
  ) o
  ORDER BY 1
  LIMIT LEAST(GREATEST(p_limit, 1), 1000);
END $$;
REVOKE ALL ON FUNCTION crove_crm.deal_stale_orgs(uuid, integer) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_crm.deal_stale_orgs(uuid, integer) TO crove_worker;
