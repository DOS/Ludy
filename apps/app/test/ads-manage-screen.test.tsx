// SPDX-License-Identifier: AGPL-3.0-only
// The Manage section of a live launch and the suggestion cards of the AI coworker (ads W4, #3835), rendered on the server with the API's answers in props or in the cache:
// what a member sees (the state and no button), what an owner or an admin is offered, what a launch that cannot change offers (Pause alone, with the reason), the states and
// reasons of the changes, and the cards of the suggestions. The buttons and the dialogs are recorded as they render, so each control is pressed here and the procedure it calls,
// with its idempotency key, is checked; the typed forms are covered by the pure checks (ads-manage.test.ts) and end to end (e2e/tests/ads-manage.spec.ts).
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdsCampaignDraftView, AdsLaunchView, AdsManageChangeView, AdsManageObjectView, AdsManageStateView, AdsManageSuggestion } from '@crove/kernel-contract';
import { catalog } from '../src/i18n/runtime.ts';

type Props = Record<string, unknown>;
const seen = vi.hoisted(() => ({
  buttons: [] as Props[],
  dialogs: [] as Props[],
  client: null as unknown as import('@tanstack/react-query').QueryClient,
  ads: {} as Record<string, (input: unknown) => Promise<unknown>>,
}));

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const { createElement } = await import('react');
  return {
    ...(await importOriginal<object>()),
    Link: ({ children, to, params }: { children?: ReactNode; to: string; params?: Record<string, string> }) =>
      createElement('a', { href: to.replace(/\$(\w+)/g, (_match, name: string) => params?.[name] ?? '') }, children),
  };
});

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  seen.client = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') {
          return (options?: { input?: unknown }) => ({ queryKey: options?.input === undefined ? path : [...path, options.input], queryFn: () => Promise.reject(new Error('not fetched')) });
        }
        if (prop === 'mutationOptions') return () => ({ mutationFn: () => Promise.resolve({}) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), queryClient: seen.client, errorMessage: (e: unknown) => String(e), isStepUpRequired: () => false, client: { ads: seen.ads } };
});

// Every button is recorded as it renders (its test id and its click), and every dialog (what it asks and what it does on its confirm).
vi.mock('@crove/ui/components/button', async (importOriginal) => {
  const real = await importOriginal<typeof import('@crove/ui/components/button')>();
  const { createElement } = await import('react');
  return {
    ...real,
    Button: (props: Props) => {
      seen.buttons.push(props);
      return createElement(real.Button as never, props);
    },
  };
});
vi.mock('../src/components/confirm-dialog.tsx', async () => {
  const { createElement } = await import('react');
  return {
    ConfirmDialog: (props: Props) => {
      seen.dialogs.push(props);
      return createElement('button', { type: 'button', 'data-dialog': String(props.title) }, props.children as ReactNode);
    },
  };
});

const { ManageSection, ObjectRow, ChangeRow, SuggestionList, SuggestionCard, AskedNote, ManageSuggestions } = await import('../src/components/ads-manage.tsx');
const { CampaignBuilder } = await import('../src/components/ads-campaign-builder.tsx');

function render(node: ReactNode, locale: 'en' | 'vi' = 'en'): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={seen.client}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        {node}
      </IntlProvider>
    </QueryClientProvider>,
  );
}

