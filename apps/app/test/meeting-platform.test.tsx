// SPDX-License-Identifier: AGPL-3.0-only
// The three screens of the meeting platform import (C1, #3173): the Settings card, the card on the Meetings tab with the import dialog's form, and the claim of the copied audio. They render
// from the data the server returned; the clicks themselves are the server's commands, tested in apps/kernel/test/meetings.db.test.ts.
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { MEETING_PLATFORM_ERROR_CODES, type MeetingPlatformConnectionView, type MeetingPlatformRecordingView } from '@crove/kernel-contract';
import { IMPORT_NOTICE } from '@crove/meeting-recorder';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import { catalog } from '../src/i18n/runtime.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));
const config = vi.hoisted(() => ({ modules: ['kernel', 'meetings'] as string[], sandbox: true }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  client.current = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return () => ({ queryKey: path, queryFn: () => Promise.reject(new Error('not fetched')) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), queryClient: client.current, errorMessage: (e: unknown) => `ERR:${(e as Error).message}`, claimImportedMedia: vi.fn() };
});
vi.mock('../src/lib/auth.ts', () => ({ getConfig: () => ({ modules: config.modules, channels: { sandbox: config.sandbox } }) }));
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const { createElement } = await import('react');
  return {
    ...(await importOriginal<object>()),
    Link: ({ children, to, params, ...rest }: { children?: ReactNode; to: string; params?: Record<string, string>; 'data-testid'?: string }) =>
      createElement('a', { href: to, 'data-testid': rest['data-testid'], 'data-params': JSON.stringify(params ?? {}) }, children),
  };
});

const { MeetingPlatforms } = await import('../src/components/meeting-platforms.tsx');
const { PlatformRecordings, ImportForm } = await import('../src/components/meeting-recordings.tsx');
const { ImportAutoClaim } = await import('../src/components/meeting-import-claim.tsx');

const connection = (over: Partial<MeetingPlatformConnectionView> = {}): MeetingPlatformConnectionView => ({
  id: 'c1',
  provider: 'sandbox',
  displayName: 'Nền tảng họp thử nghiệm',
  status: 'active',
  statusReason: null,
  lastSyncedAt: '2026-11-14T02:00:00.000Z',
  connectedAt: '2026-11-13T02:00:00.000Z',
  ...over,
});
const recording = (over: Partial<MeetingPlatformRecordingView> = {}): MeetingPlatformRecordingView => ({
  id: 'r1',
  connectionId: 'c1',
  provider: 'sandbox',
  title: 'Họp khách A',
  startedAt: '2026-11-14T02:00:00.000Z',
  lengthSeconds: 3900,
  sizeBytes: 5 * 1024 * 1024,
  hasAudio: true,
  hasVideo: false,
  hasTranscript: false,
  status: 'suggested',
  meetingId: null,
  errorCode: null,
  ...over,
});

const wrap = (node: ReactNode, locale: 'en' | 'vi' = 'en') => (
  <QueryClientProvider client={client.current}>
    <IntlProvider locale={locale} messages={catalog(locale)}>
      {node}
    </IntlProvider>
  </QueryClientProvider>
);
const reset = () => {
  client.current.clear();
  // The signed-in member's role: a member by default (the Meetings tab offers "Nhập" only to someone who may import).
  client.current.setQueryData(['org', 'get'], { role: 'member' });
  config.modules = ['kernel', 'meetings'];
  config.sandbox = true;
};
// Text as the server renderer writes it (quotes and apostrophes are escaped).
const esc = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#x27;');
const count = (html: string, needle: string) => html.split(needle).length - 1;
const KEYS = { connections: ['meetingPlatform', 'connections'], recordings: ['meetingPlatform', 'recordings'], policy: ['meetings', 'consentPolicy', 'get'] };
// A query that failed on its last read. It keeps data (an empty list) so the server render, which would otherwise read again on mount, shows the error as the browser does after a failed read.
const failQuery = (key: string[], message: string) => {
  client.current.setQueryData(key, []);
  client.current.getQueryCache().find({ queryKey: key })!.setState({ status: 'error', error: new Error(message), fetchStatus: 'idle', errorUpdateCount: 1 });
};
const disabledSubmit = (html: string) => /<button[^>]*data-testid="meeting-import-submit"[^>]*>/.exec(html)?.[0] ?? '';

