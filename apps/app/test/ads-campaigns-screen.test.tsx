// SPDX-License-Identifier: AGPL-3.0-only
// The campaign builder's parts (W1c, #2295), rendered on the server with the API's answers seeded in the cache: the builder of a new draft, of a draft
// the AI coworker wrote (each field it drafted marked), of one with findings, and one waiting for approval or already approved; what each role is offered
// (an owner or an admin asks for approval, a member only drafts); the largest amount the plan can spend in one sentence; and the request panel of the AI
// coworker with its waiting, written and refused requests, the meter's refusal in words. The page itself, which reads the address and the session, is covered
// end to end (e2e/tests/ads-campaigns.spec.ts).
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { COWORKER_ROSTER, type AdAccountView, type AdsCampaignDraftView, type AdsCampaignRequestView } from '@crove/kernel-contract';
import { catalog } from '../src/i18n/runtime.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

// A link as an anchor that names where it leads: the route with its parameters filled in.
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
  client.current = new QC();
  // orpc.<a>.<b>.queryOptions() / mutationOptions() / key(): the key is the path and the input, nothing is ever fetched.
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') {
          return (options?: { input?: unknown }) => ({
            queryKey: options?.input === undefined ? path : [...path, options.input],
            queryFn: () => Promise.reject(new Error('not fetched')),
          });
        }
        if (prop === 'mutationOptions') return () => ({ mutationFn: () => Promise.resolve({}) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), queryClient: client.current, errorMessage: (e: unknown) => String(e), isStepUpRequired: () => false, client: {} };
});

const { CampaignBuilder } = await import('../src/components/ads-campaign-builder.tsx');
const { CampaignAsk } = await import('../src/components/ads-campaign-ask.tsx');
const { PostPicker } = await import('../src/components/ads-post-picker.tsx');
const { startFromPost, formFromPost } = await import('../src/lib/ads-campaigns.ts');

function render(node: ReactNode, locale: 'en' | 'vi' = 'en'): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={client.current}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        {node}
      </IntlProvider>
    </QueryClientProvider>,
  );
}

const at = '2026-11-03T00:00:00.000Z';
const ID = '3f2b8c1e-4d5a-4e6f-8a9b-0c1d2e3f4a5b';
const uy = COWORKER_ROSTER.marketing;

const account = (over: Partial<AdAccountView> = {}): AdAccountView => ({
  id: 'a1',
  connectionId: 'c1',
  connectionStatus: 'active',
  pausedSince: null,
  pausedReason: null,
  writeEnabled: true,
  writeConnectionStatus: 'active',
  canRunAds: true,
  extraScopes: [],
  provider: 'sandbox_ads',
  name: 'Quảng cáo cửa hàng',
  currency: 'VND',
  timeZone: 'Asia/Ho_Chi_Minh',
  legalEntityId: 'e1',
  expenseAccountCode: null,
  resultKind: null,
  resultKinds: ['purchase', 'lead'],
  backfillFrom: '2025-10-01',
  settledThrough: '2026-11-02',
  syncedThrough: '2026-11-03',
  lastRunAt: at,
  lastErrorKind: null,
  nextRunAt: null,
  ...over,
});

const draft = (over: Partial<AdsCampaignDraftView> = {}): AdsCampaignDraftView => ({
  id: ID,
  adAccountId: 'a1',
  adAccountName: 'Quảng cáo cửa hàng',
  currency: 'VND',
  status: 'draft',
  revision: 2,
  plan: {
    name: 'Khai trương chi nhánh',
    objective: 'traffic',
    dailyBudget: '100000',
    startOn: '2026-11-10',
    endOn: '2026-11-16',
    targeting: { locations: [{ country: 'VN' }], ageMin: 22, ageMax: 45, gender: 'all', interests: [] },
    linkUrl: 'https://example.com/khai-truong',
    pageConnectionId: null,
    sourcePostId: null,
    mediaFileId: null,
    variants: [{ headline: 'Khai trương', primaryText: 'Mời bạn ghé thử.', callToAction: 'learn_more' }],
  },
  origin: 'human',
  aiFields: [],
  maxSpend: '700000',
  days: 7,
  issues: [],
  pendingProposalId: null,
  launch: null,
  createdAt: at,
  updatedAt: at,
  ...over,
});

