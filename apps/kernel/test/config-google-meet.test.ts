// SPDX-License-Identifier: AGPL-3.0-only
// The Google OAuth client of the Google Meet transcript import (Meetings C2, #3174, PR C): off by default, both settings or neither, a client of its own beside the calendar's, and the adapter exists only with both.
import { describe, expect, it } from 'vitest';
import { GoogleMeetAdapter } from '@crove/channel';
import { MEETING_PLATFORM_OAUTH_NAME } from '@crove/kernel-contract';
import { loadConfig } from '../src/config.ts';
import { meetingPlatformsOf } from '../src/kernel.ts';

const BASE = { DATABASE_URL: 'postgres://localhost/x', AUTH_JWT_SECRET: 'x'.repeat(32), AUTH_ISSUER: 'crove-auth', WEB_DIST: '/nonexistent' };
// A made-up client (the shape of a Google web client id, nothing real).
const MEET = { MEETINGS_GOOGLE_CLIENT_ID: '123456789012-abcdefgh12345678.apps.googleusercontent.com', MEETINGS_GOOGLE_CLIENT_SECRET: 'test-only-not-real' };
const CALENDAR = { CALENDAR_GOOGLE_CLIENT_ID: '999999999999-zyxwvuts87654321.apps.googleusercontent.com', CALENDAR_GOOGLE_CLIENT_SECRET: 'calendar-test-only-not-real' };

describe('MEETINGS_GOOGLE_CLIENT_ID and MEETINGS_GOOGLE_CLIENT_SECRET', () => {
  it('are off by default: no Google Meet adapter (the offline sandbox is a separate switch)', () => {
    const config = loadConfig({ ...BASE });
    expect(config.MEETINGS_GOOGLE_CLIENT_ID).toBeUndefined();
    expect(Object.keys(meetingPlatformsOf(config))).toEqual(['sandbox']);
    expect(Object.keys(meetingPlatformsOf(loadConfig({ ...BASE, CHANNEL_SANDBOX: 'false' })))).toEqual([]);
  });

  it('are not turned on by the calendar client: the calendar consent stays the calendar\'s', () => {
    const adapters = meetingPlatformsOf(loadConfig({ ...BASE, ...CALENDAR, CHANNEL_SANDBOX: 'false' }));
    expect(Object.keys(adapters)).toEqual([]);
  });

  it('give the deployment a Google Meet adapter when both are set', () => {
    const adapters = meetingPlatformsOf(loadConfig({ ...BASE, ...MEET, CHANNEL_SANDBOX: 'false' }));
    expect(Object.keys(adapters)).toEqual(['google_meet']);
    expect(adapters.google_meet).toBeInstanceOf(GoogleMeetAdapter);
    // The adapter's attempt name and the contract's map (which the commands use) stay the same.
    expect((adapters.google_meet as GoogleMeetAdapter).oauthProvider).toBe(MEETING_PLATFORM_OAUTH_NAME.google_meet);
  });

  it('refuse one without the other, and an id that is not a Google web client id', () => {
    expect(() => loadConfig({ ...BASE, MEETINGS_GOOGLE_CLIENT_ID: MEET.MEETINGS_GOOGLE_CLIENT_ID })).toThrow(/both MEETINGS_GOOGLE_CLIENT_ID and MEETINGS_GOOGLE_CLIENT_SECRET/);
    expect(() => loadConfig({ ...BASE, MEETINGS_GOOGLE_CLIENT_SECRET: MEET.MEETINGS_GOOGLE_CLIENT_SECRET })).toThrow(/both MEETINGS_GOOGLE_CLIENT_ID and MEETINGS_GOOGLE_CLIENT_SECRET/);
    expect(() => loadConfig({ ...BASE, ...MEET, MEETINGS_GOOGLE_CLIENT_ID: 'not-a-google-client' })).toThrow(/MEETINGS_GOOGLE_CLIENT_ID is the client id of a Google OAuth web client/);
  });
});
