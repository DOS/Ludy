// SPDX-License-Identifier: AGPL-3.0-only
// opensBusyWork (ADR-0053 section 4): the commands that open work an app's switch-off must wait for. The Meetings recording start and import start and the Ads launch, activation and manage begins (slice c C3a; the manage begin is W4, #3835). The exact list of what runs while an app is off (runsWhenOff) is in invariant/app-gate-keeping.test.ts.
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { moduleDefinitions } from '../src/kernel.ts';

const config = loadConfig({ DATABASE_URL: 'postgres://localhost/x', AUTH_JWT_SECRET: 'unit-test-jwt-secret-0123456789abcdef', AUTH_ISSUER: 'ludy-auth' });
const { commands } = moduleDefinitions(config);

describe('commands that open busy work', () => {
  it('are none yet', () => {
    expect((commands as Array<{ name: string; opensBusyWork?: true }>).filter((c) => c.opensBusyWork).map((c) => c.name).sort()).toEqual(['ads.activate.begin', 'ads.launch.begin', 'ads.manage.begin', 'meetings.import.start', 'meetings.meeting.create']);
  });
});
