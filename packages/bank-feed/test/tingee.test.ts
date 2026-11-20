// SPDX-License-Identifier: AGPL-3.0-only
// The Tingee adapter (ADR-0039, #2045 S1) against a fake Tingee: signing, the two read calls, windows and paging, the cursor, money and dates, bad pages, refusals, and the
// source scan that keeps the adapter to the two read endpoints.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BANK_FEED_PROVIDERS, TINGEE_HOSTS, TINGEE_UAT_HOST, TingeeError, allowlistedFetch, bankFeedHostedProviders, parseTingeeSecret, signTingeeRequest, tingeeBankFeed, vietnamStamp, type BankFeedTransaction } from '../src/index.ts';
import { FakeTingee, type FakeAccount, type FakeTransaction } from './tingee-fake.ts';

const CLIENT = 'client-id-for-tests';
const SECRET = 'tingee-secret-token-for-tests-0123456789';
const credential = (secretToken = SECRET, clientId = CLIENT) => JSON.stringify({ clientId, secretToken });
const VA = '8888000001';

// 2026-11-20 10:00 in Vietnam.
const NOW = '2026-11-20T03:00:00Z';

function setup(options: { accounts?: FakeAccount[]; transactions?: FakeTransaction[]; accountPageCap?: number; now?: string } = {}) {
  const clock = { now: new Date(options.now ?? NOW) };
  const fake = new FakeTingee(clock, { [CLIENT]: SECRET }, options.accounts ?? [], options.transactions ?? [], options.accountPageCap === undefined ? {} : { accountPageCap: options.accountPageCap });
  const adapter = tingeeBankFeed({
    fetch: allowlistedFetch(TINGEE_HOSTS, fake.fetch),
    now: () => clock.now,
    sleep: async (ms) => {
      clock.now = new Date(clock.now.getTime() + ms);
    },
  });
  return { clock, fake, adapter };
}

let counter = 0;
const tx = (transactionDate: string, amount: string, type: 'credit' | 'debit' = 'credit', extra: Partial<FakeTransaction> = {}): FakeTransaction => {
  counter++;
  return { transactionId: `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`, code: `FT${String(counter).padStart(8, '0')}`, amount, type, content: `Thanh toan ${counter}`, accountNumber: '0011223344', vaAccountNumber: VA, transactionDate, ...extra };
};

// Every pull of an account until `more` is false, as the worker does it.
async function pullAll(adapter: ReturnType<typeof tingeeBankFeed>, cursor: string | null = null) {
  const lines: BankFeedTransaction[] = [];
  const cursors: string[] = [];
  const more: boolean[] = [];
  for (let page = 0; page < 20; page++) {
    const pulled = await adapter.pull(credential(), VA, cursor);
    lines.push(...pulled.transactions);
    cursors.push(pulled.cursor);
    more.push(pulled.more);
    cursor = pulled.cursor;
    if (!pulled.more) break;
  }
  return { lines, cursors, more, cursor: cursor as string };
}

const failure = async (run: () => Promise<unknown>): Promise<TingeeError> => {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(TingeeError);
    return error as TingeeError;
  }
  throw new Error('expected the call to fail');
};

