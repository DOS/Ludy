// SPDX-License-Identifier: AGPL-3.0-only
// Customer payment reminders (#2488, "nhắc thu nợ"). A small business chases its overdue customers every week; this is the part of
// Kế toán that finds them and sends the reminder a person approved:
// - finance.payment_reminders.list (every role): the customers with a sales invoice past its due date and an amount left, of one
//   legal entity the caller may see, longest overdue first, each with the notice level, what is owed and the last reminder sent.
// - finance.payment_reminder.draft (every role): one customer's overdue invoices as the books stand now, the fixed words for its notice
//   level and language, and the bank accounts the mail may ask to be paid into. Nothing is stored: the screen holds the draft until a
//   person sends it.
// - finance.payment_reminder.send (owners, admins, members; R2, it sends mail): queues one mail to the customer's email through the
//   kernel's mail queue (suppression check and log row included), audited. Nothing is sent without this command, and a person runs it.
// The facts of a mail (invoice numbers, dates, amounts, the total, the bank account) are rebuilt here from the books at the moment of the
// send. The caller supplies only the words around them (subject, greeting, lead, closing), which a person approved, and the total and
// notice level they saw: when the books moved since, the send is refused (STALE_REMINDER) so nobody sends a figure they did not read.
// No due date is stored on a sale and no receipt is linked to an invoice, so both are derived (domain/payment-reminder.ts).
import { sql } from 'kysely';
import { z } from 'zod';
import {
  PAYMENT_REMINDER_CUSTOMERS_MAX,
  PAYMENT_REMINDER_SUBJECT_MAX,
  PAYMENT_REMINDER_TEXT_MAX,
  zPaymentReminderDraft,
  zPaymentReminderList,
  zPaymentReminderSend,
  zId,
  type PaymentReminderCustomer,
  type PaymentReminderDraft,
  type PaymentReminderList,
  type PaymentReminderSent,
} from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { createMailMessage } from '@crove/kernel';
import { DomainError, defineCommand, defineQuery, type QueryContext } from '@crove/kernel-runtime';
import { RECEIVABLE_ACCOUNT } from '@crove/l10n-vn';
import { chartAccounts } from './accounts.ts';
import {
  REMINDER_REPEAT_DAYS,
  addDays,
  allocateReceivable,
  noticeLevel,
  overdueOf,
  reminderLang,
  templateWords,
  totalOf,
  type NoticeLevel,
  type OpenInvoice,
  type Receivable,
} from './domain/payment-reminder.ts';
import { resolveLegalEntity } from './legal-entity.ts';
import { databaseToday } from './period-lock.ts';
import { readCollectionSetting } from './collection-settings.ts';
import { oneLine } from './missing-invoices.ts';
import { PAYMENT_REMINDER_INVOICES_MAX, PAYMENT_REMINDER_SOURCE, PAYMENT_REMINDER_TEMPLATE, zPaymentReminderMail, type PaymentReminderMail } from './payment-reminder-mail.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const EDITORS: readonly MemberRole[] = ['owner', 'admin', 'member'];
const DAY_MS = 86_400_000;
// A mail in these states went (or is going) to the customer; a suppressed or failed one did not.
const REMINDED_STATES = ['queued', 'sending', 'sent', 'delivered', 'ambiguous'] as const;

// A person's words, as they go into the mail: no control or format characters, line breaks kept (two in a row at most).
const paragraph = (value: string): string =>
  value
    .replace(/\p{Cf}+/gu, '')
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, (c) => (c === '\n' ? '\n' : ' '))
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

interface Customer {
  partyId: string;
  name: string;
  email: string | null;
  receivable: Receivable;
  overdue: OpenInvoice[];
  // The payment terms that dated its invoices: its own when it has set them, else the org's.
  termsDays: number;
  // Its own terms when it set them (null: the org's), and the last day with no reminder when it is paused.
  ownTermsDays: number | null;
  pausedUntil: string | null;
  // No reminder is drafted or sent for it today.
  paused: boolean;
}

