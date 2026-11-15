-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove kernel, issue #3223 (follow-up of #3222 and #2704): the email behind a Ludy extension token and behind an MCP grant, for the API login only.
--
-- AUTH_ALLOWED_EMAILS (#3222) is checked on the email claim of a browser access token. A Ludy extension token (`crx_`) and an MCP grant carry no
-- email, so the edge cannot apply the list to them without reading the account's. These two read-only definers give it that and nothing else; the
-- edge asks only when the deployment set the list, and BEFORE verify_extension_token / mcp_grant_verify, which stamp last_used_at: a refused
-- account costs no database write.
--
-- crove_kernel.extension_token_account_email(bytea)   the email of the account that owns the token with this SHA-256 hash, or NULL when no token has it.
-- crove_kernel.mcp_grant_account_email(uuid)          the email of the account that gave this MCP grant, or NULL when there is no such grant.
--
-- They do not look at standing (revoked, expired, role, org): a token or grant that is not in good standing is refused by the verify definers as
-- before, so the list can only ever refuse more, never let anything through. The email is the one Ludy last saw at that account's sign-in
-- (user_account.email), the same value the browser check compared. Both return text and nothing else, are STABLE, pin search_path, and are
-- executable by the API's login alone (the worker takes no part in an extension or MCP request). Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.extension_token_account_email(p_token_hash bytea)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT u.email
  FROM crove_kernel.extension_token x
  JOIN crove_kernel.user_account u ON u.id = x.user_id
  WHERE p_token_hash IS NOT NULL AND pg_catalog.octet_length(p_token_hash) = 32 AND x.token_hash = p_token_hash
$$;

CREATE OR REPLACE FUNCTION crove_kernel.mcp_grant_account_email(p_grant_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT u.email
  FROM crove_kernel.agent_grant g
  JOIN crove_kernel.user_account u ON u.id = g.user_id
  WHERE p_grant_id IS NOT NULL AND g.id = p_grant_id
$$;

REVOKE ALL ON FUNCTION
  crove_kernel.extension_token_account_email(bytea),
  crove_kernel.mcp_grant_account_email(uuid)
FROM PUBLIC;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE 'crove\_%' AND rolname <> current_user LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON FUNCTION crove_kernel.extension_token_account_email(bytea), crove_kernel.mcp_grant_account_email(uuid) FROM %I',
      r.rolname);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION
  crove_kernel.extension_token_account_email(bytea),
  crove_kernel.mcp_grant_account_email(uuid)
TO crove_app;
