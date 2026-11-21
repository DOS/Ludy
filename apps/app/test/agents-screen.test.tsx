// The agents screen as each role sees it (ADR-0029 section 9, issue #339): an agent-held position carries the AI
// label, and every control is shown only to the roles that may use it. Rendered on the server (no DOM needed), with
// the queries answered from a seeded cache.
import { readFileSync } from 'node:fs';
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MODULE_IDS } from '@crove/kernel-contract';
import { en } from '../src/i18n/messages/en.ts';
import { COWORKERS } from '../src/i18n/brand.ts';
import { catalog } from '../src/i18n/runtime.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));
const configMock = vi.hoisted(() => ({ modules: ['kernel', 'accounting'] as string[] }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  client.current = new QC();
  // orpc.<a>.<b>.queryOptions() / mutationOptions(): keys are the path, nothing is ever fetched.
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return () => ({ queryKey: path, queryFn: () => Promise.reject(new Error('not fetched')) });
        if (prop === 'mutationOptions') return () => ({ mutationFn: () => Promise.resolve({}) });
        return node([...path, prop]);
      },
    });
  return {
    orpc: node([]),
    queryClient: client.current,
    errorMessage: (e: unknown) => String(e),
    isStepUpRequired: () => false,
    takeOrgLeftNotice: () => null,
  };
});
// The dialogs portal to the body, which the server does not render: this stand-in draws a dialog's form in place so its fields can be read.
vi.mock('../src/components/form-dialog.tsx', async () => {
  const React = await import('react');
  return {
    useLive: () => ({ current: true }),
    FormDialog: (p: { title: string; submitLabel: string; children: unknown; outside?: unknown }) =>
      React.createElement('form', { 'aria-label': p.title }, p.children as never, p.outside as never, React.createElement('button', { type: 'submit' }, p.submitLabel)),
  };
});
vi.mock('../src/lib/auth.ts', () => ({
  getConfig: () => ({ modules: configMock.modules }),
  auth: {},
  authErrorText: () => '',
  authFailure: () => ({}),
}));

const { AgentsPage, AddPositionDialog, BudgetDialog } = await import('../src/routes/agents.tsx');

const member = { userId: 'u1', email: 'an@example.com', displayName: 'An' };
const chart = {
  root: [{ userId: 'u1', email: 'an@example.com', displayName: 'An' }],
  positions: [
    { id: 'p1', title: 'Chief accountant', module: 'accounting', roleKey: 'accountant', reportsTo: null, status: 'active', jobDescription: null, holder: { type: 'agent', agentId: 'a1', name: 'Kế toán AI', ai: true }, leScope: ['*'] },
    { id: 'p2', title: 'Clerk', module: 'accounting', roleKey: 'clerk', reportsTo: 'p1', status: 'active', jobDescription: null, holder: { type: 'user', userId: 'u1', email: 'an@example.com', displayName: 'An', ai: false }, leScope: ['e2'] },
  ],
  agents: [{ id: 'a1', templateKey: 'accountant', displayName: 'Kế toán AI', status: 'active', maxRisk: 'R1', dailyRunCap: 50 }],
  killSwitches: [],
};
const templates = [{ key: 'accountant', module: 'accounting', title: 'Accountant', roleKey: 'accountant', maxRisk: 'R1', dailyRunCap: 50, jobDescription: null, moduleEnabled: true }];

