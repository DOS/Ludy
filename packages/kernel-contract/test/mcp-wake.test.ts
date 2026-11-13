// SPDX-License-Identifier: AGPL-3.0-only
// The wake-up webhook's receiver URL and schedule as the contract states them (ADR-0051 decision 4, issue #3024): the rule is pure, so the form, the API and the command all agree.
import { describe, expect, it } from 'vitest';
import { mcpWakeUrlProblem, zMcpWakeSet } from '../src/mcp.ts';

const grantId = '0197a1c2-7b3e-7c11-9a55-3f2d8e6b4a10';

describe('mcpWakeUrlProblem', () => {
  it('accepts an https URL on a public-looking name, with a path and a query', () => {
    for (const url of ['https://hooks.example.com/ludy', 'https://hooks.example.com/ludy/abc123?k=1&v=2', 'https://a.b.example.co.uk/x', 'https://hooks.example.com:443/x', 'https://bücher.example.com/x']) {
      expect(mcpWakeUrlProblem(url), url).toBeNull();
    }
  });

  it('refuses http, other schemes, an address, another port, credentials, a fragment, a private name and plain nonsense', () => {
    for (const url of [
      'http://hooks.example.com/x',
      'ftp://hooks.example.com/x',
      'javascript:alert(1)',
      'https://10.0.0.5/x',
      'https://127.0.0.1/x',
      'https://0x7f000001/x',
      'https://2130706433/x',
      'https://[::1]/x',
      'https://[fd00::1]/x',
      'https://hooks.example.com:8443/x',
      'https://user:pw@hooks.example.com/x',
      'https://hooks.example.com/x#frag',
      'https://localhost/x',
      'https://intranet/x',
      'https://printer.local/x',
      'https://db.internal/x',
      'not a url',
      '',
      `https://hooks.example.com/${'a'.repeat(2100)}`,
    ]) {
      expect(mcpWakeUrlProblem(url), url).not.toBeNull();
    }
  });
});

describe('zMcpWakeSet', () => {
  const base = { grantId, url: 'https://hooks.example.com/x' };

  it('defaults to enabled and no schedule, and takes a daily or weekly schedule with its time', () => {
    expect(zMcpWakeSet.parse(base)).toMatchObject({ enabled: true, schedule: 'off' });
    expect(zMcpWakeSet.parse({ ...base, schedule: 'daily', minute: 480 }).minute).toBe(480);
    expect(zMcpWakeSet.parse({ ...base, schedule: 'weekly', minute: 0, weekday: 7 }).weekday).toBe(7);
  });

  it('refuses a schedule without its time, a weekly one without its day, a time or day out of range, an unknown key and a bad URL', () => {
    for (const bad of [
      { ...base, schedule: 'daily' },
      { ...base, schedule: 'weekly', minute: 60 },
      { ...base, schedule: 'daily', minute: 1440 },
      { ...base, schedule: 'daily', minute: -1 },
      { ...base, schedule: 'weekly', minute: 60, weekday: 0 },
      { ...base, schedule: 'weekly', minute: 60, weekday: 8 },
      { ...base, schedule: 'hourly', minute: 60 },
      { ...base, secret: 'whsec_x' },
      { ...base, url: 'http://hooks.example.com/x' },
      { grantId: 'not-a-uuid', url: base.url },
    ]) {
      expect(zMcpWakeSet.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});
