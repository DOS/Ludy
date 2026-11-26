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
import { checkReminderField } from '@ludy/agent';
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
} from '@ludy/kernel-contract';
import type { MemberRole } from '@ludy/db';
import { createMailMessage } from '@ludy/kernel';
import { DomainError, defineCommand, defineQuery, sha256Hex, type QueryContext } from '@ludy/kernel-runtime';
import { RECEIVABLE_ACCOUNT, money } from '@ludy/l10n-vn';
import { chartAccounts } from './accounts.ts';
import { canonical } from './domain/money.ts';
import {
  REMINDER_REPEAT_DAYS,
  addDays,
  allForeignAmountsOf,
  allocateReceivable,
  foreignTotalsOf,
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
import { mergeGroupRows, readCollectionSetting } from './collection-settings.ts';
import { oneLine } from './missing-invoices.ts';
import {
  PAYMENT_REMINDER_INVOICES_MAX,
  PAYMENT_REMINDER_SOURCE,
  PAYMENT_REMINDER_TEMPLATE,
  paymentReminderSource,
  paymentReminderSourceLevel,
  zPaymentReminderMail,
  type PaymentReminderMail,
} from './payment-reminder-mail.ts';

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

export interface Customer {
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

export interface CustomerBounds {
  // The balance counts only the entries, and the invoices laid under it only the ones, dated up to this day (the cash forecast reads the books as of its day 0); left out, everything counts.
  entriesTo?: string;
  // At most this many customers are read, the largest balances first, and at most `documents` of their invoices, newest first (the cash forecast bounds its reads). `seen.documents` is
  // set to how many invoice rows the read found (the limit is one more than `documents`, so a caller can tell the bound was hit); only `documents` of them are laid under the balances.
  customers: number;
  documents: number;
  seen?: { documents: number };
}

// The customers of one legal entity with a positive balance on 131, their sales invoices laid under it (domain/payment-reminder.ts),
// and the invoices past due. A party and the parties marked as its duplicates are one customer, as on the customers list. `only`:
// one customer, or a list of them (the Home signals read asks for many at once). The invoices of a customer are the sales still in the books, not voided. An adjustment invoice carries the difference it changes an invoice by: an
// increase is billed like an invoice of its own amount, and a decrease (a negative total) is skipped, as the balance already holds it, so the older invoices
// show as paid by it.
export async function loadCustomers(ctx: QueryContext, entity: string, today: string, only?: string | readonly string[], bounds?: CustomerBounds): Promise<Customer[]> {
  const kept = sql<string>`coalesce(x.duplicate_of, x.id)`;
  let balances = ctx.trx
    .selectFrom('ludy_finance.journal_line as l')
    .innerJoin('ludy_kernel.party as x', (join) => join.onRef('x.org_id', '=', 'l.org_id').onRef('x.id', '=', 'l.party_id'))
    .select(kept.as('party_id'))
    .select(sql<string>`sum(l.debit - l.credit)`.as('balance'))
    .where('l.org_id', '=', ctx.orgId)
    .where('l.legal_entity_id', '=', entity)
    .where('l.account_code', 'like', `${RECEIVABLE_ACCOUNT}%`)
    .groupBy(kept)
    .having(sql<boolean>`sum(l.debit - l.credit) > 0`);
  if (bounds?.entriesTo !== undefined) {
    balances = balances
      .innerJoin('ludy_finance.journal_entry as je', (join) => join.onRef('je.org_id', '=', 'l.org_id').onRef('je.id', '=', 'l.entry_id'))
      .where('je.entry_date', '<=', bounds.entriesTo);
  }
  if (bounds !== undefined) balances = balances.orderBy(sql`sum(l.debit - l.credit)`, 'desc').orderBy(kept).limit(bounds.customers);
  if (typeof only === 'string') balances = balances.where(sql<boolean>`coalesce(x.duplicate_of, x.id) = ${only}`);
  else if (only !== undefined) balances = balances.where(sql<boolean>`coalesce(x.duplicate_of, x.id) IN (${sql.join(only.length > 0 ? only : [''])})`);
  const owed = await balances.execute();
  if (owed.length === 0) return [];
  const ids = owed.map((r) => r.party_id);
  const parties = await ctx.trx.selectFrom('ludy_kernel.party').select(['id', 'name', 'email']).where('org_id', '=', ctx.orgId).where('id', 'in', ids).execute();
  const invoiceRows = await ctx.trx
    .selectFrom('ludy_finance.purchase_document as d')
    .innerJoin('ludy_kernel.party as x', (join) => join.onRef('x.org_id', '=', 'd.org_id').onRef('x.id', '=', 'd.party_id'))
    .leftJoin('ludy_finance.purchase_document_void as v', (join) => join.onRef('v.org_id', '=', 'd.org_id').onRef('v.document_id', '=', 'd.id'))
    .select(kept.as('party_id'))
    .select(['d.id', 'd.invoice_series', 'd.invoice_number', 'd.invoice_date', 'd.total', 'd.currency', 'd.foreign_total'])
    .where('d.org_id', '=', ctx.orgId)
    .where('d.legal_entity_id', '=', entity)
    .where('d.direction', '=', 'sale')
    .where('v.document_id', 'is', null)
    .where(sql<boolean>`coalesce(x.duplicate_of, x.id) IN (${sql.join(ids)})`)
    // As of a day: the invoice is dated and its own entry is posted by then, the same boundary the balance above uses.
    .$if(bounds?.entriesTo !== undefined, (q) =>
      q
        .where('d.invoice_date', '<=', bounds?.entriesTo ?? '')
        .where(
          sql<boolean>`exists (select 1 from ludy_finance.journal_entry e where e.org_id = d.org_id and e.source_type = 'finance.purchase_document' and e.source_id = d.id and e.entry_date <= ${bounds?.entriesTo ?? ''})`,
        ),
    )
    .$if(bounds !== undefined, (q) => q.orderBy('d.invoice_date', 'desc').orderBy('d.id').limit((bounds?.documents ?? 0) + 1))
    .execute();
  if (bounds?.seen) bounds.seen.documents = invoiceRows.length;
  // Grouped once by customer (not filtered per customer), and cut to the bound.
  const invoices = new Map<string, typeof invoiceRows>();
  for (const row of bounds ? invoiceRows.slice(0, bounds.documents) : invoiceRows) {
    const mine = invoices.get(row.party_id);
    if (mine) mine.push(row);
    else invoices.set(row.party_id, [row]);
  }
  const byParty = new Map(parties.map((p) => [p.id, p]));
  // What the org and each customer set (#2488, slice 3): the terms date the invoices, a pause keeps the customer out of the list, the draft and the send.
  const org = await readCollectionSetting(ctx);
  // The settings sit on the kept party; a party marked as a duplicate afterwards may still hold its own row (nothing moves it), so every party of the group is read: the
  // terms are the kept party's, else a duplicate's, and the pause is the latest of the group (the same rule as the customer's own screen: mergeGroupRows).
  const rows = await ctx.trx
    .selectFrom('ludy_finance.customer_collection as c')
    .innerJoin('ludy_kernel.party as x', (join) => join.onRef('x.org_id', '=', 'c.org_id').onRef('x.id', '=', 'c.party_id'))
    .select([kept.as('group_id'), 'c.party_id', 'c.terms_days', 'c.paused_until'])
    .where('c.org_id', '=', ctx.orgId)
    .where(sql<boolean>`coalesce(x.duplicate_of, x.id) IN (${sql.join(ids)})`)
    .orderBy('c.party_id')
    .execute();
  const own = new Map<string, { terms_days: number | null; paused_until: string | null }>();
  for (const groupId of new Set(rows.map((r) => r.group_id))) {
    const merged = mergeGroupRows(rows.filter((r) => r.group_id === groupId), groupId);
    if (merged) own.set(groupId, merged);
  }

  return owed.flatMap((o) => {
    const party = byParty.get(o.party_id);
    if (!party) return [];
    const set = own.get(o.party_id);
    const termsDays = set?.terms_days ?? org.termsDays;
    const receivable = allocateReceivable(
      (invoices.get(o.party_id) ?? []).map((i) => ({
        id: i.id,
        series: i.invoice_series,
        number: i.invoice_number,
        date: i.invoice_date,
        total: i.total,
        currency: i.currency,
        foreignTotal: i.foreign_total === null ? null : canonical(money(i.foreign_total)),
      })),
      o.balance,
      today,
      termsDays,
    );
    const pausedUntil = set?.paused_until ?? null;
    return [{ partyId: party.id, name: party.name, email: party.email, receivable, overdue: overdueOf(receivable), termsDays, ownTermsDays: set?.terms_days ?? null, pausedUntil, paused: pausedUntil !== null && pausedUntil >= today }];
  });
}

// All party ids belonging to the given kept party ids (including merged duplicates).
async function partyGroupMap(ctx: QueryContext, partyIds: readonly string[]): Promise<{ keptOf: Map<string, string>; allIds: string[] }> {
  const keptOf = new Map<string, string>(partyIds.map((id) => [id, id]));
  if (partyIds.length === 0) return { keptOf, allIds: [] };
  const ids = [...partyIds];
  const rows = await ctx.trx
    .selectFrom('ludy_kernel.party')
    .select(['id', sql<string>`coalesce(duplicate_of, id)`.as('kept_id')])
    .where('org_id', '=', ctx.orgId)
    .where((eb) => eb.or([eb('id', 'in', ids), eb('duplicate_of', 'in', ids)]))
    .execute();
  for (const r of rows) keptOf.set(r.id, r.kept_id);
  return { keptOf, allIds: [...new Set(keptOf.keys())] };
}

// Legacy pre-suffix rows either still hold `payload.legalEntityId` or, after 30-day payload purge, retain their entity on the immutable activity row.
const legacyEntityMatch = (entity: string) =>
  sql<boolean>`(m.payload ->> 'legalEntityId' = ${entity} or (m.payload is null and exists (select 1 from ludy_kernel.activity a where a.org_id = m.org_id and a.record_type = 'kernel.mail_message' and a.record_id = m.id and a.kind = 'payment_reminder.sent' and a.legal_entity_id = ${entity})))`;

// The last reminder each customer was sent in `entity`: the newest mail of any notice level that went (or is going) out, read from the mail log.
// Strictly scoped per legal entity via the immutable `.e<entityHex>` suffix on `source` (or explicit `payload.legalEntityId` / activity record for pre-suffix rows), so
// a reminder from another entity never leaks even after 30-day payload retention purge.
async function lastReminders(ctx: QueryContext, entity: string, partyIds: readonly string[], states: readonly string[] = REMINDED_STATES): Promise<Map<string, { at: string; level: NoticeLevel }>> {
  const out = new Map<string, { at: string; level: NoticeLevel }>();
  if (partyIds.length === 0) return out;
  const { keptOf, allIds } = await partyGroupMap(ctx, partyIds);
  const levels = [1, 2, 3] as const;
  const entitySources = levels.map((l) => paymentReminderSource(l, entity));
  const legacySources = levels.map((l) => `${PAYMENT_REMINDER_SOURCE}${l}`);
  const rows = await ctx.trx
    .selectFrom('ludy_kernel.mail_message as m')
    .select(['m.source', 'm.source_id', 'm.created_at'])
    .where('m.org_id', '=', ctx.orgId)
    .where('m.source_id', 'in', allIds)
    .where('m.status', 'in', [...states] as Array<(typeof REMINDED_STATES)[number] | 'suppressed'>)
    .where((eb) =>
      eb.or([
        eb('m.source', 'in', entitySources),
        eb.and([eb('m.source', 'in', legacySources), legacyEntityMatch(entity)]),
      ]),
    )
    .orderBy('m.created_at', 'desc')
    .orderBy('m.id', 'desc')
    .execute();
  for (const row of rows) {
    const kept = row.source_id ? keptOf.get(row.source_id) : undefined;
    if (!kept || out.has(kept)) continue;
    const level = paymentReminderSourceLevel(row.source);
    if (level !== null) out.set(kept, { at: row.created_at.toISOString(), level });
  }
  return out;
}

// The currency every amount of the books is in.
export async function bookCurrency(ctx: QueryContext): Promise<string> {
  const row = await ctx.trx.selectFrom('ludy_kernel.tenant').select('base_currency').where('org_id', '=', ctx.orgId).executeTakeFirstOrThrow();
  return row.base_currency;
}

function summary(customer: Customer, currency: string, last: { at: string; level: NoticeLevel } | undefined): PaymentReminderCustomer {
  const level = noticeLevel(customer.overdue) as NoticeLevel;
  const book = currency.trim().toUpperCase();
  return {
    partyId: customer.partyId,
    name: customer.name,
    email: customer.email,
    level,
    lang: reminderLang(customer.overdue),
    invoiceCount: customer.overdue.length,
    daysOverdue: Math.max(...customer.overdue.map((i) => i.daysOverdue)),
    total: totalOf(customer.overdue),
    foreignTotals: foreignTotalsOf(customer.overdue, book),
    hasForeignCurrency: customer.overdue.some((i) => i.currency.trim().toUpperCase() !== book),
    allForeignAmounts: allForeignAmountsOf(customer.overdue, book),
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
    const currency = await bookCurrency(ctx);
    const book = currency.trim().toUpperCase();
    const last = await lastReminders(ctx, entity, shown.map((c) => c.partyId));
    return zPaymentReminderList.parse({
      currency,
      customers: shown.map((c) => summary(c, currency, last.get(c.partyId))),
      more: customers.length > shown.length,
      termsDays: (await readCollectionSetting(ctx)).termsDays,
      paused: paused
        .sort((a, b) => (a.pausedUntil ?? '').localeCompare(b.pausedUntil ?? '') || a.name.localeCompare(b.name, 'vi') || a.partyId.localeCompare(b.partyId))
        .slice(0, PAYMENT_REMINDER_CUSTOMERS_MAX)
        .map((c) => ({
          partyId: c.partyId,
          name: c.name,
          pausedUntil: c.pausedUntil as string,
          ownTermsDays: c.ownTermsDays,
          invoiceCount: c.overdue.length,
          total: totalOf(c.overdue),
          foreignTotals: foreignTotalsOf(c.overdue, book),
          hasForeignCurrency: c.overdue.some((i) => i.currency.trim().toUpperCase() !== book),
          allForeignAmounts: allForeignAmountsOf(c.overdue, book),
        })),
    });
  },
});

// The org's bank accounts with a number recorded in the entity, oldest record first, as the mail would name them.
async function payToOptions(ctx: QueryContext, entity: string): Promise<Array<{ id: string; bank: string; number: string; holder: string }>> {
  const rows = await ctx.trx
    .selectFrom('ludy_finance.bank_account_number')
    .select(['id', 'bank_account', 'account_number'])
    .where('org_id', '=', ctx.orgId)
    .where('legal_entity_id', '=', entity)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  if (rows.length === 0) return [];
  const holder = await ctx.trx.selectFrom('ludy_kernel.legal_entity').select('name').where('org_id', '=', ctx.orgId).where('id', '=', entity).executeTakeFirst();
  const accounts = await chartAccounts(ctx, [...new Set(rows.map((r) => r.bank_account))]);
  return rows.map((r) => ({ id: r.id, bank: accounts.get(r.bank_account)?.name ?? r.bank_account, number: r.account_number, holder: holder?.name ?? '' }));
}

export async function orgName(ctx: QueryContext, entity: string): Promise<string> {
  // The seller named in the mail is the legal entity whose books the invoices are in.
  const row = await ctx.trx.selectFrom('ludy_kernel.legal_entity').select('name').where('org_id', '=', ctx.orgId).where('id', '=', entity).executeTakeFirst();
  if (row) return oneLine(row.name);
  const tenant = await ctx.trx.selectFrom('ludy_kernel.tenant').select('name').where('org_id', '=', ctx.orgId).executeTakeFirstOrThrow();
  return oneLine(tenant.name);
}

// One plain address: no space, comma, semicolon or angle bracket, so a party's email can never name a second recipient.
const PLAIN_ADDRESS = /^[^\s,;<>@"()[\]\\]+@[^\s,;<>@"()[\]\\]+\.[^\s,;<>@"()[\]\\]+$/;

// A digest of the very invoices of a draft (their ids, sorted): the draft carries it, the send recomputes it, so a customer with any number of invoices is held to the
// set the person reviewed without sending the ids back.
function invoiceKey(invoices: readonly OpenInvoice[]): string {
  return sha256Hex(
    invoices
      .map((i) => `${i.id}:${i.dueDate}:${i.amountDue}:${i.currency.trim().toUpperCase()}:${i.foreignAmountDue ?? ''}`)
      .sort()
      .join(','),
  );
}

export const customerPaused = () => new DomainError('CUSTOMER_PAUSED', 409, 'Đang tạm dừng nhắc khách hàng này; bỏ tạm dừng rồi gửi lại');
export const nothingOverdue = () => new DomainError('NOTHING_OVERDUE', 409, 'Khách hàng này không còn hóa đơn nào quá hạn');

export const paymentReminderDraft = defineQuery({
  name: 'finance.payment_reminder.draft',
  input: z.object({ partyId: zId, legalEntityId: zId.optional() }),
  access: ALL,
  handler: async (ctx, input): Promise<PaymentReminderDraft> => {
    const entity = await resolveLegalEntity(ctx, input.legalEntityId);
    const [customer] = await loadCustomers(ctx, entity, await databaseToday(ctx.trx), input.partyId);
    if (!customer || customer.overdue.length === 0) throw nothingOverdue();
    if (customer.paused) throw customerPaused();
    const currency = await bookCurrency(ctx);
    const org = await orgName(ctx, entity);
    const row = summary(customer, currency, (await lastReminders(ctx, entity, [customer.partyId])).get(customer.partyId));
    return zPaymentReminderDraft.parse({
      partyId: customer.partyId,
      name: customer.name,
      email: customer.email,
      currency,
      org,
      termsDays: customer.termsDays,
      orgTermsDays: (await readCollectionSetting(ctx)).termsDays,
      ownTermsDays: customer.ownTermsDays,
      invoiceKey: invoiceKey(customer.overdue),
      level: row.level,
      lang: row.lang,
      invoices: customer.overdue.map((i) => ({
        id: i.id,
        series: i.series,
        number: i.number,
        date: i.date,
        dueDate: i.dueDate,
        daysOverdue: i.daysOverdue,
        amountDue: i.amountDue,
        currency: i.currency.trim().toUpperCase(),
        foreignTotal: i.foreignTotal,
        foreignAmountDue: i.foreignAmountDue,
      })),
      total: row.total,
      foreignTotals: row.foreignTotals,
      hasForeignCurrency: row.hasForeignCurrency,
      allForeignAmounts: row.allForeignAmounts,
      other: row.other,
      lastReminder: row.lastReminder,
      words: templateWords({ level: row.level, lang: row.lang, customer: oneLine(customer.name), org }),
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
    const askedParty = await ctx.trx
      .selectFrom('ludy_kernel.party')
      .select(sql<string>`coalesce(duplicate_of, id)`.as('kept'))
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.partyId)
      .executeTakeFirst();
    const lockPartyId = askedParty?.kept ?? input.partyId;
    // One reminder per customer per entity at a time: a double click waits here and then meets the first one's mail.
    await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`finance.payment_reminder:${ctx.orgId}:${entity}:${lockPartyId}`}, 0))`.execute(ctx.trx);
    const [customer] = await loadCustomers(ctx, entity, await databaseToday(ctx.trx), input.partyId);
    if (!customer || customer.overdue.length === 0) throw nothingOverdue();
    if (customer.paused) throw customerPaused();
    const level = noticeLevel(customer.overdue) as NoticeLevel;
    const total = totalOf(customer.overdue);
    // What the person reviewed: the notice level, the total and the very invoices (a payment on one and a due date reached on another can leave the total as it was).
    if (level !== input.level || total !== input.total || input.invoiceKey !== invoiceKey(customer.overdue)) {
      throw new DomainError('STALE_REMINDER', 409, 'Sổ sách đã thay đổi từ lúc bạn mở bản nháp (có khoản vừa được thanh toán hoặc đã sang mức nhắc khác); hãy mở lại bản nháp để xem số liệu mới');
    }
    const email = customer.email?.trim() ?? '';
    if (!PLAIN_ADDRESS.test(email)) throw new DomainError('CUSTOMER_EMAIL_REQUIRED', 409, 'Khách hàng này chưa có email; hãy nhập email trong hồ sơ khách hàng rồi gửi lại');
    const lang = reminderLang(customer.overdue);
    const org = await orgName(ctx, entity);
    // Deterministic enforcement per AI-drafted field (#2491): no digits, number words, currencies, links, or stealth controls.
    if (
      (input.aiLead === true && checkReminderField('lead', org, input.lead).kind === 'none') ||
      (input.aiClosing === true && checkReminderField('closing', org, input.closing).kind === 'none')
    ) {
      throw new DomainError('REMINDER_AI_TEXT_INVALID', 422, 'Nội dung do AI soạn không hợp lệ (chứa số liệu, đường dẫn hoặc quá giới hạn); hãy kiểm tra hoặc dùng lời mẫu');
    }
    const source = paymentReminderSource(level, entity);
    const legacySource = `${PAYMENT_REMINDER_SOURCE}${level}`;
    const { allIds: partyScope } = await partyGroupMap(ctx, [customer.partyId]);
    const since = new Date(ctx.now.getTime() - REMINDER_REPEAT_DAYS * DAY_MS);
    const recent = await ctx.trx
      .selectFrom('ludy_kernel.mail_message as m')
      .select('m.created_at')
      .where('m.org_id', '=', ctx.orgId)
      .where('m.source_id', 'in', partyScope)
      .where('m.status', 'in', [...REMINDED_STATES])
      .where((eb) =>
        eb.or([
          eb('m.source', '=', source),
          eb.and([eb('m.source', '=', legacySource), legacyEntityMatch(entity)]),
        ]),
      )
      .where('m.created_at', '>', since)
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
    const book = currency.trim().toUpperCase();
    const foreignTotals = foreignTotalsOf(customer.overdue, book);
    const allForeignAmounts = allForeignAmountsOf(customer.overdue, book);
    const shown = customer.overdue.slice(0, PAYMENT_REMINDER_INVOICES_MAX);
    const payload: PaymentReminderMail = {
      legalEntityId: entity,
      lang,
      level,
      org,
      greeting: oneLine(input.greeting, PAYMENT_REMINDER_TEXT_MAX),
      lead: paragraph(input.lead),
      closing: paragraph(input.closing),
      invoices: shown.map((i) => {
        const invCurrency = i.currency.trim().toUpperCase();
        return {
          series: oneLine(i.series, 50),
          number: oneLine(i.number, 50),
          date: i.date,
          dueDate: i.dueDate,
          daysOverdue: i.daysOverdue,
          amountDue: i.amountDue,
          currency,
          ...(invCurrency !== book ? { invoiceCurrency: invCurrency, foreignTotal: i.foreignTotal, foreignAmountDue: i.foreignAmountDue } : {}),
        };
      }),
      count: customer.overdue.length,
      total,
      currency,
      ...(foreignTotals.length > 0 ? { foreignTotals } : {}),
      allForeignAmounts,
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
  // Only customers a reminder can reach (an email that sends), and a mail the customer's blocked address refused counts as dealt with this week, so the item can clear.
  const due = (await loadCustomers(ctx, entity, today)).filter((c) => c.overdue.length > 0 && !c.paused && PLAIN_ADDRESS.test(c.email?.trim() ?? ''));
  const last = await lastReminders(ctx, entity, due.map((c) => c.partyId), [...REMINDED_STATES, 'suppressed']);
  return { monday, count: due.filter((c) => (last.get(c.partyId)?.at ?? '') < since).length };
}

export const paymentReminderQueries = [paymentRemindersList, paymentReminderDraft];
export const paymentReminderCommands = [paymentReminderSend];
