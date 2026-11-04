// SPDX-License-Identifier: AGPL-3.0-only
// The pause of what a stopped launch made (ADR-0043 points 4 and 7a, #2296, W2-4a): the narrowed view the pause job is given has one call, which finds the objects
// that carry the launch's tag and sets them PAUSED (and the objects Ludy recorded), campaign first; a level whose list cannot be read in full (a page past the
// first) is reported as not listed; and the source names no call of a writer but `findByTag` and `setStatus`, and no status but paused.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Fetch } from '@crove/channel';
import { AdPlatformError, MetaAdWriter, SandboxAdWriter, adPausers, pauserOf, sandboxWriteLogin } from '../src/index.ts';

const ACCOUNT = 'sbxads-0123456789abcdef';
const ACCOUNT_REF = { externalAccountId: ACCOUNT, currency: 'VND' };
const secret = () => sandboxWriteLogin({ externalAccountId: ACCOUNT, currency: 'VND' }).secret;
const TAG = 'ludy:abcdef0123';
const OTHER_TAG = 'ludy:ffffffffff';

// A launch's worth of objects in a sandbox writer: the campaign, the ad set, a creative and an ad, every one carrying the tag in its name.
async function launched(writer: SandboxAdWriter, s: string, tag = TAG) {
  const campaign = await writer.createCampaign(s, ACCOUNT_REF, { name: `Plan ${tag}`, objective: 'traffic' });
  const adSet = await writer.createAdSet(s, ACCOUNT_REF, {
    name: `Plan ${tag} set`,
    campaignId: campaign.id,
    objective: 'traffic',
    dailyBudget: '100000',
    startTime: '2026-11-05T00:00:00+0700',
    endTime: '2026-11-06T00:00:00+0700',
    targeting: { countries: ['VN'], regions: [], ageMin: 18, ageMax: 65, gender: 'all', interests: [] },
    pageId: '12345',
  });
  const creative = await writer.createCreative(s, ACCOUNT_REF, { name: `Plan ${tag} creative 1`, pageId: '12345', linkUrl: 'https://example.com', headline: 'h', primaryText: 'p', callToAction: 'learn_more' });
  const ad = await writer.createAd(s, ACCOUNT_REF, { name: `Plan ${tag} ad 1`, adSetId: adSet.id, creativeId: creative.id });
  return { campaign: campaign.id, adSet: adSet.id, creative: creative.id, ad: ad.id };
}

describe('the pause view of a writer', () => {
  it('has the one method, frozen, and nothing of the writer is reachable through it', () => {
    const writer = new SandboxAdWriter();
    const view = pauserOf(writer);
    expect(Object.getOwnPropertyNames(view)).toEqual(['pauseLaunch']);
    expect(Object.getPrototypeOf(view)).toBe(Object.prototype);
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(adPausers({ sandbox: true }))).toBe(true);
    for (const name of ['verify', 'revokeToken', 'createCampaign', 'createAdSet', 'createCreative', 'createAd', 'setStatus', 'findByTag', 'resolveTargeting', 'activate']) {
      expect(name in view).toBe(false);
    }
  });

  it('has the sandbox pauser only when the sandbox is on, and Meta only with its write secret', () => {
    expect(adPausers({})).toEqual({});
    expect(adPausers({ sandbox: false })).toEqual({});
    expect(Object.keys(adPausers({ sandbox: true }))).toEqual(['sandboxwrite_ads']);
    expect(Object.keys(adPausers({ meta: { writeAppSecret: 'w'.repeat(32) } }))).toEqual(['metawrite_ads']);
    expect(Object.keys(adPausers({ sandbox: true, meta: { writeAppSecret: 'w'.repeat(32) } })).sort()).toEqual(['metawrite_ads', 'sandboxwrite_ads']);
  });

  it('names no member of a writer but findByTag and setStatus, no status but paused, and reaches no network by itself', () => {
    const source = readFileSync(new URL('../src/pausers.ts', import.meta.url), 'utf8');
    const code = source
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('import '))
      .join('\n');
    const members = [...new Set([...code.matchAll(/\bwriter\.([A-Za-z_]\w*)/g)].map((m) => m[1]))].sort();
    expect(members).toEqual(['findByTag', 'setStatus']);
    // The only status it can set is paused; nothing in it says active, archived or any way to un-pause.
    expect([...code.matchAll(/'paused'|'archived'|'active'|\bACTIVE\b|\bPAUSED\b|\bARCHIVED\b/g)].map((m) => m[0])).toEqual(["'paused'"]);
    expect(code).not.toMatch(/\bfetch\b|\bhttps?:\/\//);
    expect(code).not.toMatch(/\b(activate|unpause|resume)\w*\s*\(/i);
  });
});

