// What the AI agents screens decide on their own (ADR-0029, issue #258).
import { describe, expect, it } from 'vitest';
import {
  activeCoworkers,
  agentPermissions,
  aiConnectionsVisible,
  budgetUsage,
  chartTree,
  conversationOf,
  conversationSummaryTitle,
  defaultScope,
  deriveRoleKey,
  holderCandidates,
  isBudgetAmount,
  isEveryEntity,
  meetingItemOf,
  meetingSourceOf,
  resolvePositionTitle,
  resolveTemplateTitle,
  scopeNames,
  socialPostOf,
  stripAiSuffix,
  taskDueDay,
  taskDueFromDay,
  toggleScopeEntity,
} from '../src/lib/agents.ts';

const titles = (nodes: ReturnType<typeof chartTree<{ id: string; reportsTo: string | null }>>): unknown =>
  nodes.map((n) => (n.children.length ? { [n.position.id]: titles(n.children) } : n.position.id));

describe('chartTree', () => {
  it('nests positions under their managers, roots first, in order', () => {
    const tree = chartTree([
      { id: 'cfo', reportsTo: null },
      { id: 'acc1', reportsTo: 'cfo' },
      { id: 'ops', reportsTo: null },
      { id: 'acc2', reportsTo: 'cfo' },
      { id: 'clerk', reportsTo: 'acc1' },
    ]);
    expect(titles(tree)).toEqual([{ cfo: [{ acc1: ['clerk'] }, 'acc2'] }, 'ops']);
  });

  it('puts a position whose manager is missing at the root, and shows a cycle once without looping', () => {
    expect(titles(chartTree([{ id: 'a', reportsTo: 'gone' }]))).toEqual(['a']);
    expect(titles(chartTree([{ id: 'self', reportsTo: 'self' }]))).toEqual(['self']);
    const cycle = chartTree([
      { id: 'x', reportsTo: 'y' },
      { id: 'y', reportsTo: 'x' },
    ]);
    expect(titles(cycle)).toEqual([{ x: ['y'] }]);
  });
});

describe('agentPermissions', () => {
  it('lets owners and admins stop AI, owners manage, and members work on tasks', () => {
    expect(agentPermissions('owner')).toEqual({ stop: true, manage: true, budgets: true, tasks: true });
    expect(agentPermissions('admin')).toEqual({ stop: true, manage: false, budgets: true, tasks: true });
    expect(agentPermissions('member')).toEqual({ stop: false, manage: false, budgets: false, tasks: true });
    expect(agentPermissions('viewer')).toEqual({ stop: false, manage: false, budgets: false, tasks: false });
    expect(agentPermissions(undefined)).toEqual({ stop: false, manage: false, budgets: false, tasks: false });
  });
});

describe('budgets', () => {
  it('accepts the amounts the server accepts', () => {
    for (const ok of ['0', '150', '150.5', '1.123456', ' 12 ']) expect(isBudgetAmount(ok), ok).toBe(true);
    for (const bad of ['', '-1', '1.1234567', '1e3', '1,5', '1234567890123']) expect(isBudgetAmount(bad), bad).toBe(false);
  });

  it('says how far a budget is spent, exactly and as the run gate counts it', () => {
    expect(budgetUsage('0', '100', 80)).toEqual({ percent: 0, state: 'ok' });
    expect(budgetUsage('79.999999', '100', 80)).toEqual({ percent: 79, state: 'ok' });
    expect(budgetUsage('80', '100', 80)).toEqual({ percent: 80, state: 'warn' });
    // Spent at the limit: a hard-stop budget refuses runs (spent >= limit).
    expect(budgetUsage('100.000000', '100', 80)).toEqual({ percent: 100, state: 'spent' });
    expect(budgetUsage('0.1', '0.3', 50)).toEqual({ percent: 33, state: 'ok' });
    expect(budgetUsage('0.2', '0.3', 50)).toEqual({ percent: 66, state: 'warn' });
    expect(budgetUsage('50000', '1', 80)).toEqual({ percent: 999, state: 'spent' });
    expect(budgetUsage('0', '0', 80).state).toBe('spent');
  });
});

