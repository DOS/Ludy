// SPDX-License-Identifier: AGPL-3.0-only
// The source pins of the sealed copy of a closed ads connection's token (ADR-0043 point 4, issue #2296, W2-1; the database's own pins are in
// ads-token-seal.db.test.ts): one file opens the copy, and through one call; nothing else names the table; the revoker the worker is given has the one
// method; no job carries data; nothing in the file that handles the secret logs it. They read the sources, so a new reader of the copy, a second call
// made with the token, or a job that carries an id fails here before it reaches review. Keep this directory self-contained.
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

describe('what may open or name the sealed copy of a closed ads connection token (#2296)', () => {
  it('has one file that opens the copy, through the worker-only definer', () => {
    expect(naming('token_seal_get')).toEqual(['apps/kernel/src/ads-revoke.ts']);
  });

  it('has no source that names the sealed copy table but the module manifest that lists its columns', () => {
    expect(naming('ad_token_seal')).toEqual(['modules/ads/src/manifest.ts']);
  });

  it('opens the copy once per try, with the broker, and hands the secret to the revoker and nothing else', () => {
    const file = code('apps/kernel/src/ads-revoke.ts');
    expect(file.match(/\.open\(/g)).toHaveLength(1);
    expect(file.match(/\.revokeToken\(/g)).toHaveLength(1);
    // No other call with the token: not the reader's, not a verify, not a write.
    expect(file).not.toMatch(/\.(verify|accounts|read\w*|create\w*|setStatus|findByTag|resolveTargeting)\(/);
    // It asks the database for the copy through the definer and not through a command: the envelope reaches no command, query or audit row.
    expect(file).not.toContain('kernel.channel.credential');
    expect(file).not.toMatch(/runtime\.(execute|query)[^;]*envelope/);
    // The platform adapters it is built on are the revoke view and the typed error, never a writer.
    const imports = [...read('apps/kernel/src/ads-revoke.ts').matchAll(/import \{([^}]*)\} from '@crove\/ad-platform'/g)].flatMap((m) => (m[1] ?? '').split(',').map((s) => s.replace(/\btype\b/, '').trim()));
    expect(imports.sort()).toEqual(['AdPlatformError', 'AdRevoker']);
  });

  it('never logs, returns or records the secret: the file that opens it writes only codes and counts', () => {
    const file = code('apps/kernel/src/ads-revoke.ts');
    for (const line of file.split('\n').filter((l) => /console\.(log|warn|error|info|debug)/.test(l))) {
      expect(line, line).not.toMatch(/secret|envelope|token|sealed/i);
    }
    // The outcome that is recorded is built from the platform's kind, its code and its retry time.
    expect(file).not.toMatch(/outcome[^;\n]*secret/);
  });

  it('gives the worker the narrowed revoke view and nothing of the writer', () => {
    const worker = code('apps/kernel/src/worker.ts');
    const call = worker.match(/runAdsRevoke\(\{[\s\S]*?\}\)/)?.[0] ?? '';
    expect(call).toContain('revokers: deps.channels?.adRevokers');
    expect(call).not.toMatch(/adPlatforms|adWriters|writer/);
    const kernel = code('apps/kernel/src/kernel.ts');
    expect(kernel).toMatch(/adRevokers: adRevokersOf\(config\)/);
    // The view is built by the revokers module, from a writer, through a closure with the one method.
    expect(code('packages/ad-platform/src/revokers.ts')).toContain('revokeToken: (secret: string) => writer.revokeToken(secret)');
    // The one place a token is handed to a writer's revoke is the narrowed view's closure and the sweep's call of it.
    expect(naming('.revokeToken(').filter((p) => !p.startsWith('packages/ad-platform/'))).toEqual(['apps/kernel/src/ads-revoke.ts']);
  });

  it('has no source that drops a credential but the kernel commands that close a connection, and every close in the HTTP edge goes through the command', () => {
    // Every drop of a credential in code is one of the three commands of the channel layer (disconnect, the platform's deletion, the system's close of a
    // member who left); the database's trigger holds the copy whatever else deletes (an operator's statement, a cascade).
    expect(naming('crove_kernel.credential_drop')).toEqual(['packages/kernel/src/channels.ts']);
    const drops = [...code('packages/kernel/src/channels.ts').matchAll(/crove_kernel\.credential_drop\(/g)].length;
    expect(drops).toBe(3);
    // The rollbacks of a refused link in the API (a connection that was made and could not be attached) close it with the same command, not with SQL.
    const rpc = code('apps/kernel/src/rpc.ts');
    expect([...rpc.matchAll(/runtime\.execute\('kernel\.channel\.disconnect'/g)].length).toBeGreaterThanOrEqual(4);
    expect(rpc).not.toMatch(/credential_drop|DELETE FROM crove_kernel\.credential/);
  });

  it('carries no data in the job: a sweep on a schedule, never retried by the queue, and no job of that queue is sent with data', () => {
    const worker = code('apps/kernel/src/worker.ts');
    expect(worker).toMatch(/boss\.schedule\(QUEUES\.adsRevoke, ADS_REVOKE_CRON, null, \{[^}]*retryLimit: 0/);
    expect(naming('QUEUES.adsRevoke')).toEqual(['apps/kernel/src/jobs-schema.ts', 'apps/kernel/src/worker.ts']);
    expect(worker).not.toMatch(/boss\.send\(QUEUES\.adsRevoke/);
    expect(read('supabase/migrations/20261121250000_crove_ads_token_revoke.sql')).toContain("crove_jobs.create_queue('ads-revoke'");
    // The job's egress is the ad platform's and nothing else.
    expect(code('apps/kernel/src/jobs-schema.ts')).toMatch(/\[QUEUES\.adsRevoke\]: \['provider:ad_platform'\]/);
  });

  it('gives the revoke job no other field of the worker deps than the narrowed revokers and the credential broker', () => {
    const worker = read('apps/kernel/src/worker.ts');
    const start = worker.indexOf('boss.work(QUEUES.adsRevoke');
    const end = worker.indexOf('boss.schedule(QUEUES.adsRevoke');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = worker.slice(start, end);
    const channelFields = [...block.matchAll(/deps\.channels\??\.(\w+)/g)].map((m) => m[1]).sort();
    expect(channelFields).toEqual(['adRevokers', 'broker']);
    // And no whole `deps.channels` or `channels` object is handed to it.
    expect(block).not.toMatch(/deps\.channels(?!\??\.)/);
    expect(block).not.toMatch(/\bchannels\b(?!\??\.)/);
  });

  it('runs the age sweep apart from the revoke job: a sweep with no egress calls the definer too, and the claim and the check of a shared grant are the job’s alone', () => {
    expect(naming('token_revoke_expire')).toEqual(['apps/kernel/src/ads-revoke.ts', 'apps/kernel/src/worker.ts']);
    expect(naming('token_grant_shared')).toEqual(['apps/kernel/src/ads-revoke.ts']);
    expect(naming('token_revoke_due')).toEqual(['apps/kernel/src/ads-revoke.ts']);
    // The sweep that has no egress is the agent sweep (queue egress none): the age sweep is in its handler, not in the job that reaches the platform.
    const worker = read('apps/kernel/src/worker.ts');
    const sweep = worker.slice(worker.indexOf('boss.work(QUEUES.agentSweep'), worker.indexOf('boss.schedule(QUEUES.agentSweep'));
    expect(sweep).toContain('crove_ads.token_revoke_expire()');
    expect(code('apps/kernel/src/jobs-schema.ts')).toMatch(/\[QUEUES\.agentSweep\]: 'none'/);
  });
});
