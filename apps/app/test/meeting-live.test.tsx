// SPDX-License-Identifier: AGPL-3.0-only
// The live pane of a meeting being recorded (L4a-2, #3110): hidden unless opted in and the recorder, the lines in order, the budget and kill-switch notices (each
// saying the recording continues), the buttons per state, and a ticker that never overlaps itself. Rendered on the server from the query cache, with no network.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import type { LiveStatus } from '@crove/kernel-contract';
import { catalog } from '../src/i18n/runtime.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

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
  return { orpc: node([]), queryClient: client.current, errorMessage: String };
});

const { MeetingLive, assembleView, createTickGate, liveActive, liveNotice } = await import('../src/components/meeting-live.tsx');

const status = (over: Partial<LiveStatus> = {}): LiveStatus => ({
  meetingId: 'm1',
  optedIn: true,
  enabled: true,
  state: 'running',
  runId: 'r1',
  errorCode: null,
  lines: [],
  notesUpdatedAt: null,
  assemble: { available: false, reason: 'no_pieces', pieces: 0, missing: [] },
  ...over,
});

function render(s: LiveStatus, props: { liveNotes?: boolean; isRecorder?: boolean } = {}, locale: 'en' | 'vi' = 'vi') {
  client.current.setQueryData(['meetings', 'liveStatus'], s);
  return renderToStaticMarkup(
    <QueryClientProvider client={client.current}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        <MeetingLive meetingId="m1" liveNotes={props.liveNotes ?? true} isRecorder={props.isRecorder ?? true} />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('MeetingLive', () => {
  it('renders nothing when not opted in or not the recorder', () => {
    expect(render(status(), { liveNotes: false })).toBe('');
    expect(render(status(), { isRecorder: false })).toBe('');
  });

  it('shows the heading, the draft note and the lines in order', () => {
    const html = render(
      status({
        lines: [
          { id: 'a', seq: 0, startSeconds: 0, endSeconds: 5, text: 'Xin chào' },
          { id: 'b', seq: 1, startSeconds: 65, endSeconds: 70, text: 'Tiếp theo' },
        ],
      }),
    );
    expect(html).toContain('Bản nháp trực tiếp');
    expect(html).toContain('thay thế');
    // The tick runs from this page: the pane says live notes run only while it is open.
    expect(html).toContain('Ghi chú trực tiếp chỉ chạy khi trang này đang mở.');
    expect(html.indexOf('Xin chào')).toBeGreaterThan(-1);
    expect(html.indexOf('Xin chào')).toBeLessThan(html.indexOf('Tiếp theo'));
    expect(html).toContain('1:05');
  });

  it('offers Start when off, Stop and Update now while running', () => {
    const off = render(status({ state: 'off', runId: null }));
    expect(off).toContain('Bắt đầu ghi chú trực tiếp');
    expect(off).not.toContain('>Dừng<');
    const running = render(status());
    expect(running).toContain('Cập nhật ghi chú ngay');
    expect(running).toContain('>Dừng<');
    expect(running).not.toContain('Bắt đầu ghi chú trực tiếp');
    expect(render(status({ state: 'stopped' }))).not.toContain('Cập nhật ghi chú ngay');
  });

  it('says the deployment cannot transcribe, and that recording continues', () => {
    const html = render(status({ enabled: false, state: 'off', runId: null }));
    expect(html).toContain('Bản ghi này không phiên âm được ở máy chủ của bạn.');
    expect(html).toContain('Việc ghi âm vẫn tiếp tục.');
    expect(html).not.toContain('Bắt đầu ghi chú trực tiếp');
  });

  it('names the budget and the kill switch, each saying recording continues', () => {
    const budget = render(status({ state: 'stopped', errorCode: 'AI_BUDGET_EXHAUSTED' }));
    expect(budget).toContain('Chờ ngân sách AI');
    expect(budget).toContain('Việc ghi âm vẫn tiếp tục.');
    const killed = render(status({ state: 'stopped', errorCode: 'AI_STOPPED' }));
    expect(killed).toContain('AI đang tạm dừng');
    expect(killed).toContain('Việc ghi âm vẫn tiếp tục.');
    const other = render(status({ state: 'stopped', errorCode: 'RUN_FAILED' }));
    expect(other).toContain('Ghi chú trực tiếp đã dừng.');
    expect(other).toContain('RUN_FAILED');
    expect(other).toContain('Việc ghi âm vẫn tiếp tục.');
    expect(render(status({ state: 'stopped', errorCode: 'AI_STOPPED' }), {}, 'en')).toContain('The recording itself continues.');
  });

  it('shows no notice while healthy', () => {
    expect(render(status())).not.toContain('live-notice');
    expect(liveNotice(status())).toBeNull();
  });
});

describe('liveActive', () => {
  it('polls only while running or waiting on an enabled deployment', () => {
    expect(liveActive(status({ state: 'running' }))).toBe(true);
    expect(liveActive(status({ state: 'waiting' }))).toBe(true);
    expect(liveActive(status({ state: 'off' }))).toBe(false);
    expect(liveActive(status({ state: 'stopped' }))).toBe(false);
    expect(liveActive(status({ enabled: false }))).toBe(false);
  });
});

describe('the recording that was not uploaded (#3126)', () => {
  const assemble = (over: Partial<LiveStatus['assemble']>): LiveStatus['assemble'] => ({ available: false, reason: 'no_pieces', pieces: 0, missing: [], ...over });

  it('offers the click with the piece count, the late-upload rule and the gaps', () => {
    const html = render(status({ state: 'stopped', assemble: assemble({ available: true, reason: null, pieces: 12, missing: [3, 7] }) }));
    expect(html).toContain('live-assemble');
    expect(html).toContain('Ghép bản ghi từ các đoạn trực tiếp');
    expect(html).toContain('12 đoạn');
    expect(html).toContain('Thiếu 2 đoạn (số 3, 7)');
    expect(html).toContain('bản đến muộn bị từ chối');
    expect(render(status({ assemble: assemble({ available: true, reason: null, pieces: 3 }) }))).not.toContain('live-assemble-gaps');
  });

  it('says why the pieces cannot be joined yet or at all, and shows nothing when there is nothing to join', () => {
    expect(render(status({ assemble: assemble({ reason: 'still_recording', pieces: 4 }) }))).toContain('vẫn có thể đến');
    expect(render(status({ assemble: assemble({ reason: 'first_piece_missing', pieces: 4, missing: [0] }) }))).toContain('thiếu đoạn đầu');
    expect(render(status({ assemble: assemble({ reason: 'expired', pieces: 0 }) }))).toContain('thời hạn giữ âm thanh');
    for (const reason of ['no_pieces', 'audio_recorded'] as const) expect(render(status({ assemble: assemble({ reason, pieces: 4 }) }))).not.toContain('live-assemble');
    expect(assembleView(assemble({ reason: 'still_recording', pieces: 0 }))).toBe('none');
    expect(render(status({ assemble: assemble({ available: true, reason: null, pieces: 5 }) }), {}, 'en')).toContain('Join the recording from the live pieces');
  });

  it('is offered even when the deployment cannot transcribe: joining needs no AI', () => {
    const html = render(status({ enabled: false, state: 'off', runId: null, assemble: assemble({ available: true, reason: null, pieces: 5 }) }));
    expect(html).toContain('Ghép bản ghi từ các đoạn trực tiếp');
  });
});

describe('createTickGate', () => {
  it('drops a tick asked for while another is in flight, then allows the next', async () => {
    const gate = createTickGate();
    let release: () => void = () => undefined;
    const slow = vi.fn(() => new Promise<void>((r) => (release = r)));
    const fast = vi.fn(() => Promise.resolve());
    const first = gate.run(slow);
    expect(await gate.run(fast)).toBe(false);
    expect(fast).not.toHaveBeenCalled();
    release();
    expect(await first).toBe(true);
    expect(await gate.run(fast)).toBe(true);
    expect(slow).toHaveBeenCalledTimes(1);
  });

  it('frees the gate when a call fails', async () => {
    const gate = createTickGate();
    await expect(gate.run(() => Promise.reject(new Error('x')))).rejects.toThrow('x');
    expect(await gate.run(() => Promise.resolve())).toBe(true);
  });
});
