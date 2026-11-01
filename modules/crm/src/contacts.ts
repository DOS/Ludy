// SPDX-License-Identifier: AGPL-3.0-only
// The contact list (CRM plan 5 and 6, step K4, #2228): crm.contact.list pages through the org's parties, the contacts of
// the CRM, for the "Liên hệ" screen. The filter bar and the view tabs share one input: a Filter AST of the `crm.party`
// scope (a saved view stores exactly this) and one sort. The AST is checked against the scope registry (422 otherwise) and
// turned into a condition by the kernel's builder, then ANDed into a query that row-level security already narrows, so a
// view only narrows what the member may read. Search ignores case, Vietnamese marks and punctuation (search_fold), so
// "nguyen" finds "Nguyễn"; a typed phone number also matches through the phone key, so "+84 912" finds "0912 345 678".
//
// A party marked as a duplicate of another is left out, as in every party list: the kept one stands for both. Paging is by
// cursor on the sort field with the id as tie-breaker, so a page is stable while contacts are added. Every role reads;
// writes go through kernel.party.create and kernel.party.update.
import { sql, type Expression, type SqlBool } from 'kysely';
import {
  CONTACT_PAGE_DEFAULT,
  phoneKey,
  vietnamToday,
  zContactList,
  type Contact,
  type ContactPage,
  type FilterAst,
  type SavedViewSort,
} from '@crove/kernel-contract';
import { filterCondition, flagIs, hasText, sortTerms, textContains, valueIs, withinLastDays, type FieldCondition } from '@crove/kernel';
import type { MemberRole } from '@crove/db';
import { DomainError, defineQuery } from '@crove/kernel-runtime';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];

// The list a view of no sort opens on: by name.
export const CONTACT_DEFAULT_SORT: SavedViewSort = { field: 'name', dir: 'asc' };

