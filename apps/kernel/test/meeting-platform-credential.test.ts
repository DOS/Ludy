// SPDX-License-Identifier: AGPL-3.0-only
// The credential a meeting platform job uses (issue #3878): opened, and renewed first when it is about to expire. The command that renews it (a row lock, one provider call, the new pair stored in the same
// transaction) is tested against PostgreSQL in meeting-platform-refresh.db.test.ts; here the decisions of the caller: when it asks for a renewal, what it does with each answer, and that nothing is
// asked of a credential that is not due.
import { describe, expect, it } from 'vitest';
import { MeetingPlatformError, SandboxMeetingPlatform, meetingPlatformCallOf, normalizeMeetingPlatformCall, type MeetingPlatformAdapter } from '@ludy/channel';
import { captureCallOf, normalizeCaptureCall } from '@ludy/kernel-contract';
import { REFRESH_HORIZON_MS, freshCredential, parseCredential, withinTimeout, type RefreshOutcome } from '../src/meeting-platform-credential.ts';

const NOW = new Date('2026-11-18T12:00:00Z');
const ORG = '00000000-0000-4000-8000-000000000001';
const CONNECTION = '00000000-0000-4000-8000-000000000003';
const refresher: MeetingPlatformAdapter = { provider: 'zoom', hosts: [], list: async () => [], prepareDownload: async () => Promise.reject(new Error('not reached')), refresh: async () => ({ accessToken: 'unused' }) };
const iso = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();

// A runtime whose stored credential is a text; `answers` are what the renewal command says, in order, and a `refreshed` answer replaces the text as the command does.
function harness(secret: Record<string, unknown>, answers: Array<RefreshOutcome | Error> = []) {
  let stored = JSON.stringify(secret);
  const calls: Array<{ name: string; input: unknown }> = [];
  let reads = 0;
  const runtime = {
    query: async (name: string) => {
      expect(name).toBe('kernel.meeting_platform.credential');
      reads += 1;
      return { keyId: 'k1', envelope: Buffer.from(stored).toString('base64'), provider: 'zoom', externalAccount: 'host@zoom.test' };
    },
    execute: async (name: string, input: unknown) => {
      calls.push({ name, input });
      const answer = answers.shift() ?? { outcome: 'fresh' as const };
      if (answer instanceof Error) throw answer;
      if (answer.outcome === 'refreshed') stored = JSON.stringify({ accessToken: 'new-access', refreshToken: 'new-refresh', expiresAt: answer.expiresAt });
      return answer;
    },
  };
  const broker = { id: 'test', open: (sealed: { envelope: Buffer }) => sealed.envelope.toString(), seal: () => ({ keyId: 'k1', envelope: Buffer.alloc(0) }) };
  return { deps: { runtime: runtime as never, broker: broker as never, now: () => NOW }, calls, reads: () => reads };
}

describe('parseCredential', () => {
  it('reads the access token, and the refresh token and the expiry when they are there', () => {
    expect(parseCredential(JSON.stringify({ accessToken: 'a', refreshToken: 'r', expiresAt: iso(1000) }))).toEqual({ accessToken: 'a', refreshToken: 'r', expiresAt: new Date(iso(1000)) });
    expect(parseCredential(JSON.stringify({ accessToken: 'a' }))).toEqual({ accessToken: 'a' });
    expect(parseCredential(JSON.stringify({ accessToken: 'a', refreshToken: '', expiresAt: 'not a date' }))).toEqual({ accessToken: 'a' });
  });

  it('refuses a credential with no access token (the connection must be made again) and a text that is not JSON', () => {
    expect(() => parseCredential(JSON.stringify({ refreshToken: 'r' }))).toThrow(MeetingPlatformError);
    expect(() => parseCredential(JSON.stringify({ accessToken: '' }))).toThrow(MeetingPlatformError);
    expect(() => parseCredential('not json')).toThrow(SyntaxError);
  });
});