const at = '2026-11-18T03:00:00.000Z';
const LAUNCH = '3f2b8c1e-4d5a-4e6f-8a9b-0c1d2e3f4a5b';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const object = (slot: AdsManageObjectView['slot'], over: Partial<AdsManageObjectView> = {}): AdsManageObjectView => ({
  slot,
  level: slot === 'campaign' ? 'campaign' : slot === 'ad_set' ? 'ad_set' : 'ad',
  name: slot === 'campaign' ? 'Khai trương chi nhánh' : slot === 'ad_set' ? 'Nhóm khai trương' : 'Quảng cáo 1',
  status: 'active',
  pending: null,
  ...over,
});
const change = (over: Partial<AdsManageChangeView> = {}): AdsManageChangeView => ({
  id: 'c1',
  kind: 'pause',
  slot: 'campaign',
  state: 'queued',
  fromBudget: null,
  toBudget: null,
  fromEndOn: null,
  toEndOn: null,
  code: null,
  requestedAt: at,
  settledAt: null,
  ...over,
});
const manageState = (over: Partial<AdsManageStateView> = {}): AdsManageStateView => ({
  launchId: LAUNCH,
  currency: 'VND',
  dailyBudget: '100000',
  endOn: '2026-11-30',
  heldDailyBudget: '100000',
  heldEndOn: '2026-11-30',
  canChange: true,
  objects: [object('campaign'), object('ad_set'), object('ad_1')],
  changes: [],
  ...over,
});
const launch = (over: Partial<AdsLaunchView> = {}): AdsLaunchView => ({
  id: LAUNCH,
  draftId: 'd1',
  adAccountId: 'a1',
  state: 'live',
  step: 'live',
  attempt: 1,
  currency: 'VND',
  tag: 'ludy:0123456789',
  dailyBudget: '100000',
  amount: '2000000',
  startOn: '2026-11-10',
  endOn: '2026-11-30',
  commitUntil: '2026-11-30',
  stopReason: null,
  retryRequested: false,
  createdAt: at,
  finishedAt: null,
  windDown: null,
  objects: [],
  provider: 'sandbox_ads',
  statesReadAt: null,
  statesReadOk: null,
  manage: manageState(),
  ...over,
});

const section = (over: { launch?: Partial<AdsLaunchView>; canManage?: boolean } = {}) => <ManageSection launch={launch(over.launch)} canManage={over.canManage ?? true} slug="demo" />;
const withManage = (manage: Partial<AdsManageStateView>) => ({ launch: { manage: manageState(manage) } });

// The recorded button with this test id (the last render of it), and its click.
const button = (testid: string): Props => {
  const found = [...seen.buttons].reverse().find((b) => b['data-testid'] === testid);
  if (!found) throw new Error(`no button ${testid}`);
  return found;
};
const buttonsOf = (testid: string): Props[] => seen.buttons.filter((b) => b['data-testid'] === testid);
const press = (props: Props) => (props.onClick as () => void)();
// The confirm of the n-th dialog rendered: what pressing its confirm button does.
const confirm = (index: number) => {
  const dialog = seen.dialogs[index];
  if (!dialog) throw new Error(`no dialog ${index}`);
  (dialog.onConfirm as () => void)();
};

beforeEach(() => {
  seen.buttons.length = 0;
  seen.dialogs.length = 0;
  for (const name of ['pauseObject', 'archiveObject', 'lowerBudget', 'shortenSchedule', 'cancelChange', 'requestChange']) seen.ads[name] = vi.fn(() => Promise.resolve({ proposalId: 'p1', changeId: 'c9' }));
});

