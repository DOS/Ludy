// SPDX-License-Identifier: AGPL-3.0-only
// The add forms of Settings are dialogs (#3608, owner rule of 2026-11-17): each card holds a button and no open form, and the dialog behind it asks
// for what the person knows first and flags a repeat before saving. The dialogs portal to the body, which the server does not render, so a stand-in
// for FormDialog draws the form in place; the cards are rendered from a seeded cache as the other card tests do.
import { readFileSync } from 'node:fs';
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { en } from '../src/i18n/messages/en.ts';
import { catalog } from '../src/i18n/runtime.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  client.current = new QC();
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
vi.mock('../src/components/entity-switcher.tsx', () => ({ useChosenEntity: () => ({ ready: true, legalEntityId: undefined }) }));
vi.mock('../src/components/form-dialog.tsx', async () => {
  const React = await import('react');
  return {
    FormDialog: (p: { title: string; submitLabel: string; children: unknown }) =>
      React.createElement('form', { 'aria-label': p.title }, p.children as never, React.createElement('button', { type: 'submit' }, p.submitLabel)),
  };
});

const { BankAccountNumbersCard, AddBankNumberDialog } = await import('../src/routes/bank-account-numbers.tsx');
const { ChartOfAccountsCard, AddSubAccountDialog } = await import('../src/routes/accounts.tsx');
const { AccountRulesCard, AddKeywordRuleDialog } = await import('../src/routes/account-rules.tsx');
const { AddDayOffDialog } = await import('../src/routes/working-hours.tsx');

const chart = [
  { code: '112', name: 'Tiền gửi ngân hàng', parentCode: null, rootCode: '112', active: true, custom: false },
  { code: '1121', name: 'Tiền gửi VND', parentCode: '112', rootCode: '112', active: true, custom: false },
  { code: '1121.VCB', name: 'Vietcombank', parentCode: '1121', rootCode: '112', active: true, custom: true },
];
const entity = { id: 'e1', name: 'Công ty An', kind: 'company', taxCode: null, parentId: null, isDefault: true, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' };
const numbers = [{ id: 'n1', bankAccount: '1121', accountNumber: '0123456789', legalEntityId: 'e1', createdAt: '2026-10-01T00:00:00Z' }];

function render(node: React.ReactNode, locale: 'en' | 'vi' = 'en'): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={client.current}>
      <IntlProvider locale={locale} messages={catalog(locale)} timeZone="UTC">
        {node}
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('Settings cards hold a button, not an open form (#3608)', () => {
  beforeEach(() => {
    client.current.clear();
    client.current.setQueryData(['bankAccountNumbers', 'list'], numbers);
    client.current.setQueryData(['accounts', 'list'], chart);
    client.current.setQueryData(['legalEntities', 'list'], [entity]);
    client.current.setQueryData(['accountRules', 'list'], []);
  });

  it('bank account numbers: a button opens the dialog, and the list stays first', () => {
    const html = render(<BankAccountNumbersCard canManage />);
    expect(html).not.toContain('<form');
    expect(html).toContain(`>${en.bankAccountNumbers.addTitle}<`);
    expect(html.indexOf('0123456789')).toBeLessThan(html.indexOf(`>${en.bankAccountNumbers.addTitle}<`));
  });

  it('chart of accounts: a button for a sub-account, only for who manages', () => {
    expect(render(<ChartOfAccountsCard canManage />)).not.toContain('<form');
    expect(render(<ChartOfAccountsCard canManage />)).toContain(`>${en.accounts.addTitle}<`);
    expect(render(<ChartOfAccountsCard canManage={false} />)).not.toContain(`>${en.accounts.addTitle}<`);
  });

  it('keyword rules: a button for a rule, only for who manages', () => {
    expect(render(<AccountRulesCard canManage />)).not.toContain('<form');
    expect(render(<AccountRulesCard canManage />)).toContain(`>${en.accountRules.addTitle}<`);
    expect(render(<AccountRulesCard canManage={false} />)).not.toContain(`>${en.accountRules.addTitle}<`);
  });
});

describe('the add dialogs ask for what the person knows first', () => {
  beforeEach(() => client.current.clear());

  it('bank number: the number before the bank account, with its own duplicate line', () => {
    client.current.setQueryData(['accounts', 'list'], chart);
    const html = render(<AddBankNumberDialog bankAccounts={chart} entities={[entity] as never} numbers={numbers} onClose={() => undefined} />);
    expect(html.indexOf(en.bankAccountNumbers.number)).toBeLessThan(html.indexOf(en.bankAccountNumbers.bankAccount));
    expect(html).toContain(`aria-label="${en.bankAccountNumbers.addTitle}"`);
    // Nothing is flagged before anything is typed.
    expect(html).not.toContain('bank-number-duplicate');
  });

  it('sub-account: the name first, then the parent, then the code', () => {
    const html = render(<AddSubAccountDialog accounts={chart} onClose={() => undefined} />);
    const at = [en.accounts.name, en.accounts.parent, en.accounts.code].map((label) => html.indexOf(label));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it('keyword rule: the keyword, then the account', () => {
    client.current.setQueryData(['accounts', 'list'], chart);
    const html = render(<AddKeywordRuleDialog rules={[]} onClose={() => undefined} />);
    expect(html.indexOf(en.accountRules.keyword)).toBeLessThan(html.indexOf(en.accountRules.account));
  });

  it('day off: two dates and a line for an overlap, in Vietnamese too', () => {
    for (const locale of ['en', 'vi'] as const) {
      const html = render(<AddDayOffDialog tz="Asia/Ho_Chi_Minh" off={[]} onClose={() => undefined} />, locale);
      expect(html).toContain(catalog(locale).workingHours.from);
      expect(html).toContain(catalog(locale).workingHours.toHint);
    }
  });
});

describe('duplicate lines are wired to the dialogs and worded in both languages', () => {
  const read = (file: string) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
  it('each dialog warns before saving and keeps the button off while a repeat stands', () => {
    expect(read('routes/bank-account-numbers.tsx')).toContain('duplicateBankNumber(numbers, number)');
    expect(read('routes/bank-account-numbers.tsx')).toContain('submitDisabled={repeated !== null}');
    expect(read('routes/accounts.tsx')).toContain('duplicateAccountCode(accounts, code)');
    expect(read('routes/accounts.tsx')).toContain('repeated !== null');
    expect(read('routes/account-rules.tsx')).toContain('duplicateKeywordRule(rules, keyword)');
    expect(read('routes/account-rules.tsx')).toContain('repeated !== null');
    expect(read('routes/settings/members-card.tsx')).toContain('invitedEmailState(email, members, pendingInvites.data ?? [])');
    expect(read('routes/settings/members-card.tsx')).toContain('known !== null');
    expect(read('routes/working-hours.tsx')).toContain('overlappingDayOff(off, from, to || from)');
  });
  it('every warning has words in Vietnamese and English with the same arguments', () => {
    for (const locale of ['vi', 'en'] as const) {
      const c = catalog(locale);
      expect(c.bankAccountNumbers.duplicate).toContain('{account}');
      expect(c.accounts.duplicate).toContain('{code}');
      expect(c.accountRules.duplicate).toContain('{keyword}');
      expect(c.settings.inviteAlreadyMember).toContain('{email}');
      expect(c.settings.inviteAlreadyInvited).toContain('{email}');
      expect(c.workingHours.dayOffOverlap).toContain('{from}');
    }
    expect(catalog('vi').settings.inviteTitle).toBe('Mời thành viên');
    expect(catalog('vi').bankAccountNumbers.addTitle).toBe('Ghi số tài khoản');
  });
});
