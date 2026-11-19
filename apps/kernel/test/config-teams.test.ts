// SPDX-License-Identifier: AGPL-3.0-only
// The Microsoft Entra app of the Teams recording import (Meetings C4, #3176): off by default, both settings or neither, and the adapter exists only with both.
import { describe, expect, it } from 'vitest';
import { TeamsMeetingPlatform } from '@crove/channel';
import { MEETING_PLATFORM_OAUTH_PROVIDERS } from '@crove/kernel-contract';
import { loadConfig } from '../src/config.ts';
import { meetingPlatformsOf } from '../src/kernel.ts';

const BASE = { DATABASE_URL: 'postgres://localhost/x', AUTH_JWT_SECRET: 'x'.repeat(32), AUTH_ISSUER: 'crove-auth', WEB_DIST: '/nonexistent' };
// A made-up app (the shape of an Entra application id, nothing real).
const TEAMS = { TEAMS_OAUTH_CLIENT_ID: '11111111-2222-4333-8444-555555555555', TEAMS_OAUTH_CLIENT_SECRET: 'test-only-not-real' };

describe('TEAMS_OAUTH_CLIENT_ID and TEAMS_OAUTH_CLIENT_SECRET', () => {
  it('are off by default: no Teams adapter (the offline sandbox is a separate switch)', () => {
    const config = loadConfig({ ...BASE });
    expect(config.TEAMS_OAUTH_CLIENT_ID).toBeUndefined();
    expect(Object.keys(meetingPlatformsOf(config))).toEqual(['sandbox']);
    expect(Object.keys(meetingPlatformsOf(loadConfig({ ...BASE, CHANNEL_SANDBOX: 'false' })))).toEqual([]);
  });

  it('give the deployment a Teams adapter when both are set', () => {
    const adapters = meetingPlatformsOf(loadConfig({ ...BASE, ...TEAMS, CHANNEL_SANDBOX: 'false' }));
    expect(Object.keys(adapters)).toEqual(['microsoft_teams']);
    expect(adapters.microsoft_teams).toBeInstanceOf(TeamsMeetingPlatform);
    // The adapter's attempt name is one the database's credential functions accept (the connect step, which maps the provider to it, is the next PR).
    expect(MEETING_PLATFORM_OAUTH_PROVIDERS).toContain((adapters.microsoft_teams as TeamsMeetingPlatform).oauthProvider);
  });

  it('refuse one without the other, and an id that is not an application id', () => {
    expect(() => loadConfig({ ...BASE, TEAMS_OAUTH_CLIENT_ID: TEAMS.TEAMS_OAUTH_CLIENT_ID })).toThrow(/both TEAMS_OAUTH_CLIENT_ID and TEAMS_OAUTH_CLIENT_SECRET/);
    expect(() => loadConfig({ ...BASE, TEAMS_OAUTH_CLIENT_SECRET: TEAMS.TEAMS_OAUTH_CLIENT_SECRET })).toThrow(/both TEAMS_OAUTH_CLIENT_ID and TEAMS_OAUTH_CLIENT_SECRET/);
    expect(() => loadConfig({ ...BASE, ...TEAMS, TEAMS_OAUTH_CLIENT_ID: 'not-a-uuid' })).toThrow(/TEAMS_OAUTH_CLIENT_ID is the application/);
  });
});
