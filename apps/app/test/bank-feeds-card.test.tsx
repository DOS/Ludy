// SPDX-License-Identifier: AGPL-3.0-only
// The bank feed card in Settings (issue #2099), rendered on the server with the API's answers seeded in the cache:
// what an owner and an admin can do, what a member or viewer sees, the accounts read from bankFeeds.listed after a
// sync, the status of each connection and mapped account.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BankFeedAccountView, LegalEntity } from '@ludy/kernel-contract';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import { catalog } from '../src/i18n/runtime.ts';
import type { ChartAccount } from '../src/lib/accounts.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  client.current = new QC();
  // orpc.<a>.<b>.queryOptions() / mutationOptions() / key(): keys are the path, nothing is ever fetched.
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return () => ({ queryKey: path, queryFn: () => Promise.reject(new Error('not fetched')) });
        if (prop === 'mutationOptions') return () => ({ mutationFn: () => Promise.resolve({}) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), queryClient: client.current, errorMessage: (e: unknown) => String(e) };
});

const { BankFeedsCard } = await import('../src/routes/bank-feeds.tsx');

type Role = 'owner' | 'admin' | 'member' | 'viewer';
const at = '2026-10-31T00:00:00.000Z';
const entity = (id: string, name: string, isDefault: boolean): LegalEntity => ({ id, name, kind: 'company', taxCode: null, parentId: null, isDefault, createdAt: at, updatedAt: at });
const chartAccount = (code: string, name: string, rootCode: string): ChartAccount => ({ code, name, parentCode: null, rootCode, active: true, custom: false });
const account = (id: string, externalAccountId: string, over: Partial<BankFeedAccountView> = {}): BankFeedAccountView => ({
  id,
  connectionId: 'c1',
  provider: 'bank_sandbox',
  connectionName: 'Ngân hàng thử',
  connectionStatus: 'active',
  externalAccountId,
  bankAccount: '1121',
  legalEntityId: 'e1',
  lastSyncedAt: null,
  feedFrom: null,
  feedFromEarliest: '2026-11-13',
  lastPull: null,
  ...over,
});

interface Seed {
  connections?: Array<{ id: string; provider: string; displayName: string; status: 'active' | 'expired' | 'revoked' | 'error'; connectedAt: string }>;
  listed?: Array<{ externalAccountId: string; displayName: string; listedAt: string }>;
  mapped?: BankFeedAccountView[];
  hook?: { exists: boolean; createdAt: string | null; rotatedAt: string | null; lastSeenAt: string | null; rejectedCount: number; stopped: boolean };
  entities?: LegalEntity[];
  locale?: 'en' | 'vi';
}
const connection = (status: 'active' | 'expired' | 'revoked' | 'error' = 'active') => ({ id: 'c1', provider: 'bank_sandbox', displayName: 'Ngân hàng thử', status, connectedAt: at });
const listedAccounts = [
  { externalAccountId: 'SBX-001', displayName: 'Tài khoản thanh toán', listedAt: at },
  { externalAccountId: 'SBX-002', displayName: 'Tài khoản tiết kiệm', listedAt: at },
];