// The customers of one legal entity with a positive balance on 131, their sales invoices laid under it (domain/payment-reminder.ts),
// and the invoices past due. A party and the parties marked as its duplicates are one customer, as on the customers list. `only`:
// one customer. The invoices of a customer are the sales still in the books, not voided. An adjustment invoice carries the difference it changes an invoice by: an
// increase is billed like an invoice of its own amount, and a decrease (a negative total) is skipped, as the balance already holds it, so the older invoices
// show as paid by it.
async function loadCustomers(ctx: QueryContext, entity: string, today: string, only?: string): Promise<Customer[]> {
  const kept = sql<string>`coalesce(x.duplicate_of, x.id)`;
  let balances = ctx.trx
    .selectFrom('crove_finance.journal_line as l')
    .innerJoin('crove_kernel.party as x', (join) => join.onRef('x.org_id', '=', 'l.org_id').onRef('x.id', '=', 'l.party_id'))
    .select(kept.as('party_id'))
    .select(sql<string>`sum(l.debit - l.credit)`.as('balance'))
    .where('l.org_id', '=', ctx.orgId)
    .where('l.legal_entity_id', '=', entity)
    .where('l.account_code', 'like', `${RECEIVABLE_ACCOUNT}%`)
    .groupBy(kept)
    .having(sql<boolean>`sum(l.debit - l.credit) > 0`);
  if (only) balances = balances.where(sql<boolean>`coalesce(x.duplicate_of, x.id) = ${only}`);
  const owed = await balances.execute();
  if (owed.length === 0) return [];
  const ids = owed.map((r) => r.party_id);
  const parties = await ctx.trx.selectFrom('crove_kernel.party').select(['id', 'name', 'email']).where('org_id', '=', ctx.orgId).where('id', 'in', ids).execute();
  const invoices = await ctx.trx
    .selectFrom('crove_finance.purchase_document as d')
    .innerJoin('crove_kernel.party as x', (join) => join.onRef('x.org_id', '=', 'd.org_id').onRef('x.id', '=', 'd.party_id'))
    .leftJoin('crove_finance.purchase_document_void as v', (join) => join.onRef('v.org_id', '=', 'd.org_id').onRef('v.document_id', '=', 'd.id'))
    .select(kept.as('party_id'))
    .select(['d.id', 'd.invoice_series', 'd.invoice_number', 'd.invoice_date', 'd.total', 'd.currency'])
    .where('d.org_id', '=', ctx.orgId)
    .where('d.legal_entity_id', '=', entity)
    .where('d.direction', '=', 'sale')
    .where('v.document_id', 'is', null)
    .where(sql<boolean>`coalesce(x.duplicate_of, x.id) IN (${sql.join(ids)})`)
    .execute();
  const byParty = new Map(parties.map((p) => [p.id, p]));
  // What the org and each customer set (#2488, slice 3): the terms date the invoices, a pause keeps the customer out of the list, the draft and the send.
  const org = await readCollectionSetting(ctx);
  const own = new Map(
    (await ctx.trx.selectFrom('crove_finance.customer_collection').select(['party_id', 'terms_days', 'paused_until']).where('org_id', '=', ctx.orgId).where('party_id', 'in', ids).execute()).map((r) => [r.party_id, r]),
  );
  return owed.flatMap((o) => {
    const party = byParty.get(o.party_id);
    if (!party) return [];
    const set = own.get(o.party_id);
    const termsDays = set?.terms_days ?? org.termsDays;
    const receivable = allocateReceivable(
      invoices.filter((i) => i.party_id === o.party_id).map((i) => ({ id: i.id, series: i.invoice_series, number: i.invoice_number, date: i.invoice_date, total: i.total, currency: i.currency })),
      o.balance,
      today,
      termsDays,
    );
    const pausedUntil = set?.paused_until ?? null;
    return [{ partyId: party.id, name: party.name, email: party.email, receivable, overdue: overdueOf(receivable), termsDays, ownTermsDays: set?.terms_days ?? null, pausedUntil, paused: pausedUntil !== null && pausedUntil >= today }];
  });
}

// The last reminder each customer was sent: the newest mail of any notice level that went (or is going) out, read from the mail log.
async function lastReminders(ctx: QueryContext, partyIds: readonly string[]): Promise<Map<string, { at: string; level: NoticeLevel }>> {
  const out = new Map<string, { at: string; level: NoticeLevel }>();
  if (partyIds.length === 0) return out;
  const rows = await ctx.trx
    .selectFrom('crove_kernel.mail_message')
    .select(['source', 'source_id', 'created_at'])
    .where('org_id', '=', ctx.orgId)
    .where('source', 'like', `${PAYMENT_REMINDER_SOURCE}%`)
    .where('source_id', 'in', [...partyIds])
    .where('status', 'in', [...REMINDED_STATES])
    .orderBy('created_at', 'desc')
    .execute();
  for (const row of rows) {
    if (!row.source_id || out.has(row.source_id)) continue;
    const level = Number(row.source.slice(PAYMENT_REMINDER_SOURCE.length));
    if (level === 1 || level === 2 || level === 3) out.set(row.source_id, { at: row.created_at.toISOString(), level });
  }
  return out;
}

