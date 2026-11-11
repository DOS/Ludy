// SPDX-License-Identifier: AGPL-3.0-only
// tools/deploy/compose.pilot.yml (issue #2118) against the real docker-compose.yml, read by `docker compose config`: the
// pilot layout runs api and worker apart, drops the worker's database login from the API, and keeps the all-in-one
// service behind a profile. docker-compose.yml alone must stay what `docker compose up` runs on a laptop.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertSplitRoles, loadConfig } from '../../apps/kernel/src/config.ts';

const repo = resolve(import.meta.dirname, '../..');
// `!reset` and `!override` need compose v2.24; a runner without docker compose skips the file, as deploy.test.ts does.
const version = spawnSync('docker', ['compose', 'version', '--short'], { encoding: 'utf8' });
const [major = 0, minor = 0] = (version.status === 0 ? version.stdout.trim().replace(/^v/, '') : '0.0').split('.').map(Number);
const hasCompose = version.status === 0 && (major > 2 || (major === 2 && minor >= 24));

interface Service {
  image?: string;
  command?: string[];
  profiles?: string[];
  ports?: unknown[];
  networks?: Record<string, unknown>;
  environment?: Record<string, string | null>;
  volumes?: Array<{ target?: string; read_only?: boolean }>;
  healthcheck?: { disable?: boolean };
}

let dir: string;

function config(files: string[], env: Record<string, string> = {}, profiles: string[] = []): Record<string, Service> {
  const args = ['compose', ...files.flatMap((f) => ['-f', f]), ...profiles.flatMap((p) => ['--profile', p]), 'config', '--format', 'json'];
  const res = spawnSync('docker', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, COMPOSE_FILE: '', COMPOSE_PROFILES: '', ...env } });
  expect(res.status, res.stderr).toBe(0);
  return (JSON.parse(res.stdout) as { services: Record<string, Service> }).services;
}

