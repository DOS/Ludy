// SPDX-License-Identifier: AGPL-3.0-only
// Authenticated oRPC wiring tests for os.calendar.connectFinish and os.calendar.disconnect (#3246):
// verifies clearAgenda (meetings.agenda.clear) is invoked on disconnect and on reconnect without event-reading scopes,
// skipped when event-reading scopes are present, and stays best-effort when meetings.agenda.clear fails.
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import type { CalendarAdapter } from '@ludy/channel';
import { GOOGLE_CALENDAR_EVENTS_READ_SCOPE, MICROSOFT_CALENDAR_READ_SCOPE } from '@ludy/kernel-contract';
import { CredentialVault, DomainError, parseVaultKey, type BlobStore, type Runtime } from '@ludy/kernel-runtime';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { AuthUser } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';

const ORG_ID = '01900000-0000-7000-8000-000000000010';
const USER_ID = '01900000-0000-7000-8000-000000000020';
const CONNECTION_ID = '01900000-0000-7000-8000-000000000030';
const VALID_STATE = 'A'.repeat(43);

const WEB_DIST = mkdtempSync(join(tmpdir(), 'ludy-calendar-rpc-'));
writeFileSync(join(WEB_DIST, 'index.html'), '<!doctype html><title>Ludy</title>');

afterAll(() => {
  rmSync(WEB_DIST, { recursive: true, force: true });
});

function buildUser(): AuthUser {
  return {
    userId: USER_ID,
    email: 'member@example.com',
    name: 'Member',
    aal: 'aal1',
    sessionId: 'sess-1',
    mfaAt: null,
  };
}

function buildConfig() {
  return loadConfig({
    DATABASE_URL: 'postgres://localhost/x',
    AUTH_JWT_SECRET: 'x'.repeat(32),
    AUTH_ISSUER: 'ludy-auth',
    AUTH_UPSTREAM_URL: 'http://127.0.0.1:9',
    STATUS_FILE: join(WEB_DIST, 'status.json').replace(/^[A-Za-z]:[\\/]/, '/').replace(/\\/g, '/'),
    WEB_DIST,
  });
}

function stubAdapter(
  provider: 'google' | 'microsoft',
  oauthProvider: 'google_calendar' | 'microsoft_calendar',
  scopes: string[],
): CalendarAdapter {
  return {
    provider,
    oauthProvider,
    pkce: true,
    authorizeUrl: () => 'https://example.test/auth',
    exchange: async () => ({
      externalAccount: 'member@example.com',
      displayName: 'Member Calendar',
      scopes,
      expiresAt: new Date(Date.now() + 3_600_000),
      secret: JSON.stringify({ accessToken: 'access-1', refreshToken: 'refresh-1' }),
    }),
    refresh: async () => ({ failed: 'unused' }),
    busy: async () => ({ busy: [] }),
    revoke: async () => ({ revoked: true }),
    events: async () => ({ events: [] }),
    writeEvent: async () => ({ ok: true }),
    removeEvent: async () => ({ ok: true }),
  };
}

function createCalendarTestApp(options: {
  googleScopes?: string[];
  microsoftScopes?: string[];
  clearFails?: boolean;
  reconnected?: boolean;
}) {
  const executed: Array<{ name: string; input: unknown; opts: unknown }> = [];
  const fakeDb = {
    getExecutor: () => ({
      transformQuery: (node: unknown) => node,
      compileQuery: () => ({ query: {}, sql: '', parameters: [] }),
      executeQuery: async () => ({
        rows: [{ org_id: ORG_ID, slug: 'acme', name: 'Acme', role: 'member' }],
      }),
    }),
  };

  const runtime = {
    installed: () => true,
    modules: () => ['kernel', 'meetings'],
    forUser: async <T>(_actor: unknown, fn: (db: never) => Promise<T>) => fn(fakeDb as never),
    query: vi.fn(async () => null),
    execute: vi.fn(async (name: string, input: unknown, opts: unknown) => {
      executed.push({ name, input, opts });
      if (name === 'kernel.calendar.oauth_consume') return { codeVerifier: 'verifier-1' };
      if (name === 'kernel.calendar.connect') {
        return { connectionId: CONNECTION_ID, reconnected: options.reconnected ?? true };
      }
      if (name === 'kernel.calendar.disconnect') {
        return { connectionId: CONNECTION_ID, disconnected: true };
      }
      if (name === 'meetings.agenda.clear') {
        if (options.clearFails) throw new DomainError('UNKNOWN_COMMAND', 404, 'meetings module is not installed');
        return { connectionId: CONNECTION_ID, cleared: 2 };
      }
      return {};
    }),
  } as unknown as Runtime;

  const vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
  const app = createHttpApp({
    config: buildConfig(),
    runtime,
    store: {} as BlobStore,
    authenticate: async () => buildUser(),
    pool: {} as pg.Pool,
    aiEnabled: false,
    channels: {
      broker: vault,
      sandbox: false,
      publicUrl: 'https://app.example.test',
      calendars: {
        google_calendar: stubAdapter('google', 'google_calendar', options.googleScopes ?? ['https://www.googleapis.com/auth/calendar.freebusy']),
        microsoft_calendar: stubAdapter('microsoft', 'microsoft_calendar', options.microsoftScopes ?? ['openid', 'profile', 'email']),
      },
    },
  });

  return { app, executed };
}

