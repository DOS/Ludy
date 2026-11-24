// SPDX-License-Identifier: AGPL-3.0-only
// Component, A4 PDF builder, and flow tests for Ludy Notes shared meeting minutes -> Ludy eSign handoff (#3811, Slice 3a):
//   - Zero sign.* queries and zero UI controls when 'sign' is not deployed, MODULE_OFF, or minutes are unshared drafts
//   - Live Vietnamese status badges (Nhap, Dang cho ky, Da ky xac nhan, Tu choi / Da huy, Het han) linking to /o/$slug/sign/envelopes/$id
//   - Direct sealed PDF download button (Tai ban da ky) when completed + sealed
//   - Pure-TS A4 PDF 1.4 generation with multi-page pagination and deterministic {{signature, r1}}..{{signature, rN}} tags
//   - Attendee + linked external party contact prefill, mid-handoff retry idempotency, and org-switch guard
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionItemView, FollowupDraft, MeetingResults as ResultsData, SignEnvelopeBySourceItem } from '@ludy/kernel-contract';
import { I18nProvider } from '../src/i18n/provider.tsx';
import { setActiveLocale } from '../src/i18n/runtime.ts';
import { buildMeetingMinutesFilename, buildMeetingMinutesPdfBytes } from '../src/lib/meeting-minutes-pdf.ts';

const state = vi.hoisted(() => ({
  client: null as unknown as import('@tanstack/react-query').QueryClient,
  modules: ['meetings', 'sign'] as string[],
  calls: [] as Array<{ step: string; args: unknown }>,
  uploadedFiles: [] as Array<{ name: string; type: string; size: number; org: string | null | undefined }>,
  uploadedFileId: '01900000-0000-7000-8000-000000000501',
  createdEnvelopeId: '01900000-0000-7000-8000-000000000601',
  followupDraft: null as FollowupDraft | null,
  signQueryAsked: [] as unknown[],
  signQueryExecuted: [] as unknown[],
  orgAppsQueryExecuted: 0,
  failSecondSignerOnce: false,
  currentOrg: 'acme' as string | null,
  downloadedFileIds: [] as string[],
}));

vi.mock('../src/lib/auth.ts', () => ({
  getConfig: () => ({ modules: state.modules }),
}));

vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ slug: 'acme', id: '01900000-0000-7000-8000-000000000111' }),
  useNavigate: () => vi.fn(),
  Link: ({
    children,
    to,
    params,
    ...rest
  }: {
    children?: unknown;
    to: string;
    params?: Record<string, string>;
  }) => {
    const href = to.replace(/\$(\w+)/g, (_m, k: string) => params?.[k] ?? '');
    return (
      <a href={href} {...(rest as object)}>
        {children as never}
      </a>
    );
  },
}));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  state.client = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') {
          return (args?: { input?: unknown }) => {
            const joined = path.join('.');
            if (joined === 'sign.envelope.by_source') {
              state.signQueryAsked.push(args?.input);
            }
            return {
              queryKey: args?.input !== undefined ? [...path, args.input] : path,
              queryFn: () => {
                if (joined === 'sign.envelope.by_source') {
                  state.signQueryExecuted.push(args?.input);
                }
                if (joined === 'org.apps') {
                  state.orgAppsQueryExecuted += 1;
                }
                return Promise.reject(new Error(`unexpected query ${joined}`));
              },
            };
          };
        }
        if (prop === 'mutationOptions') return () => ({ mutationFn: () => Promise.resolve({}) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });

  let signerCallIndex = 0;
  const makeRpcClient = (pinnedOrg: string | null) => ({
    sign: {
      envelope: {
        create: async (input: unknown) => {
          state.calls.push({ step: 'create', args: { input, pinnedOrg } });
          return {
            envelopeId: state.createdEnvelopeId,
            status: 'draft',
            inspectStatus: 'pending',
            version: 1,
          };
        },
      },
      signer: {
        add: async (input: unknown) => {
          signerCallIndex += 1;
          state.calls.push({ step: 'addSigner', args: { input, pinnedOrg } });
          if (state.failSecondSignerOnce && signerCallIndex === 2) {
            state.failSecondSignerOnce = false;
            throw new Error('second signer network interrupted');
          }
          return {
            envelopeId: state.createdEnvelopeId,
            signerId: `01900000-0000-7000-8000-00000000070${signerCallIndex}`,
            routingOrder: 1,
            status: 'waiting',
            version: 1 + signerCallIndex,
          };
        },
      },
    },
    meetings: {
      followup: {
        draft: async (input: unknown) => {
          state.calls.push({ step: 'followupDraft', args: { input, pinnedOrg } });
          if (!state.followupDraft) throw new Error('no followup draft');
          return state.followupDraft;
        },
      },
    },
  });

  return {
    orpc: node([]),
    client: makeRpcClient(null),
    clientForOrg: (slug: string) => makeRpcClient(slug),
    getCurrentOrg: () => state.currentOrg,
    queryClient: state.client,
    errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
    isStepUpRequired: () => false,
    uploadFiles: async (files: File[], source: string, orgSlug?: string | null) => {
      for (const f of files) {
        state.uploadedFiles.push({ name: f.name, type: f.type, size: f.size, org: orgSlug });
      }
      state.calls.push({ step: 'uploadFiles', args: { source, orgSlug, count: files.length } });
      return { files: [{ fileId: state.uploadedFileId }] };
    },
    fetchFile: async (fileId: string) => {
      state.downloadedFileIds.push(fileId);
      return new Blob(['%PDF-1.4 sealed minutes'], { type: 'application/pdf' });
    },
  };
});

