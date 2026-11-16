// SPDX-License-Identifier: AGPL-3.0-only
// The source pins of the read of the platform's object states (issue #3301, plan docs/plan/ads-write.md sections 4 and 9; the database's own pins are in apps/kernel/test/ads.db.test.ts,
// "the platform's object states"). What the platform says of an object is DISPLAY: the job that reads it holds a frozen view with one read call and nothing else, built apart from the
// writers, the pausers and the activators, and the command that records it writes the display columns of the launch's own objects and nothing of the launch, its commitment or the caps. They
// read the sources, so a second caller, a view that gets another call, or a command that reaches further fails here before it reaches review. Keep this directory self-contained.
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
// Code only: the lines that are not comments.
const code = (path: string) => read(path).split('\n').filter((line) => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*')).join('\n');
const codeNaming = (pattern: RegExp) => ALL.filter((path) => pattern.test(code(path))).sort();

describe('what may read the platform\'s object states (#3301)', () => {
  it('gives the state job a frozen view of one call, built apart from the writers, the pausers and the activators', () => {
    const view = code('packages/ad-platform/src/state-readers.ts').replace(/^import .*$/gm, '');
    expect(view).toContain('return Object.freeze({ readStates:');
    // The one call the procedure makes at a platform: the read of one object.
    expect([...new Set([...view.matchAll(/\bsource\.(\w+)/g)].map((m) => m[1]))]).toEqual(['readState']);
    expect(view).not.toMatch(/revokeToken|setStatus|fetch|create|activate|pause/i);
    // Only the platform package builds one, and the map of a deployment is built in one place, from the config.
    expect(codeNaming(/\bstateReaderOf\(/)).toEqual(['packages/ad-platform/src/launch-writers.ts', 'packages/ad-platform/src/state-readers.ts']);
    expect(codeNaming(/\badStateReaders\(/)).toEqual(['apps/kernel/src/kernel.ts', 'packages/ad-platform/src/launch-writers.ts']);
    expect(codeNaming(/new MetaAdStateReader\(/)).toEqual(['packages/ad-platform/src/launch-writers.ts']);
    expect(codeNaming(/new SandboxAdStateReader\(/)).toEqual(['packages/ad-platform/src/launch-writers.ts']);
    expect(code('apps/kernel/src/kernel.ts')).toMatch(/adStateReaders: adStateReadersOf\(config\)/);
    // The Meta view is built only where the live switch is on, the same switch as its writer, which a public deployment refuses.
    expect(code('apps/kernel/src/kernel.ts')).toMatch(/export function adStateReadersOf[\s\S]*config\.ADS_LIVE_LAUNCH === 'true' && config\.CHANNEL_META_ADS_WRITE_APP_SECRET/);
    // The platform's read sends GET and nothing else, and it is the one place that names the review feedback fields.
    expect(code('packages/ad-platform/src/meta-state.ts')).not.toMatch(/'(POST|PUT|PATCH|DELETE)'/);
    expect(codeNaming(/review_feedback/).filter((p) => p.startsWith('packages/ad-platform/') || p.startsWith('modules/ads/'))).toEqual(['packages/ad-platform/src/meta-state.ts']);
  });

  it('keeps the other jobs away from it, and the state job away from everything that changes an object', () => {
    for (const path of ['apps/kernel/src/ads-launch.ts', 'apps/kernel/src/ads-pause.ts', 'apps/kernel/src/ads-pause-run.ts', 'apps/kernel/src/ads-revoke.ts', 'apps/kernel/src/ads-activate.ts']) {
      expect(code(path), path).not.toMatch(/adStateReaders|AdStateReader|runAdsStateSync/);
    }
    const job = code('apps/kernel/src/ads-state.ts');
    expect(job).not.toMatch(/LaunchWriter|AdPauser|AdRevoker|AdActivator|\.setStatus\(|\.activate\(|createCampaign|createAdSet|createCreative|createAd\(|revokeToken|findByTag/);
    // The platform is read only through the view, once for each launch, and the token is opened once, from the credential query that refuses a connection that is not active.
    expect(job.match(/reader\.readStates\(/g)).toHaveLength(1);
    expect(job.match(/broker\.open\(/g)).toHaveLength(1);
    expect(job).toContain("'kernel.channel.credential'");
    expect(job).toContain("'ads.object.sync_target'");
    expect(job).toContain("'ads.object.sync_state'");
    for (const line of job.split('\n').filter((l) => /console\.(log|warn|error|info|debug)/.test(l))) expect(line, line).not.toMatch(/secret|envelope|token|sealed/i);
    expect(job).not.toMatch(/execute[^;]*\bsecret\b/);
  });

  it('runs in the account\'s sync job only, after the figures, whatever came of them, with the view and the broker alone', () => {
    const worker = read('apps/kernel/src/worker.ts');
    const start = worker.indexOf('boss.work<AdsSyncJob | { sweep: true }>(QUEUES.adsSync');
    const end = worker.indexOf('boss.schedule(QUEUES.adsSync');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = worker.slice(start, end);
    expect(block).toMatch(/try \{[\s\S]*runAdsSync\([\s\S]*\} finally \{[\s\S]*runAdsStateSync\(/);
    expect(block).not.toMatch(/adWriters|adPausers|adRevokers|adActivators/);
    expect(codeNaming(/\brunAdsStateSync\(/)).toEqual(['apps/kernel/src/ads-state.ts', 'apps/kernel/src/worker.ts']);
  });

  it('records the platform\'s answer as display fields of the launch\'s own objects, as the system, and touches nothing of the launch or the caps', () => {
    const commands = code('modules/ads/src/object-state.ts');
    expect(commands).toMatch(/name: 'ads\.object\.sync_state',[\s\S]*?risk: 'R1',\s*sideEffect: 'internal',\s*access: 'system'/);
    expect(commands).toMatch(/name: 'ads\.object\.sync_target',[\s\S]*?access: 'system'/);
    expect(commands).toContain('requireSystem(ctx)');
    // The only table it updates is the object's, and only these columns; the launch, the caps and the ledger of commitments are never named for a write.
    const updates = [...commands.matchAll(/updateTable\('([^']+)'\)/g)].map((m) => m[1]);
    expect(updates).toEqual(['crove_ads.ad_object', 'crove_kernel.external_call']);
    expect(commands).toMatch(/updateTable\('crove_ads\.ad_object'\)\s*\.set\(\{ effective_status: status, review_reason: reason, last_seen_at: ctx\.now, updated_at: ctx\.now \}\)/);
    expect(commands).not.toMatch(/insertInto\('crove_ads\.|deleteFrom\(|ctx\.emit\(|stopRunningLaunch|setLaunch|needAttention|launchCapsProblems/);
    // An answer is matched to a recorded object by the platform's id and level; nothing is created from it.
    expect(commands).toContain('rowOf.get(');
    expect(commands).not.toMatch(/insertInto\('crove_ads\.ad_object'\)/);
  });
});
