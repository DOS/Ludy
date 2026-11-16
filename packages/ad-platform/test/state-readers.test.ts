// SPDX-License-Identifier: AGPL-3.0-only
// The read of the platform's object states (issue #3301): the frozen view the state job is given has one call and nothing else; it stops at a refused token or a rate limit and
// reports each failure by kind and code only; it lets through only a status and a reason code that fit what the database stores; Meta's adapter sends one GET per object with
// the token in the header and turns the platform's feedback into short codes (never its words); and the sandbox answers from the objects of its writer.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Fetch } from '@crove/channel';
import { MetaAdStateReader, metaReasonOf } from '../src/meta-state.ts';
import { AdPlatformError, SandboxAdStateReader, SandboxAdWriter, adStateReaders, sandboxWriteLogin, stateReaderOf, type AdObjectStateSource, type StateTarget } from '../src/index.ts';

const ACCOUNT = 'sbxads-0123456789abcdef';
const SECRET = JSON.stringify({ accessToken: 'write-token' });
const secretOf = () => sandboxWriteLogin({ externalAccountId: ACCOUNT, currency: 'VND' }).secret;

describe('the state view', () => {
  it('has one method, frozen, and nothing of the source is reachable through it', () => {
    const view = stateReaderOf(new SandboxAdStateReader(new SandboxAdWriter()));
    expect(Object.getOwnPropertyNames(view)).toEqual(['readStates']);
    expect(Object.getPrototypeOf(view)).toBe(Object.prototype);
    expect(Object.isFrozen(view)).toBe(true);
    expect((view as unknown as Record<string, unknown>).reads).toBeUndefined();
  });

  it('is built per provider, apart from the writers, and Meta\'s only when the deployment gave it the secret', () => {
    expect(Object.keys(adStateReaders({ sandbox: true }))).toEqual(['sandboxwrite_ads']);
    expect(Object.keys(adStateReaders({}))).toEqual([]);
    expect(Object.keys(adStateReaders({ meta: { writeAppSecret: 'secret' } }))).toEqual(['metawrite_ads']);
    expect(Object.isFrozen(adStateReaders({ sandbox: true }))).toBe(true);
  });

  it('reads each object once, answers for a missing object, and refuses a level that has no status of its own without asking', async () => {
    const asked: StateTarget[] = [];
    const source: AdObjectStateSource = {
      async readState(_secret, object) {
        asked.push(object);
        return object.id === 'gone' ? null : { status: 'PAUSED', reason: null };
      },
    };
    const result = await stateReaderOf(source).readStates('s', [
      { level: 'ad', id: 'a1' },
      { level: 'ad', id: 'a1' },
      { level: 'ad_set', id: 'gone' },
      { level: 'creative' as never, id: 'c1' },
    ]);
    expect(asked).toEqual([
      { level: 'ad', id: 'a1' },
      { level: 'ad_set', id: 'gone' },
    ]);
    expect(result.states).toEqual([
      { id: 'a1', level: 'ad', found: true, status: 'PAUSED', reason: null },
      { id: 'gone', level: 'ad_set', found: false },
    ]);
    expect(result.failed).toEqual([{ id: 'c1', level: 'creative', kind: 'bad_request', code: 'LEVEL_NOT_READABLE' }]);
  });

  it('lets through only a status of upper-case words and a reason that is a short code', async () => {
    const answers: Record<string, { status: string; reason: string | null }> = {
      ok: { status: 'DISAPPROVED', reason: 'feedback_policy_x' },
      lower: { status: 'Disapproved', reason: null },
      long: { status: 'A'.repeat(41), reason: null },
      sentence: { status: 'DISAPPROVED', reason: 'Your ad broke a policy' },
      markup: { status: 'PAUSED', reason: '<script>x</script>' },
    };
    const result = await stateReaderOf({ readState: async (_s, o) => answers[o.id] ?? null }).readStates('s', Object.keys(answers).map((id) => ({ level: 'ad' as const, id })));
    expect(result.states).toEqual([{ id: 'ok', level: 'ad', found: true, status: 'DISAPPROVED', reason: 'feedback_policy_x' }]);
    expect(result.failed.map((f) => [f.id, f.kind, f.code])).toEqual([
      ['lower', 'unknown', 'BAD_STATE'],
      ['long', 'unknown', 'BAD_STATE'],
      ['sentence', 'unknown', 'BAD_STATE'],
      ['markup', 'unknown', 'BAD_STATE'],
    ]);
  });

  it('stops at a refused token and at a rate limit, reports the rest as not read, and keeps no message of a failure', async () => {
    const wait = new Date('2026-11-16T10:00:00Z');
    const failing = (error: unknown): AdObjectStateSource => ({
      async readState(_s, o) {
        if (o.id === 'bad') throw error;
        return { status: 'PAUSED', reason: null };
      },
    });
    const objects: StateTarget[] = [
      { level: 'campaign', id: 'c' },
      { level: 'ad', id: 'bad' },
      { level: 'ad', id: 'later' },
    ];
    const token = await stateReaderOf(failing(new AdPlatformError('token_expired', '190', undefined))).readStates('s', objects);
    expect(token.tokenRefused).toBe(true);
    expect(token.states).toHaveLength(1);
    expect(token.failed).toEqual([
      { id: 'bad', level: 'ad', kind: 'token_expired', code: '190' },
      { id: 'later', level: 'ad', kind: 'token_expired', code: null },
    ]);
    const limited = await stateReaderOf(failing(new AdPlatformError('rate_limited', '80004', wait))).readStates('s', objects);
    expect(limited.retryAt).toEqual(wait);
    expect(limited.tokenRefused).toBe(false);
    expect(limited.failed.map((f) => f.kind)).toEqual(['rate_limited', 'rate_limited']);
    // An object that fails for itself does not stop the others; a message (which a value could be in) is never kept.
    const own = await stateReaderOf(failing(new Error('secret token abc in a message'))).readStates('s', objects);
    expect(own.states).toHaveLength(2);
    expect(own.failed).toEqual([{ id: 'bad', level: 'ad', kind: 'unknown', code: 'ADAPTER_ERROR' }]);
    expect(JSON.stringify(own)).not.toContain('abc');
  });

  it('makes no further request once the caller\'s deadline has passed, and says the rest were not read', async () => {
    const controller = new AbortController();
    const asked: Array<[string, boolean | undefined]> = [];
    const source: AdObjectStateSource = {
      async readState(_s, o, signal) {
        asked.push([o.id, signal?.aborted]);
        if (o.id === 'first') controller.abort();
        return { status: 'PAUSED', reason: null };
      },
    };
    const result = await stateReaderOf(source).readStates('s', [
      { level: 'campaign', id: 'first' },
      { level: 'ad', id: 'second' },
      { level: 'ad', id: 'third' },
    ], controller.signal);
    expect(asked).toEqual([['first', false]]);
    expect(result.states).toHaveLength(1);
    expect(result.failed).toEqual([
      { id: 'second', level: 'ad', kind: 'transient', code: 'TIMEOUT' },
      { id: 'third', level: 'ad', kind: 'transient', code: 'TIMEOUT' },
    ]);
    // The adapters refuse a read that was aborted before it began.
    const writer = new SandboxAdWriter();
    await expect(new SandboxAdStateReader(writer).readState(secretOf(), { level: 'ad', id: 'x' }, controller.signal)).rejects.toMatchObject({ kind: 'transient', code: 'TIMEOUT' });
    await expect(new MetaAdStateReader({ appSecret: 's', fetch: async () => { throw new Error('no request'); } }).readState(SECRET, { level: 'ad', id: '120001' }, controller.signal)).rejects.toMatchObject({ kind: 'transient', code: 'TIMEOUT' });
  });

  it('asks about twelve objects at most', async () => {
    const asked: string[] = [];
    const objects = Array.from({ length: 20 }, (_, i) => ({ level: 'ad' as const, id: `a${i}` }));
    await stateReaderOf({ readState: async (_s, o) => (asked.push(o.id), { status: 'PAUSED', reason: null }) }).readStates('s', objects);
    expect(asked).toHaveLength(12);
  });
});

