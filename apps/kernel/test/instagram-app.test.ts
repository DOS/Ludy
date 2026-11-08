// SPDX-License-Identifier: AGPL-3.0-only
// A separate Meta app for Instagram (#2212): optional, and when unset Instagram keeps using the Pages app. Covers the start-up checks,
// which app the Instagram dialog names, and that the webhook and the data deletion callback also take what the Instagram app signs.
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Runtime } from '@crove/kernel-runtime';
import { loadConfig } from '../src/config.ts';
import { acceptFacebookWebhook } from '../src/facebook-webhook.ts';
import { channelConnectors, channelPublishers, instagramMetaApp, metaConversationSecrets, metaWriteAppShared } from '../src/kernel.ts';
import { acceptMetaDeletion } from '../src/meta-deletion.ts';

const BASE = { DATABASE_URL: 'postgres://localhost/x', AUTH_JWT_SECRET: 'x'.repeat(32), AUTH_ISSUER: 'crove-auth', WEB_DIST: '/nonexistent' };
// Made-up apps (the shape of a Meta app id and secret, nothing real).
const PAGES = { CHANNEL_META_APP_ID: '1111111111', CHANNEL_META_APP_SECRET: 'pages-app-secret-0123456789abcdef' };
const INSTAGRAM = { CHANNEL_INSTAGRAM_APP_ID: '2222222223', CHANNEL_INSTAGRAM_APP_SECRET: 'instagram-app-secret-0123456789ab' };
const REDIRECT = 'https://app.example.com/channels/oauth/x/callback';
const clientId = (url: string) => new URL(url).searchParams.get('client_id');
const dialog = (provider: string, config: ReturnType<typeof loadConfig>) =>
  channelConnectors(config)[provider]?.authorizeUrl({ state: 'st', redirectUri: REDIRECT, codeChallenge: null }) ?? '';