describe('parseCredential secrets', () => {
  it('never quotes the text of a credential in an error: a text that is not JSON says only that it is not', () => {
    for (const text of ['refresh-token-secret-xyz {', '"just a string"', 'null', '[1]']) {
      let message = '';
      try {
        parseCredential(text);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        message = String((error as Error).message);
      }
      expect(message, text).not.toContain('secret-xyz');
      expect(message, text).not.toContain('just a string');
    }
    expect(() => parseCredential('refresh-token-secret-xyz {')).toThrow(SyntaxError);
  });
});

describe('withinTimeout', () => {
  it('lets a call that finishes in time answer, and clears its timer', async () => {
    expect(await withinTimeout(async () => 'ok', 1000)).toBe('ok');
  });

  it('abandons a call that ignores its signal after the limit, with platform_unavailable, and aborts the signal', async () => {
    let signalSeen: AbortSignal | undefined;
    const slow = (signal: AbortSignal) => {
      signalSeen = signal;
      return new Promise<string>((resolve) => setTimeout(() => resolve('late'), 300));
    };
    const started = Date.now();
    await expect(withinTimeout(slow, 40)).rejects.toMatchObject({ code: 'platform_unavailable' });
    expect(Date.now() - started).toBeLessThan(250);
    expect(signalSeen?.aborted).toBe(true);
  });

  it('lets a call that fails fail with its own error', async () => {
    await expect(withinTimeout(() => Promise.reject(new MeetingPlatformError('connection_expired')), 1000)).rejects.toMatchObject({ code: 'connection_expired' });
  });
});

describe('freshCredential', () => {
  it('uses a credential that is not due as it is, and asks nothing of the command', async () => {
    const { deps, calls } = harness({ accessToken: 'a', refreshToken: 'r', expiresAt: iso(REFRESH_HORIZON_MS + 60_000) });
    expect(await freshCredential(deps, ORG, CONNECTION, refresher)).toEqual({ accessToken: 'a', refreshToken: 'r', expiresAt: new Date(iso(REFRESH_HORIZON_MS + 60_000)) });
    expect(calls).toEqual([]);
  });

  it('leaves alone a credential with no expiry, and a provider that cannot refresh (the sandbox), however near the end', async () => {
    const none = harness({ accessToken: 'a', refreshToken: 'r' });
    expect((await freshCredential(none.deps, ORG, CONNECTION, refresher)).accessToken).toBe('a');
    expect(none.calls).toEqual([]);
    const sandbox = harness({ accessToken: 'a', refreshToken: 'r', expiresAt: iso(-1000) });
    expect((await freshCredential(sandbox.deps, ORG, CONNECTION, new SandboxMeetingPlatform())).accessToken).toBe('a');
    expect(sandbox.calls).toEqual([]);
  });

  it('asks the command, once, for a credential that expires within the horizon (or already did), and uses the pair it stored', async () => {
    for (const offset of [REFRESH_HORIZON_MS - 1000, 60_000, -3_600_000]) {
      const { deps, calls } = harness({ accessToken: 'old', refreshToken: 'r', expiresAt: iso(offset) }, [{ outcome: 'refreshed', expiresAt: iso(3_600_000) }]);
      const credential = await freshCredential(deps, ORG, CONNECTION, refresher);
      expect(credential, String(offset)).toEqual({ accessToken: 'new-access', refreshToken: 'new-refresh', expiresAt: new Date(iso(3_600_000)) });
      expect(calls, String(offset)).toEqual([{ name: 'kernel.meeting_platform.credential_refresh', input: { connectionId: CONNECTION } }]);
    }
  });

  it('uses the pair another worker stored while this one waited for the lock (the command says it was not due any more)', async () => {
    const { deps, calls, reads } = harness({ accessToken: 'old', refreshToken: 'r', expiresAt: iso(60_000) }, [{ outcome: 'fresh' }]);
    expect((await freshCredential(deps, ORG, CONNECTION, refresher)).accessToken).toBe('old');
    expect(calls).toHaveLength(1);
    // It reads the credential again after the command, so a pair stored meanwhile is the one it uses.
    expect(reads()).toBe(2);
  });

  it('says the connection expired when the provider refused the grant', async () => {
    const { deps } = harness({ accessToken: 'old', refreshToken: 'r', expiresAt: iso(60_000) }, [{ outcome: 'expired' }]);
    await expect(freshCredential(deps, ORG, CONNECTION, refresher)).rejects.toMatchObject({ code: 'connection_expired' });
  });

  it('goes on with the token in hand when the provider could not be reached and it still has time, and fails as unavailable when it has not', async () => {
    const open = harness({ accessToken: 'still-good', refreshToken: 'r', expiresAt: iso(60_000) }, [{ outcome: 'unavailable' }]);
    expect((await freshCredential(open.deps, ORG, CONNECTION, refresher)).accessToken).toBe('still-good');
    const dead = harness({ accessToken: 'dead', refreshToken: 'r', expiresAt: iso(-1000) }, [{ outcome: 'unavailable' }]);
    await expect(freshCredential(dead.deps, ORG, CONNECTION, refresher)).rejects.toMatchObject({ code: 'platform_unavailable' });
  });

  it('uses the credential as it is when the command has nothing to do (not active, no refresh token, no refresh)', async () => {
    for (const outcome of ['not_active', 'unsupported', 'no_refresh_token'] as const) {
      const { deps } = harness({ accessToken: 'a', refreshToken: 'r', expiresAt: iso(60_000) }, [{ outcome }]);
      expect((await freshCredential(deps, ORG, CONNECTION, refresher)).accessToken, outcome).toBe('a');
    }
  });

  it('lets an error of the command through (a lock that timed out, a database error): the caller retries, and the old token is not used blindly', async () => {
    const { deps } = harness({ accessToken: 'a', refreshToken: 'r', expiresAt: iso(60_000) }, [new Error('lock timeout')]);
    await expect(freshCredential(deps, ORG, CONNECTION, refresher)).rejects.toThrow('lock timeout');
  });
});