describe('the sandbox read', () => {
  const secret = () => sandboxWriteLogin({ externalAccountId: ACCOUNT, currency: 'VND' }).secret;
  async function campaign(writer: SandboxAdWriter, s: string) {
    return writer.createCampaign(s, { externalAccountId: ACCOUNT, currency: 'VND' }, { name: 'Plan ludy:abcdef0123', objective: 'traffic' });
  }

  it('answers from the platform\'s status, as a test sets it, and says an object is gone', async () => {
    const writer = new SandboxAdWriter();
    const s = secret();
    const made = await campaign(writer, s);
    const reader = new SandboxAdStateReader(writer);
    expect(await reader.readState(s, { level: 'campaign', id: made.id })).toEqual({ status: 'PAUSED', reason: null });
    const object = writer.objects.get(made.id);
    if (!object) throw new Error('no object');
    object.effectiveStatus = 'PENDING_REVIEW';
    object.reviewReason = 'in_review';
    expect(await reader.readState(s, { level: 'campaign', id: made.id })).toEqual({ status: 'PENDING_REVIEW', reason: 'in_review' });
    expect(await reader.readState(s, { level: 'ad', id: made.id })).toBeNull();
    object.deleted = true;
    expect(await reader.readState(s, { level: 'campaign', id: made.id })).toBeNull();
    expect(reader.reads).toHaveLength(4);
  });

  it('refuses a secret that is not its own and can be told to fail', async () => {
    const writer = new SandboxAdWriter();
    const s = secret();
    const made = await campaign(writer, s);
    const reader = new SandboxAdStateReader(writer);
    await expect(reader.readState('{"accessToken":"x"}', { level: 'campaign', id: made.id })).rejects.toMatchObject({ kind: 'token_expired' });
    writer.inject({ level: 'campaign', when: 'state' });
    await expect(reader.readState(s, { level: 'campaign', id: made.id })).rejects.toBeInstanceOf(AdPlatformError);
    expect(await reader.readState(s, { level: 'campaign', id: made.id })).toMatchObject({ status: 'PAUSED' });
  });
});

