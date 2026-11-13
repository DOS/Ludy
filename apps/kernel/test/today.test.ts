// SPDX-License-Identifier: AGPL-3.0-only
// "Hôm nay cần bạn" (#2383), unit part: kernel.today runs the reads that are registered, in the caller's own context,
// and merges, orders and checks what they answer. That each line's read scopes to the member is that line's own test;
// here the reads are stubs.
import { describe, expect, it } from 'vitest';
import { DomainError, type Lookup, type QueryContext } from '@crove/kernel-runtime';
import { TODAY_READS, todayQuery } from '@crove/kernel';

const item = (over: Record<string, unknown> = {}) => ({
  kind: 'proposal',
  app: 'finance',
  id: 'a',
  title: { key: 'today.x' },
  href: '/ke-toan',
  ...over,
});

type Reads = Record<string, unknown | (() => never)>;

// A context whose query() answers from `reads`: a function throws, a missing name is QUERY_NOT_FOUND, an `absent` module is not_installed.
function contextOf(reads: Reads, absent: readonly string[] = [], asked: string[] = []): QueryContext {
  return {
    query: async (name: string): Promise<Lookup<unknown>> => {
      asked.push(name);
      const module = name.split('.')[0] as string;
      if (absent.includes(module)) return { status: 'not_installed', module };
      if (!(name in reads)) throw new DomainError('QUERY_NOT_FOUND', 404, `no query ${name}`);
      const answer = reads[name];
      if (typeof answer === 'function') (answer as () => never)();
      return { status: 'ok', value: answer };
    },
  } as unknown as QueryContext;
}

const run = (reads: Reads, options: { reads?: readonly string[]; absent?: readonly string[]; asked?: string[] } = {}) =>
  todayQuery(options.reads ? { reads: options.reads } : {}).handler(contextOf(reads, options.absent, options.asked), {});

describe('kernel.today', () => {
  it('names the five reads the lines agreed to expose and the cross-app rule of the kernel', () => {
    expect([...TODAY_READS]).toEqual(['finance.today', 'crm.today', 'social.today', 'ads.today', 'kernel.conversation.today', 'kernel.signals.deal_without_invoice', 'kernel.signals.receivable_with_open_deal', 'kernel.signals.supplier_bank_changed']);
  });

  it('shows nothing when no read is registered yet, and when the modules are off', async () => {
    expect(await run({})).toEqual({ items: [], dropped: 0, truncated: 0, failed: 0 });
    expect(await run({}, { absent: ['finance', 'crm', 'social', 'ads'] })).toEqual({ items: [], dropped: 0, truncated: 0, failed: 0 });
  });

  it('merges the reads that are registered, flags first, and skips the ones that are not', async () => {
    const asked: string[] = [];
    const result = await run(
      {
        'finance.today': [item({ id: 'p1', count: 3 }), item({ id: 'f1', kind: 'flag', severity: 'warn', href: '/ke-toan/so-cai' })],
        'kernel.conversation.today': [item({ app: 'conversations', kind: 'message', id: 'm1', href: '/hop-thu' })],
        'crm.today': [item({ app: 'crm', kind: 'deadline', id: 'd1', dueAt: '2026-11-03T09:00:00+07:00', href: '/crm/deals' })],
      },
      { asked },
    );
    expect(result.dropped).toBe(0);
    expect(result.items.map((i) => `${i.kind}:${i.app}:${i.id}`)).toEqual(['flag:finance:f1', 'proposal:finance:p1', 'message:conversations:m1', 'deadline:crm:d1']);
    // Every agreed read was asked, in order, with a not-yet-registered one skipped rather than failing the list.
    expect(asked).toEqual([...TODAY_READS]);
  });

  it('drops an item that does not match the shape, and counts it', async () => {
    const result = await run({
      'finance.today': [
        item({ id: 'ok' }),
        item({ id: 'bad-link', href: 'https://evil.example' }),
        item({ id: 'leak', customerName: 'Nguyễn Văn A' }),
        'not an item',
      ],
      'crm.today': { not: 'a list' },
    });
    expect(result.items.map((i) => i.id)).toEqual(['ok']);
    expect(result.dropped).toBe(4);
  });

  it('shows an item that two reads both answer once', async () => {
    const result = await run({ 'finance.today': [item({ id: 'same' })], 'social.today': [item({ id: 'same' }), item({ app: 'social', id: 'same' })] });
    expect(result.items.map((i) => `${i.app}:${i.id}`)).toEqual(['finance:same', 'social:same']);
  });

  it('cuts the merged list at 200, keeping the most urgent, and says how many it cut', async () => {
    const many = (app: string, n: number) => Array.from({ length: n }, (_, i) => item({ app, id: `${app}-${i}` }));
    const result = await run({ 'finance.today': [item({ kind: 'flag', severity: 'block', id: 'urgent' }), ...many('finance', 150)], 'crm.today': many('crm', 150) });
    expect(result.items).toHaveLength(200);
    expect(result.items[0]?.id).toBe('urgent');
    expect(result.truncated).toBe(101);
  });

  it('skips a line that refuses, and counts it, while a database error still fails the list', async () => {
    const result = await run({
      'finance.today': () => {
        throw new DomainError('FORBIDDEN', 403, 'no');
      },
      'crm.today': [item({ app: 'crm' })],
    });
    expect(result.items.map((i) => i.app)).toEqual(['crm']);
    expect(result.failed).toBe(1);
    await expect(
      run({
        'finance.today': () => {
          throw new Error('current transaction is aborted');
        },
      }),
    ).rejects.toThrow(/aborted/);
  });

  it('lets an error that is not a refusal fail the list, since the transaction may be unusable', async () => {
    await expect(
      run({
        'finance.today': () => {
          throw new Error('boom');
        },
      }),
    ).rejects.toThrow(/boom/);
  });

  it('is open to every role: each line decides what the member sees', () => {
    const query = todayQuery();
    expect(query.name).toBe('kernel.today');
    expect([...(query.access as string[])].sort()).toEqual(['admin', 'member', 'owner', 'viewer']);
  });
});
