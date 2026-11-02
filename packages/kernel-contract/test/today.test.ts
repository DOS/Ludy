// SPDX-License-Identifier: AGPL-3.0-only
// The "Hôm nay cần bạn" item shape (#2383) every line's read returns.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { TODAY_APPS, TODAY_KINDS, todayCurrency, zTodayItem, zTodayItemBase, zTodayItems, type TodayItem } from '../src/today.ts';

const item = (over: Record<string, unknown> = {}) => ({
  kind: 'proposal',
  app: 'finance',
  id: 'vendor-group:7f3a',
  title: { key: 'today.finance.proposals', params: { vendor: 'Phú Thịnh', n: 3 } },
  href: '/ke-toan/de-xuat?entity=1',
  ...over,
});

describe('TodayItem', () => {
  it('takes the smallest item and the fullest one', () => {
    expect(zTodayItem.safeParse(item()).success).toBe(true);
    const full = item({
      kind: 'deadline',
      count: 3,
      amount: '1250000.50',
      currency: 'USD',
      dueAt: '2026-11-03T09:00:00+07:00',
      severity: 'warn',
    });
    const parsed = zTodayItem.parse(full);
    expect(parsed).toEqual(full);
    // The type is the parsed shape.
    const typed: TodayItem = parsed;
    expect(typed.amount).toBe('1250000.50');
  });

  it('knows the four kinds and the six apps', () => {
    expect([...TODAY_KINDS]).toEqual(['proposal', 'flag', 'message', 'deadline']);
    expect([...TODAY_APPS]).toEqual(['finance', 'crm', 'notes', 'social', 'ads', 'conversations']);
    for (const kind of TODAY_KINDS) expect(zTodayItem.safeParse(item({ kind })).success, kind).toBe(true);
    for (const app of TODAY_APPS) expect(zTodayItem.safeParse(item({ app })).success, app).toBe(true);
    expect(zTodayItem.safeParse(item({ kind: 'task' })).success).toBe(false);
    expect(zTodayItem.safeParse(item({ app: 'kernel' })).success).toBe(false);
  });

  it('keeps the title a key with params, never rendered text', () => {
    expect(zTodayItem.safeParse(item({ title: 'Duyệt 3 đề xuất' })).success).toBe(false);
    expect(zTodayItem.safeParse(item({ title: { key: '' } })).success).toBe(false);
    expect(zTodayItem.safeParse(item({ title: { key: 'today.x', params: { n: true } } })).success).toBe(false);
    expect(zTodayItem.safeParse(item({ title: { key: 'today.x' } })).success).toBe(true);
  });

  it('holds money as a decimal string in an ISO 4217 currency, VND when absent', () => {
    expect(zTodayItem.safeParse(item({ amount: 1250000 })).success).toBe(false);
    expect(zTodayItem.safeParse(item({ amount: '12,5' })).success).toBe(false);
    expect(zTodayItem.safeParse(item({ amount: '-100' })).success).toBe(true);
    expect(zTodayItem.safeParse(item({ amount: '100', currency: 'usd' })).success).toBe(false);
    expect(zTodayItem.safeParse(item({ amount: '100', currency: 'VN' })).success).toBe(false);
    expect(zTodayItem.safeParse(item({ currency: 'USD' })).success, 'a currency with no amount').toBe(false);
    expect(todayCurrency(zTodayItem.parse(item({ amount: '100' })))).toBe('VND');
    expect(todayCurrency(zTodayItem.parse(item({ amount: '100', currency: 'USD' })))).toBe('USD');
  });

  it('wants an ISO date-time, a positive whole count and a known severity', () => {
    expect(zTodayItem.safeParse(item({ dueAt: '2026-11-03T09:00:00Z' })).success).toBe(true);
    expect(zTodayItem.safeParse(item({ dueAt: '2026-11-03' })).success).toBe(false);
    expect(zTodayItem.safeParse(item({ count: 0 })).success).toBe(false);
    expect(zTodayItem.safeParse(item({ count: 1.5 })).success).toBe(false);
    for (const severity of ['info', 'warn', 'block']) expect(zTodayItem.safeParse(item({ severity })).success, severity).toBe(true);
    expect(zTodayItem.safeParse(item({ severity: 'high' })).success).toBe(false);
  });

  it('links only to a path inside the app', () => {
    for (const href of ['/', '/crm/deals/1', '/ke-toan?entity=3&tab=proposals']) expect(zTodayItem.safeParse(item({ href })).success, href).toBe(true);
    for (const href of ['/crm?next=%2F%2Fx#top', '/ke-toan/hóa-đơn?entity=3']) expect(zTodayItem.safeParse(item({ href })).success, href).toBe(true);
    for (const href of ['', 'crm/deals', '//evil.example/x', 'https://evil.example', 'javascript:alert(1)', '/a b']) {
      expect(zTodayItem.safeParse(item({ href })).success, href).toBe(false);
    }
  });

  it('refuses a link a browser would read as off-site or that hides what it is', () => {
    // A backslash is a slash to a browser: `/\evil.example` is `//evil.example`.
    for (const href of ['/\\evil.example', '/\\\\evil', '/a\\b', '/a\tb', '/a\nb', '/a\u0000b', '/a​b', '/a‮b', '/a b', `/${'x'.repeat(2000)}`]) {
      expect(zTodayItem.safeParse(item({ href })).success, JSON.stringify(href)).toBe(false);
    }
  });

  it('refuses a field it does not know instead of dropping it', () => {
    expect(zTodayItem.safeParse(item({ customerName: 'Nguyễn Văn A' })).success).toBe(false);
    expect(zTodayItem.safeParse(item({ title: { key: 'today.x', text: 'Duyệt' } })).success).toBe(false);
  });

  it('applies the currency rule to the item, and the base object is there for a line to extend', () => {
    const issue = zTodayItem.safeParse(item({ currency: 'USD' }));
    expect(issue.success).toBe(false);
    expect(issue.error?.issues[0]?.path).toEqual(['currency']);
    expect(zTodayItemBase.extend({ extra: z.string() }).safeParse(item({ extra: 'x' })).success).toBe(true);
  });

  it('keeps the lengths in bounds', () => {
    expect(zTodayItem.safeParse(item({ id: '' })).success).toBe(false);
    expect(zTodayItem.safeParse(item({ id: 'x'.repeat(201) })).success).toBe(false);
    expect(zTodayItem.safeParse(item({ title: { key: 'k'.repeat(201) } })).success).toBe(false);
    expect(zTodayItem.safeParse(item({ title: { key: 'k', params: { '': 'x' } } })).success).toBe(false);
    expect(zTodayItem.safeParse(item({ title: { key: 'k', params: { p: 'x'.repeat(501) } } })).success).toBe(false);
    expect(zTodayItem.safeParse(item({ dueAt: '2026-11-03T09:00:00+0700' })).success, 'an offset needs its colon').toBe(false);
    expect(zTodayItem.safeParse(item({ dueAt: '2026-11-03T09:00:00.250Z' })).success).toBe(true);
    expect(zTodayItems.safeParse([item(), item({ href: 'https://evil.example' })]).success).toBe(false);
  });

  it('needs kind, app, id, title and href', () => {
    for (const field of ['kind', 'app', 'id', 'title', 'href']) {
      const rest: Record<string, unknown> = item();
      delete rest[field];
      expect(zTodayItem.safeParse(rest).success, field).toBe(false);
    }
  });

  it('takes a list of items and caps its length', () => {
    expect(zTodayItems.safeParse([item(), item({ id: 'b' })]).success).toBe(true);
    expect(zTodayItems.safeParse(Array.from({ length: 201 }, (_, i) => item({ id: String(i) }))).success).toBe(false);
  });
});