describe.skipIf(!hasCompose)('compose.pilot.yml', { timeout: 60_000 }, () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'crove-pilot-compose-'));
    copyFileSync(join(repo, 'docker-compose.yml'), join(dir, 'docker-compose.yml'));
    copyFileSync(join(repo, 'tools/deploy/compose.pilot.yml'), join(dir, 'compose.pilot.yml'));
    // The release pins the images in a generated override, as deploy.sh writes it.
    writeFileSync(join(dir, 'docker-compose.override.yml'), [
        'services:',
        "  crove: { image: 'registry.example/ludy@sha256:aa', build: !reset null }",
        "  api: { image: 'registry.example/ludy@sha256:aa', build: !reset null }",
        "  worker: { image: 'registry.example/ludy@sha256:aa', build: !reset null }",
        "  crove-media: { image: 'registry.example/ludy-media@sha256:bb', build: !reset null }",
        '',
      ].join('\n'));
    writeFileSync(join(dir, '.env'), '');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('leaves docker-compose.yml alone: one crove service running every role and every module', () => {
    const services = config(['docker-compose.yml']);
    expect(services['crove']?.command).toEqual(['all']);
    expect(services['crove']?.profiles).toBeUndefined();
    expect(services['crove']?.environment?.['WORKER_DATABASE_URL']).toContain('crove_worker');
    expect(services['crove']?.environment?.['CROVE_MODULES']).toBe('');
    expect(services['api']).toBeUndefined();
    expect(services['worker']).toBeUndefined();
  });

  it('starts api and worker apart and not the all-in-one service', () => {
    const files = ['docker-compose.yml', 'compose.pilot.yml', 'docker-compose.override.yml'];
    const services = config(files);
    expect(services['crove']).toBeUndefined();
    expect(services['api']?.command).toEqual(['api']);
    expect(services['worker']?.command).toEqual(['worker']);
    // The release's digest, which deploy.sh pins for both while compose.pilot.yml is on the host.
    expect(services['api']?.image).toBe('registry.example/ludy@sha256:aa');
    expect(services['worker']?.image).toBe('registry.example/ludy@sha256:aa');
    // Without the pins (a stack built from a checkout) they run what `crove` runs.
    const unpinned = config(['docker-compose.yml', 'compose.pilot.yml']);
    expect(unpinned['api']?.image).toBe('crove:local');
    expect(unpinned['worker']?.image).toBe('crove:local');
    // The all-in-one service is one profile away, for a laptop.
    expect(config(files, {}, ['all-in-one'])['crove']?.profiles).toEqual(['all-in-one']);
  });

  it('keeps the worker database login and the sandbox away from the API', () => {
    const services = config(['docker-compose.yml', 'compose.pilot.yml']);
    const api = services['api'];
    const worker = services['worker'];
    expect(api?.environment).not.toHaveProperty('WORKER_DATABASE_URL');
    expect(api?.environment).not.toHaveProperty('EXTRACT_URL');
    // The API reaches crove-media (and not crove-extract): it measures the length of a meeting recording at upload (#2985).
    expect(Object.keys(api?.networks ?? {}).sort()).toEqual(['default', 'media']);
    expect(api?.environment?.['MEDIA_URL']).toBe('http://crove-media:8095');
    expect(api?.environment?.['DATABASE_URL']).toContain('crove_app');
    expect(worker?.environment?.['WORKER_DATABASE_URL']).toContain('crove_worker');
    expect(worker?.environment?.['EXTRACT_URL']).toBe('http://crove-extract:8090');
    expect(Object.keys(worker?.networks ?? {}).sort()).toEqual(['default', 'extract', 'media']);
    expect(worker?.environment?.['MEDIA_URL']).toBe('http://crove-media:8095');
    // crove-media runs in both layouts (the release publishes and pins its image, #2988): no profile keeps it out, and the pin wins over its build.
    const pinned = config(['docker-compose.yml', 'compose.pilot.yml', 'docker-compose.override.yml'])['crove-media'] as (Service & { image?: string; build?: unknown }) | undefined;
    expect(pinned?.image).toBe('registry.example/ludy-media@sha256:bb');
    expect(pinned?.build).toBeUndefined();
    expect(config(['docker-compose.yml'])['crove-media']?.profiles).toBeUndefined();
    expect(services['crove-media']?.profiles).toBeUndefined();
    // Where a recording sits decrypted while it is measured is a tmpfs, not a volume, so a killed container leaves nothing on the host (#2989).
    const media = config(['docker-compose.yml', 'compose.pilot.yml'])['crove-media'] as (Service & { tmpfs?: string[]; volumes?: unknown[]; mem_limit?: unknown }) | undefined;
    expect(media?.tmpfs?.some((t) => t.startsWith('/data/scratch'))).toBe(true);
    expect(media?.volumes ?? []).toEqual([]);
    // The pilot host has 8 GB: the sandbox is held to about 1 GB of video, with the scratch, the memory and the cap together, and the API refuses by the same cap (#2989).
    const pilot = config(['docker-compose.yml', 'compose.pilot.yml']);
    const pilotMedia = pilot['crove-media'] as (Service & { tmpfs?: string[]; mem_limit?: unknown; memswap_limit?: unknown }) | undefined;
    expect(pilotMedia?.tmpfs).toEqual(['/tmp:size=64m,noexec,nosuid', '/data/scratch:size=1g,mode=0700,uid=1000,gid=1000,noexec,nosuid']);
    expect(String(pilotMedia?.mem_limit)).toBe('1610612736');
    expect(String(pilotMedia?.memswap_limit)).toBe('1610612736');
    expect(pilotMedia?.environment?.['MEDIA_MAX_INPUT_BYTES']).toBe('1000000000');
    expect(pilot['api']?.environment?.['MEDIA_MAX_INPUT_BYTES']).toBe('1000000000');
    // The cap fits inside the scratch (1 GiB = 1073741824), and the memory limit holds the scratch and a decode.
    expect(Number(pilotMedia?.environment?.['MEDIA_MAX_INPUT_BYTES'])).toBeLessThan(1024 ** 3);
    // The default stack keeps the full 2 GB: 2304m of scratch, 4g of memory.
    const full = config(['docker-compose.yml'])['crove-media'] as (Service & { tmpfs?: string[]; mem_limit?: unknown }) | undefined;
    expect(full?.tmpfs?.[1]).toBe('/data/scratch:size=2304m,mode=0700,uid=1000,gid=1000,noexec,nosuid');
    expect(String(full?.mem_limit)).toBe('4294967296');
    expect(full?.environment?.['MEDIA_MAX_INPUT_BYTES']).toBe('2147483648');
    // Only the API opens a port.
    expect(api?.ports).toHaveLength(1);
    expect(worker?.ports).toBeUndefined();
    expect(worker?.healthcheck?.disable).toBe(true);
  });

  // #2130: what each role keeps of the release's `crove` service. The lists come from reading which role reads each variable
  // (kernel.ts start(): the api branch builds the HTTP app, the worker branch runs startWorker); see the audit on the issue. A variable in
  // neither list reaches both roles, which is the safe default for a new one.
  const WORKER_ONLY = [
    'ARCHIVE_STORE', 'ARCHIVE_S3_BUCKET', 'ARCHIVE_LOCK_MODE', 'ARCHIVE_RETENTION_DAYS', 'ARCHIVE_LAG_SECONDS', 'ARCHIVE_RESTORE_ALERT_DAYS',
    'ORG_LIMIT_INBOUND_EMAILS_PER_DAY', 'ORG_LIMIT_CONVERSATION_EMAILS_PER_DAY', 'ORG_LIMIT_ATTACHMENT_MB_PER_DAY', 'ORG_LIMIT_EXTRACTION_PAGES_PER_DAY',
    'ORG_LIMIT_AI_COST_PER_DAY', 'ORG_PURGE_MIN_DAYS', 'REFUSAL_TALLY_RETENTION_DAYS', 'OUTBOX_LAG_PAUSE_SECONDS', 'WORKER_DATABASE_POOL_MAX',
    'TRANSCRIBE_API_KEY', 'TRANSCRIBE_API_MODE', 'AI_PRICE_AUDIO_PER_MIN',
    // Already taken away from the API by #2133 and #2118.
    'WORKER_DATABASE_URL', 'EXTRACT_URL',
  ];
  const API_ONLY = ['OAUTH_SERVER', 'OAUTH_JWKS', 'OAUTH_COOKIE_KEYS', 'MCP_ALLOWED_ORIGINS'];
  // What the API and the worker both read, and the issue guessed were worker-only: they must stay on the API.
  const API_NEEDS = ['S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'STORAGE', 'CREDENTIAL_KEY', 'CHANNEL_META_APP_SECRET', 'CHANNEL_ZALO_APP_SECRET', 'CHANNEL_THREADS_APP_SECRET', 'EXPORT_ENCRYPTION_KEY', 'EVIDENCE_LOCK_DAYS', 'EXPORT_RETENTION_DAYS'];

  it('takes the worker-only settings and the archive volume away from the API, and the API-only ones from the worker, and nothing else', () => {
    const all = config(['docker-compose.yml', 'compose.pilot.yml'], {}, ['all-in-one'])['crove'];
    const pilot = config(['docker-compose.yml', 'compose.pilot.yml']);
    const crove = Object.keys(all?.environment ?? {});
    const apiKeys = Object.keys(pilot['api']?.environment ?? {}).sort();
    const workerKeys = Object.keys(pilot['worker']?.environment ?? {}).sort();
    // Exactly the lists are gone, and every other variable of crove reaches both roles, so a new variable stays on both until it is sorted here.
    expect(apiKeys).toEqual(crove.filter((k) => !WORKER_ONLY.includes(k)).sort());
    expect(workerKeys).toEqual(crove.filter((k) => !API_ONLY.includes(k)).sort());
    // Every name in the lists exists in crove (a renamed variable would drop out of the list unnoticed).
    for (const name of [...WORKER_ONLY, ...API_ONLY]) expect(crove, name).toContain(name);
    for (const name of API_NEEDS) expect(apiKeys, name).toContain(name);
    // Volumes: the API has no archive, keeps files, keys and the read-only status; the worker keeps the archive.
    const targets = (name: string) => (pilot[name]?.volumes ?? []).map((v) => v.target).sort();
    expect(targets('api')).toEqual(['/data/files', '/data/keys', '/data/status']);
    expect(targets('worker')).toEqual(['/data/archive', '/data/files', '/data/keys', '/data/status']);
    expect(pilot['api']?.volumes?.find((v) => v.target === '/data/status')?.read_only).toBe(true);
  });

  it('starts each role on exactly the environment it is left with: a public deployment loads its config and the api role passes its own check', () => {
    const pilot = config(['docker-compose.yml', 'compose.pilot.yml'], {
      PUBLIC_URL: 'https://books.example.com',
      PUBLIC_AUTH_URL: 'https://auth.example.com/auth/v1',
    });
    const strings = (name: string): Record<string, string> =>
      Object.fromEntries(Object.entries(pilot[name]?.environment ?? {}).filter((e): e is [string, string] => typeof e[1] === 'string'));
    // The deployment's own secrets, in place of the sample values compose falls back to (config refuses those on a public URL). Made here
    // at random, so no literal in this file looks like a secret to the secret scan.
    const random = () => randomBytes(32).toString('base64');
    const secrets = {
      AUTH_JWT_SECRET: random(),
      AUTH_AUTOCONFIRM: 'false',
      CROVE_CONTEXT_TOKEN_KEY: random(),
      DATABASE_URL: `postgres://crove_app:${randomBytes(18).toString('hex')}@db:5432/postgres`,
      EXPORT_ENCRYPTION_KEY: random(),
    };
    const workerSecret = { WORKER_DATABASE_URL: `postgres://crove_worker:${randomBytes(18).toString('hex')}@db:5432/postgres` };
    // The API: loads, refuses nothing of its own, and has none of the worker's.
    const api = loadConfig({ ...strings('api'), ...secrets });
    expect(() => assertSplitRoles(api, 'api')).not.toThrow();
    // The worker: loads without the API's OAuth settings, and turning the endpoint on in the API's environment does not leak to it.
    const worker = loadConfig({ ...strings('worker'), ...secrets, ...workerSecret });
    expect(() => assertSplitRoles(worker, 'worker')).not.toThrow();
    expect(worker.OAUTH_SERVER).toBe('off');
    expect(worker.OAUTH_JWKS).toBeUndefined();
  });

  it('runs the finance module by default for api, worker and prober, and follows CROVE_MODULES', () => {
    const files = ['docker-compose.yml', 'compose.pilot.yml'];
    for (const [env, expected] of [
      [{}, 'finance'],
      [{ CROVE_MODULES: '' }, 'finance'],
      [{ CROVE_MODULES: 'finance,crm' }, 'finance,crm'],
    ] as const) {
      const services = config(files, env, ['prober']);
      for (const name of ['api', 'worker', 'prober']) expect(services[name]?.environment?.['CROVE_MODULES'], `${name} ${JSON.stringify(env)}`).toBe(expected);
    }
  });

  it('points the prober at the API, since crove does not run', () => {
    const prober = config(['docker-compose.yml', 'compose.pilot.yml'], {}, ['prober'])['prober'];
    expect(prober?.environment?.['PROBER_AUTH_URL']).toBe('http://api:8080/auth/v1');
    expect(config(['docker-compose.yml', 'compose.pilot.yml'], { PROBER_AUTH_URL: 'https://auth.example/auth/v1' }, ['prober'])['prober']?.environment?.['PROBER_AUTH_URL']).toBe('https://auth.example/auth/v1');
  });
});