describe('CHANNEL_INSTAGRAM_APP_ID and CHANNEL_INSTAGRAM_APP_SECRET', () => {
  it('keep Instagram on the Pages app when unset: both providers name the Pages app', () => {
    const config = loadConfig({ ...BASE, ...PAGES });
    expect(Object.keys(channelConnectors(config)).sort()).toEqual(['facebook_page', 'instagram']);
    expect(clientId(dialog('facebook_page', config))).toBe(PAGES.CHANNEL_META_APP_ID);
    expect(clientId(dialog('instagram', config))).toBe(PAGES.CHANNEL_META_APP_ID);
    expect(instagramMetaApp(config)).toEqual({ appId: PAGES.CHANNEL_META_APP_ID, appSecret: PAGES.CHANNEL_META_APP_SECRET });
    expect(Object.keys(channelPublishers(config)).sort()).toEqual(expect.arrayContaining(['facebook_page', 'instagram']));
  });

  it('name the Instagram app in the Instagram dialog and the Pages app in the Facebook one when both are set', () => {
    const config = loadConfig({ ...BASE, ...PAGES, ...INSTAGRAM });
    expect(clientId(dialog('facebook_page', config))).toBe(PAGES.CHANNEL_META_APP_ID);
    expect(clientId(dialog('instagram', config))).toBe(INSTAGRAM.CHANNEL_INSTAGRAM_APP_ID);
    expect(instagramMetaApp(config)?.appSecret).toBe(INSTAGRAM.CHANNEL_INSTAGRAM_APP_SECRET);
    expect(Object.keys(channelPublishers(config))).toEqual(expect.arrayContaining(['facebook_page', 'instagram']));
  });

  it('offer Instagram alone when only the Instagram app is set', () => {
    const config = loadConfig({ ...BASE, ...INSTAGRAM });
    expect(Object.keys(channelConnectors(config))).toEqual(['instagram']);
    expect(clientId(dialog('instagram', config))).toBe(INSTAGRAM.CHANNEL_INSTAGRAM_APP_ID);
    expect(Object.keys(channelPublishers(config))).toContain('instagram');
    expect(Object.keys(channelPublishers(config))).not.toContain('facebook_page');
  });

  it('refuse one half of the pair, a non-numeric id, and one app id with two secrets', () => {
    expect(() => loadConfig({ ...BASE, ...PAGES, CHANNEL_INSTAGRAM_APP_ID: INSTAGRAM.CHANNEL_INSTAGRAM_APP_ID })).toThrow(/both CHANNEL_INSTAGRAM_APP_ID and CHANNEL_INSTAGRAM_APP_SECRET/);
    expect(() => loadConfig({ ...BASE, ...PAGES, CHANNEL_INSTAGRAM_APP_SECRET: INSTAGRAM.CHANNEL_INSTAGRAM_APP_SECRET })).toThrow(/both CHANNEL_INSTAGRAM_APP_ID and CHANNEL_INSTAGRAM_APP_SECRET/);
    expect(() => loadConfig({ ...BASE, ...PAGES, ...INSTAGRAM, CHANNEL_INSTAGRAM_APP_ID: 'abc' })).toThrow(/numeric id/);
    expect(() => loadConfig({ ...BASE, ...PAGES, CHANNEL_INSTAGRAM_APP_ID: PAGES.CHANNEL_META_APP_ID, CHANNEL_INSTAGRAM_APP_SECRET: INSTAGRAM.CHANNEL_INSTAGRAM_APP_SECRET })).toThrow(/one Meta app has one secret/);
    expect(() => loadConfig({ ...BASE, ...PAGES, CHANNEL_INSTAGRAM_APP_ID: PAGES.CHANNEL_META_APP_ID, CHANNEL_INSTAGRAM_APP_SECRET: PAGES.CHANNEL_META_APP_SECRET })).not.toThrow();
  });

  it('let the webhook verify token go with the Instagram app alone, and still need an app', () => {
    const token = { CHANNEL_META_WEBHOOK_VERIFY_TOKEN: 'verify-token-0123456789' };
    expect(() => loadConfig({ ...BASE, ...INSTAGRAM, ...token })).not.toThrow();
    expect(() => loadConfig({ ...BASE, ...token })).toThrow(/needs CHANNEL_META_APP_ID/);
  });

  it('let the previous webhook secret go with the Instagram app alone, and refuse it without any app or equal to the current one', () => {
    const previous = { CHANNEL_META_APP_SECRET_PREVIOUS: 'previous-secret-0123456789abcdef' };
    expect(() => loadConfig({ ...BASE, ...INSTAGRAM, ...previous })).not.toThrow();
    expect(() => loadConfig({ ...BASE, ...previous })).toThrow(/set without CHANNEL_META_APP_SECRET/);
    expect(() => loadConfig({ ...BASE, ...INSTAGRAM, CHANNEL_META_APP_SECRET_PREVIOUS: INSTAGRAM.CHANNEL_INSTAGRAM_APP_SECRET })).toThrow(/same as CHANNEL_META_APP_SECRET/);
  });

  it('count the Instagram app as shared with the ads write app, as the Pages app is', () => {
    const config = (write: string, instagram: string | undefined) => ({ CHANNEL_META_ADS_WRITE_APP_ID: write, CHANNEL_META_ADS_APP_ID: undefined, CHANNEL_META_APP_ID: undefined, CHANNEL_INSTAGRAM_APP_ID: instagram });
    expect(metaWriteAppShared(config('2222222223', '2222222223'))).toBe(true);
    expect(metaWriteAppShared(config('3333333334', '2222222223'))).toBe(false);
    expect(() =>
      loadConfig({ ...BASE, ...INSTAGRAM, CHANNEL_META_ADS_WRITE_APP_ID: INSTAGRAM.CHANNEL_INSTAGRAM_APP_ID, CHANNEL_META_ADS_WRITE_APP_SECRET: 'another-secret-0123456789abcdef' }),
    ).toThrow(/one Meta app has one secret/);
    // The same app and secret: refused as the Pages app is, unless it is also the read ads app.
    expect(() =>
      loadConfig({ ...BASE, ...INSTAGRAM, CHANNEL_META_ADS_WRITE_APP_ID: INSTAGRAM.CHANNEL_INSTAGRAM_APP_ID, CHANNEL_META_ADS_WRITE_APP_SECRET: INSTAGRAM.CHANNEL_INSTAGRAM_APP_SECRET }),
    ).toThrow(/is the Instagram app but not the read ads app/);
  });

  it('name the secrets Meta may sign with: the Pages app first, the Instagram app when it is another one', () => {
    expect(metaConversationSecrets(loadConfig({ ...BASE }))).toBeUndefined();
    expect(metaConversationSecrets(loadConfig({ ...BASE, ...PAGES }))).toEqual({ primary: PAGES.CHANNEL_META_APP_SECRET });
    expect(metaConversationSecrets(loadConfig({ ...BASE, ...PAGES, ...INSTAGRAM }))).toEqual({ primary: PAGES.CHANNEL_META_APP_SECRET, instagram: INSTAGRAM.CHANNEL_INSTAGRAM_APP_SECRET });
    expect(metaConversationSecrets(loadConfig({ ...BASE, ...INSTAGRAM }))).toEqual({ primary: INSTAGRAM.CHANNEL_INSTAGRAM_APP_SECRET });
  });
});

