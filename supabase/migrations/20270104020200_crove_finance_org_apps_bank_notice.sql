-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove Finance (issue #3310, ADR-0053 slice c, C2a): the bank feed notices of an org whose Finance is off are dropped.
-- Idempotent (CREATE OR REPLACE keeps the function's owner and grants); applied files stay untouched.
--
-- A notice names the bank's account, not the org, so the worker's claim is where its org is found. A notice of an org whose Finance is off is taken off the
-- queue and dropped like one that matches no account, with `AND crove_kernel.org_app_on(t.org_id, 'finance')` in the join to the active tenant, the body of
-- 20261108130000_crove_finance_bank_feed_notice.sql otherwise unchanged. The HTTP side answered 2xx already, so the provider keeps its subscription. The daily
-- bank feed sync and the pull the next notice starts read each account from its stored cursor, so the gap is recovered once Finance is back on.
SET LOCAL lock_timeout = '2s';

-- crove_finance.bank_feed_notice_claim: the body of 20261108130000_crove_finance_bank_feed_notice.sql (the newest), with the app check added to its active-tenant test.
CREATE OR REPLACE FUNCTION crove_finance.bank_feed_notice_claim(p_limit integer)
RETURNS TABLE (org_id uuid, connection_id uuid, provider text)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH claimed AS (
    DELETE FROM crove_finance.bank_feed_notice_pending p
    WHERE p.seq IN (
      SELECT q.seq FROM crove_finance.bank_feed_notice_pending q ORDER BY q.seq LIMIT LEAST(GREATEST(p_limit, 1), 1000) FOR UPDATE SKIP LOCKED
    )
    RETURNING p.provider, p.external_account_id
  ),
  matched AS (
    SELECT claimed.provider AS m_claimed_provider, claimed.external_account_id AS account, c.org_id AS m_org, c.id AS m_connection, c.provider AS m_provider
    FROM claimed
    JOIN crove_finance.bank_feed_listed_account l ON l.external_account_id = claimed.external_account_id
    JOIN crove_kernel.channel_connection c ON c.org_id = l.org_id AND c.id = l.channel_connection_id AND c.provider = claimed.provider
    JOIN crove_kernel.tenant t ON t.org_id = c.org_id AND t.status = 'active' AND crove_kernel.org_app_on(t.org_id, 'finance')
    WHERE c.status = 'active'
  )
  SELECT m.m_org, m.m_connection, m.m_provider FROM matched m
  UNION ALL
  SELECT NULL::uuid, NULL::uuid, NULL::text FROM claimed
  WHERE NOT EXISTS (SELECT 1 FROM matched m2 WHERE m2.account = claimed.external_account_id AND m2.m_claimed_provider = claimed.provider)
$$;
