// SPDX-License-Identifier: AGPL-3.0-only
// The check of a marketplace push (#4327, S3a of #4315): each platform's signature construction against a vector (TikTok's is the one its own page publishes), constant-time comparison of a header of the right shape only,
// the body read only after the signature passed and only as bytes, the shop or seller named by the body being the connection's own, the time window, and the worker's batch (a secret opened once for a connection, a broken
// credential dropping only its own pushes, a refused push counted on its hook). Made-up keys and shops only.
import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { CredentialBroker, Runtime } from '@ludy/kernel-runtime';
import { MARKETPLACE_PUSH_MAX_AGE_MS, marketplacePushSignature, verifyMarketplacePush } from '../src/marketplace-push.ts';
import { verifyMarketplaceHookNotices, type MarketplaceHookNoticeRow } from '../src/marketplace-push-relay.ts';

const enc = (text: string) => new TextEncoder().encode(text);

// The vector of TikTok Shop's webhook page: app key `abcdef`, app secret `123`, this exact body.
const TIKTOK_BODY = '{"type":1,"tts_notification_id":"7380066284010030890","shop_id":"7495540735365777507","timestamp":1718305585,"data":{"is_on_hold_order":true,"order_id":"576653688135258178","order_status":"UNPAID","update_time":1718305585}}';
const TIKTOK_SIGNATURE = '5dec0f11ec2f6783b8deee53c9ffbf8d024302f7c7e7fa55a35d17629031ac05';
const TIKTOK_SECRET = JSON.stringify({ appKey: 'abcdef', appSecret: '123', accessToken: 'tok-test', shopCipher: null, shopId: '7495540735365777507' });
const TIKTOK_NOW = 1718305585 * 1000 + 5_000;

const LAZADA_SECRET = JSON.stringify({ appKey: '123456', appSecret: 'helloworld', accessToken: '50000000001abcDEF', sellerId: '1234567' });
const SHOPEE_SECRET = JSON.stringify({ partnerId: '1000012', partnerKey: 'test-only-partner-key', shopId: '77777', accessToken: 'SHP_access' });
const SHOPEE_URL = 'https://ludy.example.test/api/marketplace/shopee/webhook/KEY-IN-THE-ADDRESS';
const NOW = Date.parse('2026-11-21T08:00:00Z');

const lazadaPush = (over: Record<string, unknown> = {}) => JSON.stringify({ seller_id: '1234567', message_type: 0, data: { order_status: 'unpaid', status_update_time: 1603698638, trade_order_id: '260422900198363' }, timestamp: NOW - 5_000, site: 'lazada_vn', ...over });
const shopeePush = (over: Record<string, unknown> = {}) => JSON.stringify({ shop_id: 77777, code: 3, success: 1, extra: '', data: { ordersn: '2611A1', status: 'READY_TO_SHIP' }, timestamp: Math.floor(NOW / 1000) - 5, ...over });
const lazadaSign = (body: string, secret = 'helloworld') => createHmac('sha256', secret).update('123456').update(body).digest('hex');
const shopeeSign = (body: string, url = SHOPEE_URL, key = 'test-only-partner-key') => createHmac('sha256', key).update(`${url}|${body}`).digest('hex');

