// SPDX-License-Identifier: AGPL-3.0-only
// Meta's management of a live launch's objects (ADR-0043, #3835, ads W4) against recorded answers: the ad set's budget in Meta's own minor unit and its end time, what a read
// says and how it is converted back, which class carries a status change, and the pin on what it can reach (one host, an object id of digits). The recorded answers are written
// from Meta's documentation, so these prove the shape of the code, not Meta's behaviour.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Fetch } from '@crove/channel';
import { AdPlatformError, managerOf, type ActivateTarget, type AdActivator } from '../src/index.ts';
import { MetaAdManager } from '../src/meta-manage.ts';

const SECRET = JSON.stringify({ accessToken: 'write-token' });
const VND = { externalAccountId: 'act_1', currency: 'VND' };
const USD = { externalAccountId: 'act_2', currency: 'USD' };
const AD_SET = { level: 'ad_set' as const, id: '120002' };

interface Call {
  method: string;
  url: URL;
  authorization: string | null;
  form: URLSearchParams | null;
}
function recorded(answers: Array<{ status?: number; body: unknown } | Error>): { fetch: Fetch; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const fetch: Fetch = async (input, init) => {
    calls.push({ method: init?.method ?? 'GET', url: new URL(input), authorization: new Headers(init?.headers).get('authorization'), form: typeof init?.body === 'string' ? new URLSearchParams(init.body) : null });
    const next = answers[i++];
    if (!next) throw new Error(`no recorded answer for ${input}`);
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, calls };
}

// The writer and the activator the manager is composed of: recording stubs, so what each carries is seen.
function parts() {
  const statusCalls: Array<{ secret: string; level: string; id: string; status: string }> = [];
  const activations: Array<{ secret: string; target: ActivateTarget }> = [];
  const writer = {
    setStatus: async (secret: string, object: { level: string; id: string }, status: 'paused' | 'archived') => void statusCalls.push({ secret, level: object.level, id: object.id, status }),
  };
  const activator: AdActivator = {
    activate: async (secret, target) => void activations.push({ secret, target }),
    readStatus: async () => ({ status: 'active' }),
  };
  return { writer: writer as never, activator, statusCalls, activations };
}
function manager(answers: Array<{ status?: number; body: unknown } | Error> = []) {
  const { fetch, calls } = recorded(answers);
  const p = parts();
  const m = new MetaAdManager({ appSecret: 'app-secret', graphVersion: 'v24.0', fetch, now: () => new Date('2026-11-05T00:00:00Z'), writer: p.writer, activator: p.activator });
  return { m, calls, ...p };
}
const rejection = async (promise: Promise<unknown>): Promise<AdPlatformError> => {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AdPlatformError);
  return error as AdPlatformError;
};

