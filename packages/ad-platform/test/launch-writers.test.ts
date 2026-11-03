// SPDX-License-Identifier: AGPL-3.0-only
// What the launch job is given of a writer (W2-3, #2296): a frozen view with the calls of a launch and nothing else, the budget conversion that must never be
// off by a hundred, and the offline sandbox writer the launch tests run against (it creates, finds and pauses in memory, every object PAUSED, and can be told to
// fail between a create and its answer).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AdPlatformError, SandboxAdWriter, adLaunchWriters, launchWriterOf, sandboxAdWriter, sandboxWriteLogin } from '../src/index.ts';
import { META_BUDGET_CURRENCIES, metaMinorUnits } from '../src/meta-currency.ts';

const LOGIN = sandboxWriteLogin({ externalAccountId: 'sbxads-0001', currency: 'VND' });
const SECRET = LOGIN.secret as string;
const ACCOUNT = { externalAccountId: 'sbxads-0001', currency: 'VND' };
const TAG = 'ludy:0123456789';
const TARGETING = { countries: ['VN'], regions: [], ageMin: 18, ageMax: 65, gender: 'all' as const, interests: [] };
const rejection = async (promise: Promise<unknown>): Promise<AdPlatformError> => {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AdPlatformError);
  return error as AdPlatformError;
};

describe('the launch writers\' view', () => {
  const source = readFileSync(new URL('../src/launch-writers.ts', import.meta.url), 'utf8');

  it('is a frozen object with the calls of a launch and not one more: no revoke, no status change, whatever it is given', () => {
    const view = launchWriterOf(new SandboxAdWriter());
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.keys(view).sort()).toEqual(['capabilities', 'createAd', 'createAdSet', 'createCampaign', 'createCreative', 'findByTag', 'resolveTargeting', 'verify']);
    expect(Reflect.has(view, 'revokeToken')).toBe(false);
    expect(Reflect.has(view, 'setStatus')).toBe(false);
    expect(() => Object.assign(view, { setStatus: () => undefined })).toThrow();
    // A whole writer handed to it does not leak its other members.
    const full = launchWriterOf(new SandboxAdWriter() as never) as unknown as Record<string, unknown>;
    expect(full.objects).toBeUndefined();
    expect(full.inject).toBeUndefined();
  });

  it('names no other member of a writer in its source', () => {
    // The code, not the comments or the imports (which name the file `writer.ts`).
    const code = source.replace(/\/\/.*$/gm, '').replace(/^import .*$/gm, '');
    const named = new Set([...code.matchAll(/\bwriter\.(\w+)/g)].map((m) => m[1]));
    expect([...named].sort()).toEqual(['capabilities', 'createAd', 'createAdSet', 'createCampaign', 'createCreative', 'findByTag', 'resolveTargeting', 'verify']);
    expect(code).not.toMatch(/fetch|revokeToken|setStatus/);
  });

  it('builds the sandbox\'s writer for the sandbox and Meta\'s only when it is given the write app\'s secret, and each is frozen', () => {
    expect(Object.keys(adLaunchWriters({}))).toEqual([]);
    expect(Object.keys(adLaunchWriters({ sandbox: true }))).toEqual(['sandboxwrite_ads']);
    const both = adLaunchWriters({ sandbox: true, meta: { writeAppSecret: 'secret' } });
    expect(Object.keys(both).sort()).toEqual(['metawrite_ads', 'sandboxwrite_ads']);
    expect(Object.isFrozen(both)).toBe(true);
    expect(Object.isFrozen(both.metawrite_ads)).toBe(true);
    expect(both.metawrite_ads?.capabilities.objectives).toEqual(['traffic']);
    expect(both.sandboxwrite_ads?.capabilities.objectives).toEqual(['traffic', 'engagement', 'messenger']);
  });
});