describe('what each role sees', () => {
  it('shows a member the state and no button: the budget, the end date, the objects and the changes', () => {
    const html = render(section({ canManage: false, launch: withManage({ changes: [change({ state: 'queued' })] }).launch }));
    expect(html).toContain('data-testid="campaign-manage"');
    expect(html).toContain('Manage this launch');
    expect(html).toContain('Only an owner or an admin can change it.');
    expect(html).toMatch(/Daily budget: [^<]*100[.,]000/);
    expect(html).toMatch(/Runs until [^<]*2026/);
    expect(html).toContain('Khai trương chi nhánh');
    expect(html).toContain('Waiting for the platform');
    for (const word of ['Pause', 'Resume', 'Archive', 'Lower budget', 'Ask to raise', 'Shorten schedule', 'Ask to extend', 'Cancel']) expect(html, word).not.toContain(`>${word}<`);
    expect(html).not.toContain('<form');
    expect(seen.buttons).toEqual([]);
    expect(seen.dialogs).toEqual([]);
  });

  it('shows an owner or an admin the controls: Pause and Archive on a running object, the four forms and the cancel of a queued change', () => {
    const html = render(section({ launch: withManage({ changes: [change({ id: 'c1', state: 'queued' })] }).launch }));
    expect(html).toContain('Pausing an ad, or lowering what it spends, applies without approval');
    expect(html).toContain('needs an approval in the Inbox first');
    expect(buttonsOf('manage-pause')).toHaveLength(3);
    expect(seen.dialogs.map((d) => d.title)).toEqual(['Archive Khai trương chi nhánh?', 'Archive Nhóm khai trương?', 'Archive Quảng cáo 1?']);
    for (const form of ['budget_lower', 'budget_raise', 'schedule_shorten', 'schedule_extend']) expect(html).toContain(`data-testid="manage-form-${form}"`);
    for (const word of ['Lower budget', 'Ask to raise', 'Shorten schedule', 'Ask to extend']) expect(html, word).toContain(`>${word}<`);
    // The forms say what needs approval and what does not.
    expect(html).toContain('Applies without approval once the platform confirms it.');
    expect(html).toContain('Needs approval in the Inbox');
    expect(buttonsOf('manage-cancel')).toHaveLength(1);
  });

  it('offers Resume, not Pause, on a paused object, says resuming needs approval, and offers nothing on an archived one or one waiting for the platform', () => {
    const html = render(
      section({
        launch: withManage({ objects: [object('campaign', { status: 'paused' }), object('ad_set', { status: 'archived' }), object('ad_1', { pending: 'pause' })] }).launch,
      }),
    );
    expect(buttonsOf('manage-resume')).toHaveLength(1);
    expect(buttonsOf('manage-pause')).toHaveLength(0);
    expect(html).toContain('Resuming asks for approval in the Inbox first.');
    expect(html).toContain('Paused');
    expect(html).toContain('Archived');
    // The archived object and the one waiting offer no archive: only the paused one has it.
    expect(seen.dialogs.map((d) => d.title)).toEqual(['Archive Khai trương chi nhánh?']);
  });

  it('offers only Pause and says why when the controls cannot change, with no form', () => {
    const html = render(section({ launch: withManage({ canChange: false, objects: [object('campaign'), object('ad_set', { status: 'paused' })] }).launch }));
    expect(html).toContain('data-testid="manage-limited"');
    expect(html).toContain('Only Pause is available now: running ads is turned off, this ad account is not enabled, or launches are blocked.');
    expect(buttonsOf('manage-pause')).toHaveLength(1);
    expect(buttonsOf('manage-resume')).toHaveLength(0);
    expect(seen.dialogs).toEqual([]);
    expect(html).not.toContain('<form');
    expect(html).not.toContain('Ask to raise');
  });

  it('draws nothing for a launch that is not live', () => {
    for (const state of ['queued', 'launching', 'needs_attention', 'stopped', 'failed', 'cancelled'] as const) {
      expect(render(section({ launch: { state } })), state).toBe('');
    }
    expect(render(section({ launch: { manage: undefined as unknown as AdsLaunchView['manage'] } }))).toBe('');
  });

  it('holds a form back while a change of its kind waits for the platform, and says so', () => {
    const html = render(section({ launch: withManage({ changes: [change({ kind: 'budget_raise', slot: 'ad_set', state: 'queued', fromBudget: '100000', toBudget: '150000' })] }).launch }));
    expect(html).toContain('A budget change is waiting for the platform.');
    expect(html).not.toContain('data-testid="manage-form-budget_lower"');
    expect(html).not.toContain('data-testid="manage-form-budget_raise"');
    expect(html).toContain('data-testid="manage-form-schedule_shorten"');
  });

  it('says the platform has not confirmed a raise or an extension yet while more is held than confirmed', () => {
    const plain = render(section());
    expect(plain).not.toContain('manage-held-budget');
    expect(plain).not.toContain('manage-held-end');
    const html = render(section({ launch: withManage({ heldDailyBudget: '150000', heldEndOn: '2026-12-10' }).launch }));
    expect(html).toContain('data-testid="manage-held-budget"');
    expect(html).toMatch(/The platform has not confirmed the higher budget yet, so [^<]*150[.,]000[^<]* a day stays held/);
    expect(html).toContain('data-testid="manage-held-end"');
    expect(html).toContain('The platform has not confirmed the later end date yet');
  });

  it('is in Vietnamese too, with the coworker-free plain words', () => {
    const html = render(section(), 'vi');
    expect(html).toContain('Quản lý lần chạy này');
    expect(html).toContain('Tạm dừng');
    expect(html).toContain('Giảm ngân sách');
    expect(html).toContain('Xin tăng');
    expect(html).toContain('Xin kéo dài');
    expect(html).toContain('Chứng từ chờ duyệt');
  });

  it('sits under the live launch note on the Campaigns screen for an owner, and not for a stopped launch', () => {
    const draft: AdsCampaignDraftView = {
      id: 'd1',
      adAccountId: 'a1',
      adAccountName: 'Quảng cáo cửa hàng',
      currency: 'VND',
      status: 'approved',
      revision: 2,
      plan: {
        name: 'Khai trương chi nhánh',
        objective: 'traffic',
        dailyBudget: '100000',
        startOn: '2026-11-10',
        endOn: '2026-11-30',
        targeting: { locations: [{ country: 'VN' }], ageMin: 22, ageMax: 45, gender: 'all', interests: [] },
        linkUrl: 'https://example.com/khai-truong',
        pageConnectionId: null,
        sourcePostId: null,
        mediaFileId: null,
        variants: [{ headline: 'Khai trương', primaryText: 'Mời bạn ghé thử.', callToAction: 'learn_more' }],
      },
      origin: 'human',
      aiFields: [],
      maxSpend: '2000000',
      days: 21,
      issues: [],
      pendingProposalId: null,
      launch: launch(),
      createdAt: at,
      updatedAt: at,
    };
    const account = { id: 'a1', currency: 'VND' } as never;
    const page = (over: Partial<AdsCampaignDraftView>, canManage = true) => (
      <CampaignBuilder slug="demo" account={account} draft={{ ...draft, ...over }} seed={null} canManage={canManage} pages={[]} onSaved={() => undefined} onDiscarded={() => undefined} />
    );
    const live = render(page({}));
    expect(live).toContain('This launch is live on the ad platform.');
    expect(live).toContain('data-testid="campaign-manage"');
    expect(live.indexOf('data-testid="campaign-launch"')).toBeLessThan(live.indexOf('data-testid="campaign-manage"'));
    const member = render(page({}, false));
    expect(member).toContain('data-testid="campaign-manage"');
    expect(member).not.toContain('data-testid="manage-form-budget_lower"');
    expect(render(page({ launch: launch({ state: 'stopped' }) }))).not.toContain('campaign-manage');
    expect(render(page({ launch: launch({ state: 'launching', manage: undefined as unknown as AdsLaunchView['manage'] }) }))).not.toContain('campaign-manage');
  });
});

