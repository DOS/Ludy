-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove kernel (issue #2286, part 2 of #2268; plan docs/plan/einvoice-lookup.md sections 3 and 5): an email with no invoice
-- attachment but with the seller's lookup link or code becomes an Inbox item "the original invoice is needed". Idempotent;
-- applied files stay untouched.
--
-- crove_kernel.inbox_item  gets a second kind, finance.invoice.original_needed, next to kernel.job.dead_lettered. One item
--                          per lookup hint of a mail: its dedupe_key is mail:<sha256 of the Message-ID>:<n>, and its detail
--                          holds the provider, the link on that provider's lookup host and the lookup code, nothing else
--                          (never the mail's text, its sender or its subject). The lookup code opens the invoice for
--                          anyone who has it: the detail CHECK keeps the object to those three keys with the shapes the
--                          reader (readLookupHints in @crove/l10n-vn) writes, so a raw text can never be stored in it.
--
-- Who reads it. Until now only owners, admins and the system context read or dismiss an inbox item (inbox_item_read,
-- inbox_item_change, #1780): the items were failed jobs. The new kind is for the people who handle invoices, so the two
-- RESTRICTIVE policies now also let a MEMBER of the org (not a viewer, not an agent) read and dismiss an item of the new
-- kind and of that kind only, when the member's scope is the whole org (a member limited to some legal entities is not:
-- a mail is not tied to an entity, so its lookup code may be another entity's invoice; the same test as the stream's
-- shared notes). A dead-letter item stays with owners and admins. Raising stays with the system context
-- (inbox_item_raise, unchanged); the guard trigger keeps every other context off the detail and keeps the key, the kind
-- and the raise time fixed (inbox_item_guard, unchanged); deletes stay with the system context (inbox_item_prune).
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_kernel.inbox_item DROP CONSTRAINT IF EXISTS inbox_item_kind_check;
ALTER TABLE crove_kernel.inbox_item ADD CONSTRAINT inbox_item_kind_check
  CHECK (kind IN ('kernel.job.dead_lettered', 'finance.invoice.original_needed'));

-- The detail of an original-needed item: provider, url and code, each a string or null (or absent), at least a url or a
-- code, shaped as the reader and zLookupHint (@crove/kernel-contract) write them (a link is printable ASCII after its host:
-- the URL serializer percent-encodes the rest). The size cap of the detail column (1 KB)
-- still holds. NOT VALID is not used: no row of the new kind exists yet.
ALTER TABLE crove_kernel.inbox_item DROP CONSTRAINT IF EXISTS inbox_item_original_detail;
ALTER TABLE crove_kernel.inbox_item ADD CONSTRAINT inbox_item_original_detail CHECK (
  kind <> 'finance.invoice.original_needed' OR (
    (detail - 'provider' - 'url' - 'code') = '{}'::jsonb
    AND COALESCE(pg_catalog.jsonb_typeof(detail -> 'provider'), 'null') IN ('string', 'null')
    AND COALESCE(pg_catalog.jsonb_typeof(detail -> 'url'), 'null') IN ('string', 'null')
    AND COALESCE(pg_catalog.jsonb_typeof(detail -> 'code'), 'null') IN ('string', 'null')
    AND ((detail ->> 'provider') IS NULL OR (detail ->> 'provider') IN ('misa', 'viettel', 'vnpt', 'bkav', 'easyinvoice', 'fpt'))
    AND ((detail ->> 'url') IS NULL OR (pg_catalog.length(detail ->> 'url') <= 400 AND (detail ->> 'url') ~ '^https://[a-z0-9.-]+([/?][!-~]*)?$'))
    AND ((detail ->> 'code') IS NULL OR (detail ->> 'code') ~ '^[A-Za-z0-9]{6,40}$')
    AND ((detail ->> 'url') IS NOT NULL OR (detail ->> 'code') IS NOT NULL)));

-- Read and update: the system context (no user, no agent), an owner or an admin as before, and now a member for the new
-- kind alone. Each context function is wrapped in a subquery, as the tenant policy is, so it runs once per statement.
DROP POLICY IF EXISTS inbox_item_read ON crove_kernel.inbox_item;
CREATE POLICY inbox_item_read ON crove_kernel.inbox_item AS RESTRICTIVE FOR SELECT TO crove_tenant
  USING (
    ((SELECT crove_kernel.ctx_user_id()) IS NULL AND (SELECT crove_kernel.ctx_agent_id()) IS NULL)
    OR EXISTS (
      SELECT 1 FROM crove_kernel.tenant_member m
      WHERE m.org_id = inbox_item.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id())
        AND (m.role IN ('owner', 'admin') OR (m.role = 'member' AND inbox_item.kind = 'finance.invoice.original_needed'
                             AND (SELECT '*' = ANY (crove_kernel.ctx_le_scope()::text[]))))));
DROP POLICY IF EXISTS inbox_item_change ON crove_kernel.inbox_item;
CREATE POLICY inbox_item_change ON crove_kernel.inbox_item AS RESTRICTIVE FOR UPDATE TO crove_tenant
  USING (
    ((SELECT crove_kernel.ctx_user_id()) IS NULL AND (SELECT crove_kernel.ctx_agent_id()) IS NULL)
    OR EXISTS (
      SELECT 1 FROM crove_kernel.tenant_member m
      WHERE m.org_id = inbox_item.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id())
        AND (m.role IN ('owner', 'admin') OR (m.role = 'member' AND inbox_item.kind = 'finance.invoice.original_needed'
                             AND (SELECT '*' = ANY (crove_kernel.ctx_le_scope()::text[]))))));