describe('MeetingPlatforms (Settings)', () => {
  it('lists the connection with its provider, account, status and last listing, and a refresh and a disconnect button', () => {
    reset();
    client.current.setQueryData(KEYS.connections, [connection()]);
    const html = renderToStaticMarkup(wrap(<MeetingPlatforms canConnect />));
    expect(html).toContain('data-testid="meeting-platforms"');
    expect(html).toContain(en.meetings.platform.settings.title);
    expect(count(html, 'data-testid="meeting-platform-connection"')).toBe(1);
    expect(html).toContain(esc(en.meetings.platform.provider.sandbox));
    expect(html).toContain('Nền tảng họp thử nghiệm');
    expect(html).toContain(en.meetings.platform.settings.statusActive);
    expect(html).toContain(en.meetings.platform.settings.refresh);
    expect(html).toContain(en.meetings.platform.settings.disconnect);
    expect(html).not.toContain('meeting-platform-confirm');
    expect(html).not.toContain('meeting-platform-reason');
    expect(html).toContain(en.meetings.platform.settings.moreLater);
  });

  it('says why a listing failed and that an expired connection must be connected again, in words', () => {
    reset();
    client.current.setQueryData(KEYS.connections, [connection({ status: 'expired', statusReason: 'connection_expired' }), connection({ id: 'c2', statusReason: 'platform_unavailable', lastSyncedAt: null })]);
    const html = renderToStaticMarkup(wrap(<MeetingPlatforms canConnect />));
    expect(html).toContain(en.meetings.platform.settings.statusExpired);
    expect(html).toContain(esc(en.meetings.platform.settings.reason.replace('{reason}', en.meetings.platform.errors.connection_expired)));
    expect(html).toContain(esc(en.meetings.platform.settings.reason.replace('{reason}', en.meetings.platform.errors.platform_unavailable)));
    expect(html).toContain(en.meetings.platform.settings.neverListed);
    const vn = renderToStaticMarkup(wrap(<MeetingPlatforms canConnect />, 'vi'));
    expect(vn).toContain(viMessages.meetings.platform.settings.statusExpired);
    expect(vn).toContain(viMessages.meetings.platform.errors.connection_expired);
  });

  it('offers the sandbox connect button only where the deployment turns the test channels on, for a member who can connect, and only until it is connected', () => {
    reset();
    client.current.setQueryData(KEYS.connections, []);
    const empty = renderToStaticMarkup(wrap(<MeetingPlatforms canConnect />));
    expect(empty).toContain('data-testid="meeting-platforms-empty"');
    expect(empty).toContain(en.meetings.platform.settings.none);
    expect(empty).toContain('data-testid="meeting-platform-connect-sandbox"');
    expect(empty).toContain(en.meetings.platform.settings.connectSandbox);
    // Google Meet, Zoom and Teams are not offered in C1.
    for (const name of ['Zoom', 'Microsoft Teams']) expect(renderToStaticMarkup(wrap(<MeetingPlatforms canConnect />))).not.toContain(`>${name}<`);
    expect(renderToStaticMarkup(wrap(<MeetingPlatforms canConnect={false} />))).not.toContain('meeting-platform-connect-sandbox');
    config.sandbox = false;
    expect(renderToStaticMarkup(wrap(<MeetingPlatforms canConnect />))).not.toContain('meeting-platform-connect-sandbox');
    config.sandbox = true;
    client.current.setQueryData(KEYS.connections, [connection()]);
    expect(renderToStaticMarkup(wrap(<MeetingPlatforms canConnect />))).not.toContain('meeting-platform-connect-sandbox');
  });

  it('shows a loading state, an error, and nothing at all without the meetings module', () => {
    reset();
    expect(renderToStaticMarkup(wrap(<MeetingPlatforms canConnect />))).toContain('data-testid="meeting-platforms-loading"');
    failQuery(KEYS.connections, 'boom');
    const failed = renderToStaticMarkup(wrap(<MeetingPlatforms canConnect />));
    expect(failed).toContain('ERR:boom');
    reset();
    config.modules = ['kernel'];
    client.current.setQueryData(KEYS.connections, [connection()]);
    expect(renderToStaticMarkup(wrap(<MeetingPlatforms canConnect />))).toBe('');
  });
});