const {
  MeetingMinutesSignHandoff,
  canCreateMeetingMinutesEnvelope,
  canDownloadSealedMeetingMinutes,
  canStartMeetingMinutesSignHandoff,
  createMeetingMinutesSignHandoffAttempt,
  hasSharedMeetingMinutes,
  isMeetingMinutesEnvelopeStale,
  performMeetingMinutesSignHandoff,
} = await import('../src/components/meeting-minutes-sign-handoff.tsx');
const { MeetingResults } = await import('../src/components/meeting-results.tsx');

const MEETING_ID = '01900000-0000-7000-8000-000000000111';
const RECORDER_ID = '01900000-0000-7000-8000-000000000021';
const ATTENDEE_ID = '01900000-0000-7000-8000-000000000022';
const NOMAIL_ID = '01900000-0000-7000-8000-000000000023';
const SEALED_FILE_ID = '01900000-0000-7000-8000-000000000888';

const ORG_MEMBERS = [
  { userId: RECORDER_ID, displayName: 'Đặng Quốc Bảo', email: 'bao@example.com' },
  { userId: ATTENDEE_ID, displayName: 'Nguyễn Minh Ánh', email: 'anh@example.com' },
  { userId: NOMAIL_ID, displayName: 'Trần Gia Huy', email: '' },
];

const makeAction = (stage: 'draft' | 'published', title = 'Gửi báo giá chính thức'): ActionItemView => ({
  id: `01900000-0000-7000-8000-00000000090${stage === 'published' ? '1' : '2'}`,
  stage,
  status: 'suggested',
  title,
  who: 'Ánh',
  whoUserId: ATTENDEE_ID,
  when: '2026-11-25',
  whenDate: '2026-11-25',
  transcriptSeconds: 90,
  flags: [],
  tainted: false,
  taskId: null,
  positions: [],
  clean: false,
  suggestion: null,
});

const SHARED_RESULTS: ResultsData = {
  meetingId: MEETING_ID,
  isRecorder: true,
  draft: null,
  published: {
    id: '01900000-0000-7000-8000-000000000801',
    feature: 'manual',
    stage: 'published',
    summary: 'Chốt phạm vi triển khai giai đoạn 1 với khách hàng ABC.',
    decisions: ['Giữ nguyên tiến độ bàn giao tháng 12', 'Ký xác nhận biên bản điện tử'],
    tainted: false,
  },
  items: [makeAction('published')],
};

