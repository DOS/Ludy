// SPDX-License-Identifier: AGPL-3.0-only
// The tabs of Settings rendered on the server (ST-1, ST-3, ST-6, ST-8, #3589): which cards each tab holds, one column and no two-column grid, one value then "Sửa" for the fields of
// the org, the reminders under the approval rule, and the members' tab for the owner alone to delete the org.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { catalog } from '../src/i18n/runtime.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));
const modules = vi.hoisted(() => ({ current: ['kernel', 'finance', 'social', 'crm', 'meetings'] as string[] }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  client.current = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return () => ({ queryKey: path, queryFn: () => Promise.reject(new Error('not fetched')) });
        if (prop === 'mutationOptions') return () => ({ mutationFn: () => Promise.resolve(undefined) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), client: {}, queryClient: client.current, errorMessage: (e: unknown) => String(e), isStepUpRequired: () => false, apiFetch: () => undefined };
});
vi.mock('../src/lib/org-modules.ts', () => ({ installedModules: () => modules.current, useModulesVersion: () => 0 }));
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useLocation: () => ({ hash: '' }),
  useSearch: () => ({}),
  Link: ({ to, hash, children }: { to: string; hash?: string; children: unknown }) => <a href={`${to}${hash ? `#${hash}` : ''}`}>{children as never}</a>,
}));

// A card of another app, or one with its own tests, as a marker: what is checked here is which tab holds it.
const stub = (name: string) => () => <div data-card={name} />;
vi.mock('../src/components/conversation-retention.tsx', () => ({ ConversationRetentionCard: stub('conversation-retention') }));
vi.mock('../src/components/engage-wake-rules.tsx', () => ({ EngageWakeRulesCard: stub('engage-wake-rules') }));
vi.mock('../src/components/extension-devices.tsx', () => ({ ExtensionDevices: stub('extension-devices') }));
vi.mock('../src/components/meeting-platforms.tsx', () => ({ MeetingPlatforms: stub('meeting-platforms') }));
vi.mock('../src/components/minutes-templates.tsx', () => ({ MinutesTemplatesCard: stub('minutes-templates') }));
vi.mock('../src/components/org-apps.tsx', () => ({ OrgAppsCard: stub('org-apps') }));
vi.mock('../src/components/org-extension-devices.tsx', () => ({ OrgExtensionDevices: stub('org-extension-devices') }));
vi.mock('../src/components/quote-settings-card.tsx', () => ({ QuoteSettingsCard: stub('quote-settings') }));
vi.mock('../src/components/sales-process-card.tsx', () => ({ SalesProcessCard: stub('sales-process') }));
vi.mock('../src/components/sessions.tsx', () => ({ MySessions: stub('my-sessions'), MemberSessions: stub('member-sessions') }));
vi.mock('../src/components/two-factor.tsx', () => ({ TwoFactorCard: stub('two-factor'), StepUpPrompt: stub('step-up') }));
vi.mock('../src/routes/account-rules.tsx', () => ({ AccountRulesCard: stub('account-rules') }));
vi.mock('../src/routes/accounts.tsx', () => ({ ChartOfAccountsCard: stub('chart-of-accounts') }));
vi.mock('../src/routes/approval-preset.tsx', () => ({ ApprovalPresetCard: ({ children }: { children?: unknown }) => <div data-card="approval-preset">{children as never}</div>, MEMBERS_CARD_ID: 'settings-members' }));
vi.mock('../src/routes/bank-account-numbers.tsx', () => ({ BankAccountNumbersCard: stub('bank-account-numbers') }));
vi.mock('../src/routes/bank-party-rules.tsx', () => ({ BankPartyRulesCard: stub('bank-party-rules') }));
vi.mock('../src/routes/event-types.tsx', () => ({ EventTypesCard: stub('event-types') }));
vi.mock('../src/routes/integrations.tsx', () => ({ IntegrationsSection: stub('integrations') }));
vi.mock('../src/routes/legal-entities.tsx', () => ({ LegalEntitiesCard: stub('legal-entities') }));
vi.mock('../src/routes/misa-goods-codes.tsx', () => ({ MisaGoodsCodesCard: stub('misa-goods-codes') }));
vi.mock('../src/routes/working-hours.tsx', () => ({ WorkingHoursCard: stub('working-hours') }));
vi.mock('../src/routes/settings/members-card.tsx', () => ({ MembersCard: stub('members') }));
vi.mock('../src/routes/settings/offboarding.tsx', () => ({ Offboarding: stub('offboarding') }));