// The currency every amount of the books is in.
async function bookCurrency(ctx: QueryContext): Promise<string> {
  const row = await ctx.trx.selectFrom('crove_kernel.tenant').select('base_currency').where('org_id', '=', ctx.orgId).executeTakeFirstOrThrow();
  return row.base_currency;
}

function summary(customer: Customer, last: { at: string; level: NoticeLevel } | undefined): PaymentReminderCustomer {
  const level = noticeLevel(customer.overdue) as NoticeLevel;
  return {
    partyId: customer.partyId,
    name: customer.name,
    email: customer.email,
    level,
    lang: reminderLang(customer.overdue),
    invoiceCount: customer.overdue.length,
    daysOverdue: Math.max(...customer.overdue.map((i) => i.daysOverdue)),
    total: totalOf(customer.overdue),
    other: customer.receivable.other,
    lastReminder: last ?? null,
  };
}

export const paymentRemindersList = defineQuery({
  name: 'finance.payment_reminders.list',
  input: z.object({ legalEntityId: zId.optional() }),
  access: ALL,
  handler: async (ctx, input): Promise<PaymentReminderList> => {
    const entity = await resolveLegalEntity(ctx, input.legalEntityId);
    const everyone = (await loadCustomers(ctx, entity, await databaseToday(ctx.trx))).filter((c) => c.overdue.length > 0);
    // A paused customer is not in the list to remind; it is listed apart, with the day its pause ends, so a person can lift it.
    const customers = everyone.filter((c) => !c.paused);
    const paused = everyone.filter((c) => c.paused);
    customers.sort((a, b) => Math.max(...b.overdue.map((i) => i.daysOverdue)) - Math.max(...a.overdue.map((i) => i.daysOverdue)) || a.name.localeCompare(b.name, 'vi') || a.partyId.localeCompare(b.partyId));
    const shown = customers.slice(0, PAYMENT_REMINDER_CUSTOMERS_MAX);
    const last = await lastReminders(ctx, shown.map((c) => c.partyId));
    return zPaymentReminderList.parse({
      currency: await bookCurrency(ctx),
      customers: shown.map((c) => summary(c, last.get(c.partyId))),
      more: customers.length > shown.length,
      termsDays: (await readCollectionSetting(ctx)).termsDays,
      paused: paused
        .sort((a, b) => (a.pausedUntil ?? '').localeCompare(b.pausedUntil ?? '') || a.name.localeCompare(b.name, 'vi') || a.partyId.localeCompare(b.partyId))
        .slice(0, PAYMENT_REMINDER_CUSTOMERS_MAX)
        .map((c) => ({ partyId: c.partyId, name: c.name, pausedUntil: c.pausedUntil as string, ownTermsDays: c.ownTermsDays, invoiceCount: c.overdue.length, total: totalOf(c.overdue) })),
    });
  },
});

// The org's bank accounts with a number recorded in the entity, oldest record first, as the mail would name them.
async function payToOptions(ctx: QueryContext, entity: string): Promise<Array<{ id: string; bank: string; number: string; holder: string }>> {
  const rows = await ctx.trx
    .selectFrom('crove_finance.bank_account_number')
    .select(['id', 'bank_account', 'account_number'])
    .where('org_id', '=', ctx.orgId)
    .where('legal_entity_id', '=', entity)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  if (rows.length === 0) return [];
  const holder = await ctx.trx.selectFrom('crove_kernel.legal_entity').select('name').where('org_id', '=', ctx.orgId).where('id', '=', entity).executeTakeFirst();
  const accounts = await chartAccounts(ctx, [...new Set(rows.map((r) => r.bank_account))]);
  return rows.map((r) => ({ id: r.id, bank: accounts.get(r.bank_account)?.name ?? r.bank_account, number: r.account_number, holder: holder?.name ?? '' }));
}

async function orgName(ctx: QueryContext, entity: string): Promise<string> {
  // The seller named in the mail is the legal entity whose books the invoices are in.
  const row = await ctx.trx.selectFrom('crove_kernel.legal_entity').select('name').where('org_id', '=', ctx.orgId).where('id', '=', entity).executeTakeFirst();
  if (row) return oneLine(row.name);
  const tenant = await ctx.trx.selectFrom('crove_kernel.tenant').select('name').where('org_id', '=', ctx.orgId).executeTakeFirstOrThrow();
  return oneLine(tenant.name);
}