describe('the signatures', () => {
  it('computes the vector TikTok Shop publishes, from the bytes', () => {
    expect(marketplacePushSignature('tiktok_shop', { appKey: 'abcdef', key: '123' }, enc(TIKTOK_BODY))).toBe(TIKTOK_SIGNATURE);
    expect(verifyMarketplacePush('tiktok_shop', TIKTOK_SECRET, { authorization: TIKTOK_SIGNATURE, body: enc(TIKTOK_BODY), requestUrl: null }, TIKTOK_NOW)).toBe('ok');
  });

  it('TikTok Shop: a wrong secret, key, byte, length or case is refused, never ok', () => {
    const check = (secret: string, authorization: string, body = TIKTOK_BODY) => verifyMarketplacePush('tiktok_shop', secret, { authorization, body: enc(body), requestUrl: null }, TIKTOK_NOW);
    expect(check(JSON.stringify({ ...JSON.parse(TIKTOK_SECRET), appSecret: '1234' }), TIKTOK_SIGNATURE)).toBe('refused');
    expect(check(JSON.stringify({ ...JSON.parse(TIKTOK_SECRET), appKey: 'abcdeg' }), TIKTOK_SIGNATURE)).toBe('refused');
    expect(check(TIKTOK_SECRET, TIKTOK_SIGNATURE, `${TIKTOK_BODY} `)).toBe('refused');
    expect(check(TIKTOK_SECRET, TIKTOK_SIGNATURE.slice(0, 63))).toBe('refused');
    expect(check(TIKTOK_SECRET, `${TIKTOK_SIGNATURE}0`)).toBe('refused');
    expect(check(TIKTOK_SECRET, TIKTOK_SIGNATURE.toUpperCase())).toBe('refused');
    expect(check(TIKTOK_SECRET, '')).toBe('refused');
    expect(check(TIKTOK_SECRET, `Bearer ${TIKTOK_SIGNATURE}`)).toBe('refused');
    // The signature does not depend on whitespace changes a JSON round trip would make: re-serialised JSON is a different body.
    expect(check(TIKTOK_SECRET, TIKTOK_SIGNATURE, JSON.stringify(JSON.parse(TIKTOK_BODY), null, 1))).toBe('refused');
  });

  it('Lazada signs the app key and the body; Shopee signs the address, a bar and the body', () => {
    const body = lazadaPush();
    expect(verifyMarketplacePush('lazada', LAZADA_SECRET, { authorization: lazadaSign(body), body: enc(body), requestUrl: null }, NOW)).toBe('ok');
    expect(verifyMarketplacePush('lazada', LAZADA_SECRET, { authorization: lazadaSign(body, 'other-secret'), body: enc(body), requestUrl: null }, NOW)).toBe('refused');
    const shopee = shopeePush();
    expect(verifyMarketplacePush('shopee', SHOPEE_SECRET, { authorization: shopeeSign(shopee), body: enc(shopee), requestUrl: SHOPEE_URL }, NOW)).toBe('ok');
    // Another address, another key, or a body moved from another hook: refused.
    expect(verifyMarketplacePush('shopee', SHOPEE_SECRET, { authorization: shopeeSign(shopee), body: enc(shopee), requestUrl: `${SHOPEE_URL}x` }, NOW)).toBe('refused');
    expect(verifyMarketplacePush('shopee', SHOPEE_SECRET, { authorization: shopeeSign(shopee, SHOPEE_URL, 'other-key'), body: enc(shopee), requestUrl: SHOPEE_URL }, NOW)).toBe('refused');
    // A Shopee push stored without its address cannot be checked: dropped, not counted against the hook.
    expect(verifyMarketplacePush('shopee', SHOPEE_SECRET, { authorization: shopeeSign(shopee), body: enc(shopee), requestUrl: null }, NOW)).toBe('dropped');
    // A signature of one platform's construction is not another's.
    expect(verifyMarketplacePush('lazada', LAZADA_SECRET, { authorization: shopeeSign(body), body: enc(body), requestUrl: null }, NOW)).toBe('refused');
  });
});

describe('what a signed push must also be', () => {
  const lazada = (body: string) => verifyMarketplacePush('lazada', LAZADA_SECRET, { authorization: lazadaSign(body), body: enc(body), requestUrl: null }, NOW);

  it('names the connection\'s own seller or shop: another one is dropped, not refused (two shops of one own app share its one address)', () => {
    expect(lazada(lazadaPush({ seller_id: '7654321' }))).toBe('dropped');
    expect(lazada(lazadaPush({ seller_id: undefined }))).toBe('dropped');
    expect(lazada(lazadaPush({ seller_id: { id: '1234567' } }))).toBe('dropped');
    const other = shopeePush({ shop_id: 88888 });
    expect(verifyMarketplacePush('shopee', SHOPEE_SECRET, { authorization: shopeeSign(other), body: enc(other), requestUrl: SHOPEE_URL }, NOW)).toBe('dropped');
    // A connection whose secret holds no shop or seller cannot say which push is its own.
    const bare = JSON.stringify({ appKey: '123456', appSecret: 'helloworld', accessToken: '50000000001abcDEF' });
    const body = lazadaPush();
    expect(verifyMarketplacePush('lazada', bare, { authorization: lazadaSign(body), body: enc(body), requestUrl: null }, NOW)).toBe('dropped');
  });

  it('is fresh: older than a day, or ahead of the clock, is dropped (seconds for TikTok and Shopee, milliseconds for Lazada)', () => {
    expect(lazada(lazadaPush({ timestamp: NOW - MARKETPLACE_PUSH_MAX_AGE_MS - 1_000 }))).toBe('dropped');
    expect(lazada(lazadaPush({ timestamp: NOW + 11 * 60_000 }))).toBe('dropped');
    expect(lazada(lazadaPush({ timestamp: Math.floor(NOW / 1000) }))).toBe('dropped');
    expect(lazada(lazadaPush({ timestamp: 'now' }))).toBe('dropped');
    const old = shopeePush({ timestamp: Math.floor(NOW / 1000) - 86_500 });
    expect(verifyMarketplacePush('shopee', SHOPEE_SECRET, { authorization: shopeeSign(old), body: enc(old), requestUrl: SHOPEE_URL }, NOW)).toBe('dropped');
  });

  it('is read only after the signature passed, as bytes: a signed body that is not UTF-8 JSON is dropped, never refused, and a bad signature never reaches the parser', () => {
    const bytes = Uint8Array.from([...enc('{"seller_id":"1234567"}'), 0xff, 0xfe]);
    const signed = createHmac('sha256', 'helloworld').update('123456').update(bytes).digest('hex');
    expect(verifyMarketplacePush('lazada', LAZADA_SECRET, { authorization: signed, body: bytes, requestUrl: null }, NOW)).toBe('dropped');
    expect(lazada('not json')).toBe('dropped');
    expect(lazada('[1,2]')).toBe('dropped');
    // An unsigned body of any shape is refused: the parser is never the judge.
    expect(verifyMarketplacePush('lazada', LAZADA_SECRET, { authorization: 'f'.repeat(64), body: bytes, requestUrl: null }, NOW)).toBe('refused');
  });

  it('drops an adapter it does not know and a secret it cannot read, without a throw', () => {
    expect(verifyMarketplacePush('sandbox', LAZADA_SECRET, { authorization: 'a'.repeat(64), body: enc('{}'), requestUrl: null }, NOW)).toBe('dropped');
    expect(verifyMarketplacePush('lazada', 'not json', { authorization: 'a'.repeat(64), body: enc('{}'), requestUrl: null }, NOW)).toBe('dropped');
    expect(verifyMarketplacePush('tiktok_shop', JSON.stringify({ appKey: 'a' }), { authorization: 'a'.repeat(64), body: enc('{}'), requestUrl: null }, NOW)).toBe('dropped');
  });
});

