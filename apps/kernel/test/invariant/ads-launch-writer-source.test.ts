// SPDX-License-Identifier: AGPL-3.0-only
// The source pins of the launch writer (ADR-0043 points 2 to 5, issue #2296, W2-3; the database's own pins are in ads-launch-writer.db.test.ts): the launch job is
// given a frozen view of the platform's writer with the calls of a launch and nothing else; no source in the app, the modules or the kernel can change an object's
// status at the platform (nothing un-pauses at this slice); the column that records what Ludy set (`ad_object.configured_status`) is a record and is never read by
// the job or by anything that decides a platform call; the token reaches one call in one file and never a log, an error or a command; and the switch that lets
// the worker reach Meta is off by default and refused on a public deployment. They read the sources, so a new caller of a status change, a job that reads the
// record, or a log line with the token fails here before it reaches review. Keep this directory self-contained.
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

describe('what the launch job may reach of the platform\'s writer (#2296, W2-3)', () => {
  it('is given the narrowed launch view, built by one function from a writer, and nothing of the writer', () => {
    // The code of the file, without its imports (which name the file `writer.ts`).
    const view = code('packages/ad-platform/src/launch-writers.ts').replace(/^import .*$/gm, '');
    // The view is a frozen object of closures, and the only members it names of a writer are the calls of a launch.
    expect(view).toContain('return Object.freeze({');
    const named = new Set([...view.matchAll(/\bwriter\.(\w+)/g)].map((m) => m[1]));
    expect([...named].sort()).toEqual(['capabilities', 'createAd', 'createAdSet', 'createCampaign', 'createCreative', 'findByTag', 'resolveTargeting', 'verify']);
    expect(view).not.toMatch(/revokeToken|setStatus|fetch/);
    // The worker's deps carry the view's type, built from the config in the kernel, and the job's handler reads the field and the broker alone.
    expect(code('apps/kernel/src/kernel.ts')).toMatch(/adWriters: adWritersOf\(config\)/);
    const worker = read('apps/kernel/src/worker.ts');
    const start = worker.indexOf('boss.work<AdsLaunchJob | { sweep: true }>(QUEUES.adsLaunch');
    const end = worker.indexOf('boss.schedule(QUEUES.adsLaunch');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = worker.slice(start, end);
    expect(block).not.toMatch(/deps\.channels(?!\??\.)/);
    expect(block).not.toMatch(/\bchannels\b(?!\??\.)/);
    // The whole writer is built in one place and the launch view in one other.
    expect(naming('launchWriterOf(')).toEqual(['packages/ad-platform/src/launch-writers.ts']);
    expect(naming('adLaunchWriters(')).toEqual(['apps/kernel/src/kernel.ts', 'packages/ad-platform/src/launch-writers.ts']);
    expect(naming('new MetaAdWriter(')).toEqual(['packages/ad-platform/src/launch-writers.ts', 'packages/ad-platform/src/revokers.ts']);
  });

  it('names the queue in the schema, the worker and the migration only, with the egress of the ad platform and nothing else', () => {
    expect(naming('QUEUES.adsLaunch')).toEqual(['apps/kernel/src/jobs-schema.ts', 'apps/kernel/src/worker.ts']);
    expect(code('apps/kernel/src/jobs-schema.ts')).toMatch(/\[QUEUES\.adsLaunch\]: \['provider:ad_platform'\]/);
    expect(read('supabase/migrations/20261122110000_crove_ads_launch_writer.sql')).toContain("crove_jobs.create_queue('ads-launch'");
    // The job is sent by the relay with ids only (the org and the launch), for the one event the approval writes.
    const worker = code('apps/kernel/src/worker.ts');
    expect(worker).toMatch(/row\.type === 'ads\.launch\.queued'/);
    expect(worker).toMatch(/boss\.send\(QUEUES\.adsLaunch, \{ orgId: row\.org_id, launchId \} satisfies AdsLaunchJob/);
  });
});

describe('nothing un-pauses at this slice (#2296, W2-3)', () => {
  it('has no caller of a status change anywhere outside the platform package, and the package\'s writers name no status but paused and archived', () => {
    // `setStatus(` is called by no source of the app, the modules or the kernel (a later slice adds the one with its own approval and stop path).
    expect(naming('.setStatus(').filter((p) => !p.startsWith('packages/ad-platform/'))).toEqual([]);
    for (const path of ['packages/ad-platform/src/meta-write.ts', 'packages/ad-platform/src/sandbox-write.ts', 'packages/ad-platform/src/launch-writers.ts', 'apps/kernel/src/ads-launch.ts', 'modules/ads/src/launch-run.ts', 'modules/ads/src/launch-steps.ts']) {
      const file = code(path);
      expect(file, path).not.toMatch(/\bACTIVE\b/);
      expect(file, path).not.toMatch(/\b(activate|unpause|resume)\w*\s*\(/i);
    }
    // What touches the platform names no `active` status either (the commands read the status of a channel connection, which is a different word for a different thing).
    for (const path of ['packages/ad-platform/src/meta-write.ts', 'packages/ad-platform/src/sandbox-write.ts', 'packages/ad-platform/src/launch-writers.ts', 'apps/kernel/src/ads-launch.ts']) {
      expect(code(path), path).not.toMatch(/['"`]active['"`]/);
    }
    // Every create of the Meta writer goes through the one call site that sets the status last.
    const meta = code('packages/ad-platform/src/meta-write.ts');
    expect(meta).toContain("{ ...fields, status: 'PAUSED' }");
    expect([...meta.matchAll(/'(PAUSED|ARCHIVED)'/g)].map((m) => m[1])).toEqual(['PAUSED', 'PAUSED', 'ARCHIVED']);
  });

  it('keeps what Ludy set (ad_object.configured_status) a record: no job and no command reads it to decide a platform call, and nothing but the database writes it', () => {
    // Which sources name the column: the manifest that classifies it, the generated and refined types, and nothing that decides a call.
    expect(naming('configured_status')).toEqual(['modules/ads/src/manifest.ts', 'packages/db/src/generated/database.ts', 'packages/db/src/schema.ts']);
    for (const path of ['apps/kernel/src/ads-launch.ts', 'modules/ads/src/launch-run.ts', 'modules/ads/src/launch-steps.ts', 'packages/ad-platform/src/launch-writers.ts', 'packages/ad-platform/src/meta-write.ts']) {
      expect(code(path), path).not.toMatch(/configured_?status|configuredStatus/);
    }
    // The job's one read of the objects is the slots and the platform's ids (which step is next, what the next create needs), never a status.
    expect(code('modules/ads/src/launch-run.ts')).toContain(".select(['slot', 'external_id'])");
  });
});

describe('what the job does with the token (#2296, W2-3)', () => {
  it('opens it once per step, with the broker, in the one file, and passes it to the narrowed view\'s calls and nothing else', () => {
    expect(naming('.open(').filter((p) => p === 'apps/kernel/src/ads-launch.ts')).toEqual(['apps/kernel/src/ads-launch.ts']);
    const file = code('apps/kernel/src/ads-launch.ts');
    expect(file.match(/broker\.open\(/g)).toHaveLength(1);
    // The secret goes to the writer's calls only: never into a command's input, a log line or an error.
    for (const line of file.split('\n').filter((l) => /console\.(log|warn|error|info|debug)/.test(l))) expect(line, line).not.toMatch(/secret|envelope|token|sealed/i);
    expect(file).not.toMatch(/execute[^;]*\bsecret\b/);
    expect(file).not.toMatch(/new (Error|AdPlatformError)\([^)]*secret/);
    // It reads the credential through the kernel's query (which refuses a connection that is not active or whose connector may not use it), not the database.
    expect(file).toContain("'kernel.channel.credential'");
    expect(file).not.toMatch(/token_seal|credential_get|FROM crove_kernel\.credential/);
  });
});

describe('the switch that lets the worker reach Meta (#2296, W2-3)', () => {
  it('is off by default, builds Meta\'s writer only when it is on, and is refused on a public deployment', () => {
    const config = code('apps/kernel/src/config.ts');
    expect(config).toMatch(/ADS_LIVE_LAUNCH: z\.enum\(\['true', 'false'\]\)\.default\('false'\)/);
    expect(config).toMatch(/config\.ADS_LIVE_LAUNCH === 'true'\) \{\s*throw new Error/);
    expect(code('apps/kernel/src/kernel.ts')).toMatch(/config\.ADS_LIVE_LAUNCH === 'true' && config\.CHANNEL_META_ADS_WRITE_APP_SECRET/);
    // The compose file does not turn it on.
    expect(read('docker-compose.yml')).not.toMatch(/ADS_LIVE_LAUNCH:\s*['"]?true/);
  });
});
