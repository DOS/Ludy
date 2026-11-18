// SPDX-License-Identifier: AGPL-3.0-only
// The Zoom OAuth app of the recording import (Meetings C3, #3175): off by default, both settings or neither, and the adapter exists only with both.
import { describe, expect, it } from 'vitest';
import { ZoomMeetingPlatform } from '@crove/channel';
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
  });

  it('refuse one without the other, and an id that is not the shape of a Zoom client id', () => {
    expect(() => loadConfig({ ...BASE, ZOOM_OAUTH_CLIENT_ID: ZOOM.ZOOM_OAUTH_CLIENT_ID })).toThrow(/both ZOOM_OAUTH_CLIENT_ID and ZOOM_OAUTH_CLIENT_SECRET/);
    expect(() => loadConfig({ ...BASE, ZOOM_OAUTH_CLIENT_SECRET: ZOOM.ZOOM_OAUTH_CLIENT_SECRET })).toThrow(/both ZOOM_OAUTH_CLIENT_ID and ZOOM_OAUTH_CLIENT_SECRET/);
    expect(() => loadConfig({ ...BASE, ...ZOOM, ZOOM_OAUTH_CLIENT_ID: 'has spaces and !' })).toThrow(/ZOOM_OAUTH_CLIENT_ID is the client id/);
  });
});