describe('Meta\'s minor units', () => {
  it('multiplies by the currency\'s own offset, exactly, in text: dong by one, dollars by a hundred', () => {
    expect(META_BUDGET_CURRENCIES).toEqual(expect.arrayContaining(['VND', 'USD']));
    for (const [amount, currency, minor] of [
      ['100000', 'VND', '100000'],
      ['100000.00', 'VND', '100000'],
      ['12345678901', 'VND', '12345678901'],
      ['1', 'USD', '100'],
      ['19.99', 'USD', '1999'],
      ['0.01', 'USD', '1'],
      ['9999999999999.99', 'USD', '999999999999999'],
      ['500', 'JPY', '500'],
      ['500', 'EUR', '50000'],
    ] as const) {
      expect(metaMinorUnits(amount, currency), `${amount} ${currency}`).toBe(minor);
    }
  });

  it('never rounds, never guesses a currency, never lets a number in: a refusal says why', () => {
    for (const [amount, currency, code] of [
      ['0.5', 'VND', 'BUDGET_FRACTION'],
      ['100.01', 'JPY', 'BUDGET_FRACTION'],
      ['0', 'USD', 'BUDGET_INVALID'],
      ['0.00', 'USD', 'BUDGET_INVALID'],
      ['', 'USD', 'BUDGET_INVALID'],
      ['1.234', 'USD', 'BUDGET_INVALID'],
      ['10000000000000', 'VND', 'BUDGET_INVALID'],
      [' 5', 'USD', 'BUDGET_INVALID'],
      ['5', 'CHF', 'CURRENCY_UNSUPPORTED'],
      ['5', '__proto__', 'CURRENCY_UNSUPPORTED'],
      ['5', 'toString', 'CURRENCY_UNSUPPORTED'],
    ] as const) {
      let error: unknown;
      try {
        metaMinorUnits(amount, currency);
      } catch (e) {
        error = e;
      }
      expect(error, `${amount} ${currency}`).toMatchObject({ kind: 'bad_request', code });
    }
  });

  it('is the ledger\'s amount times the offset for any whole or two-place amount (a property over many amounts)', () => {
    let seed = 7;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
    for (let i = 0; i < 500; i += 1) {
      const whole = String((next() % 1_000_000_000) + 1);
      const cents = String(next() % 100).padStart(2, '0');
      expect(metaMinorUnits(whole, 'VND')).toBe(whole);
      expect(metaMinorUnits(`${whole}.${cents}`, 'USD')).toBe(BigInt(whole + cents).toString());
      expect(metaMinorUnits(whole, 'USD')).toBe(`${whole}00`);
    }
  });
});