describe('the changes list, in words', () => {
  const rows = (changes: AdsManageChangeView[], locale: 'en' | 'vi' = 'en') => render(section({ launch: withManage({ changes }).launch }), locale);

  it('says waiting for the platform, done, cancelled, and what did not go through and why', () => {
    const html = rows([
      change({ id: 'a', kind: 'pause', state: 'queued' }),
      change({ id: 'b', kind: 'budget_lower', slot: 'ad_set', state: 'applied', fromBudget: '100000', toBudget: '80000' }),
      change({ id: 'c', kind: 'archive', slot: 'ad_1', state: 'cancelled', code: 'switch_off' }),
      change({ id: 'd', kind: 'schedule_shorten', slot: 'ad_set', state: 'failed', code: 'token_expired', fromEndOn: '2026-11-30', toEndOn: '2026-11-25' }),
    ]);
    expect(html).toContain('data-state="queued"');
    expect(html).toContain('Waiting for the platform');
    expect(html).toContain('Done');
    expect(html).toContain('Cancelled');
    expect(html).toContain('Did not go through');
    expect(html).toContain('Why: running ads was turned off.');
    expect(html).toContain('Why: the ad account connection expired; reconnect it on the Ads screen.');
    expect(html).toContain('Pause Khai trương chi nhánh');
    expect(html).toMatch(/Lower the daily budget from [^<]*100[.,]000[^<]* to [^<]*80[.,]000/);
  });

  it('says an unclear change could not be confirmed and to check at the platform, and that a raise keeps its amount held', () => {
    const html = rows([
      change({ id: 'u1', kind: 'budget_raise', slot: 'ad_set', state: 'unclear', fromBudget: '100000', toBudget: '150000' }),
      change({ id: 'u2', kind: 'pause', state: 'unclear' }),
    ]);
    expect(html).toContain('Could not confirm, check at the platform');
    // Only what can add spend keeps an amount held.
    expect(html.match(/data-testid="manage-change-held"/g)).toHaveLength(1);
    expect(html).toContain('stays held against your spend caps');
  });

  it('words a failure code it does not know as a general line, with the code as plain text, never as markup', () => {
    const html = rows([change({ state: 'failed', code: '<img src=x onerror=alert(1)>' })]);
    expect(html).toContain('the change did not go through (code &lt;img src=x onerror=alert(1)&gt;)');
    expect(html).not.toContain('<img');
  });

  it('keeps an object name with an invisible control character visible, never applied', () => {
    const html = render(section({ launch: withManage({ objects: [object('campaign', { name: 'Hạ giá‮gnirts' }), object('ad_set')] }).launch }));
    expect(html).toContain('Hạ giá⟨U+202E⟩gnirts');
    expect(html).not.toContain('‮');
  });

  it('offers a queued change its cancel, and a settled one none', () => {
    rows([change({ id: 'q', state: 'queued' }), change({ id: 'a', state: 'applied' }), change({ id: 'f', state: 'failed', code: 'unknown' })]);
    expect(buttonsOf('manage-cancel')).toHaveLength(1);
  });

  it('is in Vietnamese too', () => {
    const html = rows([change({ state: 'unclear', kind: 'schedule_extend', slot: 'ad_set', fromEndOn: '2026-11-30', toEndOn: '2026-12-10' })], 'vi');
    expect(html).toContain('Chưa xác nhận được, hãy kiểm tra trên nền tảng');
    expect(html).toContain('Kéo dài ngày kết thúc từ');
  });
});