describe('holderCandidates', () => {
  const templateRoles = new Map([
    ['accountant', 'accountant'],
    ['clerk', 'clerk'],
  ]);
  const agents = [
    { id: 'acc1', templateKey: 'accountant', status: 'active' },
    { id: 'acc2', templateKey: 'accountant', status: 'active' },
    { id: 'accOff', templateKey: 'accountant', status: 'paused' },
    { id: 'clk', templateKey: 'clerk', status: 'active' },
  ];
  const positions = [
    { id: 'p1', holder: { type: 'agent', agentId: 'acc1' } },
    { id: 'p2', holder: null },
    { id: 'p3', holder: { type: 'user' } },
  ];
  const ids = (list: Array<{ id: string }>) => list.map((a) => a.id);

  it('offers active agents of the position role that hold no other position', () => {
    expect(ids(holderCandidates({ id: 'p2', roleKey: 'accountant' }, agents, positions, templateRoles))).toEqual(['acc2']);
  });

  it('keeps the agent that holds this very position, so the select can show it', () => {
    expect(ids(holderCandidates({ id: 'p1', roleKey: 'accountant' }, agents, positions, templateRoles))).toEqual(['acc1', 'acc2']);
  });

  it('offers none of another role, or any before the templates are known', () => {
    expect(ids(holderCandidates({ id: 'p2', roleKey: 'auditor' }, agents, positions, templateRoles))).toEqual([]);
    expect(ids(holderCandidates({ id: 'p2', roleKey: 'accountant' }, agents, positions, new Map()))).toEqual([]);
  });
});

describe('meetingItemOf', () => {
  it('reads the action item id of a task made from a meeting, and nothing else', () => {
    const id = '0198a0b4-3c5d-7e6f-8a9b-0c1d2e3f4a5b';
    expect(meetingItemOf({ type: 'meetings.action_item', id })).toBe(id);
    expect(meetingItemOf({ type: 'social.post', id })).toBeNull();
    expect(meetingItemOf({ type: 'meetings.action_item', id: 'not-a-uuid' })).toBeNull();
    expect(meetingItemOf(null)).toBeNull();
    expect(meetingItemOf('x')).toBeNull();
  });
});

describe('conversationOf', () => {
  it('reads the Inbox thread id of a task made from a conversation (#3421), and nothing else', () => {
    const id = '0198a0b4-3c5d-7e6f-8a9b-0c1d2e3f4a5b';
    expect(conversationOf({ type: 'kernel.conversation', id })).toBe(id);
    expect(conversationOf({ type: 'kernel.conversation', id, extra: 1 })).toBe(id);
    expect(conversationOf({ type: 'social.post', id })).toBeNull();
    expect(conversationOf({ type: 'kernel.conversation.reply', id })).toBeNull();
    expect(conversationOf({ type: 'kernel.conversation', id: 'not-a-uuid' })).toBeNull();
    expect(conversationOf({ type: 'kernel.conversation', id: 7 })).toBeNull();
    expect(conversationOf({ type: 'kernel.conversation' })).toBeNull();
    expect(conversationOf({})).toBeNull();
    expect(conversationOf(null)).toBeNull();
    expect(conversationOf(undefined)).toBeNull();
    expect(conversationOf('kernel.conversation')).toBeNull();
  });
});

describe('meetingSourceOf & conversationSummaryTitle', () => {
  it('extracts meeting UUIDs from sourceRef cleanly', () => {
    const id = '0198a0b4-3c5d-7e6f-8a9b-0c1d2e3f4a5b';
    expect(meetingSourceOf({ type: 'meetings.meeting', id })).toBe(id);
    expect(meetingSourceOf({ type: 'meetings.action_item', id })).toBeNull();
    expect(meetingSourceOf({ type: 'meetings.meeting', id: 'bad' })).toBeNull();
    expect(meetingSourceOf(null)).toBeNull();
  });

  it('picks conversation display label from subject, displayName, partyName, or channel', () => {
    expect(
      conversationSummaryTitle({
        subject: 'Invoice #99',
        contact: { displayName: 'Khách A', partyName: 'Công ty A' },
        channel: { displayName: 'Mail' },
      }),
    ).toBe('Invoice #99');
    expect(
      conversationSummaryTitle({
        subject: null,
        contact: { displayName: null, partyName: 'Công ty B' },
        channel: { displayName: 'Zalo OA' },
      }),
    ).toBe('Công ty B');
    expect(
      conversationSummaryTitle({
        subject: null,
        contact: { displayName: null, partyName: null },
        channel: { displayName: 'Facebook Page' },
      }),
    ).toBe('Facebook Page');
  });
});