const ENTITY = { kind: 'company', taxCode: null, parentId: null, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' };
const oneEntity = [{ ...ENTITY, id: 'e1', name: 'Công ty An', isDefault: true }];
const twoEntities = [...oneEntity, { ...ENTITY, id: 'e2', name: 'Chi nhánh Hà Nội', kind: 'branch', isDefault: false }];

function page(role: string | null, entities = oneEntity, tpls: typeof templates = templates): string {
  const qc = client.current;
  qc.clear();
  qc.setQueryData(['legalEntities', 'list'], entities);
  qc.setQueryData(['org', 'get'], { role, members: [member] });
  qc.setQueryData(['chart', 'get'], chart);
  qc.setQueryData(['chart', 'templates'], tpls);
  qc.setQueryData(['agents', 'budgets'], []);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <IntlProvider locale="en" messages={catalog('en')}>
        <AgentsPage />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

// The add-position dialog on its own, as it stands when opened with its options shown.
function addPositionDialog(entities = oneEntity, tpls: typeof templates = templates): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={client.current}>
      <IntlProvider locale="en" messages={catalog('en')}>
        <AddPositionDialog positions={chart.positions as never} templates={tpls as never} entities={entities as never} entitiesReady defaultMore onClose={() => undefined} />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

const positionCards = (html: string) => html.split('data-testid="position"').slice(1);

describe('AgentsPage', () => {
  beforeEach(() => {
    client.current.clear();
    configMock.modules = ['kernel', 'accounting'];
  });

  it('labels the agent-held position as AI and not the member-held one', () => {
    const [agentHeld, memberHeld] = positionCards(page('owner'));
    expect(agentHeld).toContain('Chief accountant');
    expect(agentHeld).toContain(`aria-label="${en.agents.aiBadge}"`);
    expect(memberHeld).toContain('Clerk');
    expect(memberHeld).not.toContain(`aria-label="${en.agents.aiBadge}"`);
  });

  it('shows the name a template agent takes: the coworker of its module, none for a module without one', () => {
    const finance = { ...templates[0]!, key: 'finance.chief_accountant', module: 'finance' };
    const crm = { ...templates[0]!, key: 'crm.scheduler', module: 'crm', title: 'Scheduler' };
    const notes = { ...templates[0]!, key: 'notes.x', module: 'notes', title: 'Notes helper' };
    const html = page('owner', oneEntity, [finance, crm, notes]);
    const cards = html.split('data-testid="template"').slice(1);
    expect(cards[0]).toContain(`Default name: ${COWORKERS.finance}`);
    expect(cards[1]).toContain(`Default name: ${COWORKERS.sales}`);
    expect(cards[2]).not.toContain('Default name');
  });

  it('shows active AI coworkers first, hides role keys, localizes seeded roles in English, and nests add-position', () => {
    configMock.modules = ['kernel', 'finance', 'hr', 'crm', 'social'];
    const qc = client.current;
    qc.clear();
    qc.setQueryData(['legalEntities', 'list'], oneEntity);
    qc.setQueryData(['org', 'get'], { role: 'owner', members: [member] });
    qc.setQueryData(['chart', 'get'], {
      root: [member],
      positions: [
        { id: 'p-seeded', title: 'Kế toán trưởng (AI)', module: 'finance', roleKey: 'finance.chief_accountant', reportsTo: null, status: 'active', jobDescription: null, holder: { type: 'agent', agentId: 'a-fin', name: 'Ly', ai: true }, leScope: ['*'] },
      ],
      agents: [{ id: 'a-fin', templateKey: 'finance.chief_accountant', displayName: 'Ly', status: 'active', maxRisk: 'R1', dailyRunCap: 50 }],
      killSwitches: [],
    });
    qc.setQueryData(['chart', 'templates'], [
      { key: 'finance.chief_accountant', module: 'finance', title: 'Kế toán trưởng (AI)', roleKey: 'finance.chief_accountant', maxRisk: 'R1', dailyRunCap: 50, jobDescription: null, moduleEnabled: true },
      { key: 'crm.scheduler', module: 'crm', title: 'Điều phối lịch hẹn (AI)', roleKey: 'crm.scheduler', maxRisk: 'R1', dailyRunCap: 100, jobDescription: null, moduleEnabled: true },
    ]);
    qc.setQueryData(['agents', 'budgets'], [{ id: 'b1', scope: 'org', target: '*', monthlyLimit: '500000', spent: '100000', warnPercent: 80, hardStop: true }]);

    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <IntlProvider locale="en" messages={catalog('en')}>
          <AgentsPage />
        </IntlProvider>
      </QueryClientProvider>,
    );
    expect(html.indexOf('data-testid="coworkers-section"')).toBeLessThan(html.indexOf(`>${en.agents.chart}<`));
    expect(html).toContain('>Vy<');
    expect(html).toContain('>Ly<');
    expect(html).toContain('>Dy<');
    expect(html).toContain('>Uy<');
    expect(html).not.toContain('>Hy<');
    expect(html).toContain(en.agents.stopHint);
    expect(html).not.toContain(`role="alertdialog" aria-label="${en.agents.stopTitle}"`);
    expect(html).not.toContain('Kế toán trưởng');
    expect(html).not.toContain('Điều phối lịch hẹn');
    expect(html).not.toContain('finance.chief_accountant');
    expect(html).toContain('Chief accountant');
    expect(html).toContain('Booking coordinator');
    // #3608: adding a position is a button that opens a dialog, never a form left open under the chart.
    expect(html).toContain(`>${en.agents.addPosition}<`);
    expect(html).not.toContain('<details');
    expect(html).not.toContain(`aria-label="${en.agents.addPosition}"`);
    expect(html).not.toContain('Role key');

    const viHtml = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <IntlProvider locale="vi" messages={catalog('vi')}>
          <AgentsPage />
        </IntlProvider>
      </QueryClientProvider>,
    );
    expect(viHtml).not.toMatch(/tác tử|trợ lý|assistant/i);
  });

  it('hides coworker budget amounts from members and viewers', () => {
    configMock.modules = ['kernel', 'finance'];
    const qc = client.current;
    qc.clear();
    qc.setQueryData(['org', 'get'], { role: 'member', members: [member] });
    qc.setQueryData(['chart', 'get'], chart);
    qc.setQueryData(['chart', 'templates'], templates);
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <IntlProvider locale="en" messages={catalog('en')}>
          <AgentsPage />
        </IntlProvider>
      </QueryClientProvider>,
    );
    expect(html).toContain('>Vy<');
    expect(html).toContain('>Ly<');
    expect(html).not.toContain('500,000');
    expect(html).not.toContain(en.agents.coworkerBudgetNone);
  });

  it('gives owners every control', () => {
    const html = page('owner');
    for (const shown of [en.agents.stop, en.agents.addPosition, en.agents.holder, en.agents.save, en.agents.install]) expect(html).toContain(`>${shown}<`);
    // The AI use and the budgets moved to their own Ludy AI screen (#3225): the chart no longer ends with them.
    expect(html).not.toContain(`>${en.agents.setBudget}<`);
    expect(html).not.toContain(`>${en.agents.budgetsTitle}<`);
  });

  it('gives admins Stop AI, nothing that changes the chart', () => {
    const html = page('admin');
    expect(html).toContain(`>${en.agents.stop}<`);
    for (const hidden of [en.agents.addPosition, en.agents.holder, en.agents.save, en.agents.install]) expect(html).not.toContain(`>${hidden}<`);
  });

  // #1763: the legal-entity picker and each position's entities appear only for an owner of an org with several.
  it('shows an owner of a multi-entity org each position\'s entities and the pickers', () => {
    const html = page('owner', twoEntities);
    const [chief, clerk] = positionCards(html);
    expect(chief).toContain(en.agents.leScopeShown.replace('{names}', en.agents.leScopeEvery));
    expect(clerk).toContain(en.agents.leScopeShown.replace('{names}', 'Chi nhánh Hà Nội'));
    expect(chief).toContain(`>${en.agents.leScopeEdit}<`);
    // The add-position dialog and the templates each offer the picker, starting on the default entity.
    expect(addPositionDialog(twoEntities)).toContain(`>${en.agents.leScope}<`);
    expect(html).toContain(`>${en.agents.leScopeInstall}<`);
    expect(html).toContain(`>${en.agents.leScopeSome}<`);
  });

  it("shows an admin of a multi-entity org no positions' entities, whatever the cache holds", () => {
    const html = page('admin', twoEntities);
    expect(html).not.toContain(en.agents.leScopeShown.split('{')[0] as string);
    expect(html).not.toContain(`>${en.agents.leScope}<`);
  });

  it('keeps the screen as before for a single-entity org', () => {
    const html = page('owner', oneEntity);
    for (const hidden of [en.agents.leScope, en.agents.leScopeInstall, en.agents.leScopeEdit]) expect(html).not.toContain(`>${hidden}<`);
    expect(html).not.toContain(en.agents.leScopeShown.split('{')[0] as string);
  });

  it.each(['member', 'viewer', null])('shows a %s the chart and the AI labels only', (role) => {
    const html = page(role);
    expect(html).toContain(en.agents.aiBadge);
    for (const hidden of [en.agents.stop, en.agents.addPosition, en.agents.holder, en.agents.save, en.agents.install, en.agents.setBudget, en.agents.budgetsTitle]) {
      expect(html).not.toContain(`>${hidden}<`);
    }
  });

  it('translates every canonical ModuleId in add-position options and template cards instead of showing raw slugs', () => {
    configMock.modules = [...MODULE_IDS];
    const escapeHtml = (s: string) => s.replaceAll('&', '&amp;');
    const switchableModules = MODULE_IDS.filter((m) => m !== 'kernel');
    const allTemplates = switchableModules.map((module, index) => ({
      ...templates[0]!,
      key: `${module}.helper_${index}`,
      module,
      title: `Helper ${module}`,
    }));
    const html = page('owner', oneEntity, allTemplates);
    const options = addPositionDialog(oneEntity, allTemplates);
    for (const id of MODULE_IDS) {
      expect(options).toContain(`value="${id}"${id === 'kernel' ? ' selected=""' : ''}>${escapeHtml(en.modules[id])}<`);
    }
    const cards = html.split('data-testid="template"').slice(1);
    expect(cards).toHaveLength(switchableModules.length);
    for (const [index, id] of switchableModules.entries()) {
      const card = cards[index]!;
      expect(card).toContain(`Module ${escapeHtml(en.modules[id])},`);
      expect(card).not.toContain(`Module ${id},`);
    }
  });

  it('shows partial-stop badge and localized AI role presets in add-position without raw role keys', () => {
    configMock.modules = ['finance', 'hr'];
    const qc = client.current;
    qc.clear();
    qc.setQueryData(['legalEntities', 'list'], oneEntity);
    qc.setQueryData(['org', 'get'], { role: 'owner', members: [member] });
    qc.setQueryData(['chart', 'get'], {
      root: [member],
      positions: [],
      agents: [{ id: 'a-fin', templateKey: 'finance.chief_accountant', displayName: 'Ly', status: 'paused', maxRisk: 'R1', dailyRunCap: 50 }],
      killSwitches: [{ id: 'ks1', scope: 'module', target: 'hr', reason: 'pause hr', engagedAt: '2026-10-01T00:00:00Z' }],
    });
    qc.setQueryData(['chart', 'templates'], [
      { key: 'finance.chief_accountant', module: 'finance', title: 'Kế toán trưởng (AI)', roleKey: 'finance.chief_accountant', maxRisk: 'R1', dailyRunCap: 50, jobDescription: null, moduleEnabled: true },
    ]);
    qc.setQueryData(['agents', 'budgets'], []);

    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <IntlProvider locale="en" messages={catalog('en')}>
          <AgentsPage />
        </IntlProvider>
      </QueryClientProvider>,
    );
    const [vyCard, lyCard] = html.split('data-testid="coworker-card"').slice(1);
    expect(vyCard).not.toContain(en.agents.coworkerPartialStopBadge);
    expect(vyCard).not.toContain(en.agents.coworkerStoppedBadge);
    expect(lyCard).toContain(en.agents.coworkerPartialStopBadge);
    expect(lyCard).not.toContain(en.agents.coworkerStoppedBadge);
    const dialog = addPositionDialog(oneEntity, [
      { key: 'finance.chief_accountant', module: 'finance', title: 'Kế toán trưởng (AI)', roleKey: 'finance.chief_accountant', maxRisk: 'R1', dailyRunCap: 50, jobDescription: null, moduleEnabled: true },
    ] as never);
    expect(dialog).toContain(en.agents.positionRolePreset);
    expect(dialog).toContain(en.agents.positionRoleAuto);
    expect(dialog).toContain('value="0">Chief accountant<');
    expect(dialog).not.toContain('finance.chief_accountant');
    expect(html).not.toContain('finance.chief_accountant');
  });
  // #3608 (F-6): the add dialog asks the name first and never a code; the role code is made from the name.
  it('asks for the position name first, then the app, with the rest under more options', () => {
    configMock.modules = ['kernel', 'finance'];
    const dialog = addPositionDialog();
    const order = [en.agents.positionTitle, en.agents.positionModule, en.agents.moreOptions, en.agents.reportsTo].map((label) => dialog.indexOf(label));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(dialog).not.toMatch(/role key|role code|mã vai trò/i);
    expect(dialog).toContain(`aria-label="${en.agents.addPosition}"`);
    // Without the options shown (the way it opens) the dialog holds the two fields only.
    expect(readFileSync(new URL('../src/routes/agents.tsx', import.meta.url), 'utf8')).toContain('defaultMore = false');
  });

  it('asks for the budget amount first, and names a target only when the scope is not the whole org', () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client.current}>
        <IntlProvider locale="en" messages={catalog('en')}>
          <BudgetDialog agents={chart.agents as never} onClose={() => undefined} />
        </IntlProvider>
      </QueryClientProvider>,
    );
    expect(html.indexOf(en.agents.budgetLimit)).toBeLessThan(html.indexOf(en.agents.budgetScope));
    expect(html).not.toContain(`>${en.agents.budgetTarget}<`);
    expect(html).toContain(en.agents.hardStop);
    expect(html).toContain(`aria-label="${en.agents.setBudget}"`);
  });
});