describe('MetaAdManager.setBudget', () => {
  it('posts daily_budget to the ad set\'s own id, in Meta\'s minor unit: dong as they are, dollars times a hundred', async () => {
    const { m, calls } = manager([{ body: { success: true } }, { body: { success: true } }, { body: { success: true } }, { body: { success: true } }]);
    await m.setBudget(SECRET, AD_SET, VND, '100000');
    await m.setBudget(SECRET, AD_SET, VND, '150000.00');
    await m.setBudget(SECRET, AD_SET, USD, '19.99');
    await m.setBudget(SECRET, AD_SET, USD, '5');
    expect(calls).toHaveLength(4);
    for (const call of calls) {
      expect(call.method).toBe('POST');
      expect(call.url.origin).toBe('https://graph.facebook.com');
      expect(call.url.pathname).toBe('/v24.0/120002');
      expect(call.authorization).not.toBeNull();
      expect([...(call.form?.keys() ?? [])]).toEqual(['daily_budget']);
    }
    expect(calls.map((c) => c.form?.get('daily_budget'))).toEqual(['100000', '150000', '1999', '500']);
  });

  it('does its arithmetic on the text of the amount, so no digit is lost to a float', async () => {
    const { m, calls } = manager([{ body: { success: true } }, { body: { success: true } }]);
    await m.setBudget(SECRET, AD_SET, USD, '9999999999999.99');
    await m.setBudget(SECRET, AD_SET, USD, '0.29');
    expect(calls.map((c) => c.form?.get('daily_budget'))).toEqual(['999999999999999', '29']);
  });

  it('refuses a fraction the currency cannot carry, an amount that is not valid and a currency it has no offset for, before any request', async () => {
    const { m, calls } = manager([{ body: { success: true } }]);
    expect(await rejection(m.setBudget(SECRET, AD_SET, VND, '50000.5'))).toMatchObject({ kind: 'bad_request', code: 'BUDGET_FRACTION' });
    expect(await rejection(m.setBudget(SECRET, AD_SET, USD, '1.234'))).toMatchObject({ kind: 'bad_request', code: 'BUDGET_INVALID' });
    expect(await rejection(m.setBudget(SECRET, AD_SET, USD, '0'))).toMatchObject({ kind: 'bad_request', code: 'BUDGET_INVALID' });
    expect(await rejection(m.setBudget(SECRET, AD_SET, USD, '1e3'))).toMatchObject({ kind: 'bad_request', code: 'BUDGET_INVALID' });
    expect(await rejection(m.setBudget(SECRET, AD_SET, { externalAccountId: 'act_3', currency: 'CHF' }, '5'))).toMatchObject({ kind: 'bad_request', code: 'CURRENCY_UNSUPPORTED' });
    expect(calls).toHaveLength(0);
  });

  it('says so when the answer does not say it changed, and what Meta refuses with keeps its meaning', async () => {
    const { m } = manager([{ body: { success: false } }, { body: {} }, { status: 400, body: { error: { message: 'm', type: 'OAuthException', code: 100 } } }, { status: 400, body: { error: { message: 'm', type: 'OAuthException', code: 190 } } }, new TypeError('fetch failed')]);
    expect(await rejection(m.setBudget(SECRET, AD_SET, VND, '1000'))).toMatchObject({ kind: 'unknown', code: 'NOT_CHANGED' });
    expect(await rejection(m.setBudget(SECRET, AD_SET, VND, '1000'))).toMatchObject({ kind: 'unknown', code: 'NOT_CHANGED' });
    expect(await rejection(m.setBudget(SECRET, AD_SET, VND, '1000'))).toMatchObject({ kind: 'bad_request', code: '100' });
    expect(await rejection(m.setBudget(SECRET, AD_SET, VND, '1000'))).toMatchObject({ kind: 'token_expired' });
    expect(await rejection(m.setBudget(SECRET, AD_SET, VND, '1000'))).toMatchObject({ kind: 'transient', code: 'NETWORK' });
  });
});

describe('MetaAdManager.setEndTime', () => {
  it('posts end_time to the ad set\'s own id, as it was given', async () => {
    const { m, calls } = manager([{ body: { success: true } }]);
    await m.setEndTime(SECRET, AD_SET, '2026-11-17T00:00:00+0700');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'POST' });
    expect(calls[0]?.url.pathname).toBe('/v24.0/120002');
    expect([...(calls[0]?.form?.entries() ?? [])]).toEqual([['end_time', '2026-11-17T00:00:00+0700']]);
  });

  it('refuses a time that is not ISO 8601 with a numeric offset, before any request', async () => {
    const { m, calls } = manager([]);
    for (const time of ['2026-11-17', '2026-11-17T00:00:00', '2026-11-17T00:00:00Z', '2026-11-17T00:00:00+07:00', 'tomorrow', '']) {
      expect(await rejection(m.setEndTime(SECRET, AD_SET, time)), time).toMatchObject({ kind: 'bad_request', code: 'TIME_INVALID' });
    }
    expect(calls).toHaveLength(0);
  });

  it('says so when the answer does not say it changed', async () => {
    const { m } = manager([{ body: { success: false } }]);
    expect(await rejection(m.setEndTime(SECRET, AD_SET, '2026-11-17T00:00:00+0700'))).toMatchObject({ kind: 'unknown', code: 'NOT_CHANGED' });
  });
});