const builder = (over: { draft?: AdsCampaignDraftView | null; canManage?: boolean; seed?: ReturnType<typeof formFromPost> | null } = {}) => (
  <CampaignBuilder slug="demo" account={account()} draft={over.draft === undefined ? draft() : over.draft} seed={over.seed ?? null} canManage={over.canManage ?? true} pages={[]} onSaved={() => undefined} onDiscarded={() => undefined} />
);

// Whether the button with this text is there, and off (its own `disabled` attribute: the class names carry the word too).
function buttonState(html: string, text: string): 'missing' | 'disabled' | 'enabled' {
  const tag = new RegExp(`<button([^>]*)>(?:(?!</button>)[\\s\\S])*?${text}`).exec(html)?.[1];
  return tag === undefined ? 'missing' : /\sdisabled=""/.test(tag) ? 'disabled' : 'enabled';
}

describe('the builder of a new draft', () => {
  const html = render(builder({ draft: null }));

  it('offers the fields, saves first and says the plan is not checked until it is saved', () => {
    expect(html).toContain('New campaign');
    expect(html).toContain('Campaign name');
    expect(html).toContain('Daily budget');
    expect(html).toContain('Who sees it');
    expect(html).toContain('Save the draft');
    expect(html).toContain('Save the draft to check it against the dates and your spend caps.');
  });

  it('has nothing to ask approval for yet, and no largest amount while the budget and the dates are empty', () => {
    expect(buttonState(html, 'Ask for approval')).toBe('disabled');
    expect(html).toContain('Set the daily budget and the dates to see the most it can spend.');
    expect(html).not.toContain('Discard');
  });

  it('shows the post a draft started from only through its texts and keeps the post as an opaque id', () => {
    const start = startFromPost({ id: ID, title: 'Khai trương chi nhánh mới', body: 'Mời bạn ghé thử cà phê mới.', linkUrl: 'https://example.com/khai-truong' });
    const seeded = render(builder({ draft: null, seed: formFromPost(start, 'traffic') }));
    expect(seeded).toContain('Khai trương chi nhánh mới');
    expect(seeded).toContain('Mời bạn ghé thử cà phê mới.');
    expect(seeded).toContain('https://example.com/khai-truong');
    expect(seeded).not.toContain(ID);
  });
});

describe('the builder of a saved draft', () => {
  it('says the largest amount the plan can spend in one sentence, with the days and the daily budget', () => {
    const html = render(builder());
    expect(html).toMatch(/The most it can spend is [^<]*700[.,]000[^<]* over 7 days, [^<]*100[.,]000[^<]* a day\./);
    const vi = render(builder(), 'vi');
    expect(vi).toMatch(/Tối đa có thể chi [^<]*700[.,]000[^<]* trong 7 ngày, mỗi ngày [^<]*100[.,]000/);
  });

  it('says nothing is to be fixed, and lets an owner or an admin ask for approval', () => {
    const html = render(builder());
    expect(html).toContain('Nothing to fix.');
    expect(buttonState(html, 'Ask for approval')).toBe('enabled');
    expect(html).toContain('Discard');
  });

  it('lets a member draft and save but not ask for approval, and says who can', () => {
    const html = render(builder({ canManage: false }));
    expect(html).toContain('Save the draft');
    expect(html).not.toContain('Ask for approval');
    expect(html).toContain('Only an owner or an admin can ask for approval.');
  });

  it('lists what is to fix in words and holds the approval back, and lists the warnings apart', () => {
    const html = render(
      builder({
        draft: draft({
          issues: [
            { code: 'daily_cap_exceeded', severity: 'error', field: 'dailyBudget', params: { scope: 'org' } },
            { code: 'missing_field', severity: 'error', field: 'linkUrl', params: {} },
            { code: 'headline_long', severity: 'warning', field: 'variants', params: { variant: 1, soft: 40 } },
          ],
        }),
      }),
    );
    expect(html).toContain('To fix before it can be approved');
    expect(html).toContain('The daily budget is above the daily spend cap in force.');
    expect(html).toContain('Still missing: the link.');
    expect(html).toContain('Good to know');
    expect(html).toContain('The headline of text 1 is over 40 characters');
    expect(buttonState(html, 'Ask for approval')).toBe('disabled');
    const vi = render(builder({ draft: draft({ issues: [{ code: 'no_cap', severity: 'error', field: null, params: {} }] }) }), 'vi');
    expect(vi).toContain('Cần sửa trước khi được duyệt');
    expect(vi).toContain('Chưa đặt hạn mức chi tiêu nào.');
  });

  it('says why the most it can spend cannot be told when the budget and both dates are there but the flight is backwards', () => {
    const html = render(builder({ draft: draft({ plan: { ...draft().plan, startOn: '2026-11-16', endOn: '2026-11-10' } }) }));
    expect(html).toContain('The most it can spend is worked out for a flight of 1 to 90 days');
    expect(html).not.toContain('Set the daily budget and the dates to see the most it can spend.');
  });

  it('offers the Page of a Messenger ad in place of the link, and the link of the others', () => {
    const messenger = render(builder({ draft: draft({ plan: { ...draft().plan, objective: 'messenger', linkUrl: null } }) }));
    expect(messenger).toContain('The Facebook Page');
    expect(messenger).not.toContain('Where the ad leads');
    const traffic = render(builder());
    expect(traffic).toContain('Where the ad leads');
    expect(traffic).not.toContain('The Facebook Page');
  });

  it('shows a day of a finding the way the date fields write it', () => {
    const html = render(builder({ draft: draft({ issues: [{ code: 'start_in_past', severity: 'error', field: 'startOn', params: { today: '2026-11-03' } }] }) }), 'vi');
    expect(html).toContain('03/11/2026');
    expect(html).not.toContain('2026-11-03');
  });

  it('never shows a cap amount: a member is not told one', () => {
    const html = render(builder({ canManage: false, draft: draft({ issues: [{ code: 'daily_cap_exceeded', severity: 'error', field: 'dailyBudget', params: { scope: 'org' } }] }) }));
    expect(html).toContain('The daily budget is above the daily spend cap in force.');
    expect(html).not.toMatch(/cap of/i);
  });
});

