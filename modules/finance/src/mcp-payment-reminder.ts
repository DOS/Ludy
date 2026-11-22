// SPDX-License-Identifier: AGPL-3.0-only
// `finance.mcp.payment_reminder` (#3849, tool 3): the draft of a payment reminder for ONE overdue customer, as an AI app the owner connected may read it. It reads and sends nothing:
// the send is `finance.payment_reminder.send`, a command a person runs from the screen, and no command is reachable by a grant. Privacy review: the customer's name as the books hold it
// (one plain line), the notice level and language, the book currency, the overdue invoices (series, number, date, due date, days overdue, amount due), their total, and the FIXED template
// words of the notice (the words the screen falls back to; no model is called here, so nothing is metered: the metered wording is its own follow-up, #3927, with its own design).
// Never returned: the customer's email, phone or address, `payTo` (the org's bank account numbers and holders, which `finance.payment_reminder.draft` carries), a reminder's mail log, the
// payment terms or any other setting. The same refusals as the screen's draft: nothing overdue, a paused customer. The figures are the whole org's or nothing (wholeOrgEntity).
import { z } from 'zod';
import type { MemberRole } from '@ludy/db';
import { zId } from '@ludy/kernel-contract';
import { defineQuery } from '@ludy/kernel-runtime';
import { noticeLevel, reminderLang, templateWords, totalOf, type NoticeLevel, type ReminderLang, type ReminderWords } from './domain/payment-reminder.ts';
import { wholeOrgEntity } from './mcp-whole-org.ts';
import { oneLine } from './missing-invoices.ts';
import { bookCurrency, customerPaused, loadCustomers, nothingOverdue, orgName } from './payment-reminders.ts';
import { databaseToday } from './period-lock.ts';

const GRANTORS: readonly MemberRole[] = ['owner', 'admin'];
export const MCP_REMINDER_INVOICES_MAX = 50;

export const zMcpPaymentReminderInput = z.strictObject({
  partyId: zId.describe('The id of one customer with an overdue invoice (from ludy_finance_open_balances, side receivable).'),
});

export interface McpReminderInvoice {
  series: string;
  number: string;
  date: string;
  dueDate: string;
  daysOverdue: number;
  amountDue: string;
}
export interface McpPaymentReminder {
  partyId: string;
  name: string;
  level: NoticeLevel;
  lang: ReminderLang;
  currency: string;
  invoices: McpReminderInvoice[];
  // How many overdue invoices the customer has; `invoices` holds the oldest MCP_REMINDER_INVOICES_MAX of them.
  invoiceCount: number;
  total: string;
  words: ReminderWords;
}

export const mcpPaymentReminder = defineQuery({
  name: 'finance.mcp.payment_reminder',
  input: zMcpPaymentReminderInput,
  access: GRANTORS,
  mcp: { scope: 'ludy.read' },
  handler: async (ctx, input): Promise<McpPaymentReminder> => {
    const entity = await wholeOrgEntity(ctx);
    const [customer] = await loadCustomers(ctx, entity, await databaseToday(ctx.trx), input.partyId);
    if (!customer || customer.overdue.length === 0) throw nothingOverdue();
    if (customer.paused) throw customerPaused();
    const level = noticeLevel(customer.overdue) as NoticeLevel;
    const lang = reminderLang(customer.overdue);
    const name = oneLine(customer.name);
    // Oldest first, so a cut keeps the invoices that matter most; the total is of all of them.
    const oldest = [...customer.overdue].sort((a, b) => b.daysOverdue - a.daysOverdue || (a.id < b.id ? -1 : 1));
    return {
      partyId: customer.partyId,
      name,
      level,
      lang,
      currency: await bookCurrency(ctx),
      invoices: oldest.slice(0, MCP_REMINDER_INVOICES_MAX).map((i) => ({ series: oneLine(i.series, 20), number: oneLine(i.number, 40), date: i.date, dueDate: i.dueDate, daysOverdue: i.daysOverdue, amountDue: i.amountDue })),
      invoiceCount: customer.overdue.length,
      total: totalOf(customer.overdue),
      words: templateWords({ level, lang, customer: name, org: await orgName(ctx, entity) }),
    };
  },
});