describe('MetaAdManager.read', () => {
  it('reads status, daily_budget and end_time of an ad set, and converts the budget back to the currency\'s own unit', async () => {
    const { m, calls } = manager([
      { body: { status: 'PAUSED', daily_budget: '100000', end_time: '2026-11-17T00:00:00+0700' } },
      { body: { status: 'ACTIVE', daily_budget: '1999', end_time: '2026-11-17T00:00:00+0700' } },
      { body: { status: 'ARCHIVED', daily_budget: '500' } },
    ]);
    expect(await m.read(SECRET, AD_SET, VND)).toEqual({ status: 'paused', dailyBudget: '100000', endTime: '2026-11-17T00:00:00+0700' });
    expect(await m.read(SECRET, AD_SET, USD)).toEqual({ status: 'active', dailyBudget: '19.99', endTime: '2026-11-17T00:00:00+0700' });
    expect(await m.read(SECRET, AD_SET, USD)).toEqual({ status: 'archived', dailyBudget: '5', endTime: null });
    for (const call of calls) {
      expect(call.method).toBe('GET');
      expect(call.url.pathname).toBe('/v24.0/120002');
      expect(call.url.searchParams.get('fields')).toBe('status,daily_budget,end_time');
      expect(call.form).toBeNull();
    }
  });

  it('asks for the status alone of a campaign or an ad, and has no budget or end time for them', async () => {
    const { m, calls } = manager([{ body: { status: 'ACTIVE' } }, { body: { status: 'WITH_ISSUES', daily_budget: '700', end_time: '2026-11-17T00:00:00+0700' } }]);
    expect(await m.read(SECRET, { level: 'campaign', id: '120001' }, VND)).toEqual({ status: 'active', dailyBudget: null, endTime: null });
    expect(calls[0]?.url.searchParams.get('fields')).toBe('status');
    // The field list asked for is the only thing sent, and an answer that says more is read as it comes (a word Ludy does not name is `other`).
    expect((await m.read(SECRET, { level: 'ad', id: '120003' }, VND)).status).toBe('other');
    expect(calls[1]?.url.searchParams.get('fields')).toBe('status');
  });

  it('answers null for a budget or an end time the platform did not say', async () => {
    const { m } = manager([{ body: { status: 'PAUSED' } }, { body: { status: 'paused', daily_budget: '', end_time: '' } }]);
    expect(await m.read(SECRET, AD_SET, VND)).toEqual({ status: 'paused', dailyBudget: null, endTime: null });
    expect(await m.read(SECRET, AD_SET, VND)).toEqual({ status: 'paused', dailyBudget: null, endTime: null });
  });

  it('is an error, not a guess, when the budget it is told is not digits or the currency has no offset', async () => {
    const { m } = manager([{ body: { status: 'PAUSED', daily_budget: '12.5' } }, { body: { status: 'PAUSED', daily_budget: 'abc' } }, { body: { status: 'PAUSED', daily_budget: '-100' } }, { body: { status: 'PAUSED', daily_budget: '1000' } }]);
    expect(await rejection(m.read(SECRET, AD_SET, USD))).toMatchObject({ kind: 'unknown', code: 'BUDGET_UNREADABLE' });
    expect(await rejection(m.read(SECRET, AD_SET, USD))).toMatchObject({ kind: 'unknown', code: 'BUDGET_UNREADABLE' });
    expect(await rejection(m.read(SECRET, AD_SET, USD))).toMatchObject({ kind: 'unknown', code: 'BUDGET_UNREADABLE' });
    expect(await rejection(m.read(SECRET, AD_SET, { externalAccountId: 'act_3', currency: 'CHF' }))).toMatchObject({ kind: 'bad_request', code: 'CURRENCY_UNSUPPORTED' });
  });

  it('keeps the meaning of what Meta refuses with', async () => {
    const { m } = manager([{ status: 400, body: { error: { message: 'm', type: 'GraphMethodException', code: 100 } } }, { status: 500, body: { error: { message: 'm', type: 'x', code: 2 } } }]);
    expect(await rejection(m.read(SECRET, AD_SET, VND))).toMatchObject({ kind: 'bad_request' });
    expect(await rejection(m.read(SECRET, AD_SET, VND))).toMatchObject({ kind: 'transient' });
  });
});

