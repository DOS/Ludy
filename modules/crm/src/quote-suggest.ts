// SPDX-License-Identifier: AGPL-3.0-only
// What the sales coworker may see when it proposes the lines of a quote (#2698, plan docs/plan/crm-quotes.md section 7):
// - crm.quote.suggest_source (owners, admins, members; read only): the deal's title and amount, its customer's name, the newest inbound messages of the conversations linked to the customer
//   (as far as the member may read them: row-level security applies, so a private message is read by owners, admins and holders of the direct-message permission) and the lines of earlier
//   quotes to the customer, the latest of each description. The messages are read only while the org's switch for AI on customers' words (conversation_setting.auto_draft) is on: with it off
//   none is read, and nothing of the customer reaches the model. No address, tax code, credential or bank account is read. The model is asked outside any transaction, by the API.
// Nothing is written here, no agent runs it (it is not in the agent's allowlist), and it leaves no audit row: a read of the member's own records.
import { sql } from 'kysely';
import { zQuoteSuggestInput } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { money } from '@crove/l10n-vn';
import { DomainError, defineQuery } from '@crove/kernel-runtime';

const EDITORS: readonly MemberRole[] = ['owner', 'admin', 'member'];

// The most messages read and the most earlier lines offered (packages/agent QUOTE_SUGGEST_MESSAGES_MAX and QUOTE_SUGGEST_EARLIER_MAX say the same).
export const SUGGEST_MESSAGES_MAX = 8;
export const SUGGEST_EARLIER_MAX = 30;

export interface QuoteSuggestSource {
  dealTitle: string;
  // The deal's amount as a decimal string; null when it is zero (a deal with no amount yet).
  dealAmount: string | null;
  partyName: string;
  // Whether the org lets customers' words reach a model (the default is yes, as for reply drafts).
  wordsAllowed: boolean;
  // The customer's newest inbound messages, oldest first; empty while the switch is off.
  messages: string[];
  earlier: Array<{ description: string; unit: string | null; unitPrice: string; vatRate: string }>;
}

export const quoteSuggestSource = defineQuery({
  name: 'crm.quote.suggest_source',
  input: zQuoteSuggestInput,
  access: EDITORS,
  handler: async (ctx, input): Promise<QuoteSuggestSource> => {
    const deal = await sql<{ title: string; amount: string; party_id: string; party_name: string }>`
      SELECT d.title, d.amount::text AS amount, d.party_id, p.name AS party_name
      FROM crove_crm.deal d
      JOIN crove_kernel.party p ON p.org_id = d.org_id AND p.id = d.party_id
      WHERE d.org_id = ${ctx.orgId}::uuid AND d.id = ${input.dealId}::uuid`.execute(ctx.trx);
    const row = deal.rows[0];
    if (!row) throw new DomainError('DEAL_NOT_FOUND', 404, 'Không tìm thấy cơ hội này');
    const setting = await sql<{ auto_draft: boolean }>`SELECT auto_draft FROM crove_kernel.conversation_setting WHERE org_id = ${ctx.orgId}::uuid`.execute(ctx.trx);
    const wordsAllowed = setting.rows[0]?.auto_draft ?? true;
    const messages: string[] = [];
    if (wordsAllowed) {
      const written = await sql<{ body: string }>`
        SELECT pg_catalog.left(m.body, 600) AS body
        FROM crove_kernel.conversation_message m
        JOIN crove_kernel.conversation c ON c.org_id = m.org_id AND c.id = m.conversation_id
        WHERE c.org_id = ${ctx.orgId}::uuid AND c.party_id = ${row.party_id}::uuid AND m.direction = 'in' AND m.platform_removed_at IS NULL AND m.body <> ''
        ORDER BY m.id DESC LIMIT ${SUGGEST_MESSAGES_MAX}`.execute(ctx.trx);
      messages.push(...written.rows.map((r) => r.body).reverse());
    }
    const earlier = await sql<{ description: string; unit: string | null; unit_price: string; vat_rate: string }>`
      SELECT h.description, h.unit, h.unit_price, h.vat_rate FROM (
        SELECT DISTINCT ON (pg_catalog.lower(l.description)) l.description, l.unit, l.unit_price::text AS unit_price, l.vat_rate, q.created_at
        FROM crove_crm.quote_line l
        JOIN crove_crm.quote q ON q.org_id = l.org_id AND q.id = l.quote_id
        WHERE q.org_id = ${ctx.orgId}::uuid AND q.party_id = ${row.party_id}::uuid AND l.kind = 'item'
        ORDER BY pg_catalog.lower(l.description), q.created_at DESC, l.line_no
      ) h
      ORDER BY h.created_at DESC, h.description
      LIMIT ${SUGGEST_EARLIER_MAX}`.execute(ctx.trx);
    const amount = money(row.amount);
    return {
      dealTitle: row.title,
      dealAmount: amount.greaterThan(0) ? amount.toFixed() : null,
      partyName: row.party_name,
      wordsAllowed,
      messages,
      earlier: earlier.rows.map((r) => ({ description: r.description, unit: r.unit, unitPrice: money(r.unit_price).toFixed(), vatRate: r.vat_rate })),
    };
  },
});