describe('pausing what a launch made', () => {
  it('pauses the campaign first, then the ad set, then the ad, and leaves the creative (it has no status) and another launch alone', async () => {
    const writer = new SandboxAdWriter();
    const s = secret();
    const mine = await launched(writer, s);
    const other = await launched(writer, s, OTHER_TAG);
    const out = await pauserOf(writer).pauseLaunch(s, ACCOUNT_REF, { tag: TAG, known: [] });
    expect(out.listed).toEqual({ campaign: { ok: true }, ad_set: { ok: true }, ad: { ok: true } });
    expect(writer.statusCalls.map((c) => [c.level, c.id])).toEqual([['campaign', mine.campaign], ['ad_set', mine.adSet], ['ad', mine.ad]]);
    expect(out.paused).toEqual([{ level: 'campaign', id: mine.campaign }, { level: 'ad_set', id: mine.adSet }, { level: 'ad', id: mine.ad }]);
    expect(out.failed).toEqual([]);
    expect(out.notTried).toBe(0);
    expect(out.tokenRefused).toBe(false);
    // What the tag found is reported, with the name each carries, so the caller can record what it had not.
    expect(out.found.map((o) => [o.level, o.id, o.name.includes(TAG)])).toEqual([['campaign', mine.campaign, true], ['ad_set', mine.adSet, true], ['ad', mine.ad, true]]);
    // The other launch's objects were not touched, and nothing was created.
    expect(writer.statusCalls.some((c) => [other.campaign, other.adSet, other.ad, mine.creative, other.creative].includes(c.id))).toBe(false);
    expect(writer.received).toEqual(['campaign', 'ad_set', 'creative', 'ad', 'campaign', 'ad_set', 'creative', 'ad']);
  });

  it('pauses an object Ludy recorded even when the platform’s list does not show it, once', async () => {
    const writer = new SandboxAdWriter();
    const s = secret();
    const mine = await launched(writer, s);
    // The list of the ad level fails: the recorded ad is still paused, the level is reported as not listed, and the run is not complete.
    writer.inject({ level: 'ad', when: 'find' });
    const out = await pauserOf(writer).pauseLaunch(s, ACCOUNT_REF, { tag: TAG, known: [{ level: 'ad', id: mine.ad }, { level: 'campaign', id: mine.campaign }] });
    expect(out.listed.ad).toEqual({ ok: false, kind: 'unknown', code: 'PAGED_ANSWER' });
    expect(out.listed.campaign).toEqual({ ok: true });
    // The campaign is both recorded and found: paused once.
    expect(out.paused.filter((p) => p.id === mine.campaign)).toHaveLength(1);
    expect(out.paused.map((p) => p.id)).toEqual([mine.campaign, mine.adSet, mine.ad]);
    expect(out.found.map((o) => o.level)).toEqual(['campaign', 'ad_set']);
  });

  it('reports a refusal of one object and goes on with the others', async () => {
    const writer = new SandboxAdWriter();
    const s = secret();
    const mine = await launched(writer, s);
    writer.inject({ level: 'ad_set', when: 'status', error: new AdPlatformError('bad_request', 'OBJECT_GONE') });
    const out = await pauserOf(writer).pauseLaunch(s, ACCOUNT_REF, { tag: TAG, known: [] });
    expect(out.failed).toEqual([{ level: 'ad_set', id: mine.adSet, kind: 'bad_request', code: 'OBJECT_GONE' }]);
    expect(out.paused.map((p) => p.id)).toEqual([mine.campaign, mine.ad]);
    expect(out.notTried).toBe(0);
  });

  it('stops at a refused token: nothing more is tried and the token is reported refused', async () => {
    const writer = new SandboxAdWriter();
    const s = secret();
    const mine = await launched(writer, s);
    writer.inject({ level: 'campaign', when: 'status', error: new AdPlatformError('token_expired', 'TOKEN') });
    const out = await pauserOf(writer).pauseLaunch(s, ACCOUNT_REF, { tag: TAG, known: [] });
    expect(out.tokenRefused).toBe(true);
    expect(out.failed).toEqual([{ level: 'campaign', id: mine.campaign, kind: 'token_expired', code: 'TOKEN' }]);
    expect(out.paused).toEqual([]);
    expect(out.notTried).toBe(2);
  });

  it('stops at a rate limit, reports when to ask again, and does not ask again now', async () => {
    const writer = new SandboxAdWriter();
    const s = secret();
    await launched(writer, s);
    const retryAt = new Date('2026-11-05T10:00:00Z');
    writer.inject({ level: 'campaign', when: 'status', error: new AdPlatformError('rate_limited', 'LIMIT', retryAt) });
    const out = await pauserOf(writer).pauseLaunch(s, ACCOUNT_REF, { tag: TAG, known: [] });
    expect(out.retryAt).toEqual(retryAt);
    expect(out.tokenRefused).toBe(false);
    expect(out.notTried).toBe(2);
    expect(out.paused).toEqual([]);
  });

  it('never throws a platform error: a refused list is a result, and a token that does not reach the account is too', async () => {
    const writer = new SandboxAdWriter();
    const out = await pauserOf(writer).pauseLaunch(secret(), { externalAccountId: 'sbxads-other', currency: 'VND' }, { tag: TAG, known: [] });
    expect(out.listed.campaign).toEqual({ ok: false, kind: 'permission', code: 'ACCOUNT_NOT_REACHED' });
    expect(out.paused).toEqual([]);
  });
});