describe('PlatformRecordings (Meetings tab)', () => {
  it('stays hidden with no connection and no rows, while the connections load, and without the meetings module', () => {
    reset();
    client.current.setQueryData(KEYS.connections, []);
    client.current.setQueryData(KEYS.recordings, []);
    expect(renderToStaticMarkup(wrap(<PlatformRecordings slug="acme" />))).toBe('');
    reset();
    expect(renderToStaticMarkup(wrap(<PlatformRecordings slug="acme" />))).toBe('');
    reset();
    config.modules = ['kernel'];
    client.current.setQueryData(KEYS.connections, [connection()]);
    client.current.setQueryData(KEYS.recordings, [recording()]);
    expect(renderToStaticMarkup(wrap(<PlatformRecordings slug="acme" />))).toBe('');
  });

  it('shows a loading state and the empty state of a connected member, and an error', () => {
    reset();
    client.current.setQueryData(KEYS.connections, [connection()]);
    expect(renderToStaticMarkup(wrap(<PlatformRecordings slug="acme" />))).toContain('data-testid="meeting-recordings-loading"');
    client.current.setQueryData(KEYS.recordings, []);
    const empty = renderToStaticMarkup(wrap(<PlatformRecordings slug="acme" />));
    expect(empty).toContain('data-testid="meeting-recordings-empty"');
    expect(empty).toContain(en.meetings.platform.recordings.title);
    reset();
    client.current.setQueryData(KEYS.connections, [connection()]);
    failQuery(KEYS.recordings, 'down');
    expect(renderToStaticMarkup(wrap(<PlatformRecordings slug="acme" />))).toContain('ERR:down');
  });

  it('shows a suggested recording with its facts, a primary "Nhập" and a quiet "Bỏ qua"', () => {
    reset();
    client.current.setQueryData(KEYS.connections, [connection()]);
    client.current.setQueryData(KEYS.recordings, [recording({ hasVideo: true, hasTranscript: true })]);
    const html = renderToStaticMarkup(wrap(<PlatformRecordings slug="acme" />));
    expect(html).toContain('Họp khách A');
    expect(html).toContain(esc(en.meetings.platform.provider.sandbox));
    expect(html).toContain('1 h 5 min');
    expect(html).toContain('5 MB');
    expect(html).toContain(esc(en.meetings.platform.recordings.offers.replace('{items}', `${en.meetings.platform.recordings.offerAudio}, ${en.meetings.platform.recordings.offerVideo}, ${en.meetings.platform.recordings.offerTranscript}`)));
    expect(count(html, 'data-testid="meeting-recording-import"')).toBe(1);
    expect(html).toContain(en.meetings.platform.recordings.import);
    expect(html).toContain(en.meetings.platform.recordings.dismiss);
    const vn = renderToStaticMarkup(wrap(<PlatformRecordings slug="acme" />, 'vi'));
    expect(vn).toContain(viMessages.meetings.platform.recordings.title);
    expect(vn).toContain('1 giờ 5 phút');
  });

  it('offers a viewer no "Nhập" or retry, says why, and still lets them dismiss; nothing is offered before the role is known', () => {
    reset();
    client.current.setQueryData(KEYS.connections, [connection()]);
    client.current.setQueryData(KEYS.recordings, [recording(), recording({ id: 'f', status: 'failed', meetingId: 'm5', errorCode: 'download_failed' })]);
    client.current.setQueryData(['org', 'get'], { role: 'viewer' });
    for (const locale of ['en', 'vi'] as const) {
      const words = locale === 'en' ? en : viMessages;
      const html = renderToStaticMarkup(wrap(<PlatformRecordings slug="acme" />, locale));
      expect(html).not.toContain('meeting-recording-import');
      expect(html).not.toContain('meeting-recording-retry');
      expect(html).toContain(esc(words.meetings.platform.recordings.viewerOnly));
      expect(html).toContain(words.meetings.platform.recordings.dismiss);
    }
    client.current.removeQueries({ queryKey: ['org', 'get'] });
    expect(renderToStaticMarkup(wrap(<PlatformRecordings slug="acme" />))).not.toContain('meeting-recording-import');
  });

  it('offers no "Nhập" for a video-only recording or one over 90 minutes or 300 MB, and says why', () => {
    reset();
    client.current.setQueryData(KEYS.connections, [connection()]);
    client.current.setQueryData(KEYS.recordings, [
      recording({ id: 'v', hasAudio: false, hasVideo: true }),
      recording({ id: 'l', lengthSeconds: 5401 }),
      recording({ id: 'b', sizeBytes: 300 * 1024 * 1024 + 1 }),
      recording({ id: 'ok', lengthSeconds: 5400, sizeBytes: 300 * 1024 * 1024 }),
    ]);
    const html = renderToStaticMarkup(wrap(<PlatformRecordings slug="acme" />));
    expect(count(html, 'data-testid="meeting-recording-import"')).toBe(1);
    expect(count(html, 'data-testid="meeting-recording-blocked"')).toBe(3);
    expect(html).toContain(en.meetings.platform.recordings.videoOnly);
    expect(html).toContain(en.meetings.platform.recordings.tooLong);
    expect(html).toContain(en.meetings.platform.recordings.tooLarge);
    expect(renderToStaticMarkup(wrap(<PlatformRecordings slug="acme" />, 'vi'))).toContain('Chỉ có bản hình, chưa nhập được');
  });

  it('shows each state in words: importing, processing, imported with a link to the meeting, failed with a retry', () => {
    reset();
    client.current.setQueryData(KEYS.connections, [connection()]);
    client.current.setQueryData(KEYS.recordings, [
      recording({ id: 'i', status: 'importing', meetingId: 'm1' }),
      recording({ id: 's', status: 'staged', meetingId: 'm2' }),
      recording({ id: 'c', status: 'claimed', meetingId: 'm3' }),
      recording({ id: 'd', status: 'imported', meetingId: 'm4' }),
      recording({ id: 'f', status: 'failed', meetingId: 'm5', errorCode: 'download_failed' }),
    ]);
    const html = renderToStaticMarkup(wrap(<PlatformRecordings slug="acme" />));
    expect(html).toContain(en.meetings.platform.recordings.importing);
    expect(count(html, `>${en.meetings.platform.recordings.processing}<`)).toBe(2);
    expect(html).toContain(en.meetings.platform.recordings.stagedHint);
    expect(html).toContain('data-testid="meeting-recording-open"');
    expect(html).toContain('&quot;id&quot;:&quot;m4&quot;');
    expect(html).toContain(esc(en.meetings.platform.recordings.failed.replace('{reason}', en.meetings.platform.errors.download_failed)));
    expect(count(html, 'data-testid="meeting-recording-retry"')).toBe(1);
    expect(count(html, 'data-testid="meeting-recording-import"')).toBe(0);
  });

  it('words every error code in both languages, and offers a retry only where it can work', () => {
    for (const locale of ['en', 'vi'] as const) {
      for (const code of MEETING_PLATFORM_ERROR_CODES) {
        reset();
        client.current.setQueryData(KEYS.connections, [connection()]);
        client.current.setQueryData(KEYS.recordings, [recording({ status: 'failed', meetingId: 'm1', errorCode: code })]);
        const html = renderToStaticMarkup(wrap(<PlatformRecordings slug="acme" />, locale));
        const messages = locale === 'en' ? en : viMessages;
        expect(html, `${locale} ${code}`).toContain(esc(messages.meetings.platform.recordings.failed.replace('{reason}', messages.meetings.platform.errors[code])));
        const retry = count(html, 'data-testid="meeting-recording-retry"');
        expect(retry, code).toBe(['recording_gone', 'no_audio', 'too_large', 'too_long'].includes(code) ? 0 : 1);
        // The dismiss stays for a failed row.
        expect(html).toContain(messages.meetings.platform.recordings.dismiss);
      }
    }
    reset();
    client.current.setQueryData(KEYS.connections, [connection()]);
    client.current.setQueryData(KEYS.recordings, [recording({ status: 'failed', errorCode: 'a_code_from_a_newer_server' })]);
    expect(renderToStaticMarkup(wrap(<PlatformRecordings slug="acme" />))).toContain(esc(en.meetings.platform.errors.unknown));
  });
});