describe('socialPostOf', () => {
  it("names the Social post a content agent's task is about (#1193), and nothing else", () => {
    const id = '0b5c6f7e-1d2a-4c3b-9e8f-7a6b5c4d3e2f';
    expect(socialPostOf({ type: 'social.post', id })).toBe(id);
    expect(socialPostOf({ type: 'kernel.proposal', id })).toBeNull();
    expect(socialPostOf({ type: 'social.post', id: 'not-a-uuid' })).toBeNull();
    expect(socialPostOf(null)).toBeNull();
    expect(socialPostOf('social.post')).toBeNull();
  });
});

// A position's legal entities on the agents screen (#1763).
describe('legal entity scope', () => {
  const entities = [
    { id: 'e1', name: 'Công ty', isDefault: true },
    { id: 'e2', name: 'Chi nhánh Hà Nội', isDefault: false },
    { id: 'e3', name: 'Hộ kinh doanh', isDefault: false },
  ];

  it('starts a new position on the default entity, as the server would', () => {
    expect(defaultScope(entities)).toEqual(['e1']);
    expect(defaultScope([{ id: 'x', isDefault: false }])).toEqual(['x']);
    expect(defaultScope([])).toEqual([]);
  });

  it('turns entities on and off in the order of the list, leaving every entity for some', () => {
    expect(toggleScopeEntity(['e3'], 'e1', true, entities)).toEqual(['e1', 'e3']);
    expect(toggleScopeEntity(['e1', 'e3'], 'e1', false, entities)).toEqual(['e3']);
    expect(toggleScopeEntity(['*'], 'e2', true, entities)).toEqual(['e2']);
    expect(toggleScopeEntity(['e2'], 'e2', false, entities)).toEqual([]);
    // An id the list does not hold is kept.
    expect(toggleScopeEntity(['e9', 'e1'], 'e2', true, entities)).toEqual(['e1', 'e2', 'e9']);
  });

  it('names a scope for display, or null for every entity', () => {
    expect(isEveryEntity(['*'])).toBe(true);
    expect(scopeNames(['*'], entities)).toBeNull();
    expect(scopeNames(['e3', 'e1'], entities)).toEqual(['Công ty', 'Hộ kinh doanh']);
    // An id the reader cannot name is left out.
    expect(scopeNames(['e9', 'e2'], entities)).toEqual(['Chi nhánh Hà Nội']);
  });
});

// Task due day conversion for task creation and editing (#2588).
describe('taskDueDay and taskDueFromDay', () => {
  it('converts between an ISO timestamp and the local day in Asia/Ho_Chi_Minh and across DST', () => {
    const iso = taskDueFromDay('2026-11-20', 'Asia/Ho_Chi_Minh');
    expect(iso).toBe('2026-11-20T16:59:00.000Z');
    expect(taskDueDay(iso, 'Asia/Ho_Chi_Minh')).toBe('2026-11-20');
    const dst = taskDueFromDay('2026-04-04', 'Australia/Sydney');
    expect(dst).toBe('2026-04-04T12:59:00.000Z');
    expect(taskDueDay(dst, 'Australia/Sydney')).toBe('2026-04-04');
    expect(taskDueFromDay('', 'Asia/Ho_Chi_Minh')).toBeNull();
    expect(taskDueDay(null, 'Asia/Ho_Chi_Minh')).toBe('');
  });
});