// One plain address: no space, comma, semicolon or angle bracket, so a party's email can never name a second recipient.
const PLAIN_ADDRESS = /^[^\s,;<>@"()[\]\\]+@[^\s,;<>@"()[\]\\]+\.[^\s,;<>@"()[\]\\]+$/;

const customerPaused = () => new DomainError('CUSTOMER_PAUSED', 409, 'Đang tạm dừng nhắc khách hàng này; bỏ tạm dừng rồi gửi lại');
const nothingOverdue = () => new DomainError('NOTHING_OVERDUE', 409, 'Khách hàng này không còn hóa đơn nào quá hạn');

export const paymentReminderDraft = defineQuery({
  name: 'finance.payment_reminder.draft',
  input: z.object({ partyId: zId, legalEntityId: zId.optional() }),
  access: ALL,
  handler: async (ctx, input): Promise<PaymentReminderDraft> => {
    const entity = await resolveLegalEntity(ctx, input.legalEntityId);
    const [customer] = await loadCustomers(ctx, entity, await databaseToday(ctx.trx), input.partyId);
    if (!customer || customer.overdue.length === 0) throw nothingOverdue();
    if (customer.paused) throw customerPaused();
    const row = summary(customer, (await lastReminders(ctx, [customer.partyId])).get(customer.partyId));
    return zPaymentReminderDraft.parse({
      partyId: customer.partyId,
      name: customer.name,
      email: customer.email,
      currency: await bookCurrency(ctx),
      termsDays: customer.termsDays,
      level: row.level,
      lang: row.lang,
      invoices: customer.overdue.map((i) => ({ id: i.id, series: i.series, number: i.number, date: i.date, dueDate: i.dueDate, daysOverdue: i.daysOverdue, amountDue: i.amountDue })),
      total: row.total,
      other: row.other,
      lastReminder: row.lastReminder,
      words: templateWords({ level: row.level, lang: row.lang, customer: oneLine(customer.name), org: await orgName(ctx, entity) }),
      payTo: await payToOptions(ctx, entity),
    });
  },
});

export const paymentReminderSend = defineCommand({
  name: 'finance.payment_reminder.send',
  input: zPaymentReminderSend,
  // It queues a mail to a customer: a send, an effect outside Ludy (R2), always from a person's click.
  risk: 'R2',
  sideEffect: 'external',
  access: EDITORS,
  handler: async (ctx, input): Promise<PaymentReminderSent> => {
    const entity = await resolveLegalEntity(ctx, input.legalEntityId);
    // One reminder per customer at a time: a double click waits here and then meets the first one's mail.
    await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`finance.payment_reminder:${ctx.orgId}:${input.partyId}`}, 0))`.execute(ctx.trx);
    const [customer] = await loadCustomers(ctx, entity, await databaseToday(ctx.trx), input.partyId);
    if (!customer || customer.overdue.length === 0) throw nothingOverdue();
    if (customer.paused) throw customerPaused();
    const level = noticeLevel(customer.overdue) as NoticeLevel;
    const total = totalOf(customer.overdue);
    // What the person reviewed: the notice level, the total and the very invoices (a payment on one and a due date reached on another can leave the total as it was).
    const reviewed = [...input.invoiceIds].sort().join(',');
    if (level !== input.level || total !== input.total || reviewed !== customer.overdue.map((i) => i.id).sort().join(',')) {
      throw new DomainError('STALE_REMINDER', 409, 'Sổ sách đã thay đổi từ lúc bạn mở bản nháp (có khoản vừa được thanh toán hoặc đã sang mức nhắc khác); hãy mở lại bản nháp để xem số liệu mới');
    }
    const email = customer.email?.trim() ?? '';
    if (!PLAIN_ADDRESS.test(email)) throw new DomainError('CUSTOMER_EMAIL_REQUIRED', 409, 'Khách hàng này chưa có email; hãy nhập email trong hồ sơ khách hàng rồi gửi lại');
    const source = `${PAYMENT_REMINDER_SOURCE}${level}`;
    const since = new Date(ctx.now.getTime() - REMINDER_REPEAT_DAYS * DAY_MS);
    const recent = await ctx.trx
      .selectFrom('crove_kernel.mail_message')
      .select('created_at')
      .where('org_id', '=', ctx.orgId)
      .where('source', '=', source)
      .where('source_id', '=', customer.partyId)
      .where('status', 'in', [...REMINDED_STATES])
      .where('created_at', '>', since)
      .limit(1)
      .executeTakeFirst();
    if (recent && input.confirm !== true) {
      throw new DomainError('ALREADY_REMINDED', 409, `Khách hàng này đã được nhắc ở mức này trong ${REMINDER_REPEAT_DAYS} ngày qua; gửi lại cần xác nhận`, { audit: { level } });
    }
    let payTo: PaymentReminderMail['payTo'] = null;
    if (input.payToId) {
      const chosen = (await payToOptions(ctx, entity)).find((o) => o.id === input.payToId);
      if (!chosen) throw new DomainError('PAY_TO_NOT_FOUND', 422, 'Tài khoản nhận tiền đã chọn không còn; hãy chọn lại');
      payTo = { bank: chosen.bank, number: chosen.number, holder: chosen.holder };
    }
    const currency = await bookCurrency(ctx);
    const shown = customer.overdue.slice(0, PAYMENT_REMINDER_INVOICES_MAX);
    const payload: PaymentReminderMail = {
      lang: reminderLang(customer.overdue),
      level,
      org: await orgName(ctx, entity),
      greeting: oneLine(input.greeting, PAYMENT_REMINDER_TEXT_MAX),
      lead: paragraph(input.lead),
      closing: paragraph(input.closing),
      invoices: shown.map((i) => ({ series: oneLine(i.series, 50), number: oneLine(i.number, 50), date: i.date, dueDate: i.dueDate, daysOverdue: i.daysOverdue, amountDue: i.amountDue, currency })),
      count: customer.overdue.length,
      total,
      currency,
      payTo,
    };
    // The worker validates this at render; a mail it would refuse is refused here, before anything is queued or audited as sent.
    if (!zPaymentReminderMail.safeParse(payload).success) {
      throw new DomainError('REMINDER_INVALID', 422, 'Không soạn được thư từ số liệu hiện có (số hóa đơn hoặc ngày quá dài hoặc không hợp lệ); hãy kiểm tra các hóa đơn của khách hàng này');
    }
    const mail = await createMailMessage(ctx, {
      stream: 'transactional',
      source,
      sourceId: customer.partyId,
      templateKey: PAYMENT_REMINDER_TEMPLATE,
      to: email,
      subject: oneLine(input.subject, PAYMENT_REMINDER_SUBJECT_MAX),
      payload,
      status: 'queued',
    });
    const status = mail.status === 'suppressed' ? 'suppressed' : 'queued';
    await ctx.activity(
      'kernel.mail_message',
      mail.id,
      'payment_reminder.sent',
      status === 'suppressed' ? 'Không gửi được thư nhắc thu nợ: địa chỉ email của khách hàng đang bị chặn' : `Gửi thư nhắc thu nợ mức ${level} cho khách hàng, ${customer.overdue.length} hóa đơn quá hạn`,
      { legalEntityId: entity },
    );
    ctx.audit({ party_id: customer.partyId, level, invoices: customer.overdue.length, owed: total, message_id: mail.id, status, repeated: recent !== undefined, legal_entity_id: entity });
    return { messageId: mail.id, status, level };
  },
});

// The Monday of the week `today` (a YYYY-MM-DD date in Vietnam) falls in, and how many customers of the entity that are overdue and not paused were sent no reminder
// since then: what the weekly "Hôm nay cần bạn" item counts (#2488, slice 3). Nothing is drafted or sent by counting.
export async function remindersToSendThisWeek(ctx: QueryContext, entity: string, today: string): Promise<{ monday: string; count: number }> {
  const day = new Date(`${today}T00:00:00Z`).getUTCDay();
  const monday = addDays(today, -((day + 6) % 7));
  const since = new Date(`${monday}T00:00:00+07:00`).toISOString();
  const due = (await loadCustomers(ctx, entity, today)).filter((c) => c.overdue.length > 0 && !c.paused);
  const last = await lastReminders(ctx, due.map((c) => c.partyId));
  return { monday, count: due.filter((c) => (last.get(c.partyId)?.at ?? '') < since).length };
}

export const paymentReminderQueries = [paymentRemindersList, paymentReminderDraft];
export const paymentReminderCommands = [paymentReminderSend];
