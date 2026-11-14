// SPDX-License-Identifier: AGPL-3.0-only
// The "Sắp họp" card (B2, #3166): the agenda scope is asked for only when the member chooses it, a damaged answer draws no card, the line names the service of a join host and never an
// address, and the client reads the next meetings from the one route the agenda scope opens, with the token, and nothing else.
import { describe, expect, it } from 'vitest';
import { AGENDA_SCOPE, agendaLine, readAgendaNext, serviceOfHost, signInScopes } from '../src/agenda.ts';
import { connectUrl, newPkce } from '../src/auth.ts';
import { createClient, LudyError } from '../src/api.ts';
import { FEATURES } from '../src/features.ts';
import { ENGLISH, VIETNAMESE } from '../src/strings.ts';

const event = { title: 'Họp giao ban', startsAt: '2026-11-14T02:00:00.000Z', endsAt: '2026-11-14T03:00:00.000Z', joinHost: 'meet.google.com' };

describe('the agenda scope in the sign-in', () => {
  it('is left out of the plain sign-in and added when the member chose it', async () => {
    const pkce = await newPkce();
    const scopes = (withAgenda?: boolean) => new URL(connectUrl('https://ludy.example', pkce, 'https://x.chromiumapp.org/connect', 'Tiện ích', withAgenda)).searchParams.get('scope');
    expect(scopes()).toBe(FEATURES.map((f) => f.scope).join(' '));
    expect(scopes(false)).not.toContain(AGENDA_SCOPE);
    expect(scopes(true)?.split(' ')).toEqual([...FEATURES.map((f) => f.scope), AGENDA_SCOPE]);
    expect(signInScopes(['meetings'], false)).toEqual(['meetings']);
    expect(signInScopes(['meetings'], true)).toEqual(['meetings', 'agenda']);
  });
});

describe('the answer of the next-meetings read', () => {
  it('keeps a well-formed answer, with at most 5 events and the title cut at 200', () => {
    expect(readAgendaNext({ json: { enabled: true, events: [event] } })).toEqual({ enabled: true, events: [event] });
    expect(readAgendaNext({ enabled: false, events: [] })).toEqual({ enabled: false, events: [] });
    expect(readAgendaNext({ json: { enabled: true, events: [{ ...event, title: 'x'.repeat(300), joinHost: null }] } })?.events[0]?.title).toHaveLength(200);
  });

  it('draws nothing for a damaged answer', () => {
    expect(readAgendaNext(null)).toBeNull();
    expect(readAgendaNext('x')).toBeNull();
    expect(readAgendaNext({ json: { enabled: 'yes', events: [] } })).toBeNull();
    expect(readAgendaNext({ json: { enabled: true, events: [event, event, event, event, event, event] } })).toBeNull();
    expect(readAgendaNext({ json: { enabled: true, events: [{ ...event, startsAt: 'not a time' }] } })).toBeNull();
    expect(readAgendaNext({ json: { enabled: true, events: [{ ...event, title: 7 }] } })).toBeNull();
    expect(readAgendaNext({ json: { enabled: true, events: [{ ...event, joinHost: 7 }] } })).toBeNull();
    expect(readAgendaNext({ json: { enabled: true, events: [42] } })).toBeNull();
  });
});

describe('the card line', () => {
  it('names the service of a join host, and never an address', () => {
    expect(serviceOfHost('meet.google.com')).toBe('meet');
    expect(serviceOfHost('us02web.zoom.us')).toBe('zoom');
    expect(serviceOfHost('zoom.us')).toBe('zoom');
    expect(serviceOfHost('teams.microsoft.com')).toBe('teams');
    expect(serviceOfHost('evil.example')).toBeNull();
    expect(serviceOfHost('notzoom.us')).toBeNull();
    expect(serviceOfHost(null)).toBeNull();
    const line = agendaLine(VIETNAMESE.agendaLine, VIETNAMESE.agendaUntitled, event, 'vi-VN');
    expect(line).toContain('Sắp họp: Họp giao ban');
    expect(line).toContain('(Google Meet)');
    expect(line).not.toContain('http');
    expect(agendaLine(ENGLISH.agendaLine, ENGLISH.agendaUntitled, { ...event, title: ' ', joinHost: null }, 'en-US')).toMatch(/^Starting soon: \(no title\) /);
  });
});

describe('the client', () => {
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('asks the one route of the agenda scope with the token and reads the answer', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const client = createClient('https://ludy.example', 'crx_token', async (url, init) => (calls.push({ url, init }), answer({ json: { enabled: true, events: [event] } })));
    expect(await client.agendaNext()).toEqual({ enabled: true, events: [event] });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://ludy.example/api/rpc/meetings/agenda/next');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBe('Bearer crx_token');
    expect(calls[0]?.init?.credentials).toBe('omit');
  });

  it('throws the HTTP status for a token without the scope, and answers null for a damaged answer', async () => {
    const refused = createClient('https://ludy.example', 'crx_token', async () => answer({ code: 'FORBIDDEN' }, 403));
    await expect(refused.agendaNext()).rejects.toMatchObject({ status: 403 });
    await expect(refused.agendaNext()).rejects.toBeInstanceOf(LudyError);
    expect(await createClient('https://ludy.example', 'crx_token', async () => answer({ json: { enabled: 1 } })).agendaNext()).toBeNull();
  });
});
