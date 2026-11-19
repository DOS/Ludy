// SPDX-License-Identifier: AGPL-3.0-only
import { Link, useSearch } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import { buttonVariants } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { ConversationRetentionCard } from '../../components/conversation-retention.tsx';
import { ExtensionDevices } from '../../components/extension-devices.tsx';
import { MeetingPlatforms } from '../../components/meeting-platforms.tsx';
import { MinutesTemplatesCard } from '../../components/minutes-templates.tsx';
import { OrgAppsCard } from '../../components/org-apps.tsx';
import { OrgExtensionDevices } from '../../components/org-extension-devices.tsx';
import { QuoteSettingsCard } from '../../components/quote-settings-card.tsx';
import { SalesProcessCard } from '../../components/sales-process-card.tsx';
import { MySessions } from '../../components/sessions.tsx';
import { TwoFactorCard } from '../../components/two-factor.tsx';
import { AccountRulesCard } from '../account-rules.tsx';
import { ChartOfAccountsCard } from '../accounts.tsx';
import { ApprovalPresetCard } from '../approval-preset.tsx';
import { BankAccountNumbersCard } from '../bank-account-numbers.tsx';
import { BankPartyRulesCard } from '../bank-party-rules.tsx';
import { EventTypesCard } from '../event-types.tsx';
import { IntegrationsSection } from '../integrations.tsx';
import { LegalEntitiesCard } from '../legal-entities.tsx';
import { MisaGoodsCodesCard } from '../misa-goods-codes.tsx';
import { WorkingHoursCard } from '../working-hours.tsx';
import { AddressField, ContactEmailField, ProposalRemindersField, RotateInboundAddress, TaxCalendarField, TaxCodeField, VatFilingPeriodField } from './fields.tsx';
import { Anchor, SettingsFrame } from './frame.tsx';
import { MembersCard } from './members-card.tsx';
import { Offboarding } from './offboarding.tsx';
import { SETTINGS_CARD } from './tabs.ts';

// The ten tabs of Settings (ST-1, #3589), one screen each. A tab lists its cards in one column and stays under 1200 px at 1440 wide, which decides what sits together. The cards owned by another
// app (the booking and quote cards of Engage, the minutes templates of the meetings) have tabs of their own or sit under "Ứng dụng" until a later issue moves them into their own app's settings.
// A new card is one line in the page of its tab.

// Tổ chức: who the org is, what the tax office knows of it, and the legal entities its books are kept for.
export function SettingsOrgPage() {
  const t = useTranslations('settings');
  return (
    <SettingsFrame>
      {({ org, canManage, modules }) => (
        <>
          <Card className="block p-4">
            <p className="text-sm font-medium text-muted-foreground">{t('org')}</p>
            <dl className="mt-3 space-y-3 text-sm">
              <div>
                <dt className="text-subtle-foreground">{t('name')}</dt>
                <dd className="text-foreground">{org.name}</dd>
              </div>
              <div>
                <dt className="text-subtle-foreground">{t('slug')}</dt>
                <dd className="font-mono text-foreground">{org.slug}</dd>
              </div>
              {/* Keyed by org too: a value typed in one org must not stay in the form when the page shows another. */}
              <AddressField key={`address:${org.slug}:${org.address ?? ''}`} address={org.address ?? null} canManage={canManage} />
              {modules.includes('finance') && (
                <ContactEmailField key={`contact-email:${org.slug}:${org.contactEmail ?? ''}`} email={org.contactEmail ?? null} canManage={canManage} />
              )}
              <div>
                <dt className="text-subtle-foreground">{t('inboundAddress')}</dt>
                <dd className="break-all font-mono text-foreground">{org.inboundAddress ?? t('inboundOff')}</dd>
                {/* Mail to an address retired in the last 30 days is dropped without a bounce; only the count is kept (#139). */}
                {(org.inboundDroppedCount ?? 0) > 0 && (
                  <dd className="mt-1 text-xs text-warning" role="status">
                    {t('inboundDropped', { count: org.inboundDroppedCount ?? 0 })}
                  </dd>
                )}
              </div>
            </dl>
            {org.role === 'owner' && org.inboundAddress && <RotateInboundAddress />}
          </Card>
          {/* What the tax office knows of the org: its tax code, VAT filing period and tax calendar, one value then "Sửa" each (ST-6). */}
          {modules.includes('finance') && (
          <Anchor id={SETTINGS_CARD.taxProfile}>
            <Card className="block p-4">
              <p className="text-sm font-medium text-muted-foreground">{t('taxProfile')}</p>
              <dl className="mt-3 space-y-3 text-sm">
                <TaxCodeField key={`tax-code:${org.slug}:${org.taxCode ?? ''}`} taxCode={org.taxCode ?? null} canManage={canManage} />
                <VatFilingPeriodField key={`vat-filing-period:${org.slug}:${org.vatFilingPeriod ?? ''}`} period={org.vatFilingPeriod ?? null} canManage={canManage} />
                <TaxCalendarField key={`tax-calendar:${org.slug}`} canManage={canManage} />
              </dl>
            </Card>
          </Anchor>
          )}
          {/* The legal entities the books are kept for (#1278), with the finance module; owners and admins only. */}
          {modules.includes('finance') && canManage && (
            <Anchor id={SETTINGS_CARD.legalEntities}>
              <LegalEntitiesCard key={`legal-entities:${org.slug}`} />
            </Anchor>
          )}
        </>
      )}
    </SettingsFrame>
  );
}

