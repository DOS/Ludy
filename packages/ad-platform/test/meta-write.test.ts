// SPDX-License-Identifier: AGPL-3.0-only
// The writer of Meta ads (ADR-0043, #2296, W2-1) against recorded answers: what `verify` reads, how `revokeToken` removes the permissions at Meta and
// what each answer of Meta means for it, and the pin on what the writer can do at all: its own methods, every endpoint its source names, the host,
// and the token in a header and never in a URL. The recorded answers are written from Meta's documentation (the live check records what Meta really
// answers, plan docs/plan/ads-write.md section 5.2), so these prove the shape of the code, not Meta's behaviour.
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Fetch } from '@crove/channel';
import { AdPlatformError, MetaAdWriter, META_WRITE_PROVIDER } from '../src/index.ts';

const NOW = new Date('2026-11-03T08:00:00Z');
const APP_SECRET = 'app-secret';
const SECRET = JSON.stringify({ accessToken: 'write-token' });

interface Call {
  method: string;
  url: URL;
  authorization: string | null;
}

// A fetch that answers from a list of recorded answers, in order, and remembers each request. An answer may be an error thrown by fetch itself.
function recorded(answers: Array<{ status?: number; body: unknown } | Error>): { fetch: Fetch; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const fetch: Fetch = async (input, init) => {
    calls.push({ method: init?.method ?? 'GET', url: new URL(input), authorization: new Headers(init?.headers).get('authorization') });
    const next = answers[i++];
    if (!next) throw new Error(`no recorded answer for ${input}`);
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, calls };
}

const writer = (answers: Array<{ status?: number; body: unknown } | Error>) => {
  const { fetch, calls } = recorded(answers);
  return { writer: new MetaAdWriter({ appSecret: APP_SECRET, graphVersion: 'v24.0', fetch, now: () => NOW }), calls };
};
const metaError = (status: number, code: number, subcode?: number) => ({ status, body: { error: { message: 'Meta text', type: 'OAuthException', code, ...(subcode === undefined ? {} : { error_subcode: subcode }) } } });
const rejection = async (promise: Promise<unknown>): Promise<AdPlatformError> => {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AdPlatformError);
  return error as AdPlatformError;
};

describe('MetaAdWriter.revokeToken', () => {
  it('removes the app\'s permissions with one DELETE to me/permissions, the token in the header and the proof of the app secret', async () => {
    const { writer: w, calls } = writer([{ body: { success: true } }]);
    expect(await w.revokeToken(SECRET)).toEqual({ how: 'revoked' });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.method).toBe('DELETE');
    expect(call?.url.origin).toBe('https://graph.facebook.com');
    expect(call?.url.pathname).toBe('/v24.0/me/permissions');
    expect(call?.authorization).toBe('Bearer write-token');
    expect(call?.url.searchParams.get('appsecret_proof')).toBe(createHmac('sha256', APP_SECRET).update('write-token').digest('hex'));
    // The token is in no URL.
    expect(call?.url.toString()).not.toContain('write-token');
  });

  it('counts a token Meta no longer accepts as revoked: nothing is left to revoke with it', async () => {
    for (const body of [metaError(400, 190), metaError(400, 190, 463), metaError(400, 102), metaError(400, 190, 460), metaError(400, 190, 467)]) {
      const { writer: w } = writer([body]);
      expect(await w.revokeToken(SECRET)).toEqual({ how: 'already_invalid' });
    }
  });

  it('is never done on an answer that does not say success', async () => {
    const error = await rejection(writer([{ body: { success: false } }]).writer.revokeToken(SECRET));
    expect([error.kind, error.code]).toEqual(['unknown', 'NOT_REVOKED']);
    const none = await rejection(writer([{ body: {} }]).writer.revokeToken(SECRET));
    expect([none.kind, none.code]).toEqual(['unknown', 'NOT_REVOKED']);
  });

  it('says in the error\'s kind what the caller does next: wait (with the time), try again, or a person looks', async () => {
    const hourly = await rejection(writer([metaError(400, 4)]).writer.revokeToken(SECRET));
    expect([hourly.kind, hourly.retryAt?.toISOString()]).toEqual(['rate_limited', '2026-11-03T09:00:00.000Z']);
    const score = await rejection(writer([metaError(400, 17)]).writer.revokeToken(SECRET));
    expect([score.kind, score.retryAt?.toISOString()]).toEqual(['rate_limited', '2026-11-03T08:10:00.000Z']);
    expect((await rejection(writer([metaError(500, 2)]).writer.revokeToken(SECRET))).kind).toBe('transient');
    expect((await rejection(writer([metaError(403, 200)]).writer.revokeToken(SECRET))).kind).toBe('permission');
    expect((await rejection(writer([metaError(400, 100)]).writer.revokeToken(SECRET))).kind).toBe('bad_request');
    const network = await rejection(writer([Object.assign(new Error('aborted'), { name: 'AbortError' })]).writer.revokeToken(SECRET));
    expect([network.kind, network.code]).toEqual(['transient', 'NETWORK']);
  });

  it('refuses a secret that holds no token, without calling Meta', async () => {
    for (const secret of ['not json', '{}', JSON.stringify({ accessToken: '' }), JSON.stringify({ accessToken: 5 })]) {
      const { writer: w, calls } = writer([]);
      const error = await rejection(w.revokeToken(secret));
      expect([error.kind, error.code]).toEqual(['unknown', 'BAD_SECRET']);
      expect(calls).toHaveLength(0);
    }
  });
});

