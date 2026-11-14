// SPDX-License-Identifier: AGPL-3.0-only
// "Gửi biên bản tới địa chỉ của tôi" (Meetings A6, #3164), rendered on the server: the owner's switch (off by default), what a member sees while it is off, the sentence that
// the text leaves Ludy and cannot be recalled, the message when the server has no key to seal a secret, that no secret is ever drawn from the API's view, and the strings.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MEETING_HOOK_FIELDS, type MeetingHookView } from '@crove/kernel-contract';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import { catalog } from '../src/i18n/runtime.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  client.current = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return () => ({ queryKey: path, queryFn: () => Promise.reject(new Error('not fetched')) });
        if (prop === 'mutationOptions') return () => ({ mutationFn: () => Promise.resolve({}) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), queryClient: client.current, errorMessage: (e: unknown) => String(e) };
});

const { MeetingHookCard } = await import('../src/components/meeting-hook.tsx');

const view = (over: Partial<MeetingHookView> = {}): MeetingHookView => ({
  url: 'https://hooks.example.com/ludy',
  fields: ['title', 'summary'],
  enabled: true,
  pausedReason: null,
  secretHint: 'whk_0a1b2c3d',
  previousUntil: null,
  failingSince: null,
  consecutiveFailures: 0,
  lastDeliveryAt: null,
  lastStatus: null,
  createdAt: '2026-11-13T01:00:00.000Z',
  ...over,
});

function render(state: { switchOn: boolean; sealing?: boolean; hook?: MeetingHookView | null }, role: string, locale: 'en' | 'vi' = 'en'): string {
  client.current.setQueryData(['meetings', 'hook', 'get'], { sealing: true, hook: null, ...state });
  client.current.setQueryData(['org', 'get'], { role });
  return renderToStaticMarkup(
    <QueryClientProvider client={client.current}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        <MeetingHookCard />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('MeetingHookCard', () => {
  beforeEach(() => client.current.clear());

  it('is off until the owner turns it on: the owner sees the switch and how to turn it on, a member is told it is off, and no one sees a form', () => {
    const owner = render({ switchOn: false }, 'owner');
    expect(owner).toContain(en.meetings.hook.title);
    expect(owner).toContain('meeting-hook-switch');
    expect(owner).toContain(`>${en.meetings.hook.switchOff}<`);
    expect(owner).toContain(`>${en.meetings.hook.switchTurnOn}<`);
    expect(owner).toContain(en.meetings.hook.offOwner);
    expect(owner).not.toContain('<form');
    const member = render({ switchOn: false }, 'member');
    expect(member).not.toContain('meeting-hook-switch');
    expect(member).toContain(en.meetings.hook.offMember);
    expect(member).not.toContain(`>${en.meetings.hook.set}<`);
  });

  it('offers a member the setup once the owner turned it on, with the warning that text leaves Ludy and cannot be recalled, before anything is saved', () => {
    const html = render({ switchOn: true }, 'member');
    expect(html).not.toContain('meeting-hook-switch');
    expect(html).toContain(en.meetings.hook.notSet);
    expect(html).toContain(`>${en.meetings.hook.set}<`);
    expect(html).toContain('meeting-hook-warning');
    expect(html).toContain('cannot be recalled');
    const owner = render({ switchOn: true }, 'owner');
    expect(owner).toContain(`>${en.meetings.hook.switchOn}<`);
    expect(owner).toContain(`>${en.meetings.hook.switchTurnOff}<`);
    expect(owner).toContain(en.meetings.hook.switchOffNote.replace("'", '&#x27;'));
  });

  it('says so when the server has no key to seal a secret', () => {
    const html = render({ switchOn: true, sealing: false }, 'member');
    expect(html).toContain('meeting-hook-nosealing');
    expect(html).toContain('CREDENTIAL_KEY');
    expect(render({ switchOn: true, sealing: true }, 'member')).not.toContain('meeting-hook-nosealing');
  });

  it('shows a running hook, a paused one and a failing one, and never a secret', () => {
    const running = render({ switchOn: true, hook: view() }, 'member');
    expect(running).toContain(`>${en.meetings.hook.on}<`);
    expect(running).toContain(`>${en.meetings.hook.edit}<`);
    expect(running).not.toContain('whsec_');
    expect(running).not.toContain('meeting-hook-secret');
    expect(render({ switchOn: true, hook: view({ enabled: false, pausedReason: 'failing' }) }, 'member')).toContain(en.meetings.hook.pausedFailing);
    expect(render({ switchOn: true, hook: view({ consecutiveFailures: 3 }) }, 'member')).toContain('The last 3 sends failed');
  });

  it('words every field a member can tick, and the sentence about what is never sent, in both languages, and has no field for the transcript', () => {
    expect([...MEETING_HOOK_FIELDS]).toEqual(['title', 'summary', 'decisions', 'action_items']);
    for (const field of MEETING_HOOK_FIELDS) {
      expect(en.meetings.hook.field[field]).toBeTruthy();
      expect(viMessages.meetings.hook.field[field]).toBeTruthy();
    }
    expect(Object.keys(en.meetings.hook.field).join()).not.toMatch(/transcript|audio|video|attendee/);
    expect(en.meetings.hook.neverSent).toMatch(/transcript, audio, video/);
    expect(viMessages.meetings.hook.neverSent).toContain('bản ghi lời');
    expect(viMessages.meetings.hook.outside).toContain('không thu hồi được');
    expect(render({ switchOn: true }, 'member', 'vi')).toContain('Gửi biên bản tới địa chỉ của tôi');
  });
});