async function callRpc(app: ReturnType<typeof createHttpApp>, path: string, json: unknown) {
  return app.request(`/api/rpc${path}`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer test-token',
      'x-ludy-org': 'acme',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ json }),
  });
}

describe('os.calendar RPC clearAgenda wiring (#3246)', () => {
  it('invokes meetings.agenda.clear after kernel.calendar.disconnect', async () => {
    const { app, executed } = createCalendarTestApp({});
    const res = await callRpc(app, '/calendar/disconnect', { connectionId: CONNECTION_ID });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ json: { connectionId: CONNECTION_ID, disconnected: true } });
    expect(executed.map((c) => c.name)).toEqual(['kernel.calendar.disconnect', 'meetings.agenda.clear']);
    expect(executed[1]).toMatchObject({
      name: 'meetings.agenda.clear',
      input: { connectionId: CONNECTION_ID },
      opts: { orgId: ORG_ID, actor: { type: 'user', userId: USER_ID } },
    });
  });

  it('invokes meetings.agenda.clear on connectFinish when the grant lacks event-reading scopes (Google and Microsoft)', async () => {
    for (const provider of ['google_calendar', 'microsoft_calendar'] as const) {
      const { app, executed } = createCalendarTestApp({ reconnected: true });
      const res = await callRpc(app, '/calendar/connectFinish', {
        provider,
        state: VALID_STATE,
        code: 'oauth-code-1',
      });
      expect(res.status, provider).toBe(200);
      expect(await res.json()).toEqual({
        json: { connectionId: CONNECTION_ID, reconnected: true, displayName: 'Member Calendar' },
      });
      expect(executed.map((c) => c.name), provider).toEqual([
        'kernel.calendar.oauth_consume',
        'kernel.calendar.connect',
        'meetings.agenda.clear',
      ]);
      expect(executed[2]).toMatchObject({
        name: 'meetings.agenda.clear',
        input: { connectionId: CONNECTION_ID },
        opts: { orgId: ORG_ID, actor: { type: 'user', userId: USER_ID } },
      });
    }
  });

  it('does not invoke meetings.agenda.clear on connectFinish when the grant carries event-reading scopes', async () => {
    const { app, executed } = createCalendarTestApp({
      googleScopes: ['https://www.googleapis.com/auth/calendar.freebusy', GOOGLE_CALENDAR_EVENTS_READ_SCOPE],
      microsoftScopes: ['openid', 'profile', 'email', MICROSOFT_CALENDAR_READ_SCOPE],
      reconnected: true,
    });
    for (const provider of ['google_calendar', 'microsoft_calendar'] as const) {
      executed.length = 0;
      const res = await callRpc(app, '/calendar/connectFinish', {
        provider,
        state: VALID_STATE,
        code: 'oauth-code-2',
      });
      expect(res.status, provider).toBe(200);
      expect(executed.map((c) => c.name), provider).toEqual([
        'kernel.calendar.oauth_consume',
        'kernel.calendar.connect',
      ]);
    }
  });

  it('keeps disconnect and reconnect best-effort when meetings.agenda.clear fails', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { app, executed } = createCalendarTestApp({ clearFails: true });
      const discRes = await callRpc(app, '/calendar/disconnect', { connectionId: CONNECTION_ID });
      expect(discRes.status).toBe(200);
      expect(await discRes.json()).toEqual({ json: { connectionId: CONNECTION_ID, disconnected: true } });

      const connRes = await callRpc(app, '/calendar/connectFinish', {
        provider: 'google_calendar',
        state: VALID_STATE,
        code: 'oauth-code-3',
      });
      expect(connRes.status).toBe(200);
      expect(await connRes.json()).toEqual({
        json: { connectionId: CONNECTION_ID, reconnected: true, displayName: 'Member Calendar' },
      });
      expect(executed.filter((c) => c.name === 'meetings.agenda.clear')).toHaveLength(2);
      expect(errSpy).toHaveBeenCalledTimes(2);
      expect(errSpy.mock.calls.map((c) => String(c[0]))).toEqual([
        `[calendar] cached meetings of connection ${CONNECTION_ID.slice(0, 8)} not cleared: UNKNOWN_COMMAND`,
        `[calendar] cached meetings of connection ${CONNECTION_ID.slice(0, 8)} not cleared: UNKNOWN_COMMAND`,
      ]);
    } finally {
      errSpy.mockRestore();
    }
  });
});