// The sort fields of the scope, as the column each means; `text` is its value as a cursor carries it (a time in UTC with
// microseconds, so it reads back exactly whatever the session's settings) and `type` how it is read back.
const TIME_TEXT = (column: string) => sql`to_char(${sql.ref(column)} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const SORT_COLUMNS: Record<string, { column: Expression<unknown>; text: Expression<unknown>; type: 'text' | 'timestamptz' }> = {
  created: { column: sql`p.created_at`, text: TIME_TEXT('p.created_at'), type: 'timestamptz' },
  name: { column: sql`p.name`, text: sql`p.name`, type: 'text' },
  updated: { column: sql`p.updated_at`, text: TIME_TEXT('p.updated_at'), type: 'timestamptz' },
};

// A cursor value as the server wrote it, and nothing else: a made-up value is a 422 and never reaches a cast.
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
function validTime(v: string): boolean {
  if (!TIME.test(v)) return false;
  const at = new Date(`${v.slice(0, 23)}Z`);
  return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 23) === v.slice(0, 23);
}

// A typed phone number (at least four digits, nothing but digits and phone punctuation) also matches the parties whose
// phone key starts with its key, so every way of writing a number finds it.
const PHONE_TYPED = /^\s*\+?[0-9 ().-]{4,30}$/;

const searchContacts: FieldCondition = (op, value, ctx) => {
  const text = textContains([sql`p.name`, sql`p.email`, sql`p.phone`, sql`p.tax_code`])(op, value, ctx);
  const typed = String(value);
  const key = PHONE_TYPED.test(typed) ? phoneKey(typed) : null;
  if (key === null || key.length < 4) return text;
  return sql<boolean>`(${text} OR crove_kernel.phone_key(p.phone) LIKE ${`${key.replace(/[\\%_]/g, (c) => `\\${c}`)}%`})`;
};

// The condition of each field of the `crm.party` scope over the party table (alias p). A contact "has an open deal" when a
// deal of it sits in an open stage (not Won or Lost); deals are the crm module's own tables (step K1).
export function contactFields(): Record<string, FieldCondition> {
  return {
    search: searchContacts,
    kind: valueIs(sql`p.kind`),
    has_email: flagIs(hasText(sql`p.email`)),
    has_phone: flagIs(hasText(sql`p.phone`)),
    has_tax_code: flagIs(hasText(sql`p.tax_code`)),
    has_open_deal: flagIs(sql<boolean>`EXISTS (
      SELECT 1 FROM crove_crm.deal d JOIN crove_crm.pipeline_stage s ON s.org_id = d.org_id AND s.id = d.stage_id
      WHERE d.org_id = p.org_id AND d.party_id = p.id AND s.kind = 'open')`),
    created: withinLastDays(sql`p.created_at`),
  };
}

// Where the next page starts: the sort it belongs to and the last contact shown with its sort value as the page was served,
// so a contact edited or removed since cannot make a page repeat or skip rows. The value is checked before it is used.
interface Cursor {
  f: string;
  d: 'asc' | 'desc';
  id: string;
  v: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

function decodeCursor(raw: string): Cursor {
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<Cursor>;
    if (typeof c.f === 'string' && (c.d === 'asc' || c.d === 'desc') && typeof c.id === 'string' && UUID.test(c.id) && typeof c.v === 'string' && c.v.length <= 1000) return { f: c.f, d: c.d, id: c.id, v: c.v };
  } catch {
    // Falls through to the refusal below.
  }
  throw new DomainError('VALIDATION', 422, 'Con trỏ trang không hợp lệ', { issues: [{ path: 'cursor', code: 'bad_cursor' }] });
}

interface Row {
  id: string;
  kind: 'organization' | 'person';
  name: string;
  tax_code: string | null;
  address: string | null;
  email: string | null;
  phone: string | null;
  version: number;
  created_at: Date;
  sort_value: string;
}

export const contactList = defineQuery({
  name: 'crm.contact.list',
  input: zContactList,
  access: ALL,
  handler: async (ctx, input): Promise<ContactPage> => {
    const filters: FilterAst = (input.filters as FilterAst | undefined) ?? { v: 1, all: [] };
    const sort = input.sort ?? null;
    const limit = input.limit ?? CONTACT_PAGE_DEFAULT;
    const me = ctx.actor.type === 'user' ? ctx.actor.userId : null;
    // A query has no command clock: one read takes the process clock once, for "created within the last N days".
    const now = new Date();
    const where = filterCondition('crm.party', filters, contactFields(), { me, today: vietnamToday(now), now });
    const sorted = sort ?? CONTACT_DEFAULT_SORT;
    const order = sortTerms('crm.party', sort, Object.fromEntries(Object.entries(SORT_COLUMNS).map(([k, v]) => [k, v.column])), sql`p.id`, CONTACT_DEFAULT_SORT);
    const by = SORT_COLUMNS[sorted.field];
    if (!by) throw new Error(`contact list: no column for sort field ${sorted.field}`);

    let after: Expression<SqlBool> = sql<boolean>`true`;
    if (input.cursor !== undefined) {
      const c = decodeCursor(input.cursor);
      // A cursor belongs to the sort it came from.
      if (c.f !== sorted.field || c.d !== sorted.dir) {
        throw new DomainError('VALIDATION', 422, 'Con trỏ trang không khớp với cách sắp xếp', { issues: [{ path: 'cursor', code: 'bad_cursor' }] });
      }
      if (by.type === 'timestamptz' && !validTime(c.v)) {
        throw new DomainError('VALIDATION', 422, 'Con trỏ trang không hợp lệ', { issues: [{ path: 'cursor', code: 'bad_cursor' }] });
      }
      const value = by.type === 'text' ? sql`${c.v}::text` : sql`${c.v}::timestamptz`;
      const past = sorted.dir === 'asc' ? sql`${by.column} > ${value}` : sql`${by.column} < ${value}`;
      after = sql<boolean>`(${past} OR (${by.column} = ${value} AND p.id > ${c.id}::uuid))`;
    }

    const result = await sql<Row>`
      SELECT p.id, p.kind, p.name, p.tax_code, p.address, p.email, p.phone, p.version, p.created_at, (${by.text}) AS sort_value
      FROM crove_kernel.party p
      WHERE p.org_id = ${ctx.orgId}::uuid AND p.duplicate_of IS NULL AND ${where} AND ${after}
      ORDER BY ${sql.join(order, sql`, `)}
      LIMIT ${limit + 1}`.execute(ctx.trx);

    const rows = result.rows.slice(0, limit);
    const last = rows.at(-1);
    const more = result.rows.length > limit && last !== undefined;
    const items: Contact[] = rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      name: r.name,
      taxCode: r.tax_code,
      address: r.address,
      email: r.email,
      phone: r.phone,
      version: r.version,
      createdAt: r.created_at.toISOString(),
    }));
    return { items, next: more ? encodeCursor({ f: sorted.field, d: sorted.dir, id: last.id, v: last.sort_value }) : null };
  },
});

export const contactQueries = [contactList];