const UNSHARED_DRAFT_RESULTS: ResultsData = {
  meetingId: MEETING_ID,
  isRecorder: true,
  draft: {
    id: '01900000-0000-7000-8000-000000000802',
    feature: 'meetings.summary',
    stage: 'published' === ('draft' as string) ? 'published' : 'draft',
    summary: 'Bản nháp riêng của người ghi, chưa chia sẻ.',
    decisions: ['Nháp chưa duyệt'],
    tainted: true,
  },
  published: null,
  items: [makeAction('draft', 'Việc nháp riêng')],
};

function renderWithProviders(ui: React.ReactNode, locale: 'vi' | 'en' = 'vi'): string {
  setActiveLocale(locale);
  return renderToStaticMarkup(
    <QueryClientProvider client={state.client}>
      <I18nProvider>{ui}</I18nProvider>
    </QueryClientProvider>,
  );
}

function seedSignEnabled(enabled: boolean): void {
  state.client.setQueryData(['org', 'apps'], {
    apps: [{ id: 'sign', effective: enabled }],
  });
}

describe('Ludy Notes -> Ludy eSign shared meeting minutes handoff (#3811)', () => {
  beforeEach(() => {
    state.client.clear();
    state.modules = ['meetings', 'sign'];
    state.calls = [];
    state.uploadedFiles = [];
    state.followupDraft = null;
    state.signQueryAsked = [];
    state.signQueryExecuted = [];
    state.orgAppsQueryExecuted = 0;
    state.failSecondSignerOnce = false;
    state.currentOrg = 'acme';
    state.downloadedFileIds = [];
  });

  it('builds a clean A4 PDF 1.4 meeting minutes document with multi-page pagination and {{signature, rN}} tags', () => {
    expect(buildMeetingMinutesFilename('2026-11-19T07:30:00.000Z', MEETING_ID)).toBe(
      'bien-ban-cuoc-hop-2026-11-19-01900000.pdf',
    );

    const pdfBytes = buildMeetingMinutesPdfBytes({
      companyName: 'Công ty TNHH Công nghệ Ludy',
      title: 'Họp chốt nghiệm thu giai đoạn 1',
      startedAt: '2026-11-19T07:00:00.000Z',
      createdAt: '2026-11-19T06:58:00.000Z',
      endedAt: '2026-11-19T08:15:00.000Z',
      place: 'Phòng họp tầng 5, Quận 1',
      recorderName: 'Đặng Quốc Bảo',
      attendees: ['Đặng Quốc Bảo', 'Nguyễn Minh Ánh', 'Khách hàng Lê Hoàng'],
      sections: [{ title: 'Tiến độ dự án', text: 'Đã hoàn thành 100% các hạng mục kiểm thử bảo mật.' }],
      conclusions: ['Thống nhất nghiệm thu giai đoạn 1'],
      actions: [{ title: 'Gửi biên bản ký điện tử', owner: 'Nguyễn Minh Ánh', due: '25/11/2026' }],
      signers: [
        { name: 'Đặng Quốc Bảo', roleLabel: 'Người ghi biên bản' },
        { name: 'Nguyễn Minh Ánh', roleLabel: 'Người tham dự' },
        { name: 'Lê Hoàng', roleLabel: 'Khách tham dự' },
      ],
    });

    const text = new TextDecoder('latin1').decode(pdfBytes);
    expect(text.startsWith('%PDF-1.4\n')).toBe(true);
    expect(text.endsWith('%%EOF\n')).toBe(true);
    expect(text).toContain('/MediaBox [0 0 595 842]');
    expect(text).toContain('BIEN BAN CUOC HOP / MEETING MINUTES');
    expect(text).toContain('Tu 14:00 den 15:15, ngay 19/11/2026');
    expect(text).toContain('Dang Quoc Bao');
    expect(text).toContain('Nguyen Minh Anh');
    expect(text).toContain('{{signature, r1}}');
    expect(text).toContain('{{signature, r2}}');
    expect(text).toContain('{{signature, r3}}');

    const startxrefMatch = /startxref\n(\d+)\n%%EOF/.exec(text);
    expect(startxrefMatch).not.toBeNull();
    expect(text.slice(Number(startxrefMatch![1]), Number(startxrefMatch![1]) + 5)).toBe('xref\n');

    // Long minutes paginate cleanly across multiple A4 pages without overlapping signature blocks.
    const multiPageBytes = buildMeetingMinutesPdfBytes({
      companyName: 'Cong ty TNHH Ludy Vietnam',
      title: 'Hop tong ket quy 4',
      createdAt: '2026-11-19T07:00:00.000Z',
      recorderName: 'Dang Quoc Bao',
      attendees: ['Dang Quoc Bao', 'Nguyen Minh Anh', 'Tran Gia Huy', 'Le Hoang'],
      sections: Array.from({ length: 12 }, (_, idx) => ({
        title: `Hang muc thao luan so ${idx + 1}`,
        text: 'Noi dung thao luan chi tiet ve ke hoach san pham, ngan sach va van hanh khach hang doanh nghiep nho. '.repeat(
          5,
        ),
      })),
      conclusions: Array.from({ length: 8 }, (_, idx) => `Quyet dinh quan trong so ${idx + 1} da duoc thong qua`),
      actions: Array.from({ length: 8 }, (_, idx) => ({
        title: `Cong viec can trien khai so ${idx + 1}`,
        owner: 'Nguyen Minh Anh',
        due: '30/11/2026',
      })),
      signers: [
        { name: 'Dang Quoc Bao', roleLabel: 'Nguoi ghi bien ban' },
        { name: 'Nguyen Minh Anh', roleLabel: 'Nguoi tham du' },
        { name: 'Tran Gia Huy', roleLabel: 'Nguoi tham du' },
        { name: 'Le Hoang', roleLabel: 'Khach tham du' },
      ],
    });
    const multiText = new TextDecoder('latin1').decode(multiPageBytes);
    expect(multiText).toMatch(/\/Count [2-9]/);
    expect(multiText).toContain('{{signature, r4}}');
  });

  it('runs zero sign.* queries and renders zero eSign controls when minutes are unshared OR sign is MODULE_OFF', () => {
    expect(hasSharedMeetingMinutes(UNSHARED_DRAFT_RESULTS)).toBe(false);
    expect(hasSharedMeetingMinutes(SHARED_RESULTS)).toBe(true);

    // Case 1: Sign IS enabled, minutes are UNSHARED (private Vy/manual draft only) -> zero sign queries & no button!
    seedSignEnabled(true);
    state.client.setQueryData(['meetings', 'results', 'get', { meetingId: MEETING_ID }], UNSHARED_DRAFT_RESULTS);
    state.client.setQueryData(['meetings', 'results', 'summaryStatus', { meetingId: MEETING_ID }], {
      meetingId: MEETING_ID,
      enabled: false,
    });
    state.client.setQueryData(['meetings', 'template', 'list', {}], { templates: [] });
    const unsharedHtml = renderWithProviders(
      <MeetingResults
        meetingId={MEETING_ID}
        readers={[RECORDER_ID, ATTENDEE_ID]}
        title="Họp nội bộ"
        signInfo={{
          startedAt: '2026-11-19T07:00:00.000Z',
          createdAt: '2026-11-19T07:00:00.000Z',
          endedAt: null,
          recorderUserId: RECORDER_ID,
          companyName: 'Ludy',
          orgMembers: ORG_MEMBERS,
        }}
      />,
    );
    expect(unsharedHtml).not.toContain('meeting-minutes-send-esign');
    expect(unsharedHtml).not.toContain('meeting-minutes-sign-handoff');
    expect(state.signQueryAsked).toEqual([]);

    // Case 2: Shared minutes, 'sign' not in deployed modules -> zero sign queries, zero org.apps queries!
    state.modules = ['meetings'];
    state.client.setQueryData(['meetings', 'results', 'get', { meetingId: MEETING_ID }], SHARED_RESULTS);
    const notDeployedHtml = renderWithProviders(
      <MeetingResults
        meetingId={MEETING_ID}
        readers={[RECORDER_ID, ATTENDEE_ID]}
        title="Họp chốt biên bản"
        signInfo={{
          startedAt: '2026-11-19T07:00:00.000Z',
          createdAt: '2026-11-19T07:00:00.000Z',
          endedAt: null,
          recorderUserId: RECORDER_ID,
          companyName: 'Ludy',
          orgMembers: ORG_MEMBERS,
        }}
      />,
    );
    expect(notDeployedHtml).not.toContain('meeting-minutes-send-esign');
    expect(state.signQueryAsked).toEqual([]);
    expect(state.orgAppsQueryExecuted).toBe(0);

    // Case 3: 'sign' deployed, disabled for this org (MODULE_OFF) -> zero sign.* queries!
    state.modules = ['meetings', 'sign'];
    seedSignEnabled(false);
    const disabledHtml = renderWithProviders(
      <MeetingResults
        meetingId={MEETING_ID}
        readers={[RECORDER_ID, ATTENDEE_ID]}
        title="Họp chốt biên bản"
        signInfo={{
          startedAt: '2026-11-19T07:00:00.000Z',
          createdAt: '2026-11-19T07:00:00.000Z',
          endedAt: null,
          recorderUserId: RECORDER_ID,
          companyName: 'Ludy',
          orgMembers: ORG_MEMBERS,
        }}
      />,
    );
    expect(disabledHtml).not.toContain('meeting-minutes-send-esign');
    expect(state.signQueryAsked).toEqual([]);
  });

  it('shows the eSign handoff on the minutes page only while the org setting "Ký biên bản họp" is on (#4703)', () => {
    seedSignEnabled(true);
    state.client.setQueryData(['meetings', 'results', 'get', { meetingId: MEETING_ID }], SHARED_RESULTS);
    state.client.setQueryData(['meetings', 'results', 'summaryStatus', { meetingId: MEETING_ID }], { meetingId: MEETING_ID, enabled: false });
    state.client.setQueryData(['meetings', 'template', 'list', {}], { templates: [] });
    state.client.setQueryData(['sign', 'envelope', 'by_source', { sourceKind: 'meeting_minutes', sourceIds: [MEETING_ID] }], { items: [] });
    const page = () =>
      renderWithProviders(
        <MeetingResults
          meetingId={MEETING_ID}
          readers={[RECORDER_ID, ATTENDEE_ID]}
          title="Họp chốt biên bản"
          signInfo={{ startedAt: '2026-11-19T07:00:00.000Z', createdAt: '2026-11-19T07:00:00.000Z', endedAt: null, recorderUserId: RECORDER_ID, companyName: 'Ludy', orgMembers: ORG_MEMBERS }}
        />,
      );

    // Not read yet (loading, or unreadable), then read as off: no handoff and no sign.* query at all.
    expect(page()).not.toContain('meeting-minutes-send-esign');
    state.client.setQueryData(['meetings', 'minutesEsign', 'get', {}], { enabled: false });
    expect(page()).not.toContain('meeting-minutes-send-esign');
    expect(state.signQueryAsked).toEqual([]);

    // On: the handoff shows as it did before the setting existed.
    state.client.setQueryData(['meetings', 'minutesEsign', 'get', {}], { enabled: true });
    expect(page()).toContain('data-testid="meeting-minutes-send-esign"');
  });

  it('renders live Vietnamese status badges (Nháp, Đang chờ ký, Đã ký xác nhận, Từ chối / Đã hủy, Hết hạn) and Tải bản đã ký', () => {
    seedSignEnabled(true);
    state.client.setQueryData(['meetings', 'results', 'get', { meetingId: MEETING_ID }], SHARED_RESULTS);
    state.client.setQueryData(['meetings', 'results', 'summaryStatus', { meetingId: MEETING_ID }], {
      meetingId: MEETING_ID,
      enabled: false,
    });
    state.client.setQueryData(['meetings', 'template', 'list', {}], { templates: [] });

    const makeEnvelope = (
      status: SignEnvelopeBySourceItem['status'],
      overrides: Partial<SignEnvelopeBySourceItem> = {},
    ): SignEnvelopeBySourceItem => ({
      sourceId: MEETING_ID,
      envelopeId: state.createdEnvelopeId,
      title: 'Biên bản cuộc họp - Họp nghiệm thu (19/11/2026)',
      status,
      sealStatus: status === 'completed' ? 'sealed' : null,
      sealedFileId: status === 'completed' ? SEALED_FILE_ID : null,
      certificateCode: status === 'completed' ? 'CS-MTG1-ABCD-1234' : null,
      completedAt: status === 'completed' ? '2026-11-19T08:15:00.000Z' : null,
      signerCount: 2,
      signedCount: status === 'completed' ? 2 : 0,
      createdAt: '2026-11-19T08:00:00.000Z',
      updatedAt: '2026-11-19T08:15:00.000Z',
      ...overrides,
    });

    const source = {
      meeting: {
        id: MEETING_ID,
        title: 'Họp nghiệm thu',
        startedAt: '2026-11-19T07:00:00.000Z',
        createdAt: '2026-11-19T06:58:00.000Z',
        endedAt: '2026-11-19T08:00:00.000Z',
        recorderUserId: RECORDER_ID,
        readers: [RECORDER_ID, ATTENDEE_ID],
        summaryTemplate: 'general' as const,
        minutesTemplate: null,
        isRecorder: true,
      },
      results: SHARED_RESULTS,
      companyName: 'Công ty Ludy',
      orgMembers: ORG_MEMBERS,
    };

    // Empty -> shows "Ký xác nhận qua eSign"
    state.client.setQueryData(
      ['sign', 'envelope', 'by_source', { sourceKind: 'meeting_minutes', sourceIds: [MEETING_ID] }],
      { items: [] },
    );
    const emptyHtml = renderWithProviders(<MeetingMinutesSignHandoff source={source} />);
    expect(emptyHtml).toContain('data-testid="meeting-minutes-send-esign"');
    expect(emptyHtml).toContain('Ký xác nhận qua eSign');

    // Draft -> "Nháp", send hidden
    const draftHtml = renderWithProviders(
      <MeetingMinutesSignHandoff source={source} envelope={makeEnvelope('draft')} />,
    );
    expect(draftHtml).toContain(`href="/o/acme/sign/envelopes/${state.createdEnvelopeId}"`);
    expect(draftHtml).toContain('>Nháp<');
    expect(draftHtml).not.toContain('data-testid="meeting-minutes-send-esign"');

    // Sent & in_progress -> "Đang chờ ký"
    for (const st of ['sent', 'in_progress'] as const) {
      const html = renderWithProviders(<MeetingMinutesSignHandoff source={source} envelope={makeEnvelope(st)} />);
      expect(html).toContain('>Đang chờ ký<');
      expect(html).not.toContain('data-testid="meeting-minutes-send-esign"');
    }

    // Completed & sealed -> "Đã ký xác nhận" + "Tải bản đã ký"
    const completedHtml = renderWithProviders(
      <MeetingMinutesSignHandoff source={source} envelope={makeEnvelope('completed')} />,
    );
    expect(completedHtml).toContain('>Đã ký xác nhận<');
    expect(completedHtml).toContain('data-testid="meeting-minutes-download-sealed"');
    expect(completedHtml).toContain('Tải bản đã ký');
    expect(canDownloadSealedMeetingMinutes(makeEnvelope('completed'))).toBe(true);
    expect(canDownloadSealedMeetingMinutes(makeEnvelope('completed', { sealStatus: 'pending' }))).toBe(false);

    // Declined & voided -> "Từ chối / Đã hủy" + retry button visible
    for (const st of ['declined', 'voided'] as const) {
      const html = renderWithProviders(<MeetingMinutesSignHandoff source={source} envelope={makeEnvelope(st)} />);
      expect(html).toContain('>Từ chối / Đã hủy<');
      expect(html).toContain('data-testid="meeting-minutes-send-esign"');
      expect(canStartMeetingMinutesSignHandoff(SHARED_RESULTS, makeEnvelope(st))).toBe(true);
    }

    // Expired -> "Hết hạn" + retry button visible
    const expiredHtml = renderWithProviders(
      <MeetingMinutesSignHandoff source={source} envelope={makeEnvelope('expired')} />,
    );
    expect(expiredHtml).toContain('>Hết hạn<');
    expect(expiredHtml).toContain('data-testid="meeting-minutes-send-esign"');

    // Stale is the server's word (#4532), not a hash read from the title: an envelope for older minutes (even a signed one) can be started again, a title that looks like a revision means nothing.
    expect(isMeetingMinutesEnvelopeStale(SHARED_RESULTS, makeEnvelope('draft', { stale: true }))).toBe(true);
    expect(isMeetingMinutesEnvelopeStale(SHARED_RESULTS, makeEnvelope('draft', { stale: false }))).toBe(false);
    expect(isMeetingMinutesEnvelopeStale(SHARED_RESULTS, makeEnvelope('draft', { title: 'Biên bản [#deadbeef]' }))).toBe(false);
    expect(isMeetingMinutesEnvelopeStale(UNSHARED_DRAFT_RESULTS, makeEnvelope('draft', { stale: true }))).toBe(false);
    expect(isMeetingMinutesEnvelopeStale(SHARED_RESULTS, null)).toBe(false);
    expect(canStartMeetingMinutesSignHandoff(SHARED_RESULTS, makeEnvelope('completed'))).toBe(false);
    expect(canStartMeetingMinutesSignHandoff(SHARED_RESULTS, makeEnvelope('completed', { stale: true }))).toBe(true);

    // The recorder, an org owner or an admin is offered the signature, a plain reader and a viewer are not (the server refuses a reader with 403, #4532).
    expect(canCreateMeetingMinutesEnvelope('member', true)).toBe(true);
    expect(canCreateMeetingMinutesEnvelope('member', undefined)).toBe(true);
    expect(canCreateMeetingMinutesEnvelope('owner', false)).toBe(true);
    expect(canCreateMeetingMinutesEnvelope('admin', false)).toBe(true);
    expect(canCreateMeetingMinutesEnvelope('member', false)).toBe(false);
    expect(canCreateMeetingMinutesEnvelope('viewer', true)).toBe(false);
    expect(canCreateMeetingMinutesEnvelope('viewer', false)).toBe(false);
  });

  it('prefills attendees + linked external party contacts, resumes mid-handoff retries idempotently, and guards org switch', async () => {
    state.followupDraft = {
      meetingId: MEETING_ID,
      lang: 'vi',
      org: 'Công ty Ludy',
      factsKey: 'fk-1',
      facts: { summary: 'Chốt biên bản', decisions: [], items: [] },
      words: { subject: 's', greeting: 'g', lead: 'l', closing: 'c' },
      recipients: [
        { kind: 'attendee', id: RECORDER_ID, name: 'Đặng Quốc Bảo', email: 'bao@example.com', alreadySent: false },
        { kind: 'party', id: '01900000-0000-7000-8000-000000000333', name: 'Lê Hoàng (ABC)', email: 'hoang@example.com', alreadySent: false },
      ],
      sendsLeft: 3,
    };

    const navigated: unknown[] = [];
    const attempt = createMeetingMinutesSignHandoffAttempt();
    state.failSecondSignerOnce = true;

    const source = {
      meeting: {
        id: MEETING_ID,
        title: 'Họp nghiệm thu giai đoạn 1',
        startedAt: '2026-11-19T07:00:00.000Z',
        createdAt: '2026-11-19T06:58:00.000Z',
        endedAt: '2026-11-19T08:00:00.000Z',
        recorderUserId: RECORDER_ID,
        readers: [RECORDER_ID, ATTENDEE_ID, NOMAIL_ID],
        summaryTemplate: 'general' as const,
        minutesTemplate: null,
        isRecorder: true,
      },
      results: SHARED_RESULTS,
      companyName: 'Công ty Ludy',
      orgMembers: ORG_MEMBERS,
    };

    const labels = {
      recorderRoleLabel: 'Người ghi biên bản',
      attendeeRoleLabel: 'Người tham dự',
      externalRoleLabel: 'Khách tham dự',
      unknownMemberLabel: 'Thành viên',
    };

    // First run fails on signer #2 after uploading PDF, creating envelope, and adding signer #1.
    await expect(
      performMeetingMinutesSignHandoff({
        source,
        slug: 'acme',
        envelopeTitle: 'Biên bản cuộc họp - Họp nghiệm thu (19/11/2026)',
        labels,
        navigate: (opts) => navigated.push(opts),
        attempt,
      }),
    ).rejects.toThrow('second signer network interrupted');

    expect(attempt.envelopeId).toBe(state.createdEnvelopeId);
    expect(attempt.signersAddedCount).toBe(1);
    expect(navigated).toHaveLength(0);

    // Retry reuses sourceFileId + envelopeId, skips signer #1, and resumes from signer #2 with the same idempotency key!
    const finishedId = await performMeetingMinutesSignHandoff({
      source,
      slug: 'acme',
      envelopeTitle: 'Biên bản cuộc họp - Họp nghiệm thu (19/11/2026)',
      labels,
      navigate: (opts) => navigated.push(opts),
      attempt,
    });

    expect(finishedId).toBe(state.createdEnvelopeId);
    expect(state.uploadedFiles).toHaveLength(1);
    expect(state.calls.filter((c) => c.step === 'create')).toHaveLength(1);

    // Signers: 1 = Recorder (email), 2 = Attendee (email, retried once -> 2 calls with identical idempotencyKey),
    // 3 = Attendee without email (deliveryMode: 'link'), 4 = Linked external party contact (email).
    const signerCalls = state.calls
      .filter((c) => c.step === 'addSigner')
      .map((c) => (c.args as { input: Record<string, unknown> }).input);
    expect(signerCalls).toHaveLength(5);
    expect(signerCalls[0]).toMatchObject({
      routingOrder: 1,
      name: 'Đặng Quốc Bảo',
      email: 'bao@example.com',
      roleLabel: 'Người ghi biên bản',
      deliveryMode: 'email',
    });
    expect(signerCalls[1]!.idempotencyKey).toBe(signerCalls[2]!.idempotencyKey);
    expect(signerCalls[2]).toMatchObject({
      routingOrder: 2,
      name: 'Nguyễn Minh Ánh',
      email: 'anh@example.com',
      roleLabel: 'Người tham dự',
      deliveryMode: 'email',
    });
    expect(signerCalls[3]).toMatchObject({
      routingOrder: 3,
      name: 'Trần Gia Huy',
      roleLabel: 'Người tham dự',
      deliveryMode: 'link',
    });
    expect(signerCalls[4]).toMatchObject({
      routingOrder: 4,
      name: 'Lê Hoàng (ABC)',
      email: 'hoang@example.com',
      roleLabel: 'Khách tham dự',
      deliveryMode: 'email',
    });
    expect(navigated).toEqual([
      { to: '/o/$slug/sign/envelopes/$id', params: { slug: 'acme', id: state.createdEnvelopeId } },
    ]);

    // Switching organization aborts handoff before mutating the wrong workspace.
    state.currentOrg = 'other-org';
    await expect(
      performMeetingMinutesSignHandoff({
        source,
        slug: 'acme',
        envelopeTitle: 'Biên bản cuộc họp',
        labels,
        navigate: (opts) => navigated.push(opts),
      }),
    ).rejects.toThrow('Organization changed');
  });
});