const esc = (text: string): string => text.replace(/&/g, '&amp;').replace(/'/g, '&#x27;');
const rx = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function controlByLabel(html: string, label: string): string {
  const id = new RegExp(`<label[^>]*\\bfor="([^"]+)"[^>]*>${rx(esc(label))}</label>`).exec(html)?.[1];
  expect(id, `visible <label for="..."> missing for "${label}"`).toBeTruthy();
  return html.match(new RegExp(`<(?:input|select)\\b[^>]*\\bid="${rx(id ?? '')}"[^>]*>`))?.[0] ?? '';
}

function card(role: Role, seed: Seed = {}, offers?: { sandbox: boolean; tingee: boolean }): string {
  const qc = client.current;
  qc.setQueryData(['bankFeeds', 'accounts'], seed.mapped ?? []);
  qc.setQueryData(['bankFeeds', 'connections'], seed.connections ?? [connection()]);
  if (seed.hook) qc.setQueryData(['bankFeeds', 'hook'], seed.hook);
  qc.setQueryData(['bankFeeds', 'listed'], seed.listed ?? listedAccounts);
  qc.setQueryData(['accounts', 'list'], [chartAccount('111', 'Tiền mặt', '111'), chartAccount('1121', 'Tiền Việt Nam', '1121'), chartAccount('1121.VCB', 'Vietcombank', '1121')]);
  qc.setQueryData(['legalEntities', 'list'], seed.entities ?? [entity('e1', 'Công ty TNHH Mẫu', true)]);
  const locale = seed.locale ?? 'en';
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        <BankFeedsCard role={role} {...(offers ? { offers } : {})} />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('BankFeedsCard for an owner or admin', () => {
  beforeEach(() => client.current.clear());

  it.each<Role>(['owner', 'admin'])('as %s: lists the connection with its status, the connect form and the accounts to map', (role) => {
    const html = card(role);
    expect(html).toContain(`role="region"`);
    expect(html).toContain(`aria-label="${en.bankFeeds.title}"`);
    expect(html).toContain('Ngân hàng thử');
    expect(html).toContain(`>${en.bankFeeds.status.active}<`);
    expect(html).toContain(`aria-label="${en.bankFeeds.connectTitle}"`);
    expect(html).toContain(`>${en.bankFeeds.connect}<`);
    // The accounts come from bankFeeds.listed (the connect answer carries none), each with a map form over the 112 accounts.
    expect(html).toContain('Tài khoản thanh toán');
    expect(html).toContain('Tài khoản tiết kiệm');
    expect(html.match(new RegExp(`>${en.bankFeeds.map}<`, 'g'))).toHaveLength(2);
    expect(html).toContain('>1121 · Tiền Việt Nam<');
    expect(html).toContain('>1121.VCB · Vietcombank<');
    expect(html).not.toContain('>111 · Tiền mặt<');
    // One legal entity: nothing to choose.
    expect(html).not.toContain(`aria-label="${en.bankFeeds.legalEntity}"`);
    expect(html).not.toContain(en.bankFeeds.waiting);
  });

  it('says so while a connection has listed nothing yet, right after connecting', () => {
    const html = card('owner', { listed: [] });
    expect(html).toContain(en.bankFeeds.waiting);
    expect(html).toContain(`>${en.bankFeeds.refresh}<`);
    expect(html).not.toContain(`>${en.bankFeeds.map}<`);
  });

  it('says there is no connection yet, and still offers to connect one', () => {
    const html = card('owner', { connections: [] });
    expect(html).toContain(en.bankFeeds.noConnections);
    expect(html).toContain(`aria-label="${en.bankFeeds.connectTitle}"`);
  });

  it('shows a mapped account with its bank account and when it was last synced, and offers to remap or unmap it', () => {
    const html = card('owner', { mapped: [account('m1', 'SBX-001', { lastSyncedAt: '2026-10-30T08:00:00.000Z' })] });
    expect(html).toContain('Goes to bank account 1121');
    expect(html).toContain('Last synced');
    expect(html).toContain(`>${en.bankFeeds.remap}<`);
    expect(html).toContain(`>${en.bankFeeds.unmap}<`);
    // The other account is not mapped yet, and has not been synced.
    expect(html.match(new RegExp(`>${en.bankFeeds.map}<`, 'g'))).toHaveLength(1);
  });

  it('offers the cut-over day on each account, with its hint, and names it once set', () => {
    const html = card('owner');
    expect(html).toContain(en.bankFeeds.feedFromLabel);
    expect(html).toContain(en.bankFeeds.feedFromHint);
    expect(html).toContain('type="date"');
    expect(html).not.toContain('The feed supplies lines from');
    const set = card('owner', { mapped: [account('m1', 'SBX-001', { feedFrom: '2026-10-15' })] });
    expect(set).toContain('value="2026-10-15"');
    expect(set).toContain('The feed supplies lines from');
  });

  it('says a mapped account never pulled has not been synced', () => {
    expect(card('owner', { mapped: [account('m1', 'SBX-001')] })).toContain(en.bankFeeds.neverSynced);
  });

  it('shows a mapped account the provider no longer lists as such, with only an unmap', () => {
    const html = card('owner', { listed: listedAccounts.slice(1), mapped: [account('m1', 'SBX-001')] });
    expect(html).toContain(en.bankFeeds.gone);
    expect(html).toContain(`aria-label="${en.bankFeeds.unmapOf.replace('{name}', 'SBX-001')}"`);
    expect(html).not.toContain(`aria-label="${en.bankFeeds.mapForm.replace('{name}', 'SBX-001')}"`);
  });

  function expectEnabledUnmapButton(html: string, accountName: string, messages: { unmapOf: string; unmap: string }) {
    const tag = new RegExp(`<button\\b[^>]*aria-label="${rx(messages.unmapOf.replace('{name}', accountName))}"[^>]*>${rx(messages.unmap)}<`).exec(html)?.[0] ?? '';
    expect(tag).toContain('min-h-11');
    expect(tag).not.toContain('disabled=');
  }

  it('asks an expired connection to be connected again, and cannot map to it', () => {
    const html = card('owner', { connections: [connection('expired')], mapped: [account('m1', 'SBX-001', { connectionStatus: 'expired' })] });
    expect(html).toContain(`>${en.bankFeeds.status.expired}<`);
    expect(html).toContain(en.bankFeeds.expiredHint);
    expect(html).toContain('disabled=""');
    expectEnabledUnmapButton(html, 'Tài khoản thanh toán', en.bankFeeds);

    const emptyExpired = card('owner', { connections: [connection('expired')], listed: [], mapped: [] });
    expect(emptyExpired).not.toContain(en.bankFeeds.waiting);
    expect(emptyExpired).not.toContain(`>${en.bankFeeds.refresh}<`);
  });

  it('shows a mapped revoked connection with its hint, only mapped accounts, and a 44 px unmap control (#2127)', () => {
    for (const [locale, msgs] of [
      ['en', en],
      ['vi', viMessages],
    ] as const) {
      const html = card('owner', {
        locale,
        connections: [connection('revoked')],
        mapped: [account('m1', 'SBX-001', { connectionStatus: 'revoked' })],
      });
      expect(html).toContain(`>${msgs.bankFeeds.status.revoked}<`);
      expect(html).toContain(msgs.bankFeeds.revokedHint);
      expect(html).toContain('Tài khoản thanh toán');
      expect(html).not.toContain('Tài khoản tiết kiệm');
      expect(html).not.toContain(`aria-label="${msgs.bankFeeds.mapForm.replace('{name}', 'Tài khoản thanh toán')}"`);
      expect(html).not.toContain(msgs.bankFeeds.gone);
      expectEnabledUnmapButton(html, 'Tài khoản thanh toán', msgs.bankFeeds);
    }
  });

  it('offers the legal entity choice only to an org with several, and locks it on a mapped account', () => {
    const entities = [entity('e1', 'Công ty TNHH Mẫu', true), entity('e2', 'Chi nhánh Hà Nội', false)];
    const html = card('owner', { entities, mapped: [account('m1', 'SBX-001')] });
    expect(html.match(new RegExp(`aria-label="${en.bankFeeds.legalEntity}"`, 'g'))).toHaveLength(2);
    expect(html).toContain('>Chi nhánh Hà Nội<');
    expect(html).toContain(`title="${en.bankFeeds.entityLocked}"`);
  });

  it('has words for the whole card in both languages and offers nothing to pay', () => {
    expect(Object.keys(viMessages.bankFeeds).sort()).toEqual(Object.keys(en.bankFeeds).sort());
    const inVi = card('owner', { locale: 'vi', mapped: [account('m1', 'SBX-001')] });
    expect(inVi).toContain(viMessages.bankFeeds.title);
    expect(inVi).toContain(`>${viMessages.bankFeeds.status.active}<`);
    expect(inVi).toContain(`>${viMessages.bankFeeds.unmap}<`);
    for (const html of [card('owner'), inVi]) expect(html).not.toMatch(/chuyển tiền<|Pay<|Transfer</);
  });
});

describe('BankFeedsCard for a member or viewer', () => {
  beforeEach(() => client.current.clear());

  it.each<Role>(['member', 'viewer'])('as %s: only reads which accounts are mapped, with nothing to change, and sees the cut-over day when set (#4223)', (role) => {
    const html = card(role, { mapped: [account('m1', 'SBX-001', { lastSyncedAt: '2026-10-30T08:00:00.000Z', feedFrom: '2026-10-15' })] });
    expect(html).toContain(`role="region"`);
    expect(html).toContain(`aria-label="${en.bankFeeds.title}"`);
    expect(html).toContain(en.bankFeeds.readOnlyIntro);
    expect(html).toContain('Ngân hàng thử');
    // The provider's account number is for those who map it.
    expect(html).not.toContain('SBX-001');
    expect(html).toContain('Goes to bank account 1121');
    expect(html).toContain('The feed supplies lines from');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('<select');
    expect(html).not.toContain(en.bankFeeds.connectTitle);

    const viHtml = card(role, { locale: 'vi', mapped: [account('m1', 'SBX-001', { feedFrom: '2026-10-15' })] });
    expect(viHtml).toContain('Nguồn tự động lấy giao dịch từ ngày');
    expect(viHtml).toContain('15/10/2026');

    const withoutCutover = card(role, { mapped: [account('m1', 'SBX-001', { feedFrom: null, connectionStatus: 'expired' })] });
    expect(withoutCutover).not.toContain('The feed supplies lines from');
    expect(withoutCutover).toContain(`>${en.bankFeeds.status.expired}<`);
  });

  it.each<Role>(['member', 'viewer'])('as %s: draws nothing when no account is mapped', (role) => {
    expect(card(role, { mapped: [] })).toBe('');
  });
});

describe('BankFeedsCard Tingee connect form', () => {
  beforeEach(() => client.current.clear());

  it('shows the Tingee form with the permission guidance, visible labels, a hidden secret and 44 px controls, only when offered', () => {
    const html = card('owner', {}, { sandbox: false, tingee: true });
    expect(html).toContain(`aria-label="${en.bankFeeds.tingee.title}"`);
    for (const key of ['guideCreate', 'guideGroups', 'guideNever', 'guideSecret'] as const) expect(html).toContain(en.bankFeeds.tingee[key]);
    // The secret input itself is the hidden one, and each Tingee control carries the 44 px height and a visible <label for="...">.
    const secret = controlByLabel(html, en.bankFeeds.tingee.secretLabel);
    expect(secret).toContain('type="password"');
    expect(secret).toContain('autoComplete="new-password"');
    expect(secret).toContain('min-h-11');
    const clientId = controlByLabel(html, en.bankFeeds.tingee.clientIdLabel);
    expect(clientId).not.toContain('type="password"');
    expect(clientId).toContain('min-h-11');
    const connectionName = controlByLabel(html, en.bankFeeds.tingee.nameLabel);
    expect(connectionName).not.toContain('type="password"');
    expect(connectionName).toContain('min-h-11');
    expect(html).not.toMatch(/<label[^>]*class="[^"]*sr-only/);
    // The test feed's form is not drawn when it is not offered, and the Tingee one is not drawn when it is not.
    expect(html).not.toContain(`aria-label="${en.bankFeeds.connectTitle}"`);
    expect(card('owner', {}, { sandbox: true, tingee: false })).not.toContain(`aria-label="${en.bankFeeds.tingee.title}"`);
  });

  it('pairs every input on the test-feed and Tingee connect forms with a visible <label for="..."> in both languages (#4221)', () => {
    const enSandbox = card('owner', {}, { sandbox: true, tingee: false });
    const enName = controlByLabel(enSandbox, en.bankFeeds.nameLabel);
    expect(enName).toContain(`placeholder="${en.bankFeeds.namePlaceholder}"`);
    expect(enName).toContain('max-md:min-h-11');
    expect(enName).not.toContain('aria-label=');

    const viBoth = card('owner', { locale: 'vi' }, { sandbox: true, tingee: true });
    expect(controlByLabel(viBoth, viMessages.bankFeeds.nameLabel)).toContain(`placeholder="${viMessages.bankFeeds.namePlaceholder}"`);
    expect(controlByLabel(viBoth, viMessages.bankFeeds.tingee.clientIdLabel)).toContain('min-h-11');
    expect(controlByLabel(viBoth, viMessages.bankFeeds.tingee.secretLabel)).toContain('type="password"');
    expect(controlByLabel(viBoth, viMessages.bankFeeds.tingee.nameLabel)).toContain('min-h-11');
    expect(viBoth).not.toMatch(/<label[^>]*class="[^"]*sr-only/);
  });

  it('names the permission groups to leave out, in both languages', () => {
    for (const messages of [en, viMessages]) {
      expect(messages.bankFeeds.tingee.guideNever).toMatch(/Chi hộ/);
      expect(messages.bankFeeds.tingee.guideNever).toMatch(/Direct debit/);
      expect(messages.bankFeeds.tingee.guideNever).toMatch(/Hoàn tiền/);
    }
    expect(card('owner', { locale: 'vi' }, { sandbox: false, tingee: true })).toContain(viMessages.bankFeeds.tingee.guideGroups);
  });

  it('shows no Tingee form to a member or viewer', () => {
    expect(card('member', { mapped: [account('m1', 'SBX-001')] }, { sandbox: false, tingee: true })).not.toContain(en.bankFeeds.tingee.title);
  });
});

