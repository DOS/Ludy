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

// The sort fields of the scope, as the column each means, and the type its cursor value is read back as.
const SORT_COLUMNS: Record<string, { column: Expression<unknown>; type: 'text' | 'timestamptz' }> = {
  created: { column: sql`p.created_at`, type: 'timestamptz' },
  name: { column: sql`p.name`, type: 'text' },
  updated: { column: sql`p.updated_at`, type: 'timestamptz' },
};

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

// The condition of each field of the `crm.party` scope over the party table (alias p). A contact "has an open deal" only
// once deals exist (step K1): until then no contact has one, so "yes" matches none and "no" matches every contact.
export function contactFields(): Record<string, FieldCondition> {
  return {
    search: searchContacts,
    kind: valueIs(sql`p.kind`),
    has_email: flagIs(hasText(sql`p.email`)),
    has_phone: flagIs(hasText(sql`p.phone`)),
    has_tax_code: flagIs(hasText(sql`p.tax_code`)),
    has_open_deal: flagIs(sql<boolean>`false`),
    created: withinLastDays(sql`p.created_at`),
  };
}

// Where the next page starts: the sort it belongs to and the last contact shown. The sort value is read from that contact
// on the server, so a long name never makes the cursor long and nothing but an id is taken from the client.
interface Cursor {
  f: string;
  d: 'asc' | 'desc';
  id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

function decodeCursor(raw: string): Cursor {
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<Cursor>;
    if (typeof c.f === 'string' && (c.d === 'asc' || c.d === 'desc') && typeof c.id === 'string' && UUID.test(c.id)) return { f: c.f, d: c.d, id: c.id };
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
      // The sort value of the last contact shown, in this org and as this member reads it: a contact that is gone, or
      // another org's, is a stale cursor.
      const last = await sql<{ v: string }>`SELECT (${by.column})::text AS v FROM crove_kernel.party p WHERE p.org_id = ${ctx.orgId}::uuid AND p.id = ${c.id}::uuid`.execute(ctx.trx);
      const v = last.rows[0]?.v;
      if (v === undefined) throw new DomainError('VALIDATION', 422, 'Con trỏ trang không còn hợp lệ', { issues: [{ path: 'cursor', code: 'bad_cursor' }] });
      const value = by.type === 'text' ? sql`${v}::text` : sql`${v}::timestamptz`;
      const past = sorted.dir === 'asc' ? sql`${by.column} > ${value}` : sql`${by.column} < ${value}`;
      after = sql<boolean>`(${past} OR (${by.column} = ${value} AND p.id > ${c.id}::uuid))`;
    }

    const result = await sql<Row>`
      SELECT p.id, p.kind, p.name, p.tax_code, p.address, p.email, p.phone, p.version, p.created_at
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
    return { items, next: more ? encodeCursor({ f: sorted.field, d: sorted.dir, id: last.id }) : null };
  },
});

export const contactQueries = [contactList];
