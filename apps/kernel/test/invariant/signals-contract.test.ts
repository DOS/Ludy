// SPDX-License-Identifier: AGPL-3.0-only
// The cross-app signals contract (Vy V4 and V5, issues #2967 and #2969), pinned before the line reads exist and before any of them reaches an AI app over MCP.
// Step 1 of the two-step plan: every case passes on main today and bites when a read or the MCP tool of a later step weakens it.
//
//   - A row a line read answers carries ids, dates, counts and decimal-string amounts only, by a pinned list of keys; the schema is strict, so a name, a title, an invoice number
//     or a note cannot ride in a field whatever it is called, and an answer with one extra key is void.
//   - Any query of the signals family that is registered (`<line>.signals.*`) takes a strict input, lists its roles, is not sensitive, not streamed, not open to member mode or
//     an extension token, and declares at most the one scope an AI app reads with. None of this needs the read to exist: a case whose read does not exist passes by finding nothing.
// Part of the invariant suite; it imports package code under test, never helpers from outside test/invariant/.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  zConversationUnansweredSignal,
  zCrmOpenDealSignal,
  zCrmWonDealSignal,
  zFinanceOverdueReceivableSignal,
  zFinanceSalesSignal,
  zFinanceSupplierBankChangeSignal,
  zFinanceSupplierPaymentsWaitingSignal,
} from '@crove/kernel-contract';
import { crmQueries } from '@crove/mod-crm';
import { financeQueries } from '@crove/mod-finance';
import { kernelQueries } from '@crove/kernel';

// The only keys a signal row may have: ids, days, counts and amounts. Adding a key is a change to this protected file and needs a privacy review.
// `conversationId` and `since` belong to the conversation read of the fourth rule (#3124): the id of the thread and the moment its oldest unanswered customer message arrived, never a word of it.
const ROW_KEYS = ['amount', 'changedOn', 'conversationId', 'count', 'dealId', 'lastSaleOn', 'oldestDueOn', 'partyId', 'since', 'wonOn'];

const ROWS = {
  'finance.signals.sales': zFinanceSalesSignal,
  'crm.signals.won_deals': zCrmWonDealSignal,
  'crm.signals.open_deals': zCrmOpenDealSignal,
  'finance.signals.overdue_receivables': zFinanceOverdueReceivableSignal,
  'finance.signals.supplier_bank_changes': zFinanceSupplierBankChangeSignal,
  'finance.signals.supplier_payments_waiting': zFinanceSupplierPaymentsWaitingSignal,
  // The inbox's side of the fourth rule (#3124): ids and an instant, never a word of a message.
  'kernel.conversation.signals_unanswered': zConversationUnansweredSignal,
} as const;
// A value the schema refuses: it fails to parse or throws (a date check that throws on a malformed day still refuses the row; a follow-up makes it fail cleanly).
const refuses = (run: () => { success: boolean }): boolean => {
  try {
    return !run().success;
  } catch {
    return true;
  }
};

describe('the signals contract carries ids, dates, counts and amounts only', () => {
  for (const [read, schema] of Object.entries(ROWS)) {
    it(`${read}: only pinned keys, and one extra key voids a row`, () => {
      const keys = Object.keys(schema.shape).sort();
      expect(keys.filter((k) => !ROW_KEYS.includes(k)), `${read} has a key outside the pinned list`).toEqual([]);
      // No key is free text by name, whatever the list above says.
      expect(keys.filter((k) => /name|title|note|text|message|email|phone|address|number|description|reason|bank/i.test(k)), read).toEqual([]);
      // Each value is a uuid, a date, a count or a decimal string: parse a row of the right shape, then the same row with one more key.
      const sample: Record<string, unknown> = {};
      for (const key of keys) {
        sample[key] = key.endsWith('Id') ? '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b' : key === 'count' ? 1 : key === 'amount' ? '100000' : key === 'since' ? '2026-11-10T09:00:00+07:00' : '2026-11-10';
      }
      const ok = schema.safeParse(sample);
      expect(ok.success, `${read}: ${JSON.stringify(ok.error?.issues)}`).toBe(true);
      expect(refuses(() => schema.safeParse({ ...sample, name: 'x' })), `${read} must be strict`).toBe(true);
      // A text value in a field of a pinned key is refused (an id is a uuid, a date is a real day, an amount is a decimal string).
      for (const key of keys) {
        expect(refuses(() => schema.safeParse({ ...sample, [key]: 'Công ty TNHH A, a note' })), `${read}.${key} took free text`).toBe(true);
      }
    });
  }
});

describe('a registered signals read is a plain, role-listed, scope-limited query', () => {
  const all = [...kernelQueries({ inboundDomain: 'in.test' }), ...financeQueries, ...crmQueries] as Array<{
    name: string;
    input: z.ZodType;
    access?: unknown;
    sensitive?: boolean;
    stream?: boolean;
    memberVy?: unknown;
    extension?: unknown;
    mcp?: { scope: string };
  }>;
  const signals = all.filter((q) => /^((finance|crm)\.signals\.|kernel\.conversation\.signals_)/.test(q.name));

  it('has no read outside the names of the contract', () => {
    expect(signals.map((q) => q.name).filter((n) => !(n in ROWS))).toEqual([]);
  });

  it('lists roles, is not sensitive, streamed or open to member mode or an extension token, and declares at most the AI-app scope', () => {
    for (const q of signals) {
      expect(Array.isArray(q.access), q.name).toBe(true);
      expect(q.sensitive === true, q.name).toBe(false);
      expect(q.stream === true, q.name).toBe(false);
      expect(q.memberVy, q.name).toBeUndefined();
      expect(q.extension, q.name).toBeUndefined();
      if (q.mcp !== undefined) expect(q.mcp.scope, q.name).toBe('ludy.read');
      // Strict input: an unknown key is refused, so a client cannot widen the read.
      expect(q.input.safeParse({ unknown: 1, partyIds: ['0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'] }).success, q.name).toBe(false);
    }
  });
});