// Why the last pull stopped (#4244): one plain sentence per kind, cleared after a good pull, never the bank's text.
describe('BankFeedsCard pull reason', () => {
  beforeEach(() => client.current.clear());
  const kinds = ['credentials', 'clock', 'rate_limited', 'upstream', 'config', 'bad_page', 'too_many_lines'] as const;

  it.each(kinds)('shows the %s sentence in English and Vietnamese for an owner', (kind) => {
    const mapped = [account('m1', 'SBX-001', { lastPull: { outcome: kind, at, item: null } })];
    expect(card('owner', { mapped })).toContain(en.bankFeeds.pullReason[kind]);
    expect(card('owner', { mapped, locale: 'vi' })).toContain(viMessages.bankFeeds.pullReason[kind]);
  });

  it('names the position of a line it cannot store, counted from 1', () => {
    const html = card('owner', { mapped: [account('m1', 'SBX-001', { lastPull: { outcome: 'bad_page', at, item: 3 } })] });
    expect(html).toContain(en.bankFeeds.pullReason.bad_page_item.replace('{item}', '3'));
  });

  it('says nothing after a good pull or before any pull', () => {
    for (const lastPull of [null, { outcome: 'ok' as const, at, item: null }]) {
      const html = card('owner', { mapped: [account('m1', 'SBX-001', { lastPull })] });
      for (const kind of kinds) expect(html).not.toContain(en.bankFeeds.pullReason[kind]);
    }
  });

  it('shows it to a member or viewer too, in a status region', () => {
    const html = card('viewer', { mapped: [account('m1', 'SBX-001', { lastPull: { outcome: 'credentials', at, item: null } })] });
    expect(html).toContain(en.bankFeeds.pullReason.credentials);
    expect(html).toContain('role="status"');
  });

  it('has the same kinds in both languages', () => {
    expect(Object.keys(viMessages.bankFeeds.pullReason).sort()).toEqual(Object.keys(en.bankFeeds.pullReason).sort());
  });
});