describe('activeCoworkers (#3594)', () => {
  const templateModules = new Map([
    ['finance.chief_accountant', 'finance'],
    ['social.content_manager', 'social'],
    ['crm.scheduler', 'crm'],
  ]);

  it('always includes Vy, shows Ly/Dy/Uy when their modules are on, and never shows Hy', () => {
    expect(activeCoworkers({ modules: ['kernel'], agents: [], templateModules, killSwitches: [] }).map((c) => c.key)).toEqual(['gm']);
    expect(activeCoworkers({ modules: ['kernel', 'finance'], agents: [], templateModules, killSwitches: [] }).map((c) => c.key)).toEqual(['gm', 'finance']);
    const all = activeCoworkers({
      modules: ['kernel', 'finance', 'hr', 'crm', 'social', 'ads'],
      agents: [],
      templateModules,
      killSwitches: [],
    });
    expect(all.map((c) => [c.key, c.name])).toEqual([
      ['gm', 'Vy'],
      ['finance', 'Ly'],
      ['sales', 'Dy'],
      ['marketing', 'Uy'],
    ]);
  });

  it('uses active renamed org-chart agent name, kill switch state, and most specific budget', () => {
    const out = activeCoworkers({
      modules: ['kernel', 'finance', 'social'],
      agents: [{ id: 'a-fin', templateKey: 'finance.chief_accountant', displayName: 'Chị Ly', status: 'active' }],
      templateModules,
      killSwitches: [{ scope: 'module', target: 'social' }],
      budgets: [
        { scope: 'org', target: '*', monthlyLimit: '500000', spent: '100000', warnPercent: 80, hardStop: true },
        { scope: 'module', target: 'finance', monthlyLimit: '200000', spent: '50000', warnPercent: 80, hardStop: true },
      ],
    });
    const fin = out.find((c) => c.key === 'finance');
    const mkt = out.find((c) => c.key === 'marketing');
    expect(fin?.name).toBe('Chị Ly');
    expect(fin?.stopped).toBe(false);
    expect(fin?.stopState).toBe('running');
    expect(fin?.budget?.monthlyLimit).toBe('200000');
    expect(mkt?.stopped).toBe(true);
    expect(mkt?.stopState).toBe('stopped');
    expect(mkt?.budget?.scope).toBe('org');
  });

  it('keeps the oldest non-retired agent name even when paused, matching coworker-names', () => {
    const out = activeCoworkers({
      modules: ['kernel', 'finance'],
      agents: [
        { id: 'a-retired', templateKey: 'finance.chief_accountant', displayName: 'Tên cũ', status: 'retired' },
        { id: 'a-paused', templateKey: 'finance.chief_accountant', displayName: 'Chị Ly 1', status: 'paused' },
        { id: 'a-active', templateKey: 'finance.chief_accountant', displayName: 'Chị Ly 2', status: 'active' },
      ],
      templateModules,
      killSwitches: [],
    });
    expect(out.find((c) => c.key === 'finance')?.name).toBe('Chị Ly 1');
  });

  it('distinguishes partial kill switches from full coworker stops', () => {
    const out = activeCoworkers({
      modules: ['kernel', 'finance', 'hr', 'crm', 'conversations', 'social'],
      agents: [{ id: 'a-crm', templateKey: 'crm.scheduler', displayName: 'Dy', status: 'active' }],
      templateModules,
      killSwitches: [
        { scope: 'module', target: 'hr' },
        { scope: 'agent', target: 'a-crm' },
        { scope: 'module', target: 'social' },
      ],
    });
    const fin = out.find((c) => c.key === 'finance');
    const sales = out.find((c) => c.key === 'sales');
    const mkt = out.find((c) => c.key === 'marketing');
    expect(fin?.stopState).toBe('partial');
    expect(fin?.stopped).toBe(false);
    expect(sales?.stopState).toBe('partial');
    expect(sales?.stopped).toBe(false);
    expect(mkt?.stopState).toBe('stopped');
    expect(mkt?.stopped).toBe(true);
  });

  it('ranks a spent hard-stop org budget ahead of an unused module budget and keeps all matching budgets', () => {
    const out = activeCoworkers({
      modules: ['kernel', 'finance'],
      agents: [],
      templateModules,
      killSwitches: [],
      budgets: [
        { scope: 'module', target: 'finance', monthlyLimit: '200000', spent: '0', warnPercent: 80, hardStop: true },
        { scope: 'org', target: '*', monthlyLimit: '500000', spent: '500000', warnPercent: 80, hardStop: true },
      ],
    });
    const fin = out.find((c) => c.key === 'finance');
    expect(fin?.budget?.scope).toBe('org');
    expect(fin?.budgets.map((b) => b.scope)).toEqual(['org', 'module']);
  });

  it('marks Vy partially stopped when notes remain active, maps conversations budget target, and keeps renamed name across disabled sibling modules', () => {
    const out = activeCoworkers({
      modules: ['kernel', 'notes', 'conversations'],
      agents: [{ id: 'a-crm', templateKey: 'crm.scheduler', displayName: 'Dy CRM', status: 'active' }],
      templateModules,
      killSwitches: [{ scope: 'module', target: 'kernel' }],
      budgets: [{ scope: 'module', target: 'conversation', monthlyLimit: '150000', spent: '150000', warnPercent: 80, hardStop: true }],
    });
    const vy = out.find((c) => c.key === 'gm');
    const sales = out.find((c) => c.key === 'sales');
    expect(vy?.stopState).toBe('partial');
    expect(vy?.stopped).toBe(false);
    expect(sales?.name).toBe('Dy CRM');
    expect(sales?.budget?.monthlyLimit).toBe('150000');

    const fullStopVy = activeCoworkers({
      modules: ['kernel', 'notes'],
      agents: [],
      templateModules,
      killSwitches: [
        { scope: 'module', target: 'kernel' },
        { scope: 'module', target: 'notes' },
      ],
    }).find((c) => c.key === 'gm');
    expect(fullStopVy?.stopState).toBe('stopped');
    expect(fullStopVy?.stopped).toBe(true);
  });

  it('includes finance-metered budget on Ly when HR is enabled without Finance', () => {
    const out = activeCoworkers({
      modules: ['kernel', 'hr'],
      agents: [],
      templateModules,
      killSwitches: [],
      budgets: [{ scope: 'module', target: 'finance', monthlyLimit: '10', spent: '10', warnPercent: 80, hardStop: true }],
    });
    const ly = out.find((c) => c.key === 'finance');
    expect(ly?.coveredModules).toEqual(['hr']);
    expect(ly?.budget?.monthlyLimit).toBe('10');
  });
});