describe('a draft the AI coworker wrote', () => {
  const ai = draft({ origin: 'ai', aiFields: ['name', 'dailyBudget', 'variants'] });

  it('is marked as drafted, with the coworker named by the roster, on the draft and on each field it wrote', () => {
    const html = render(builder({ draft: ai }));
    expect(html).toContain(`Drafted by ${uy}`);
    expect(html).not.toContain('{marketing}');
    expect((html.match(/Drafted by/g) ?? []).length).toBeGreaterThanOrEqual(5);
    const vi = render(builder({ draft: ai }), 'vi');
    expect(vi).toContain(`Do ${uy} soạn`);
  });

  it('is left unmarked on a draft a person wrote', () => {
    expect(render(builder())).not.toContain('Drafted by');
  });
});

describe('a draft that is frozen', () => {
  it('waiting for approval says so, links the Inbox item and offers no change', () => {
    const html = render(builder({ draft: draft({ pendingProposalId: 'p1' }) }));
    expect(html).toContain('Waiting for approval in the Inbox');
    expect(html).toContain('href="/o/demo/inbox/p1"');
    expect(html).toMatch(/<fieldset[^>]*disabled/);
    expect(html).not.toContain('Save the draft');
    expect(html).not.toContain('Ask for approval');
  });

  it('approved says that nothing is spent yet', () => {
    const html = render(builder({ draft: draft({ status: 'approved' }) }));
    expect(html).toContain('Approved. Nothing is spent yet.');
    expect(html).not.toContain('Save the draft');
  });

  // The ledger row of an approved plan (W2-2, #2296): its amount is held against the spend caps until it is cancelled.
  const launch = (over: Partial<NonNullable<AdsCampaignDraftView['launch']>> = {}): NonNullable<AdsCampaignDraftView['launch']> => ({
    id: 'l1',
    draftId: ID,
    adAccountId: 'a1',
    state: 'queued',
    step: null,
    attempt: 1,
    currency: 'VND',
    tag: 'ludy:0123456789',
    dailyBudget: '100000',
    amount: '700000',
    startOn: '2026-11-10',
    endOn: '2026-11-16',
    commitUntil: '2026-11-16',
    stopReason: null,
    createdAt: at,
    finishedAt: null,
    ...over,
  });

  it('an approved plan with a queued launch says its amount is held against the caps and offers owners and admins to cancel it', () => {
    const html = render(builder({ draft: draft({ status: 'approved', launch: launch() }) }));
    expect(html).toContain('is held against your spend caps');
    expect(html).toContain('so nothing is spent yet.');
    expect(html).toContain('Cancel and release the amount');
    // A member sees the note and no button.
    const member = render(builder({ draft: draft({ status: 'approved', launch: launch() }), canManage: false }));
    expect(member).toContain('is held against your spend caps');
    expect(member).not.toContain('Cancel and release the amount');
  });

  it('a cancelled launch says its amount is released, and says it in Vietnamese too', () => {
    const html = render(builder({ draft: draft({ status: 'approved', launch: launch({ state: 'cancelled', commitUntil: null }) }) }));
    expect(html).toContain('This launch was cancelled. The amount held against your spend caps is released.');
    expect(html).not.toContain('Cancel and release the amount');
    const vi = render(builder({ draft: draft({ status: 'approved', launch: launch() }) }), 'vi');
    expect(vi).toContain('đang được giữ chỗ trong hạn mức chi tiêu');
    expect(vi).toContain('Hủy và trả lại số tiền');
  });
});

