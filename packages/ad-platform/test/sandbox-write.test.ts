// SPDX-License-Identifier: AGPL-3.0-only
// The offline sandbox of running ads (ADR-0043, #2294, W0b): the write connection's login, its own secret (never the reader's), and
// the verify that reaches no host. It is not an ad platform of the readers' registry.
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  AD_PLATFORM_PROVIDERS,
  AdPlatformError,
  SANDBOX_AMBIGUOUS_MARKER,
  SANDBOX_REJECT_MARKER,
  SANDBOX_UNKNOWN_MARKER,
  SANDBOX_WRITE_PROVIDER,
  SANDBOX_WRITE_SCOPES,
  SandboxAdWriter,
  adPlatforms,
  isAdPlatformProvider,
  sandboxAdPlatform,
  sandboxAdWriter,
  sandboxWriteLogin,
} from '../src/index.ts';

const READ_ACCOUNT = 'sbxads-0123456789abcdef';

describe('the sandbox ad writer', () => {
  it('logs in to the account of the read connection, with a secret of its own and the scopes that can run ads', () => {
    const login = sandboxWriteLogin({ externalAccountId: READ_ACCOUNT, currency: 'VND' });
    expect(login).toMatchObject({ provider: 'sandboxwrite_ads', externalAccountId: READ_ACCOUNT, scopes: ['ads_read', 'ads_management'], expiresAt: null });
    expect(SANDBOX_WRITE_PROVIDER).toBe('sandboxwrite_ads');
    expect(SANDBOX_WRITE_SCOPES).toEqual(['ads_read', 'ads_management']);
    expect(login.displayName).toBe('Sandbox ads VND (running ads)');
    const secret = JSON.parse(login.secret) as Record<string, unknown>;
    expect(Object.keys(secret).sort()).toEqual(['accessToken', 'accountId', 'currency']);
    expect(secret.accessToken).toMatch(/^sbxw_[A-Za-z0-9_-]{43}$/);
    expect(secret.accountId).toBe(READ_ACCOUNT);
    expect(secret.currency).toBe('VND');
    // A name of the caller's, and a new token each time.
    const again = sandboxWriteLogin({ externalAccountId: READ_ACCOUNT, currency: 'USD', displayName: 'Chạy quảng cáo thử' });
    expect(again.displayName).toBe('Chạy quảng cáo thử');
    expect(again.secret).not.toBe(login.secret);
  });

  it('refuses an account id or a currency it does not know, before it makes a token', () => {
    expect(() => sandboxWriteLogin({ externalAccountId: 'not an id!', currency: 'VND' })).toThrow('invalid account id');
    expect(() => sandboxWriteLogin({ externalAccountId: '', currency: 'VND' })).toThrow('invalid account id');
    // The currency of a read account is text from the database: any but the sandbox's two is refused.
    expect(() => sandboxWriteLogin({ externalAccountId: READ_ACCOUNT, currency: 'EUR' })).toThrow('unknown currency');
    expect(() => sandboxWriteLogin({ externalAccountId: READ_ACCOUNT, currency: 'vnd' })).toThrow('unknown currency');
  });

  it('says a token it made can run ads on its account, and opens nothing remote', async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('a host was reached');
    });
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const login = sandboxWriteLogin({ externalAccountId: READ_ACCOUNT, currency: 'USD' });
      expect(sandboxAdWriter.provider).toBe('sandboxwrite_ads');
      expect(await sandboxAdWriter.verify(login.secret, { externalAccountId: READ_ACCOUNT })).toEqual({ canRunAds: true, scopes: ['ads_read', 'ads_management'] });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('refuses the token of the reader, a garbled secret and one with a field missing, as a refused token', async () => {
    const reader = sandboxAdPlatform().connect({ displayName: 'a' });
    const refused = { kind: 'token_expired', code: 'BAD_SECRET' };
    // The reader's secret holds a `sbx_` token and a key, not this writer's token and account.
    await expect(sandboxAdWriter.verify(reader.secret, { externalAccountId: reader.externalAccountId })).rejects.toMatchObject(refused);
    await expect(sandboxAdWriter.verify('nope', { externalAccountId: READ_ACCOUNT })).rejects.toMatchObject(refused);
    const login = sandboxWriteLogin({ externalAccountId: READ_ACCOUNT, currency: 'VND' });
    const parsed = JSON.parse(login.secret) as Record<string, unknown>;
    for (const field of ['accessToken', 'accountId', 'currency']) {
      const rest = { ...parsed };
      delete rest[field];
      await expect(sandboxAdWriter.verify(JSON.stringify(rest), { externalAccountId: READ_ACCOUNT }), field).rejects.toMatchObject(refused);
    }
    // A reader's-looking token, and a token of the wrong length, are not this writer's.
    await expect(sandboxAdWriter.verify(JSON.stringify({ ...parsed, accessToken: `sbx_${'A'.repeat(43)}` }), { externalAccountId: READ_ACCOUNT })).rejects.toMatchObject(refused);
    await expect(sandboxAdWriter.verify(JSON.stringify({ ...parsed, accessToken: 'sbxw_short' }), { externalAccountId: READ_ACCOUNT })).rejects.toMatchObject(refused);
    await expect(sandboxAdWriter.verify(JSON.stringify({ ...parsed, currency: 'EUR' }), { externalAccountId: READ_ACCOUNT })).rejects.toMatchObject(refused);
    // The message names no part of the secret.
    await expect(sandboxAdWriter.verify(login.secret.replace('sbxw_', 'x'), { externalAccountId: READ_ACCOUNT })).rejects.toMatchObject({ message: 'ad platform error: token_expired BAD_SECRET' });
  });

  it('refuses an account the token was not made for, as a missing permission', async () => {
    const login = sandboxWriteLogin({ externalAccountId: READ_ACCOUNT, currency: 'VND' });
    await expect(sandboxAdWriter.verify(login.secret, { externalAccountId: 'sbxads-ffffffffffffffff' })).rejects.toMatchObject({ kind: 'permission', code: 'ACCOUNT_NOT_REACHED' });
  });

  it('revokes nothing at any platform (there is none), keeps to its own secret and reaches no host', async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('a host was reached');
    });
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const login = sandboxWriteLogin({ externalAccountId: READ_ACCOUNT, currency: 'VND' });
      expect(await sandboxAdWriter.revokeToken(login.secret)).toEqual({ how: 'sandbox' });
      // The reader's secret and a garbled one are refused as everywhere in this writer, so a wrong secret never counts as a revoke.
      const reader = sandboxAdPlatform().connect({ displayName: 'a' });
      await expect(sandboxAdWriter.revokeToken(reader.secret)).rejects.toMatchObject({ kind: 'token_expired', code: 'BAD_SECRET' });
      await expect(sandboxAdWriter.revokeToken('nope')).rejects.toMatchObject({ kind: 'token_expired', code: 'BAD_SECRET' });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('works next to the reader: the account id is the read connection\'s, and the reader never opens the writer\'s secret', async () => {
    const reader = sandboxAdPlatform();
    const read = reader.connect({ displayName: 'a', currency: 'USD' });
    const login = sandboxWriteLogin({ externalAccountId: read.externalAccountId, currency: 'USD' });
    expect(login.externalAccountId).toBe(read.externalAccountId);
    expect(await sandboxAdWriter.verify(login.secret, { externalAccountId: read.externalAccountId })).toMatchObject({ canRunAds: true });
    // The reader's own secret is unchanged by any of this, and the writer's is not one it accepts.
    await expect(reader.accounts(login.secret)).rejects.toThrow('invalid secret');
    await expect(reader.readDaily(login.secret, read.externalAccountId, { from: '2026-10-01', to: '2026-10-02' })).rejects.toThrow('invalid secret');
    expect(await reader.accounts(read.secret)).toEqual([{ externalAccountId: read.externalAccountId, displayName: 'Sandbox ads USD', currency: 'USD', timeZone: 'America/Los_Angeles' }]);
  });

  it('is not an ad platform of the readers\' registry', () => {
    expect(AD_PLATFORM_PROVIDERS).toEqual(['sandbox_ads', 'meta_ads']);
    expect(isAdPlatformProvider('sandboxwrite_ads')).toBe(false);
    expect(Object.keys(adPlatforms({ sandbox: true }))).toEqual(['sandbox_ads']);
  });

  it('reaches no host and writes nothing: its source names no network call', () => {
    const source = readFileSync(new URL('../src/sandbox-write.ts', import.meta.url), 'utf8');
    for (const network of ['fetch', 'http:', 'https:', 'node:net', 'node:http']) expect(source, network).not.toContain(network);
  });
});