describe('the worker\'s batch', () => {
  const sealedFor = (secret: string) => ({ provider: 'marketplace_lazada', externalAccountId: 'acct', keyId: 'k1', envelope: Buffer.from(secret).toString('base64') });
  const row = (over: Partial<Omit<MarketplaceHookNoticeRow, 'body'>> & { body?: string } = {}): MarketplaceHookNoticeRow => {
    const { body: bodyText, ...rest } = over;
    const body = bodyText ?? lazadaPush();
    return {
      orgId: 'org-1',
      hookId: 'hook-1',
      marketplaceConnectionId: 'mc-1',
      channelConnectionId: 'cc-1',
      adapter: 'lazada',
      platform: 'lazada',
      authorization: lazadaSign(body),
      body: enc(body),
      requestUrl: null,
      ...rest,
    };
  };
  function setup(secrets: Record<string, string | Error>) {
    const opened: string[] = [];
    const runtime = {
      query: vi.fn(async (_name: string, input: { connectionId: string }) => {
        const secret = secrets[input.connectionId];
        if (secret instanceof Error || secret === undefined) throw new Error('CHANNEL_NOT_ACTIVE');
        return sealedFor(secret);
      }),
    } as unknown as Runtime;
    const broker = { open: (sealed: { envelope: Buffer }) => (opened.push('open'), sealed.envelope.toString('utf8')) } as unknown as CredentialBroker;
    const rejected: string[] = [];
    const deps = { runtime, broker, adapters: new Set(['lazada', 'shopee']), reject: async (hookId: string) => void rejected.push(hookId), now: () => NOW };
    return { deps, rejected, opened, runtime };
  }

  it('opens a connection\'s secret once for the batch, counts only the refused push on its hook, and gives a verdict for each in order', async () => {
    const { deps, rejected, opened } = setup({ 'cc-1': LAZADA_SECRET });
    const good = row();
    const bad = row({ authorization: 'a'.repeat(64) });
    const other = row({ body: lazadaPush({ seller_id: '7654321' }) });
    const verdicts = await verifyMarketplaceHookNotices(deps, [good, bad, other, row()]);
    expect(verdicts).toEqual(['ok', 'refused', 'dropped', 'ok']);
    expect(rejected).toEqual(['hook-1']);
    expect(opened).toHaveLength(1);
  });

  it('drops the pushes of a connection whose credential cannot be opened and of an adapter the deployment does not run, and goes on with the others', async () => {
    const { deps, rejected } = setup({ 'cc-1': LAZADA_SECRET, 'cc-2': new Error('closed') });
    const verdicts = await verifyMarketplaceHookNotices(deps, [row({ channelConnectionId: 'cc-2', marketplaceConnectionId: 'mc-2' }), row({ adapter: 'tiktok_shop' }), row()]);
    expect(verdicts).toEqual(['dropped', 'dropped', 'ok']);
    expect(rejected).toEqual([]);
  });

  it('never puts a body, header or secret in what it throws or returns', async () => {
    const { deps } = setup({ 'cc-1': LAZADA_SECRET });
    const canary = 'canary-body-do-not-keep';
    const verdicts = await verifyMarketplaceHookNotices(deps, [row({ body: lazadaPush({ note: canary }) })]);
    expect(JSON.stringify(verdicts)).not.toContain(canary);
  });
});
