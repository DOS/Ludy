// SPDX-License-Identifier: AGPL-3.0-only
// The source pins of the activation (ADR-0043 points 4 and 5, issue #2296, W2-4b; the database's own pins are in apps/kernel/test/ads.db.test.ts, "retry and activation (W2-4b)"). The activation is the one place
// that starts spend, so the code that can do it is a short list: the activation job is given a frozen view of the platform with `activate` and `readStatus` and nothing else,
// built apart from the launch writers; the status ACTIVE is sent from one file; the writers' `setStatus` still takes `paused` and `archived` only; the job calls the platform
// only after the begin command that re-checked the stop conditions, the plan and the caps, and for the object that command named; and the queue, the worker block and the relay
// that feed it are the ones this slice adds. They read the sources, so a second caller of an activation, a view that gets another call, or a worker block that reaches the
// writers fails here before it reaches review. Keep this directory self-contained.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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
const naming = (text: string) => ALL.filter((path) => read(path).includes(text)).sort();
// Code only: the lines that are not comments.
const code = (path: string) => read(path).split('\n').filter((line) => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*')).join('\n');
const codeNaming = (pattern: RegExp) => ALL.filter((path) => pattern.test(code(path))).sort();

describe('what may start spend at the platform (#2296, W2-4b)', () => {
  it('sends the status ACTIVE from one file, and the writers\' setStatus still takes paused and archived only', () => {
    expect(codeNaming(/\bACTIVE\b/).filter((p) => p.startsWith('packages/ad-platform/') || p.startsWith('apps/') || p.startsWith('modules/'))).toEqual(['packages/ad-platform/src/meta-activate.ts']);
    const meta = code('packages/ad-platform/src/meta-write.ts');
    expect([...meta.matchAll(/'(PAUSED|ARCHIVED)'/g)].map((m) => m[1])).toEqual(['PAUSED', 'PAUSED', 'ARCHIVED']);
    // The writer's own type has no way to ask for more.
    expect(code('packages/ad-platform/src/writer.ts')).toMatch(/status: 'paused' \| 'archived'\): Promise<void>/);
    // The activation is not a method of the writer, and the writers' classes do not carry it.
    expect(code('packages/ad-platform/src/writer.ts')).not.toMatch(/\bactivate\w*\s*\(/i);
    expect(code('packages/ad-platform/src/meta-write.ts')).not.toMatch(/\bactivate\w*\s*\(/i);
    expect(code('packages/ad-platform/src/sandbox-write.ts')).not.toMatch(/\bactivate\w*\s*\(/i);
  });

  it('gives the activation job a frozen view of two calls, built apart from the launch writers, and the creating view cannot reach it', () => {
    const view = code('packages/ad-platform/src/activators.ts').replace(/^import .*$/gm, '');
    expect(view).toContain('return Object.freeze({');
    const named = new Set([...view.matchAll(/\bactivator\.(\w+)/g)].map((m) => m[1]));
    expect([...named].sort()).toEqual(['activate', 'readStatus']);
    expect(view).not.toMatch(/revokeToken|setStatus|fetch|create/);
    // Only the platform package builds one, and the map of a deployment is built in one place, from the config.
    expect(naming('activatorOf(')).toEqual(['packages/ad-platform/src/activators.ts', 'packages/ad-platform/src/launch-writers.ts']);
    expect(naming('adActivators(')).toEqual(['apps/kernel/src/kernel.ts', 'packages/ad-platform/src/launch-writers.ts']);
    expect(naming('new MetaAdActivator(')).toEqual(['packages/ad-platform/src/launch-writers.ts']);
    expect(naming('new SandboxAdActivator(')).toEqual(['packages/ad-platform/src/launch-writers.ts']);
    expect(code('apps/kernel/src/kernel.ts')).toMatch(/adActivators: adActivatorsOf\(config\)/);
    // The Meta view is built only where the live switch is on, the same switch as its writer, which a public deployment refuses.
    expect(code('apps/kernel/src/kernel.ts')).toMatch(/export function adActivatorsOf[\s\S]*config\.ADS_LIVE_LAUNCH === 'true' && config\.CHANNEL_META_ADS_WRITE_APP_SECRET/);
    // The launch job and the pause job are not given it, and the activation job is not given their views.
    for (const path of ['apps/kernel/src/ads-launch.ts', 'apps/kernel/src/ads-pause.ts', 'apps/kernel/src/ads-pause-run.ts', 'apps/kernel/src/ads-revoke.ts']) {
      expect(code(path), path).not.toMatch(/adActivators|AdActivator|runAdsActivate/);
    }
    const job = code('apps/kernel/src/ads-activate.ts');
    expect(job).not.toMatch(/LaunchWriter|AdPauser|AdRevoker|\.setStatus\(|createCampaign|createAdSet|createCreative|createAd\(|revokeToken|findByTag/);
  });

  it('calls the platform to switch on only after the begin command that re-checked everything, for the object that command named, and opens the token once', () => {
    const job = code('apps/kernel/src/ads-activate.ts');
    // One call site of the switch, in the one function that runs a begun step, after the loop's begin; the object is the one begin handed out.
    expect(naming('.activate(').filter((p) => p.startsWith('apps/') || p.startsWith('modules/'))).toEqual(['apps/kernel/src/ads-activate.ts']);
    expect(job.match(/activator\.activate\(/g)).toHaveLength(1);
    expect(job).toContain("'ads.activate.begin'");
    expect(job).toContain('const target = { level: work.level, id: work.objectId };');
    // The step runs only for work begin returned: the loop returns on `none` and passes the work to the step.
    expect(job).toMatch(/if \(work\.action === 'none'\) return[^\n]*\n[\s\S]*runStep\(deps, job, activator, work\)/);
    // The token: opened once, with the broker, from the credential query that refuses a connection that is not active or whose connector may not use it.
    expect(job.match(/broker\.open\(/g)).toHaveLength(1);
    expect(job).toContain("'kernel.channel.credential'");
    for (const line of job.split('\n').filter((l) => /console\.(log|warn|error|info|debug)/.test(l))) expect(line, line).not.toMatch(/secret|envelope|token|sealed/i);
    expect(job).not.toMatch(/execute[^;]*\bsecret\b/);
    // The commands: begin is the system's and declared external (it writes the pause event and decides the call), record is the system's R1; the retry is an owner's or an admin's.
    const commands = code('modules/ads/src/launch-activate.ts');
    expect(commands).toMatch(/name: 'ads\.activate\.begin',[\s\S]*?risk: 'R2',\s*sideEffect: 'external',\s*access: 'system'/);
    expect(commands).toMatch(/name: 'ads\.activate\.record',[\s\S]*?risk: 'R1',\s*sideEffect: 'internal',\s*access: 'system'/);
    expect(commands).toMatch(/name: 'ads\.launch\.retry',[\s\S]*?risk: 'R2',\s*sideEffect: 'external',\s*access: MANAGERS/);
    // Begin re-checks, before the ledger row of a call is made, the stop conditions, the plan, the flight and the caps, and only the launch's own recorded objects are named.
    const begin = commands.slice(commands.indexOf("name: 'ads.activate.begin'"), commands.indexOf("name: 'ads.activate.record'"));
    const order = ['stopConditionOf(', 'planHash(', 'todayIn(', 'launchCapsProblems(', ".from('crove_ads.ad_object')".replace('.from', '.selectFrom'), "insertInto('crove_kernel.external_call')"];
    let at = -1;
    for (const part of order) {
      const next = begin.indexOf(part);
      expect(next, part).toBeGreaterThan(at);
      at = next;
    }
    expect(begin).toContain('lockedSetting(ctx)');
    expect(begin).not.toMatch(/findByTag|slotOfName|tag\b.*objectId/);
  });
});

describe('what feeds the activation (#2296, W2-4b)', () => {
  it('names the queue in the schema, the worker and the migration only, with the egress of the ad platform and nothing else', () => {
    expect(naming('QUEUES.adsActivate')).toEqual(['apps/kernel/src/jobs-schema.ts', 'apps/kernel/src/worker.ts']);
    expect(code('apps/kernel/src/jobs-schema.ts')).toMatch(/\[QUEUES\.adsActivate\]: \['provider:ad_platform'\]/);
    const migration = readdirSync(join(ROOT, 'supabase/migrations')).find((f) => f.endsWith('_crove_ads_launch_activation.sql'));
    expect(migration).toBeDefined();
    expect(read(`supabase/migrations/${migration}`)).toContain("crove_jobs.create_queue('ads-activate'");
    // The worker block reads the activators and the broker alone, never the writers, the pausers or the revokers.
    const worker = read('apps/kernel/src/worker.ts');
    const start = worker.indexOf('boss.work<AdsActivateJob | { sweep: true }>(QUEUES.adsActivate');
    const end = worker.indexOf('boss.schedule(QUEUES.adsActivate');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = worker.slice(start, end);
    expect(block).not.toMatch(/adWriters|adPausers|adRevokers|adPlatforms/);
    expect(block).not.toMatch(/deps\.channels(?!\?\.adActivators)/);
    // The relay sends it with ids only, for the one event the launch job writes when the objects are created.
    const relay = code('apps/kernel/src/worker.ts');
    expect(relay).toMatch(/row\.type === 'ads\.activate\.queued'/);
    expect(relay).toMatch(/boss\.send\(QUEUES\.adsActivate, \{ orgId: row\.org_id, launchId \} satisfies AdsActivateJob/);
  });

  it('writes the event that queues the activation from the launch job\'s begin (declared external) and nowhere a person or a record can', () => {
    const writers = codeNaming(/ctx\.emit\('ads\.activate\.queued'/);
    expect(writers).toEqual(['modules/ads/src/launch-run.ts']);
    const run = code('modules/ads/src/launch-run.ts');
    const begin = run.slice(run.indexOf("name: 'ads.launch.begin'"), run.indexOf("name: 'ads.launch.record'"));
    expect(begin).toContain("ctx.emit('ads.activate.queued'");
    expect(begin).toMatch(/risk: 'R2',\s*sideEffect: 'external'/);
    // The sweep that writes it again is the worker's definer, in the migration only.
    expect(naming("'ads.activate.queued'").filter((p) => p.endsWith('.sql'))).toEqual([]);
    const migration = readdirSync(join(ROOT, 'supabase/migrations')).find((f) => f.endsWith('_crove_ads_launch_activation.sql')) as string;
    expect(read(`supabase/migrations/${migration}`)).toContain("'ads.activate.queued'");
  });

  it('keeps ACTIVE, the activation calls and the status record out of the files the W2-3 pins name, and what Ludy set a record nothing here reads', () => {
    for (const path of ['packages/ad-platform/src/meta-write.ts', 'packages/ad-platform/src/sandbox-write.ts', 'packages/ad-platform/src/launch-writers.ts', 'apps/kernel/src/ads-launch.ts', 'modules/ads/src/launch-run.ts', 'modules/ads/src/launch-steps.ts']) {
      expect(code(path), path).not.toMatch(/\bACTIVE\b/);
    }
    for (const path of ['apps/kernel/src/ads-activate.ts', 'modules/ads/src/launch-activate.ts', 'modules/ads/src/launch-activation.ts']) {
      expect(code(path), path).not.toMatch(/configured_?status|configuredStatus/);
    }
  });
});
