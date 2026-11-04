// SPDX-License-Identifier: AGPL-3.0-only
// The activation of a launch's objects (ADR-0043 points 4 and 5, #2296, W2-4b): the frozen view the activation job is given has two calls and nothing else; the sandbox switches
// on the objects of one sandbox writer and can be made to fail between the change and its answer; Meta's adapter sends the status ACTIVE to one object id, reads it back, and
// names no other endpoint; and the one file that sends ACTIVE is that adapter.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Fetch } from '@crove/channel';
import { AdPlatformError, MetaAdActivator, SandboxAdActivator, SandboxAdWriter, activatorOf, adActivators, sandboxWriteLogin } from '../src/index.ts';

const ACCOUNT = 'sbxads-0123456789abcdef';
const ACCOUNT_REF = { externalAccountId: ACCOUNT, currency: 'VND' };
const secret = () => sandboxWriteLogin({ externalAccountId: ACCOUNT, currency: 'VND' }).secret;
const SECRET = JSON.stringify({ accessToken: 'write-token' });

async function launched(writer: SandboxAdWriter, s: string) {
  const campaign = await writer.createCampaign(s, ACCOUNT_REF, { name: 'Plan ludy:abcdef0123', objective: 'traffic' });
  const adSet = await writer.createAdSet(s, ACCOUNT_REF, {
    name: 'Plan ludy:abcdef0123 set',
    campaignId: campaign.id,
    objective: 'traffic',
    dailyBudget: '100000',
    startTime: '2026-11-05T00:00:00+0700',
    endTime: '2026-11-06T00:00:00+0700',
    targeting: { countries: ['VN'], regions: [], ageMin: 18, ageMax: 65, gender: 'all', interests: [] },
    pageId: '12345',
  });
  const creative = await writer.createCreative(s, ACCOUNT_REF, { name: 'Plan ludy:abcdef0123 creative 1', pageId: '12345', linkUrl: 'https://example.com', headline: 'h', primaryText: 'p', callToAction: 'learn_more' });
  const ad = await writer.createAd(s, ACCOUNT_REF, { name: 'Plan ludy:abcdef0123 ad 1', adSetId: adSet.id, creativeId: creative.id });
  return { campaign: campaign.id, adSet: adSet.id, creative: creative.id, ad: ad.id };
}