// Thành viên và quyền: the members and their roles, the invitations, and the approval rule with its reminders.
export function SettingsMembersPage() {
  const search: { invite?: string } = useSearch({ strict: false });
  return (
    <SettingsFrame>
      {({ org, me, canManage, isOwner, modules }) => (
        <>
          <MembersCard key={`members:${org.slug}`} members={org.members} me={me?.userId} isOwner={isOwner} canManage={canManage} inviteEmail={search.invite} />
          {/* Who approves the ledger's proposals (#1425), with the finance module; every member sees it, owners switch it. The reminders of a proposal nobody has decided sit under the rule (ST-6). */}
          {modules.includes('finance') && (
            <ApprovalPresetCard key={`approval-preset:${org.slug}:${org.approvalPreset}`} preset={org.approvalPreset} isOwner={isOwner}>
              <dl className="mt-4 border-t pt-4 text-sm">
                <ProposalRemindersField key={`proposal-reminders:${org.slug}`} canManage={canManage} />
              </dl>
            </ApprovalPresetCard>
          )}
        </>
      )}
    </SettingsFrame>
  );
}

// Ứng dụng: which apps the company uses (ADR-0053, #3312; every member sees the list, owners and admins switch it), then the retention of Engage's conversations and the meetings' minutes templates.
export function SettingsAppsPage() {
  return (
    <SettingsFrame>
      {({ org, canManage, modules }) => (
        <>
          <OrgAppsCard key={`org-apps:${org.slug}`} />
          {/* How long Engage's conversations are kept (CV6, #2305; moved here from the Inbox, #3582), with the social module; owners and admins. */}
          {modules.includes('social') && canManage && <ConversationRetentionCard key={`conversation-retention:${org.slug}`} />}
          {/* The minutes templates the org writes (#3578): owners and admins write them, every member picks one in a meeting. */}
          {modules.includes('meetings') && canManage && <MinutesTemplatesCard key={`minutes-templates:${org.slug}`} />}
        </>
      )}
    </SettingsFrame>
  );
}

// Lịch hẹn: the member's working hours and the booking pages' event types.
export function SettingsBookingsPage() {
  return (
    <SettingsFrame>
      {({ org, me, modules }) => (
        <>
          {/* The member's own working hours and days off (#1313). */}
          <WorkingHoursCard key={`working-hours:${org.slug}`} canEdit={org.role !== 'viewer'} />
          {/* The booking pages' event types (#1314), with the crm module. */}
          {modules.includes('crm') && me && <EventTypesCard key={`event-types:${org.slug}`} slug={org.slug} members={org.members} me={me.userId} role={org.role} />}
        </>
      )}
    </SettingsFrame>
  );
}

// Bán hàng, with the crm module: the deal board's stages and the reminder for forgotten deals; owners and admins.
export function SettingsSalesPage() {
  const t = useTranslations('settings');
  return (
    <SettingsFrame>
      {({ org, canManage, modules }) => (
        <>
          {!canManage && (
            <Card className="block p-4">
              <p className="text-sm text-muted-foreground">{t('adminOnlyTab')}</p>
            </Card>
          )}
          {/* The deal board's stages and the reminder for forgotten deals (#3647), with the crm module; owners and admins. */}
          {modules.includes('crm') && canManage && <SalesProcessCard key={`sales-process:${org.slug}`} />}
        </>
      )}
    </SettingsFrame>
  );
}

// Báo giá, with the crm module: the letterhead, bank note, defaults and logo of the org's quotes; owners and admins.
export function SettingsQuotesPage() {
  const t = useTranslations('settings');
  return (
    <SettingsFrame>
      {({ org, canManage, modules }) => (
        <>
          {!canManage && (
            <Card className="block p-4">
              <p className="text-sm text-muted-foreground">{t('adminOnlyTab')}</p>
            </Card>
          )}
          {/* The letterhead, bank note, defaults and logo of the org's quotes (#3645), with the crm module; owners and admins. */}
          {modules.includes('crm') && canManage && <QuoteSettingsCard key={`quote-settings:${org.slug}`} />}
        </>
      )}
    </SettingsFrame>
  );
}

