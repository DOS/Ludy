// SPDX-License-Identifier: AGPL-3.0-only
// What the Inbox card of an AI coworker's Engage proposal shows (E4 #3863): the fields of the stored payload as plain text, never as markup. The payload is what an outside AI app sent (tainted), and the approval
// sends exactly what was stored, so the card shows exactly that: a control character, a bidirectional embedding, override or isolate or a zero-width mark is NOT dropped (the customer would then read something
// other than what the approver read) but written out as a visible marker, <U+202E>. Each value is cut to a bounded length.
import { sql, type Transaction } from 'kysely';
import { isEngageProposalKind, type EngageProposalView } from '@crove/kernel-contract';
import type { Database } from '@crove/db';

const MAX_FIELDS = 40;
const VALUE_MAX = 8000;
const LONG_FROM = 80;
// Controls other than a newline and a tab, the bidirectional embeddings, overrides and isolates, and the zero-width marks.
const hidden = (code: number): boolean =>
  code <= 0x08 || (code >= 0x0b && code <= 0x1f) || (code >= 0x7f && code <= 0x9f) || (code >= 0x200b && code <= 0x200f) || (code >= 0x202a && code <= 0x202e) || (code >= 0x2060 && code <= 0x2064) || (code >= 0x2066 && code <= 0x2069) || code === 0xfeff;

const marker = (code: number): string => `<U+${code.toString(16).toUpperCase().padStart(4, '0')}>`;

const textOf = (value: unknown): string => {
  const raw = typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
  return Array.from(raw.slice(0, VALUE_MAX))
    .map((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return hidden(code) ? marker(code) : ch;
    })
    .join('')
    .slice(0, VALUE_MAX);
};

export function engageViewOf(kind: string, command: string, payload: unknown, about: EngageProposalView['about'] = []): EngageProposalView | null {
  if (!isEngageProposalKind(kind) || typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const fields = Object.entries(payload as Record<string, unknown>)
    .filter(([key]) => /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(key))
    .slice(0, MAX_FIELDS)
    .map(([key, value]) => {
      const text = textOf(value);
      return { key, value: text, long: text.length > LONG_FROM || text.includes('\n') };
    });
  return { command, fields, about };
}

const isId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

// Who and what a conversation ask is about, from the thread itself: the channel, the customer's name and what the customer last wrote (or, for hiding, the comment itself), so the approver sees the right
// person and the right words and not an id. Read as the approver (an owner or an admin, who reads every thread); text is shown as the card shows any text (marked, bounded).
export async function engageAboutOf(trx: Transaction<Database>, orgId: string, command: string, payload: unknown): Promise<EngageProposalView['about']> {
  if (typeof payload !== 'object' || payload === null) return [];
  const p = payload as Record<string, unknown>;
  if (!['kernel.conversation.reply_approved', 'kernel.conversation.reply_privately_approved', 'kernel.conversation.hide_approved'].includes(command)) return [];
  const messageId = isId(p.messageId) ? p.messageId.toLowerCase() : null;
  const conversationId = isId(p.conversationId) ? p.conversationId.toLowerCase() : null;
  if (!messageId && !conversationId) return [];
  const { rows } = await sql<{ channel: string | null; provider: string | null; contact: string | null; said: string | null }>`
    SELECT cc.display_name AS channel, cc.provider AS provider, i.display_name AS contact,
           CASE WHEN ${messageId}::uuid IS NOT NULL THEN m.body ELSE (
             SELECT lm.body FROM crove_kernel.conversation_message lm
             WHERE lm.org_id = c.org_id AND lm.conversation_id = c.id AND lm.direction = 'in' AND lm.platform_removed_at IS NULL
             ORDER BY lm.seq DESC LIMIT 1) END AS said
    FROM crove_kernel.conversation c
    LEFT JOIN crove_kernel.conversation_message m ON m.org_id = c.org_id AND m.id = ${messageId}::uuid
    LEFT JOIN crove_kernel.channel_connection cc ON cc.org_id = c.org_id AND cc.id = c.channel_connection_id
    LEFT JOIN crove_kernel.conversation_identity i ON i.org_id = c.org_id AND i.id = c.identity_id
    WHERE c.org_id = ${orgId}::uuid AND c.id = COALESCE(${conversationId}::uuid, m.conversation_id)
    LIMIT 1`.execute(trx);
  const row = rows[0];
  if (!row) return [];
  const out: EngageProposalView['about'] = [];
  if (row.channel || row.provider) out.push({ label: 'channel', value: textOf([row.provider, row.channel].filter(Boolean).join(': ')).slice(0, 200) });
  if (row.contact) out.push({ label: 'contact', value: textOf(row.contact).slice(0, 200) });
  if (row.said) out.push({ label: 'customerMessage', value: textOf(row.said).slice(0, 600) });
  return out;
}