describe('MetaAdWriter.verify', () => {
  const permissions = (...pairs: Array<[string, string]>) => ({ body: { data: pairs.map(([permission, status]) => ({ permission, status })) } });

  it('reads the permissions the token holds now and the account itself, and changes nothing', async () => {
    const { writer: w, calls } = writer([permissions(['ads_read', 'granted'], ['ads_management', 'granted'], ['public_profile', 'granted']), { body: { id: 'act_1001' } }]);
    expect(await w.verify(SECRET, { externalAccountId: 'act_1001' })).toEqual({ canRunAds: true, scopes: ['ads_management', 'ads_read', 'public_profile'] });
    expect(calls.map((c) => [c.method, c.url.pathname])).toEqual([
      ['GET', '/v24.0/me/permissions'],
      ['GET', '/v24.0/act_1001'],
    ]);
    expect(calls.every((c) => c.authorization === 'Bearer write-token' && !c.url.toString().includes('write-token'))).toBe(true);
  });

  it('says a token cannot run ads when a permission is missing or was declined, without reading the account', async () => {
    const { writer: w, calls } = writer([permissions(['ads_read', 'granted'], ['ads_management', 'declined'])]);
    expect(await w.verify(SECRET, { externalAccountId: 'act_1001' })).toEqual({ canRunAds: false, scopes: ['ads_read'] });
    expect(calls).toHaveLength(1);
  });

  it('refuses an account the token does not reach, as Meta says it', async () => {
    const { writer: w } = writer([permissions(['ads_read', 'granted'], ['ads_management', 'granted']), metaError(403, 200)]);
    expect((await rejection(w.verify(SECRET, { externalAccountId: 'act_1001' }))).kind).toBe('permission');
  });

  it('refuses an account id that is not one, without calling Meta', async () => {
    const { writer: w, calls } = writer([]);
    const error = await rejection(w.verify(SECRET, { externalAccountId: '1001/../me' }));
    expect([error.kind, error.code]).toEqual(['bad_request', 'BAD_ACCOUNT']);
    expect(calls).toHaveLength(0);
  });
});

describe('what the writer can do at all', () => {
  const source = readFileSync(new URL('../src/meta-write.ts', import.meta.url), 'utf8');

  it('is the write provider\'s writer, and has exactly the methods of this slice: no delete of any ad object', () => {
    expect(new MetaAdWriter({ appSecret: APP_SECRET }).provider).toBe(META_WRITE_PROVIDER);
    // Each method is a capability: a new one is added here on purpose, with the live check that confirmed it.
    expect(Object.getOwnPropertyNames(MetaAdWriter.prototype).sort()).toEqual(['constructor', 'revokeToken', 'verify']);
    expect(source).not.toMatch(/\b(delete|remove|archive)[A-Z]\w*\s*\(/);
  });

  it('names exactly the Graph endpoints of this slice: two GETs to read and one DELETE to revoke', () => {
    const calls = [...source.matchAll(/\.call<[\s\S]*?>\(\s*'(GET|POST|PUT|PATCH|DELETE)',\s*([^,)]+)/g)].map((m) => [m[1], m[2]]);
    expect(calls).toEqual([
      ['GET', "'me/permissions'"],
      ['GET', 'account.externalAccountId'],
      ['DELETE', "'me/permissions'"],
    ]);
    // Nothing is sent as a form or a file, and no other method is spelled.
    expect(source).not.toMatch(/'(POST|PUT|PATCH)'|form:|multipart/);
  });

  it('keeps every request on graph.facebook.com over https', async () => {
    const { writer: w, calls } = writer([{ body: { success: true } }, { body: { data: [{ permission: 'ads_read', status: 'granted' }, { permission: 'ads_management', status: 'granted' }] } }, { body: { id: 'act_1' } }]);
    await w.revokeToken(SECRET);
    await w.verify(SECRET, { externalAccountId: 'act_1' });
    expect(calls.every((c) => c.url.protocol === 'https:' && c.url.host === 'graph.facebook.com' && c.url.username === '' && c.url.password === '')).toBe(true);
  });
});