// Kế toán và thuế, with the finance module: the master data the books and the exports read.
export function SettingsAccountingPage() {
  return (
    <SettingsFrame>
      {({ org, canManage }) => (
        <>
          {/* The chart of accounts belongs to the finance module (#319). */}
          <Anchor id={SETTINGS_CARD.chartOfAccounts}>
            <ChartOfAccountsCard canManage={canManage} />
          </Anchor>
          {/* The MISA codes of stock purchases (#1398), for the goods purchase export. */}
          <Anchor id={SETTINGS_CARD.misaGoodsCodes}>
            <MisaGoodsCodesCard key={`misa-goods:${org.slug}`} canManage={canManage} />
          </Anchor>
          {/* The account rules learned from approvals, and keyword rules (#1399). */}
          <Anchor id={SETTINGS_CARD.accountRules}>
            <AccountRulesCard key={`account-rules:${org.slug}`} canManage={canManage} />
          </Anchor>
          <Anchor id={SETTINGS_CARD.bankPartyRules}>
            <BankPartyRulesCard key={`bank-party-rules:${org.slug}`} canManage={canManage} />
          </Anchor>
        </>
      )}
    </SettingsFrame>
  );
}

// Kết nối, with the finance module: the bank feed, the e-invoice provider and the numbers of the bank accounts.
export function SettingsConnectionsPage() {
  return (
    <SettingsFrame>
      {({ org, canManage, modules }) => (
        <>
          {/* The bank feed (ADR-0039, #2099) and the e-invoice provider (ADR-0044, #2501), each only where the deployment offers one or the org has one connected. */}
          {modules.includes('finance') && <IntegrationsSection key={`integrations:${org.slug}`} role={org.role} orgSlug={org.slug} />}
          {/* The numbers of the bank accounts (#2183): how a statement file finds its account without a bank feed; owners and admins. */}
          {modules.includes('finance') && canManage && (
            <Anchor id={SETTINGS_CARD.bankAccountNumbers}>
              <BankAccountNumbersCard key={`bank-account-numbers:${org.slug}`} canManage={canManage} />
            </Anchor>
          )}
        </>
      )}
    </SettingsFrame>
  );
}

// Bảo mật tài khoản: the person's own second factor, devices and meeting platform connections; the team's extension devices for owners and admins.
export function SettingsSecurityPage() {
  return (
    <SettingsFrame>
      {({ org, me, canManage, modules }) => (
        <>
          <Anchor id={SETTINGS_CARD.twoFactor}>
            <TwoFactorCard />
          </Anchor>
          {me && (
            <Anchor id={SETTINGS_CARD.sessions}>
              <MySessions userId={me.userId} />
            </Anchor>
          )}
          {/* The member's own meeting platform connections (C1, #3173): the recordings they hold are suggested on the Meetings tab. */}
          {modules.includes('meetings') && (
            <Anchor id={SETTINGS_CARD.meetingPlatforms}>
              <MeetingPlatforms canConnect={org.role !== 'viewer'} />
            </Anchor>
          )}
          {modules.includes('meetings') && <ExtensionDevices />}
          {/* The other members' extension devices (#2868), with the meetings module; owners and admins. */}
          {modules.includes('meetings') && canManage && me && (org.role === 'owner' || org.role === 'admin') && (
            <OrgExtensionDevices key={`org-extension-devices:${org.slug}`} members={org.members} viewerRole={org.role} me={me.userId} />
          )}
        </>
      )}
    </SettingsFrame>
  );
}

// Dữ liệu và xóa tổ chức: the personal-data and audit screens, and the owner's offboarding.
export function SettingsDataPage() {
  const t = useTranslations('settings');
  const root = useTranslations();
  return (
    <SettingsFrame>
      {({ org, canManage, isOwner }) => (
        <>
          {canManage && (
            <Card className="block p-4">
              <p className="text-sm font-medium text-muted-foreground">{t('dataRecords')}</p>
              <p className="mt-1 text-sm text-subtle-foreground">{t('dataRecordsHint')}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Link to="/o/$slug/personal-data" params={{ slug: org.slug }} className={buttonVariants({ variant: 'outline', size: 'lg' })}>
                  {root('personalData.open')}
                </Link>
                <Link to="/o/$slug/audit" params={{ slug: org.slug }} className={buttonVariants({ variant: 'outline', size: 'lg' })}>
                  {root('audit.open')}
                </Link>
              </div>
            </Card>
          )}
          {isOwner ? (
            <Offboarding name={org.name} slug={org.slug} />
          ) : (
            <Card className="block p-4">
              <p className="text-sm text-muted-foreground">{t('dataOwnerOnly')}</p>
            </Card>
          )}
        </>
      )}
    </SettingsFrame>
  );
}