describe('the activation view', () => {
  it('has two methods, frozen, and nothing of the activator is reachable through it', () => {
    const view = activatorOf(new SandboxAdActivator(new SandboxAdWriter()));
    expect(Object.getOwnPropertyNames(view).sort()).toEqual(['activate', 'readStatus']);
    expect(Object.getPrototypeOf(view)).toBe(Object.prototype);
    expect(Object.isFrozen(view)).toBe(true);
    expect((view as unknown as Record<string, unknown>).changes).toBeUndefined();
  });

  it('refuses a level that has no status of its own before any adapter is reached', async () => {
    const writer = new SandboxAdWriter();
    const view = activatorOf(new SandboxAdActivator(writer));
    const made = await launched(writer, secret());
    const refused = await view.activate(secret(), { level: 'creative' as never, id: made.creative }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(AdPlatformError);
    expect((refused as AdPlatformError).code).toBe('LEVEL_NOT_ACTIVATABLE');
    expect(writer.objects.get(made.creative)?.status).toBe('paused');
  });

  it('is built per provider, apart from the launch writers, and Meta\'s only when the deployment gave it the secret', () => {
    expect(Object.keys(adActivators({ sandbox: true }))).toEqual(['sandboxwrite_ads']);
    expect(Object.keys(adActivators({}))).toEqual([]);
    expect(Object.keys(adActivators({ meta: { writeAppSecret: 'secret' } }))).toEqual(['metawrite_ads']);
    expect(Object.isFrozen(adActivators({ sandbox: true }))).toBe(true);
  });
});

describe('the sandbox activation', () => {
  it('switches on an object of its writer, reads it back, and leaves the others as they are', async () => {
    const writer = new SandboxAdWriter();
    const s = secret();
    const made = await launched(writer, s);
    const activator = new SandboxAdActivator(writer);
    expect(await activator.readStatus(s, { level: 'campaign', id: made.campaign })).toEqual({ status: 'paused' });
    await activator.activate(s, { level: 'ad', id: made.ad });
    expect(await activator.readStatus(s, { level: 'ad', id: made.ad })).toEqual({ status: 'active' });
    expect(writer.objects.get(made.campaign)?.status).toBe('paused');
    expect(activator.changes).toEqual([{ level: 'ad', id: made.ad }]);
    // Idempotent, and a pause by the writer is seen.
    await activator.activate(s, { level: 'ad', id: made.ad });
    await writer.setStatus(s, { level: 'ad', id: made.ad }, 'paused');
    expect(await activator.readStatus(s, { level: 'ad', id: made.ad })).toEqual({ status: 'paused' });
  });

  it('refuses an object it does not hold, an object of another level, and a secret that is not its own', async () => {
    const writer = new SandboxAdWriter();
    const s = secret();
    const made = await launched(writer, s);
    const activator = new SandboxAdActivator(writer);
    await expect(activator.activate(s, { level: 'ad', id: 'nope' })).rejects.toMatchObject({ kind: 'bad_request', code: 'OBJECT_NOT_FOUND' });
    await expect(activator.activate(s, { level: 'campaign', id: made.ad })).rejects.toMatchObject({ kind: 'bad_request', code: 'OBJECT_NOT_FOUND' });
    await expect(activator.activate('{"accessToken":"x"}', { level: 'ad', id: made.ad })).rejects.toMatchObject({ kind: 'token_expired' });
    expect(writer.objects.get(made.ad)?.status).toBe('paused');
  });

  it('can be told to fail before the change, after it (the answer is lost) and on the read', async () => {
    const writer = new SandboxAdWriter();
    const s = secret();
    const made = await launched(writer, s);
    const activator = new SandboxAdActivator(writer);
    writer.inject({ level: 'ad', when: 'status' });
    await expect(activator.activate(s, { level: 'ad', id: made.ad })).rejects.toBeInstanceOf(AdPlatformError);
    expect(writer.objects.get(made.ad)?.status).toBe('paused');
    writer.inject({ level: 'ad', when: 'status_after' });
    await expect(activator.activate(s, { level: 'ad', id: made.ad })).rejects.toBeInstanceOf(AdPlatformError);
    expect(writer.objects.get(made.ad)?.status).toBe('active');
    writer.inject({ level: 'ad', when: 'read' });
    await expect(activator.readStatus(s, { level: 'ad', id: made.ad })).rejects.toBeInstanceOf(AdPlatformError);
    expect(await activator.readStatus(s, { level: 'ad', id: made.ad })).toEqual({ status: 'active' });
  });
});

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
const meta = (answers: Array<{ status?: number; body: unknown } | Error>) => {
  const { fetch, calls } = recorded(answers);
  return { activator: new MetaAdActivator({ appSecret: 'app-secret', graphVersion: 'v24.0', fetch, now: () => new Date('2026-11-05T00:00:00Z') }), calls };
};

describe('the Meta activation', () => {
  it('posts the status ACTIVE to one object id with the token, and reads the status back', async () => {
    const { activator, calls } = meta([{ body: { success: true } }, { body: { status: 'ACTIVE', id: '120001' } }, { body: { status: 'PAUSED' } }, { body: { status: 'DELETED' } }]);
    await activator.activate(SECRET, { level: 'campaign', id: '120001' });
    expect(calls[0]).toMatchObject({ method: 'POST' });
    expect(calls[0]?.url.pathname).toMatch(/\/v24\.0\/120001$/);
    expect(calls[0]?.form?.get('status')).toBe('ACTIVE');
    expect(await activator.readStatus(SECRET, { level: 'campaign', id: '120001' })).toEqual({ status: 'active' });
    expect(calls[1]).toMatchObject({ method: 'GET' });
    expect(calls[1]?.url.searchParams.get('fields')).toBe('status');
    expect(await activator.readStatus(SECRET, { level: 'ad', id: '120002' })).toEqual({ status: 'paused' });
    expect(await activator.readStatus(SECRET, { level: 'ad', id: '120003' })).toEqual({ status: 'other' });
  });

  it('refuses an id that is not a platform id and an answer that does not say it changed, before or after the request', async () => {
    const { activator, calls } = meta([{ body: { success: false } }]);
    await expect(activator.activate(SECRET, { level: 'ad', id: '12/../3' })).rejects.toMatchObject({ kind: 'bad_request', code: 'BAD_OBJECT' });
    await expect(activator.readStatus(SECRET, { level: 'ad', id: 'x' })).rejects.toMatchObject({ kind: 'bad_request', code: 'BAD_OBJECT' });
    expect(calls).toHaveLength(0);
    await expect(activator.activate(SECRET, { level: 'ad', id: '120001' })).rejects.toMatchObject({ kind: 'unknown', code: 'NOT_CHANGED' });
    await expect(activator.activate('not json', { level: 'ad', id: '120001' })).rejects.toMatchObject({ code: 'BAD_SECRET' });
  });

  it('names exactly two Graph calls and sends the status ACTIVE once, in this file', () => {
    const source = readFileSync(new URL('../src/meta-activate.ts', import.meta.url), 'utf8')
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('//'))
      .join('\n');
    const calls = [...source.matchAll(/\.call<[\s\S]*?>\(\s*'(GET|POST|PUT|PATCH|DELETE)',\s*([^,)]+)/g)].map((m) => [m[1], m[2]]);
    expect(calls).toEqual([
      ['POST', 'object.id'],
      ['GET', 'object.id'],
    ]);
    expect([...source.matchAll(/'ACTIVE'/g)]).toHaveLength(2);
    expect(source).not.toMatch(/PAUSED'\s*\}|ARCHIVED'\s*\}|DELETE|revoke|createC|createA/);
  });
});
