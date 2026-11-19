// SPDX-License-Identifier: AGPL-3.0-only
// The source pins of managing a running ad (ADR-0043 points 1, 2, 4 and 5, issue #3835, W4; the database's own pins are in ads-manage.db.test.ts next to this file and in
// apps/kernel/test/ads.db.test.ts, "managing a running ad (W4)"). Managing a running ad can start or raise spend (a resume, a raise, an extension), so the code that can do it
// is a short list: the manage job is given a frozen view of the platform with four calls and nothing else, built apart from the launch writers, the pausers, the activators and
// the state readers; no status word is spelled in the files that are new; the job calls the platform only after the begin command that re-checked the stop conditions and the
// caps, for the object that command named; the three commands that can raise spend are R3 financial proposal commands and the only writers of their kinds; and Uy's suggestion
// can only lower or pause, never raise. They read the sources, so a second caller, a view that gets another call, a worker block that reaches another view or a suggestion that
// suggests a raise fails here before it reaches review. Keep this directory self-contained: the one import is the pure rule under test.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { suggestionFor } from '@crove/mod-ads';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SKIP = new Set(['node_modules', 'dist', 'test', 'tests', '.git', '.turbo', 'coverage']);

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sources(path, out);
    else if (/\.(ts|tsx|mts|mjs|js)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(relative(ROOT, path).replaceAll('\\', '/'));
  }
  return out;
}

