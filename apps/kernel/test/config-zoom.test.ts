// SPDX-License-Identifier: AGPL-3.0-only
// The Zoom OAuth app of the recording import (Meetings C3, #3175): off by default, both settings or neither, and the adapter exists only with both.
import { describe, expect, it } from 'vitest';
import { ZoomMeetingPlatform } from '@ludy/channel';
import { MEETING_PLATFORM_OAUTH_NAME } from '@ludy/kernel-contract';
import { loadConfig } from '../src/config.ts';
import { meetingPlatformsOf } from '../src/kernel.ts';

const BASE = { DATABASE_URL: 'postgres://localhost/x', AUTH_JWT_SECRET: 'x'.repeat(32), AUTH_ISSUER: 'crove-auth', WEB_DIST: '/nonexistent' };
// A made-up app (the shape of a Zoom client id, nothing real).
const ZOOM = { ZOOM_OAUTH_CLIENT_ID: 'zoomtestclient01', ZOOM_OAUTH_CLIENT_SECRET: 'test-only-not-real' };

describe('ZOOM_OAUTH_CLIENT_ID and ZOOM_OAUTH_CLIENT_SECRET', () => {
  it('are off by default: no Zoom adapter (the offline sandbox is a separate switch)', () => {
    const config = loadConfig({ ...BASE });
    expect(config.ZOOM_OAUTH_CLIENT_ID).toBeUndefined();
    expect(Object.keys(meetingPlatformsOf(config))).toEqual(['sandbox']);
    expect(Object.keys(meetingPlatformsOf(loadConfig({ ...BASE, CHANNEL_SANDBOX: 'false' })))).toEqual([]);
  });

  it('give the deployment a Zoom adapter when both are set', () => {
    const adapters = meetingPlatformsOf(loadConfig({ ...BASE, ...ZOOM, CHANNEL_SANDBOX: 'false' }));
    expect(Object.keys(adapters)).toEqual(['zoom']);
    expect(adapters.zoom).toBeInstanceOf(ZoomMeetingPlatform);
    // The adapter's attempt name and the contract's map (which the commands use) stay the same.
    expect((adapters.zoom as ZoomMeetingPlatform).oauthProvider).toBe(MEETING_PLATFORM_OAUTH_NAME.zoom);
  });

  it('refuse one without the other, and an id that is not the shape of a Zoom client id', () => {
    expect(() => loadConfig({ ...BASE, ZOOM_OAUTH_CLIENT_ID: ZOOM.ZOOM_OAUTH_CLIENT_ID })).toThrow(/both ZOOM_OAUTH_CLIENT_ID and ZOOM_OAUTH_CLIENT_SECRET/);
    expect(() => loadConfig({ ...BASE, ZOOM_OAUTH_CLIENT_SECRET: ZOOM.ZOOM_OAUTH_CLIENT_SECRET })).toThrow(/both ZOOM_OAUTH_CLIENT_ID and ZOOM_OAUTH_CLIENT_SECRET/);
    expect(() => loadConfig({ ...BASE, ...ZOOM, ZOOM_OAUTH_CLIENT_ID: 'has spaces and !' })).toThrow(/ZOOM_OAUTH_CLIENT_ID is the client id/);
  });
});

describe('ZOOM_WEBHOOK_SECRET_TOKEN and ZOOM_WEBHOOK_SECRET_TOKEN_PREVIOUS', () => {
  const TOKEN = 'zoom-secret-token-not-real-0001';
  it('are off by default, and the token needs the OAuth app', () => {
    expect(loadConfig({ ...BASE }).ZOOM_WEBHOOK_SECRET_TOKEN).toBeUndefined();
    expect(loadConfig({ ...BASE, ...ZOOM, ZOOM_WEBHOOK_SECRET_TOKEN: TOKEN }).ZOOM_WEBHOOK_SECRET_TOKEN).toBe(TOKEN);
    expect(() => loadConfig({ ...BASE, ZOOM_WEBHOOK_SECRET_TOKEN: TOKEN })).toThrow(/ZOOM_WEBHOOK_SECRET_TOKEN needs ZOOM_OAUTH_CLIENT_ID/);
  });

  it('accept a token being replaced only with the current one, different from it, and of the shape of a secret token', () => {
    const OLD = 'zoom-secret-token-old-not-real-0002';
    expect(loadConfig({ ...BASE, ...ZOOM, ZOOM_WEBHOOK_SECRET_TOKEN: TOKEN, ZOOM_WEBHOOK_SECRET_TOKEN_PREVIOUS: OLD }).ZOOM_WEBHOOK_SECRET_TOKEN_PREVIOUS).toBe(OLD);
    expect(() => loadConfig({ ...BASE, ...ZOOM, ZOOM_WEBHOOK_SECRET_TOKEN_PREVIOUS: OLD })).toThrow(/PREVIOUS is set without ZOOM_WEBHOOK_SECRET_TOKEN/);
    expect(() => loadConfig({ ...BASE, ...ZOOM, ZOOM_WEBHOOK_SECRET_TOKEN: TOKEN, ZOOM_WEBHOOK_SECRET_TOKEN_PREVIOUS: TOKEN })).toThrow(/the same as ZOOM_WEBHOOK_SECRET_TOKEN/);
    for (const bad of ['short', 'fifteen-chars-1', 'has a space in it 12345', 'x'.repeat(201)]) expect(() => loadConfig({ ...BASE, ...ZOOM, ZOOM_WEBHOOK_SECRET_TOKEN: bad }), bad).toThrow(/secret token of the Zoom app/);
  });
});
