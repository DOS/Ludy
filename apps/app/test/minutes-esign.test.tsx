// SPDX-License-Identifier: AGPL-3.0-only
// "Ký biên bản họp" (Meetings, #4703): the settings card says whether signing minutes is on, only an owner or admin can change it, and the hook reads the setting as off while it loads. Rendered on the server.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import { catalog } from '../src/i18n/runtime.ts';

vi.mock('../src/lib/api.ts', () => {
  const opts = (key: string) => ({ queryOptions: () => ({ queryKey: [key], queryFn: () => Promise.reject(new Error('not fetched')) }), key: () => [key] });
  return {
    orpc: { meetings: { minutesEsign: { get: opts('esign'), set: { call: vi.fn() }, key: () => ['esign'] } }, org: { get: opts('org') } },
    queryClient: new (class {
      invalidateQueries() {
        return Promise.resolve();
      }
    })(),
    errorMessage: String,
  };
});
vi.mock('../src/lib/toast.ts', () => ({ toast: vi.fn() }));

const { MinutesEsignCard, useMinutesEsign } = await import('../src/components/minutes-esign.tsx');

const render = (enabled: boolean | null, role: string, locale: 'en' | 'vi' = 'en') => {
  const client = new QueryClient();
  if (enabled !== null) client.setQueryData(['esign'], { enabled });
  client.setQueryData(['org'], { role });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        <MinutesEsignCard />
      </IntlProvider>
    </QueryClientProvider>,
  );
};

describe('MinutesEsignCard', () => {
  it('shows the setting as off by default and as on once it is turned on, in Vietnamese and English', () => {
    expect(render(false, 'owner')).toContain(en.meetings.minutesEsign.stateOff);
    expect(render(true, 'owner')).toContain(en.meetings.minutesEsign.stateOn);
    expect(render(false, 'owner', 'vi')).toContain('Ký biên bản họp');
    expect(render(false, 'owner', 'vi')).toContain(viMessages.meetings.minutesEsign.stateOff);
    // Nothing is drawn until the setting is read.
    expect(render(null, 'owner')).toBe('');
  });

  it('lets an owner or admin turn it on or off, and tells a member only they can', () => {
    for (const role of ['owner', 'admin']) {
      expect(render(false, role)).toContain(en.meetings.minutesEsign.turnOn);
      expect(render(true, role)).toContain(en.meetings.minutesEsign.turnOff);
      expect(render(false, role)).not.toContain(en.meetings.minutesEsign.adminOnly);
    }
    const member = render(false, 'member');
    expect(member).toContain(en.meetings.minutesEsign.adminOnly);
    expect(member).not.toContain('minutes-esign-toggle');
  });

  it('keeps its words and the server error in both languages', () => {
    expect(en.meetings.minutesEsign.hint).toContain('Envelopes already made stay readable');
    expect(viMessages.meetings.minutesEsign.hint).toContain('Hồ sơ đã tạo vẫn xem được');
    expect(Object.keys(en.meetings.minutesEsign).sort()).toEqual(Object.keys(viMessages.meetings.minutesEsign).sort());
  });
});

describe('useMinutesEsign', () => {
  it('reads as off while the setting is not read and as on only when the server says so', () => {
    const read = (seed: boolean | null): boolean => {
      const client = new QueryClient();
      if (seed !== null) client.setQueryData(['esign'], { enabled: seed });
      let value = false;
      const Probe = () => {
        value = useMinutesEsign();
        return null;
      };
      renderToStaticMarkup(
        <QueryClientProvider client={client}>
          <Probe />
        </QueryClientProvider>,
      );
      return value;
    };
    expect(read(null)).toBe(false);
    expect(read(false)).toBe(false);
    expect(read(true)).toBe(true);
  });
});