const ALL = ['apps', 'packages', 'modules', 'tools'].filter((d) => existsSync(join(ROOT, d))).flatMap((d) => sources(join(ROOT, d)));
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const adPlatformPkg = (JSON.parse(read('packages/ad-platform/package.json')) as { name: string }).name;
if (adPlatformPkg !== '@crove/ad-platform' && adPlatformPkg !== '@ludy/ad-platform') {
  throw new Error(`Unexpected ad-platform package name: ${adPlatformPkg}`);
}
const adPlatformRe = adPlatformPkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const naming = (text: string) => ALL.filter((path) => read(path).includes(text)).sort();
// Code only: the lines that are not comments.
const code = (path: string) => read(path).split('\n').filter((line) => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*')).join('\n');
const codeNaming = (pattern: RegExp) => ALL.filter((path) => pattern.test(code(path))).sort();
const between = (text: string, from: string, to: string) => {
  const start = text.indexOf(from);
  const end = text.indexOf(to, start + from.length);
  expect(start, from).toBeGreaterThan(-1);
  expect(end, to).toBeGreaterThan(start);
  return text.slice(start, end);
};

describe('what may change a running ad at the platform (#3835, W4)', () => {
  it('gives the manage job a frozen view of four calls and nothing else, with no way to create, find by a tag, verify a token or revoke one', () => {
    const view = code('packages/ad-platform/src/managers.ts').replace(/^import .*$/gm, '');
    // The interface: four methods.
    const iface = between(view, 'export interface AdManager {', '\n}\n');
    expect([...iface.matchAll(/^\s{2}(\w+)\(/gm)].map((m) => m[1])).toEqual(['changeStatus', 'setBudget', 'setEndTime', 'read']);
    // The view: a new frozen object of closures, the four calls and no other.
    expect(view).toContain('return Object.freeze({');
    const frozen = between(view, 'return Object.freeze({', '\n  });');
    expect([...frozen.matchAll(/^\s{4}(\w+): async/gm)].map((m) => m[1])).toEqual(['changeStatus', 'setBudget', 'setEndTime', 'read']);
    expect([...new Set([...view.matchAll(/\bmanager\.(\w+)\(/g)].map((m) => m[1]))].sort()).toEqual(['changeStatus', 'read', 'setBudget', 'setEndTime']);
    expect(view).not.toMatch(/\b(create\w*|findByTag|verify|revoke\w*|fetch)\b/);
    // The levels and the statuses are checked in the view as well as in the adapters, so a creative never gets a status.
    expect(view).toContain("'LEVEL_NOT_MANAGEABLE'");
    expect(view).toContain("'STATUS_REFUSED'");
    // Only the platform package builds one, and the map of a deployment is built in one place, from the config.
    expect(codeNaming(/\bmanagerOf\(/)).toEqual(['packages/ad-platform/src/launch-writers.ts', 'packages/ad-platform/src/managers.ts']);
    expect(codeNaming(/\badManagers\(/)).toEqual(['apps/kernel/src/kernel.ts', 'packages/ad-platform/src/launch-writers.ts']);
    expect(codeNaming(/new MetaAdManager\(/)).toEqual(['packages/ad-platform/src/launch-writers.ts']);
    expect(codeNaming(/new SandboxAdManager\(/)).toEqual(['packages/ad-platform/src/launch-writers.ts']);
    expect(code('apps/kernel/src/kernel.ts')).toMatch(/adManagers: adManagersOf\(config\)/);
    // The Meta view is built only where the live switch is on, the same switch as its writer, which a public deployment refuses.
    expect(code('apps/kernel/src/kernel.ts')).toMatch(/export function adManagersOf[\s\S]*config\.ADS_LIVE_LAUNCH === 'true' && config\.CHANNEL_META_ADS_WRITE_APP_SECRET/);
    // The view is not a method of the writer, the activator or the pauser, and their views do not carry it.
    for (const path of ['packages/ad-platform/src/writer.ts', 'packages/ad-platform/src/activators.ts', 'packages/ad-platform/src/pausers.ts', 'packages/ad-platform/src/state-readers.ts']) {
      expect(code(path), path).not.toMatch(/\b(changeStatus|setBudget|setEndTime)\b/);
    }
  });

  it('spells no status word in the files that are new: the status words stay where the writer and the activator already have them', () => {
    for (const path of ['packages/ad-platform/src/managers.ts', 'packages/ad-platform/src/meta-manage.ts', 'packages/ad-platform/src/sandbox-manage.ts', 'apps/kernel/src/ads-manage.ts', 'modules/ads/src/manage.ts', 'modules/ads/src/manage-rules.ts', 'modules/ads/src/manage-state.ts']) {
      expect(code(path), path).not.toMatch(/\b(ACTIVE|PAUSED|ARCHIVED)\b/);
    }
    // And the files that spell them are the ones that did before this slice: ACTIVE from the activation's file alone.
    expect(codeNaming(/\bACTIVE\b/).filter((p) => p.startsWith('packages/ad-platform/') || p.startsWith('apps/') || p.startsWith('modules/'))).toEqual(['packages/ad-platform/src/meta-activate.ts']);
    // Meta's management reads a status word, never sends one: the write goes through the two classes that already own the words.
    const meta = code('packages/ad-platform/src/meta-manage.ts');
    expect(meta).toMatch(/this\.writer\.setStatus\(/);
    expect(meta).toMatch(/this\.activator\.activate\(/);
    expect(meta).not.toMatch(/form: \{[^}]*status/);
  });

  it('keeps the other jobs away from the view, and the manage job away from everything that creates, finds, pauses by a tag, revokes or switches on a launch\'s objects', () => {
    for (const path of ['apps/kernel/src/ads-launch.ts', 'apps/kernel/src/ads-pause.ts', 'apps/kernel/src/ads-pause-run.ts', 'apps/kernel/src/ads-revoke.ts', 'apps/kernel/src/ads-activate.ts', 'apps/kernel/src/ads-state.ts']) {
      expect(code(path), path).not.toMatch(/adManagers|AdManager|runAdsManage/);
    }
    const job = code('apps/kernel/src/ads-manage.ts');
    expect(job).not.toMatch(/LaunchWriter|AdPauser|AdRevoker|AdActivator|AdStateReader|\.setStatus\(|\.activate\(|createCampaign|createAdSet|createCreative|createAd\(|revokeToken|findByTag|\.verify\(/);
    // The platform package's names the job imports are the error and the two types of the view.
    expect(job).toMatch(new RegExp(`import \\{ AdPlatformError, type AdManager, type ManagedRead \\} from '${adPlatformRe}';`));
  });

  it('bounds the time between begin and the platform call, inside the wait of the wind-down: a begin that waited too long is never called', () => {
    const job = code('apps/kernel/src/ads-manage.ts');
    const bound = /export const BEGIN_TO_CALL_MS = (\d[\d_]*);/.exec(job);
    const callTimeout = /const CALL_TIMEOUT_MS = (\d[\d_]*);/.exec(job);
    expect(bound).not.toBeNull();
    // The longest a call can be sent after its begin (the bound plus the call's own timeout) is inside the wind-down's wait for a begun manage call.
    const pause = code('modules/ads/src/launch-pause.ts');
    const wait = Number(/const ACTIVATION_IN_FLIGHT_SECONDS = (\d+);/.exec(pause)?.[1]);
    expect((Number(String(bound?.[1]).replaceAll('_', '')) + Number(String(callTimeout?.[1]).replaceAll('_', ''))) / 1000).toBeLessThan(wait);
    expect(pause).toMatch(/ads\.manage:' \|\| c\.id::text \|\| ':apply'/);
    // The check is before the call, after the token is opened, on the call path and after the read on the reconcile path.
    // A stale begin records NOTHING (a record from a worker that woke late could undo the call another worker made after reconciling), and the clock is monotonic.
    expect(job).toMatch(/if \(work\.action === 'call' && stale\(\)\) return 'stale_begin';/);
    expect(job).not.toMatch(/STALE_BEGIN'? \}/);
    expect(job).toContain('performance.now()');
    expect(job).not.toContain('Date.now');
    expect(job.indexOf("stale()) return 'stale_begin'")).toBeLessThan(job.indexOf('await timed(() => make('));
    expect(job.indexOf('broker.open(')).toBeLessThan(job.indexOf("stale()) return 'stale_begin'"));
    expect(job).toMatch(/if \(stale\(\)\) return 'stale_begin';/);
  });

  it('calls the platform only after the begin command that re-checked everything, for the object that command named, and opens the token once', () => {
    const job = code('apps/kernel/src/ads-manage.ts');
    // Each of the view's calls has one call site, in this file, and no other file of the apps or the modules makes them.
    for (const call of ['changeStatus', 'setBudget', 'setEndTime']) {
      expect(job.match(new RegExp(`manager\\.${call}\\(`, 'g')), call).toHaveLength(1);
      expect(codeNaming(new RegExp(`\\.${call}\\(`)).filter((p) => p.startsWith('apps/') || p.startsWith('modules/')), call).toEqual(['apps/kernel/src/ads-manage.ts']);
    }
    expect(job.match(/manager\.read\(/g)).toHaveLength(1);
    // The call sites are in the functions that run work begin handed out: begin comes first in the exported function, `none` returns before anything else, and the object is the one
    // begin named.
    expect(job).toContain("'ads.manage.begin'");
    expect(job).toContain('const target = { level: work.level, id: work.objectId };');
    const run = job.slice(job.indexOf('export async function runAdsManage'));
    expect(run.indexOf("'ads.manage.begin'")).toBeGreaterThan(-1);
    expect(run.indexOf("'ads.manage.begin'")).toBeLessThan(run.indexOf("if (work.action === 'none') return"));
    expect(run.indexOf("if (work.action === 'none') return")).toBeLessThan(run.indexOf('runChange('));
    expect(job.match(/runChange\(/g)).toHaveLength(2);
    expect(job.indexOf('async function runChange')).toBeLessThan(job.indexOf('export async function runAdsManage'));
    // The token: opened once, with the broker, from the credential query that refuses a connection that is not active or whose connector may not use it; a worker with no
    // broker begins nothing.
    expect(job.match(/broker\.open\(/g)).toHaveLength(1);
    expect(job).toContain("'kernel.channel.credential'");
    expect(job).toMatch(/if \(deps\.broker\.id === 'none'\) return/);
    expect(job.indexOf("deps.broker.id === 'none'")).toBeLessThan(job.indexOf("'ads.manage.begin'"));
    // The secret lives in one function's scope: never logged, never in an error, never sent to a command.
    for (const line of job.split('\n').filter((l) => /console\.(log|warn|error|info|debug)/.test(l))) expect(line, line).not.toMatch(/secret|envelope|token|sealed/i);
    expect(job).not.toMatch(/execute[^;]*\bsecret\b/);
    expect(job).not.toMatch(/new (Error|AdPlatformError)\([^)]*\bsecret\b/);
    // What the recorded answer carries is a code of the platform's, never a message.
    expect(job).toContain('const safeCode =');
    expect(job).not.toMatch(/error\.message|\.stack\b/);
  });

  it('declares the job\'s commands: begin the system\'s R2 external one that re-checks before the ledger row of a call, record the system\'s R1, and begin holds the tenant row like a switch-off', () => {
    const commands = code('modules/ads/src/manage.ts');
    expect(commands).toMatch(/name: 'ads\.manage\.begin',\s*opensBusyWork: true,[\s\S]*?risk: 'R2',\s*sideEffect: 'external',\s*access: 'system'/);
    expect(commands).toMatch(/name: 'ads\.manage\.record',[\s\S]*?risk: 'R1',\s*sideEffect: 'internal',\s*access: 'system'/);
    const begin = between(commands, "name: 'ads.manage.begin'", "name: 'ads.manage.record'");
    // Before the ledger row of the call is made, begin takes the org's lock, the launch's row, and re-checks the launch, the stop conditions and, for what can raise spend, the caps.
    const order = ['lockedSetting(ctx)', ".forUpdate().executeTakeFirstOrThrow()", 'stopConditions(', 'manageCapsProblems(', "insertInto('crove_kernel.external_call')"];
    let at = -1;
    for (const part of order) {
      const next = begin.indexOf(part);
      expect(next, part).toBeGreaterThan(at);
      at = next;
    }
    expect(begin).toContain("settle('cancelled', 'cap_lowered'");
    expect(begin).toContain('OPENING_KINDS.includes(change.kind)');
    // A launch that is no longer live cancels what was queued, and the stops win: only a pause is kept for a launch that needs attention.
    expect(begin).toMatch(/launch_\$\{lockedLaunchRow\.state\}/);
    expect(begin).toMatch(/stopsChange\(stops, change\.kind\)/);
    // The record never calls anything and writes nothing of the launch, its commitment or the caps: the change's state and the call's ledger row only.
    const record = commands.slice(commands.indexOf("name: 'ads.manage.record'"), commands.indexOf('export const adsManageState'));
    expect(record).not.toMatch(/ad_launch|ad_spend_cap|ad_org_setting|insertInto/);
    expect([...new Set([...record.matchAll(/updateTable\('([a-z_.]+)'\)/g)].map((m) => m[1]))].sort()).toEqual(['crove_ads.ad_manage_change', 'crove_kernel.external_call']);
  });
});

describe('what can raise spend of a running ad (#3835, W4)', () => {
  it('keeps the resume, the raise and the extension R3 financial proposal commands, their preparers R1 internal, and the four reducing commands and the cancel R2 external, owners and admins', () => {
    const commands = code('modules/ads/src/manage.ts');
    for (const name of ['ads.object.resume', 'ads.budget.raise', 'ads.schedule.extend']) {
      const at = commands.indexOf(`name: '${name}'`);
      expect(at, name).toBeGreaterThan(-1);
      expect(commands.slice(at, at + 500), name).toMatch(/risk: 'R3',\s*sideEffect: 'financial',\s*access: 'proposal',\s*proposalKind:/);
    }
    for (const name of ['ads.object.prepare_resume', 'ads.budget.prepare_raise', 'ads.schedule.prepare_extend']) {
      const at = commands.indexOf(`name: '${name}'`);
      expect(at, name).toBeGreaterThan(-1);
      expect(commands.slice(at, at + 400), name).toMatch(/risk: 'R1',\s*sideEffect: 'internal',\s*access: MANAGERS/);
    }
    for (const name of ['ads.object.pause', 'ads.object.archive', 'ads.budget.lower', 'ads.schedule.shorten', 'ads.manage.cancel']) {
      const at = commands.indexOf(`name: '${name}'`);
      expect(at, name).toBeGreaterThan(-1);
      expect(commands.slice(at, at + 400), name).toMatch(/risk: 'R2',\s*sideEffect: 'external',\s*access: MANAGERS/);
    }
    expect(commands).toMatch(/const MANAGERS: readonly MemberRole\[\] = \['owner', 'admin'\];/);
    // A preparer posts nothing: it reads and returns the request; no preparer writes a change, emits an event or calls insertChange.
    for (const name of ['ads.object.prepare_resume', 'ads.budget.prepare_raise', 'ads.schedule.prepare_extend']) {
      const at = commands.indexOf(`name: '${name}'`);
      const body = commands.slice(at, commands.indexOf('\n});', at));
      expect(body, name).not.toMatch(/insertChange|emit\(|insertInto|updateTable/);
    }
  });

  it('inserts a change of a kind that can raise spend from the approved commands only: no other command, and no other file, writes the table', () => {
    const commands = code('modules/ads/src/manage.ts');
    // The one INSERT into the table is `insertChange`, in this file; the one update of its state is begin, record and the cancel, in this file.
    expect(codeNaming(/insertInto\('crove_ads\.ad_manage_change'\)/)).toEqual(['modules/ads/src/manage.ts']);
    expect(commands.match(/insertInto\('crove_ads\.ad_manage_change'\)/g)).toHaveLength(1);
    expect(codeNaming(/updateTable\('crove_ads\.ad_manage_change'\)/)).toEqual(['modules/ads/src/manage.ts']);
    expect(codeNaming(/deleteFrom\('crove_ads\.ad_manage_change'\)/)).toEqual([]);
    // Every call of insertChange: the reducing commands name their own kind and never a proposal; the approved ones go through approvedHandler, which names the proposal of the approval.
    const calls = [...commands.matchAll(/insertChange\(ctx, control, \{([^}]*)\}\)/g)].map((m) => m[1] as string);
    expect(calls).toHaveLength(5);
    const reducing = calls.filter((c) => !c.includes('...change'));
    expect(reducing.map((c) => /kind: '(\w+)'/.exec(c)?.[1]).sort()).toEqual(['archive', 'budget_lower', 'pause', 'schedule_shorten']);
    for (const c of reducing) expect(c).not.toContain('proposalId');
    const approvedCalls = calls.filter((c) => c.includes('...change'));
    expect(approvedCalls).toEqual([' ...change, proposalId: ctx.proposalId ']);
    // The kinds that can raise spend are named as a change to make in approvedHandler only, whose three callers are the three R3 commands.
    const handler = between(commands, 'function approvedHandler', 'export const adsObjectResume');
    expect([...handler.matchAll(/kind: '(\w+)'/g)].map((m) => m[1]).sort()).toEqual(['budget_raise', 'resume', 'schedule_extend']);
    // (The audit rows of the three approved commands name their own kind: a record of what ran, never a write.)
    const outside = commands.replace(handler, '').replace(/ctx\.audit\(\{[^\n]*\}\);/g, '');
    expect(outside).not.toMatch(/kind: '(resume|budget_raise|schedule_extend)'(?! as const)/);
    expect(handler).toMatch(/if \(!ctx\.proposalId \|\| ctx\.actor\.type !== 'user'\) throw onlyApproved\(\);/);
    expect(commands.match(/approvedHandler\('(resume|budget_raise|schedule_extend)'\)\(ctx, payload\)/g)).toHaveLength(3);
    // The caps are judged under the org's lock (held by the controlOf every command opens with) before the row is written, and again by begin.
    expect(handler.indexOf('await refuseOverCaps(')).toBeGreaterThan(-1);
    expect(handler.indexOf('await refuseOverCaps(')).toBeLessThan(handler.indexOf('insertChange(ctx, control'));
    expect(commands).toMatch(/async function controlOf[\s\S]*await lockedSetting\(ctx\);/);
    // The database's guard knows the same three commands and no other: it is the migration's alone, and it asks the approval for them.
    const migration = readdirSync(join(ROOT, 'supabase/migrations')).find((f) => f.endsWith('_crove_ads_manage.sql')) as string;
    const sql = read(`supabase/migrations/${migration}`);
    expect(sql).toContain("v_command := CASE NEW.kind WHEN 'resume' THEN 'ads.object.resume' WHEN 'budget_raise' THEN 'ads.budget.raise' ELSE 'ads.schedule.extend' END;");
    expect(sql).toContain("NEW.kind IN ('resume', 'budget_raise', 'schedule_extend')");
    expect(sql).toContain('crove_ads.approved_execution(v_command, v_match, v_amount)');
  });

  it('writes the event that queues the job from the commands that make a change, with ids only, and the sweep that writes it again is the worker\'s definer, in the migration only', () => {
    expect(codeNaming(/ctx\.emit\('ads\.manage\.queued'/)).toEqual(['modules/ads/src/manage.ts']);
    const commands = code('modules/ads/src/manage.ts');
    const emits = [...commands.matchAll(/ctx\.emit\('ads\.manage\.queued', (\{[^}]*\})\)/g)].map((m) => m[1]);
    // Seven changes, seven emits (the four reducing commands and the three approved ones), each with the three ids and nothing else.
    expect(emits).toHaveLength(7);
    const own = '{ changeId, launchId: control.launch.id, adAccountId: control.launch.ad_account_id }';
    const approved = '{ changeId: done.changeId, launchId: done.control.launch.id, adAccountId: done.control.launch.ad_account_id }';
    expect([...emits].sort()).toEqual([approved, approved, approved, own, own, own, own].sort());
    const migration = readdirSync(join(ROOT, 'supabase/migrations')).find((f) => f.endsWith('_crove_ads_manage.sql')) as string;
    expect(naming("'ads.manage.queued'").filter((p) => p.endsWith('.sql'))).toEqual([]);
    expect(read(`supabase/migrations/${migration}`)).toContain("'ads.manage.queued', pg_catalog.jsonb_build_object('changeId', v_row.change_id, 'launchId', v_row.launch_id, 'adAccountId', v_row.ad_account_id)");
    expect(read(`supabase/migrations/${migration}`)).toContain("crove_jobs.create_queue('ads-manage'");
  });

  it('names the queue in the schema and the worker only, with the egress of the ad platform and nothing else; the worker block reads the managers and the broker alone; the relay sends ids only', () => {
    expect(naming('QUEUES.adsManage')).toEqual(['apps/kernel/src/jobs-schema.ts', 'apps/kernel/src/worker.ts']);
    expect(code('apps/kernel/src/jobs-schema.ts')).toMatch(/\[QUEUES\.adsManage\]: \['provider:ad_platform'\]/);
    // The only code that reads `adManagers`: the platform package builds it, the kernel hands it over, the worker's block and relay use it.
    expect(codeNaming(/\badManagers\b/)).toEqual(['apps/kernel/src/kernel.ts', 'apps/kernel/src/worker.ts', 'packages/ad-platform/src/launch-writers.ts']);
    const worker = code('apps/kernel/src/worker.ts');
    // The only worker block that reads them is the ads-manage queue's, and it reads nothing else of the ad platform.
    const block = between(worker, 'const adManagers = deps.channels?.adManagers;', 'await dropCron(QUEUES.adsManage);');
    expect(block).toContain('boss.work<AdsManageJob | { sweep: true }>(QUEUES.adsManage');
    expect(block).not.toMatch(/adWriters|adPausers|adRevokers|adPlatforms|adActivators|adStateReaders/);
    expect(block).not.toMatch(/deps\.channels(?!\?\.adManagers)/);
    // No other queue's block reads the managers: every other mention is the relay's gate for this event.
    const outside = worker.replace(block, '');
    expect([...outside.matchAll(/\badManagers\b/g)].length).toBe(2 + 1);
    expect(outside).toMatch(/adManagers\?: Readonly<Record<string, AdManager>>;/);
    // The relay sends it with ids only, for the one event the commands write.
    expect(worker).toMatch(/row\.type === 'ads\.manage\.queued'/);
    expect(worker).toMatch(/boss\.send\(QUEUES\.adsManage, \{ orgId: row\.org_id, changeId \} satisfies AdsManageJob/);
    expect(worker).toContain('const changeId = String(row.payload.changeId);');
    // The other queue blocks do not reach the managers.
    for (const queue of ['adsLaunch', 'adsActivate', 'adsPause', 'adsRevoke', 'adsState']) {
      const at = worker.indexOf(`QUEUES.${queue}`);
      if (at === -1) continue;
      expect(worker.slice(at, at + 600), queue).not.toMatch(/adManagers/);
    }
  });
});

describe('what Uy may suggest for a running ad (#3835, W4)', () => {
  it('can only suggest a pause or a lower budget, never a raise: the query changes nothing and its rule has no other kind', () => {
    const commands = code('modules/ads/src/manage.ts');
    const query = between(commands, "name: 'ads.manage.suggestions'", 'export const manageCommands');
    // Read only: a query of the ads module that writes no row, emits no event and runs no command, and calls no model.
    expect(query).not.toMatch(/insertInto|updateTable|deleteFrom|\.emit\(|\.execute\('|runtime\.|fetch\(|insertChange|ai\.|llm/i);
    expect(query).toContain('suggestionFor(');
    // The kinds it can put in an answer are the rule's, and the contract's enum has the same two.
    expect(query).not.toMatch(/budget_raise|schedule_extend|resume/);
    const rules = code('modules/ads/src/manage-rules.ts');
    const rule = between(rules, 'export function suggestionFor', 'export function sameInstant');
    expect([...new Set([...rule.matchAll(/kind: '(\w+)'/g)].map((m) => m[1]))].sort()).toEqual(['budget_lower', 'pause']);
    expect(rule).not.toMatch(/raise|extend|resume|archive/);
    expect(code('packages/kernel-contract/src/ads-manage.ts')).toContain("export const ADS_MANAGE_SUGGESTION_KINDS = ['pause', 'budget_lower'] as const;");
    // The suggestion is for people with the controls: owners and admins.
    expect(query).toMatch(/access: MANAGERS/);
  });

  it('proposes a budget that is always below the one the launch holds, whatever the ratio, the budget and the currency', () => {
    // A decimal string as a count of its smallest unit (two places at most), so the comparison is exact and uses no float.
    const cents = (value: string): bigint => {
      const [whole = '0', fraction = ''] = value.split('.');
      return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2));
    };
    const ratios = ['1.00', '1.01', '1.5', '2', '2.5', '2.99', '2.999999', '3', '3.0001', '5', '10', '100', '1000000'];
    const budgets = ['1', '2', '3', '9', '10', '99', '100', '101', '999', '1000', '7777', '50000', '100000', '100001', '123456', '999999', '5000000', '10000000000', '9999999999999', '1.5', '0.99', '12.34', '100.01', '9999999999999.99'];
    let lowers = 0;
    let pauses = 0;
    for (const currency of ['VND', 'USD', 'EUR']) {
      for (const ratio of ratios) {
        for (const heldBudget of budgets) {
          const s = suggestionFor({ ratio, heldBudget, currency });
          expect(['pause', 'budget_lower'], `${ratio} ${heldBudget} ${currency}`).toContain(s.kind);
          if (s.kind === 'budget_lower') {
            lowers += 1;
            expect(cents(s.toBudget) < cents(heldBudget), `${ratio} ${heldBudget} ${currency}: ${s.toBudget}`).toBe(true);
            expect(cents(s.toBudget) > 0n, `${ratio} ${heldBudget} ${currency}: ${s.toBudget}`).toBe(true);
            // Never more than seven tenths of what is held.
            expect(cents(s.toBudget) * 10n <= cents(heldBudget) * 7n, `${ratio} ${heldBudget} ${currency}: ${s.toBudget}`).toBe(true);
            expect(Object.keys(s).sort()).toEqual(['kind', 'toBudget']);
          } else {
            pauses += 1;
            expect(Object.keys(s)).toEqual(['kind']);
          }
        }
      }
    }
    // The property was tested on both kinds.
    expect(lowers).toBeGreaterThan(100);
    expect(pauses).toBeGreaterThan(100);
    // A ratio of three or more is a pause, whatever the budget.
    for (const heldBudget of budgets) expect(suggestionFor({ ratio: '3', heldBudget, currency: 'VND' })).toEqual({ kind: 'pause' });
  });
});