describe('the signer and the stamps', () => {
  it('signs timestamp:body with HMAC-SHA512 keyed by the secret token, in hex', () => {
    expect(signTingeeRequest('secret', '20260101101122333', '{"a":1}')).toBe('2ed6dc1d5bd4f851f2d1c9937cd45243360b0eb848bb81347d0aec746b68e7113bd41e4cfacf8fdec4475a3297db49b4ee7fa4664bd30fce75d41257842444d0');
  });

  it('writes a time in Vietnam (UTC+7) as digits, with milliseconds when asked', () => {
    expect(vietnamStamp(new Date('2026-11-20T17:30:00.123Z'))).toBe('20261121003000');
    expect(vietnamStamp(new Date('2026-11-20T17:30:00.123Z'), true)).toBe('20261121003000123');
  });

  it('reads the sealed credential, and refuses a malformed one without echoing it', () => {
    expect(parseTingeeSecret(credential())).toEqual({ clientId: CLIENT, secretToken: SECRET });
    for (const bad of ['not json', '{}', JSON.stringify({ clientId: CLIENT }), JSON.stringify({ clientId: '', secretToken: SECRET }), JSON.stringify({ clientId: CLIENT, secretToken: ` ${SECRET}` }), JSON.stringify({ clientId: CLIENT, secretToken: 'a\u0000b' })]) {
      let error: unknown;
      try {
        parseTingeeSecret(bad);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(TingeeError);
      expect((error as TingeeError).kind).toBe('config');
      expect(String((error as Error).message)).not.toContain(SECRET);
    }
  });

  it('is a provider of its own, bound to Tingee\'s production host', () => {
    const { adapter } = setup();
    expect(adapter.id).toBe('bank_tingee');
    expect(BANK_FEED_PROVIDERS).toContain(adapter.id);
    expect(adapter.hosts).toEqual(['open-api.tingee.vn']);
    expect(adapter.verifyWebhook).toBeUndefined();
  });
});

describe('listing the accounts', () => {
  const account = (over: Partial<FakeAccount>): FakeAccount => ({ accountNumber: '0011223344', vaAccountNumber: VA, bankBin: '970418', bankName: 'BIDV', accountName: 'CONG TY ABC', status: 'active', ...over });

  it('lists the active accounts once each, across pages, by virtual account number', async () => {
    const { adapter, fake } = setup({
      accounts: [
        account({ transactionType: 'credit' }),
        account({ transactionType: 'debit' }),
        account({ vaAccountNumber: '8888000002', status: 'inactive' }),
        account({ vaAccountNumber: '8888000003', status: 'lock' }),
        account({ vaAccountNumber: '', accountNumber: '5566778899', bankName: 'ACB', accountName: 'NGUYEN VAN A' }),
      ],
      accountPageCap: 2,
    });
    const listed = await adapter.accounts(credential());
    expect(listed).toEqual([
      { externalAccountId: VA, displayName: `BIDV ${VA} - CONG TY ABC` },
      { externalAccountId: '5566778899', displayName: 'ACB 5566778899 - NGUYEN VAN A' },
    ]);
    // Three pages of two, and only the one read path.
    expect(fake.requests.map((r) => r.path)).toEqual(['/v1/get-va-paging', '/v1/get-va-paging', '/v1/get-va-paging']);
    expect(fake.requests.every((r) => r.host === 'open-api.tingee.vn')).toBe(true);
  });
});

describe('an answer that is too large', () => {
  it('is refused past 2 MB, by its declared length or as it is read, and a normal answer is read', async () => {
    const clock = { now: new Date(NOW) };
    const ok = '{"code":"00","message":"Success","data":{"totalCount":0,"items":[]}}';
    const answering = (make: () => Response) => tingeeBankFeed({ fetch: async () => make(), now: () => clock.now, sleep: async () => {} });
    expect(await answering(() => new Response(ok, { status: 200 })).accounts(credential())).toEqual([]);
    const declared = answering(() => new Response(ok, { status: 200, headers: { 'content-length': '3000000' } }));
    expect(await failure(() => declared.accounts(credential()))).toMatchObject({ kind: 'upstream' });
    // A body with no declared length, over the cap, is cut off while it is read.
    const streamed = answering(() => new Response(new ReadableStream({ start(c) { for (let i = 0; i < 4; i++) c.enqueue(new Uint8Array(600_000).fill(32)); c.close(); } }), { status: 200 }));
    const error = await failure(() => streamed.accounts(credential()));
    expect(error).toMatchObject({ kind: 'upstream' });
    expect(error.message).toContain('too large');
  });
});

describe('the hosted adapters of a deployment', () => {
  const ok = '{"code":"00","message":"Success","data":{"totalCount":0,"items":[]}}';
  const hostsCalled = async (options: { tingee: boolean; uat?: boolean }) => {
    const seen: string[] = [];
    const providers = bankFeedHostedProviders({
      ...options,
      fetchImpl: async (input) => {
        seen.push(new URL(input).hostname);
        return new Response(ok, { status: 200 });
      },
    });
    for (const provider of Object.values(providers)) await provider.check?.(credential());
    return { providers, seen };
  };

  it('offers nothing when Tingee is off, only the production host by default, and only the UAT host for the UAT run', async () => {
    expect((await hostsCalled({ tingee: false })).providers).toEqual({});
    expect((await hostsCalled({ tingee: false, uat: true })).providers).toEqual({});
    const production = await hostsCalled({ tingee: true });
    expect(Object.keys(production.providers)).toEqual(['bank_tingee']);
    expect(production.seen).toEqual([TINGEE_HOSTS[0]]);
    const uat = await hostsCalled({ tingee: true, uat: true });
    expect(uat.seen).toEqual([TINGEE_UAT_HOST]);
    // What an adapter declares it reaches stays the production host.
    expect(production.providers.bank_tingee?.hosts).toEqual(TINGEE_HOSTS);
  });
});

describe('testing a credential', () => {
  it('is one call for a page of one account, and refuses a credential Tingee does not accept', async () => {
    const account: FakeAccount = { accountNumber: '0011223344', vaAccountNumber: VA, bankBin: '970418', bankName: 'BIDV', accountName: 'CONG TY ABC', status: 'active' };
    const { adapter, fake } = setup({ accounts: [account, { ...account, vaAccountNumber: '8888000002' }, { ...account, vaAccountNumber: '8888000003' }], accountPageCap: 1 });
    await adapter.check?.(credential());
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toMatchObject({ path: '/v1/get-va-paging', body: { skipCount: 0, maxResultCount: 1 } });
    expect(await failure(() => adapter.check?.(credential('another-secret-token')) as Promise<void>)).toMatchObject({ kind: 'credentials', tingeeCode: '97' });
  });
});

describe('refusals', () => {
  it('names a wrong secret or an unknown client as a credential problem, and never echoes the secret', async () => {
    const { adapter } = setup({ accounts: [] });
    const wrong = await failure(() => adapter.accounts(credential('another-secret-token')));
    expect(wrong).toMatchObject({ kind: 'credentials', tingeeCode: '97' });
    const unknown = await failure(() => adapter.accounts(credential(SECRET, 'nobody')));
    expect(unknown).toMatchObject({ kind: 'credentials', tingeeCode: '92' });
    for (const error of [wrong, unknown]) {
      expect(`${error.message} ${JSON.stringify(error)}`).not.toContain(SECRET);
      expect(`${error.message} ${JSON.stringify(error)}`).not.toContain('another-secret-token');
    }
  });

  it('names a clock too far behind as a clock problem', async () => {
    const clock = { now: new Date(NOW) };
    const fake = new FakeTingee(clock, { [CLIENT]: SECRET });
    const adapter = tingeeBankFeed({ fetch: allowlistedFetch(TINGEE_HOSTS, fake.fetch), now: () => new Date(clock.now.getTime() - 20 * 60_000), sleep: async () => {} });
    expect(await failure(() => adapter.accounts(credential()))).toMatchObject({ kind: 'clock', tingeeCode: '91' });
  });

  it('reads a repeated signature as an upstream refusal to retry, not as a bad credential', async () => {
    const clock = { now: new Date(NOW) };
    const fake = new FakeTingee(clock, { [CLIENT]: SECRET });
    const twice: typeof fake.fetch = async (input, init) => {
      await fake.fetch(input, init);
      return fake.fetch(input, init);
    };
    const adapter = tingeeBankFeed({ fetch: twice, now: () => clock.now, sleep: async () => {} });
    expect(await failure(() => adapter.accounts(credential()))).toMatchObject({ kind: 'upstream', tingeeCode: '97' });
  });

  it('stops on Tingee\'s rate limit', async () => {
    const clock = { now: new Date(NOW) };
    const fake = new FakeTingee(clock, { [CLIENT]: SECRET }, []);
    // No pause between calls, and a clock that moves a millisecond a call: the 21st call within 10 seconds is refused.
    const adapter = tingeeBankFeed({
      fetch: allowlistedFetch(TINGEE_HOSTS, fake.fetch),
      now: () => (clock.now = new Date(clock.now.getTime() + 1)),
      spacingMs: 0,
    });
    let error: TingeeError | null = null;
    for (let i = 0; i < 30 && error === null; i++) {
      try {
        await adapter.accounts(credential());
      } catch (e) {
        error = e as TingeeError;
      }
    }
    expect(error).toMatchObject({ kind: 'rate_limited', tingeeCode: '1001' });
  });

  it('refuses a host that is not Tingee\'s, and an unreadable cursor', async () => {
    const { fake } = setup();
    expect(() => tingeeBankFeed({ fetch: fake.fetch, host: 'evil.example' as unknown as typeof TINGEE_UAT_HOST })).toThrow(TingeeError);
    const { adapter } = setup();
    expect(await failure(() => adapter.pull(credential(), VA, 'yesterday'))).toMatchObject({ kind: 'config' });
    expect(await failure(() => adapter.pull(credential(), VA, '20261340250000'))).toMatchObject({ kind: 'config' });
    // The UAT host is the one other host, and the production allowlist does not include it.
    const uat = tingeeBankFeed({ fetch: allowlistedFetch(TINGEE_HOSTS, fake.fetch), host: TINGEE_UAT_HOST, sleep: async () => {} });
    expect(await failure(() => uat.accounts(credential()))).toMatchObject({ kind: 'upstream' });
  });
});

describe('pulling transactions', () => {
  it('goes back 31 days on the first pull, in windows of at most 10 days, and reads the last 2 days again next time', async () => {
    // One transaction a day from 20 October.
    const transactions = Array.from({ length: 32 }, (_, i) => {
      const day = new Date(Date.UTC(2026, 9, 20 + i));
      return tx(`${day.getUTCFullYear()}${String(day.getUTCMonth() + 1).padStart(2, '0')}${String(day.getUTCDate()).padStart(2, '0')}090000`, '100000');
    });
    const { adapter, fake } = setup({ transactions });
    const run = await pullAll(adapter);
    expect(run.more).toEqual([true, true, true, false]);
    expect(run.lines).toHaveLength(32);
    expect(new Set(run.lines.map((l) => l.reference)).size).toBe(32);
    // The first window starts at 00:00 on 20 October; no window was refused, and each is under 10 days.
    const windows = fake.requests.filter((r) => r.path === '/v1/transaction/get-paging');
    expect(windows[0]?.body.startTime).toBe('20261020000000');
    expect(windows.every((r) => r.code === '00')).toBe(true);
    // An intermediate window moves the cursor to the second after its end; the last leaves it 2 days before now, but never behind where that window started (here 00:00 on 19 November).
    expect(run.cursors).toEqual(['20261030000000', '20261109000000', '20261119000000', '20261119000000']);
    expect(run.cursor).toBe('20261119000000');
  });

  it('starts the next pull at the cursor, so a line posted late inside the last 2 days comes again', async () => {
    const t1 = tx('20261119090000', '100000');
    const { adapter, clock, fake } = setup({ transactions: [t1] });
    const first = await pullAll(adapter);
    expect(first.lines.map((l) => l.reference)).toContain(t1.code);
    clock.now = new Date(clock.now.getTime() + 3_600_000);
    const late = tx('20261119120000', '250000');
    fake.transactions.push(late, tx('20261120103000', '5000'));
    const second = await pullAll(adapter, first.cursor);
    // The earlier line again (its reference keys it), the late one, and the new one; the cursor moves on, never back.
    expect(second.lines.map((l) => l.reference)).toEqual([t1.code, late.code, expect.stringMatching(/^FT/)]);
    expect(second.cursor >= first.cursor).toBe(true);
    expect(fake.requests.at(-1)?.body.startTime).toBe(first.cursor);
  });

  it('reads every page of a window and returns the lines oldest first, whatever the order Tingee answers in', async () => {
    const day = Array.from({ length: 450 }, (_, i) => tx(`20261110${String(Math.floor(i / 60) + 6).padStart(2, '0')}${String(i % 60).padStart(2, '0')}00`, String(1000 + i)));
    const { adapter, fake } = setup({ transactions: day });
    const run = await pullAll(adapter);
    expect(run.lines).toHaveLength(450);
    expect(run.lines.map((l) => l.reference)).toEqual([...day].sort((a, b) => a.transactionDate.localeCompare(b.transactionDate) || a.transactionId.localeCompare(b.transactionId)).map((t) => t.code));
    // 450 lines in 200s: three pages of that window.
    expect(fake.requests.filter((r) => r.body.startTime === '20261109000000').map((r) => r.body.skipCount)).toEqual([0, 200, 400]);
  });

  it('keeps an amount beyond 2^53 as the digits Tingee wrote, signs a debit, and reads the Vietnam day', async () => {
    const big = tx('20261110235959', '9999999999999999');
    const fraction = tx('20261111000001', '1500000.50');
    const debit = tx('20261112080000', '250000', 'debit');
    const whole = tx('20261113080000', '7000');
    const { adapter } = setup({ transactions: [big, fraction, debit, whole] });
    const { lines } = await pullAll(adapter);
    const byRef = Object.fromEntries(lines.map((l) => [l.reference, l]));
    expect(byRef[big.code]).toMatchObject({ amount: '9999999999999999', date: '2026-11-10', balance: null });
    expect(byRef[fraction.code]).toMatchObject({ amount: '1500000.5', date: '2026-11-11' });
    expect(byRef[debit.code]).toMatchObject({ amount: '-250000', date: '2026-11-12' });
    expect(byRef[whole.code]).toMatchObject({ amount: '7000' });
  });

  it('keys a line by the bank\'s code, else by Tingee\'s id, and keeps no content a bank did not give', async () => {
    const noCode = tx('20261110090000', '1000', 'credit', { code: '' });
    const noContent = tx('20261110090100', '2000');
    delete noContent.content;
    const dirty = tx('20261110090200', '3000', 'credit', { content: `a\u0000b\u001fc${'x'.repeat(1200)}` });
    const { adapter } = setup({ transactions: [noCode, noContent, dirty] });
    const { lines } = await pullAll(adapter);
    const byAmount = Object.fromEntries(lines.map((l) => [l.amount, l]));
    expect(byAmount['1000']?.reference).toBe(noCode.transactionId);
    expect(byAmount['2000']).toMatchObject({ reference: noContent.code, description: '' });
    expect(byAmount['3000']?.description.startsWith('a b c')).toBe(true);
    expect(byAmount['3000']?.description).toHaveLength(1000);
  });

  it('skips a line of no money, and refuses a page with any other bad line, naming the place and never the content', async () => {
    const zero = tx('20261110090000', '0');
    const ok = tx('20261110090100', '4000');
    expect((await pullAll(setup({ transactions: [zero, ok] }).adapter)).lines).toHaveLength(1);
    const cases: Array<[string, Partial<FakeTransaction>, string]> = [
      ['an unreadable amount', { amount: '1e6' }, 'an unreadable amount'],
      ['more than 16 digits', { amount: '12345678901234567890' }, 'more than 16 digits'],
      ['more than 2 decimals', { amount: '10.001' }, 'more than 2 decimals'],
      ['a negative credit', { amount: '-5000' }, 'a negative credit'],
      ['no known type', { type: 'transfer' as unknown as 'credit' }, 'no known type'],
      ['an unreadable date', { transactionDate: '20261110250000' }, 'an unreadable date'],
      ['no reference', { code: '', transactionId: '' }, 'no reference'],
    ];
    for (const [, over, what] of cases) {
      const bad = tx('20261110090200', '9000', 'credit', { content: 'PRIVATE-TRANSFER-TEXT', ...over });
      const error = await failure(() => pullAll(setup({ transactions: [ok, bad] }).adapter));
      expect(error.kind).toBe('bad_page');
      expect(error.message).toMatch(/^tingee: transaction \d+ of the page has /);
      expect(error.message).toContain(what);
      expect(error.message).not.toContain('PRIVATE-TRANSFER-TEXT');
      expect(error.message).not.toContain(SECRET);
    }
  });

  it('halves a window that would bring more lines than one pull may carry, and refuses a single day that does', async () => {
    // 5200 lines over ten days: the first 10-day window would carry too many, so it is read in halves.
    const spread = Array.from({ length: 5200 }, (_, i) => tx(`202610${20 + (i % 10)}${String(Math.floor(i / 10) % 24).padStart(2, '0')}${String(i % 60).padStart(2, '0')}00`, '1000'));
    const { adapter, fake } = setup({ transactions: spread });
    const first = await adapter.pull(credential(), VA, null);
    expect(first.transactions.length).toBeLessThanOrEqual(5000);
    expect(first.more).toBe(true);
    const spans = fake.requests.filter((r) => r.path === '/v1/transaction/get-paging').map((r) => `${r.body.startTime}-${r.body.endTime}`);
    expect(spans[0]).toBe('20261020000000-20261029235959');
    expect(spans.at(-1)).not.toBe(spans[0]);

    const oneDay = Array.from({ length: 5200 }, (_, i) => tx(`20261020${String(Math.floor(i / 300) + 1).padStart(2, '0')}${String(i % 60).padStart(2, '0')}00`, '1000'));
    const error = await failure(() => setup({ transactions: oneDay }).adapter.pull(credential(), VA, null));
    expect(error).toMatchObject({ kind: 'bad_page' });
    expect(error.message).toContain('a single day');
  });
});

describe('the adapter keeps to what it is for', () => {
  // The whole source, comments included: nothing here names another path or host, so a scan of the raw text cannot be hidden by a comment trick.
  const source = readFileSync(new URL('../src/tingee.ts', import.meta.url), 'utf8').replace('https://developers.tingee.vn/docs/', '');

  it('names no path but the two read ones, and no host but Tingee\'s production and UAT hosts', () => {
    const paths = [...new Set([...source.matchAll(/\/v\d\/[\w/_-]+/g)].map((m) => m[0]))].sort();
    expect(paths).toEqual(['/v1/get-va-paging', '/v1/transaction/get-paging']);
    const hosts = [...new Set([...source.matchAll(/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.tingee\.vn/g)].map((m) => m[0]))].sort();
    expect(hosts).toEqual(['open-api.tingee.vn', 'uat-open-api.tingee.vn']);
  });

  it('calls only through the two path constants, so a path cannot be built from pieces', () => {
    const calls = [...source.matchAll(/\bcall\(\s*credential\s*,\s*([^,]+),/g)].map((m) => (m[1] as string).trim());
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.every((c) => c === 'ACCOUNTS_PATH' || c === 'TRANSACTIONS_PATH')).toBe(true);
    expect(source).toMatch(/const ACCOUNTS_PATH = '\/v1\/get-va-paging';/);
    expect(source).toMatch(/const TRANSACTIONS_PATH = '\/v1\/transaction\/get-paging';/);
  });

  it('never reaches for the global fetch or a Node network module, and names no other Tingee product', () => {
    expect(source).not.toMatch(/(?<![.\w])fetch\s*\(/);
    expect(source).not.toMatch(/from 'node:(https?|net|tls|http2|dgram)'/);
    expect(source).not.toMatch(/create-va|confirm-va|delete-va|register-notify|create-debit|direct-link|direct-debit|refund|disburs|chi ho|payment-gateway|\/qr\b/i);
  });

  it('keeps the money out of JS numbers: no parse of an amount into a number', () => {
    expect(source).not.toMatch(/(parseFloat|parseInt|Number)\s*\(\s*(raw|digits|item\.amount|line\.amount)/);
    expect(source).not.toMatch(/parseFloat/);
  });
});

describe('an answer without a total', () => {
  it('is refused rather than read as one short page', async () => {
    const clock = { now: new Date(NOW) };
    const fake = new FakeTingee(clock, { [CLIENT]: SECRET }, [], [tx('20261110090000', '1000')]);
    const noTotal: typeof fake.fetch = async (input, init) => {
      const answer = await fake.fetch(input, init);
      const body = (await answer.json()) as { data?: Record<string, unknown> };
      if (body.data) delete body.data.totalCount;
      return new Response(JSON.stringify(body), { status: 200 });
    };
    const adapter = tingeeBankFeed({ fetch: noTotal, now: () => clock.now, sleep: async (ms) => void (clock.now = new Date(clock.now.getTime() + ms)) });
    expect(await failure(() => adapter.pull(credential(), VA, null))).toMatchObject({ kind: 'upstream' });
    expect(await failure(() => adapter.accounts(credential()))).toMatchObject({ kind: 'upstream' });
  });
});