describe('deriveRoleKey and localized labels (#3594)', () => {
  it('derives valid unique kernel role keys from Vietnamese position titles', () => {
    const key1 = deriveRoleKey('Đọc hóa đơn & công nợ', 'finance', []);
    expect(key1).toBe('finance.doc_hoa_don_cong_no');
    expect(key1).toMatch(/^[a-z][a-z0-9_.]*$/);
    const key2 = deriveRoleKey('Đọc hóa đơn & công nợ', 'finance', [key1]);
    expect(key2).toBe('finance.doc_hoa_don_cong_no_2');
    expect(deriveRoleKey('---', 'ads')).toBe('ads.position');
    expect(deriveRoleKey('a'.repeat(150), 'kernel').length).toBeLessThanOrEqual(100);
  });

  it('translates seeded template and position titles and strips legacy (AI) suffix', () => {
    const t = (k: 'finance_chief_accountant' | 'social_content_manager' | 'crm_scheduler' | 'kernel_member_vy') =>
      ({
        finance_chief_accountant: 'Chief accountant',
        social_content_manager: 'Content manager',
        crm_scheduler: 'Booking coordinator',
        kernel_member_vy: 'Personal Vy',
      })[k];
    expect(resolveTemplateTitle('finance.chief_accountant', 'Kế toán trưởng (AI)', t)).toBe('Chief accountant');
    expect(resolvePositionTitle('Điều phối lịch hẹn (AI)', t)).toBe('Booking coordinator');
    expect(resolvePositionTitle('Custom lead (AI)', t)).toBe('Custom lead');
    expect(stripAiSuffix('Kiểm toán viên (ai)')).toBe('Kiểm toán viên');
  });

  it('gates AI connections visibility strictly on mcpEnabled === true', () => {
    expect(aiConnectionsVisible(true)).toBe(true);
    expect(aiConnectionsVisible(false)).toBe(false);
    expect(aiConnectionsVisible(undefined)).toBe(false);
  });
});