describe('ImportForm (the "Nhập" dialog)', () => {
  const form = (locale: 'en' | 'vi' = 'en') => renderToStaticMarkup(wrap(<ImportForm recording={recording()} onDone={() => undefined} onCancel={() => undefined} />, locale));

  it('shows the import notice of the active language, what Ludy does and does not copy, the one consent box, and a submit that waits for the tick', () => {
    reset();
    const html = form();
    expect(html).toContain('value="Họp khách A"');
    expect(html).toContain(esc(IMPORT_NOTICE.text.en));
    expect(html).not.toContain(esc(IMPORT_NOTICE.text.vi));
    for (const line of [en.meetings.platform.dialog.copyAudio, en.meetings.platform.dialog.keepOriginal, en.meetings.platform.dialog.noParticipants, en.meetings.platform.dialog.ownTranscript]) expect(html).toContain(esc(line));
    expect(html).toContain(en.meetings.platform.dialog.consent);
    expect(count(html, 'id="import-consent"')).toBe(1);
    expect(disabledSubmit(html)).toMatch(/ disabled=/);
    expect(html).not.toContain('meeting-import-strict');
    expect(/<[^>]*data-slot="checkbox"[^>]*>/.exec(html)?.[0]).not.toMatch(/ data-disabled| disabled=/);
    expect(html).toContain(en.meetings.templates.label);
    expect(html).toContain(en.meetings.form.visibility);
    const vn = form('vi');
    expect(vn).toContain(esc(IMPORT_NOTICE.text.vi));
    expect(vn).toContain('Nền tảng đã hiện thông báo ghi hình của chính họ cho mọi người trong cuộc họp, và tôi xác nhận điều đó.');
    expect(vn).toContain(viMessages.meetings.platform.dialog.noticeDraft);
  });

  it('says before the click that a strict org cannot import, and disables the box and the submit', () => {
    reset();
    client.current.setQueryData(KEYS.policy, { policy: 'strict' });
    const html = form('vi');
    expect(html).toContain('data-testid="meeting-import-strict"');
    expect(html).toContain(esc(viMessages.meetings.platform.dialog.strict));
    expect(html).toContain('chưa nhập được bản ghi từ nền tảng');
    expect(disabledSubmit(html)).toMatch(/ disabled=/);
    expect(/<[^>]*data-slot="checkbox"[^>]*>/.exec(html)?.[0]).toMatch(/ data-disabled| disabled=/);
  });
});

describe('ImportAutoClaim', () => {
  it('draws nothing when no row is waiting to be received', () => {
    reset();
    client.current.setQueryData(KEYS.recordings, [recording({ status: 'suggested' }), recording({ id: 'i', status: 'importing', meetingId: 'm1' }), recording({ id: 'd', status: 'imported', meetingId: 'm2' })]);
    expect(renderToStaticMarkup(wrap(<ImportAutoClaim />))).toBe('');
    reset();
    config.modules = ['kernel'];
    client.current.setQueryData(KEYS.recordings, [recording({ status: 'staged', meetingId: 'm1' })]);
    expect(renderToStaticMarkup(wrap(<ImportAutoClaim />))).toBe('');
  });

  it('tells the member to keep the page open while a staged row has not been received yet', () => {
    reset();
    client.current.setQueryData(KEYS.recordings, [recording({ status: 'staged', meetingId: 'm1' })]);
    const html = renderToStaticMarkup(wrap(<ImportAutoClaim />));
    expect(html).toContain('data-testid="meeting-import-waiting"');
    expect(html).toContain(en.meetings.platform.claim.waiting);
    expect(renderToStaticMarkup(wrap(<ImportAutoClaim />, 'vi'))).toContain('Hãy giữ trang này mở');
  });
});