describe('the pause at Meta', () => {
  const metaSecret = JSON.stringify({ accessToken: 'EAAB-token' });
  const answers = (list: unknown) => {
    const calls: Array<{ method: string; url: string; body: string }> = [];
    const fetcher: Fetch = async (input, init) => {
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : '';
      calls.push({ method, url: input, body });
      return new Response(JSON.stringify(method === 'GET' ? list : { success: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    return { fetcher, calls };
  };

  it('finds by the tag with GETs and sets PAUSED by one POST to the object, and nothing else', async () => {
    const { fetcher, calls } = answers({ data: [{ id: '120001', name: `Plan ${TAG}` }] });
    const meta = new MetaAdWriter({ appSecret: 'write-app-secret', fetch: fetcher });
    const out = await pauserOf(meta).pauseLaunch(metaSecret, { externalAccountId: 'act_123', currency: 'VND' }, { tag: TAG, known: [] });
    // One id answers every list, so it is found at each level and paused at each: a GET and a POST per level, campaign first.
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(3);
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(3);
    for (const post of posts) {
      expect(new URL(post.url).pathname.endsWith('/120001')).toBe(true);
      expect(post.body).toContain('status=PAUSED');
      expect(post.body).not.toMatch(/ACTIVE|ARCHIVED|DELETED/);
    }
    expect(out.failed).toEqual([]);
    expect(out.paused).toHaveLength(3);
  });

  it('treats an answer with a next page as unknowable, never as the whole list', async () => {
    const { fetcher } = answers({ data: [{ id: '120001', name: `Plan ${TAG}` }], paging: { cursors: { after: 'x' }, next: 'https://graph.facebook.com/next' } });
    const meta = new MetaAdWriter({ appSecret: 'write-app-secret', fetch: fetcher });
    await expect(meta.findByTag(metaSecret, { externalAccountId: 'act_123', currency: 'VND' }, 'campaign', TAG)).rejects.toMatchObject({ kind: 'unknown', code: 'PAGED_ANSWER' });
    // And a list that has cursors but no next page is the whole answer.
    const whole = answers({ data: [{ id: '120001', name: `Plan ${TAG}` }], paging: { cursors: { after: 'x', before: 'y' } } });
    const full = new MetaAdWriter({ appSecret: 'write-app-secret', fetch: whole.fetcher });
    await expect(full.findByTag(metaSecret, { externalAccountId: 'act_123', currency: 'VND' }, 'campaign', TAG)).resolves.toEqual([{ id: '120001', name: `Plan ${TAG}` }]);
  });
});
