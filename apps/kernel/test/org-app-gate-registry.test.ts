// SPDX-License-Identifier: AGPL-3.0-only
// opensBusyWork (ADR-0053 section 4): the commands that open work an app's switch-off must wait for. None yet: slice c adds the first (the Meetings
// recording start). The exact list of what runs while an app is off (runsWhenOff) is in invariant/app-gate-keeping.test.ts.
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { moduleDefinitions } from '../src/kernel.ts';

const config = loadConfig({ DATABASE_URL: 'postgres://localhost/x', AUTH_JWT_SECRET: 'unit-test-jwt-secret-0123456789abcdef', AUTH_ISSUER: 'crove-auth' });
const { commands } = moduleDefinitions(config);

describe('commands that open busy work', () => {
  it('are none yet', () => {
    expect((commands as Array<{ name: string; opensBusyWork?: true }>).filter((c) => c.opensBusyWork).map((c) => c.name)).toEqual([]);
  });
});
