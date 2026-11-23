-- SPDX-License-Identifier: AGPL-3.0-only
-- Keep the mail tables closed to the sealed contexts of an MCP grant (#3956, review follow-up N2 of #3941; ADR-0051 decision 12 opens conversations and CRM to a grant and says "nothing else new").
-- Before this migration the tables that hold mail had only the org policy (and, on mail_message, the reply restriction), so a sealed MCP context (kinds `mcp_company`, `mcp_member` and the write kinds) read
-- every mail row of its org: the recipient address, the subject and the merge data of every mail the org sent (mail_message), the delivery events of those mails (mail_event), the stopped addresses
-- (mail_suppression, hashes only), the sender address, subject and text of every mail the org received (inbound_message) and the daily digest marker (today_mail, which a user policy already hides from an agent).
-- A grant reads mail only through the conversation policies of 20270119100000, where a person's own scope and the member binding decide; the raw mail tables have no such rule and need none opened.
-- The one exception (PO decision on #3956, kept from #3941): the reply row of a conversation thread stays readable by a grant exactly as far as the thread is (mail_message_conversation_reply), so the acceptance
-- is "zero non-reply mail rows; reply rows only of threads the grant may read".
--
-- One restrictive policy, `mcp_sealed_closed`, FOR ALL on each of the four other tables (FOR SELECT plus one policy per write command on mail_message, below), to the tenant role: a row is refused to a context whose sealed kind starts with `mcp_`. The prefix is read, not a list of kinds, so a
-- sealed MCP kind added later (the company, draft, proposal, member, Engage and Ads kinds exist today) is closed here without a new migration: the policy fails closed for the family, not open for the unknown kind.
-- A context with no sealed kind (a person, the system, an org-chart agent) has a NULL kind, `IS DISTINCT FROM 'mcp_'` is true for it, and nothing changes for anyone but a grant: no person's, worker's or system's
-- access moves. FOR ALL also closes the write side, which agent_write_guard already refuses to every sealed MCP kind on these tables (only audit, draft post, proposal and the Engage rows are written), as a second wall.
-- The kind is read inline (`ctx_verified() ->> 'kind'`, sub-selected so the sealed context is verified once per statement, not once per row) and compared by prefix, never named, so no policy names `mcp_company` or
-- `mcp_member` and no function is added: the nets of mcp-grant-read.db.test.ts, mcp-company-context.db.test.ts and member-vy-background.db.test.ts are unchanged. A later decision that opens mail to a grant adds
-- its own read branch on top of the person's rule in its own migration; this policy is the default it replaces for that table alone.
-- Idempotent (drop and create). Pinned in test/invariant/mcp-mail-closed.db.test.ts.
SET LOCAL lock_timeout = '2s';

-- mail_message: every source is closed to a sealed MCP context except the reply row of a conversation thread (source `kernel.conversation.reply`), which #3941 lets a grant read exactly as far as it may read the
-- thread (ADR-0051 decision 12; pinned in mcp-grant-read.db.test.ts): that row stays governed by the existing restrictive policy mail_message_conversation_reply, which asks for the thread's own message and
-- so for the conversation policies. The exception is for READING only; the three write commands are closed to every sealed MCP kind without it.
DROP POLICY IF EXISTS mcp_sealed_closed ON ludy_kernel.mail_message;
CREATE POLICY mcp_sealed_closed ON ludy_kernel.mail_message AS RESTRICTIVE FOR SELECT TO ludy_tenant
  USING (source = 'kernel.conversation.reply' OR pg_catalog.left(((SELECT ludy_kernel.ctx_verified()) ->> 'kind'), 4) IS DISTINCT FROM 'mcp_');
DROP POLICY IF EXISTS mcp_sealed_closed_insert ON ludy_kernel.mail_message;
CREATE POLICY mcp_sealed_closed_insert ON ludy_kernel.mail_message AS RESTRICTIVE FOR INSERT TO ludy_tenant
  WITH CHECK (pg_catalog.left(((SELECT ludy_kernel.ctx_verified()) ->> 'kind'), 4) IS DISTINCT FROM 'mcp_');
DROP POLICY IF EXISTS mcp_sealed_closed_update ON ludy_kernel.mail_message;
CREATE POLICY mcp_sealed_closed_update ON ludy_kernel.mail_message AS RESTRICTIVE FOR UPDATE TO ludy_tenant
  USING (pg_catalog.left(((SELECT ludy_kernel.ctx_verified()) ->> 'kind'), 4) IS DISTINCT FROM 'mcp_')
  WITH CHECK (pg_catalog.left(((SELECT ludy_kernel.ctx_verified()) ->> 'kind'), 4) IS DISTINCT FROM 'mcp_');
DROP POLICY IF EXISTS mcp_sealed_closed_delete ON ludy_kernel.mail_message;
CREATE POLICY mcp_sealed_closed_delete ON ludy_kernel.mail_message AS RESTRICTIVE FOR DELETE TO ludy_tenant
  USING (pg_catalog.left(((SELECT ludy_kernel.ctx_verified()) ->> 'kind'), 4) IS DISTINCT FROM 'mcp_');

DROP POLICY IF EXISTS mcp_sealed_closed ON ludy_kernel.mail_event;
CREATE POLICY mcp_sealed_closed ON ludy_kernel.mail_event AS RESTRICTIVE FOR ALL TO ludy_tenant
  USING (pg_catalog.left(((SELECT ludy_kernel.ctx_verified()) ->> 'kind'), 4) IS DISTINCT FROM 'mcp_')
  WITH CHECK (pg_catalog.left(((SELECT ludy_kernel.ctx_verified()) ->> 'kind'), 4) IS DISTINCT FROM 'mcp_');

DROP POLICY IF EXISTS mcp_sealed_closed ON ludy_kernel.mail_suppression;
CREATE POLICY mcp_sealed_closed ON ludy_kernel.mail_suppression AS RESTRICTIVE FOR ALL TO ludy_tenant
  USING (pg_catalog.left(((SELECT ludy_kernel.ctx_verified()) ->> 'kind'), 4) IS DISTINCT FROM 'mcp_')
  WITH CHECK (pg_catalog.left(((SELECT ludy_kernel.ctx_verified()) ->> 'kind'), 4) IS DISTINCT FROM 'mcp_');

DROP POLICY IF EXISTS mcp_sealed_closed ON ludy_kernel.inbound_message;
CREATE POLICY mcp_sealed_closed ON ludy_kernel.inbound_message AS RESTRICTIVE FOR ALL TO ludy_tenant
  USING (pg_catalog.left(((SELECT ludy_kernel.ctx_verified()) ->> 'kind'), 4) IS DISTINCT FROM 'mcp_')
  WITH CHECK (pg_catalog.left(((SELECT ludy_kernel.ctx_verified()) ->> 'kind'), 4) IS DISTINCT FROM 'mcp_');

DROP POLICY IF EXISTS mcp_sealed_closed ON ludy_kernel.today_mail;
CREATE POLICY mcp_sealed_closed ON ludy_kernel.today_mail AS RESTRICTIVE FOR ALL TO ludy_tenant
  USING (pg_catalog.left(((SELECT ludy_kernel.ctx_verified()) ->> 'kind'), 4) IS DISTINCT FROM 'mcp_')
  WITH CHECK (pg_catalog.left(((SELECT ludy_kernel.ctx_verified()) ->> 'kind'), 4) IS DISTINCT FROM 'mcp_');