interface Call {
  method: string;
  url: URL;
  authorization: string | null;
}
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
const meta = (answers: Array<{ status?: number; body: unknown } | Error>) => {
  const { fetch, calls } = recorded(answers);
  return { reader: new MetaAdStateReader({ appSecret: 'app-secret', graphVersion: 'v24.0', fetch, now: () => new Date('2026-11-16T00:00:00Z') }), calls };
};
const error = (code: number, subcode?: number, status = 400) => ({ status, body: { error: { message: 'Meta words that are never kept', type: 'OAuthException', code, ...(subcode ? { error_subcode: subcode } : {}) } } });

describe('the Meta read', () => {
  it('sends one GET per object with the token in the header and the fields of its level, and never writes', async () => {
    const { reader, calls } = meta([{ body: { effective_status: 'ACTIVE', id: '1' } }, { body: { effective_status: 'PAUSED' } }, { body: { effective_status: 'PENDING_REVIEW' } }]);
    expect(await reader.readState(SECRET, { level: 'campaign', id: '120001' })).toEqual({ status: 'ACTIVE', reason: null });
    expect(await reader.readState(SECRET, { level: 'ad_set', id: '120002' })).toEqual({ status: 'PAUSED', reason: null });
    expect(await reader.readState(SECRET, { level: 'ad', id: '120003' })).toEqual({ status: 'PENDING_REVIEW', reason: 'in_review' });
    expect(calls.map((c) => c.method)).toEqual(['GET', 'GET', 'GET']);
    expect(calls.map((c) => c.url.pathname.split('/').pop())).toEqual(['120001', '120002', '120003']);
    expect(calls.map((c) => c.url.searchParams.get('fields'))).toEqual(['effective_status,issues_info', 'effective_status,issues_info', 'effective_status,issues_info,ad_review_feedback']);
    expect(calls.every((c) => (c.authorization ?? '').includes('write-token') && !c.url.search.includes('write-token'))).toBe(true);
  });

  it('turns a refusal\'s feedback and issues into short codes and keeps none of the platform\'s words', async () => {
    const feedback = { global: { 'Personal Attributes!': 'You may not say that about people. Read our policy.', 'Adult content': 'x' } };
    const { reader } = meta([
      { body: { effective_status: 'DISAPPROVED', ad_review_feedback: feedback, issues_info: [{ error_code: 1487079, error_summary: 'A sentence from Meta' }] } },
      { body: { effective_status: 'WITH_ISSUES', issues_info: [{ error_code: 1359188, error_message: 'More words' }] } },
      { body: { effective_status: 'DISAPPROVED' } },
    ]);
    const first = await reader.readState(SECRET, { level: 'ad', id: '1' });
    expect(first).toEqual({ status: 'DISAPPROVED', reason: 'feedback_adult_content' });
    expect(await reader.readState(SECRET, { level: 'ad_set', id: '2' })).toEqual({ status: 'WITH_ISSUES', reason: 'issue_1359188' });
    expect(await reader.readState(SECRET, { level: 'ad', id: '3' })).toEqual({ status: 'DISAPPROVED', reason: null });
    expect(JSON.stringify(first)).not.toMatch(/sentence|policy|people|Meta/i);
    // The mapping itself: a refusal names its feedback first, any other status its issue first, a review in progress says so.
    expect(metaReasonOf('DISAPPROVED', { issues_info: [{ error_code: 7 }], ad_review_feedback: { global: { reason_a: 'x' } } })).toBe('feedback_reason_a');
    expect(metaReasonOf('WITH_ISSUES', { issues_info: [{ error_code: 7 }], ad_review_feedback: { global: { reason_a: 'x' } } })).toBe('issue_7');
    expect(metaReasonOf('IN_PROCESS', {})).toBe('in_process');
    expect(metaReasonOf('ACTIVE', { issues_info: 'nope', ad_review_feedback: [] })).toBeNull();
    expect(metaReasonOf('DISAPPROVED', { ad_review_feedback: { global: { '***': 'x' } } })).toBeNull();
  });

  it('says an object Meta does not have is gone, and maps a rate limit (BUC), a refused token, a 4xx and a network failure to their kinds', async () => {
    const { reader, calls } = meta([
      error(100, 33),
      error(80004, undefined, 400),
      error(190, 458, 401),
      error(100, undefined, 400),
      new TypeError('fetch failed'),
      { body: { id: '1' } },
    ]);
    expect(await reader.readState(SECRET, { level: 'ad', id: '1' })).toBeNull();
    await expect(reader.readState(SECRET, { level: 'ad', id: '2' })).rejects.toMatchObject({ kind: 'rate_limited', code: '80004' });
    await expect(reader.readState(SECRET, { level: 'ad', id: '3' })).rejects.toMatchObject({ kind: 'token_expired', code: '190' });
    await expect(reader.readState(SECRET, { level: 'ad', id: '4' })).rejects.toMatchObject({ kind: 'bad_request', code: '100' });
    await expect(reader.readState(SECRET, { level: 'ad', id: '5' })).rejects.toMatchObject({ kind: 'transient', code: 'NETWORK' });
    await expect(reader.readState(SECRET, { level: 'ad', id: '6' })).rejects.toMatchObject({ kind: 'unknown', code: 'NO_STATUS' });
    expect(calls).toHaveLength(6);
  });

  it('refuses an id that is not a platform id and a secret that is not a token, before any request', async () => {
    const { reader, calls } = meta([]);
    await expect(reader.readState(SECRET, { level: 'ad', id: '12/../3' })).rejects.toMatchObject({ kind: 'bad_request', code: 'BAD_OBJECT' });
    await expect(reader.readState('not json', { level: 'ad', id: '120001' })).rejects.toMatchObject({ code: 'BAD_SECRET' });
    await expect(reader.readState(JSON.stringify({ accessToken: '' }), { level: 'ad', id: '120001' })).rejects.toMatchObject({ code: 'BAD_SECRET' });
    expect(calls).toHaveLength(0);
  });

  it('names exactly one Graph call, a GET of the object, and nothing that could change one', () => {
    const source = readFileSync(new URL('../src/meta-state.ts', import.meta.url), 'utf8')
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('//'))
      .join('\n');
    const calls = [...source.matchAll(/\.call<[\s\S]*?>\(\s*'(GET|POST|PUT|PATCH|DELETE)',\s*([^,)]+)/g)].map((m) => [m[1], m[2]]);
    expect(calls).toEqual([['GET', 'object.id']]);
    expect(source).not.toMatch(/\bACTIVE\b|\bPAUSED\b|ARCHIVED|DELETE|revoke|createC|createA|form:/);
  });
});
