-- SPDX-License-Identifier: AGPL-3.0-only
-- Step 2 of 2 of the extension id binding (issue #2855; step 1 was #2850 / #2851). Idempotent; applied files stay untouched.
-- Drops the two definers that could make or exchange a code with no extension id: the 5-argument issue_extension_auth_code and the
-- 3-argument exchange_extension_auth_code. Only the id-bound 6-argument issue and 4-argument exchange (20261201030000) remain; the
-- API, the runtime command and the invariant suite use them alone. A code that was open when this ran is unbound or bound; an
-- unbound one can no longer be exchanged by anything (the 4-argument exchange refuses it), and codes live five minutes.
SET LOCAL lock_timeout = '2s';

DROP FUNCTION IF EXISTS crove_kernel.issue_extension_auth_code(bytea, text, text, text[], text);
DROP FUNCTION IF EXISTS crove_kernel.exchange_extension_auth_code(bytea, text, bytea);