describe('each control calls its procedure with an idempotency key', () => {
  const calls = (name: string) => (seen.ads[name] as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as Record<string, unknown>);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  it('Pause calls pauseObject for the object, with a key', async () => {
    render(section());
    press(buttonsOf('manage-pause')[1] as Props);
    await settle();
    expect(calls('pauseObject')).toEqual([{ launchId: LAUNCH, slot: 'ad_set', idempotencyKey: expect.stringMatching(UUID) }]);
    expect(calls('requestChange')).toEqual([]);
  });

  it('Resume asks for approval through requestChange with the object_resume kind, never resumes directly', async () => {
    render(section({ launch: withManage({ objects: [object('campaign', { status: 'paused' })] }).launch }));
    press(button('manage-resume'));
    await settle();
    expect(calls('requestChange')).toEqual([{ change: 'object_resume', launchId: LAUNCH, slot: 'campaign', idempotencyKey: expect.stringMatching(UUID) }]);
    expect(calls('pauseObject')).toEqual([]);
  });

  it('Archive asks first, and calls archiveObject only when confirmed', async () => {
    render(section());
    const dialog = seen.dialogs[2] as Props;
    expect(dialog.destructive).toBe(true);
    expect(dialog.title).toBe('Archive Quảng cáo 1?');
    expect(String(dialog.description)).toContain('Archiving is permanent');
    await settle();
    expect(calls('archiveObject')).toEqual([]);
    (dialog.onConfirm as () => void)();
    await settle();
    expect(calls('archiveObject')).toEqual([{ launchId: LAUNCH, slot: 'ad_1', idempotencyKey: expect.stringMatching(UUID) }]);
  });

  it('Cancel calls cancelChange for the change', async () => {
    render(section({ launch: withManage({ changes: [change({ id: '7e1d2c3b-4a59-4687-9a0b-1c2d3e4f5a6b', state: 'queued' })] }).launch }));
    press(button('manage-cancel'));
    await settle();
    expect(calls('cancelChange')).toEqual([{ changeId: '7e1d2c3b-4a59-4687-9a0b-1c2d3e4f5a6b', idempotencyKey: expect.stringMatching(UUID) }]);
  });

  it('shows the link to the Inbox item after a request for approval', () => {
    const html = render(<AskedNote slug="demo" proposalId="9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a" />);
    expect(html).toContain('Asked for approval. It waits in the Inbox.');
    expect(html).toContain('href="/o/demo/inbox/9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a"');
    expect(html).toContain('Open the Inbox');
    expect(render(<AskedNote slug="demo" proposalId="p1" />, 'vi')).toContain('Mở Chứng từ chờ duyệt');
  });
});