describe('BankFeedsCard Tingee webhook block (#4204)', () => {
  beforeEach(() => client.current.clear());
  const tingee = (status: 'active' | 'expired' = 'active') => [{ id: 'c1', provider: 'bank_tingee', displayName: 'Tingee của tôi', status, connectedAt: at }];
  const fresh = { exists: true, createdAt: at, rotatedAt: null, lastSeenAt: null, rejectedCount: 0, stopped: false };
  const hookLabel = `aria-label="${en.bankFeeds.hook.title}"`;

  it.each<Role>(['owner', 'admin'])('as %s: shows the block for an active Tingee connection', (role) => {
    const html = card(role, { connections: tingee(), hook: fresh });
    expect(html).toContain(hookLabel);
    expect(html).toContain(en.bankFeeds.hook.intro);
  });

  it('is not shown for the test feed, for an inactive Tingee connection, or to a member or viewer', () => {
    expect(card('owner', { hook: fresh })).not.toContain(hookLabel);
    expect(card('owner', { connections: tingee('expired'), hook: fresh })).not.toContain(hookLabel);
    for (const role of ['member', 'viewer'] as const) {
      expect(card(role, { connections: tingee(), hook: fresh, mapped: [account('m1', 'T-1', { provider: 'bank_tingee' })] })).not.toContain(en.bankFeeds.hook.title);
    }
  });

  it('offers to create the address when there is none, and to replace it when there is one', () => {
    const none = card('owner', { connections: tingee(), hook: { ...fresh, exists: false, createdAt: null } });
    expect(none).toContain(en.bankFeeds.hook.none);
    expect(none).toContain(`>${en.bankFeeds.hook.create}<`);
    expect(none).not.toContain(`>${en.bankFeeds.hook.rotate}<`);
    const has = card('owner', { connections: tingee(), hook: fresh });
    expect(has).toContain(`>${en.bankFeeds.hook.rotate}<`);
    expect(has).not.toContain(`>${en.bankFeeds.hook.create}<`);
    // Replacing asks a second click first, so the warning and the confirm button are not drawn yet.
    expect(has).not.toContain(en.bankFeeds.hook.warnRotate);
    expect(has).not.toContain(en.bankFeeds.hook.confirmRotate);
  });

  it('says when the last notice came, how many were refused and when the last pull was', () => {
    const quiet = card('owner', { connections: tingee(), hook: fresh });
    expect(quiet).toContain(en.bankFeeds.hook.noNotice);
    expect(quiet).toContain('Notices refused this hour: 0');
    expect(quiet).toContain(en.bankFeeds.hook.noPull);
    const seen = card('owner', { connections: tingee(), hook: { ...fresh, lastSeenAt: '2026-10-31T01:00:00.000Z', rejectedCount: 3 }, mapped: [account('m1', 'T-1', { provider: 'bank_tingee', lastSyncedAt: '2026-10-30T08:00:00.000Z' })] });
    expect(seen).toContain('Last notice from Tingee: ');
    expect(seen).not.toContain(en.bankFeeds.hook.noNotice);
    expect(seen).toContain('Notices refused this hour: 3');
    expect(seen).toContain('Last pull of transactions: ');
    expect(seen).not.toContain(en.bankFeeds.hook.stopped);
  });

  it('warns when the address stopped, and asks for a replacement', () => {
    const html = card('owner', { connections: tingee(), hook: { ...fresh, rejectedCount: 10, stopped: true } });
    expect(html).toContain(en.bankFeeds.hook.stopped);
    expect(html).toContain('role="alert"');
  });

  it('draws no key or address before one is made, and the 44 px button', () => {
    const html = card('owner', { connections: tingee(), hook: fresh });
    expect(html).not.toContain('/api/bank-feed/');
    expect(html).not.toContain(en.bankFeeds.hook.shownOnce);
    expect(html).not.toContain('readonly');
    expect(html.match(new RegExp(`<button[^>]*min-h-11[^>]*>${en.bankFeeds.hook.rotate}<`))).not.toBeNull();
  });

  it('always draws the status regions, empty until a copy or an address, so a screen reader announces them', () => {
    const html = card('owner', { connections: tingee(), hook: fresh });
    const statuses = html.match(/<p[^>]*role="status"[^>]*><\/p>/g) ?? [];
    expect(statuses.length).toBeGreaterThanOrEqual(2);
    expect(html).not.toContain(en.bankFeeds.hook.copied);
    expect(html).not.toContain(en.bankFeeds.hook.replacedExisting);
  });

  it('has the words in both languages', () => {
    for (const key of ['replacedExisting', 'rotateFailed'] as const) {
      expect(en.bankFeeds.hook[key].length).toBeGreaterThan(10);
      expect(viMessages.bankFeeds.hook[key].length).toBeGreaterThan(10);
    }
    const html = card('owner', { locale: 'vi', connections: tingee(), hook: { ...fresh, stopped: true } });
    expect(html).toContain(viMessages.bankFeeds.hook.title);
    expect(html).toContain(viMessages.bankFeeds.hook.stopped);
    expect(html).toContain(`>${viMessages.bankFeeds.hook.rotate}<`);
    expect(Object.keys(viMessages.bankFeeds.hook).sort()).toEqual(Object.keys(en.bankFeeds.hook).sort());
  });
});
