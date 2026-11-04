// SPDX-License-Identifier: AGPL-3.0-only
// The source pins of the stop and the pause (ADR-0043 points 4 and 7a, issue #2296, W2-4a; the database's own pins are in ads-launch-stop.db.test.ts): the pause job is
// given a frozen view of the platform's writer with one call that finds what a launch made by its tag and sets it PAUSED, and nothing else; nothing in the pause path can
// activate, create, archive, verify or revoke; the only caller of that call is the one shared step the pause job and the revoke sweep both make; every command that stops
// a launch writes the event the pause job is fed by; and the queue, its schedule and the definers of the wind-down are named where they should be and nowhere else. They read
// the sources, so a new caller of a status change, a pause path that learns to un-pause, or a stop that forgets the event fails here before it reaches review. Keep this
// directory self-contained.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SKIP = new Set(['node_modules', 'dist', 'test', 'tests', '.git', '.turbo', 'coverage']);

// The TypeScript sources of the apps, packages and modules (not their tests), as paths from the repository root.
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
const count = (text: string, part: string) => text.split(part).length - 1;

describe('what the pause job may reach of the platform\'s writer (#2296, W2-4a)', () => {
  it('is given the narrowed pause view: one frozen method, built from two calls of a writer, setting no status but paused', () => {
    const view = code('packages/ad-platform/src/pausers.ts').replace(/^import .*$/gm, '');
    expect(view).toContain('return Object.freeze({ pauseLaunch:');
    const named = new Set([...view.matchAll(/\bwriter\.(\w+)/g)].map((m) => m[1]));
    expect([...named].sort()).toEqual(['findByTag', 'setStatus']);
    // The only status it names is paused, and nothing in it can create, activate, archive, verify, revoke or reach the network.
    expect([...view.matchAll(/'paused'|'archived'|'active'|\bACTIVE\b|\bPAUSED\b|\bARCHIVED\b/g)].map((m) => m[0])).toEqual(["'paused'"]);
    expect(view).not.toMatch(/\b(activate|unpause|resume|archive)\w*\s*\(|revokeToken|verify\(|create\w+\(|\bfetch\b|\bhttps?:\/\//i);
    // The view is built in one place, and the map of a deployment in one other, next to the launch writers.
    expect(naming('pauserOf(')).toEqual(['packages/ad-platform/src/launch-writers.ts', 'packages/ad-platform/src/pausers.ts', 'packages/ad-platform/src/revokers.ts']);
    expect(naming('adPausers(')).toEqual(['apps/kernel/src/kernel.ts', 'packages/ad-platform/src/launch-writers.ts']);
    expect(code('apps/kernel/src/kernel.ts')).toMatch(/adPausers: adPausersOf\(config\)/);
  });

  it('has one caller of the pause outside the package, the shared step, and no caller of a status change anywhere outside the package', () => {
    expect(naming('.pauseLaunch(').filter((p) => !p.startsWith('packages/ad-platform/'))).toEqual(['apps/kernel/src/ads-pause-run.ts']);
    expect(naming('.setStatus(').filter((p) => !p.startsWith('packages/ad-platform/'))).toEqual([]);
    // The two jobs that make the step: the pause job (the live connection's token) and the revoke sweep (the sealed copy), and nothing else.
    expect(naming('pauseWork(')).toEqual(['apps/kernel/src/ads-pause-run.ts', 'apps/kernel/src/ads-pause.ts', 'apps/kernel/src/ads-revoke.ts']);
    // The shared step hands the secret to the narrowed pauser and nothing else: no log, no error text, no command.
    const step = code('apps/kernel/src/ads-pause-run.ts');
    expect(step).not.toMatch(/console\./);
    expect(step).not.toMatch(/runtime\.|\.execute\(|\.query\(/);
    expect(step).not.toMatch(/error\.message|String\(error\)/);
    expect([...step.matchAll(/@crove\/ad-platform'/g)]).toHaveLength(1);
  });

  it('gives the pause job the narrowed pausers and the broker alone, opens the token once from the connection and never touches a platform call but the pause', () => {
    const job = code('apps/kernel/src/ads-pause.ts');
    expect(job.match(/\.open\(/g)).toHaveLength(1);
    expect(job).toContain("'kernel.channel.credential'");
    expect(job).not.toMatch(/\.(verify|accounts|read\w*|create\w*|setStatus|findByTag|resolveTargeting|revokeToken)\(/);
    expect(job).not.toMatch(/\b(ACTIVE|PAUSED|ARCHIVED)\b|\b(activate|unpause|resume)\w*\s*\(/i);
    const imports = [...read('apps/kernel/src/ads-pause.ts').matchAll(/import (?:type )?\{([^}]*)\} from '@crove\/ad-platform'/g)].flatMap((m) => (m[1] ?? '').split(',').map((s) => s.replace(/\btype\b/, '').trim()));
    expect(imports.sort()).toEqual(['AdPauser']);
    // Nothing it logs or records carries the secret.
    for (const line of read('apps/kernel/src/ads-pause.ts').split('\n').filter((l) => /console\.(log|warn|error|info|debug)/.test(l))) expect(line, line).not.toMatch(/secret|envelope|token|sealed/i);
    const worker = read('apps/kernel/src/worker.ts');
    const start = worker.indexOf('boss.work<AdsPauseJob | { sweep: true }>(QUEUES.adsPause');
    const end = worker.indexOf('boss.schedule(QUEUES.adsPause');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = worker.slice(start, end);
    expect([...block.matchAll(/deps\.channels\??\.(\w+)/g)].map((m) => m[1]).sort()).toEqual([]);
    expect(block).toContain('pausers: adPausers');
    expect(block).not.toMatch(/deps\.channels(?!\??\.)/);
    expect(block).not.toMatch(/\badWriters\b|\badRevokers\b|\badPlatforms\b/);
  });

  it('keeps the module free of the platform and of any status that could un-pause', () => {
    for (const path of ['modules/ads/src/launch-pause.ts', 'modules/ads/src/launch-pause-policy.ts']) {
      const file = code(path);
      expect(file, path).not.toMatch(/@crove\/ad-platform|\bfetch\b|\bhttps?:\/\//);
      expect(file, path).not.toMatch(/\b(ACTIVE|PAUSED|ARCHIVED)\b|\b(activate|unpause|resume)\w*\s*\(/i);
    }
    // The pause commands are the system's alone, and the stop is a person's and only stops.
    const commands = code('modules/ads/src/launch-pause.ts');
    expect(commands).toMatch(/name: 'ads\.pause\.begin'[\s\S]*?access: 'system'/);
    expect(commands).toMatch(/name: 'ads\.pause\.record'[\s\S]*?access: 'system'/);
    expect(commands).toMatch(/name: 'ads\.launch\.stop'[\s\S]*?risk: 'R2'[\s\S]*?sideEffect: 'external'/);
  });
});

describe('what stops a launch, and what is fed by it (#2296, W2-4a)', () => {
  it('has every command that stops started launches write the event of the pause, once for each', () => {
    const callers = naming('stopStartedLaunches(').filter((p) => p !== 'modules/ads/src/launch-ledger.ts');
    expect(callers).toEqual(['modules/ads/src/launch-pause.ts', 'modules/ads/src/write-connection.ts', 'modules/ads/src/write.ts']);
    for (const path of callers) {
      const file = code(path);
      const stops = count(file, 'await stopStartedLaunches(');
      // One loop that writes the event for each launch stopped, with the event named as a literal (the job-egress invariant reads the names from the source).
      expect(count(file, "ctx.emit('ads.pause.queued'"), path).toBe(stops);
    }
    // The job's own stop of a launch a condition stopped while it ran writes it too.
    expect(code('modules/ads/src/launch-run.ts')).toContain("ctx.emit('ads.pause.queued'");
    // And the one event is sent to the queue by the relay alone, with ids only.
    const worker = code('apps/kernel/src/worker.ts');
    expect(worker).toMatch(/row\.type === 'ads\.pause\.queued'/);
    expect(worker).toMatch(/boss\.send\(QUEUES\.adsPause, \{ orgId: row\.org_id, launchId \} satisfies AdsPauseJob/);
  });

  it('names the queue in the schema, the worker and the migration only, with the egress of the ad platform and nothing else, and the definers where they are used', () => {
    expect(naming('QUEUES.adsPause')).toEqual(['apps/kernel/src/jobs-schema.ts', 'apps/kernel/src/worker.ts']);
    expect(code('apps/kernel/src/jobs-schema.ts')).toMatch(/\[QUEUES\.adsPause\]: \['provider:ad_platform'\]/);
    const migration = readdirSync(join(ROOT, 'supabase/migrations')).find((f) => f.endsWith('_crove_ads_launch_pause.sql'));
    expect(migration).toBeDefined();
    expect(read(`supabase/migrations/${migration}`)).toContain("crove_jobs.create_queue('ads-pause'");
    // The claim and the settlement of a wind-down are called by the commands of the pause only, and the safety net by the worker's sweep only.
    expect(naming('wind_down_take')).toEqual(['modules/ads/src/launch-pause.ts']);
    expect(naming('wind_down_settle')).toEqual(['modules/ads/src/launch-pause.ts']);
    expect(naming('wind_down_requeue')).toEqual(['apps/kernel/src/worker.ts']);
    // The sweep is a schedule with no data, never retried by the queue.
    expect(code('apps/kernel/src/worker.ts')).toMatch(/boss\.schedule\(QUEUES\.adsPause, ADS_PAUSE_SWEEP_CRON, \{ sweep: true \}, \{[^}]*retryLimit: 0/);
  });
});
