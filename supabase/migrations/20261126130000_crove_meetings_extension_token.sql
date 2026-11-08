-- SPDX-License-Identifier: AGPL-3.0-only
-- Which extension token created a meeting (issue #2582, ADR-0047 point 10). Idempotent; applied files stay untouched.
--
-- The meetings scope of the Ludy extension may create a meeting and then upload to it, finish the upload and read its
-- status, only for the meetings that same token created. The command that creates a meeting stamps the token's id here
-- when the actor is an extension token; a meeting made in the app or by another token has none or another id, so a token
-- reaches no other meeting. Not a foreign key: extension_token is definer-only machinery of the kernel, and a revoked
-- or expired token's meetings stay what they are.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_meetings.meeting ADD COLUMN IF NOT EXISTS extension_token_id uuid;