const pages = await import('../src/routes/settings/pages.tsx');

const org = (role: 'owner' | 'admin' | 'member') => ({
  slug: 'acme',
  name: 'Acme',
  role,
  members: [{ userId: 'u1', email: 'a@example.test', displayName: 'An', role }],
  address: '12 Nguyễn Huệ',
  contactEmail: null,
  inboundAddress: null,
  inboundDroppedCount: 0,
  taxCode: '0101234567',
  vatFilingPeriod: 'quarter',
  approvalPreset: 'founder',
});

function render(page: keyof typeof pages, role: 'owner' | 'admin' | 'member' = 'owner', locale: 'vi' | 'en' = 'vi'): string {
  const qc = client.current;
  qc.clear();
  qc.setQueryData(['org', 'get'], org(role));
  qc.setQueryData(['me', 'get'], { userId: 'u1', orgs: [] });
  qc.setQueryData(['org', 'taxProfile'], { obligations: ['vat_return', 'pit_withholding'], pitFilingPeriod: 'month', fiscalYearEndMonth: 12 });
  qc.setQueryData(['org', 'proposalPolicy'], { remindAfterDays: 3, escalateAfterDays: 7, expireAfterDays: null });
  const Page = pages[page];
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        <Page />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

const cardsOf = (html: string) => [...html.matchAll(/data-card="([^"]+)"/g)].map((m) => m[1]);

describe('which cards each tab of Settings holds', () => {
  it('Tổ chức: who the org is, its tax profile and its legal entities', () => {
    const html = render('SettingsOrgPage');
    expect(cardsOf(html)).toEqual(['legal-entities']);
    expect(html).toContain('Acme');
    expect(html).toContain('12 Nguyễn Huệ');
    expect(html).toContain('Hồ sơ thuế');
  });

  it('Thành viên và quyền: the members and the approval rule with its reminders under it', () => {
    const html = render('SettingsMembersPage');
    expect(cardsOf(html)).toEqual(['members', 'approval-preset']);
    // The reminders sit inside the approval card (ST-6).
    const approval = html.slice(html.indexOf('data-card="approval-preset"'));
    expect(approval).toContain('Nhắc duyệt đề xuất');
    expect(html.indexOf('Nhắc duyệt đề xuất')).toBeGreaterThan(html.indexOf('data-card="members"'));
  });

  it('Ứng dụng: the switches, the retention of conversations and the minutes templates', () => {
    expect(cardsOf(render('SettingsAppsPage'))).toEqual(['org-apps', 'conversation-retention', 'engage-wake-rules', 'minutes-templates']);
  });

  it('Lịch hẹn: the working hours and the booking event types', () => {
    expect(cardsOf(render('SettingsBookingsPage'))).toEqual(['working-hours', 'event-types']);
  });

  it('Báo giá: the letterhead of the quotes, for owners and admins', () => {
    expect(cardsOf(render('SettingsQuotesPage'))).toEqual(['quote-settings']);
    expect(cardsOf(render('SettingsQuotesPage', 'member'))).toEqual([]);
  });

  it('Bán hàng: the deal board, for owners and admins', () => {
    expect(cardsOf(render('SettingsSalesPage'))).toEqual(['sales-process']);
    expect(cardsOf(render('SettingsSalesPage', 'member'))).toEqual([]);
    // A member opens the tab and is told why it holds nothing for them, not an empty page.
    expect(render('SettingsSalesPage', 'member')).toContain('Chỉ chủ sở hữu và quản trị viên thay đổi được các mục này.');
  });

  it('Kế toán và thuế: the master data of the books', () => {
    expect(cardsOf(render('SettingsAccountingPage'))).toEqual(['chart-of-accounts', 'misa-goods-codes', 'account-rules', 'bank-party-rules']);
  });

  it('Kết nối: the integrations and the bank account numbers', () => {
    expect(cardsOf(render('SettingsConnectionsPage'))).toEqual(['integrations', 'bank-account-numbers']);
    expect(cardsOf(render('SettingsConnectionsPage', 'member'))).toEqual(['integrations']);
  });

  it('Bảo mật tài khoản: the person\'s own second factor and devices, and the team\'s devices for an admin', () => {
    expect(cardsOf(render('SettingsSecurityPage'))).toEqual(['two-factor', 'my-sessions', 'meeting-platforms', 'extension-devices', 'org-extension-devices']);
    expect(cardsOf(render('SettingsSecurityPage', 'member'))).toEqual(['two-factor', 'my-sessions', 'meeting-platforms', 'extension-devices']);
  });

  it('Dữ liệu và xóa tổ chức: the owner deletes the org, others are told who can', () => {
    const owner = render('SettingsDataPage', 'owner');
    expect(cardsOf(owner)).toEqual(['offboarding']);
    expect(owner).toContain('href="/o/$slug/personal-data"');
    expect(owner).toContain('href="/o/$slug/audit"');
    const admin = render('SettingsDataPage', 'admin');
    expect(cardsOf(admin)).toEqual([]);
    expect(admin).toContain('Chỉ chủ sở hữu mới xóa được tổ chức.');
    const member = render('SettingsDataPage', 'member');
    expect(member).not.toContain('href="/o/$slug/audit"');
    expect(member).toContain('Chỉ chủ sở hữu mới xóa được tổ chức.');
  });

  it('leaves out the cards of an app that is off', () => {
    modules.current = ['kernel'];
    try {
      expect(cardsOf(render('SettingsAppsPage'))).toEqual(['org-apps']);
      expect(cardsOf(render('SettingsBookingsPage'))).toEqual(['working-hours']);
      expect(cardsOf(render('SettingsSalesPage'))).toEqual([]);
      expect(cardsOf(render('SettingsQuotesPage'))).toEqual([]);
      expect(cardsOf(render('SettingsOrgPage'))).toEqual([]);
      expect(cardsOf(render('SettingsSecurityPage'))).toEqual(['two-factor', 'my-sessions']);
      expect(cardsOf(render('SettingsConnectionsPage'))).toEqual([]);
    } finally {
      modules.current = ['kernel', 'finance', 'social', 'crm', 'meetings'];
    }
  });
});

describe('one column and one pattern for the fields (ST-6, ST-8)', () => {
  it('lists the cards of a tab in one column, never a two-column grid', () => {
    for (const page of ['SettingsOrgPage', 'SettingsMembersPage', 'SettingsAppsPage', 'SettingsBookingsPage', 'SettingsQuotesPage', 'SettingsAccountingPage', 'SettingsSecurityPage'] as const) {
      const html = render(page);
      expect(html, page).toContain('class="grid max-w-4xl gap-6"');
      expect(html, page).not.toContain('lg:grid-cols-2');
    }
  });

  it('shows each field of the tax profile as its value and a "Sửa" button, with no editor open', () => {
    const html = render('SettingsOrgPage');
    expect(html).toContain('0101234567');
    expect(html).toContain('Theo quý');
    expect(html).toContain('Tờ khai thuế GTGT, Tờ khai thuế TNCN khấu trừ');
    // Mã số thuế, Kỳ khai thuế GTGT and Lịch thuế, one edit button each; no select or checkbox until "Sửa" is pressed.
    expect(html.match(/>Sửa<\/button>/g)).toHaveLength(3);
    expect(html).not.toContain('<select');
    expect(html).not.toContain('type="checkbox"');
  });

  it('shows the reminders as three values and one "Sửa", with no select open', () => {
    const html = render('SettingsMembersPage');
    expect(html).toContain('Nhắc người duyệt sau: </span><span class="text-foreground">3 ngày');
    expect(html).toContain('Báo chủ sở hữu sau: </span><span class="text-foreground">7 ngày');
    expect(html).toContain('Không đặt hạn');
    expect(html.match(/>Sửa<\/button>/g)).toHaveLength(1);
    expect(html).not.toContain('<select');
  });

  it('offers no edit button to a member, and says the same in English', () => {
    const html = render('SettingsOrgPage', 'member');
    expect(html).not.toContain('>Sửa</button>');
    // The tax code keeps its own wording ("Change"); the other two say "Edit".
    const en = render('SettingsOrgPage', 'admin', 'en');
    expect(en.match(/>Edit<\/button>/g)).toHaveLength(2);
    expect(en).toContain('>Change</button>');
  });
});