describe('MetaAdManager.changeStatus', () => {
  it('pauses and archives through the writer, which owns those words, and sends nothing itself', async () => {
    const { m, calls, statusCalls, activations } = manager([]);
    await m.changeStatus(SECRET, { level: 'campaign', id: '120001' }, 'paused');
    await m.changeStatus(SECRET, { level: 'ad', id: '120003' }, 'archived');
    expect(statusCalls).toEqual([
      { secret: SECRET, level: 'campaign', id: '120001', status: 'paused' },
      { secret: SECRET, level: 'ad', id: '120003', status: 'archived' },
    ]);
    expect(activations).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('switches on through the activator, which owns that word, and sends nothing itself', async () => {
    const { m, calls, statusCalls, activations } = manager([]);
    await m.changeStatus(SECRET, { level: 'ad_set', id: '120002' }, 'active');
    expect(activations).toEqual([{ secret: SECRET, target: { level: 'ad_set', id: '120002' } }]);
    expect(statusCalls).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('lets what the writer or the activator throws through as it is', async () => {
    const failing = new MetaAdManager({
      appSecret: 'app-secret',
      writer: { setStatus: async () => Promise.reject(new AdPlatformError('permission', 'NO')) },
      activator: { activate: async () => Promise.reject(new AdPlatformError('transient', 'NETWORK')), readStatus: async () => ({ status: 'active' }) },
    });
    expect(await rejection(failing.changeStatus(SECRET, { level: 'ad', id: '1' }, 'paused'))).toMatchObject({ kind: 'permission', code: 'NO' });
    expect(await rejection(failing.changeStatus(SECRET, { level: 'ad', id: '1' }, 'active'))).toMatchObject({ kind: 'transient', code: 'NETWORK' });
  });
});

describe('what MetaAdManager can reach', () => {
  it('refuses an id that is not digits (a path, a query, another endpoint) and a secret that holds no token, before any request', async () => {
    const { m, calls } = manager([]);
    for (const id of ['12/../3', 'me/permissions', '120002?x=1', '', 'x', '1'.repeat(33), '12 3', '-1']) {
      const target = { level: 'ad_set' as const, id };
      expect((await rejection(m.setBudget(SECRET, target, VND, '1000'))).code, id).toBe('BAD_OBJECT');
      expect((await rejection(m.setEndTime(SECRET, target, '2026-11-17T00:00:00+0700'))).code, id).toBe('BAD_OBJECT');
      expect((await rejection(m.read(SECRET, target, VND))).code, id).toBe('BAD_OBJECT');
    }
    for (const secret of ['not json', '{}', '{"accessToken":""}', '{"accessToken":5}', 'null']) {
      expect((await rejection(m.setBudget(secret, AD_SET, VND, '1000'))).code, secret).toBe('BAD_SECRET');
      expect((await rejection(m.read(secret, AD_SET, VND))).code, secret).toBe('BAD_SECRET');
    }
    expect(calls).toHaveLength(0);
  });

  it('reaches graph.facebook.com and no other host, whatever it is asked', async () => {
    const { m, calls } = manager([{ body: { success: true } }, { body: { success: true } }, { body: { status: 'ACTIVE', daily_budget: '1000', end_time: 'x' } }]);
    await m.setBudget(SECRET, AD_SET, VND, '1000');
    await m.setEndTime(SECRET, AD_SET, '2026-11-17T00:00:00+0700');
    await m.read(SECRET, AD_SET, VND);
    expect(new Set(calls.map((c) => c.url.host))).toEqual(new Set(['graph.facebook.com']));
    expect(new Set(calls.map((c) => c.url.protocol))).toEqual(new Set(['https:']));
  });

  it('keeps the token in a header and never in a URL or a form', async () => {
    const { m, calls } = manager([{ body: { success: true } }, { body: { status: 'ACTIVE' } }]);
    await m.setBudget(SECRET, AD_SET, VND, '1000');
    await m.read(SECRET, AD_SET, VND);
    for (const call of calls) {
      expect(call.authorization).toContain('write-token');
      expect(call.url.toString()).not.toContain('write-token');
      expect(call.form?.toString() ?? '').not.toContain('write-token');
    }
  });

  it('names exactly two Graph calls in its own source, both on the object\'s id, and no status word', () => {
    const source = readFileSync(new URL('../src/meta-manage.ts', import.meta.url), 'utf8')
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('//'))
      .join('\n');
    const calls = [...source.matchAll(/\.call<[\s\S]*?>\(\s*'(GET|POST|PUT|PATCH|DELETE)',\s*([^,)]+)/g)].map((m) => [m[1], m[2]]);
    expect(calls).toEqual([
      ['POST', 'id'],
      ['GET', 'object.id'],
    ]);
    expect(source).not.toMatch(/'ACTIVE'|'PAUSED'|'ARCHIVED'|DELETE|revoke|createC|createA|me\/permissions/);
  });

  it('is what the frozen view carries to Meta: a budget of a campaign is refused by the view before it reaches the manager', async () => {
    const { m, calls } = manager([]);
    const view = managerOf(m);
    expect((await rejection(view.setBudget(SECRET, { level: 'campaign', id: '120001' }, VND, '1000'))).code).toBe('LEVEL_NOT_MANAGEABLE');
    expect(calls).toHaveLength(0);
  });
});
