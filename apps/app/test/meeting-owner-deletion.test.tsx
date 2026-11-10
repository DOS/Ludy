// SPDX-License-Identifier: AGPL-3.0-only
// The owner's meeting deletion section of the personal-data screen (#2703), rendered on the server: an owner sees every meeting of the
// org as date, recorder, visibility, status and retention dates with a delete per row, never a title; an admin does not see the section.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import type { MeetingOwnerList } from '@crove/kernel-contract';
import { catalog } from '../src/i18n/runtime.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  client.current = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return () => ({ queryKey: path, queryFn: () => Promise.reject(new Error('not fetched')) });
        if (prop === 'mutationOptions') return () => ({});
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), client: {}, queryClient: client.current, errorMessage: (e: unknown) => String(e), isStepUpRequired: () => false };
});

vi.mock('../src/lib/auth.ts', async (importOriginal) => ({ ...(await importOriginal<object>()), getConfig: () => ({ modules: ['meetings'] }) }));

const { PersonalDataPage } = await import('../src/routes/personal-data.tsx');

const RECORDER = '00000000-0000-7000-8000-0000000000b1';
const page: MeetingOwnerList = {
  items: [
    {
      id: '00000000-0000-7000-8000-0000000000c1',
      recorderUserId: RECORDER,
      startedAt: '2026-11-01T02:00:00.000Z',
      visibility: 'attendees',
      status: 'completed',
      audioRetentionDate: '2027-02-01',
      videoRetentionDate: '2026-12-01',
      textRetentionDate: null,
    },
  ],
  next: { afterStartedAt: '2026-11-01T02:00:00.000Z', afterId: '00000000-0000-7000-8000-0000000000c1' },
};

function render(locale: 'vi' | 'en', role: 'owner' | 'admin'): string {
  const qc = client.current;
  qc.clear();
  qc.setQueryData(['org', 'get'], { role, members: [{ userId: RECORDER, displayName: 'Chị Lan', email: 'lan@example.test', role: 'member' }] });
  qc.setQueryData(['meetings', 'ownerList'], page);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        <PersonalDataPage />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('the owner meeting deletion section (#2703)', () => {
  it('shows an owner each meeting as metadata with a delete button, in Vietnamese', () => {
    const html = render('vi', 'owner');
    expect(html).toContain('data-testid="meeting-owner-deletion"');
    expect(html).toContain('Xóa cuộc họp');
    expect(html).toContain('Chị Lan');
    expect(html).toContain('Chỉ người tham dự');
    expect(html).toContain('Đã xong');
    expect(html).toContain('Chữ: giữ đến khi có người xóa');
    expect(html).toContain('Video: ');
    expect(html).toContain('Trang sau');
    expect(html.match(/data-testid="meeting-owner-row"/g)).toHaveLength(1);
  });

  it('labels the section in English', () => {
    const html = render('en', 'owner');
    expect(html).toContain('Meeting deletion');
    expect(html).toContain('Attendees only');
    expect(html).toContain('Text: kept until someone deletes it');
    expect(html).toContain('>Delete<');
  });

  it('is not shown to an admin', () => {
    expect(render('vi', 'admin')).not.toContain('data-testid="meeting-owner-deletion"');
  });
});
