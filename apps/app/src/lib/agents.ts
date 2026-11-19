// What the AI agents screens decide on their own (ADR-0029, issue #258): the chart as a tree, who may use which
// control, and how far a budget is spent. The server enforces every rule; these only hide what can never succeed.
import { z } from 'zod';
import { COWORKER_BY_MODULE, COWORKER_ROSTER, todoDueInstant, type CoworkerKey } from '@crove/kernel-contract';
import type { Role } from './members.ts';
import { readSearch, type Defined } from './search.ts';

export interface ChartNode<P> {
  position: P;
  children: ChartNode<P>[];
}

// The positions as a tree under the owners. A position without reportsTo, or whose manager is not in the list, is a
// root (it reports to the owners). The database refuses reporting cycles; a position caught in one anyway is still
// shown once, as a root, so a bad row never hides part of the chart or loops.
export function chartTree<P extends { id: string; reportsTo: string | null }>(positions: readonly P[]): ChartNode<P>[] {
  const byId = new Map(positions.map((p) => [p.id, p]));
  const children = new Map<string, P[]>();
  const roots: P[] = [];
  for (const p of positions) {
    if (p.reportsTo && p.reportsTo !== p.id && byId.has(p.reportsTo)) children.set(p.reportsTo, [...(children.get(p.reportsTo) ?? []), p]);
    else roots.push(p);
  }
  const placed = new Set<string>();
  const build = (p: P): ChartNode<P> => {
    placed.add(p.id);
    return { position: p, children: (children.get(p.id) ?? []).filter((c) => !placed.has(c.id)).map(build) };
  };
  const tree = roots.map(build);
  // Positions only reachable through a cycle.
  for (const p of positions) if (!placed.has(p.id)) tree.push(build(p));
  return tree;
}

// The agents a position's holder select offers: active, of a template whose role is the position's role (the server
// refuses any other, AGENT_ROLE_MISMATCH), and not holding another position (AGENT_ALREADY_PLACED). The agent that holds
// this very position stays in the list, so the select can show it. Until the templates are known no agent is offered.
export function holderCandidates<A extends { id: string; templateKey: string; status: string }>(
  position: { id: string; roleKey: string },
  agents: readonly A[],
  positions: ReadonlyArray<{ id: string; holder: { type: string; agentId?: string } | null }>,
  templateRoles: ReadonlyMap<string, string>,
): A[] {
  const placedElsewhere = new Set(
    positions.filter((p) => p.id !== position.id && p.holder?.type === 'agent' && p.holder.agentId).map((p) => p.holder?.agentId as string),
  );
  const here = positions.find((p) => p.id === position.id)?.holder;
  const holderHere = here?.type === 'agent' ? here.agentId : undefined;
  return agents.filter(
    (a) => a.id === holderHere || (a.status === 'active' && templateRoles.get(a.templateKey) === position.roleKey && !placedElsewhere.has(a.id)),
  );
}

// A position's legal entities (#1763): every entity ('*' alone) or some of the org's, by id, as the chart commands take
// them. The picker sends one only where the org has more than one entity; with a single entity the screen is as before.
export const EVERY_ENTITY = ['*'] as const;
export type LeScope = readonly string[];

export const isEveryEntity = (scope: LeScope): boolean => scope.includes('*');

// The most entities a position names one by one (the commands' limit); past it, every entity is the choice.
export const LE_SCOPE_MAX = 50;

// Some entities with `id` turned on or off, in the order of `entities` (the server keeps what it is sent). An id the
// list does not hold (an entity the reader cannot see) is kept, so a change never drops it unseen.
export function toggleScopeEntity(scope: LeScope, id: string, on: boolean, entities: ReadonlyArray<{ id: string }>): string[] {
  const chosen = new Set(isEveryEntity(scope) ? [] : scope);
  if (on) chosen.add(id);
  else chosen.delete(id);
  const listed = new Set(entities.map((e) => e.id));
  return [...entities.filter((e) => chosen.has(e.id)).map((e) => e.id), ...[...chosen].filter((c) => !listed.has(c))];
}