// The sandbox as a platform that keeps its objects (W2): the launch's creating calls, the status changes, the read-back, the lookup by name and the
// faults that let the tests make it fail where a real platform does.
describe('the sandbox ad writer, as a platform that keeps its objects', () => {
  const login = sandboxWriteLogin({ externalAccountId: READ_ACCOUNT, currency: 'VND' });
  const account = { externalAccountId: READ_ACCOUNT };
  const targeting = { countries: ['VN'], regions: [], ageMin: 18, ageMax: 65, gender: 'all' as const, interests: [] };
  const T0 = new Date('2026-11-03T08:00:00Z');

  // One clock the test moves, and a writer that reads it.
  function fresh(reviewSeconds = 20) {
    const clock = { now: T0 };
    return { clock, writer: new SandboxAdWriter({ now: () => clock.now, reviewSeconds }) };
  }
  // The four creating calls of a launch, in order.
  async function make(writer: SandboxAdWriter, tag = '[ludy:aaaa1111]', message = 'Mời bạn ghé thử.') {
    const campaign = await writer.createCampaign(login.secret, account, { name: `Khai trương ${tag}`, objective: 'messenger' });
    const adSet = await writer.createAdSet(login.secret, account, {
      name: `Khai trương ${tag}`,
      campaignId: campaign.externalId,
      objective: 'engagement',
      pageId: '5551',
      dailyBudgetMinor: '100000',
      startTime: '2026-11-10T00:00:00+0700',
      endTime: '2026-11-17T00:00:00+0700',
      targeting,
    });
    const creative = await writer.createCreative(login.secret, account, { name: `Khai trương ${tag}:v1`, pageId: '5551', message, headline: 'Khai trương', linkUrl: null, callToAction: 'send_message' });
    const ad = await writer.createAd(login.secret, account, { name: `Khai trương ${tag}:v1`, adSetId: adSet.externalId, creativeId: creative.externalId });
    return { campaign: campaign.externalId, adSet: adSet.externalId, creative: creative.externalId, ad: ad.externalId };
  }

  it('makes every object PAUSED, and the sandbox runs all three objectives (no live check stands between it and an objective)', async () => {
    const { writer } = fresh();
    const ids = await make(writer);
    expect(Object.values(ids).every((id) => /^\d{12}$/.test(id))).toBe(true);
    expect(writer.objects().map((o) => [o.level, o.configured])).toEqual([
      ['campaign', 'PAUSED'],
      ['ad_set', 'PAUSED'],
      ['creative', 'PAUSED'],
      ['ad', 'PAUSED'],
    ]);
    const states = await writer.readObjects(login.secret, [
      { level: 'campaign', externalId: ids.campaign },
      { level: 'ad_set', externalId: ids.adSet },
      { level: 'ad', externalId: ids.ad },
    ]);
    expect(states.map((s) => [s.configuredStatus, s.effectiveStatus, s.reasons])).toEqual([
      ['PAUSED', 'PAUSED', []],
      ['PAUSED', 'PAUSED', []],
      ['PAUSED', 'PAUSED', []],
    ]);
  });

  it('delivers only when the whole chain is active: an ad shows in review, then active; a paused parent shows in its children', async () => {
    const { writer, clock } = fresh(20);
    const ids = await make(writer);
    const read = async () => (await writer.readObjects(login.secret, [{ level: 'ad', externalId: ids.ad }, { level: 'ad_set', externalId: ids.adSet }, { level: 'campaign', externalId: ids.campaign }])).map((s) => s.effectiveStatus);
    await writer.setStatus(login.secret, ids.ad, 'ACTIVE');
    await writer.setStatus(login.secret, ids.adSet, 'ACTIVE');
    // The campaign is still paused, which the children say.
    expect(await read()).toEqual(['CAMPAIGN_PAUSED', 'CAMPAIGN_PAUSED', 'PAUSED']);
    await writer.setStatus(login.secret, ids.campaign, 'ACTIVE');
    expect(await read()).toEqual(['PENDING_REVIEW', 'ACTIVE', 'ACTIVE']);
    clock.now = new Date(T0.getTime() + 21_000);
    expect(await read()).toEqual(['ACTIVE', 'ACTIVE', 'ACTIVE']);
    // Pausing the campaign stops what is inside it.
    await writer.setStatus(login.secret, ids.campaign, 'PAUSED');
    expect(await read()).toEqual(['CAMPAIGN_PAUSED', 'CAMPAIGN_PAUSED', 'PAUSED']);
  });

  it('rejects in review an ad whose text carries the marker, with a reason the screen can word', async () => {
    const { writer, clock } = fresh(0);
    const ids = await make(writer, '[ludy:bbbb2222]', `Ưu đãi ${SANDBOX_REJECT_MARKER}`);
    for (const id of [ids.ad, ids.adSet, ids.campaign]) await writer.setStatus(login.secret, id, 'ACTIVE');
    clock.now = new Date(T0.getTime() + 1_000);
    const [ad] = await writer.readObjects(login.secret, [{ level: 'ad', externalId: ids.ad }]);
    expect([ad?.effectiveStatus, ad?.reasons]).toEqual(['DISAPPROVED', ['sandbox_policy']]);
  });

  it('finds an object again by its exact name, so a call that lost its answer is reconciled and not repeated', async () => {
    const { writer } = fresh();
    writer.injectFault({ operation: 'createCampaign', when: 'after' });
    const lost = await writer.createCampaign(login.secret, account, { name: 'Khai trương [ludy:cccc3333]', objective: 'traffic' }).catch((e: unknown) => e);
    // The caller saw a network failure: it does not know whether the campaign exists.
    expect(lost).toMatchObject({ kind: 'transient', code: 'NETWORK' });
    const found = await writer.findByTag(login.secret, account, 'campaign', 'Khai trương [ludy:cccc3333]');
    expect(found).toMatchObject({ kind: 'found' });
    expect(writer.objects()).toHaveLength(1);
    // A call that failed before it made anything leaves nothing to find.
    writer.injectFault({ operation: 'createCampaign', when: 'before' });
    await expect(writer.createCampaign(login.secret, account, { name: 'Khác [ludy:dddd4444]', objective: 'traffic' })).rejects.toMatchObject({ kind: 'transient' });
    expect(await writer.findByTag(login.secret, account, 'campaign', 'Khác [ludy:dddd4444]')).toEqual({ kind: 'missing' });
    expect(writer.objects()).toHaveLength(1);
  });

  it('says unknowable when a blind retry made a duplicate, and is exact about the name and the level', async () => {
    const { writer } = fresh();
    const name = 'Khai trương [ludy:eeee5555]';
    await writer.createCampaign(login.secret, account, { name, objective: 'traffic' });
    await writer.createCampaign(login.secret, account, { name, objective: 'traffic' });
    expect(await writer.findByTag(login.secret, account, 'campaign', name)).toEqual({ kind: 'unknowable', reason: 'duplicates' });
    expect(await writer.findByTag(login.secret, account, 'campaign', `${name} `)).toEqual({ kind: 'missing' });
    expect(await writer.findByTag(login.secret, account, 'ad_set', name)).toEqual({ kind: 'missing' });
  });

  it('puts a fault on the calls asked for, as many times as asked, with the error asked for', async () => {
    const { writer } = fresh();
    writer.injectFault({ operation: 'createCampaign', when: 'before', times: 2, error: new AdPlatformError('rate_limited', '17', new Date('2026-11-03T09:00:00Z')) });
    for (let i = 0; i < 2; i++) await expect(writer.createCampaign(login.secret, account, { name: 'x', objective: 'traffic' })).rejects.toMatchObject({ kind: 'rate_limited', code: '17' });
    await expect(writer.createCampaign(login.secret, account, { name: 'x', objective: 'traffic' })).resolves.toMatchObject({ externalId: expect.stringMatching(/^\d{12}$/) });
    // A fault on one operation does not touch the others.
    writer.injectFault({ operation: 'setStatus', when: 'after' });
    const [campaign] = writer.objects();
    await expect(writer.setStatus(login.secret, campaign?.externalId ?? '', 'ACTIVE')).rejects.toMatchObject({ kind: 'transient' });
    // The status was set though the answer was lost: reading it back says so.
    expect((await writer.readObjects(login.secret, [{ level: 'campaign', externalId: campaign?.externalId ?? '' }]))[0]?.configuredStatus).toBe('ACTIVE');
  });

  it('changes a status to the one it has without a trace, and knows no object of another account or an unknown id', async () => {
    const { writer } = fresh();
    const { campaign } = await make(writer);
    await writer.setStatus(login.secret, campaign, 'PAUSED');
    expect(writer.objects()[0]?.activatedAt).toBeNull();
    await expect(writer.setStatus(login.secret, '999999999999', 'ACTIVE')).rejects.toMatchObject({ kind: 'bad_request', code: '100' });
    const other = sandboxWriteLogin({ externalAccountId: 'sbxads-ffffffffffffffff', currency: 'VND' });
    await expect(writer.setStatus(other.secret, campaign, 'ACTIVE')).rejects.toMatchObject({ kind: 'bad_request', code: '100' });
    expect(await writer.readObjects(other.secret, [{ level: 'campaign', externalId: campaign }])).toEqual([]);
    await expect(writer.createCampaign(other.secret, account, { name: 'x', objective: 'traffic' })).rejects.toMatchObject({ kind: 'permission', code: 'ACCOUNT_NOT_REACHED' });
    expect(await writer.readObjects(login.secret, [{ level: 'ad', externalId: campaign }])).toEqual([]);
  });

  it('pins names down as the real platform would: a marker makes a name unknown or ambiguous, the others get the same ids each time', async () => {
    const { writer } = fresh();
    const names = { interests: ['Coffee', `Tea ${SANDBOX_UNKNOWN_MARKER}`, `Fashion ${SANDBOX_AMBIGUOUS_MARKER}`], regions: [{ country: 'VN', region: 'Hà Nội' }, { country: 'VN', region: `Đà Lạt ${SANDBOX_UNKNOWN_MARKER}` }] };
    const first = await writer.resolveTargeting(login.secret, names);
    expect(first.interests.unknown).toEqual([`Tea ${SANDBOX_UNKNOWN_MARKER}`]);
    expect(first.interests.ambiguous).toEqual([`Fashion ${SANDBOX_AMBIGUOUS_MARKER}`]);
    expect(first.interests.resolved).toHaveLength(1);
    expect(first.regions.unknown).toEqual([`VN:Đà Lạt ${SANDBOX_UNKNOWN_MARKER}`]);
    expect(first.regions.resolved).toHaveLength(1);
    expect(await writer.resolveTargeting(login.secret, names)).toEqual(first);
  });

  it('refuses an ad set under a campaign it does not know, and a budget that is not whole units', async () => {
    const { writer } = fresh();
    await expect(writer.createAdSet(login.secret, account, { name: 'x', campaignId: '1', objective: 'traffic', pageId: '5551', dailyBudgetMinor: '100', startTime: 'a', endTime: 'b', targeting })).rejects.toMatchObject({ code: '100' });
    const { campaign } = await make(writer);
    await expect(writer.createAdSet(login.secret, account, { name: 'x', campaignId: campaign, objective: 'traffic', pageId: '5551', dailyBudgetMinor: '10.5', startTime: 'a', endTime: 'b', targeting })).rejects.toMatchObject({ code: 'BAD_BUDGET' });
  });
});