describe('one row of the objects and of the changes on their own', () => {
  it('an object row names its level and status, and presses Pause with the kind it was given', () => {
    const onRequest = vi.fn();
    const html = render(<ObjectRow object={object('ad_1')} offers={['pause', 'archive']} busy={false} onRequest={onRequest} />);
    expect(html).toContain('Ad: <span class="font-medium">Quảng cáo 1</span>');
    expect(html).toContain('Running');
    press(button('manage-pause'));
    expect(onRequest).toHaveBeenCalledWith('pause');
    confirm(0);
    expect(onRequest).toHaveBeenLastCalledWith('archive');
  });

  it('a change row words its sentence from the objects of the launch', () => {
    const html = render(<ChangeRow change={change({ kind: 'resume', slot: 'ad_set' })} objects={[object('ad_set')]} currency="VND" canCancel={false} busy={false} onCancel={() => undefined} />);
    expect(html).toContain('Resume Nhóm khai trương');
    expect(html).not.toContain('manage-cancel');
  });
});

describe('the suggestion of the AI coworker', () => {
  const suggestion = (over: Partial<AdsManageSuggestion> = {}): AdsManageSuggestion => ({
    launchId: LAUNCH,
    adAccountId: 'a1',
    campaignName: 'Khai trương chi nhánh',
    kind: 'pause',
    slot: 'campaign',
    toBudget: null,
    currency: 'VND',
    recentCost: '90000',
    medianCost: '30000',
    ratio: '3.00',
    recentResults: '12',
    day: '2026-11-18',
    ...over,
  });
  const list = (suggestions: AdsManageSuggestion[], onApply = vi.fn(), error: string | null = null) => ({ node: <SuggestionList suggestions={suggestions} busy={false} error={error} onApply={onApply} />, onApply });
  const coworker = catalog('en').ads.manage.suggestion.title;

  it('renders nothing when there is no suggestion (AI off, or nothing to say)', () => {
    expect(render(list([]).node)).toBe('');
    expect(render(<ManageSuggestions adAccountId="a1" canManage={false} />)).toBe('');
    // The query not answered yet (or answering with an error) draws nothing either.
    expect(render(<ManageSuggestions adAccountId="a1" canManage />)).toBe('');
    seen.client.setQueryData(['ads', 'manageSuggestions', { adAccountId: 'a1' }], []);
    expect(render(<ManageSuggestions adAccountId="a1" canManage />)).toBe('');
  });

  it('names the coworker through the roster and says it only suggests', () => {
    const html = render(list([suggestion()]).node);
    // The roster's name stands in the title; the placeholder never reaches the screen.
    expect(coworker).toMatch(/^Suggested by \S/);
    expect(coworker).not.toContain('{marketing}');
    expect(html).toContain(coworker);
    expect(html).toContain('It only suggests: nothing changes until you confirm.');
    expect(html).not.toContain('{marketing}');
  });

  it('says in plain words what it saw, with the numbers: the cost per result of the last days, the usual one, the ratio and the results', () => {
    const html = render(list([suggestion({ ratio: '3.40' })]).node);
    expect(html).toContain('Khai trương chi nhánh');
    expect(html).toMatch(/cost [^<]*90[.,]000[^<]* per result over the last days, against [^<]*30[.,]000[^<]* usually: 3\.4 times as much, from 12 results\./);
    expect(html).toContain('suggests pausing it.');
  });

  it('offers ONE button for a pause, and ONE for a lower budget with its own figure, each behind a confirm', () => {
    const pause = render(list([suggestion()]).node);
    expect(pause).toContain('Pause this campaign');
    expect(seen.dialogs).toHaveLength(1);
    expect(seen.dialogs[0]?.title).toBe('Pause “Khai trương chi nhánh”?');
    seen.dialogs.length = 0;
    const lower = render(list([suggestion({ kind: 'budget_lower', toBudget: '70000' })]).node);
    expect(lower).toMatch(/Lower the budget to [^<]*70[.,]000/);
    expect(lower).toMatch(/suggests lowering its daily budget to [^<]*70[.,]000/);
    expect(seen.dialogs).toHaveLength(1);
    expect(seen.dialogs[0]?.title).toBe('Lower the budget of “Khai trương chi nhánh”?');
  });

  it('never offers a raise, whatever it is given', () => {
    const html = render(list([suggestion(), suggestion({ kind: 'budget_lower', toBudget: '70000', slot: 'ad_set' })]).node);
    expect(html).not.toMatch(/Raise|raise|Resume|Extend|Ask to/);
    // One button per card, each behind its own confirm.
    expect(seen.dialogs).toHaveLength(2);
  });

  it('applies the pause only after the confirm, with the person\'s own click, and calls pauseObject with a key', async () => {
    const { node, onApply } = list([suggestion()]);
    render(node);
    // Rendering and pressing the trigger apply nothing: only the dialog's confirm does.
    expect(onApply).not.toHaveBeenCalled();
    confirm(0);
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledWith({ kind: 'pause', launchId: LAUNCH, slot: 'campaign' });
  });

  it('applies the lower budget only after the confirm, with its figure', () => {
    const { node, onApply } = list([suggestion({ kind: 'budget_lower', toBudget: '70000' })]);
    render(node);
    expect(onApply).not.toHaveBeenCalled();
    confirm(0);
    expect(onApply).toHaveBeenCalledWith({ kind: 'budget_lower', launchId: LAUNCH, dailyBudget: '70000' });
  });

  it('the container sends a confirmed pause to pauseObject and a confirmed lower budget to lowerBudget, never to requestChange', async () => {
    seen.client.setQueryData(['ads', 'manageSuggestions', { adAccountId: 'a1' }], [suggestion(), suggestion({ kind: 'budget_lower', toBudget: '70000', launchId: '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a' })]);
    const html = render(<ManageSuggestions adAccountId="a1" canManage />);
    expect(html).toContain('data-testid="manage-suggestions"');
    expect(seen.dialogs).toHaveLength(2);
    expect(seen.ads.pauseObject).not.toHaveBeenCalled();
    confirm(0);
    confirm(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((seen.ads.pauseObject as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual([{ launchId: LAUNCH, slot: 'campaign', idempotencyKey: expect.stringMatching(UUID) }]);
    expect((seen.ads.lowerBudget as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual([{ launchId: '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a', dailyBudget: '70000', idempotencyKey: expect.stringMatching(UUID) }]);
    expect(seen.ads.requestChange).not.toHaveBeenCalled();
    seen.client.clear();
  });

  it('a card for a lower budget with no figure draws nothing', () => {
    const html = render(<ul><SuggestionCard suggestion={suggestion({ kind: 'budget_lower', toBudget: null })} busy={false} onApply={() => undefined} /></ul>);
    expect(html).toBe('<ul></ul>');
  });

  it('shows the refusal under the cards', () => {
    expect(render(list([suggestion()], vi.fn(), 'A change of the same kind is already waiting').node)).toContain('A change of the same kind is already waiting');
  });

  it('is in Vietnamese too, with the coworker named by the roster', () => {
    const html = render(list([suggestion({ kind: 'budget_lower', toBudget: '70000' })]).node, 'vi');
    expect(html).toContain('Gợi ý của ');
    expect(html).toContain('Chỉ là gợi ý: bạn xác nhận thì mới đổi gì.');
    expect(html).toContain('Giảm ngân sách xuống');
    expect(html).not.toContain('{marketing}');
  });
});