// What a new position starts with until the owner picks: the org's default entity, as the server gives it.
export function defaultScope(entities: ReadonlyArray<{ id: string; isDefault: boolean }>): string[] {
  const chosen = entities.find((e) => e.isDefault) ?? entities[0];
  return chosen ? [chosen.id] : [];
}

// The names of a scope's entities for display, in the order of `entities`; null for every entity. An id the reader
// cannot name (an entity they may not see) is left out.
export function scopeNames(scope: LeScope, entities: ReadonlyArray<{ id: string; name: string }>): string[] | null {
  if (isEveryEntity(scope)) return null;
  return entities.filter((e) => scope.includes(e.id)).map((e) => e.name);
}

export interface AgentPermissions {
  // Owners and admins: "Stop AI" is R1, never behind a second factor.
  stop: boolean;
  // Owners only (R3, fresh MFA): the chart, templates, agents, budgets, turning AI back on.
  manage: boolean;
  // Owners and admins read the budgets.
  budgets: boolean;
  // Owners, admins and members create tasks, comment and change their status.
  tasks: boolean;
}

export function agentPermissions(role: Role | null | undefined): AgentPermissions {
  return {
    stop: role === 'owner' || role === 'admin',
    manage: role === 'owner',
    budgets: role === 'owner' || role === 'admin',
    tasks: role === 'owner' || role === 'admin' || role === 'member',
  };
}

// A non-negative amount with up to 6 decimals, the budget limit the server accepts.
export function isBudgetAmount(value: string): boolean {
  return /^\d{1,12}(\.\d{1,6})?$/.test(value.trim());
}

// Amounts in millionths, exactly (never a JS number for money).
function micros(value: string): bigint {
  const [i = '0', f = ''] = value.trim().split('.');
  return BigInt(i || '0') * 1_000_000n + BigInt((f + '000000').slice(0, 6));
}

export type BudgetState = 'ok' | 'warn' | 'spent';

// How far this month's spend is into a budget. spent: the spend reached the limit, so a hard-stop budget refuses every
// run it covers (the server's rule: spent >= limit). percent is for display only, rounded down, capped at 999.
export function budgetUsage(spent: string, limit: string, warnPercent: number): { percent: number; state: BudgetState } {
  const s = micros(spent);
  const l = micros(limit);
  const state: BudgetState = s >= l ? 'spent' : s * 100n >= l * BigInt(warnPercent) ? 'warn' : 'ok';
  const percent = l === 0n ? (s > 0n ? 999 : 100) : Number((s * 100n) / l > 999n ? 999n : (s * 100n) / l);
  return { percent, state };
}

// The most tasks one list answers (kernel.task.list), newest first.
export const TASK_LIST_LIMIT = 200;

