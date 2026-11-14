// SPDX-License-Identifier: AGPL-3.0-only
// The always-visible recording chip (Meetings A1, #3159): shown while this member records in the app or with the extension,
// gone when the recording stops, and the recording notice's version is the one the server stores. Rendered on the server.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { CONSENT_NOTICE_VERSION } from '@crove/kernel-contract';
import { RECORDING_NOTICE } from '@crove/meeting-recorder';
import { catalog } from '../src/i18n/runtime.ts';

const remote = vi.hoisted(() => ({ recording: null as null | { meetingId: string; startedAt: string } }));

vi.mock('../src/lib/api.ts', () => ({
  orpc: { meetings: { recordingNow: { queryOptions: () => ({ queryKey: ['recordingNow'], queryFn: () => Promise.resolve({ recording: remote.recording }) }) } } },
}));
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const { createElement } = await import('react');
  return {
    ...(await importOriginal<object>()),
    useParams: () => ({ slug: 'acme' }),
    Link: ({ children, to, params: _params, className: _class, ...rest }: { children?: ReactNode; to: string; params?: unknown; className?: string }) => createElement('a', { href: to, ...rest }, children),
  };
});

const { RecordingChip } = await import('../src/components/recording-chip.tsx');
const { setLocalRecording } = await import('../src/lib/recording-indicator.ts');

const render = (seed?: { meetingId: string; startedAt: string }) => {
  const client = new QueryClient();
  if (seed) client.setQueryData(['recordingNow'], { recording: seed });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={catalog('en')}>
        <RecordingChip />
      </IntlProvider>
    </QueryClientProvider>,
  );
};

describe('RecordingChip', () => {
  it('shows nothing when nothing records', () => {
    setLocalRecording(null);
    expect(render()).not.toContain('recording-chip');
  });

  it('shows the in-app recording with its time, and its pause', () => {
    setLocalRecording({ meetingId: 'm1', title: 'Họp', paused: false, elapsedMs: () => 751_000 });
    expect(render()).toContain('Recording 12:31');
    setLocalRecording({ meetingId: 'm1', title: 'Họp', paused: true, elapsedMs: () => 751_000 });
    expect(render()).toContain('Paused 12:31');
  });

  it('goes when the in-app recording stops', () => {
    setLocalRecording({ meetingId: 'm1', title: 'Họp', paused: false, elapsedMs: () => 1000 });
    expect(render()).toContain('recording-chip');
    setLocalRecording(null);
    expect(render()).not.toContain('recording-chip');
  });

  it('shows an extension recording read from the server, counted from its start, and links to the meeting', () => {
    setLocalRecording(null);
    const html = render({ meetingId: 'm2', startedAt: new Date(Date.now() - 65_000).toISOString() });
    expect(html).toContain('data-source="extension"');
    expect(html).toMatch(/Recording 0[01]:0\d|Recording 01:0\d/);
    expect(html).toContain('/o/$slug/meetings/$id');
  });
});

describe('the notice version', () => {
  it('is the version the server stores', () => {
    expect(RECORDING_NOTICE.version).toBe(CONSENT_NOTICE_VERSION);
  });
});