describe('the Page and Instagram webhook with an Instagram app of its own', () => {
  // A verified notice with nothing to park answers 200 without touching the database, so a runtime that is never reached will do.
  const never = {} as Runtime;
  const body = new TextEncoder().encode(JSON.stringify({ object: 'instagram', entry: [] }));
  const sign = (secret: string) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  const config = { appSecret: PAGES.CHANNEL_META_APP_SECRET, instagramAppSecret: INSTAGRAM.CHANNEL_INSTAGRAM_APP_SECRET };

  it('takes a notice signed by either app and refuses any other signature', async () => {
    expect(await acceptFacebookWebhook(never, config, { signature: sign(PAGES.CHANNEL_META_APP_SECRET), body })).toEqual({ status: 200, parked: false });
    expect(await acceptFacebookWebhook(never, config, { signature: sign(INSTAGRAM.CHANNEL_INSTAGRAM_APP_SECRET), body })).toEqual({ status: 200, parked: false });
    expect(await acceptFacebookWebhook(never, config, { signature: sign('another-secret-0123456789abcdef'), body })).toEqual({ status: 401, code: 'WEBHOOK_SIGNATURE' });
    expect(await acceptFacebookWebhook(never, config, { signature: undefined, body })).toEqual({ status: 401, code: 'WEBHOOK_SIGNATURE' });
  });

  it('refuses the Instagram app’s signature when no Instagram app is configured', async () => {
    expect(await acceptFacebookWebhook(never, { appSecret: PAGES.CHANNEL_META_APP_SECRET }, { signature: sign(INSTAGRAM.CHANNEL_INSTAGRAM_APP_SECRET), body })).toEqual({
      status: 401,
      code: 'WEBHOOK_SIGNATURE',
    });
  });
});

describe('Meta’s data deletion callback with an Instagram app of its own', () => {
  const signed = (secret: string) => {
    const encoded = Buffer.from(JSON.stringify({ algorithm: 'HMAC-SHA256', issued_at: Math.floor(Date.now() / 1000), user_id: '7001' })).toString('base64url');
    return new URLSearchParams({ signed_request: `${createHmac('sha256', secret).update(encoded).digest('base64url')}.${encoded}` }).toString();
  };
  // A request that verifies reaches the database, which this runtime refuses with a marker; one that does not never gets that far.
  const reached = new Error('reached the database');
  const runtime = { orgless: () => Promise.reject(reached) } as unknown as Runtime;
  const apps = { conversations: PAGES.CHANNEL_META_APP_SECRET, instagram: INSTAGRAM.CHANNEL_INSTAGRAM_APP_SECRET };

  it('verifies a request against the Pages app and the Instagram app, and refuses another', async () => {
    await expect(acceptMetaDeletion(runtime, apps, signed(PAGES.CHANNEL_META_APP_SECRET))).rejects.toBe(reached);
    await expect(acceptMetaDeletion(runtime, apps, signed(INSTAGRAM.CHANNEL_INSTAGRAM_APP_SECRET))).rejects.toBe(reached);
    expect(await acceptMetaDeletion(runtime, apps, signed('another-secret-0123456789abcdef'))).toEqual({ status: 401, code: 'DELETION_SIGNATURE' });
    expect(await acceptMetaDeletion(runtime, { conversations: PAGES.CHANNEL_META_APP_SECRET }, signed(INSTAGRAM.CHANNEL_INSTAGRAM_APP_SECRET))).toEqual({ status: 401, code: 'DELETION_SIGNATURE' });
  });
});