export const TASK_STATUSES = ['todo', 'in_progress', 'waiting', 'in_review', 'done', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
// Statuses a task can still move from.
export const OPEN_TASK_STATUSES: readonly TaskStatus[] = ['todo', 'in_progress', 'waiting', 'in_review'];

// The tasks screen's tabs; open tasks are the default.
export const TASK_FILTERS = ['open', 'mine', 'all'] as const;
export type TaskFilter = (typeof TASK_FILTERS)[number];

// ?filter= and ?project= of the tasks screen (#1513, #2593), left out for the defaults.
const zTasksSearch = z.object({
  filter: z.enum(TASK_FILTERS).optional().catch(undefined),
  project: z.union([z.uuid().transform((v) => v.toLowerCase()), z.literal('none')]).optional().catch(undefined),
});
export type TasksSearch = Defined<z.output<typeof zTasksSearch>>;
export const parseTasksSearch = (search: Record<string, unknown>): TasksSearch => readSearch(zTasksSearch, search);

// The Social post a task is about (#1193): the content agent's tasks point at their post by their source ref, and the
// task page links to it. Anything else, or an id that is not a UUID, is none.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Whether a task was handed over from a member's own to-do (#1674); the to-do stays private, so no id is shown. */
export function fromTodo(sourceRef: unknown): boolean {
  return typeof sourceRef === 'object' && sourceRef !== null && (sourceRef as { type?: unknown }).type === 'notes.todo';
}

function sourceRefId(sourceRef: unknown, expectedType: string): string | null {
  if (typeof sourceRef !== 'object' || sourceRef === null) return null;
  const { type, id } = sourceRef as { type?: unknown; id?: unknown };
  return type === expectedType && typeof id === 'string' && UUID.test(id) ? id : null;
}

export function socialPostOf(sourceRef: unknown): string | null {
  return sourceRefId(sourceRef, 'social.post');
}

/** The action item of a meeting a task was made from (#2580), or null. The meeting itself is asked of the kernel, which answers only a reader of it. */
export function meetingItemOf(sourceRef: unknown): string | null {
  return sourceRefId(sourceRef, 'meetings.action_item');
}

/** The meeting a task was proposed from directly (#2608), or null. */
export function meetingSourceOf(sourceRef: unknown): string | null {
  return sourceRefId(sourceRef, 'meetings.meeting');
}

/** Human-facing display label for a conversation summary (#2608). */
export function conversationSummaryTitle(c: {
  subject?: string | null | undefined;
  contact: { displayName: string | null; partyName: string | null };
  channel: { displayName: string };
}): string {
  return c.subject?.trim() || c.contact.displayName?.trim() || c.contact.partyName?.trim() || c.channel.displayName.trim();
}

/** The Inbox thread a task was made from (#3421, "Create task" in the Inbox: `source_ref` is `{type: 'kernel.conversation', id}`), or null. Only the id is read: the thread itself is asked of the Inbox, which answers a reader of it. */
export function conversationOf(sourceRef: unknown): string | null {
  if (typeof sourceRef !== 'object' || sourceRef === null) return null;
  const { type, id } = sourceRef as { type?: unknown; id?: unknown };
  return type === 'kernel.conversation' && typeof id === 'string' && UUID.test(id) ? id : null;
}

/** The YYYY-MM-DD day of a task's ISO due timestamp in `timeZone`, or '' when there is none (#2588). */
export function taskDueDay(due: string | null | undefined, timeZone: string): string {
  if (!due) return '';
  const ms = Date.parse(due);
  if (Number.isNaN(ms)) return '';
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

/** End of `dueOn` (23:59) in `timeZone` as an ISO timestamp, or null when `dueOn` is empty (#2588). */
export function taskDueFromDay(dueOn: string, timeZone: string): string | null {
  const day = dueOn.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  try {
    return todoDueInstant(day, '23:59', timeZone).toISOString();
  } catch {
    return `${day}T23:59:00.000Z`;
  }
}

export type ActiveCoworkerKey = Exclude<CoworkerKey, 'system'>;
export const ACTIVE_COWORKER_KEYS: readonly ActiveCoworkerKey[] = ['gm', 'finance', 'sales', 'marketing'];

const GM_MODULES: readonly string[] = ['kernel', 'notes', 'projects', 'meetings', 'sign'];

// Conversations meter/budget targets 'conversation' (packages/agent/src/meter.ts), while the UI/module id is 'conversations'.
function killSwitchTargets(mod: string): readonly string[] {
  return mod === 'conversations' ? ['conversations', 'conversation'] : [mod];
}

// HR payroll and labor checks meter under 'finance' (packages/agent/src/meter.ts) even when Finance UI is turned off.
function budgetTargets(mod: string): readonly string[] {
  if (mod === 'conversations') return ['conversations', 'conversation'];
  if (mod === 'hr') return ['hr', 'finance'];
  return [mod];
}

function coveredModulesOf(key: ActiveCoworkerKey): readonly string[] {
  if (key === 'gm') return GM_MODULES;
  return Object.entries(COWORKER_BY_MODULE)
    .filter(([, owner]) => owner === key)
    .map(([mod]) => mod);
}

export interface CoworkerBudgetSummary {
  scope: string;
  monthlyLimit: string;
  spent: string;
  warnPercent: number;
  hardStop: boolean;
}

export type CoworkerStopState = 'running' | 'partial' | 'stopped';

export interface CoworkerOverview {
  key: ActiveCoworkerKey;
  name: string;
  coveredModules: readonly string[];
  stopState: CoworkerStopState;
  stopped: boolean;
  budget: CoworkerBudgetSummary | null;
  budgets: CoworkerBudgetSummary[];
}

function budgetSeverityRank(b: CoworkerBudgetSummary): number {
  const { state } = budgetUsage(b.spent, b.monthlyLimit, b.warnPercent);
  if (state === 'spent') return b.hardStop ? 3 : 2;
  if (state === 'warn') return 1;
  return 0;
}

/** Build the ordered AI coworkers that exist for an org based on installed modules, matching coworker-names.ts (#3594). */
export function activeCoworkers(input: {
  modules: readonly string[];
  agents: ReadonlyArray<{ id: string; templateKey: string; displayName: string; status: string }>;
  templateModules: ReadonlyMap<string, string>;
  killSwitches: ReadonlyArray<{ scope: string; target: string }>;
  budgets?: ReadonlyArray<{ scope: string; target: string; monthlyLimit: string; spent: string; warnPercent: number; hardStop: boolean }> | undefined;
}): CoworkerOverview[] {
  const installed = new Set(input.modules);
  const out: CoworkerOverview[] = [];
  for (const key of ACTIVE_COWORKER_KEYS) {
    const allModules = coveredModulesOf(key);
    const activeModules = key === 'gm' ? allModules.filter((m) => m === 'kernel' || installed.has(m)) : allModules.filter((m) => installed.has(m));
    if (key !== 'gm' && activeModules.length === 0) continue;

    // Input agents come ordered by (created_at, id) from chart.get: oldest non-retired across all covered modules
    // matches packages/kernel/src/coworker-names.ts even when one covered module is disabled (#3594).
    const namingAgents =
      key === 'gm'
        ? []
        : input.agents.filter((a) => a.status !== 'retired' && allModules.includes(input.templateModules.get(a.templateKey) ?? ''));
    const name = namingAgents[0]?.displayName ?? COWORKER_ROSTER[key];
    const activeAgents =
      key === 'gm'
        ? []
        : input.agents.filter((a) => a.status !== 'retired' && activeModules.includes(input.templateModules.get(a.templateKey) ?? ''));
    const agentIds = new Set(activeAgents.map((a) => a.id));

    const budgetModules = new Set(activeModules.flatMap(budgetTargets));
    const orgStopped = input.killSwitches.some((k) => k.scope === 'org');
    const stoppedModules = activeModules.filter((m) =>
      input.killSwitches.some((k) => k.scope === 'module' && killSwitchTargets(m).includes(k.target)),
    );
    const hasStoppedAgent = input.killSwitches.some((k) => k.scope === 'agent' && agentIds.has(k.target));
    const allStopped = orgStopped || stoppedModules.length === activeModules.length;
    const stopState: CoworkerStopState = allStopped ? 'stopped' : stoppedModules.length > 0 || hasStoppedAgent ? 'partial' : 'running';

    // Consider all concurrently enforced budgets (org, active modules, coworker agents), surfacing blocking/spent limits first.
    const rankedBudgets: Array<{ summary: CoworkerBudgetSummary; specificity: number }> = [];
    if (input.budgets) {
      for (const b of input.budgets) {
        const specificity =
          b.scope === 'agent' && agentIds.has(b.target)
            ? 2
            : b.scope === 'module' && budgetModules.has(b.target)
              ? 1
              : b.scope === 'org'
                ? 0
                : -1;
        if (specificity < 0) continue;
        rankedBudgets.push({
          specificity,
          summary: {
            scope: b.scope,
            monthlyLimit: b.monthlyLimit,
            spent: b.spent,
            warnPercent: b.warnPercent,
            hardStop: b.hardStop,
          },
        });
      }
      rankedBudgets.sort(
        (a, b) => budgetSeverityRank(b.summary) - budgetSeverityRank(a.summary) || b.specificity - a.specificity,
      );
    }
    const budgets = rankedBudgets.map((r) => r.summary);

    out.push({ key, name, coveredModules: activeModules, stopState, stopped: stopState === 'stopped', budget: budgets[0] ?? null, budgets });
  }
  return out;
}

export const KNOWN_TEMPLATE_KEYS = ['finance.chief_accountant', 'social.content_manager', 'crm.scheduler', 'kernel.member_vy'] as const;
export type KnownTemplateKey = (typeof KNOWN_TEMPLATE_KEYS)[number];
export type KnownTemplateMsgKey = 'finance_chief_accountant' | 'social_content_manager' | 'crm_scheduler' | 'kernel_member_vy';

const TEMPLATE_KEY_TO_MSG: Readonly<Record<KnownTemplateKey, KnownTemplateMsgKey>> = {
  'finance.chief_accountant': 'finance_chief_accountant',
  'social.content_manager': 'social_content_manager',
  'crm.scheduler': 'crm_scheduler',
  'kernel.member_vy': 'kernel_member_vy',
};

const SEEDED_POSITION_TO_TEMPLATE: Readonly<Record<string, KnownTemplateKey>> = {
  'Kế toán trưởng (AI)': 'finance.chief_accountant',
  'Quản lý nội dung (AI)': 'social.content_manager',
  'Điều phối lịch hẹn (AI)': 'crm.scheduler',
  'Vy làm việc cho một thành viên': 'kernel.member_vy',
};

export function knownTemplateMsgKey(templateKey: string): KnownTemplateMsgKey | null {
  return Object.hasOwn(TEMPLATE_KEY_TO_MSG, templateKey) ? TEMPLATE_KEY_TO_MSG[templateKey as KnownTemplateKey] : null;
}

/** Remove legacy trailing " (AI)" suffix from agent template or position titles since AI badges are rendered beside them. */
export function stripAiSuffix(title: string): string {
  const cleaned = title.replace(/\s*\(AI\)\s*$/i, '').trim();
  return cleaned || title;
}

/** Resolve a template title in the active locale using known seeded keys first, then stripping " (AI)". */
export function resolveTemplateTitle(templateKey: string, fallbackTitle: string | undefined, translate: (msgKey: KnownTemplateMsgKey) => string): string {
  const known = knownTemplateMsgKey(templateKey);
  if (known) return translate(known);
  return fallbackTitle ? stripAiSuffix(fallbackTitle) : templateKey;
}

/** Resolve a stored position title (mapping seeded Vietnamese titles to the active locale) without " (AI)". */
export function resolvePositionTitle(title: string, translate: (msgKey: KnownTemplateMsgKey) => string): string {
  const templateKey = Object.hasOwn(SEEDED_POSITION_TO_TEMPLATE, title) ? SEEDED_POSITION_TO_TEMPLATE[title] : undefined;
  if (templateKey) return translate(TEMPLATE_KEY_TO_MSG[templateKey]);
  return stripAiSuffix(title);
}

/** Derive a valid unique kernel roleKey (`^[a-z][a-z0-9_.]*$`, max 100 chars) from a position title and module (#3594). */
export function deriveRoleKey(title: string, module: string, existingRoleKeys: Iterable<string> = []): string {
  const safeModule = /^[a-z][a-z0-9_]*$/.test(module) ? module : 'role';
  const ascii = title
    .replaceAll('đ', 'd')
    .replaceAll('Đ', 'd')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const prefix = `${safeModule}.`;
  const slug = (ascii || 'position').slice(0, Math.max(1, 90 - prefix.length)).replace(/_+$/g, '') || 'position';
  const base = `${prefix}${slug}`;
  const used = new Set(existingRoleKeys);
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}_${suffix}`)) suffix += 1;
  return `${base}_${suffix}`;
}

/** Whether AI connections screen is enabled in deployment config and shown in nav/palette (#3594). */
export function aiConnectionsVisible(mcpEnabled: boolean | undefined): boolean {
  return mcpEnabled === true;
}
