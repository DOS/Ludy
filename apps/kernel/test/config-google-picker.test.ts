// SPDX-License-Identifier: AGPL-3.0-only
// The settings of the Google Picker route for the audio of a Google Meet recording (Meetings C2, #3174, ADR-0025 amendment of 2026-11-25): off by default, both or neither, they need the Meet client, and
// only with them the Google adapter offers recordings and the app is told the (public) Picker values.
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { meetingPlatformsOf } from '../src/kernel.ts';

const BASE = { DATABASE_URL: 'postgres://localhost/x', AUTH_JWT_SECRET: 'x'.repeat(32), AUTH_ISSUER: 'crove-auth', WEB_DIST: '/nonexistent', CHANNEL_SANDBOX: 'false' };
const MEET = { MEETINGS_GOOGLE_CLIENT_ID: '123456789012-abcdefgh12345678.apps.googleusercontent.com', MEETINGS_GOOGLE_CLIENT_SECRET: 'test-only-not-real' };
const PICKER = { MEETINGS_GOOGLE_PICKER_API_KEY: 'AIzaSyFakeKeyForTestsOnly000000000000', MEETINGS_GOOGLE_PICKER_APP_ID: '123456789012' };

describe('MEETINGS_GOOGLE_PICKER_API_KEY and MEETINGS_GOOGLE_PICKER_APP_ID', () => {
  it('are off by default', () => {
    const config = loadConfig({ ...BASE, ...MEET });
    expect(config.MEETINGS_GOOGLE_PICKER_API_KEY).toBeUndefined();
    expect(config.MEETINGS_GOOGLE_PICKER_APP_ID).toBeUndefined();
  });

  it('are set both or neither, and need the Google Meet client', () => {
    expect(() => loadConfig({ ...BASE, ...MEET, MEETINGS_GOOGLE_PICKER_API_KEY: PICKER.MEETINGS_GOOGLE_PICKER_API_KEY })).toThrow(/both MEETINGS_GOOGLE_PICKER_API_KEY and MEETINGS_GOOGLE_PICKER_APP_ID/);
    expect(() => loadConfig({ ...BASE, ...MEET, MEETINGS_GOOGLE_PICKER_APP_ID: PICKER.MEETINGS_GOOGLE_PICKER_APP_ID })).toThrow(/both MEETINGS_GOOGLE_PICKER_API_KEY and MEETINGS_GOOGLE_PICKER_APP_ID/);
    expect(() => loadConfig({ ...BASE, ...PICKER })).toThrow(/needs the Google Meet client/);
    expect(loadConfig({ ...BASE, ...MEET, ...PICKER }).MEETINGS_GOOGLE_PICKER_APP_ID).toBe('123456789012');
  });

  it('take only a Google API key and a project number', () => {
    expect(() => loadConfig({ ...BASE, ...MEET, MEETINGS_GOOGLE_PICKER_API_KEY: 'short', MEETINGS_GOOGLE_PICKER_APP_ID: '123456789012' })).toThrow(/MEETINGS_GOOGLE_PICKER_API_KEY/);
    expect(() => loadConfig({ ...BASE, ...MEET, MEETINGS_GOOGLE_PICKER_API_KEY: 'AIzaSyFakeKeyForTestsOnly000000000000 x', MEETINGS_GOOGLE_PICKER_APP_ID: '123456789012' })).toThrow(/MEETINGS_GOOGLE_PICKER_API_KEY/);
    expect(() => loadConfig({ ...BASE, ...MEET, MEETINGS_GOOGLE_PICKER_API_KEY: PICKER.MEETINGS_GOOGLE_PICKER_API_KEY, MEETINGS_GOOGLE_PICKER_APP_ID: 'abc' })).toThrow(/MEETINGS_GOOGLE_PICKER_APP_ID/);
  });

  it('turn on the recording half of the Google adapter only when set', async () => {
    const credential = { accessToken: 't' };
    const off = meetingPlatformsOf(loadConfig({ ...BASE, ...MEET })).google_meet;
    const on = meetingPlatformsOf(loadConfig({ ...BASE, ...MEET, ...PICKER })).google_meet;
    await expect(off?.prepareDownload(credential, 'x', 'video')).rejects.toMatchObject({ message: expect.stringContaining('transcript only') });
    await expect(on?.prepareDownload(credential, 'x', 'video')).rejects.toMatchObject({ message: expect.stringContaining('not a recording') });
  });
});