describe('the sandbox writer', () => {
  const adSet = (campaignId: string) => ({ name: `Set ${TAG}`, campaignId, objective: 'traffic' as const, dailyBudget: '100000', startTime: 'a', endTime: 'b', targeting: TARGETING, pageId: '1' });

  it('creates a campaign, an ad set, a creative and an ad in memory, every one PAUSED, and finds them by their tag', async () => {
    const w = new SandboxAdWriter();
    const campaign = await w.createCampaign(SECRET, ACCOUNT, { name: `C ${TAG}`, objective: 'traffic' });
    const set = await w.createAdSet(SECRET, ACCOUNT, adSet(campaign.id));
    const creative = await w.createCreative(SECRET, ACCOUNT, { name: `Cr ${TAG}`, pageId: '1', linkUrl: 'https://example.com', headline: 'h', primaryText: 'p', callToAction: 'learn_more' });
    const ad = await w.createAd(SECRET, ACCOUNT, { name: `A ${TAG}`, adSetId: set.id, creativeId: creative.id });
    expect([...w.objects.values()].map((o) => [o.level, o.status])).toEqual([['campaign', 'paused'], ['ad_set', 'paused'], ['creative', 'paused'], ['ad', 'paused']]);
    expect(await w.findByTag(SECRET, ACCOUNT, 'ad', TAG)).toEqual([{ id: ad.id, name: `A ${TAG}` }]);
    expect(await w.findByTag(SECRET, ACCOUNT, 'campaign', 'ludy:ffffffffff')).toEqual([]);
    expect(w.received).toEqual(['campaign', 'ad_set', 'creative', 'ad']);
    // An object of another account is not found, and a parent that is not there is refused.
    expect(await w.findByTag(sandboxWriteLogin({ externalAccountId: 'sbxads-0002', currency: 'VND' }).secret as string, { externalAccountId: 'sbxads-0002', currency: 'VND' }, 'campaign', TAG)).toEqual([]);
    expect((await rejection(w.createAdSet(SECRET, ACCOUNT, adSet('nope')))).code).toBe('PARENT_NOT_FOUND');
  });

  it('pauses and archives what it made, and refuses any other status', async () => {
    const w = new SandboxAdWriter();
    const { id } = await w.createCampaign(SECRET, ACCOUNT, { name: `C ${TAG}`, objective: 'traffic' });
    await w.setStatus(SECRET, { level: 'campaign', id }, 'archived');
    expect(w.objects.get(id)?.status).toBe('archived');
    expect((await rejection(w.setStatus(SECRET, { level: 'campaign', id }, 'active' as never))).code).toBe('STATUS_REFUSED');
    expect(w.objects.get(id)?.status).toBe('archived');
  });

  it('can lose the answer of a create after the object was made, or fail it before: the two cases reconcile tells apart', async () => {
    const w = new SandboxAdWriter();
    w.inject({ level: 'campaign', when: 'after' });
    expect((await rejection(w.createCampaign(SECRET, ACCOUNT, { name: `C ${TAG}`, objective: 'traffic' }))).kind).toBe('transient');
    expect(await w.findByTag(SECRET, ACCOUNT, 'campaign', TAG)).toHaveLength(1);
    w.inject({ level: 'campaign', when: 'before', error: new AdPlatformError('bad_request', 'NOPE') });
    expect((await rejection(w.createCampaign(SECRET, ACCOUNT, { name: `D ${TAG}`, objective: 'traffic' }))).code).toBe('NOPE');
    expect(w.objects.size).toBe(1);
    // A fault is used up: the next call works.
    await w.createCampaign(SECRET, ACCOUNT, { name: `E ${TAG}`, objective: 'traffic' });
    expect(w.objects.size).toBe(2);
  });

  it('resolves a name to the same id every time and lists the names it was told it does not know', async () => {
    const w = new SandboxAdWriter({ unknownTargeting: ['Nowhere (VN)', 'Mystery'] });
    const query = { regions: [{ country: 'VN', name: 'Hà Nội' }, { country: 'VN', name: 'Nowhere' }], interests: ['Coffee', 'Mystery'] };
    const once = await w.resolveTargeting(SECRET, query);
    expect(once.unknown).toEqual(['Nowhere (VN)', 'Mystery']);
    expect(once.regions).toHaveLength(1);
    expect(once.interests).toHaveLength(1);
    expect(await w.resolveTargeting(SECRET, query)).toEqual(once);
  });

  it('refuses a token that is not this sandbox\'s or does not reach the account, as the platform does', async () => {
    const w = new SandboxAdWriter();
    expect((await rejection(w.createCampaign('not json', ACCOUNT, { name: `C ${TAG}`, objective: 'traffic' }))).kind).toBe('token_expired');
    expect((await rejection(w.createCampaign(SECRET, { externalAccountId: 'sbxads-9999', currency: 'VND' }, { name: `C ${TAG}`, objective: 'traffic' }))).kind).toBe('permission');
    expect(w.objects.size).toBe(0);
  });

  it('is the process\'s one offline writer in the shared export, with its own state apart from the tests\' instances', () => {
    expect(sandboxAdWriter).toBeInstanceOf(SandboxAdWriter);
    expect(new SandboxAdWriter().objects).not.toBe(sandboxAdWriter.objects);
  });
});