const request = (over: Partial<AdsCampaignRequestView> = {}): AdsCampaignRequestView => ({
  id: 'r1',
  adAccountId: 'a1',
  adAccountName: 'Quảng cáo cửa hàng',
  objective: 'traffic',
  brief: 'Chi nhánh mới mở thứ Bảy này',
  sourcePostId: null,
  state: 'requested',
  code: null,
  draftId: null,
  requestedAt: at,
  settledAt: null,
  ...over,
});
const ask = (requests: AdsCampaignRequestView[], locale: 'en' | 'vi' = 'en') =>
  render(<CampaignAsk account={account()} brief="" onBrief={() => undefined} sourcePostId={null} requests={requests} onOpenDraft={() => undefined} />, locale);

describe('asking the AI coworker for a draft', () => {
  it('names the coworker by the roster and says what it writes and what it does not', () => {
    const html = ask([]);
    expect(html).toContain(`Ask ${uy} for a draft`);
    expect(html).toContain('the dates and the budget follow your spend caps');
    expect(html).not.toContain('{marketing}');
    expect(buttonState(html, `Ask ${uy}`)).toBe('enabled');
  });

  it('waits for a request that is open: the button is held and the row says it is being written', () => {
    const html = ask([request()]);
    expect(html).toContain(`${uy} is writing the draft.`);
    expect(buttonState(html, `Ask ${uy}`)).toBe('disabled');
  });

  it('offers the draft of a request that was written', () => {
    const html = ask([request({ state: 'written', draftId: ID })]);
    expect(html).toContain('The draft is ready.');
    expect(html).toContain('Open the draft');
  });

  it('says in words why there is no draft: the meter, the rate, the AI being off, and the checks', () => {
    const budget = ask([request({ state: 'none', code: 'AI_BUDGET' })]);
    expect(budget).toContain('The org’s AI budget for this month is used up, so there is no draft.');
    expect(budget).toContain('you can write the campaign yourself');
    expect(budget).not.toContain('AI_BUDGET');
    expect(ask([request({ state: 'none', code: 'RATE_LIMITED' })])).toContain('Too many drafts were asked for in this minute.');
    expect(ask([request({ state: 'none', code: 'AI_OFF' })])).toContain('The AI is not set up on this deployment');
    expect(ask([request({ state: 'none', code: 'FIGURES' })])).toContain('a price, a date or a number that you did not give');
    expect(ask([request({ state: 'none', code: 'LINK' })])).toContain('a link or an address that you did not give');
    const vi = ask([request({ state: 'none', code: 'AI_BUDGET' })], 'vi');
    expect(vi).toContain('Ngân sách AI tháng này của tổ chức đã dùng hết nên không có bản nháp.');
  });

  it('keeps the newest few requests only', () => {
    const many = Array.from({ length: 8 }, (_, i) => request({ id: `r${i}`, state: 'none', code: 'EMPTY', requestedAt: `2026-11-0${i + 1}T00:00:00.000Z` }));
    expect((ask(many).match(/data-testid="campaign-request"/g) ?? []).length).toBe(5);
  });
});

describe('starting from a post', () => {
  it('offers the button that opens the list of posts', () => {
    expect(render(<PostPicker onPick={() => undefined} />)).toContain('Start from a post');
    expect(render(<PostPicker onPick={() => undefined} />, 'vi')).toContain('Bắt đầu từ bài đăng');
  });
});