describe('meetingPlatformCallOf parity with captureCallOf', () => {
  it('agrees with @ludy/kernel-contract captureCallOf and normalizeCaptureCall on every address and raw id', () => {
    const thread = '19:meeting_Nzk1YTQzMjMtMGFhZS00ZDQ1LThhYzMtNzU3MDIxYzFmNmVk@thread.v2';
    for (const url of [
      'https://meet.google.com/abc-defg-hij',
      'https://meet.google.com/ABC-defg-HIJ/?authuser=1',
      'https://us02web.zoom.us/j/81234567890?pwd=secret',
      'https://congty.zoom.us/wc/join/81234567890',
      `https://teams.microsoft.com/l/meetup-join/${encodeURIComponent(thread)}/0?context=%7b%22Tid%22%3a%221%22%7d`,
      'https://teams.microsoft.com/meet/123456789012?p=abc',
      'https://meet.google.com/landing',
      'https://meet.google.com.evil.example/abc-defg-hij',
      'http://zoom.us/j/81234567890',
      'https://zoom.us/j/123',
      'not a url',
    ]) {
      expect(meetingPlatformCallOf(url), url).toEqual(captureCallOf(url));
    }
    for (const call of [
      { platform: 'google_meet', id: 'ABC-defg-HIJ' },
      { platform: 'zoom', id: '81234567890' },
      { platform: 'microsoft_teams', id: thread },
      { platform: 'microsoft_teams', id: '123456789012' },
      { platform: 'zoom', id: '123' },
      { platform: 'sandbox', id: 'abc-defg-hij' },
    ]) {
      expect(normalizeMeetingPlatformCall(call), JSON.stringify(call)).toEqual(normalizeCaptureCall(call));
    }
  });
});
