// tools/deploy/deploy.sh (issue #56) against stand-ins for docker and curl (tools/test/deploy-stubs): the order of
// the steps, the readiness gate, rollback on a failed smoke test, the state it records, and what it refuses.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AVAILABLE_MODULES } from '../../apps/kernel/src/config.ts';

const repo = resolve(import.meta.dirname, '../..');
const script = join(repo, 'tools/deploy/deploy.sh');
// Linux and macOS (CI runs it on Linux). Under Git Bash on Windows the same suite takes about 15 minutes, since every
// case forks a few hundred processes; set LUDY_DEPLOY_TESTS=1 to run it there anyway.
const hasBash = spawnSync('bash', ['-c', 'exit 0']).status === 0;
const runHere = hasBash && (process.platform !== 'win32' || process.env['LUDY_DEPLOY_TESTS'] === '1');

const digest = (c: string) => c.repeat(64);
const image = (c: string) => `ghcr.io/example/ludy@sha256:${digest(c)}`;
const extract = (c: string) => `ghcr.io/example/ludy-extract@sha256:${digest(c)}`;
const media = (c: string) => `ghcr.io/example/ludy-media@sha256:${digest(c)}`;
const releaseDir = (release: string, c: string) => `${release}-${digest(c).slice(0, 12)}`;
// Forward slashes: the script takes absolute paths without backslashes (Git Bash on Windows accepts C:/...).
const slash = (p: string) => p.replaceAll('\\', '/');

let root: string;
let dir: string;
let log: string;
let compose: string;

function run(args: string[], env: Record<string, string> = {}, input?: string) {
  const stubs = join(root, 'bin');
  const res = spawnSync('bash', [script, ...args], {
    encoding: 'utf8',
    input: input ?? '',
    env: {
      ...process.env,
      PATH: `${stubs}${delimiter}${process.env['PATH'] ?? ''}`,
      LUDY_DEPLOY_DIR: dir,
      LUDY_READY_TIMEOUT: '1',
      LUDY_WORKER_SETTLE: '0',
      STUB_LOG: log,
      STUB_DEPLOY_DIR: dir,
      STUB_OPENSSL_KEY_FILE: `${root}/openssl-key`,
      // The account step of the smoke test stays off unless a case turns it on.
      SMOKE_EMAIL: '',
      SMOKE_PASSWORD: '',
      SMOKE_ORG: '',
      ...env,
    },
  });
  return { status: res.status, out: `${res.stdout}${res.stderr}` };
}

const deploy = (release: string, c: string, env: Record<string, string> = {}) =>
  run(['deploy', '--release', release, '--image', image(c), '--extract-image', extract(c), '--media-image', media(c), '--compose', compose], env);

const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter((l) => l && !l.startsWith('curl ')) : []);
const state = (name: string) => {
  const f = join(dir, '.deploy', name);
  return existsSync(f) ? readFileSync(f, 'utf8').trim() : '';
};
const running = () => readFileSync(join(dir, 'docker-compose.override.yml'), 'utf8');
const indexOf = (lines: string[], text: string) => lines.findIndex((l) => l.includes(text));

describe.skipIf(!runHere)('deploy.sh', { timeout: 300_000 }, () => {
  beforeEach(() => {
    root = slash(mkdtempSync(join(tmpdir(), 'ludy-deploy-')));
    dir = `${root}/host`;
    log = `${root}/calls.log`;
    compose = `${root}/docker-compose.yml`;
    mkdirSync(dir);
    mkdirSync(`${root}/bin`);
    // The key the stand-in for openssl makes (a new one for each case): the cases look for it in every log.
    writeFileSync(`${root}/openssl-key`, `${randomBytes(32).toString('base64')}\n`);
    for (const stub of ['docker', 'curl', 'openssl']) {
      // LF endings whatever the checkout did (core.autocrlf on Windows): bash refuses a CR in the shebang.
      writeFileSync(`${root}/bin/${stub}`, readFileSync(join(import.meta.dirname, 'deploy-stubs', stub), 'utf8').replaceAll('\r\n', '\n'));
      chmodSync(`${root}/bin/${stub}`, 0o755);
    }
    writeFileSync(`${dir}/.env`, 'POSTGRES_PASSWORD=x\n');
    writeFileSync(compose, 'name: ludy\nservices: {}\n');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('pulls by digest, migrates first, then rolls infrastructure, the app and the prober, and records the release', () => {
    const res = deploy('v1.0.0', 'a', { STUB_SERVICES: 'db migrate auth auth-grants ludy-extract ludy-media mailpit ludy prober' });
    expect(res.status, res.out).toBe(0);
    const c = calls();
    const order = [
      `pull ${image('a')}`,
      `pull ${extract('a')}`,
      `pull ${media('a')}`,
      'compose config --quiet',
      'compose up --detach --no-build --no-deps --wait --wait-timeout 600 db',
      'compose run --rm --no-TTY --no-deps migrate',
      'compose up --detach --no-build --no-deps --wait --wait-timeout 600 auth',
      'compose run --rm --no-TTY --no-deps auth-grants',
      'compose up --detach --no-build --no-deps --wait --wait-timeout 600 ludy-extract ludy-media mailpit',
      'compose up --detach --no-build --no-deps --wait --wait-timeout 600 ludy',
      'compose port ludy 8080',
      'compose up --detach --no-build --no-deps --wait --wait-timeout 600 prober',
    ].map((step) => indexOf(c, step));
    expect(order.every((i) => i >= 0), c.join('\n')).toBe(true);
    expect(order).toEqual([...order].sort((x, y) => x - y));

    expect(state('current')).toBe(releaseDir('v1.0.0', 'a'));
    expect(state('previous')).toBe('');
    expect(running()).toContain(`ludy: { image: '${image('a')}', build: !reset null }`);
    expect(running()).toContain(`ludy-extract: { image: '${extract('a')}', build: !reset null }`);
    expect(running()).toContain(`ludy-media: { image: '${media('a')}', build: !reset null }`);
    expect(readFileSync(`${dir}/releases/${releaseDir('v1.0.0', 'a')}/release.env`, 'utf8')).toContain(`MEDIA_IMAGE=${media('a')}`);
    expect(readFileSync(`${dir}/docker-compose.yml`, 'utf8')).toBe('name: ludy\nservices: {}\n');
    expect(readFileSync(`${dir}/.deploy/history.log`, 'utf8')).toMatch(/deploy v1\.0\.0-a{12} ok/);
    // The script installs itself for a manual rollback.
    expect(readFileSync(`${dir}/.deploy/deploy.sh`, 'utf8')).toBe(readFileSync(script, 'utf8'));
    expect(res.out).toContain('smoke ok: /login loads the app shell and its script bundle');
    expect(existsSync(`${dir}/.deploy/lock`)).toBe(false);
  });

  // #2118, #2133: the pilot's split API and worker. compose.pilot.yml ships with each release, next to its compose file;
  // the host chooses the layout by listing it in COMPOSE_FILE, and the pins of api and worker follow that choice.
  const SPLIT = 'db migrate auth auth-grants ludy-extract mailpit api worker';
  const PILOT_ENV = 'POSTGRES_PASSWORD=x\nCOMPOSE_FILE=docker-compose.yml:compose.pilot.yml:docker-compose.override.yml:compose.host.yml\n';
  const NOT_PILOT_ENV = 'POSTGRES_PASSWORD=x\nCOMPOSE_FILE=docker-compose.yml:docker-compose.override.yml:compose.host.yml\n';
  const filesOf = () => readFileSync(`${log}.files`, 'utf8').split('\n').filter(Boolean);
  const pins = (c: string) => [`api: { image: '${image(c)}', build: !reset null }`, `worker: { image: '${image(c)}', build: !reset null }`];

  it('uses the release\'s compose.pilot.yml only when COMPOSE_FILE lists it: after the release file, before the pins, host file last', () => {
    writeFileSync(`${dir}/compose.host.yml`, 'services: {}\n');
    // The release carries the file, but the host has not chosen the layout: not passed, not copied, no pins for api and worker.
    writeFileSync(`${root}/compose.pilot.yml`, '# release a\nservices: {}\n');
    expect(deploy('v1.0.0', 'a').status).toBe(0);
    for (const files of filesOf()) expect(files).toBe(`${dir}/docker-compose.yml ${dir}/docker-compose.override.yml ${dir}/compose.host.yml`);
    expect(existsSync(`${dir}/compose.pilot.yml`)).toBe(false);
    expect(existsSync(`${dir}/releases/${releaseDir('v1.0.0', 'a')}/compose.pilot.yml`)).toBe(true);
    expect(running()).not.toContain('api: {');

    // Listed: the release's copy becomes the host's, in the order the plain docker compose of COMPOSE_FILE uses.
    writeFileSync(`${dir}/.env`, PILOT_ENV);
    writeFileSync(`${root}/compose.pilot.yml`, '# release b\nservices: {}\n');
    rmSync(`${log}.files`);
    const res = deploy('v1.1.0', 'b', { STUB_SERVICES: SPLIT });
    expect(res.status, res.out).toBe(0);
    expect(filesOf().length).toBeGreaterThan(5);
    for (const files of filesOf()) expect(files).toBe(`${dir}/docker-compose.yml ${dir}/compose.pilot.yml ${dir}/docker-compose.override.yml ${dir}/compose.host.yml`);
    expect(readFileSync(`${dir}/compose.pilot.yml`, 'utf8')).toContain('# release b');
    // The pins of the release reach api and worker, for a plain docker compose on the host.
    for (const pin of pins('b')) expect(running()).toContain(pin);
    // The split roles roll worker first, then the API, and the smoke test finds the API's port.
    const c = calls();
    // The all-in-one container of an earlier layout goes first, so it keeps neither the API's port nor the worker's jobs.
    expect(indexOf(c, 'compose rm --stop --force ludy')).toBeGreaterThanOrEqual(0);
    expect(indexOf(c, 'compose rm --stop --force ludy')).toBeLessThan(indexOf(c, 'compose up --detach --no-build --no-deps worker'));
    expect(indexOf(c, 'compose up --detach --no-build --no-deps worker')).toBeLessThan(indexOf(c, 'compose up --detach --no-build --no-deps --wait --wait-timeout 600 api'));
    expect(c.some((l) => l === 'compose port api 8080')).toBe(true);

    // The next release brings its own copy, so the host's stays in step with its docker-compose.yml.
    writeFileSync(`${root}/compose.pilot.yml`, '# release c\nservices: {}\n');
    expect(deploy('v1.2.0', 'c', { STUB_SERVICES: SPLIT }).status).toBe(0);
    expect(readFileSync(`${dir}/compose.pilot.yml`, 'utf8')).toContain('# release c');
  });

  // #2162: the host's compose.pilot.yml is replaced by each release's copy; an edit made by hand is said out loud, a previous release's copy is not.
  it('says so when it replaces a hand-edited host compose.pilot.yml, and not when the host copy is a staged release\'s', () => {
    writeFileSync(`${dir}/.env`, PILOT_ENV);
    writeFileSync(`${root}/compose.pilot.yml`, '# release a\nservices: {}\n');
    const first = deploy('v1.0.0', 'a', { STUB_SERVICES: SPLIT });
    expect(first.status, first.out).toBe(0);
    expect(first.out).not.toContain('replacing');
    // The next release brings another copy over the unedited one: no word.
    writeFileSync(`${root}/compose.pilot.yml`, '# release b\nservices: {}\n');
    const second = deploy('v1.1.0', 'b', { STUB_SERVICES: SPLIT });
    expect(second.status, second.out).toBe(0);
    expect(second.out).not.toContain('replacing');
    // An operator edits the host copy; the next release replaces it and says so, naming the file and not its content.
    writeFileSync(`${dir}/compose.pilot.yml`, '# edited by hand SECRET-MARKER\nservices: {}\n');
    writeFileSync(`${root}/compose.pilot.yml`, '# release c\nservices: {}\n');
    const third = deploy('v1.2.0', 'c', { STUB_SERVICES: SPLIT });
    expect(third.status, third.out).toBe(0);
    expect(third.out).toContain(`replacing ${dir}/compose.pilot.yml with the copy of release`);
    expect(third.out).not.toContain('SECRET-MARKER');
    expect(readFileSync(`${dir}/compose.pilot.yml`, 'utf8')).toContain('# release c');
  });

  // #2162: `export COMPOSE_FILE=` and spaces around `=` are read like the pilot layout's own line, so the WAL overlay stop is not skipped.
  it('refuses a missing compose.wal.yml however the COMPOSE_FILE line is written, and ignores a commented-out one', () => {
    for (const line of ['export COMPOSE_FILE=docker-compose.yml:compose.wal.yml', 'COMPOSE_FILE = docker-compose.yml:compose.wal.yml', '  export  COMPOSE_FILE =docker-compose.yml:compose.wal.yml\r']) {
      writeFileSync(`${dir}/.env`, `POSTGRES_PASSWORD=x\n${line}\n`);
      const res = deploy('v1.0.0', 'a');
      expect(res.status, `${line}: ${res.out}`).toBe(2);
      expect(res.out).toContain('lists compose.wal.yml but');
    }
    // A comment, or a trailing comment, is not a listing.
    for (const line of ['# COMPOSE_FILE=docker-compose.yml:compose.wal.yml', 'COMPOSE_FILE=docker-compose.yml # compose.wal.yml']) {
      writeFileSync(`${dir}/.env`, `POSTGRES_PASSWORD=x\n${line}\n`);
      const res = deploy('v1.0.0', 'a');
      expect(res.out, line).not.toContain('lists compose.wal.yml but');
    }
  });

  it('rolls back to a release staged before ludy-media was published: no media image to pull, none pinned (#2988)', () => {
    expect(deploy('v1.0.0', 'a').status).toBe(0);
    expect(deploy('v1.1.0', 'b').status).toBe(0);
    // Release a as an earlier deploy.sh staged it: no MEDIA_IMAGE in release.env and no pin in its override.
    const old = `${dir}/releases/${releaseDir('v1.0.0', 'a')}`;
    writeFileSync(`${old}/release.env`, readFileSync(`${old}/release.env`, 'utf8').split('\n').filter((l) => !l.startsWith('MEDIA_IMAGE=')).join('\n'));
    writeFileSync(`${old}/docker-compose.override.yml`, readFileSync(`${old}/docker-compose.override.yml`, 'utf8').split('\n').filter((l) => !l.includes('ludy-media:')).join('\n'));
    writeFileSync(log, '');
    const back = run(['rollback']);
    expect(back.status, back.out).toBe(0);
    const c = calls();
    expect(indexOf(c, `pull ${image('a')}`)).toBeGreaterThanOrEqual(0);
    expect(indexOf(c, `pull ${extract('a')}`)).toBeGreaterThanOrEqual(0);
    // Nothing was pulled for a media image: no `pull` with an empty reference, no ludy-media digest.
    expect(c.filter((line) => line.startsWith('pull') && !line.includes('@sha256:'))).toEqual([]);
    expect(c.some((line) => line.includes('ludy-media@'))).toBe(false);
    expect(running()).not.toContain('ludy-media: {');
  });

  it('takes the pins of api and worker out when the host goes back to one container, and from a release staged with them (#2133)', () => {
    writeFileSync(`${dir}/.env`, PILOT_ENV);
    writeFileSync(`${root}/compose.pilot.yml`, '# pilot\nservices: {}\n');
    expect(deploy('v1.0.0', 'a', { STUB_SERVICES: SPLIT }).status).toBe(0);
    expect(deploy('v1.1.0', 'b', { STUB_SERVICES: SPLIT }).status).toBe(0);
    for (const pin of pins('b')) expect(running()).toContain(pin);
    // A release staged by an earlier deploy.sh carries the pins in its own override file. It is release b, the one the
    // rollback below goes back to, so the pins really are activated again.
    const staged = `${dir}/releases/${releaseDir('v1.1.0', 'b')}/docker-compose.override.yml`;
    writeFileSync(staged, `${readFileSync(staged, 'utf8')}${pins('b').map((l) => `  ${l}\n`).join('')}`);

    // Back to one container: only COMPOSE_FILE changes. The file stays on the host, unused; no bare api or worker is defined.
    writeFileSync(`${dir}/.env`, NOT_PILOT_ENV);
    rmSync(`${log}.files`);
    expect(deploy('v1.2.0', 'c').status).toBe(0);
    for (const files of filesOf()) expect(files).toBe(`${dir}/docker-compose.yml ${dir}/docker-compose.override.yml`);
    expect(running()).not.toContain('api: {');
    expect(running()).not.toContain('worker: {');
    // A rollback to the release with the old pins: stripped on activation, so the active override has none either.
    writeFileSync(`${dir}/compose.host.yml`, 'services: {}\n');
    expect(run(['rollback']).status).toBe(0);
    rmSync(`${dir}/compose.host.yml`, { force: true });
    expect(running()).not.toContain('api: {');
    expect(running()).not.toContain('worker: {');
    expect(running()).toContain(`ludy: { image: '${image('b')}', build: !reset null }`);
    // And forward again into the pilot layout: the pins come back with the layout.
    writeFileSync(`${dir}/.env`, PILOT_ENV);
    expect(deploy('v1.3.0', 'd', { STUB_SERVICES: SPLIT }).status).toBe(0);
    for (const pin of pins('d')) expect(running()).toContain(pin);
  });

  // #2120: the database image with WAL archiving is the host's file too; a deploy that dropped it would recreate `db`
  // without pgBackRest while the volume keeps pushing WAL with it.
  it('passes compose.wal.yml after the pins and before compose.host.yml, and refuses a COMPOSE_FILE that names it when it is missing (#2120)', () => {
    const filesOf = () => readFileSync(`${log}.files`, 'utf8').split('\n').filter(Boolean);
    writeFileSync(`${dir}/compose.wal.yml`, 'services: {}\n');
    writeFileSync(`${dir}/compose.host.yml`, 'services: {}\n');
    expect(deploy('v1.0.0', 'a').status).toBe(0);
    for (const files of filesOf()) expect(files).toBe(`${dir}/docker-compose.yml ${dir}/docker-compose.override.yml ${dir}/compose.wal.yml ${dir}/compose.host.yml`);
    rmSync(`${dir}/compose.wal.yml`);
    writeFileSync(`${dir}/.env`, 'POSTGRES_PASSWORD=x\nCOMPOSE_FILE=docker-compose.yml:docker-compose.override.yml:compose.wal.yml\n');
    const res = deploy('v1.1.0', 'b');
    expect(res.status, res.out).toBe(2);
    expect(res.out).toContain('lists compose.wal.yml but');
  });

  it('stops before pulling when COMPOSE_FILE lists compose.pilot.yml and neither the release nor the host has the file, rather than roll the all-in-one ludy (#2118, #2133)', () => {
    writeFileSync(`${dir}/.env`, PILOT_ENV);
    const res = deploy('v1.0.0', 'a', { STUB_SERVICES: 'db migrate auth auth-grants ludy-extract mailpit ludy' });
    expect(res.status, res.out).toBe(2);
    expect(res.out).toContain('lists compose.pilot.yml but this release does not carry it');
    expect(calls().some((l) => l.startsWith('pull '))).toBe(false);
    // Any way a dotenv file may spell the assignment counts, and a name inside a comment does not.
    const layout = 'docker-compose.yml:compose.pilot.yml:docker-compose.override.yml';
    for (const line of [`COMPOSE_FILE = ${layout}`, `export COMPOSE_FILE=${layout}`, `  COMPOSE_FILE="${layout}" # pilot`, `COMPOSE_FILE=${layout}\r`]) {
      writeFileSync(`${dir}/.env`, `POSTGRES_PASSWORD=x\n${line}\n`);
      expect(deploy('v1.0.0', 'a').status, line).toBe(2);
    }
    for (const line of ['COMPOSE_FILE=docker-compose.yml:docker-compose.override.yml # not compose.pilot.yml', `# COMPOSE_FILE=${layout}`]) {
      writeFileSync(`${dir}/.env`, `POSTGRES_PASSWORD=x\n${line}\n`);
      expect(deploy('v1.0.0', 'a').status, line).toBe(0);
    }
    writeFileSync(`${dir}/.env`, PILOT_ENV);
    rmSync(`${log}.files`, { force: true });
    // A copy the host already has is enough for a release that does not ship one (an older release).
    writeFileSync(`${dir}/compose.pilot.yml`, 'services: {}\n');
    expect(deploy('v1.0.0', 'a', { STUB_SERVICES: SPLIT }).status).toBe(0);
    for (const files of filesOf()) expect(files).toBe(`${dir}/docker-compose.yml ${dir}/compose.pilot.yml ${dir}/docker-compose.override.yml`);
  });

  it('says so when it cannot remove the old ludy container, and goes on', () => {
    writeFileSync(`${dir}/.env`, PILOT_ENV);
    writeFileSync(`${root}/compose.pilot.yml`, 'services: {}\n');
    const res = deploy('v1.0.0', 'a', { STUB_SERVICES: 'db migrate auth auth-grants ludy-extract mailpit api worker', STUB_RM_FAIL: '1' });
    expect(res.status, res.out).toBe(0);
    expect(res.out).toContain('could not remove the old ludy container (the deploy goes on): rm: stub failure');
  });

  it('cleans up renamed v0.3.12 crove-extract/crove-media/crove containers gracefully scoped to the project before starting replacements, and supports rolling back to v0.3.12 (#3972)', () => {
    writeFileSync(`${dir}/.env`, `${PILOT_ENV}COMPOSE_PROJECT_NAME=ludy\n`);
    writeFileSync(`${root}/compose.pilot.yml`, 'services: {}\n');
    const res = deploy('v0.4.0', 'b', {
      STUB_SERVICES: 'db migrate auth auth-grants ludy-extract ludy-media mailpit api worker',
      STUB_ORPHAN_CONTAINERS: 'ludy:crove-extract=cid-ext ludy:crove-media=cid-media ludy:crove=cid-app ludy:crove=cid-backup-run:True otherproj:crove-extract=cid-other',
    });
    expect(res.status, res.out).toBe(0);
    const c = calls();
    expect(indexOf(c, 'docker stop --time 30 cid-ext')).toBeGreaterThanOrEqual(0);
    expect(indexOf(c, 'docker stop --time 30 cid-ext')).toBeLessThan(indexOf(c, 'docker rm cid-ext'));
    expect(indexOf(c, 'docker rm cid-ext')).toBeLessThan(indexOf(c, 'compose up --detach --no-build --no-deps --wait --wait-timeout 600 ludy-extract ludy-media mailpit'));
    expect(indexOf(c, 'docker stop --time 30 cid-media')).toBeLessThan(indexOf(c, 'docker rm cid-media'));
    expect(indexOf(c, 'docker rm cid-media')).toBeLessThan(indexOf(c, 'compose up --detach --no-build --no-deps --wait --wait-timeout 600 ludy-extract ludy-media mailpit'));
    expect(indexOf(c, 'docker stop --time 30 cid-app')).toBeLessThan(indexOf(c, 'docker rm cid-app'));
    expect(indexOf(c, 'docker rm cid-app')).toBeLessThan(indexOf(c, 'compose up --detach --no-build --no-deps worker'));
    expect(c.some((l) => l.includes('cid-backup-run'))).toBe(false);
    expect(c.some((l) => l.includes('cid-other'))).toBe(false);

    // Stage a v0.3.12-shaped release using legacy service names (`crove`, `crove-extract`, `crove-media`) as previous and roll back to it.
    writeFileSync(`${dir}/.env`, 'POSTGRES_PASSWORD=x\nCOMPOSE_PROJECT_NAME=ludy\n');
    const legacyRel = releaseDir('v0.3.12', 'a');
    const legacyDir = `${dir}/releases/${legacyRel}`;
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(`${legacyDir}/docker-compose.yml`, 'name: crove\nservices:\n  crove:\n  crove-extract:\n  crove-media:\n');
    writeFileSync(
      `${legacyDir}/docker-compose.override.yml`,
      `services:\n  crove: { image: '${image('a')}', build: !reset null }\n  crove-extract: { image: '${extract('a')}', build: !reset null }\n  crove-media: { image: '${media('a')}', build: !reset null }\n`,
    );
    writeFileSync(`${legacyDir}/release.env`, `RELEASE=v0.3.12\nIMAGE=${image('a')}\nEXTRACT_IMAGE=${extract('a')}\nMEDIA_IMAGE=${media('a')}\nBUILD=\nSTAGED_AT=20261124T000000.000000000Z\n`);
    writeFileSync(`${dir}/.deploy/previous`, `${legacyRel}\n`);
    writeFileSync(log, '');
    const back = run(['rollback'], {
      STUB_SERVICES: 'db migrate auth auth-grants crove-extract crove-media mailpit crove',
      STUB_ORPHAN_CONTAINERS: 'ludy:ludy-extract=cid-new-ext ludy:ludy-media=cid-new-media ludy:ludy=cid-new-app',
    });
    expect(back.status, back.out).toBe(0);
    const rc = calls();
    expect(indexOf(rc, 'docker stop --time 30 cid-new-ext')).toBeGreaterThanOrEqual(0);
    expect(indexOf(rc, 'docker stop --time 30 cid-new-ext')).toBeLessThan(indexOf(rc, 'docker rm cid-new-ext'));
    expect(indexOf(rc, 'docker rm cid-new-ext')).toBeLessThan(indexOf(rc, 'compose up --detach --no-build --no-deps --wait --wait-timeout 600 crove-extract crove-media mailpit'));
    expect(indexOf(rc, 'docker rm cid-new-media')).toBeGreaterThanOrEqual(0);
    expect(indexOf(rc, 'docker rm cid-new-app')).toBeGreaterThanOrEqual(0);
    expect(rc.some((l) => l === 'compose port crove 8080')).toBe(true);
    expect(rc.some((l) => l.endsWith('compose up --detach --no-build --no-deps --wait --wait-timeout 600 crove'))).toBe(true);
  });

  it('uses the merged compose project name (e.g. compose.host.yml) for orphan cleanup and fails closed on empty project or failed stop/rm (#3972)', () => {
    writeFileSync(`${dir}/.env`, PILOT_ENV);
    writeFileSync(`${root}/compose.pilot.yml`, 'services: {}\n');
    writeFileSync(`${dir}/compose.host.yml`, 'name: beta\nservices: {}\n');
    const beta = deploy('v0.4.0', 'b', {
      STUB_SERVICES: 'db migrate auth auth-grants ludy-extract ludy-media mailpit api worker',
      STUB_ORPHAN_CONTAINERS: 'beta:crove-extract=cid-beta-ext ludy:crove-extract=cid-ludy-ext',
    });
    expect(beta.status, beta.out).toBe(0);
    const bc = calls();
    expect(bc.some((l) => l === 'docker stop --time 30 cid-beta-ext')).toBe(true);
    expect(bc.some((l) => l === 'docker rm cid-beta-ext')).toBe(true);
    expect(bc.some((l) => l.includes('cid-ludy-ext'))).toBe(false);

    rmSync(`${dir}/compose.host.yml`, { force: true });
    expect(deploy('v0.4.1', 'c', { STUB_COMPOSE_PROJECT: '__empty__' }).status).not.toBe(0);
    for (const failEnv of [{ STUB_ORPHAN_STOP_FAIL: '1' }, { STUB_ORPHAN_RM_FAIL: '1' }] as Record<string, string>[]) {
      const failed = deploy('v0.4.2', 'd', {
        STUB_SERVICES: 'db migrate auth auth-grants ludy-extract api worker',
        STUB_ORPHAN_CONTAINERS: 'ludy:crove-extract=cid-stuck',
        ...failEnv,
      });
      expect(failed.status, failed.out).not.toBe(0);
      expect(failed.out).toContain('failed to');
    }
  });

  it('refuses retired CROVE_* credentials without LUDY_* replacement before pulling images and blocks un-cut-over crove_db-data volumes (#3972)', () => {
    const readEnv = () => readFileSync(`${dir}/.env`, 'utf8');
    const secretCtx = 'secret-context-token-do-not-print';
    const beforeCtx = `POSTGRES_PASSWORD=x\nCROVE_CONTEXT_TOKEN_KEY=${secretCtx}\n`;
    writeFileSync(`${dir}/.env`, beforeCtx);
    const resCtx = deploy('v1.0.0', 'a');
    expect(resCtx.status, resCtx.out).toBe(2);
    expect(resCtx.out).toContain('CROVE_CONTEXT_TOKEN_KEY->LUDY_CONTEXT_TOKEN_KEY');
    expect(resCtx.out).not.toContain(secretCtx);
    expect(readEnv()).toBe(beforeCtx);
    expect(calls()).toEqual([]);

    const secretPw = 'secret-app-pw-do-not-print';
    const beforePw = `POSTGRES_PASSWORD=x\nLUDY_CONTEXT_TOKEN_KEY=valid-key\nCROVE_APP_DB_PASSWORD=${secretPw}\n`;
    writeFileSync(`${dir}/.env`, beforePw);
    const resPw = deploy('v1.0.0', 'a');
    expect(resPw.status, resPw.out).toBe(2);
    expect(resPw.out).toContain('CROVE_APP_DB_PASSWORD->LUDY_APP_DB_PASSWORD');
    expect(resPw.out).not.toContain(secretPw);
    expect(readEnv()).toBe(beforePw);
    expect(calls()).toEqual([]);

    // Having both legacy CROVE_* and non-empty LUDY_* replacement proceeds normally.
    writeFileSync(`${dir}/.env`, `POSTGRES_PASSWORD=x\nLUDY_CONTEXT_TOKEN_KEY=valid-key\nCROVE_APP_DB_PASSWORD=${secretPw}\nLUDY_APP_DB_PASSWORD=new-pw\n`);
    expect(deploy('v1.0.0', 'a').status).toBe(0);
    writeFileSync(log, '');

    // Retired CROVE_MODULES without LUDY_MODULES must abort before pulling images.
    const beforeMod = `POSTGRES_PASSWORD=x\nLUDY_CONTEXT_TOKEN_KEY=valid-key\nCROVE_MODULES=finance\n`;
    writeFileSync(`${dir}/.env`, beforeMod);
    const resMod = deploy('v1.0.0', 'a');
    expect(resMod.status, resMod.out).toBe(2);
    expect(resMod.out).toContain('CROVE_MODULES->LUDY_MODULES');
    expect(readEnv()).toBe(beforeMod);
    expect(calls()).toEqual([]);

    // Unrelated crove_db-data on the Docker host when this directory has no prior compose stack must NOT block a fresh deploy.
    writeFileSync(`${dir}/.env`, `POSTGRES_PASSWORD=x\nLUDY_CONTEXT_TOKEN_KEY=valid-key\n`);
    const freshWithOtherStack = deploy('v1.0.0', 'a', {
      STUB_VOLUMES: 'crove_db-data',
      STUB_PG_CLUSTER_IDS: 'crove_db-data=unrelated-cluster',
    });
    expect(freshWithOtherStack.status, freshWithOtherStack.out).toBe(0);

    // Simulate a first-time deploy over an existing manual pre-Stage-7 checkout (no .deploy/current yet):
    // failing the storage guard must abort AND restore the original crove docker-compose.yml without leaving override behind.
    rmSync(`${dir}/.deploy`, { recursive: true, force: true });
    const legacyCompose = 'name: crove\nservices:\n  db:\n  crove:\n';
    writeFileSync(`${dir}/docker-compose.yml`, legacyCompose);
    rmSync(`${dir}/docker-compose.override.yml`, { force: true });

    const volGuard = deploy('v1.0.1', 'b', {
      STUB_VOLUMES: 'crove_db-data',
      STUB_PG_CLUSTER_IDS: 'crove_db-data=cluster-1',
    });
    expect(volGuard.status, volGuard.out).toBe(1);
    expect(volGuard.out).toContain('without a matching copied PostgreSQL cluster in ludy_db-data');
    expect(volGuard.out).toContain('cutover-ludy.sh cutover-stack');
    expect(readFileSync(`${dir}/docker-compose.yml`, 'utf8')).toBe(legacyCompose);
    expect(existsSync(`${dir}/docker-compose.override.yml`)).toBe(false);

    // Empty ludy_db-data (no PG_VERSION / pg_control) alongside populated crove_db-data fails closed and keeps compose intact.
    const emptyVolGuard = deploy('v1.0.1', 'b', {
      STUB_VOLUMES: 'crove_db-data ludy_db-data',
      STUB_PG_CLUSTER_IDS: 'crove_db-data=cluster-1',
    });
    expect(emptyVolGuard.status, emptyVolGuard.out).toBe(1);
    expect(emptyVolGuard.out).toContain('without a matching copied PostgreSQL cluster in ludy_db-data');
    expect(readFileSync(`${dir}/docker-compose.yml`, 'utf8')).toBe(legacyCompose);

    // Freshly initialized empty ludy_db-data (mismatched system_identifier) alongside crove_db-data fails closed.
    const mismatchedVolGuard = deploy('v1.0.1', 'b', {
      STUB_VOLUMES: 'crove_db-data ludy_db-data',
      STUB_PG_CLUSTER_IDS: 'crove_db-data=cluster-old ludy_db-data=cluster-fresh',
    });
    expect(mismatchedVolGuard.status, mismatchedVolGuard.out).toBe(1);
    expect(mismatchedVolGuard.out).toContain('without a matching copied PostgreSQL cluster in ludy_db-data');

    // Bind-mounted PostgreSQL target path on host is verified just like named volumes and fails if empty/mismatched.
    const bindPgDir = `${root}/empty-pg-bind`;
    mkdirSync(bindPgDir);
    const bindMismatch = deploy('v1.0.1', 'b', {
      STUB_VOLUMES: 'crove_db-data',
      STUB_NEW_DB_BIND: bindPgDir,
      STUB_PG_CLUSTER_IDS: 'crove_db-data=cluster-1',
    });
    expect(bindMismatch.status, bindMismatch.out).toBe(1);
    expect(bindMismatch.out).toContain(`without a matching copied PostgreSQL cluster in ${bindPgDir}`);

    // Reusing crove_db-data while non-empty crove_files or crove_keys lacks migrated ludy_* data fails closed.
    const missingFiles = deploy('v1.0.1', 'b', {
      STUB_VOLUMES: 'crove_db-data crove_files',
      STUB_NEW_DB_VOLUME: 'crove_db-data',
      STUB_PG_CLUSTER_IDS: 'crove_db-data=cluster-1',
      STUB_POPULATED_MOUNTS: 'crove_files',
    });
    expect(missingFiles.status, missingFiles.out).toBe(1);
    expect(missingFiles.out).toContain('found non-empty prior /data/files storage crove_files while destination ludy_files does not contain all migrated data');

    const emptyKeys = deploy('v1.0.1', 'b', {
      STUB_VOLUMES: 'crove_db-data ludy_db-data crove_keys ludy_keys',
      STUB_PG_CLUSTER_IDS: 'crove_db-data=cluster-1 ludy_db-data=cluster-1',
      STUB_POPULATED_MOUNTS: 'crove_keys',
    });
    expect(emptyKeys.status, emptyKeys.out).toBe(1);
    expect(emptyKeys.out).toContain('found non-empty prior /data/keys storage crove_keys while destination ludy_keys does not contain all migrated data');

    // Custom db volume configured on db service is checked rather than hardcoded ludy_db-data.
    const customVolMismatch = deploy('v1.0.1', 'b', {
      STUB_VOLUMES: 'crove_db-data ludy_db-data custom_db-data',
      STUB_NEW_DB_VOLUME: 'custom_db-data',
      STUB_PG_CLUSTER_IDS: 'crove_db-data=c1 ludy_db-data=c1 custom_db-data=c2',
    });
    expect(customVolMismatch.status, customVolMismatch.out).toBe(1);
    expect(customVolMismatch.out).toContain('without a matching copied PostgreSQL cluster in custom_db-data');

    // Fully migrated ludy_* DB + files + keys (while empty crove_archive is skipped cleanly) succeeds.
    const fullCutover = deploy('v1.0.1', 'b', {
      STUB_VOLUMES: 'crove_db-data ludy_db-data crove_files ludy_files crove_keys ludy_keys crove_archive',
      STUB_PG_CLUSTER_IDS: 'crove_db-data=cluster-1 ludy_db-data=cluster-1',
      STUB_POPULATED_MOUNTS: 'crove_files ludy_files crove_keys ludy_keys',
    });
    expect(fullCutover.status, fullCutover.out).toBe(0);
  });

  // #892: with --build, /version must report the build being deployed, so an old container that still answers fails.
  it('resolves tools/backup/compose.wal.yml from COMPOSE_FILE in preflight and compose calls (#3972)', () => {
    mkdirSync(`${dir}/tools/backup`, { recursive: true });
    writeFileSync(`${dir}/tools/backup/compose.wal.yml`, 'services: {}\n');
    writeFileSync(`${dir}/.env`, 'POSTGRES_PASSWORD=x\nCOMPOSE_FILE=docker-compose.yml:tools/backup/compose.wal.yml\n');
    const ok = deploy('v1.0.0', 'a');
    expect(ok.status, ok.out).toBe(0);
    expect(readFileSync(`${log}.files`, 'utf8')).toContain(`${dir}/tools/backup/compose.wal.yml`);

    rmSync(`${dir}/tools/backup/compose.wal.yml`);
    const missing = deploy('v1.0.1', 'b');
    expect(missing.status, missing.out).toBe(2);
    expect(missing.out).toContain('lists compose.wal.yml but');

    // Interpolated COMPOSE_FILE + custom COMPOSE_PATH_SEPARATOR resolves identically to Compose and fails closed when missing (#3972 Round 16).
    mkdirSync(`${dir}/tools/backup`, { recursive: true });
    writeFileSync(`${dir}/tools/backup/compose.wal.yml`, 'services: {}\n');
    writeFileSync(`${dir}/.env`, 'POSTGRES_PASSWORD=x\nWAL_OVERLAY=tools/backup/compose.wal.yml\nCOMPOSE_PATH_SEPARATOR=;\nCOMPOSE_FILE=docker-compose.yml;${WAL_OVERLAY}\n');
    rmSync(`${log}.files`, { force: true });
    const okInterp = deploy('v1.0.2', 'c');
    expect(okInterp.status, okInterp.out).toBe(0);
    expect(readFileSync(`${log}.files`, 'utf8')).toContain(`${dir}/tools/backup/compose.wal.yml`);
    rmSync(`${dir}/tools/backup/compose.wal.yml`);
    const missingInterp = deploy('v1.0.3', 'd');
    expect(missingInterp.status, missingInterp.out).toBe(2);
    expect(missingInterp.out).toContain('lists compose.wal.yml but');

    // Exact Compose path & declared order preserved for site.yml after compose.host.yml and nested site/compose.host.yml (#3972 Round 17).
    rmSync(`${dir}/.deploy`, { recursive: true, force: true });
    rmSync(`${dir}/docker-compose.yml`, { force: true });
    writeFileSync(`${dir}/compose.host.yml`, 'services: {}\n');
    writeFileSync(`${dir}/site.yml`, 'services: {}\n');
    writeFileSync(`${dir}/.env`, 'POSTGRES_PASSWORD=x\nCOMPOSE_FILE=docker-compose.yml:compose.host.yml:site.yml\n');
    rmSync(`${log}.files`, { force: true });
    const siteAfterHost = deploy('v1.0.4', 'e');
    expect(siteAfterHost.status, siteAfterHost.out).toBe(0);
    for (const files of readFileSync(`${log}.files`, 'utf8').split('\n').filter(Boolean)) {
      expect(files).toBe(`${dir}/docker-compose.yml ${dir}/docker-compose.override.yml ${dir}/compose.host.yml ${dir}/site.yml`);
    }

    writeFileSync(`${dir}/.env`, 'POSTGRES_PASSWORD=x\nCOMPOSE_FILE=docker-compose.yml:site/compose.host.yml\n');
    const missingNestedHost = deploy('v1.0.5', 'f');
    expect(missingNestedHost.status, missingNestedHost.out).toBe(2);
    expect(missingNestedHost.out).toContain('lists site/compose.host.yml but the file does not exist');

    mkdirSync(`${dir}/site`, { recursive: true });
    writeFileSync(`${dir}/site/compose.host.yml`, 'services: {}\n');
    rmSync(`${log}.files`, { force: true });
    const nestedHost = deploy('v1.0.6', '1');
    expect(nestedHost.status, nestedHost.out).toBe(0);
    for (const files of readFileSync(`${log}.files`, 'utf8').split('\n').filter(Boolean)) {
      expect(files).toBe(`${dir}/docker-compose.yml ${dir}/docker-compose.override.yml ${dir}/site/compose.host.yml`);
    }
    rmSync(`${dir}/compose.host.yml`, { force: true });
    rmSync(`${dir}/site.yml`, { force: true });
    rmSync(`${dir}/site`, { recursive: true, force: true });
  });

  it('fails closed before activate when pre-deploy compose inspection fails, and exports prior release images (#3972)', () => {
    writeFileSync(`${dir}/docker-compose.yml`, '# manual checkout\nname: crove\nservices: {}\n');
    const blocked = deploy('v1.0.0', 'a', { STUB_PREV_CONFIG_FAIL: '1' });
    expect(blocked.status, blocked.out).toBe(1);
    expect(blocked.out).toContain('cannot inspect existing compose configuration');
    expect(readFileSync(`${dir}/docker-compose.yml`, 'utf8')).toContain('# manual checkout');
    expect(existsSync(`${dir}/.deploy/current`)).toBe(false);

    rmSync(`${dir}/docker-compose.yml`);
    expect(deploy('v1.0.0', 'a').status).toBe(0);
    const upgrade = deploy('v1.1.0', 'b', {
      STUB_PREV_CONFIG_REQUIRE_ENV: 'CROVE_IMAGE',
      STUB_PREV_IMAGE_MATCH: digest('a'),
    });
    expect(upgrade.status, upgrade.out).toBe(0);
  });

  it('refuses project switch when another container holds shared or prior db storage, or when docker inspection fails (#3972)', () => {
    writeFileSync(`${dir}/docker-compose.yml`, 'name: crove\nservices: {}\n');
    const sharedHeld = deploy('v1.0.0', 'a', {
      STUB_NEW_DB_VOLUME: 'crove_db-data',
      STUB_RUNNING_CONTAINERS: 'crove-db-1',
      STUB_INSPECT_MOUNTS: 'crove-db-1|crove|volume|crove_db-data|',
    });
    expect(sharedHeld.status, sharedHeld.out).toBe(1);
    expect(sharedHeld.out).toContain('still mounted by a running container outside project ludy');
    expect(readFileSync(`${dir}/docker-compose.yml`, 'utf8')).toContain('name: crove');
    expect(existsSync(`${dir}/.deploy/current`)).toBe(false);
    expect(calls().some((l) => l.startsWith('compose up '))).toBe(false);

    // Running container still holding prior crove_db-data while switching to ludy_db-data is refused even with equal cluster IDs.
    const sourceHeld = deploy('v1.0.0', 'a', {
      STUB_VOLUMES: 'crove_db-data ludy_db-data',
      STUB_PG_CLUSTER_IDS: 'crove_db-data=99 ludy_db-data=99',
      STUB_RUNNING_CONTAINERS: 'crove-db-1',
      STUB_INSPECT_MOUNTS: 'crove-db-1|crove|volume|crove_db-data|',
    });
    expect(sourceHeld.status, sourceHeld.out).toBe(1);
    expect(sourceHeld.out).toContain('prior database storage crove_db-data is still mounted by a running container');

    // Docker ps / inspect failures fail closed instead of looking like free storage.
    const psFail = deploy('v1.0.0', 'a', { STUB_PS_FAIL: '1' });
    expect(psFail.status, psFail.out).toBe(1);
    expect(psFail.out).toContain('cannot inspect existing Docker containers');

    const inspectFail = deploy('v1.0.0', 'a', {
      STUB_RUNNING_CONTAINERS: 'crove-db-1',
      STUB_INSPECT_FAIL: '1',
    });
    expect(inspectFail.status, inspectFail.out).toBe(1);
    expect(inspectFail.out).toContain('cannot inspect running containers to verify database storage');
  });

  it('detects prior project even if .env was already switched to ludy, and verifies stale PG / full recursive parity (#3972)', () => {
    // 1) After deploying under crove, switching .env to ludy without cutting over still catches crove_db-data via .deploy/project.
    writeFileSync(`${dir}/.env`, 'POSTGRES_PASSWORD=x\nCOMPOSE_PROJECT_NAME=crove\n');
    const firstCrove = deploy('v1.0.0', 'a');
    expect(firstCrove.status, firstCrove.out).toBe(0);
    expect(readFileSync(`${dir}/.deploy/project`, 'utf8').trim()).toBe('crove');

    writeFileSync(`${dir}/.env`, 'POSTGRES_PASSWORD=x\nCOMPOSE_PROJECT_NAME=ludy\n');
    const blockedViaState = deploy('v1.1.0', 'b', {
      STUB_VOLUMES: 'crove_db-data',
      STUB_PG_CLUSTER_IDS: 'crove_db-data=cluster-1',
    });
    expect(blockedViaState.status, blockedViaState.out).toBe(1);
    expect(blockedViaState.out).toContain('without a matching copied PostgreSQL cluster in ludy_db-data');

    // 2) Without .deploy state, a running or stopped container labeled for $dir still catches crove_db-data.
    rmSync(`${dir}/.deploy`, { recursive: true, force: true });
    writeFileSync(`${dir}/docker-compose.yml`, 'name: crove\nservices: {}\n');
    const blockedViaContainer = deploy('v1.0.0', 'a', {
      STUB_WORKDIR_CONTAINERS: `${dir}|db|crove-db-1`,
      STUB_INSPECT_MOUNTS: 'crove-db-1|crove|volume|crove_db-data|',
      STUB_VOLUMES: 'crove_db-data',
      STUB_PG_CLUSTER_IDS: 'crove_db-data=cluster-1',
    });
    expect(blockedViaContainer.status, blockedViaContainer.out).toBe(1);
    expect(blockedViaContainer.out).toContain('without a matching copied PostgreSQL cluster in ludy_db-data');

    // 3) Stale pg_control / pg_wal or postmaster.pid fails PG cluster parity even when system_identifier matches.
    const stalePg = deploy('v1.0.0', 'a', {
      STUB_VOLUMES: 'crove_db-data ludy_db-data',
      STUB_PG_CLUSTER_IDS: 'crove_db-data=99 ludy_db-data=99',
      STUB_PG_STALE_MOUNTS: 'ludy_db-data',
    });
    expect(stalePg.status, stalePg.out).toBe(1);
    expect(stalePg.out).toContain('without a matching copied PostgreSQL cluster in ludy_db-data');

    // 4) Incomplete /data/files or /data/keys parity fails without passing invalid CLI flags (e.g. --strict) to node -e.
    const partialFiles = deploy('v1.0.0', 'a', {
      STUB_PG_CLUSTER_IDS: 'crove_db-data=99 ludy_db-data=99',
      STUB_VOLUMES: 'crove_db-data ludy_db-data crove_files ludy_files',
      STUB_POPULATED_MOUNTS: 'crove_files ludy_files',
      STUB_PARTIAL_MOUNTS: 'ludy_files',
    });
    expect(partialFiles.status, partialFiles.out).toBe(1);
    expect(partialFiles.out).toContain('does not contain all migrated data');

    const partialKeys = deploy('v1.0.0', 'a', {
      STUB_PG_CLUSTER_IDS: 'crove_db-data=99 ludy_db-data=99',
      STUB_VOLUMES: 'crove_db-data ludy_db-data crove_keys ludy_keys',
      STUB_POPULATED_MOUNTS: 'crove_keys ludy_keys',
      STUB_PARTIAL_MOUNTS: 'ludy_keys',
    });
    expect(partialKeys.status, partialKeys.out).toBe(1);
    expect(partialKeys.out).toContain('does not contain all migrated data');

    const okKeys = deploy('v1.0.0', 'a', {
      STUB_PG_CLUSTER_IDS: 'crove_db-data=99 ludy_db-data=99',
      STUB_VOLUMES: 'crove_db-data ludy_db-data crove_keys ludy_keys',
      STUB_POPULATED_MOUNTS: 'crove_keys ludy_keys',
    });
    expect(okKeys.status, okKeys.out).toBe(0);
    expect(readFileSync(`${log}.volumes`, 'utf8')).not.toContain(' --strict');
    expect(readFileSync(`${dir}/.deploy/project`, 'utf8').trim()).toBe('ludy');
  });

  it('catches host mount path changes via container mounts and .deploy/mounts, blocks active data writers, and fails closed on volume inspect error (#3972)', () => {
    const oldPg = `${root}/pg-old`;
    const newPg = `${root}/pg-new`;
    mkdirSync(oldPg);
    mkdirSync(newPg);

    // 1) Container mount reports oldPg while new compose config specifies newPg -> blocked before up db.
    writeFileSync(`${dir}/docker-compose.yml`, 'name: ludy\nservices: {}\n');
    const ctrBindBlocked = deploy('v1.0.0', 'a', {
      STUB_NEW_DB_BIND: newPg,
      STUB_PG_CLUSTER_IDS: `${oldPg}=cluster-old`,
      STUB_WORKDIR_CONTAINERS: `${dir}|db|ludy-db-1`,
      STUB_INSPECT_MOUNTS: `ludy-db-1|ludy|bind||${oldPg}|/var/lib/postgresql/data`,
    });
    expect(ctrBindBlocked.status, ctrBindBlocked.out).toBe(1);
    expect(ctrBindBlocked.out).toContain(`without a matching copied PostgreSQL cluster in ${newPg}`);

    // 2) After deploying with oldPg (.deploy/mounts records oldPg), editing compose.host.yml to newPg with no containers still blocks.
    rmSync(`${dir}/docker-compose.yml`);
    const initialBindOk = deploy('v1.0.0', 'a', { STUB_NEW_DB_BIND: oldPg });
    expect(initialBindOk.status, initialBindOk.out).toBe(0);
    expect(readFileSync(`${dir}/.deploy/mounts`, 'utf8')).toContain(`/var/lib/postgresql/data=bind:${oldPg}`);

    const changedBindBlocked = deploy('v1.1.0', 'b', {
      STUB_NEW_DB_BIND: newPg,
      STUB_PG_CLUSTER_IDS: `${oldPg}=cluster-old`,
    });
    expect(changedBindBlocked.status, changedBindBlocked.out).toBe(1);
    expect(changedBindBlocked.out).toContain(`without a matching copied PostgreSQL cluster in ${newPg}`);

    // 3) Switching /data/files while keeping same DB mount refuses if a running container still mounts prior crove_files.
    rmSync(`${dir}/.deploy`, { recursive: true, force: true });
    writeFileSync(`${dir}/docker-compose.yml`, 'name: crove\nservices: {}\n');
    const dataWriterHeld = deploy('v1.0.0', 'a', {
      STUB_NEW_DB_VOLUME: 'crove_db-data',
      STUB_VOLUMES: 'crove_db-data crove_files',
      STUB_RUNNING_CONTAINERS: 'crove-api-1',
      STUB_INSPECT_MOUNTS: 'crove-api-1|crove|volume|crove_files|',
    });
    expect(dataWriterHeld.status, dataWriterHeld.out).toBe(1);
    expect(dataWriterHeld.out).toContain('prior /data/files storage crove_files is still mounted by a running container');

    // 4) Docker volume inspect failure fails closed instead of treating prior storage as absent.
    const volInspectFail = deploy('v1.0.0', 'a', { STUB_VOLUME_INSPECT_FAIL: '1' });
    expect(volInspectFail.status, volInspectFail.out).toBe(1);
    expect(volInspectFail.out).toContain('cannot inspect prior database storage crove_db-data');
  });

  it('fails closed on missing new mounts, extra PGDATA files, volume subpaths, and keeps project across recover and rollback (#3972)', () => {
    const croveCompose = `${root}/docker-compose.crove.yml`;
    writeFileSync(croveCompose, 'name: crove\nservices: {}\n');

    writeFileSync(`${dir}/docker-compose.yml`, 'name: crove\nservices: {}\n');
    const missingNewDb = deploy('v1.0.0', 'a', {
      STUB_OMIT_NEW_DB_MOUNT: '1',
      STUB_VOLUMES: 'crove_db-data',
      STUB_PG_CLUSTER_IDS: 'crove_db-data=c1',
    });
    expect(missingNewDb.status, missingNewDb.out).toBe(1);
    expect(missingNewDb.out).toContain('defines no persistent mount at /var/lib/postgresql/data');

    const missingNewFiles = deploy('v1.0.0', 'a', {
      STUB_OMIT_NEW_FILES_MOUNT: '1',
      STUB_VOLUMES: 'crove_db-data ludy_db-data crove_files',
      STUB_PG_CLUSTER_IDS: 'crove_db-data=c1 ludy_db-data=c1',
      STUB_POPULATED_MOUNTS: 'crove_files',
    });
    expect(missingNewFiles.status, missingNewFiles.out).toBe(1);
    expect(missingNewFiles.out).toContain('defines no persistent mount at /data/files');

    const extraPg = deploy('v1.0.0', 'a', {
      STUB_VOLUMES: 'crove_db-data ludy_db-data',
      STUB_PG_CLUSTER_IDS: 'crove_db-data=c1 ludy_db-data=c1',
      STUB_PG_EXTRA_FILES_MOUNTS: 'ludy_db-data',
    });
    expect(extraPg.status, extraPg.out).toBe(1);
    expect(extraPg.out).toContain('without a matching copied PostgreSQL cluster in ludy_db-data');

    const subpathMount = deploy('v1.0.0', 'a', {
      STUB_NEW_DB_SUBPATH: 'pg17',
    });
    expect(subpathMount.status, subpathMount.out).toBe(1);
    expect(subpathMount.out).toContain('unsupported volume subpath mount on /var/lib/postgresql/data');

    rmSync(`${dir}/docker-compose.yml`);
    const v1Crove = run(['deploy', '--release', 'v1.0.0', '--image', image('a'), '--extract-image', extract('a'), '--media-image', media('a'), '--compose', croveCompose]);
    expect(v1Crove.status, v1Crove.out).toBe(0);
    expect(readFileSync(`${dir}/.deploy/project`, 'utf8').trim()).toBe('crove');

    writeFileSync(`${log}.project`, '');
    const failedSwitch = deploy('v1.1.0', 'b', {
      STUB_VOLUMES: 'crove_db-data ludy_db-data',
      STUB_PG_CLUSTER_IDS: 'crove_db-data=c1 ludy_db-data=c1',
      STUB_BAD_DIGEST: digest('b'),
      STUB_LOG_PROJECT: '1',
    });
    expect(failedSwitch.status, failedSwitch.out).toBe(1);
    const recoverProjects = readFileSync(`${log}.project`, 'utf8').split('\n').filter(Boolean);
    expect(recoverProjects.some((l) => l === 'project ludy up' || l === 'project ludy port')).toBe(true);
    expect(recoverProjects.filter((l) => l.startsWith('project  '))).toContain('project  config');
    expect(readFileSync(`${dir}/.deploy/project`, 'utf8').trim()).toBe('ludy');
    expect(running()).toContain('name: ludy');

    const recoverPlainCfg = spawnSync('docker', ['compose', '--env-file', `${dir}/.env`, '-f', `${dir}/docker-compose.yml`, '-f', `${dir}/docker-compose.override.yml`, 'config'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${join(root, 'bin')}${delimiter}${process.env['PATH'] ?? ''}`, STUB_LOG: log, STUB_DEPLOY_DIR: dir },
    });
    expect(recoverPlainCfg.status, recoverPlainCfg.stderr).toBe(0);
    expect(recoverPlainCfg.stdout).toMatch(/^name: ludy$/m);

    rmSync(`${dir}/.deploy`, { recursive: true, force: true });
    rmSync(`${dir}/docker-compose.yml`, { force: true });
    expect(run(['deploy', '--release', 'v1.0.0', '--image', image('a'), '--extract-image', extract('a'), '--media-image', media('a'), '--compose', croveCompose]).status).toBe(0);
    const v2Ludy = deploy('v1.1.0', 'b', {
      STUB_VOLUMES: 'crove_db-data ludy_db-data',
      STUB_PG_CLUSTER_IDS: 'crove_db-data=c1 ludy_db-data=c1',
    });
    expect(v2Ludy.status, v2Ludy.out).toBe(0);
    expect(readFileSync(`${dir}/.deploy/project`, 'utf8').trim()).toBe('ludy');

    writeFileSync(`${log}.project`, '');
    const back = run(['rollback'], { STUB_LOG_PROJECT: '1' });
    expect(back.status, back.out).toBe(0);
    const rollbackProjects = readFileSync(`${log}.project`, 'utf8').split('\n').filter(Boolean);
    expect(rollbackProjects.some((l) => l === 'project ludy up' || l === 'project ludy port')).toBe(true);
    expect(rollbackProjects.filter((l) => l !== 'project  config').every((l) => l.startsWith('project ludy '))).toBe(true);
    expect(running()).toContain('name: ludy');

    // Plain `docker compose config` (without -p or COMPOSE_PROJECT_NAME in .env) stays on project ludy after rollback.
    const plainCfg = spawnSync('docker', ['compose', '--env-file', `${dir}/.env`, '-f', `${dir}/docker-compose.yml`, '-f', `${dir}/docker-compose.override.yml`, 'config'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${join(root, 'bin')}${delimiter}${process.env['PATH'] ?? ''}`, STUB_LOG: log, STUB_DEPLOY_DIR: dir },
    });
    expect(plainCfg.status, plainCfg.stderr).toBe(0);
    expect(plainCfg.stdout).toMatch(/^name: ludy$/m);
  });

  it('refuses retired CROVE_DEPLOY_DIR / CROVE_ENV_FILE, pre-Stage-7 --compose files, HostConfig.Mounts subpaths, split api/worker mismatches, and handles custom PGDATA (#3972)', () => {
    const croveCompose = `${root}/docker-compose.crove.yml`;
    writeFileSync(croveCompose, 'name: crove\nservices:\n  crove:\n  crove-extract:\n  crove-media:\n');
    const preStage7Compose = run(['deploy', '--release', 'v1.0.0', '--image', image('a'), '--extract-image', extract('a'), '--media-image', media('a'), '--compose', croveCompose]);
    expect(preStage7Compose.status, preStage7Compose.out).toBe(2);
    expect(preStage7Compose.out).toContain("defines pre-Stage-7 service 'crove' without 'ludy'");
    expect(existsSync(`${dir}/releases/${releaseDir('v1.0.0', 'a')}`)).toBe(false);

    // Retired CROVE_DEPLOY_DIR and CROVE_ENV_FILE fail closed unless overridden by LUDY_* or CLI flags.
    const binEnv = {
      ...process.env,
      PATH: `${join(root, 'bin')}${delimiter}${process.env['PATH'] ?? ''}`,
      STUB_LOG: log,
      STUB_DEPLOY_DIR: dir,
    };
    const retiredDirEnv: Record<string, string | undefined> = { ...binEnv, CROVE_DEPLOY_DIR: '/opt/crove' };
    delete retiredDirEnv['LUDY_DEPLOY_DIR'];
    const statusRetired = spawnSync('bash', [script, 'status'], { encoding: 'utf8', env: retiredDirEnv });
    expect(statusRetired.status).toBe(2);
    expect(`${statusRetired.stdout}${statusRetired.stderr}`).toContain('CROVE_DEPLOY_DIR is retired');

    const statusCli = spawnSync('bash', [script, 'status', '--dir', dir], { encoding: 'utf8', env: retiredDirEnv });
    expect(statusCli.status).toBe(0);

    const retiredFileEnv: Record<string, string | undefined> = { ...binEnv, LUDY_DEPLOY_DIR: dir, CROVE_ENV_FILE: `${root}/old.env` };
    delete retiredFileEnv['LUDY_ENV_FILE'];
    const rollbackRetiredEnvFile = spawnSync('bash', [script, 'rollback'], { encoding: 'utf8', env: retiredFileEnv });
    expect(rollbackRetiredEnvFile.status).toBe(2);
    expect(`${rollbackRetiredEnvFile.stdout}${rollbackRetiredEnvFile.stderr}`).toContain('CROVE_ENV_FILE is retired');

    // Existing container with VolumeOptions.Subpath in HostConfig.Mounts still fails closed even after compose subpath is removed.
    writeFileSync(`${dir}/docker-compose.yml`, 'name: ludy\nservices: {}\n');
    const hcSubpathBlocked = deploy('v1.0.0', 'a', {
      STUB_WORKDIR_CONTAINERS: `${dir}|db|ludy-db-1`,
      STUB_INSPECT_MOUNTS: 'ludy-db-1|ludy|volume|ludy_db-data||/var/lib/postgresql/data',
      STUB_INSPECT_HOSTCONFIG_MOUNTS: 'ludy-db-1|[{"Type":"volume","Source":"ludy_db-data","Target":"/var/lib/postgresql/data","VolumeOptions":{"Subpath":"pg17"}}]',
    });
    expect(hcSubpathBlocked.status, hcSubpathBlocked.out).toBe(1);
    expect(hcSubpathBlocked.out).toContain('unsupported volume subpath mount on /var/lib/postgresql/data');

    // Split api/worker persistent mount parity checks.
    rmSync(`${dir}/docker-compose.yml`);
    const localFilesMismatch = deploy('v1.0.0', 'a', {
      STUB_SPLIT_PILOT_SERVICES: '1',
      STUB_NEW_API_FILES_VOL_NAME: 'ludy_files_a',
      STUB_NEW_WORKER_FILES_VOL_NAME: 'ludy_files_b',
    });
    expect(localFilesMismatch.status, localFilesMismatch.out).toBe(1);
    expect(localFilesMismatch.out).toContain('api and worker mount different /data/files storage');

    const localFilesOmitted = deploy('v1.0.0', 'a', {
      STUB_SPLIT_PILOT_SERVICES: '1',
      STUB_OMIT_NEW_WORKER_FILES_MOUNT: '1',
    });
    expect(localFilesOmitted.status, localFilesOmitted.out).toBe(1);
    expect(localFilesOmitted.out).toContain('must share the same persistent /data/files mount');

    const s3KeysMismatch = deploy('v1.0.0', 'a', {
      STUB_SPLIT_PILOT_SERVICES: '1',
      STUB_NEW_STORAGE: 's3',
      STUB_NEW_API_FILES_VOL_NAME: 'ludy_files_a',
      STUB_NEW_WORKER_FILES_VOL_NAME: 'ludy_files_b',
      STUB_NEW_API_KEYS_VOL_NAME: 'ludy_keys_a',
      STUB_NEW_WORKER_KEYS_VOL_NAME: 'ludy_keys_b',
    });
    expect(s3KeysMismatch.status, s3KeysMismatch.out).toBe(1);
    expect(s3KeysMismatch.out).toContain('api and worker mount different /data/keys storage');

    const archiveMismatch = deploy('v1.0.0', 'a', {
      STUB_SPLIT_PILOT_SERVICES: '1',
      STUB_NEW_API_ARCHIVE_VOL_NAME: 'ludy_api_archive',
    });
    expect(archiveMismatch.status, archiveMismatch.out).toBe(1);
    expect(archiveMismatch.out).toContain('api and worker mount different /data/archive storage');

    const s3FilesAllowed = deploy('v1.0.0', 'a', {
      STUB_SPLIT_PILOT_SERVICES: '1',
      STUB_NEW_STORAGE: 's3',
      STUB_NEW_API_FILES_VOL_NAME: 'ludy_files_a',
      STUB_NEW_WORKER_FILES_VOL_NAME: 'ludy_files_b',
    });
    expect(s3FilesAllowed.status, s3FilesAllowed.out).toBe(0);

    // Re-deploying the same split S3 /data/files mounts keeps both populated volumes without demanding cross-copy.
    const s3FilesRedeploy = deploy('v1.1.0', 'b', {
      STUB_SPLIT_PILOT_SERVICES: '1',
      STUB_NEW_STORAGE: 's3',
      STUB_NEW_API_FILES_VOL_NAME: 'ludy_files_a',
      STUB_NEW_WORKER_FILES_VOL_NAME: 'ludy_files_b',
      STUB_VOLUMES: 'ludy_db-data ludy_files_a ludy_files_b',
      STUB_POPULATED_MOUNTS: 'ludy_files_a ludy_files_b',
    });
    expect(s3FilesRedeploy.status, s3FilesRedeploy.out).toBe(0);

    // Custom PGDATA subdir passes when both match and blocks when PGDATA changes on same or new volume.
    rmSync(`${dir}/.deploy`, { recursive: true, force: true });
    rmSync(`${dir}/docker-compose.yml`, { force: true });
    writeFileSync(`${dir}/docker-compose.yml`, 'name: crove\nservices: {}\n');
    writeFileSync(`${log}.volumes`, '');
    const customPgOk = deploy('v1.0.0', 'a', {
      STUB_VOLUMES: 'crove_db-data ludy_db-data',
      STUB_PG_CLUSTER_IDS: 'crove_db-data=c1 ludy_db-data=c1',
      STUB_PREV_DB_PGDATA: '/var/lib/postgresql/data/pgdata',
      STUB_NEW_DB_PGDATA: '/var/lib/postgresql/data/pgdata',
      STUB_PG_SUBDIR_MOUNTS: 'crove_db-data=pgdata ludy_db-data=pgdata',
    });
    expect(customPgOk.status, customPgOk.out).toBe(0);
    expect(readFileSync(`${log}.volumes`, 'utf8')).toContain('SRC_PGDATA_SUB=pgdata');
    expect(readFileSync(`${log}.volumes`, 'utf8')).toContain('DST_PGDATA_SUB=pgdata');

    rmSync(`${dir}/.deploy`, { recursive: true, force: true });
    rmSync(`${dir}/docker-compose.yml`, { force: true });
    writeFileSync(`${dir}/docker-compose.yml`, 'name: crove\nservices: {}\n');
    const customPgChangedOnSameVol = deploy('v1.0.0', 'a', {
      STUB_VOLUMES: 'crove_db-data',
      STUB_PG_CLUSTER_IDS: 'crove_db-data=c1',
      STUB_NEW_DB_VOLUME: 'crove_db-data',
      STUB_PREV_DB_PGDATA: '/var/lib/postgresql/data/pgdata',
      STUB_PG_SUBDIR_MOUNTS: 'crove_db-data=pgdata',
    });
    expect(customPgChangedOnSameVol.status, customPgChangedOnSameVol.out).toBe(1);
    expect(customPgChangedOnSameVol.out).toContain('PGDATA /var/lib/postgresql/data/pgdata');

    const badPgdata = deploy('v1.0.0', 'a', {
      STUB_NEW_DB_PGDATA: '/var/lib/postgresql/outside',
    });
    expect(badPgdata.status, badPgdata.out).toBe(1);
    expect(badPgdata.out).toContain('unsupported PGDATA path outside /var/lib/postgresql/data');

    // Container PGDATA in .Config.Env catches in-place compose.host.yml PGDATA edit on same volume,
    // and persists PGDATA_SUB in .deploy/mounts after containers are gone (#3972 Round 10).
    rmSync(`${dir}/.deploy`, { recursive: true, force: true });
    rmSync(`${dir}/docker-compose.yml`, { force: true });
    writeFileSync(`${dir}/docker-compose.yml`, 'name: ludy\nservices: {}\n');
    const ctrPgChanged = deploy('v1.0.0', 'a', {
      STUB_VOLUMES: 'ludy_db-data',
      STUB_PG_CLUSTER_IDS: 'ludy_db-data=c1',
      STUB_WORKDIR_CONTAINERS: `${dir}|db|ludy-db-1`,
      STUB_INSPECT_MOUNTS: 'ludy-db-1|ludy|volume|ludy_db-data||/var/lib/postgresql/data',
      STUB_INSPECT_ENV: 'ludy-db-1|PGDATA=/var/lib/postgresql/data/a',
      STUB_NEW_DB_PGDATA: '/var/lib/postgresql/data/b',
      STUB_PG_SUBDIR_MOUNTS: 'ludy_db-data=a',
    });
    expect(ctrPgChanged.status, ctrPgChanged.out).toBe(1);
    expect(ctrPgChanged.out).toContain('PGDATA /var/lib/postgresql/data/a while new config uses /var/lib/postgresql/data/b');

    rmSync(`${dir}/docker-compose.yml`);
    const persistedPgOk = deploy('v1.0.0', 'a', {
      STUB_VOLUMES: 'ludy_db-data',
      STUB_NEW_DB_PGDATA: '/var/lib/postgresql/data/a',
    });
    expect(persistedPgOk.status, persistedPgOk.out).toBe(0);
    expect(readFileSync(`${dir}/.deploy/mounts`, 'utf8')).toContain('PGDATA_SUB=a');

    const persistedPgChanged = deploy('v1.1.0', 'b', {
      STUB_VOLUMES: 'ludy_db-data',
      STUB_PG_CLUSTER_IDS: 'ludy_db-data=c1',
      STUB_NEW_DB_PGDATA: '/var/lib/postgresql/data/b',
      STUB_PG_SUBDIR_MOUNTS: 'ludy_db-data=a',
    });
    expect(persistedPgChanged.status, persistedPgChanged.out).toBe(1);
    expect(persistedPgChanged.out).toContain('PGDATA /var/lib/postgresql/data/a while new config uses /var/lib/postgresql/data/b');

    // Same Compose project name (`ludy`) from a different working directory still blocks shared storage (#3972 Round 10).
    rmSync(`${dir}/.deploy`, { recursive: true, force: true });
    rmSync(`${dir}/docker-compose.yml`, { force: true });
    const otherDirCollision = deploy('v1.0.0', 'a', {
      STUB_VOLUMES: 'ludy_db-data',
      STUB_RUNNING_CONTAINERS: 'other-ludy-db-1',
      STUB_INSPECT_MOUNTS: 'other-ludy-db-1|ludy|volume|ludy_db-data|',
      STUB_INSPECT_WORKDIRS: 'other-ludy-db-1|/opt/other-ludy',
    });
    expect(otherDirCollision.status, otherDirCollision.out).toBe(1);
    expect(otherDirCollision.out).toContain(`outside project ludy (${dir})`);

    // Same project + matching working_dir IS exempt on normal re-deploy.
    const sameDirRunningOk = deploy('v1.0.0', 'a', {
      STUB_VOLUMES: 'ludy_db-data',
      STUB_RUNNING_CONTAINERS: 'ludy-db-1',
      STUB_INSPECT_MOUNTS: 'ludy-db-1|ludy|volume|ludy_db-data|',
      STUB_INSPECT_WORKDIRS: `ludy-db-1|${dir}`,
    });
    expect(sameDirRunningOk.status, sameDirRunningOk.out).toBe(0);

    // Pre-up-db aborted deploy after rolling back to legacy `name: crove` preserves `name: ludy` in docker-compose.override.yml (#3972 Round 10).
    rmSync(`${dir}/.deploy`, { recursive: true, force: true });
    rmSync(`${dir}/docker-compose.yml`, { force: true });
    const croveLegacy = `${root}/legacy-base.yml`;
    writeFileSync(croveLegacy, 'name: crove\nservices: {}\n');
    expect(run(['deploy', '--release', 'v1.0.0', '--image', image('a'), '--extract-image', extract('a'), '--media-image', media('a'), '--compose', croveLegacy]).status).toBe(0);
    expect(deploy('v1.1.0', 'b', { STUB_VOLUMES: 'crove_db-data ludy_db-data', STUB_PG_CLUSTER_IDS: 'crove_db-data=c1 ludy_db-data=c1' }).status).toBe(0);
    expect(run(['rollback']).status).toBe(0);
    expect(running()).toContain('name: ludy');

    const abortedNext = deploy('v1.2.0', 'c', { STUB_NEW_DB_SUBPATH: 'pg17' });
    expect(abortedNext.status).toBe(1);
    expect(running()).toContain('name: ludy');
    const afterAbortPlainCfg = spawnSync('docker', ['compose', '--env-file', `${dir}/.env`, '-f', `${dir}/docker-compose.yml`, '-f', `${dir}/docker-compose.override.yml`, 'config'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${join(root, 'bin')}${delimiter}${process.env['PATH'] ?? ''}`, STUB_LOG: log, STUB_DEPLOY_DIR: dir },
    });
    expect(afterAbortPlainCfg.status, afterAbortPlainCfg.stderr).toBe(0);
    expect(afterAbortPlainCfg.stdout).toMatch(/^name: ludy$/m);

    // Rollback to legacy `name: crove` fails closed when COMPOSE_FILE omits docker-compose.override.yml and defines no COMPOSE_PROJECT_NAME,
    // and succeeds once COMPOSE_PROJECT_NAME=ludy is set (#3972 Round 11).
    // Roll back to v1.1.0 (name: ludy) first so `previous` is again the legacy v1.0.0 (name: crove) release.
    expect(run(['rollback']).status).toBe(0);
    writeFileSync(`${dir}/compose.host.yml`, 'services: {}\n');
    writeFileSync(`${dir}/.env`, 'POSTGRES_PASSWORD=x\nLUDY_CONTEXT_TOKEN_KEY=already-here\nCOMPOSE_FILE=docker-compose.yml:compose.host.yml\n');
    const unsafeRollback = run(['rollback']);
    expect(unsafeRollback.status, unsafeRollback.out).toBe(2);
    expect(unsafeRollback.out).toContain('omits docker-compose.override.yml and defines no COMPOSE_PROJECT_NAME');
    writeFileSync(`${dir}/.env`, 'POSTGRES_PASSWORD=x\nLUDY_CONTEXT_TOKEN_KEY=already-here\nCOMPOSE_FILE=docker-compose.yml:compose.host.yml\nCOMPOSE_PROJECT_NAME=ludy\n');
    expect(run(['rollback']).status).toBe(0);
    rmSync(`${dir}/compose.host.yml`, { force: true });

    // Nested mount under /var/lib/postgresql/data/pgdata is rejected before up db (#3972 Round 11).
    writeFileSync(`${dir}/.env`, 'POSTGRES_PASSWORD=x\n');
    rmSync(`${dir}/.deploy`, { recursive: true, force: true });
    rmSync(`${dir}/docker-compose.yml`, { force: true });
    const nestedDb = deploy('v1.0.0', 'a', { STUB_NEW_DB_NESTED_MOUNT: '/var/lib/postgresql/data/pgdata' });
    expect(nestedDb.status, nestedDb.out).toBe(1);
    expect(nestedDb.out).toContain('unsupported nested mount at /var/lib/postgresql/data/pgdata');

    // Leftover restore-drill container (`project=ludy-restore-test`) in same working_dir does not pollute real stack (#3972 Round 11).
    rmSync(`${dir}/.deploy`, { recursive: true, force: true });
    rmSync(`${dir}/docker-compose.yml`, { force: true });
    expect(deploy('v1.0.0', 'a', { STUB_VOLUMES: 'ludy_db-data' }).status).toBe(0);
    const drillIgnored = deploy('v1.1.0', 'b', {
      STUB_VOLUMES: 'ludy_db-data',
      STUB_WORKDIR_CONTAINERS: `${dir}|db|drill-db-1 ${dir}|db|ludy-db-1`,
      STUB_INSPECT_MOUNTS: 'drill-db-1|ludy-restore-test|volume|drill_db-data||/var/lib/postgresql/data ludy-db-1|ludy|volume|ludy_db-data||/var/lib/postgresql/data',
    });
    expect(drillIgnored.status, drillIgnored.out).toBe(0);

    // Image ENV PGDATA fallback matches running container PGDATA when Compose YAML omits PGDATA (#3972 Round 11).
    rmSync(`${dir}/.deploy`, { recursive: true, force: true });
    rmSync(`${dir}/docker-compose.yml`, { force: true });
    const imgPgdataOk = deploy('v1.0.0', 'a', {
      STUB_VOLUMES: 'ludy_db-data',
      STUB_NEW_DB_IMAGE: 'custom-pg:17',
      STUB_IMAGE_PGDATA: 'custom-pg:17=/var/lib/postgresql/data/pgdata',
      STUB_WORKDIR_CONTAINERS: `${dir}|db|ludy-db-1`,
      STUB_INSPECT_MOUNTS: 'ludy-db-1|ludy|volume|ludy_db-data||/var/lib/postgresql/data',
      STUB_INSPECT_ENV: 'ludy-db-1|PGDATA=/var/lib/postgresql/data/pgdata',
    });
    expect(imgPgdataOk.status, imgPgdataOk.out).toBe(0);
    expect(readFileSync(`${dir}/.deploy/mounts`, 'utf8')).toContain('PGDATA_SUB=pgdata');

    // Missing $DEPLOY_DIR/docker-compose.yml still verifies prior storage via staged release, .deploy/mounts, or containers (#3972 Round 13).
    rmSync(`${dir}/.deploy`, { recursive: true, force: true });
    rmSync(`${dir}/docker-compose.yml`, { force: true });
    expect(deploy('v1.0.0', 'a', { STUB_VOLUMES: 'ludy_db-data' }).status).toBe(0);
    const croveRelCompose = `${root}/crove-prev.yml`;
    writeFileSync(croveRelCompose, 'name: crove\nservices: {}\n');
    const prevRelName = releaseDir('v1.0.0', 'a');
    rmSync(`${dir}/docker-compose.yml`, { force: true });
    writeFileSync(`${dir}/.deploy/project`, 'crove\n');
    writeFileSync(`${dir}/.deploy/mounts`, '/var/lib/postgresql/data=volume:crove_db-data\nPGDATA_SUB=\n');
    writeFileSync(`${dir}/releases/${prevRelName}/docker-compose.yml`, readFileSync(croveRelCompose, 'utf8'));
    const missingRootViaRel = deploy('v1.1.0', 'b', {
      STUB_VOLUMES: 'crove_db-data',
      STUB_PG_CLUSTER_IDS: 'crove_db-data=c1',
    });
    expect(missingRootViaRel.status, missingRootViaRel.out).toBe(1);
    expect(missingRootViaRel.out).toContain('without a matching copied PostgreSQL cluster in ludy_db-data');

    // Missing both root and release compose files still blocks via .deploy/mounts, via containers, or fails closed if mounts missing.
    rmSync(`${dir}/docker-compose.yml`, { force: true });
    rmSync(`${dir}/releases/${prevRelName}/docker-compose.yml`, { force: true });
    const missingComposeViaMounts = deploy('v1.1.0', 'b', {
      STUB_VOLUMES: 'crove_db-data',
      STUB_PG_CLUSTER_IDS: 'crove_db-data=c1',
    });
    expect(missingComposeViaMounts.status, missingComposeViaMounts.out).toBe(1);
    expect(missingComposeViaMounts.out).toContain('without a matching copied PostgreSQL cluster in ludy_db-data');

    rmSync(`${dir}/docker-compose.yml`, { force: true });
    rmSync(`${dir}/.deploy/mounts`, { force: true });
    rmSync(`${dir}/.deploy/current`, { force: true });
    const missingComposeNoMounts = deploy('v1.1.0', 'b');
    expect(missingComposeNoMounts.status, missingComposeNoMounts.out).toBe(1);
    expect(missingComposeNoMounts.out).toContain('without docker-compose.yml or recorded database storage mounts');

    rmSync(`${dir}/.deploy`, { recursive: true, force: true });
    rmSync(`${dir}/docker-compose.yml`, { force: true });
    const missingComposeViaCtr = deploy('v1.0.0', 'a', {
      STUB_WORKDIR_CONTAINERS: `${dir}|db|crove-db-1`,
      STUB_INSPECT_MOUNTS: 'crove-db-1|crove|volume|crove_db-data||/var/lib/postgresql/data',
      STUB_VOLUMES: 'crove_db-data',
      STUB_PG_CLUSTER_IDS: 'crove_db-data=c1',
    });
    expect(missingComposeViaCtr.status, missingComposeViaCtr.out).toBe(1);
    expect(missingComposeViaCtr.out).toContain('without a matching copied PostgreSQL cluster in ludy_db-data');

    // Unpulled target db image fails closed when inspect+pull fail, and pulls + reads ENV PGDATA when pull succeeds (#3972 Round 13).
    rmSync(`${dir}/.deploy`, { recursive: true, force: true });
    rmSync(`${dir}/docker-compose.yml`, { force: true });
    const unpulledFail = deploy('v1.0.0', 'a', {
      STUB_NEW_DB_IMAGE: 'unpulled-pg:17',
      STUB_IMAGE_INSPECT_FAIL: 'unpulled-pg:17',
      STUB_PULL_FAIL_IMAGES: 'unpulled-pg:17',
    });
    expect(unpulledFail.status, unpulledFail.out).toBe(1);
    expect(unpulledFail.out).toContain('cannot inspect target db image metadata to determine PGDATA');

    const unpulledPulled = deploy('v1.0.0', 'a', {
      STUB_NEW_DB_IMAGE: 'unpulled-pg:17',
      STUB_IMAGE_INSPECT_FAIL: 'unpulled-pg:17',
      STUB_PULL_RESOLVES_IMAGE_INSPECT: '1',
      STUB_IMAGE_PGDATA: 'unpulled-pg:17=/var/lib/postgresql/data/pg17custom',
    });
    expect(unpulledPulled.status, unpulledPulled.out).toBe(0);
    expect(readFileSync(`${dir}/.deploy/mounts`, 'utf8')).toContain('PGDATA_SUB=pg17custom');

    // Rollback fails closed if .env or an override file sets a conflicting project for plain docker compose (#3972 Round 13).
    rmSync(`${dir}/.deploy`, { recursive: true, force: true });
    rmSync(`${dir}/docker-compose.yml`, { force: true });
    writeFileSync(`${dir}/.env`, 'POSTGRES_PASSWORD=x\n');
    expect(deploy('v1.0.0', 'a').status).toBe(0);
    expect(deploy('v1.1.0', 'b').status).toBe(0);
    writeFileSync(`${dir}/.env`, 'POSTGRES_PASSWORD=x\nCOMPOSE_PROJECT_NAME=crove\n');
    const rbEnvConflict = run(['rollback']);
    expect(rbEnvConflict.status, rbEnvConflict.out).toBe(2);
    expect(rbEnvConflict.out).toContain('sets COMPOSE_PROJECT_NAME=crove');

    writeFileSync(`${dir}/.env`, 'POSTGRES_PASSWORD=x\nCOMPOSE_FILE=docker-compose.yml:docker-compose.override.yml:compose.host.yml\n');
    writeFileSync(`${dir}/compose.host.yml`, 'name: crove\nservices: {}\n');
    const rbHostConflict = run(['rollback']);
    expect(rbHostConflict.status, rbHostConflict.out).toBe(2);
    expect(rbHostConflict.out).toContain("resolves plain docker compose to project 'crove'");
    rmSync(`${dir}/compose.host.yml`, { force: true });

    // SIGTERM after activate during pre-up-db checks restores the original compose files via cleanup (#3972 Round 13).
    rmSync(`${dir}/.deploy`, { recursive: true, force: true });
    rmSync(`${dir}/docker-compose.yml`, { force: true });
    rmSync(`${dir}/docker-compose.override.yml`, { force: true });
    writeFileSync(`${dir}/.env`, 'POSTGRES_PASSWORD=x\n');
    const preSignalCompose = '# pre-deploy sentinel\nname: crove\nservices: {}\n';
    writeFileSync(`${dir}/docker-compose.yml`, preSignalCompose);
    const sigBin = `${root}/sigbin`;
    mkdirSync(sigBin, { recursive: true });
    writeFileSync(
      `${sigBin}/docker`,
      [
        '#!/usr/bin/env bash',
        'if [ "${1:-}" = volume ] && [ "${2:-}" = inspect ]; then',
        '  pid="$(cat "${STUB_DEPLOY_DIR}/.deploy/lock/pid" 2>/dev/null || true)"',
        '  if [ -n "$pid" ]; then kill -TERM "$pid" 2>/dev/null || true; fi',
        'fi',
        `exec "${root}/bin/docker" "$@"`,
        '',
      ].join('\n'),
    );
    chmodSync(`${sigBin}/docker`, 0o755);
    const sigRes = spawnSync(
      'bash',
      [script, 'deploy', '--release', 'v1.0.0', '--image', image('a'), '--extract-image', extract('a'), '--media-image', media('a'), '--compose', compose],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${sigBin}${delimiter}${join(root, 'bin')}${delimiter}${process.env['PATH'] ?? ''}`,
          LUDY_DEPLOY_DIR: dir,
          LUDY_READY_TIMEOUT: '1',
          LUDY_WORKER_SETTLE: '0',
          STUB_LOG: log,
          STUB_DEPLOY_DIR: dir,
          STUB_OPENSSL_KEY_FILE: `${root}/openssl-key`,
          STUB_AUTH_ENABLE: '0',
          STUB_WAIT_TIMEOUT: '1',
          STUB_VOLUMES: 'crove_db-data',
        },
      },
    );
    expect(sigRes.status).toBe(143);
    expect(readFileSync(`${dir}/docker-compose.yml`, 'utf8')).toBe(preSignalCompose);
    expect(existsSync(`${dir}/docker-compose.override.yml`)).toBe(false);
    expect(existsSync(`${dir}/.deploy/lock`)).toBe(false);

    // Rollback fails closed on stale/mismatched /data/files volume, PGDATA change, or missing COMPOSE_FILE entry (#3972 Round 14).
    rmSync(`${dir}/.deploy`, { recursive: true, force: true });
    rmSync(`${dir}/docker-compose.yml`, { force: true });
    writeFileSync(`${dir}/.env`, 'POSTGRES_PASSWORD=x\n');
    expect(deploy('v1.0.0', 'a', { STUB_VOLUMES: 'ludy_db-data ludy_files' }).status).toBe(0);
    expect(
      deploy('v1.1.0', 'b', {
        STUB_VOLUMES: 'ludy_db-data ludy_files ludy_files_v2',
        STUB_POPULATED_MOUNTS: 'ludy_files ludy_files_v2',
        STUB_NEW_FILES_VOLUME: 'ludy_files_v2',
      }).status,
    ).toBe(0);
    const rbStaleFiles = run(['rollback'], {
      STUB_VOLUMES: 'ludy_db-data ludy_files ludy_files_v2',
      STUB_POPULATED_MOUNTS: 'ludy_files ludy_files_v2',
      STUB_PARTIAL_MOUNTS: 'ludy_files',
      STUB_NEW_FILES_VOLUME: 'ludy_files',
    });
    expect(rbStaleFiles.status, rbStaleFiles.out).toBe(1);
    expect(rbStaleFiles.out).toContain('rollback would revert to stale data');
    expect(readFileSync(`${dir}/.deploy/current`, 'utf8').trim()).toBe(releaseDir('v1.1.0', 'b'));

    // Cross-volume rollback fails closed when an active (running, paused, or restarting) container still mounts the active volume (#3972 Round 15).
    const rbBusyFiles = run(['rollback'], {
      STUB_VOLUMES: 'ludy_db-data ludy_files ludy_files_v2',
      STUB_POPULATED_MOUNTS: 'ludy_files ludy_files_v2',
      STUB_NEW_FILES_VOLUME: 'ludy_files',
      STUB_PAUSED_CONTAINERS: 'live-api-1',
      STUB_INSPECT_MOUNTS: 'live-api-1|ludy|volume|ludy_files_v2||',
    });
    expect(rbBusyFiles.status, rbBusyFiles.out).toBe(1);
    expect(rbBusyFiles.out).toContain('still mounted by a running, paused, or restarting container');

    const rbPgdataChange = run(['rollback'], {
      STUB_VOLUMES: 'ludy_db-data',
      STUB_NEW_DB_PGDATA: '/var/lib/postgresql/data/other',
    });
    expect(rbPgdataChange.status, rbPgdataChange.out).toBe(1);
    expect(rbPgdataChange.out).toContain('PGDATA /var/lib/postgresql/data/other');

    writeFileSync(`${dir}/.env`, 'POSTGRES_PASSWORD=x\nCOMPOSE_FILE=docker-compose.yml:docker-compose.override.yml:compose.host.yml\n');
    const rbMissingHostFile = run(['rollback']);
    expect(rbMissingHostFile.status, rbMissingHostFile.out).toBe(2);
    expect(rbMissingHostFile.out).toContain(`plain docker compose in ${dir} resolves to project`);
    writeFileSync(`${dir}/.env`, 'POSTGRES_PASSWORD=x\n');

    // Parent/child bind paths and symlinked bind mounts collide cleanly in check_storage_free without false-positiving on siblings (#3972 Round 14).
    rmSync(`${dir}/.deploy`, { recursive: true, force: true });
    rmSync(`${dir}/docker-compose.yml`, { force: true });
    const parentBind = `${root}/srv-db`;
    const childBind = `${parentBind}/pgdata`;
    const siblingBind = `${root}/srv-db2`;
    const linkBind = `${root}/srv-db-link`;
    mkdirSync(childBind, { recursive: true });
    mkdirSync(siblingBind, { recursive: true });
    symlinkSync(parentBind, linkBind);
    const parentHeld = deploy('v1.0.0', 'a', {
      STUB_NEW_DB_BIND: childBind,
      STUB_RUNNING_CONTAINERS: 'other-db-1',
      STUB_INSPECT_WORKDIRS: 'other-db-1|/opt/other',
      STUB_INSPECT_MOUNTS: `other-db-1|other|bind||${parentBind}|`,
    });
    expect(parentHeld.status, parentHeld.out).toBe(1);
    expect(parentHeld.out).toContain('still mounted by a running container outside project');

    const childHeld = deploy('v1.0.0', 'a', {
      STUB_NEW_DB_BIND: linkBind,
      STUB_RUNNING_CONTAINERS: 'other-db-1',
      STUB_INSPECT_WORKDIRS: 'other-db-1|/opt/other',
      STUB_INSPECT_MOUNTS: `other-db-1|other|bind||${childBind}|`,
    });
    expect(childHeld.status, childHeld.out).toBe(1);
    expect(childHeld.out).toContain('still mounted by a running container outside project');

    const siblingFree = deploy('v1.0.0', 'a', {
      STUB_NEW_DB_BIND: siblingBind,
      STUB_RUNNING_CONTAINERS: 'other-db-1',
      STUB_INSPECT_WORKDIRS: 'other-db-1|/opt/other',
      STUB_INSPECT_MOUNTS: `other-db-1|other|bind||${parentBind}|`,
    });
    expect(siblingFree.status, siblingFree.out).toBe(0);

    // Paused and restarting containers block storage cutover just like running containers (#3972 Round 15).
    for (const [label, statusEnv] of [
      ['paused', { STUB_PAUSED_CONTAINERS: 'paused-db-1' }],
      ['restarting', { STUB_RESTARTING_CONTAINERS: 'restarting-db-1' }],
    ] as const) {
      rmSync(`${dir}/.deploy`, { recursive: true, force: true });
      rmSync(`${dir}/docker-compose.yml`, { force: true });
      const cid = label === 'paused' ? 'paused-db-1' : 'restarting-db-1';
      const activeHeld = deploy('v1.0.0', 'a', {
        STUB_NEW_DB_BIND: childBind,
        ...statusEnv,
        STUB_INSPECT_WORKDIRS: `${cid}|/opt/other`,
        STUB_INSPECT_MOUNTS: `${cid}|other|bind||${parentBind}|`,
      });
      expect(activeHeld.status, `${label}: ${activeHeld.out}`).toBe(1);
      expect(activeHeld.out).toContain('still mounted by a running container outside project');
    }

    // Stopped container owned by another working directory under COMPOSE_PROJECT_NAME=ludy blocks BOTH deploy and rollback even with non-overlapping storage (#3972 Round 16).
    rmSync(`${dir}/.deploy`, { recursive: true, force: true });
    rmSync(`${dir}/docker-compose.yml`, { force: true });
    const foreignDeploy = deploy('v1.0.0', 'a', {
      STUB_PROJECT_CONTAINERS: 'ludy|other-stopped-db-1',
      STUB_INSPECT_WORKDIRS: 'other-stopped-db-1|/opt/other-ludy',
    });
    expect(foreignDeploy.status, foreignDeploy.out).toBe(1);
    expect(foreignDeploy.out).toContain("Compose project 'ludy' is already owned by another installation at /opt/other-ludy");

    expect(deploy('v1.0.0', 'a', { STUB_PROJECT_CONTAINERS: 'ludy|own-db-1', STUB_INSPECT_WORKDIRS: `own-db-1|${dir}` }).status).toBe(0);
    expect(deploy('v1.1.0', 'b').status).toBe(0);
    const foreignRollback = run(['rollback'], {
      STUB_PROJECT_CONTAINERS: 'ludy|other-stopped-db-1',
      STUB_INSPECT_WORKDIRS: 'other-stopped-db-1|/opt/other-ludy',
    });
    expect(foreignRollback.status, foreignRollback.out).toBe(1);
    expect(foreignRollback.out).toContain("Compose project 'ludy' is already owned by another installation at /opt/other-ludy");

    // Round 17 regressions (#3972 Round 17):
    // 1) Auto-recover refuses to revert to an older release when the failed deploy used a copied /data/files volume with unmigrated data.
    rmSync(`${dir}/.deploy`, { recursive: true, force: true });
    rmSync(`${dir}/docker-compose.yml`, { force: true });
    writeFileSync(`${dir}/.env`, 'POSTGRES_PASSWORD=x\n');
    const filesMapEnv = `${digest('a')}=ludy_files ${digest('b')}=ludy_files_v2`;
    expect(deploy('v1.0.0', 'a', { STUB_VOLUMES: 'ludy_db-data ludy_files', STUB_FILES_VOL_BY_DIGEST: filesMapEnv }).status).toBe(0);
    const autoRecBlocked = deploy('v1.1.0', 'b', {
      STUB_VOLUMES: 'ludy_db-data ludy_files ludy_files_v2',
      STUB_POPULATED_MOUNTS: 'ludy_files ludy_files_v2',
      STUB_PARTIAL_MOUNTS: 'ludy_files',
      STUB_FILES_VOL_BY_DIGEST: filesMapEnv,
      STUB_BAD_DIGEST: digest('b'),
    });
    expect(autoRecBlocked.status, autoRecBlocked.out).toBe(3);
    expect(autoRecBlocked.out).toContain('automatic rollback');
    expect(autoRecBlocked.out).toContain('rollback would revert to stale data');
    expect(running()).toContain(image('b'));
    expect(state('current')).toBe(releaseDir('v1.0.0', 'a'));

    // 2) Cross-project/cross-volume `up db` failure restarts previous `db` before rolling services when new db storage is free,
    // and refuses with exit 3 when the failed new db container still holds the copied storage.
    rmSync(`${dir}/.deploy`, { recursive: true, force: true });
    rmSync(`${dir}/docker-compose.yml`, { force: true });
    const croveBase = `${root}/crove-after-db-fail.yml`;
    writeFileSync(croveBase, 'name: crove\nservices: {}\n');
    expect(run(['deploy', '--release', 'v1.0.0', '--image', image('a'), '--extract-image', extract('a'), '--media-image', media('a'), '--compose', croveBase]).status).toBe(0);
    writeFileSync(`${log}.project`, '');
    writeFileSync(log, '');
    const afterDbRec = deploy('v1.1.0', 'b', {
      STUB_VOLUMES: 'crove_db-data ludy_db-data',
      STUB_PG_CLUSTER_IDS: 'crove_db-data=c1 ludy_db-data=c1',
      STUB_UP_DB_FAIL_PROJ: 'ludy',
      STUB_LOG_PROJECT: '1',
    });
    expect(afterDbRec.status, afterDbRec.out).toBe(1);
    expect(afterDbRec.out).toContain(`rolled back to ${releaseDir('v1.0.0', 'a')}, which serves again`);
    const dbRecCalls = readFileSync(`${log}.project`, 'utf8').split('\n').filter(Boolean);
    const oldDbUpIdx = dbRecCalls.findIndex((l) => l === 'project crove up');
    const firstOldPortIdx = dbRecCalls.findIndex((l) => l === 'project crove port');
    expect(oldDbUpIdx).toBeGreaterThan(-1);
    expect(firstOldPortIdx).toBeGreaterThan(oldDbUpIdx);

    const afterDbHeld = deploy('v1.1.0', 'b', {
      STUB_VOLUMES: 'crove_db-data ludy_db-data',
      STUB_PG_CLUSTER_IDS: 'crove_db-data=c1 ludy_db-data=c1',
      STUB_UP_DB_FAIL_PROJ: 'ludy',
      STUB_RESTARTING_CONTAINERS: 'ludy-restarting-db',
      STUB_INSPECT_WORKDIRS: `ludy-restarting-db|${dir}`,
      STUB_INSPECT_MOUNTS: 'ludy-restarting-db|ludy|volume|ludy_db-data||',
    });
    expect(afterDbHeld.status, afterDbHeld.out).toBe(3);
    expect(afterDbHeld.out).toContain('failed database storage ludy_db-data is still mounted');

    // 3) Valid multiline single-quoted OAUTH_JWKS works in both deploy and rollback.
    rmSync(`${dir}/.deploy`, { recursive: true, force: true });
    rmSync(`${dir}/docker-compose.yml`, { force: true });
    const mlEnv = [
      'POSTGRES_PASSWORD=x',
      'LUDY_CONTEXT_TOKEN_KEY=already-here',
      "OAUTH_JWKS='{\n  \"keys\": [\n    {\"kty\": \"RSA\", \"use\": \"sig\"}\n  ]\n}' # inline comment",
      'COMPOSE_FILE=docker-compose.yml:docker-compose.override.yml',
      '',
    ].join('\n');
    writeFileSync(`${dir}/.env`, mlEnv);
    expect(deploy('v1.0.0', 'a').status).toBe(0);
    expect(deploy('v1.1.0', 'b').status).toBe(0);
    const mlRollback = run(['rollback']);
    expect(mlRollback.status, mlRollback.out).toBe(0);
    expect(readFileSync(`${dir}/.env`, 'utf8')).toBe(mlEnv);

    // 4) Out-of-tree --env-file rollback still checks plain docker compose in $DEPLOY_DIR ($dir/.env) as tools/backup/lib.sh loads it.
    rmSync(`${dir}/.deploy`, { recursive: true, force: true });
    rmSync(`${dir}/docker-compose.yml`, { force: true });
    const extEnv = `${root}/external.env`;
    writeFileSync(`${dir}/.env`, 'POSTGRES_PASSWORD=x\nCOMPOSE_PROJECT_NAME=ludy\n');
    writeFileSync(extEnv, 'POSTGRES_PASSWORD=x\nCOMPOSE_PROJECT_NAME=ludy\n');
    expect(run(['deploy', '--release', 'v1.0.0', '--image', image('a'), '--extract-image', extract('a'), '--media-image', media('a'), '--compose', compose, '--env-file', extEnv]).status).toBe(0);
    expect(run(['deploy', '--release', 'v1.1.0', '--image', image('b'), '--extract-image', extract('b'), '--media-image', media('b'), '--compose', compose, '--env-file', extEnv]).status).toBe(0);
    writeFileSync(`${dir}/.env`, 'POSTGRES_PASSWORD=x\nCOMPOSE_PROJECT_NAME=crove\n');
    const extRollback = run(['rollback', '--env-file', extEnv]);
    expect(extRollback.status, extRollback.out).toBe(2);
    expect(extRollback.out).toContain('sets COMPOSE_PROJECT_NAME=crove');
    writeFileSync(`${dir}/.env`, 'POSTGRES_PASSWORD=x\n');

    // Round 18 regressions (#3972 Round 18):
    // 1) after_db_fail refuses rollback (exit 3) before `up db` if rollback Compose DB volume or PGDATA drifted from pre-deploy state.
    rmSync(`${dir}/.deploy`, { recursive: true, force: true });
    rmSync(`${dir}/docker-compose.yml`, { force: true });
    writeFileSync(croveBase, 'name: crove\nservices: {}\n');
    expect(run(['deploy', '--release', 'v1.0.0', '--image', image('a'), '--extract-image', extract('a'), '--media-image', media('a'), '--compose', croveBase]).status).toBe(0);
    writeFileSync(`${log}.project`, '');
    const driftedDbRec = deploy('v1.1.0', 'b', {
      STUB_VOLUMES: 'crove_db-data crove_drifted-db ludy_db-data',
      STUB_CROVE_DB_VOLUME: 'crove_drifted-db',
      STUB_PG_CLUSTER_IDS: 'crove_db-data=c1 ludy_db-data=c1',
      STUB_UP_DB_FAIL_PROJ: 'ludy',
      STUB_LOG_PROJECT: '1',
    });
    expect(driftedDbRec.status, driftedDbRec.out).toBe(3);
    expect(driftedDbRec.out).toContain('does not match pre-deploy database storage');
    expect(readFileSync(`${log}.project`, 'utf8').split('\n')).not.toContain('project crove up');

    const driftedPgRec = deploy('v1.1.0', 'b', {
      STUB_VOLUMES: 'crove_db-data ludy_db-data',
      STUB_PREV_DB_PGDATA: '/var/lib/postgresql/data/drifted',
      STUB_PG_CLUSTER_IDS: 'crove_db-data=c1 ludy_db-data=c1',
      STUB_UP_DB_FAIL_PROJ: 'ludy',
      STUB_LOG_PROJECT: '1',
    });
    expect(driftedPgRec.status, driftedPgRec.out).toBe(3);
    expect(driftedPgRec.out).toContain('does not match pre-deploy database storage');
    expect(readFileSync(`${log}.project`, 'utf8').split('\n')).not.toContain('project crove up');

    // 2) Cross-type Docker volume Mountpoint vs host bind overlap blocks check_storage_free in both directions.
    rmSync(`${dir}/.deploy`, { recursive: true, force: true });
    rmSync(`${dir}/docker-compose.yml`, { force: true });
    const volBackingPath = `${root}/docker-vols/ludy_db-data/_data`;
    mkdirSync(volBackingPath, { recursive: true });
    const crossVolTarget = deploy('v1.0.0', 'a', {
      STUB_VOLUMES: 'ludy_db-data',
      STUB_VOLUME_MOUNTPOINTS: `ludy_db-data=${volBackingPath}`,
      STUB_RUNNING_CONTAINERS: 'bind-holder-1',
      STUB_INSPECT_WORKDIRS: 'bind-holder-1|/opt/other',
      STUB_INSPECT_MOUNTS: `bind-holder-1|other|bind||${volBackingPath}|`,
    });
    expect(crossVolTarget.status, crossVolTarget.out).toBe(1);
    expect(crossVolTarget.out).toContain('still mounted by a running container outside project');

    const crossBindTarget = deploy('v1.0.0', 'a', {
      STUB_NEW_DB_BIND: volBackingPath,
      STUB_VOLUMES: 'other_db-data',
      STUB_VOLUME_MOUNTPOINTS: `other_db-data=${volBackingPath}`,
      STUB_RUNNING_CONTAINERS: 'vol-holder-1',
      STUB_INSPECT_WORKDIRS: 'vol-holder-1|/opt/other',
      STUB_INSPECT_MOUNTS: 'vol-holder-1|other|volume|other_db-data||',
    });
    expect(crossBindTarget.status, crossBindTarget.out).toBe(1);
    expect(crossBindTarget.out).toContain('still mounted by a running container outside project');

    // 3) plain_compose_omits_override_and_project inspects each env file in-process without subshell array staleness.
    rmSync(`${dir}/.deploy`, { recursive: true, force: true });
    rmSync(`${dir}/docker-compose.yml`, { force: true });
    writeFileSync(croveBase, 'name: crove\nservices: {}\n');
    const inTreeEnv = 'POSTGRES_PASSWORD=x\nCOMPOSE_FILE=docker-compose.yml:compose.host.yml\n';
    const outTreeEnv = 'POSTGRES_PASSWORD=x\nCOMPOSE_FILE=docker-compose.yml:docker-compose.override.yml\n';
    writeFileSync(`${dir}/.env`, inTreeEnv);
    writeFileSync(extEnv, outTreeEnv);
    writeFileSync(`${dir}/compose.host.yml`, 'services: {}\n');
    expect(run(['deploy', '--release', 'v1.0.0', '--image', image('a'), '--extract-image', extract('a'), '--media-image', media('a'), '--compose', croveBase, '--env-file', extEnv]).status).toBe(0);
    const staleArrayGuard = run(['deploy', '--release', 'v1.1.0', '--image', image('b'), '--extract-image', extract('b'), '--media-image', media('b'), '--compose', compose, '--env-file', extEnv]);
    expect(staleArrayGuard.status, staleArrayGuard.out).toBe(2);
    expect(staleArrayGuard.out).toContain('COMPOSE_FILE omits docker-compose.override.yml');
    rmSync(`${dir}/compose.host.yml`, { force: true });

    // 4) --modules changing /data/files via Compose interpolation re-validates storage continuity before rolling and updates .deploy/mounts.
    rmSync(`${dir}/.deploy`, { recursive: true, force: true });
    rmSync(`${dir}/docker-compose.yml`, { force: true });
    writeFileSync(`${dir}/.env`, 'POSTGRES_PASSWORD=x\nLUDY_CONTEXT_TOKEN_KEY=already-here\n');
    expect(deploy('v1.0.0', 'a', { STUB_VOLUMES: 'ludy_db-data ludy_files' }).status).toBe(0);
    writeFileSync(log, '');
    const modSwitchBlocked = run(
      ['deploy', '--release', 'v1.1.0', '--image', image('b'), '--extract-image', extract('b'), '--media-image', media('b'), '--compose', compose, '--modules', 'finance,crm'],
      {
        STUB_VOLUMES: 'ludy_db-data ludy_files ludy_files_mod',
        STUB_POPULATED_MOUNTS: 'ludy_files',
        STUB_FILES_VOL_IF_ENV_HAS: 'LUDY_MODULES=finance,crm|ludy_files_mod',
      },
    );
    expect(modSwitchBlocked.status, modSwitchBlocked.out).toBe(1);
    expect(modSwitchBlocked.out).toContain('storage changed incompatibly');
    expect(readFileSync(`${dir}/.env`, 'utf8')).not.toContain('LUDY_MODULES=finance,crm');
    expect(calls().some((l) => l.startsWith('compose up') && l.includes(' ludy'))).toBe(false);

    rmSync(`${dir}/.deploy`, { recursive: true, force: true });
    rmSync(`${dir}/docker-compose.yml`, { force: true });
    writeFileSync(`${dir}/.env`, 'POSTGRES_PASSWORD=x\nLUDY_CONTEXT_TOKEN_KEY=already-here\n');
    const modSwitchFresh = run(
      ['deploy', '--release', 'v1.0.0', '--image', image('a'), '--extract-image', extract('a'), '--media-image', media('a'), '--compose', compose, '--modules', 'finance,crm'],
      { STUB_FILES_VOL_IF_ENV_HAS: 'LUDY_MODULES=finance,crm|ludy_files_mod' },
    );
    expect(modSwitchFresh.status, modSwitchFresh.out).toBe(0);
    expect(state('mounts')).toContain('/data/files=volume:ludy_files_mod');

    // Round 19 regressions (#3972 Round 19):
    // 1) Distinct DB storage still refuses deploy before `up db` when destination /data/keys or /data/files is held by another project.
    rmSync(`${dir}/.deploy`, { recursive: true, force: true });
    rmSync(`${dir}/docker-compose.yml`, { force: true });
    writeFileSync(`${dir}/.env`, 'POSTGRES_PASSWORD=x\n');
    writeFileSync(log, '');
    const heldAppMount = deploy('v1.0.0', 'a', {
      STUB_VOLUMES: 'ludy_db-data ludy_keys',
      STUB_RUNNING_CONTAINERS: 'other-app-1',
      STUB_INSPECT_WORKDIRS: 'other-app-1|/opt/other-app',
      STUB_INSPECT_MOUNTS: 'other-app-1|other|volume|ludy_keys||',
    });
    expect(heldAppMount.status, heldAppMount.out).toBe(1);
    expect(heldAppMount.out).toContain('/data/keys storage ludy_keys is still mounted by a running container outside project');
    expect(calls().some((l) => l.startsWith('compose up'))).toBe(false);

    // 2) COMPOSE_FILE omitting compose.host.yml while $DEPLOY_DIR/compose.host.yml exists still includes compose.host.yml in dc().
    rmSync(`${dir}/.deploy`, { recursive: true, force: true });
    rmSync(`${dir}/docker-compose.yml`, { force: true });
    writeFileSync(`${dir}/compose.host.yml`, 'services: {}\n');
    writeFileSync(`${dir}/.env`, 'POSTGRES_PASSWORD=x\nCOMPOSE_FILE=docker-compose.yml:docker-compose.override.yml\n');
    rmSync(`${log}.files`, { force: true });
    const hostFallback = deploy('v1.0.0', 'a');
    expect(hostFallback.status, hostFallback.out).toBe(0);
    for (const files of readFileSync(`${log}.files`, 'utf8').split('\n').filter(Boolean)) {
      expect(files).toBe(`${dir}/docker-compose.yml ${dir}/docker-compose.override.yml ${dir}/compose.host.yml`);
    }
    rmSync(`${dir}/compose.host.yml`, { force: true });

    // 3) Both deploy workflows reject ambiguous dual /opt/ludy + /opt/crove hosts when DEPLOY_DIR is unset.
    for (const wfRel of ['.github/workflows/deploy.yml', '.github/workflows/pilot-ludy-cutover.yml']) {
      const wfText = readFileSync(join(repo, wfRel), 'utf8');
      expect(wfText, wfRel).toContain('both_distinct');
      expect(wfText, wfRel).toContain('cd -P /opt/ludy');
      expect(wfText, wfRel).toContain('cd -P /opt/crove');
    }

    writeFileSync(`${dir}/.env`, 'POSTGRES_PASSWORD=x\n');

    // Failed restore_pre_activate preserves $PRE_ACTIVATE_SNAP across EXIT cleanup so the reported recovery path remains intact (#3972 Round 14).
    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      rmSync(`${dir}/.deploy`, { recursive: true, force: true });
      rmSync(`${dir}/docker-compose.yml`, { force: true });
      writeFileSync(`${dir}/docker-compose.yml`, 'name: ludy\nservices: {}\n');
      const roBin = `${root}/robin`;
      mkdirSync(roBin, { recursive: true });
      writeFileSync(
        `${roBin}/docker`,
        [
          '#!/usr/bin/env bash',
          'if [ "${1:-}" = ps ] && [[ " $* " == *" status=running "* ]]; then',
          '  chmod 0555 "${STUB_DEPLOY_DIR}"',
          '  exit 1',
          'fi',
          `exec "${root}/bin/docker" "$@"`,
          '',
        ].join('\n'),
      );
      chmodSync(`${roBin}/docker`, 0o755);
      let keptSnapPath: string | undefined;
      try {
        const roRes = spawnSync(
          'bash',
          [script, 'deploy', '--release', 'v1.0.0', '--image', image('a'), '--extract-image', extract('a'), '--media-image', media('a'), '--compose', compose],
          {
            encoding: 'utf8',
            env: {
              ...process.env,
              PATH: `${roBin}${delimiter}${join(root, 'bin')}${delimiter}${process.env['PATH'] ?? ''}`,
              LUDY_DEPLOY_DIR: dir,
              LUDY_READY_TIMEOUT: '1',
              LUDY_WORKER_SETTLE: '0',
              STUB_LOG: log,
              STUB_DEPLOY_DIR: dir,
              STUB_OPENSSL_KEY_FILE: `${root}/openssl-key`,
              SMOKE_EMAIL: '',
              SMOKE_PASSWORD: '',
              SMOKE_ORG: '',
            },
          },
        );
        const roOut = `${roRes.stdout}${roRes.stderr}`;
        expect(roRes.status, roOut).not.toBe(0);
        expect(roOut).toContain('snapshot kept at ');
        keptSnapPath = /snapshot kept at (\S+)/.exec(roOut)?.[1];
        expect(keptSnapPath).toBeTruthy();
        expect(existsSync(keptSnapPath!)).toBe(true);
      } finally {
        chmodSync(dir, 0o755);
        if (keptSnapPath) rmSync(keptSnapPath, { recursive: true, force: true });
      }
    }
  });

  it('admits stale pre-rename containers for recreation while refusing foreign working_dir installations (#3972)', () => {
    const staleDir = `${root}/opt-crove-gone`;
    const existingForeignDir = `${root}/existing-foreign`;
    const danglingForeignLink = `${root}/dangling-foreign`;
    mkdirSync(existingForeignDir);
    symlinkSync(`${root}/absent-symlink-target`, danglingForeignLink);

    // Seed an active prior release so .deploy/current and .deploy/project exist.
    expect(deploy('v1.0.0', 'a', { STUB_SERVICES: 'db migrate auth ludy', STUB_VOLUMES: 'ludy_db-data' }).status).toBe(0);

    // 1) Mixed owned + stale non-existent pre-rename dir with live stale db mounting ludy_db-data succeeds and uses --force-recreate only for stale services (including mixed up "${rest[@]}").
    writeFileSync(log, '');
    const staleRecreate = deploy('v1.1.0', 'b', {
      STUB_SERVICES: 'db migrate auth mailpit ludy-extract ludy',
      STUB_VOLUMES: 'ludy_db-data',
      STUB_WORKDIR_CONTAINERS: `${dir}|ludy|own-ludy-1 ${dir}|ludy-extract|own-extract-1`,
      STUB_PROJECT_CONTAINERS: 'ludy|own-ludy-1 ludy|own-extract-1 ludy|stale-db-1 ludy|stale-auth-1 ludy|stale-mailpit-1',
      STUB_RUNNING_CONTAINERS: 'own-ludy-1 own-extract-1 stale-db-1 stale-auth-1 stale-mailpit-1',
      STUB_INSPECT_WORKDIRS: `own-ludy-1|${dir} own-extract-1|${dir} stale-db-1|${staleDir} stale-auth-1|${staleDir} stale-mailpit-1|${staleDir}`,
      STUB_INSPECT_SERVICES: 'own-ludy-1|ludy|False|true own-extract-1|ludy-extract|False|true stale-db-1|db|False|true stale-auth-1|auth|False|true stale-mailpit-1|mailpit|False|true',
      STUB_INSPECT_MOUNTS: 'stale-db-1|ludy|volume|ludy_db-data||/var/lib/postgresql/data',
    });
    expect(staleRecreate.status, staleRecreate.out).toBe(0);
    const c1 = calls();
    expect(c1).toContain('compose up --detach --no-build --no-deps --force-recreate --wait --wait-timeout 600 db');
    expect(c1).toContain('compose up --detach --no-build --no-deps --force-recreate --wait --wait-timeout 600 auth');
    expect(c1).toContain('compose up --detach --no-build --no-deps --force-recreate --wait --wait-timeout 600 mailpit');
    expect(c1).toContain('compose up --detach --no-build --no-deps --wait --wait-timeout 600 ludy-extract');
    expect(c1).toContain('compose up --detach --no-build --no-deps --wait --wait-timeout 600 ludy');
    expect(c1.some((l) => l.includes('--force-recreate') && (l.endsWith(' ludy') || l.includes('ludy-extract')))).toBe(false);

    // Stale pre-rename db PGDATA is still inspected by detect_prev_container_mounts before recreation.
    const stalePgdataCheck = deploy('v1.2.0', 'c', {
      STUB_SERVICES: 'db migrate auth ludy',
      STUB_VOLUMES: 'ludy_db-data',
      STUB_PG_CLUSTER_IDS: 'ludy_db-data=c1',
      STUB_PG_SUBDIR_MOUNTS: 'ludy_db-data=oldpg',
      STUB_WORKDIR_CONTAINERS: `${dir}|ludy|own-ludy-1`,
      STUB_PROJECT_CONTAINERS: 'ludy|own-ludy-1 ludy|stale-db-1',
      STUB_RUNNING_CONTAINERS: 'own-ludy-1',
      STUB_INSPECT_WORKDIRS: `own-ludy-1|${dir} stale-db-1|${staleDir}`,
      STUB_INSPECT_SERVICES: 'own-ludy-1|ludy|False|true stale-db-1|db|False|false',
      STUB_INSPECT_MOUNTS: 'stale-db-1|ludy|volume|ludy_db-data||/var/lib/postgresql/data',
      STUB_INSPECT_ENV: 'stale-db-1|PGDATA=/var/lib/postgresql/data/oldpg',
    });
    expect(stalePgdataCheck.status, stalePgdataCheck.out).toBe(1);
    expect(stalePgdataCheck.out).toContain('PGDATA /var/lib/postgresql/data/oldpg');

    // Stale split worker also recreates with --force-recreate via roll_worker.
    writeFileSync(log, '');
    const staleWorker = deploy('v1.2.0', 'c', {
      STUB_SERVICES: 'db migrate auth api worker',
      STUB_VOLUMES: 'ludy_db-data',
      STUB_WORKDIR_CONTAINERS: `${dir}|api|own-api-1`,
      STUB_PROJECT_CONTAINERS: 'ludy|own-api-1 ludy|stale-worker-1',
      STUB_RUNNING_CONTAINERS: 'own-api-1 stale-worker-1',
      STUB_INSPECT_WORKDIRS: `own-api-1|${dir} stale-worker-1|${staleDir}`,
      STUB_INSPECT_SERVICES: 'own-api-1|api|False|true stale-worker-1|worker|False|true',
    });
    expect(staleWorker.status, staleWorker.out).toBe(0);
    const cWorker = calls();
    expect(cWorker).toContain('compose up --detach --no-build --no-deps --force-recreate worker');
    expect(cWorker).toContain('compose up --detach --no-build --no-deps --wait --wait-timeout 600 api');

    // 2) Existing foreign directory at working_dir is still refused even with .deploy/current and an owned container.
    const existingDirRefused = deploy('v1.3.0', 'd', {
      STUB_SERVICES: 'db migrate auth ludy',
      STUB_PROJECT_CONTAINERS: 'ludy|own-ludy-1 ludy|foreign-db-1',
      STUB_INSPECT_WORKDIRS: `own-ludy-1|${dir} foreign-db-1|${existingForeignDir}`,
      STUB_INSPECT_SERVICES: 'own-ludy-1|ludy|False|true foreign-db-1|db|False|true',
    });
    expect(existingDirRefused.status, existingDirRefused.out).toBe(1);
    expect(existingDirRefused.out).toContain(`Compose project 'ludy' is already owned by another installation at ${existingForeignDir}`);

    // 3) Dangling symlink at foreign working_dir is still refused even with .deploy/current and an owned container.
    const danglingRefused = deploy('v1.3.0', 'd', {
      STUB_SERVICES: 'db migrate auth ludy',
      STUB_PROJECT_CONTAINERS: 'ludy|own-ludy-1 ludy|foreign-link-1',
      STUB_INSPECT_WORKDIRS: `own-ludy-1|${dir} foreign-link-1|${danglingForeignLink}`,
      STUB_INSPECT_SERVICES: 'own-ludy-1|ludy|False|true foreign-link-1|db|False|true',
    });
    expect(danglingRefused.status, danglingRefused.out).toBe(1);
    expect(danglingRefused.out).toContain(`Compose project 'ludy' is already owned by another installation at ${danglingForeignLink}`);

    // 4) Absent foreign working_dir with .deploy/current present but ZERO owned containers is still refused.
    const zeroOwnedRefused = deploy('v1.3.0', 'd', {
      STUB_SERVICES: 'db migrate auth ludy',
      STUB_PROJECT_CONTAINERS: 'ludy|foreign-absent-1',
      STUB_INSPECT_WORKDIRS: `foreign-absent-1|${staleDir}`,
      STUB_INSPECT_SERVICES: 'foreign-absent-1|db|False|true',
    });
    expect(zeroOwnedRefused.status, zeroOwnedRefused.out).toBe(1);
    expect(zeroOwnedRefused.out).toContain(`Compose project 'ludy' is already owned by another installation at ${staleDir}`);

    // 5) Stale container with running oneoff=True or missing com.docker.compose.service label is still refused.
    const runningOneoffRefused = deploy('v1.3.0', 'd', {
      STUB_SERVICES: 'db migrate auth ludy',
      STUB_PROJECT_CONTAINERS: 'ludy|own-ludy-1 ludy|stale-oneoff-run',
      STUB_INSPECT_WORKDIRS: `own-ludy-1|${dir} stale-oneoff-run|${staleDir}`,
      STUB_INSPECT_SERVICES: 'own-ludy-1|ludy|False|true stale-oneoff-run|migrate|True|true',
    });
    expect(runningOneoffRefused.status, runningOneoffRefused.out).toBe(1);
    expect(runningOneoffRefused.out).toContain(`Compose project 'ludy' is already owned by another installation at ${staleDir}`);

    const missingServiceRefused = deploy('v1.3.0', 'd', {
      STUB_SERVICES: 'db migrate auth ludy',
      STUB_PROJECT_CONTAINERS: 'ludy|own-ludy-1 ludy|stale-nosvc',
      STUB_INSPECT_WORKDIRS: `own-ludy-1|${dir} stale-nosvc|${staleDir}`,
      STUB_INSPECT_SERVICES: 'own-ludy-1|ludy|False|true stale-nosvc||False|false',
    });
    expect(missingServiceRefused.status, missingServiceRefused.out).toBe(1);
    expect(missingServiceRefused.out).toContain(`Compose project 'ludy' is already owned by another installation at ${staleDir}`);

    // 6) Stopped stale oneoff=True container alongside owned container + .deploy/current succeeds without --force-recreate.
    writeFileSync(log, '');
    const stoppedOneoffOk = deploy('v1.3.0', 'd', {
      STUB_SERVICES: 'db migrate auth ludy',
      STUB_VOLUMES: 'ludy_db-data',
      STUB_WORKDIR_CONTAINERS: `${dir}|ludy|own-ludy-1`,
      STUB_PROJECT_CONTAINERS: 'ludy|own-ludy-1 ludy|stale-oneoff-stopped',
      STUB_INSPECT_WORKDIRS: `own-ludy-1|${dir} stale-oneoff-stopped|${staleDir}`,
      STUB_INSPECT_SERVICES: 'own-ludy-1|ludy|False|true stale-oneoff-stopped|db|True|false',
      STUB_INSPECT_MOUNTS: 'stale-oneoff-stopped|ludy|volume|ludy_db-data||/var/lib/postgresql/data',
      STUB_INSPECT_ENV: 'stale-oneoff-stopped|PGDATA=/var/lib/postgresql/data/bad',
    });
    expect(stoppedOneoffOk.status, stoppedOneoffOk.out).toBe(0);
    const cStoppedOneoff = calls();
    expect(cStoppedOneoff).toContain('compose up --detach --no-build --no-deps --wait --wait-timeout 600 db');
    expect(cStoppedOneoff.some((l) => l.includes('--force-recreate'))).toBe(false);

    // 7) Security hardening checks:
    // (a) Unsearchable foreign parent directory (0o000 / 0o600) is still refused.
    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      const unsearchableParent = `${root}/locked-parent`;
      mkdirSync(unsearchableParent, { mode: 0o700 });
      const maskedPath = `${unsearchableParent}/crove-masked`;
      for (const mode of [0o000, 0o600]) {
        try {
          chmodSync(unsearchableParent, mode);
          const maskedRefused = deploy('v1.4.0', 'e', {
            STUB_SERVICES: 'db migrate auth ludy',
            STUB_PROJECT_CONTAINERS: 'ludy|own-ludy-1 ludy|foreign-masked-1',
            STUB_INSPECT_WORKDIRS: `own-ludy-1|${dir} foreign-masked-1|${maskedPath}`,
            STUB_INSPECT_SERVICES: 'own-ludy-1|ludy|False|true foreign-masked-1|db|False|true',
          });
          expect(maskedRefused.status, `mode ${mode.toString(8)}: ${maskedRefused.out}`).toBe(1);
          expect(maskedRefused.out).toContain(`Compose project 'ludy' is already owned by another installation at ${maskedPath}`);
        } finally {
          chmodSync(unsearchableParent, 0o700);
        }
      }
    }

    // (b) Dangling symlink ancestor (/dangling/. and /dangling/sub) and regular-file ancestor (/file/sub) are still refused.
    const regFileAncestor = `${root}/regfile-ancestor`;
    writeFileSync(regFileAncestor, 'x');
    for (const badWdir of [`${danglingForeignLink}/.`, `${danglingForeignLink}/sub`, `${regFileAncestor}/sub`]) {
      const ancRefused = deploy('v1.4.0', 'e', {
        STUB_SERVICES: 'db migrate auth ludy',
        STUB_PROJECT_CONTAINERS: 'ludy|own-ludy-1 ludy|foreign-anc-1',
        STUB_INSPECT_WORKDIRS: `own-ludy-1|${dir} foreign-anc-1|${badWdir}`,
        STUB_INSPECT_SERVICES: 'own-ludy-1|ludy|False|true foreign-anc-1|db|False|true',
      });
      expect(ancRefused.status, `${badWdir}: ${ancRefused.out}`).toBe(1);
      expect(ancRefused.out).toContain("Compose project 'ludy' is already owned by another installation at");
    }

    // (c) Delimiter-smuggled STUB_INSPECT_SERVICES and unexpected oneoff/running values are still refused.
    for (const badMeta of [
      'stale-meta-1|db|False|True|true',
      'stale-meta-1|db|maybe|false',
      'stale-meta-1|db|False|restarting',
    ]) {
      const badMetaRefused = deploy('v1.4.0', 'e', {
        STUB_SERVICES: 'db migrate auth ludy',
        STUB_PROJECT_CONTAINERS: 'ludy|own-ludy-1 ludy|stale-meta-1',
        STUB_INSPECT_WORKDIRS: `own-ludy-1|${dir} stale-meta-1|${staleDir}`,
        STUB_INSPECT_SERVICES: `own-ludy-1|ludy|False|true ${badMeta}`,
      });
      expect(badMetaRefused.status, `${badMeta}: ${badMetaRefused.out}`).toBe(1);
      expect(badMetaRefused.out).toContain(`Compose project 'ludy' is already owned by another installation at ${staleDir}`);
    }

    // (e) Unrelated-project container mounting ludy_db-data stays blocked by check_storage_free even while stale containers of ludy are admitted.
    writeFileSync(log, '');
    const unrelatedHeld = deploy('v1.4.0', 'e', {
      STUB_SERVICES: 'db migrate auth ludy',
      STUB_VOLUMES: 'ludy_db-data',
      STUB_WORKDIR_CONTAINERS: `${dir}|ludy|own-ludy-1`,
      STUB_PROJECT_CONTAINERS: 'ludy|own-ludy-1 ludy|stale-db-1',
      STUB_RUNNING_CONTAINERS: 'own-ludy-1 stale-db-1 other-db-1',
      STUB_INSPECT_WORKDIRS: `own-ludy-1|${dir} stale-db-1|${staleDir} other-db-1|/opt/other`,
      STUB_INSPECT_SERVICES: 'own-ludy-1|ludy|False|true stale-db-1|db|False|true',
      STUB_INSPECT_MOUNTS: 'stale-db-1|ludy|volume|ludy_db-data||/var/lib/postgresql/data other-db-1|other|volume|ludy_db-data||/var/lib/postgresql/data',
    });
    expect(unrelatedHeld.status, unrelatedHeld.out).toBe(1);
    expect(unrelatedHeld.out).toContain('database storage ludy_db-data is still mounted by a running container outside project ludy');
    expect(calls().some((l) => l.startsWith('compose up'))).toBe(false);

    // (f) Conflicting PGDATA between an owned DB container and an admitted stale DB container is refused before any container recreation.
    writeFileSync(log, '');
    const conflictingPgdataRefused = deploy('v1.4.0', 'e', {
      STUB_SERVICES: 'db migrate auth ludy',
      STUB_VOLUMES: 'ludy_db-data',
      STUB_WORKDIR_CONTAINERS: `${dir}|db|own-db-1 ${dir}|ludy|own-ludy-1`,
      STUB_PROJECT_CONTAINERS: 'ludy|own-db-1 ludy|own-ludy-1 ludy|stale-db-1',
      STUB_RUNNING_CONTAINERS: 'own-db-1 own-ludy-1 stale-db-1',
      STUB_INSPECT_WORKDIRS: `own-db-1|${dir} own-ludy-1|${dir} stale-db-1|${staleDir}`,
      STUB_INSPECT_SERVICES: 'own-db-1|db|False|true own-ludy-1|ludy|False|true stale-db-1|db|False|true',
      STUB_INSPECT_MOUNTS: 'own-db-1|ludy|volume|ludy_db-data||/var/lib/postgresql/data stale-db-1|ludy|volume|ludy_db-data||/var/lib/postgresql/data',
      STUB_INSPECT_ENV: 'own-db-1|PGDATA=/var/lib/postgresql/data stale-db-1|PGDATA=/var/lib/postgresql/data/oldpg',
    });
    expect(conflictingPgdataRefused.status, conflictingPgdataRefused.out).toBe(1);
    expect(conflictingPgdataRefused.out).toContain('unsupported PGDATA path');
    expect(calls().some((l) => l.startsWith('compose up'))).toBe(false);

    // (d) Fresh install without .deploy/current refuses stale pre-rename containers even when an owned container exists.
    rmSync(`${dir}/.deploy/current`, { force: true });
    const noCurrentRefused = deploy('v1.4.0', 'e', {
      STUB_SERVICES: 'db migrate auth ludy',
      STUB_PROJECT_CONTAINERS: 'ludy|own-ludy-1 ludy|stale-db-1',
      STUB_INSPECT_WORKDIRS: `own-ludy-1|${dir} stale-db-1|${staleDir}`,
      STUB_INSPECT_SERVICES: 'own-ludy-1|ludy|False|true stale-db-1|db|False|true',
    });
    expect(noCurrentRefused.status, noCurrentRefused.out).toBe(1);
    expect(noCurrentRefused.out).toContain(`Compose project 'ludy' is already owned by another installation at ${staleDir}`);
  });

  describe('build check', () => {
    const build = (c: string) => digest(c).slice(0, 12);
    const withBuild = (release: string, c: string, env: Record<string, string> = {}) =>
      run(['deploy', '--release', release, '--image', image(c), '--extract-image', extract(c), '--media-image', media(c), '--compose', compose, '--build', build(c)], env);
    const versionCalls = () => readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith('curl ') && l.endsWith('/version'));

    it('checks /version and records the build of the release', () => {
      const res = withBuild('v1.0.0', 'a');
      expect(res.status, res.out).toBe(0);
      expect(res.out).toContain(`smoke ok: /version answers build ${build('a')} with every migration applied`);
      expect(readFileSync(`${dir}/releases/${releaseDir('v1.0.0', 'a')}/release.env`, 'utf8')).toContain(`BUILD=${build('a')}\n`);
    });

    it('skips /version without --build (a release from before it)', () => {
      expect(deploy('v1.0.0', 'a').status).toBe(0);
      expect(versionCalls()).toEqual([]);
      expect(readFileSync(`${dir}/releases/${releaseDir('v1.0.0', 'a')}/release.env`, 'utf8')).toContain('BUILD=\n');
    });

    it('rolls back when an old container answers instead of the new build', () => {
      expect(deploy('v1.0.0', 'a').status).toBe(0);
      const res = withBuild('v1.1.0', 'b', { STUB_STALE_DIGEST: digest('b') });
      expect(res.status, res.out).toBe(1);
      expect(res.out).toContain(`smoke: expected build ${build('b')} with no missing migration; /version answered: {"build":"stale","migrationsMissing":[]}`);
      expect(res.out).toContain(`rolled back to ${releaseDir('v1.0.0', 'a')}, which serves again`);
      expect(running()).toContain(image('a'));
    });

    it('rolls back when a committed migration is missing from the ledger', () => {
      expect(deploy('v1.0.0', 'a').status).toBe(0);
      rmSync(log);
      const res = withBuild('v1.1.0', 'b', { STUB_MIGRATION_MISSING: '1' });
      expect(res.status, res.out).toBe(1);
      expect(res.out).toContain(`smoke failed: /version answers build ${build('b')} with every migration applied`);
      // The release rolled back to was deployed without a build id: its smoke test does not ask /version.
      expect(versionCalls()).toHaveLength(1);
    });

    it('checks the build of the release it rolls back to, when that release has one', () => {
      expect(withBuild('v1.0.0', 'a').status).toBe(0);
      const failed = withBuild('v1.1.0', 'b', { STUB_NO_BUNDLE_DIGEST: digest('b') });
      expect(failed.status, failed.out).toBe(1);
      expect(failed.out).toContain(`smoke ok: /version answers build ${build('a')} with every migration applied`);
      expect(withBuild('v1.1.0', 'b').status).toBe(0);
      rmSync(log);
      const back = run(['rollback']);
      expect(back.status, back.out).toBe(0);
      expect(back.out).toContain(`smoke ok: /version answers build ${build('a')} with every migration applied`);
    });

    it('refuses a build id with other characters, or an empty one', () => {
      for (const id of ["a'b", '']) {
        const res = run(['deploy', '--release', 'v1.0.0', '--image', image('a'), '--extract-image', extract('a'), '--media-image', media('a'), '--compose', compose, '--build', id]);
        expect(res.status, id).toBe(2);
        expect(res.out).toContain('--build must match');
      }
    });
  });

  it('rolls the worker before the API when they run as separate services', () => {
    const res = deploy('v1.0.0', 'a', { STUB_SERVICES: 'db migrate auth auth-grants ludy-extract api worker' });
    expect(res.status, res.out).toBe(0);
    const c = calls();
    const worker = indexOf(c, 'compose up --detach --no-build --no-deps worker');
    const ps = indexOf(c, 'compose ps --status running --services');
    const api = indexOf(c, 'compose up --detach --no-build --no-deps --wait --wait-timeout 600 api');
    expect(worker).toBeGreaterThan(indexOf(c, 'run --rm --no-TTY --no-deps migrate'));
    expect(ps).toBeGreaterThan(worker);
    expect(api).toBeGreaterThan(ps);
    expect(indexOf(c, 'compose port api 8080')).toBeGreaterThan(api);
    expect(c.some((l) => / (ludy|crove)$/.test(l) && !l.startsWith('compose rm ') && !l.startsWith('docker rm '))).toBe(false);
  });

  // #1965 (plan §3.5): toward an older release the API goes first, so the worker that runs is never older than the API
  // that serves (whose /readyz waits on an older worker, #1952); toward a newer one, the worker first.
  describe('separate services, toward an older release (#1965)', () => {
    const env = { STUB_SERVICES: 'db migrate auth ludy-extract api worker' };
    const worker = 'compose up --detach --no-build --no-deps worker';
    const api = 'compose up --detach --no-build --no-deps --wait --wait-timeout 600 api';
    const last = (lines: string[], text: string) => lines.findLastIndex((l) => l.includes(text));

    it('rolls the API before the worker on a rollback, and the worker before the API on the second one', () => {
      expect(deploy('v1.0.0', 'a', env).status).toBe(0);
      expect(deploy('v1.1.0', 'b', env).status).toBe(0);
      rmSync(log);
      let res = run(['rollback'], env);
      expect(res.status, res.out).toBe(0);
      let c = calls();
      expect(indexOf(c, api)).toBeGreaterThan(-1);
      expect(indexOf(c, worker)).toBeGreaterThan(indexOf(c, api));
      // The worker is still checked: it stays up before the instance is called ready.
      expect(indexOf(c, 'compose ps --status running --services')).toBeGreaterThan(indexOf(c, worker));
      expect(indexOf(c, 'compose port api 8080')).toBeGreaterThan(indexOf(c, worker));
      expect(res.out).toContain('rolling the API (toward an older build: the API before the worker)');
      // The second rollback returns to the release deployed later: toward it, the worker first again.
      rmSync(log);
      res = run(['rollback'], env);
      expect(res.status, res.out).toBe(0);
      c = calls();
      expect(indexOf(c, worker)).toBeGreaterThan(-1);
      expect(indexOf(c, api)).toBeGreaterThan(indexOf(c, worker));
      expect(res.out).not.toContain('the API before the worker');
    });

    it('recovers a failed deploy API first, toward the release that ran before', () => {
      expect(deploy('v1.0.0', 'a', env).status).toBe(0);
      rmSync(log);
      const res = deploy('v1.1.0', 'b', { ...env, STUB_BAD_DIGEST: digest('b') });
      expect(res.status, res.out).toBe(1);
      expect(res.out).toContain(`rolled back to ${releaseDir('v1.0.0', 'a')}, which serves again`);
      const c = calls();
      // The deploy: the worker, then the API. The recovery: the API, then the worker.
      expect(indexOf(c, api)).toBeGreaterThan(indexOf(c, worker));
      expect(last(c, worker)).toBeGreaterThan(last(c, api));
      expect(last(c, api)).toBeGreaterThan(indexOf(c, api));
    });

    it('recovers a failed rollback worker first, toward the newer release it left', () => {
      expect(deploy('v1.0.0', 'a', env).status).toBe(0);
      expect(deploy('v1.1.0', 'b', env).status).toBe(0);
      rmSync(log);
      const res = run(['rollback'], { ...env, STUB_BAD_DIGEST: digest('a') });
      expect(res.status, res.out).toBe(1);
      expect(res.out).toContain(`rolled back to ${releaseDir('v1.1.0', 'b')}, which serves again`);
      const c = calls();
      // The rollback: the API, then the worker. The recovery: the worker, then the API.
      expect(indexOf(c, worker)).toBeGreaterThan(indexOf(c, api));
      expect(last(c, worker)).toBeGreaterThan(indexOf(c, worker));
      expect(last(c, api)).toBeGreaterThan(last(c, worker));
    });

    it('recovers forward, worker first, when the older worker does not stay up after the API was rolled back', () => {
      expect(deploy('v1.0.0', 'a', env).status).toBe(0);
      expect(deploy('v1.1.0', 'b', env).status).toBe(0);
      rmSync(log);
      const res = run(['rollback'], { ...env, STUB_WORKER_DOWN_DIGEST: digest('a') });
      expect(res.status, res.out).toBe(1);
      expect(res.out).toContain('the worker is not running');
      expect(res.out).toContain(`rolled back to ${releaseDir('v1.1.0', 'b')}, which serves again`);
      const c = calls();
      expect(indexOf(c, worker)).toBeGreaterThan(indexOf(c, api));
      expect(last(c, worker)).toBeGreaterThan(indexOf(c, worker));
      expect(last(c, api)).toBeGreaterThan(last(c, worker));
    });

    // The build time the image carries orders the rolls, not when the release was deployed: a deploy of an older tag
    // rolls the API first, and the rollback from it, to the newer build, the worker first (Codex and review, #1965).
    it('orders by the build time the images carry, so a deploy of an older tag rolls the API first', () => {
      const times = { ...env, STUB_BUILD_TIMES: `${digest('a')}=2026-10-01T10:00:00+07:00 ${digest('b')}=2026-10-02T09:00:00+07:00` };
      expect(deploy('v1.1.0', 'b', times).status).toBe(0);
      expect(readFileSync(`${dir}/releases/${releaseDir('v1.1.0', 'b')}/release.env`, 'utf8')).toContain(`BUILD_EPOCH=${Date.parse('2026-10-02T02:00:00Z') / 1000}`);
      rmSync(log);
      let res = deploy('v1.0.0', 'a', times);
      expect(res.status, res.out).toBe(0);
      let c = calls();
      expect(indexOf(c, worker)).toBeGreaterThan(indexOf(c, api));
      rmSync(log);
      res = run(['rollback'], times);
      expect(res.status, res.out).toBe(0);
      c = calls();
      expect(indexOf(c, api)).toBeGreaterThan(indexOf(c, worker));
      // The older tag's release records its build time too.
      expect(readFileSync(`${dir}/releases/${releaseDir('v1.0.0', 'a')}/release.env`, 'utf8')).toMatch(/BUILD_EPOCH=\d+/);
    });
  });

  it('does not roll the API when the new worker does not stay up, and rolls back', () => {
    const env = { STUB_SERVICES: 'db migrate auth ludy-extract api worker' };
    expect(deploy('v1.0.0', 'a', env).status).toBe(0);
    rmSync(log);
    const res = deploy('v1.1.0', 'b', { ...env, STUB_WORKER_DOWN_DIGEST: digest('b') });
    expect(res.status, res.out).toBe(1);
    expect(res.out).toContain('the worker is not running');
    expect(res.out).toContain(`rolled back to ${releaseDir('v1.0.0', 'a')}`);
    expect(state('current')).toBe(releaseDir('v1.0.0', 'a'));
    // The new API was never started: the first `up api` after the failed worker belongs to the rollback.
    const c = calls();
    const firstApi = indexOf(c, '--wait-timeout 600 api');
    expect(firstApi).toBeGreaterThan(indexOf(c, 'compose ps --status running --services'));
    expect(c.filter((l) => l.endsWith(' api')).length).toBe(1);
  });

  it('asks for readiness at least once, however short the timeout, so a ready instance is never taken for a failed one (#1841)', () => {
    // A timeout of 0 forces the boundary that made the case above flaky: the whole second passes before the first
    // question, as when bash's SECONDS ticks right after the deadline is set.
    const env = { LUDY_READY_TIMEOUT: '0', STUB_SERVICES: 'db migrate auth ludy-extract api worker' };
    const ready = deploy('v1.0.0', 'a', env);
    expect(ready.status, ready.out).toBe(0);
    expect(ready.out).toContain('ready: every committed migration is applied');
    // The rollback after a worker that does not stay up gets its question too, and serves the previous release again.
    rmSync(log);
    const res = deploy('v1.1.0', 'b', { ...env, STUB_WORKER_DOWN_DIGEST: digest('b') });
    expect(res.status, res.out).toBe(1);
    expect(res.out).toContain(`rolled back to ${releaseDir('v1.0.0', 'a')}`);
    expect(res.out).not.toContain('rollback to');
  });

  it('keeps the previous release and moves on with a second deploy', () => {
    expect(deploy('v1.0.0', 'a').status).toBe(0);
    expect(deploy('v1.1.0', 'b').status).toBe(0);
    expect(state('current')).toBe(releaseDir('v1.1.0', 'b'));
    expect(state('previous')).toBe(releaseDir('v1.0.0', 'a'));
    expect(running()).toContain(image('b'));
  });

  it('rolls back to the running release when the new one never gets ready, and exits 1', () => {
    expect(deploy('v1.0.0', 'a').status).toBe(0);
    const res = deploy('v1.1.0', 'b', { STUB_BAD_DIGEST: digest('b') });
    expect(res.status, res.out).toBe(1);
    expect(res.out).toContain('not ready after 1s');
    expect(res.out).toContain(`rolled back to ${releaseDir('v1.0.0', 'a')}, which serves again`);
    expect(state('current')).toBe(releaseDir('v1.0.0', 'a'));
    expect(state('previous')).toBe('');
    expect(running()).toContain(image('a'));
    expect(running()).not.toContain(image('b'));
    expect(readFileSync(`${dir}/.deploy/history.log`, 'utf8')).toContain(`deploy ${releaseDir('v1.1.0', 'b')} failed, rolled back to ${releaseDir('v1.0.0', 'a')}`);
  });

  it('never runs the account step of the smoke test on the host, so a rollback cannot depend on the smoke account', () => {
    const res = deploy('v1.0.0', 'a', { SMOKE_EMAIL: 'smoke@example.com', SMOKE_PASSWORD: 'x', SMOKE_ORG: 'ludy-smoke', STUB_SIGNIN_FAIL: '1' });
    expect(res.status, res.out).toBe(0);
    expect(res.out).not.toContain('signs in, uploads');
    expect(readFileSync(log, 'utf8')).not.toContain('/auth/v1/token');
  });

  it('rolls back when the smoke test fails after the instance is ready', () => {
    expect(deploy('v1.0.0', 'a').status).toBe(0);
    // Ready, but the new release's sign-in page has no script bundle.
    const res = deploy('v1.1.0', 'b', { STUB_NO_BUNDLE_DIGEST: digest('b') });
    expect(res.status, res.out).toBe(1);
    expect(res.out).toContain('smoke failed: /login loads the app shell and its script bundle');
    expect(res.out).toContain(`rolled back to ${releaseDir('v1.0.0', 'a')}, which serves again`);
    expect(running()).toContain(image('a'));
  });

  it('exits 3 when the rollback fails too', () => {
    expect(deploy('v1.0.0', 'a').status).toBe(0);
    const res = deploy('v1.1.0', 'b', { STUB_READYZ_FAIL: '1' });
    expect(res.status, res.out).toBe(3);
    expect(res.out).toContain('the instance needs an operator');
    expect(readFileSync(`${dir}/.deploy/history.log`, 'utf8')).toContain('FAILED');
  });

  it('exits 1 without an earlier release to roll back to', () => {
    const res = deploy('v1.0.0', 'a', { STUB_READYZ_FAIL: '1' });
    expect(res.status, res.out).toBe(1);
    expect(res.out).toContain('no earlier release to roll back to');
    expect(state('current')).toBe('');
  });

  it('leaves the services alone when the migration fails', () => {
    expect(deploy('v1.0.0', 'a').status).toBe(0);
    rmSync(log);
    const res = deploy('v1.1.0', 'b', { STUB_MIGRATE_EXIT: '1' });
    expect(res.status, res.out).toBe(1);
    expect(res.out).toContain('migrations failed; the services were not changed');
    const c = calls();
    expect(c.slice(indexOf(c, 'migrate')).some((l) => l.startsWith('compose up'))).toBe(false);
    expect(running()).toContain(image('a'));
    expect(state('current')).toBe(releaseDir('v1.0.0', 'a'));
  });

  it('changes nothing when a pull fails', () => {
    expect(deploy('v1.0.0', 'a').status).toBe(0);
    rmSync(log);
    const res = deploy('v1.1.0', 'b', { STUB_PULL_FAIL: '1' });
    expect(res.status, res.out).toBe(1);
    expect(calls().some((l) => l.startsWith('compose up') || l.startsWith('compose run'))).toBe(false);
    expect(running()).toContain(image('a'));
  });

  it('rolls back on request, and a second rollback returns', () => {
    expect(deploy('v1.0.0', 'a').status).toBe(0);
    expect(deploy('v1.1.0', 'b').status).toBe(0);
    rmSync(log);
    let res = run(['rollback']);
    expect(res.status, res.out).toBe(0);
    expect(calls().some((l) => l.includes('migrate'))).toBe(false);
    expect(state('current')).toBe(releaseDir('v1.0.0', 'a'));
    expect(state('previous')).toBe(releaseDir('v1.1.0', 'b'));
    expect(running()).toContain(image('a'));
    res = run(['rollback']);
    expect(res.status, res.out).toBe(0);
    expect(state('current')).toBe(releaseDir('v1.1.0', 'b'));
    expect(run(['status']).out).toContain(`current:  ${releaseDir('v1.1.0', 'b')}`);
  });

  it('refuses a rollback with no previous release', () => {
    expect(deploy('v1.0.0', 'a').status).toBe(0);
    const res = run(['rollback']);
    expect(res.status).toBe(2);
    expect(res.out).toContain('no previous release');
  });

  it('logs in with the password from stdin in a throwaway Docker config', () => {
    const res = run(
      ['deploy', '--release', 'v1.0.0', '--image', image('a'), '--extract-image', extract('a'), '--media-image', media('a'), '--compose', compose, '--registry', 'ghcr.io', '--registry-user', 'bot', '--registry-password-stdin'],
      {},
      'the-token\n',
    );
    expect(res.status, res.out).toBe(0);
    expect(readFileSync(`${log}.password`, 'utf8')).toBe('the-token');
    const c = calls();
    const login = c.find((l) => l.startsWith('login '));
    expect(login).toMatch(/^login DOCKER_CONFIG=\S+ --username bot --password-stdin ghcr\.io$/);
    const config = /DOCKER_CONFIG=(\S+)/.exec(login ?? '')?.[1] ?? '';
    expect(c.filter((l) => l.startsWith('pull ')).every((l) => l.endsWith(`DOCKER_CONFIG=${config}`))).toBe(true);
    // Removed after the pull, and the token appears in no argument.
    expect(existsSync(config)).toBe(false);
    expect(readFileSync(log, 'utf8')).not.toContain('the-token');
    expect(res.out).not.toContain('the-token');
  });

  it.each([
    ['a release id with shell characters', ['--release', 'v1;rm -rf /', '--image', image('a'), '--extract-image', extract('a'), '--media-image', media('a')], '--release must match'],
    ['an image without a digest', ['--release', 'v1', '--image', 'ghcr.io/example/ludy:v1', '--extract-image', extract('a'), '--media-image', media('a')], '--image must be pinned by digest'],
    ['an extract image without a digest', ['--release', 'v1', '--image', image('a'), '--extract-image', 'ludy-extract:latest', '--media-image', media('a')], '--extract-image must be pinned'],
    ['a media image without a digest', ['--release', 'v1', '--image', image('a'), '--extract-image', extract('a'), '--media-image', 'ludy-media:latest'], '--media-image must be pinned'],
    ['no media image', ['--release', 'v1', '--image', image('a'), '--extract-image', extract('a')], '--media-image must be pinned'],
  ])('refuses %s before calling docker', (_name, args, message) => {
    const res = run(['deploy', ...args, '--compose', compose]);
    expect(res.status).toBe(2);
    expect(res.out).toContain(message);
    expect(calls()).toEqual([]);
  });

  it('refuses to run without the env file', () => {
    rmSync(`${dir}/.env`);
    const res = deploy('v1.0.0', 'a');
    expect(res.status).toBe(2);
    expect(res.out).toContain('.env not found');
  });

  it('refuses to run while another deploy holds the lock, and clears a stale lock', () => {
    mkdirSync(`${dir}/.deploy/lock`, { recursive: true });
    // This test's own process is alive.
    writeFileSync(`${dir}/.deploy/lock/pid`, `${process.pid}\n`);
    const live = spawnSync('bash', ['-c', `kill -0 ${process.pid}`]).status === 0;
    if (live) {
      const res = deploy('v1.0.0', 'a');
      expect(res.status).toBe(2);
      expect(res.out).toContain('another deploy');
    }
    writeFileSync(`${dir}/.deploy/lock/pid`, '999999\n');
    const res = deploy('v1.0.0', 'a');
    expect(res.status, res.out).toBe(0);
    expect(res.out).toContain('removing a stale lock');
  });

  it('treats a fresh lock without a pid as taken (another run is starting)', () => {
    mkdirSync(`${dir}/.deploy/lock`, { recursive: true });
    const res = deploy('v1.0.0', 'a');
    expect(res.status).toBe(2);
    expect(res.out).toContain('another deploy is starting');
    expect(existsSync(`${dir}/.deploy/lock`)).toBe(true);
  });

  it('pulls the previous images again on a rollback, with the password from stdin', () => {
    expect(deploy('v1.0.0', 'a').status).toBe(0);
    expect(deploy('v1.1.0', 'b').status).toBe(0);
    rmSync(log);
    const res = run(['rollback', '--registry', 'ghcr.io', '--registry-user', 'github-actions[bot]', '--registry-password-stdin'], {}, 'the-token\n');
    expect(res.status, res.out).toBe(0);
    const c = calls();
    expect(c.some((l) => l.startsWith('login ') && l.endsWith('--username github-actions[bot] --password-stdin ghcr.io'))).toBe(true);
    expect(indexOf(c, `pull ${image('a')}`)).toBeGreaterThanOrEqual(0);
    expect(indexOf(c, `pull ${extract('a')}`)).toBeGreaterThanOrEqual(0);
    expect(readFileSync(log, 'utf8')).not.toContain('the-token');
    expect(state('current')).toBe(releaseDir('v1.0.0', 'a'));
  });

  it('keeps the newest releases and never removes the current or previous one', () => {
    for (const [i, c] of ['a', 'b', 'c', 'd'].entries()) expect(deploy(`v1.${i}.0`, c, { LUDY_KEEP_RELEASES: '2' }).status).toBe(0);
    const left = readdirSync(`${dir}/releases`).sort();
    expect(left).toEqual([releaseDir('v1.2.0', 'c'), releaseDir('v1.3.0', 'd')]);
  });

  // #3282: the production steps of #1822 (the context token key) and #1750 (the plain idempotency rows) run in the deploy, on the
  // host, after the database is up and before `migrate`.
  describe('context token key and plain idempotency rows (#3282)', () => {
    const KEY_LINE = /^LUDY_CONTEXT_TOKEN_KEY=([A-Za-z0-9+/]{43}=)$/m;
    const envFile = () => readFileSync(`${dir}/.env`, 'utf8');
    const keyOf = () => KEY_LINE.exec(envFile())?.[1] ?? '';
    const stubKey = () => readFileSync(`${root}/openssl-key`, 'utf8').trim();
    const opensslCalls = () => (existsSync(`${log}.openssl`) ? readFileSync(`${log}.openssl`, 'utf8') : '');
    // Copies of the env file that stay in .deploy: none, unless a write could not be put back.
    const leftovers = () => readdirSync(`${dir}/.deploy`).filter((f) => f.startsWith('env-key.') || f.startsWith('env-old.'));
    const files = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(`${d}/${e.name}`) : [`${d}/${e.name}`]));

    it('writes a 44-character key into an empty line before migrate, keeps the file, and a second deploy leaves it alone', () => {
      writeFileSync(`${dir}/.env`, 'POSTGRES_PASSWORD=x\nLUDY_CONTEXT_TOKEN_KEY=\nOTHER=1\n');
      chmodSync(`${dir}/.env`, 0o600);
      const before = statSync(`${dir}/.env`);
      const first = deploy('v1.0.0', 'a');
      expect(first.status, first.out).toBe(0);
      const key = keyOf();
      expect(key).toHaveLength(44);
      expect(key).toBe(stubKey());
      // Only that line changed; the file keeps its inode (so its owner) and its mode.
      expect(envFile()).toBe(`POSTGRES_PASSWORD=x\nLUDY_CONTEXT_TOKEN_KEY=${key}\nOTHER=1\n`);
      const after = statSync(`${dir}/.env`);
      expect(after.ino).toBe(before.ino);
      expect(after.mode & 0o777).toBe(0o600);
      // The log says it, names the person step, and `migrate` (which saw the key) installs it afterwards.
      expect(first.out).toContain('context token key generated');
      expect(first.out).toContain('person step: copy LUDY_CONTEXT_TOKEN_KEY');
      expect(first.out).not.toContain('context token key present');
      const at = (text: string) => first.out.indexOf(text);
      expect(at('context token key generated')).toBeLessThan(at('running migrations'));
      expect(at('running migrations')).toBeLessThan(at('context token key installed'));
      expect(readFileSync(`${dir}/.deploy/history.log`, 'utf8')).toContain('context token key generated');
      expect(opensslCalls()).toBe('openssl rand -base64 32\n');
      // No copy of the env file is left behind.
      expect(leftovers()).toEqual([]);

      // The second deploy keeps the key: present, no new key, `migrate` has nothing to install.
      writeFileSync(`${root}/openssl-key`, `${randomBytes(32).toString('base64')}\n`);
      const second = deploy('v1.1.0', 'b');
      expect(second.status, second.out).toBe(0);
      expect(second.out).toContain('context token key present');
      expect(second.out).not.toContain('context token key generated');
      expect(second.out).toContain('context token key unchanged');
      expect(keyOf()).toBe(key);
      expect(opensslCalls()).toBe('openssl rand -base64 32\n');
    });

    it('adds the line when the env file has none, also when its last line has no line break', () => {
      writeFileSync(`${dir}/.env`, 'POSTGRES_PASSWORD=x');
      const res = deploy('v1.0.0', 'a');
      expect(res.status, res.out).toBe(0);
      expect(envFile()).toBe(`POSTGRES_PASSWORD=x\nLUDY_CONTEXT_TOKEN_KEY=${stubKey()}\n`);
      expect(res.out).toContain('context token key installed');
    });

    it.each([
      ['export and spaces', 'export  LUDY_CONTEXT_TOKEN_KEY =', 'LUDY_CONTEXT_TOKEN_KEY=@KEY@'],
      ['empty double quotes', 'LUDY_CONTEXT_TOKEN_KEY=""', 'LUDY_CONTEXT_TOKEN_KEY=@KEY@'],
      ['empty single quotes and a comment', "LUDY_CONTEXT_TOKEN_KEY='' # later", 'LUDY_CONTEXT_TOKEN_KEY=@KEY@'],
      ['a comment as the value', 'LUDY_CONTEXT_TOKEN_KEY= # to fill in', 'LUDY_CONTEXT_TOKEN_KEY=@KEY@'],
      ['empty quotes and a comment with a hash in it', 'LUDY_CONTEXT_TOKEN_KEY="" # required by #1822', 'LUDY_CONTEXT_TOKEN_KEY=@KEY@'],
      ['empty quotes and a comment right after them', 'LUDY_CONTEXT_TOKEN_KEY=""#later', 'LUDY_CONTEXT_TOKEN_KEY=@KEY@'],
      ['only spaces', 'LUDY_CONTEXT_TOKEN_KEY=   ', 'LUDY_CONTEXT_TOKEN_KEY=@KEY@'],
      ['a CRLF line break', 'LUDY_CONTEXT_TOKEN_KEY=\r', 'LUDY_CONTEXT_TOKEN_KEY=@KEY@\r'],
      ['the colon form of a dotenv file', 'LUDY_CONTEXT_TOKEN_KEY: ', 'LUDY_CONTEXT_TOKEN_KEY=@KEY@'],
    ])('takes %s for a missing key and replaces that line only', (_name, line, replaced) => {
      writeFileSync(`${dir}/.env`, `A=1\n${line}\nB=2\n`);
      const res = deploy('v1.0.0', 'a');
      expect(res.status, res.out).toBe(0);
      expect(res.out).toContain('context token key generated');
      expect(envFile()).toBe(`A=1\n${replaced.replace('@KEY@', stubKey())}\nB=2\n`);
    });

    it.each([
      ['a value', 'LUDY_CONTEXT_TOKEN_KEY=abc'],
        ['export and a quoted value', 'export LUDY_CONTEXT_TOKEN_KEY="abc"'],
      ['a value and a comment', 'LUDY_CONTEXT_TOKEN_KEY = abc # mine'],
      ['a quoted value with a space and a hash', 'LUDY_CONTEXT_TOKEN_KEY="a # b"'],
      ['a value that starts with a hash (in doubt: kept)', 'LUDY_CONTEXT_TOKEN_KEY=#abc'],
      ['a key that is not 44 characters (never judged, never replaced)', 'LUDY_CONTEXT_TOKEN_KEY=short'],
      ['the colon form of a dotenv file', 'LUDY_CONTEXT_TOKEN_KEY: abc'],
    ])('never replaces an existing key: %s', (_name, line) => {
      const content = `A=1\n${line}\nB=2\n`;
      writeFileSync(`${dir}/.env`, content);
      const res = deploy('v1.0.0', 'a');
      expect(res.status, res.out).toBe(0);
      expect(res.out).toContain('context token key present');
      expect(res.out).not.toContain('context token key generated');
      expect(envFile()).toBe(content);
      expect(opensslCalls()).toBe('');
    });

    it('reads the last assignment, ignores comments and LUDY_CONTEXT_TOKEN_KEY_FILE, and replaces only the last line', () => {
      // The last assignment wins, as in a dotenv file: set, then empty again, is missing; the earlier line stays as it is.
      writeFileSync(`${dir}/.env`, 'LUDY_CONTEXT_TOKEN_KEY=old\nLUDY_CONTEXT_TOKEN_KEY=\n');
      expect(deploy('v1.0.0', 'a').status).toBe(0);
      expect(envFile()).toBe(`LUDY_CONTEXT_TOKEN_KEY=old\nLUDY_CONTEXT_TOKEN_KEY=${stubKey()}\n`);
      // Empty, then set: present.
      writeFileSync(`${dir}/.env`, 'LUDY_CONTEXT_TOKEN_KEY=\nLUDY_CONTEXT_TOKEN_KEY=real\n');
      const present = deploy('v1.1.0', 'b');
      expect(present.out).toContain('context token key present');
      expect(envFile()).toBe('LUDY_CONTEXT_TOKEN_KEY=\nLUDY_CONTEXT_TOKEN_KEY=real\n');
      // A commented-out line and another setting that starts with the same name are no assignment: the line is added.
      writeFileSync(`${dir}/.env`, '# LUDY_CONTEXT_TOKEN_KEY=abc\nLUDY_CONTEXT_TOKEN_KEY_FILE=/data/key\n');
      const added = deploy('v1.2.0', 'c');
      expect(added.out).toContain('context token key generated');
      expect(envFile()).toBe(`# LUDY_CONTEXT_TOKEN_KEY=abc\nLUDY_CONTEXT_TOKEN_KEY_FILE=/data/key\nLUDY_CONTEXT_TOKEN_KEY=${stubKey()}\n`);
    });

    it('never puts the key in a log, an argument, another process\'s environment or the release directory', () => {
      // Every command the script runs through a recording shim: its arguments and its whole environment are kept.
      const shims = ['cat', 'cmp', 'mktemp', 'rm', 'sed', 'grep', 'tr', 'head', 'tail', 'mv', 'cp', 'mkdir', 'date'];
      for (const name of shims) {
        const real = spawnSync('bash', ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim();
        writeFileSync(`${root}/bin/${name}`, `#!/bin/sh\nprintf '%s %s\\n' "${name}" "$*" >>"$STUB_LOG.shim-argv"\nenv >>"$STUB_LOG.shim-env"\nexec ${real} "$@"\n`);
        chmodSync(`${root}/bin/${name}`, 0o755);
      }
      writeFileSync(`${dir}/.env`, 'POSTGRES_PASSWORD=x\nLUDY_CONTEXT_TOKEN_KEY=\n');
      const res = deploy('v1.0.0', 'a');
      expect(res.status, res.out).toBe(0);
      const key = keyOf();
      expect(key).toBe(stubKey());
      // The shims did see the run, so an empty log would prove nothing.
      const argv = readFileSync(`${log}.shim-argv`, 'utf8');
      expect(argv).toContain('mktemp ');
      expect(argv).toContain('cmp ');
      const places: Record<string, string> = {
        'the deploy log': res.out,
        'the stub docker calls': readFileSync(log, 'utf8'),
        'the stub curl calls': readFileSync(`${log}.argv`, 'utf8'),
        'the arguments of the commands it ran': argv,
        'their environments': readFileSync(`${log}.shim-env`, 'utf8'),
        'openssl\'s arguments': opensslCalls(),
      };
      for (const f of files(dir)) if (f !== `${dir}/.env`) places[f] = readFileSync(f, 'utf8');
      for (const [place, text] of Object.entries(places)) expect(text.includes(key), `the key is in ${place}`).toBe(false);
      // Only the env file holds it, and nothing stays that holds a copy of the file.
      expect(files(dir).filter((f) => readFileSync(f, 'utf8').includes(key))).toEqual([`${dir}/.env`]);
    });

    it('stops before anything changes when the key cannot be made, and leaves the env file as it was', () => {
      writeFileSync(`${dir}/.env`, 'POSTGRES_PASSWORD=x\nLUDY_CONTEXT_TOKEN_KEY=\n');
      expect(deploy('v1.0.0', 'a', { STUB_OPENSSL_FAIL: '1' }).status).toBe(1);
      expect(deploy('v1.0.0', 'a').status).toBe(0);
      writeFileSync(`${dir}/.env`, 'POSTGRES_PASSWORD=x\nLUDY_CONTEXT_TOKEN_KEY=\n');
      rmSync(log);
      const failed = deploy('v1.1.0', 'b', { STUB_OPENSSL_FAIL: '1' });
      expect(failed.status, failed.out).toBe(1);
      expect(failed.out).toContain('openssl did not make a 32 byte key');
      expect(failed.out).toContain('the context token key could not be written');
      expect(failed.out).toContain(`${releaseDir('v1.0.0', 'a')} still runs`);
      expect(envFile()).toBe('POSTGRES_PASSWORD=x\nLUDY_CONTEXT_TOKEN_KEY=\n');
      // The migration did not run, the services were not changed, no copy of the env file is left.
      expect(calls().some((l) => l.startsWith('compose run'))).toBe(false);
      expect(running()).toContain(image('a'));
      expect(state('current')).toBe(releaseDir('v1.0.0', 'a'));
      expect(leftovers()).toEqual([]);
      expect(readFileSync(`${dir}/.deploy/history.log`, 'utf8')).toContain('failed: context token key');
    });

    it.each(['', 'not a key', 'AAAA', `${'A'.repeat(44)}`, `${'A'.repeat(43)}=\nsecond line`])('refuses what is not a 32 byte key from openssl (%j)', (answer) => {
      writeFileSync(`${root}/openssl-key`, `${answer}\n`);
      const res = deploy('v1.0.0', 'a');
      expect(res.status, res.out).toBe(1);
      expect(res.out).toContain('openssl did not make a 32 byte key');
      expect(envFile()).toBe('POSTGRES_PASSWORD=x\n');
    });

    it.skipIf(process.getuid?.() === 0)('refuses before pulling when the env file has no key and cannot be written', () => {
      chmodSync(`${dir}/.env`, 0o444);
      const res = deploy('v1.0.0', 'a');
      expect(res.status, res.out).toBe(2);
      expect(res.out).toContain('the deploy user cannot write to the file');
      expect(calls()).toEqual([]);
      // A key that is there needs no write access.
      chmodSync(`${dir}/.env`, 0o644);
      writeFileSync(`${dir}/.env`, 'LUDY_CONTEXT_TOKEN_KEY=abc\n');
      chmodSync(`${dir}/.env`, 0o444);
      expect(deploy('v1.0.0', 'a').status).toBe(0);
    });

    it('makes the key with the real openssl: 44 characters of base64', () => {
      if (spawnSync('bash', ['-c', 'command -v openssl']).status !== 0) return;
      rmSync(`${root}/bin/openssl`);
      const res = deploy('v1.0.0', 'a');
      expect(res.status, res.out).toBe(0);
      const key = keyOf();
      expect(key).toMatch(/^[A-Za-z0-9+/]{43}=$/);
      expect(Buffer.from(key, 'base64')).toHaveLength(32);
    });

    it('leaves the key where it is when the migration fails, on a rollback and on a later deploy', () => {
      writeFileSync(`${dir}/.env`, 'LUDY_CONTEXT_TOKEN_KEY=\n');
      const failed = deploy('v1.0.0', 'a', { STUB_MIGRATE_EXIT: '1' });
      expect(failed.status, failed.out).toBe(1);
      const key = keyOf();
      expect(key).toBe(stubKey());
      expect(deploy('v1.0.0', 'a').status).toBe(0);
      expect(deploy('v1.1.0', 'b').status).toBe(0);
      expect(run(['rollback']).status).toBe(0);
      expect(keyOf()).toBe(key);
      expect(opensslCalls()).toBe('openssl rand -base64 32\n');
    });

    // A write into the env file that fails or is cut off is put back; when even that fails, both copies stay and are named.
    describe('a failed overwrite of the env file', () => {
      const ORIGINAL = 'POSTGRES_PASSWORD=x\nLUDY_CONTEXT_TOKEN_KEY=\nOTHER=1\n';
      // A `cat` that writes three bytes and fails when it reads the pattern's file.
      const failingCat = (pattern: string) => {
        const real = spawnSync('bash', ['-c', 'command -v cat'], { encoding: 'utf8' }).stdout.trim();
        writeFileSync(`${root}/bin/cat`, `#!/bin/sh\nfor a in "$@"; do case "$a" in ${pattern}) printf 'cut'; exit 1;; esac; done\nexec ${real} "$@"\n`);
        chmodSync(`${root}/bin/cat`, 0o755);
      };

      it('puts the env file back as it was and stops before migrate', () => {
        writeFileSync(`${dir}/.env`, ORIGINAL);
        failingCat('*/env-key.*');
        const res = deploy('v1.0.0', 'a');
        expect(res.status, res.out).toBe(1);
        expect(res.out).toContain('the file was put back as it was');
        expect(envFile()).toBe(ORIGINAL);
        expect(leftovers()).toEqual([]);
        expect(calls().some((l) => l.startsWith('compose run'))).toBe(false);
        expect(res.out).not.toContain(stubKey());
      });

      it('keeps the old and the new copy, names them, and says what to do when it cannot put it back', () => {
        writeFileSync(`${dir}/.env`, ORIGINAL);
        failingCat('*/env-key.*|*/env-old.*');
        const res = deploy('v1.0.0', 'a');
        expect(res.status, res.out).toBe(1);
        expect(res.out).toContain('and so did putting it back');
        // The cleanup does not name the copies a second time, with no path.
        expect(res.out).not.toContain('stopped while writing');
        const [old, fresh] = [leftovers().find((f) => f.startsWith('env-old.')) ?? '', leftovers().find((f) => f.startsWith('env-key.')) ?? ''];
        expect(res.out).toContain(`${dir}/.deploy/${old}`);
        expect(res.out).toContain(`${dir}/.deploy/${fresh}`);
        expect(readFileSync(`${dir}/.deploy/${old}`, 'utf8')).toBe(ORIGINAL);
        expect(statSync(`${dir}/.deploy/${old}`).mode & 0o777).toBe(0o600);
        expect(statSync(`${dir}/.deploy/${fresh}`).mode & 0o777).toBe(0o600);
        expect(readFileSync(`${dir}/.deploy/${fresh}`, 'utf8')).toContain(`LUDY_CONTEXT_TOKEN_KEY=${stubKey()}`);
        expect(res.out).not.toContain(stubKey());
      });
    });

    it('takes the key from the env file only: caller LUDY_ and CROVE_CONTEXT_TOKEN_KEY do not reach migrate or up', () => {
      writeFileSync(`${dir}/.env`, 'LUDY_CONTEXT_TOKEN_KEY=\n');
      const res = deploy('v1.0.0', 'a', {
        LUDY_CONTEXT_TOKEN_KEY: 'from-the-session',
        CROVE_CONTEXT_TOKEN_KEY: 'legacy-from-session',
      });
      expect(res.status, res.out).toBe(0);
      expect(res.out).toContain('context token key generated');
      expect(existsSync(`${log}.envvar`)).toBe(false);

      expect(deploy('v1.1.0', 'b').status).toBe(0);
      const rb = run(['rollback'], {
        LUDY_CONTEXT_TOKEN_KEY: 'from-the-session',
        CROVE_CONTEXT_TOKEN_KEY: 'legacy-from-session',
      });
      expect(rb.status, rb.out).toBe(0);
      expect(existsSync(`${log}.envvar`)).toBe(false);
    });

    // The count is read only, runs as the database's superuser in its container, and never fails the deploy.
    it('prints the plain idempotency rows after the database is up and before migrate', () => {
      const res = deploy('v1.0.0', 'a', { STUB_PLAIN_ROWS: '7' });
      expect(res.status, res.out).toBe(0);
      expect(res.out).toContain('[deploy] plain idempotency rows: 7\n');
      const c = calls();
      const exec = c.findIndex((l) => l.startsWith('compose exec '));
      expect(exec).toBeGreaterThan(indexOf(c, 'compose up --detach --no-build --no-deps --wait --wait-timeout 600 db'));
      expect(exec).toBeLessThan(indexOf(c, 'compose run --rm --no-TTY --no-deps migrate'));
      expect(c.filter((l) => l.startsWith('compose exec '))).toEqual([
        "compose exec -T -e PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=30000 -c lock_timeout=5000 db psql -X -q -t -A -v ON_ERROR_STOP=1 -U postgres -d postgres -c SELECT count(*) FROM ludy_kernel.idempotency_key WHERE NOT starts_with(request_sha256, 'k1:')",
      ]);
      expect(deploy('v1.1.0', 'b').out).toContain('[deploy] plain idempotency rows: 0\n');
      // No temporary file of the count stays.
      expect(readdirSync(`${dir}/.deploy`).filter((f) => f.startsWith('count-err.'))).toEqual([]);
    });

    it.each([
      ['psql fails', { STUB_PSQL_FAIL: 'psql: error: relation "ludy_kernel.idempotency_key" does not exist' }, 'does not exist'],
      ['it answers something else than a number', { STUB_PLAIN_ROWS: 'many' }, 'no answer'],
      ['it answers nothing', { STUB_PLAIN_ROWS: '' }, 'no answer'],
    ])('never fails the deploy when the count did not run: %s', (_name, env, text) => {
      const res = deploy('v1.0.0', 'a', env);
      expect(res.status, res.out).toBe(0);
      expect(res.out).toContain('plain idempotency rows: unknown (the count did not run; the deploy goes on)');
      expect(res.out).toContain(text);
      expect(res.out).toContain('deployed v1.0.0');
      expect(state('current')).toBe(releaseDir('v1.0.0', 'a'));
    });

    it('does not count or touch the key on a rollback', () => {
      expect(deploy('v1.0.0', 'a').status).toBe(0);
      expect(deploy('v1.1.0', 'b').status).toBe(0);
      const envBefore = envFile();
      rmSync(log);
      const res = run(['rollback']);
      expect(res.status, res.out).toBe(0);
      expect(res.out).not.toContain('plain idempotency rows');
      expect(res.out).not.toContain('context token key');
      expect(calls().some((l) => l.startsWith('compose exec '))).toBe(false);
      expect(envFile()).toBe(envBefore);
    });
  });

  describe('smoke', () => {
    it('passes when every check answers', () => {
      const res = run(['smoke', 'https://ludy.example.test/']);
      expect(res.status, res.out).toBe(0);
      const urls = readFileSync(log, 'utf8');
      for (const path of ['/healthz', '/readyz', '/api/config', '/auth/v1/health', '/login', '/assets/index-abc123.js']) {
        expect(urls).toContain(`curl https://ludy.example.test${path}\n`);
      }
    });

    it('checks /version when given the build being deployed (#892)', () => {
      const ok = run(['smoke', 'https://ludy.example.test', 'dev']);
      expect(ok.status, ok.out).toBe(0);
      expect(ok.out).toContain('smoke ok: /version answers build dev with every migration applied');
      const other = run(['smoke', 'https://ludy.example.test', '0123456789ab']);
      expect(other.status).toBe(1);
      expect(other.out).toContain('smoke failed: /version answers build 0123456789ab with every migration applied');
      const behind = run(['smoke', 'https://ludy.example.test', 'dev'], { STUB_MIGRATION_MISSING: '1' });
      expect(behind.status).toBe(1);
      expect(behind.out).toContain('"migrationsMissing":["20990101000000_ludy_kernel_next.sql"]');
      expect(run(['smoke', 'https://ludy.example.test']).out).not.toContain('/version');
      expect(run(['smoke', 'https://ludy.example.test', 'a b']).status).toBe(2);
    });

    it('fails, naming the check, when one does not answer', () => {
      const res = run(['smoke', 'https://ludy.example.test'], { STUB_READYZ_FAIL: '1' });
      expect(res.status).toBe(1);
      expect(res.out).toContain('smoke failed: /readyz answers ready');
      expect(res.out).toContain('smoke ok: /healthz answers ok');
    });

    describe('account step (#690)', () => {
      // A password with characters a JSON body or a shell would have to escape.
      const PASSWORD = 'smoke "pass" \\ word $HOME 0123';
      const account = { SMOKE_EMAIL: 'smoke@example.com', SMOKE_PASSWORD: PASSWORD, SMOKE_ORG: 'ludy-smoke', LUDY_SMOKE_POLL_SECONDS: '1' };
      const STEP = 'signs in, uploads a synthetic e-invoice to org ludy-smoke and gets a proposal';
      const read = (suffix: string) => (existsSync(`${log}.${suffix}`) ? readFileSync(`${log}.${suffix}`, 'utf8') : '');

      it('is skipped with a notice without SMOKE_EMAIL and SMOKE_PASSWORD', () => {
        const res = run(['smoke', 'https://ludy.example.test'], { SMOKE_EMAIL: 'smoke@example.com' });
        expect(res.status, res.out).toBe(0);
        expect(res.out).toContain('smoke skipped: sign-in and upload (SMOKE_EMAIL and SMOKE_PASSWORD are not set)');
        expect(readFileSync(log, 'utf8')).not.toContain('/auth/v1/token');
      });

      it('fails the smoke command, which makes the workflow roll back', () => {
        const res = run(['smoke', 'https://ludy.example.test'], { ...account, STUB_SIGNIN_FAIL: '1' });
        expect(res.status).toBe(1);
        expect(res.out).toContain('smoke test failed on https://ludy.example.test');
      });

      it('signs in, uploads one synthetic e-invoice, waits for its proposal and rejects it', () => {
        const res = run(['smoke', 'https://ludy.example.test'], account);
        expect(res.status, res.out).toBe(0);
        expect(res.out).toContain(`smoke ok: ${STEP}`);
        expect(JSON.parse(read('signin'))).toEqual({ email: 'smoke@example.com', password: PASSWORD });
        const invoice = read('upload');
        expect(invoice).toMatch(/<SHDon>\d{10}<\/SHDon>/);
        // Synthetic parties only: tax codes that fail the checksum.
        expect(invoice).toContain('<MST>0101234564</MST>');
        expect(invoice).toContain('<MST>0309876546</MST>');
        expect(JSON.parse(read('rpc'))).toEqual({ json: { id: 'proposal-1', reason: 'Kiểm thử sau triển khai' } });
        // Neither the password nor the access token is on any command line.
        const argv = read('argv');
        expect(argv).toContain('/auth/v1/token?grant_type=password');
        expect(argv).not.toContain('"pass"');
        expect(argv).not.toContain('stub-access-token');
      });

      it('fails when the sign-in is refused, without uploading', () => {
        const res = run(['smoke', 'https://ludy.example.test'], { ...account, STUB_SIGNIN_FAIL: '1' });
        expect(res.status).toBe(1);
        expect(res.out).toContain('smoke: signing in with SMOKE_EMAIL and SMOKE_PASSWORD failed');
        expect(res.out).toContain(`smoke failed: ${STEP}`);
        expect(read('upload')).toBe('');
      });

      it('fails when the worker cannot extract the upload, or no proposal comes in time', () => {
        const failed = run(['smoke', 'https://ludy.example.test'], { ...account, STUB_FILE_STATUS: 'failed' });
        expect(failed.status).toBe(1);
        expect(failed.out).toContain('smoke: the worker could not extract the synthetic e-invoice: UNREADABLE');
        const pending = run(['smoke', 'https://ludy.example.test'], { ...account, STUB_FILE_STATUS: 'extracting' });
        expect(pending.status).toBe(1);
        expect(pending.out).toContain('smoke: no proposal after 1s (file extracting)');
        // An empty proposal id is not filled from the next field.
        const noId = run(['smoke', 'https://ludy.example.test'], { ...account, STUB_FILE_STATUS: 'proposed-no-id' });
        expect(noId.status).toBe(1);
        expect(noId.out).toContain('smoke: no proposal after 1s (file proposed)');
        expect(read('rpc')).toBe('');
      });

      it('fails when the proposal cannot be rejected', () => {
        const res = run(['smoke', 'https://ludy.example.test'], { ...account, STUB_REJECT_FAIL: '1' });
        expect(res.status).toBe(1);
        expect(res.out).toContain('smoke: rejecting the smoke proposal proposal-1 failed');
      });

      it('never sends the password over plain http to another host', () => {
        const res = run(['smoke', 'http://ludy.example.test'], account);
        expect(res.status).toBe(1);
        expect(res.out).toContain('the account step signs in only over https');
        expect(read('signin')).toBe('');
      });

      it('refuses an org that is not a slug', () => {
        const res = run(['smoke', 'https://ludy.example.test'], { ...account, SMOKE_ORG: 'Ludy Smoke' });
        expect(res.status).toBe(1);
        expect(res.out).toContain("SMOKE_ORG must be the smoke org's slug");
        expect(read('signin')).toBe('');
      });
    });
  });

  describe('check-app-build (#3580)', () => {
    const SHA = 'a8bebb273126a7df7e61535419a9b4063527caec';
    const OLD = '74ce84f800000000000000000000000000000000';
    const APP = 'https://app.example.test';
    const API = 'https://api.example.test';

    it('passes when the served bundle VITE_BUILD matches /version (backtick or quoted, skipping theme-boot.js)', () => {
      const html = '<div id="root"></div><script src="/assets/theme-boot.js"></script><script type="module" crossorigin src="/assets/index-abc123.js"></script>';
      const backtick = run(['check-app-build', APP, SHA, API], {
        STUB_VERSION_BUILD: SHA,
        STUB_APP_HTML: html,
        STUB_APP_BUNDLE_JS: `const env={PROD:!0,VITE_BUILD:\`${SHA}\`};`,
        LUDY_APP_BUILD_TIMEOUT: '0',
        LUDY_APP_BUILD_POLL: '0',
      });
      expect(backtick.status, backtick.out).toBe(0);
      expect(backtick.out).toContain(`web app ok: ${APP} bundle VITE_BUILD matches ${API}/version (${SHA})`);

      const quoted = run(['check-app-build', `${APP}/`, SHA], {
        STUB_APP_HTML: html,
        STUB_APP_BUNDLE_JS: `const env={"VITE_BUILD":"${SHA}"};`,
        LUDY_APP_BUILD_TIMEOUT: '0',
        LUDY_APP_BUILD_POLL: '0',
      });
      expect(quoted.status, quoted.out).toBe(0);
      expect(quoted.out).toContain(`web app ok: ${APP} bundle VITE_BUILD matches ${SHA}`);
    });

    it('follows dynamically imported asset chunks when VITE_BUILD lives in a split chunk', () => {
      for (const ref of ['./assets/router-xyz.js', '/assets/router-xyz.js']) {
        writeFileSync(log, '');
        const ok = run(['check-app-build', APP, SHA, API], {
          STUB_VERSION_BUILD: SHA,
          STUB_APP_BUNDLE_JS: `navigator.serviceWorker?.register("/assets/sw.js");import("${ref}");`,
          STUB_APP_ROUTER_JS: `const e={VITE_BUILD:\`${SHA}\`};`,
          LUDY_APP_BUILD_TIMEOUT: '0',
          LUDY_APP_BUILD_POLL: '0',
        });
        expect(ok.status, `${ref}: ${ok.out}`).toBe(0);
        const curls = readFileSync(log, 'utf8');
        expect(curls).toContain(`curl ${APP}/assets/router-xyz.js\n`);
        expect(curls).not.toContain('//assets/');
      }
    });

    it('retries while the static host still serves the older bundle and passes once updated', () => {
      const res = run(['check-app-build', APP, SHA, API], {
        STUB_VERSION_BUILD: SHA,
        STUB_APP_BUNDLE_JS: `const env={VITE_BUILD:\`${OLD}\`};`,
        STUB_APP_BUNDLE_NEXT: `const env={VITE_BUILD:\`${SHA}\`};`,
        STUB_APP_SWITCH_ON: '2',
        LUDY_APP_BUILD_TIMEOUT: '2',
        LUDY_APP_BUILD_POLL: '0',
      });
      expect(res.status, res.out).toBe(0);
      expect(res.out).toContain(`waiting for web app at ${APP} to serve build ${SHA} (observed: ${OLD})`);
      expect(res.out).toContain(`web app ok: ${APP} bundle VITE_BUILD matches ${API}/version (${SHA})`);
    });

    it('fails loudly when bundle VITE_BUILD stays mismatched or empty, or when /version differs', () => {
      const stale = run(['check-app-build', APP, SHA, API], {
        STUB_VERSION_BUILD: SHA,
        STUB_APP_BUNDLE_JS: `const env={VITE_BUILD:\`${OLD}\`};`,
        LUDY_APP_BUILD_TIMEOUT: '0',
        LUDY_APP_BUILD_POLL: '0',
      });
      expect(stale.status).toBe(1);
      expect(stale.out).toContain(`web app at ${APP} does not serve bundle build ${SHA} (observed: ${OLD}) matching ${API}/version`);

      const staleQuoted = run(['check-app-build', APP, SHA, API], {
        STUB_VERSION_BUILD: SHA,
        STUB_APP_BUNDLE_JS: `const env={"VITE_BUILD":"${OLD}"};`,
        LUDY_APP_BUILD_TIMEOUT: '0',
        LUDY_APP_BUILD_POLL: '0',
      });
      expect(staleQuoted.status).toBe(1);
      expect(staleQuoted.out).toContain(`web app at ${APP} does not serve bundle build ${SHA} (observed: ${OLD}) matching ${API}/version`);

      const empty = run(['check-app-build', APP, SHA, API], {
        STUB_VERSION_BUILD: SHA,
        STUB_APP_BUNDLE_JS: 'const env={VITE_BUILD:``};',
        LUDY_APP_BUILD_TIMEOUT: '0',
        LUDY_APP_BUILD_POLL: '0',
      });
      expect(empty.status).toBe(1);
      expect(empty.out).toContain('(observed: (empty))');

      const apiMismatch = run(['check-app-build', APP, SHA, API], {
        STUB_VERSION_BUILD: OLD,
        STUB_APP_BUNDLE_JS: `const env={VITE_BUILD:\`${SHA}\`};`,
        LUDY_APP_BUILD_TIMEOUT: '0',
        LUDY_APP_BUILD_POLL: '0',
      });
      expect(apiMismatch.status).toBe(1);
      expect(apiMismatch.out).toContain(`API at ${API}/version does not report build ${SHA}`);

      const noBundle = run(['check-app-build', APP, SHA], {
        STUB_NO_BUNDLE: '1',
        LUDY_APP_BUILD_TIMEOUT: '0',
        LUDY_APP_BUILD_POLL: '0',
      });
      expect(noBundle.status).toBe(1);
      expect(noBundle.out).toContain('(observed: no script bundle in HTML)');

      const bareShaWithoutKey = run(['check-app-build', APP, SHA, API], {
        STUB_VERSION_BUILD: SHA,
        STUB_APP_BUNDLE_JS: `const COMMIT="${SHA}";`,
        LUDY_APP_BUILD_TIMEOUT: '0',
        LUDY_APP_BUILD_POLL: '0',
      });
      expect(bareShaWithoutKey.status).toBe(1);
      expect(bareShaWithoutKey.out).toContain('(observed: none)');
    });

    it('rejects traversal, query strings, curl globs, and 3xx redirects, and hardens curl flags', () => {
      const unsafeHtml = [
        '<div id="root"></div>',
        '<script src="/assets/../../internal/foo.js"></script>',
        '<script src="/assets/index.js?redirect=https://evil.example"></script>',
        '<script src="/assets/a[1-99999].js"></script>',
        '<script src="/assets/..foo.js"></script>',
      ].join('');
      const unsafeOnly = run(['check-app-build', APP, SHA], {
        STUB_APP_HTML: unsafeHtml,
        LUDY_APP_BUILD_TIMEOUT: '0',
        LUDY_APP_BUILD_POLL: '0',
      });
      expect(unsafeOnly.status).toBe(1);
      expect(unsafeOnly.out).toContain('(observed: no script bundle in HTML)');
      expect(readFileSync(log, 'utf8')).toBe(`curl ${APP}/login\n`);

      writeFileSync(log, '');
      writeFileSync(`${log}.argv`, '');
      const mixed = run(['check-app-build', APP, SHA], {
        STUB_APP_HTML: `${unsafeHtml}<script type="module" src="/assets/index-abc123.js"></script>`,
        STUB_APP_BUNDLE_JS: `const env={VITE_BUILD:\`${SHA}\`};`,
        LUDY_APP_BUILD_TIMEOUT: '0',
        LUDY_APP_BUILD_POLL: '0',
      });
      expect(mixed.status, mixed.out).toBe(0);
      expect(readFileSync(log, 'utf8')).toBe(`curl ${APP}/login\ncurl ${APP}/assets/index-abc123.js\n`);
      const argv = readFileSync(`${log}.argv`, 'utf8').split('\n').filter(Boolean);
      expect(argv[0]).toMatch(/^-q .*--globoff .*--location --max-redirs 0 --proto =http,https --proto-redir =http,https .* -- https:\/\/app\.example\.test\/login$/);

      const redirect = run(['check-app-build', APP, SHA], {
        STUB_APP_REDIRECT: '1',
        LUDY_APP_BUILD_TIMEOUT: '0',
        LUDY_APP_BUILD_POLL: '0',
      });
      expect(redirect.status).toBe(1);
      expect(redirect.out).toContain('(observed: request failed)');

      const leadingZero = run(['check-app-build', APP, SHA], {
        STUB_APP_BUNDLE_JS: `const env={VITE_BUILD:\`${SHA}\`};`,
        LUDY_APP_BUILD_TIMEOUT: '08',
        LUDY_APP_BUILD_POLL: '00',
      });
      expect(leadingZero.status, leadingZero.out).toBe(0);
    });

    it('refuses invalid arguments with exit 2', () => {
      expect(run(['check-app-build', 'app.example.test', SHA]).status).toBe(2);
      expect(run(['check-app-build', APP, 'bad build']).status).toBe(2);
      expect(run(['check-app-build', APP, SHA, 'not-a-url']).status).toBe(2);
      expect(run(['check-app-build', APP]).status).toBe(2);
    });
  });
  // #2704: the pilot's identity provider settings. With --auth-settings the deploy edits the host's env file (step 5 of
  // docs/runbooks/pilot-sign-in-remote-idp.md) after a dated private copy, and puts the copy back when the deploy fails or the
  // release is rolled back. Every value in these tests is made up (example.com, example.org).
  describe('identity provider settings (#2704)', () => {
    const IDP: Record<string, string> = {
      AUTH_ISSUER: 'https://idp.example.com/auth/v1',
      AUTH_JWKS_URL: 'https://idp.example.com/auth/v1/.well-known/jwks.json',
      PUBLIC_AUTH_URL: 'https://idp.example.com/auth/v1',
      PUBLIC_AUTH_ANON_KEY: 'sb_publishable_TESTKEYabcdef0123456789',
      AUTH_ALLOWED_EMAILS: '@example.com,owner@example.org',
    };
    // What a stale pilot env file holds before: the bundled Supabase Auth, an invite-only sign-up policy and its prober.
    const BEFORE = [
      'POSTGRES_PASSWORD=x',
      'LUDY_CONTEXT_TOKEN_KEY=already-here',
      '# kept comment: AUTH_SIGNUP_POLICY=open',
      'AUTH_JWT_SECRET=keep-this-secret',
      'AUTH_ISSUER=crove-auth',
      'AUTH_SESSION_CHECK=db',
      'export AUTH_UPSTREAM_URL=http://auth:9999',
      'AUTH_SIGNUP_POLICY=invite_only',
      'AUTH_SIGNUP_ALLOWED_DOMAINS=example.net',
      'PROBER_AUTH_URL=http://ludy:8080/auth/v1',
      'AUTH_OAUTH_PROVIDERS=github',
      'PUBLIC_URL=https://api.example.com',
      '',
    ].join('\n');
    const envFile = () => readFileSync(`${dir}/.env`, 'utf8');
    const lines = (text: string) => text.split('\n').filter(Boolean);
    // Where the workflow uploads it: the release's private incoming directory, the only place deploy.sh removes a settings file from.
    const settingsPath = () => `${dir}/.deploy/incoming/run/auth-settings.env`;
    const putSettings = (text: string) => {
      mkdirSync(`${dir}/.deploy/incoming/run`, { recursive: true });
      writeFileSync(settingsPath(), text);
    };
    const writeSettings = (values: Record<string, string>) => putSettings(Object.entries(values).map(([k, v]) => `${k}=${v}\n`).join(''));
    const deployIdp = (release: string, c: string, values: Record<string, string> | null = IDP, env: Record<string, string> = {}) => {
      if (values !== null) writeSettings(values);
      return run(['deploy', '--release', release, '--image', image(c), '--extract-image', extract(c), '--media-image', media(c), '--compose', compose, '--auth-settings', settingsPath()], env);
    };
    const copies = () => readdirSync(dir).filter((f) => f.startsWith('.env.bak-'));
    const everyFile = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? everyFile(`${d}/${e.name}`) : [`${d}/${e.name}`]));
    const SPLIT_SERVICES = 'db migrate auth auth-grants ludy-extract api worker prober';

    it('leaves the env file alone without --auth-settings', () => {
      writeFileSync(`${dir}/.env`, BEFORE);
      const res = deploy('v1.0.0', 'a');
      expect(res.status, res.out).toBe(0);
      expect(envFile()).toBe(BEFORE);
      expect(copies()).toEqual([]);
      expect(res.out).not.toContain('identity provider');
      expect(existsSync(`${dir}/.deploy/env-backup`)).toBe(false);
      // The proxy check still runs when the host keeps the bundled Supabase Auth.
      expect(res.out).toContain('smoke ok: /auth/v1/health answers (Supabase Auth through the proxy)');
    });

    it('sets exactly the lines of the runbook, removes the three, keeps every other line, and keeps a private dated copy', () => {
      writeFileSync(`${dir}/.env`, BEFORE);
      chmodSync(`${dir}/.env`, 0o600);
      const res = deployIdp('v1.0.0', 'a', IDP, { STUB_SERVICES: SPLIT_SERVICES });
      expect(res.status, res.out).toBe(0);
      expect(lines(envFile())).toEqual([
        'POSTGRES_PASSWORD=x',
        'LUDY_CONTEXT_TOKEN_KEY=already-here',
        '# kept comment: AUTH_SIGNUP_POLICY=open',
        'AUTH_JWT_SECRET=keep-this-secret',
        'PUBLIC_URL=https://api.example.com',
        ...Object.entries(IDP).map(([k, v]) => `${k}=${v}`),
        'AUTH_SESSION_CHECK=jwt',
        'AUTH_UPSTREAM_URL=',
      ]);
      // The copy next to the env file: the old content, mode 600; the env file keeps its mode.
      expect(copies()).toHaveLength(1);
      expect(readFileSync(`${dir}/${copies()[0]}`, 'utf8')).toBe(BEFORE);
      if (process.platform !== 'win32') {
        expect(statSync(`${dir}/${copies()[0]}`).mode & 0o777).toBe(0o600);
        expect(statSync(`${dir}/.env`).mode & 0o777).toBe(0o600);
      }
      expect(state('env-backup')).toMatch(new RegExp(`^${releaseDir('v1.0.0', 'a')} ${dir}/${copies()[0]} [0-9a-f]{64}$`));
      // Written after the migration and before the services are recreated with it.
      const c = calls();
      expect(indexOf(c, 'run --rm --no-TTY --no-deps migrate')).toBeGreaterThanOrEqual(0);
      expect(res.out).toContain('identity provider settings written to');
      expect(res.out).toContain('set: AUTH_ISSUER AUTH_JWKS_URL PUBLIC_AUTH_URL PUBLIC_AUTH_ANON_KEY AUTH_ALLOWED_EMAILS AUTH_SESSION_CHECK AUTH_UPSTREAM_URL; removed: AUTH_SIGNUP_POLICY AUTH_SIGNUP_ALLOWED_DOMAINS PROBER_AUTH_URL');
      expect(indexOf(res.out.split('\n'), 'identity provider settings written')).toBeLessThan(indexOf(res.out.split('\n'), 'rolling the worker'));
      expect(indexOf(c, 'compose up --detach --no-build --no-deps worker')).toBeGreaterThan(indexOf(c, 'run --rm --no-TTY --no-deps migrate'));
      // The services were recreated (worker, API, prober) and the smoke test skipped the proxy check, which a remote provider has none of.
      expect(c.some((l) => l.endsWith('--wait-timeout 600 prober'))).toBe(true);
      expect(res.out).toContain('smoke skipped: /auth/v1/health');
      expect(res.out).not.toContain('smoke failed');
      // The provider was asked before anything changed (its keys and its /health); the host's own proxy was not.
      expect(res.out).toContain('identity provider: AUTH_JWKS_URL answers with an ES256 or RS256 key');
      expect(readFileSync(log, 'utf8')).not.toContain('curl http://127.0.0.1:18080/auth/v1/health');
      // The settings file is removed once read.
      expect(existsSync(settingsPath())).toBe(false);
    });

    it('writes the optional settings, quotes the button words, and takes an optional line out when the environment no longer defines it', () => {
      writeFileSync(`${dir}/.env`, BEFORE);
      const full = {
        ...IDP,
        AUTH_OAUTH_PROVIDERS: 'google, github',
        AUTH_HOSTED_LOGIN_URL: 'https://login.example.com/authorize',
        AUTH_HOSTED_LOGIN_TOKEN_URL: 'https://login.example.com/token',
        AUTH_HOSTED_LOGIN_NAME: 'Login with Ví dụ',
      };
      const res = deployIdp('v1.0.0', 'a', full);
      expect(res.status, res.out).toBe(0);
      const env = lines(envFile());
      expect(env).toContain('AUTH_OAUTH_PROVIDERS=google,github');
      expect(env).toContain('AUTH_HOSTED_LOGIN_URL=https://login.example.com/authorize');
      expect(env).toContain('AUTH_HOSTED_LOGIN_TOKEN_URL=https://login.example.com/token');
      expect(env).toContain("AUTH_HOSTED_LOGIN_NAME='Login with Ví dụ'");
      expect(env.filter((l) => l.startsWith('AUTH_OAUTH_PROVIDERS='))).toHaveLength(1);
      // The settings are the environment's: without the buttons and the hosted login, those lines leave the file.
      const second = deployIdp('v1.1.0', 'b', IDP);
      expect(second.status, second.out).toBe(0);
      expect(lines(envFile()).some((l) => l.startsWith('AUTH_OAUTH_PROVIDERS=') || l.startsWith('AUTH_HOSTED_LOGIN'))).toBe(false);
    });

    it('does nothing, and makes no copy, when the env file already has exactly these settings', () => {
      writeFileSync(`${dir}/.env`, BEFORE);
      expect(deployIdp('v1.0.0', 'a').status).toBe(0);
      const done = envFile();
      expect(copies()).toHaveLength(1);
      const res = deployIdp('v1.1.0', 'b');
      expect(res.status, res.out).toBe(0);
      expect(res.out).toContain('already in');
      expect(envFile()).toBe(done);
      expect(copies()).toHaveLength(1);
      // This deploy changed nothing, so a rollback from it does not touch the file.
      expect(existsSync(`${dir}/.deploy/env-backup`)).toBe(false);
      const back = run(['rollback']);
      expect(back.status, back.out).toBe(0);
      expect(envFile()).toBe(done);
    });

    it('keeps Windows line breaks: the added lines get them too', () => {
      writeFileSync(`${dir}/.env`, 'POSTGRES_PASSWORD=x\r\nLUDY_CONTEXT_TOKEN_KEY=already-here\r\nAUTH_SIGNUP_POLICY=invite_only\r\n');
      expect(deployIdp('v1.0.0', 'a').status).toBe(0);
      const text = envFile();
      expect(text.split('\n').filter(Boolean).every((l) => l.endsWith('\r'))).toBe(true);
      expect(text).toContain('AUTH_UPSTREAM_URL=\r\n');
      expect(text).not.toContain('AUTH_SIGNUP_POLICY');
    });

    it('does not take a commented-out line, another setting with a longer name or a value for an assignment', () => {
      const before = '# AUTH_ISSUER=old\nAUTH_ISSUER_EXTRA=keep\nSOME=AUTH_SIGNUP_POLICY=x\nLUDY_CONTEXT_TOKEN_KEY=already-here\n  AUTH_SIGNUP_POLICY : allowlist\n';
      writeFileSync(`${dir}/.env`, before);
      expect(deployIdp('v1.0.0', 'a').status).toBe(0);
      const env = lines(envFile());
      expect(env.slice(0, 3)).toEqual(['# AUTH_ISSUER=old', 'AUTH_ISSUER_EXTRA=keep', 'SOME=AUTH_SIGNUP_POLICY=x']);
      expect(env.some((l) => l.includes('allowlist'))).toBe(false);
    });

    describe('checks every value before the host is touched', () => {
      const bad: Array<[string, Record<string, string>, string]> = [
        ['an http issuer', { ...IDP, AUTH_ISSUER: 'http://idp.example.com/auth/v1' }, 'AUTH_ISSUER'],
        ['an issuer with a command substitution', { ...IDP, AUTH_ISSUER: 'https://idp.example.com/$(touch pwned)' }, 'AUTH_ISSUER'],
        ['an issuer with a backtick', { ...IDP, AUTH_ISSUER: 'https://idp.example.com/`touch pwned`' }, 'AUTH_ISSUER'],
        ['an issuer with a query', { ...IDP, AUTH_ISSUER: 'https://idp.example.com/auth/v1?x=1' }, 'AUTH_ISSUER'],
        ['an issuer with a fragment', { ...IDP, AUTH_ISSUER: 'https://idp.example.com/auth/v1#frag' }, 'AUTH_ISSUER'],
        ['an issuer with a user', { ...IDP, AUTH_ISSUER: 'https://user@idp.example.com/auth/v1' }, 'AUTH_ISSUER'],
        ['an issuer with a quote', { ...IDP, AUTH_ISSUER: 'https://idp.example.com/a"b' }, 'AUTH_ISSUER'],
        ['an issuer that is an IP address', { ...IDP, AUTH_ISSUER: 'https://127.0.0.1/auth/v1', AUTH_JWKS_URL: 'https://127.0.0.1/keys' }, 'AUTH_ISSUER'],
        ['an issuer on localhost', { ...IDP, AUTH_ISSUER: 'https://localhost/auth/v1', AUTH_JWKS_URL: 'https://localhost/keys' }, 'AUTH_ISSUER'],
        ['a port out of range', { ...IDP, PUBLIC_AUTH_URL: 'https://idp.example.com:99999/auth/v1' }, 'PUBLIC_AUTH_URL'],
        ['a path with ..', { ...IDP, AUTH_JWKS_URL: 'https://idp.example.com/../keys' }, 'AUTH_JWKS_URL'],
        ['keys on another origin than the issuer', { ...IDP, AUTH_JWKS_URL: 'https://keys.example.net/auth/v1/.well-known/jwks.json' }, 'same origin'],
        ['a key with a space', { ...IDP, PUBLIC_AUTH_ANON_KEY: 'sb_publishable_ with space 1234' }, 'PUBLIC_AUTH_ANON_KEY'],
        ['a key with a semicolon', { ...IDP, PUBLIC_AUTH_ANON_KEY: 'sb_publishable_1234567890;rm' }, 'PUBLIC_AUTH_ANON_KEY'],
        ['a key that is too short', { ...IDP, PUBLIC_AUTH_ANON_KEY: 'short' }, 'PUBLIC_AUTH_ANON_KEY'],
        ['an upper-case provider id', { ...IDP, AUTH_OAUTH_PROVIDERS: 'Google' }, 'AUTH_OAUTH_PROVIDERS'],
        ['a provider id with a dash', { ...IDP, AUTH_OAUTH_PROVIDERS: 'go-ogle' }, 'AUTH_OAUTH_PROVIDERS'],
        ['a provider id with a semicolon', { ...IDP, AUTH_OAUTH_PROVIDERS: 'google;github' }, 'AUTH_OAUTH_PROVIDERS'],
        ['thirteen providers', { ...IDP, AUTH_OAUTH_PROVIDERS: 'a,b,c,d,e,f,g,h,i,j,k,l,m' }, 'AUTH_OAUTH_PROVIDERS'],
        ['a hosted login page without its token endpoint', { ...IDP, AUTH_HOSTED_LOGIN_URL: 'https://login.example.com/authorize' }, 'both AUTH_HOSTED_LOGIN_URL'],
        ['a hosted token endpoint without its page', { ...IDP, AUTH_HOSTED_LOGIN_TOKEN_URL: 'https://login.example.com/token' }, 'both AUTH_HOSTED_LOGIN_URL'],
        ['hosted login words without the hosted login', { ...IDP, AUTH_HOSTED_LOGIN_NAME: 'Login' }, 'AUTH_HOSTED_LOGIN_NAME needs'],
        ['an http hosted login', { ...IDP, AUTH_HOSTED_LOGIN_URL: 'http://login.example.com/a', AUTH_HOSTED_LOGIN_TOKEN_URL: 'https://login.example.com/token' }, 'AUTH_HOSTED_LOGIN_URL'],
        ...['a$HOME', 'a`id`', "it's", 'say "hi"', 'a\\b', 'a#b', 'a=b', 'a;b', 'a&b', 'a|b', 'a<b', '<b>', ' lead', 'trail ', 'a(b)', 'a{b}', 'a*b', 'a~b', 'a%b', 'a[b]', 'a!b'].map(
          (name): [string, Record<string, string>, string] => [
            `hosted login words ${JSON.stringify(name)}`,
            { ...IDP, AUTH_HOSTED_LOGIN_URL: 'https://login.example.com/authorize', AUTH_HOSTED_LOGIN_TOKEN_URL: 'https://login.example.com/token', AUTH_HOSTED_LOGIN_NAME: name },
            'AUTH_HOSTED_LOGIN_NAME',
          ],
        ),
        ['hosted login words over 40 characters (the kernel refuses them at boot)', { ...IDP, AUTH_HOSTED_LOGIN_URL: 'https://login.example.com/a', AUTH_HOSTED_LOGIN_TOKEN_URL: 'https://login.example.com/t', AUTH_HOSTED_LOGIN_NAME: 'x'.repeat(41) }, 'AUTH_HOSTED_LOGIN_NAME'],
        ['an address with a space inside', { ...IDP, AUTH_ALLOWED_EMAILS: 'own er@example.org' }, 'AUTH_ALLOWED_EMAILS'],
        ['an address with no domain dot', { ...IDP, AUTH_ALLOWED_EMAILS: 'owner@example' }, 'AUTH_ALLOWED_EMAILS'],
        ['an address with a semicolon', { ...IDP, AUTH_ALLOWED_EMAILS: 'owner@example.org;x@example.org' }, 'AUTH_ALLOWED_EMAILS'],
        ['an address with a dollar', { ...IDP, AUTH_ALLOWED_EMAILS: 'o$wner@example.org' }, 'AUTH_ALLOWED_EMAILS'],
        ['a bare @', { ...IDP, AUTH_ALLOWED_EMAILS: '@' }, 'AUTH_ALLOWED_EMAILS'],
        ['an @domain entry over 254 characters', { ...IDP, AUTH_ALLOWED_EMAILS: `@${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(60)}.${'e'.repeat(20)}.example` }, 'AUTH_ALLOWED_EMAILS'],
        ['an address whose last label ends in a dash (the kernel refuses it, and the worker would not boot)', { ...IDP, AUTH_ALLOWED_EMAILS: 'a@example.org,owner@gmail.com-' }, 'AUTH_ALLOWED_EMAILS'],
        ['a domain whose last label ends in a dash', { ...IDP, AUTH_ALLOWED_EMAILS: '@example.co-' }, 'AUTH_ALLOWED_EMAILS'],
        ['a domain with a label that ends in a dash', { ...IDP, AUTH_ALLOWED_EMAILS: '@bad-.example.com' }, 'AUTH_ALLOWED_EMAILS'],
        ['a domain whose last label starts with a digit', { ...IDP, AUTH_ALLOWED_EMAILS: '@example.1com' }, 'AUTH_ALLOWED_EMAILS'],
        ['an issuer whose last label ends in a dash', { ...IDP, AUTH_ISSUER: 'https://idp.example.co-/auth/v1', AUTH_JWKS_URL: 'https://idp.example.co-/keys' }, 'AUTH_ISSUER'],
        ['an issuer on a .localhost name', { ...IDP, AUTH_ISSUER: 'https://idp.localhost/auth/v1', AUTH_JWKS_URL: 'https://idp.localhost/keys' }, 'AUTH_ISSUER'],
        ['an Auth URL on a .localhost name', { ...IDP, PUBLIC_AUTH_URL: 'https://app.example.LOCALHOST/auth/v1' }, 'PUBLIC_AUTH_URL'],
        ['a list of only commas', { ...IDP, AUTH_ALLOWED_EMAILS: ',' }, 'AUTH_ALLOWED_EMAILS'],
        ['a line break smuggling a second assignment', { ...IDP, AUTH_ISSUER: 'https://idp.example.com/auth/v1\nAUTH_JWT_SECRET=evil' }, 'unknown identity provider setting AUTH_JWT_SECRET'],
        ['a line break smuggling a known name twice', { ...IDP, AUTH_ISSUER: 'https://idp.example.com/auth/v1\nAUTH_ALLOWED_EMAILS=@evil.example' }, 'given twice'],
        ['a carriage return', { ...IDP, AUTH_ISSUER: 'https://idp.example.com/auth/v1\r' }, 'AUTH_ISSUER'],
        ['a setting of another name', { ...IDP, AUTH_JWT_SECRET: 'x'.repeat(20) }, 'unknown identity provider setting AUTH_JWT_SECRET'],
        ['COMPOSE_FILE', { ...IDP, COMPOSE_FILE: 'docker-compose.yml' }, 'unknown identity provider setting COMPOSE_FILE'],
        ['a missing issuer', Object.fromEntries(Object.entries(IDP).filter(([k]) => k !== 'AUTH_ISSUER')), 'AUTH_ISSUER is required'],
        ['a missing key', Object.fromEntries(Object.entries(IDP).filter(([k]) => k !== 'PUBLIC_AUTH_ANON_KEY')), 'PUBLIC_AUTH_ANON_KEY is required'],
        ['no allowed addresses', Object.fromEntries(Object.entries(IDP).filter(([k]) => k !== 'AUTH_ALLOWED_EMAILS')), 'AUTH_ALLOWED_EMAILS is required'],
      ];

      it.each(bad)('refuses %s: exit 2, nothing pulled or changed, no value in the message', (_name, values, message) => {
        writeFileSync(`${dir}/.env`, BEFORE);
        const res = deployIdp('v1.0.0', 'a', values);
        expect(res.status, res.out).toBe(2);
        expect(res.out).toContain(message);
        expect(res.out).toContain('nothing was changed');
        // Nothing ran: no pull, no compose call, no copy, no new env file, no state.
        expect(calls()).toEqual([]);
        expect(envFile()).toBe(BEFORE);
        expect(copies()).toEqual([]);
        expect(existsSync(`${dir}/.deploy/current`)).toBe(false);
        // The file, with the secret in it, does not stay on the host when it is refused either.
        expect(existsSync(settingsPath())).toBe(false);
        // The message names the setting, never what it was given.
        for (const [k, v] of Object.entries(values)) {
          if (v.length >= 6 && !['AUTH_ISSUER', 'AUTH_JWKS_URL', 'PUBLIC_AUTH_URL'].includes(k)) expect(res.out.includes(v), `${k}'s value is in the output`).toBe(false);
        }
        expect(res.out).not.toContain('owner@example.org');
        expect(res.out).not.toContain('sb_publishable_');
      });

      it('refuses a line that is not NAME=value, a missing file and a relative path', () => {
        writeFileSync(`${dir}/.env`, BEFORE);
        putSettings('AUTH_ISSUER https://idp.example.com/auth/v1\n');
        const line = run(['deploy', '--release', 'v1.0.0', '--image', image('a'), '--extract-image', extract('a'), '--media-image', media('a'), '--compose', compose, '--auth-settings', settingsPath()]);
        expect(line.status, line.out).toBe(2);
        expect(line.out).toContain('is not NAME=value');
        const missing = run(['deploy', '--release', 'v1.0.0', '--image', image('a'), '--extract-image', extract('a'), '--media-image', media('a'), '--compose', compose, '--auth-settings', `${root}/nope.env`]);
        expect(missing.status, missing.out).toBe(2);
        expect(missing.out).toContain('not readable');
        const relative = run(['deploy', '--release', 'v1.0.0', '--image', image('a'), '--extract-image', extract('a'), '--media-image', media('a'), '--compose', compose, '--auth-settings', 'auth-settings.env']);
        expect(relative.status, relative.out).toBe(2);
        expect(relative.out).toContain('--auth-settings must be an absolute path');
        expect(envFile()).toBe(BEFORE);
        expect(calls()).toEqual([]);
      });

      it('check-auth-settings accepts the settings and names them, without a value', () => {
        writeSettings(IDP);
        const ok = run(['check-auth-settings', settingsPath()]);
        expect(ok.status, ok.out).toBe(0);
        expect(ok.out).toContain('they set: AUTH_ISSUER AUTH_JWKS_URL PUBLIC_AUTH_URL PUBLIC_AUTH_ANON_KEY AUTH_ALLOWED_EMAILS AUTH_SESSION_CHECK AUTH_UPSTREAM_URL');
        expect(ok.out).not.toContain('example');
        writeSettings({ ...IDP, AUTH_ISSUER: 'http://idp.example.com' });
        const refused = run(['check-auth-settings', settingsPath()]);
        expect(refused.status).toBe(2);
        expect(refused.out).toContain('AUTH_ISSUER must be an https address');
      });
    });

    describe('puts the dated copy back', () => {
      it('when the release does not become ready: the env file is as it was, and the release before runs again', () => {
        writeFileSync(`${dir}/.env`, BEFORE);
        expect(deploy('v1.0.0', 'a', { STUB_SERVICES: SPLIT_SERVICES }).status).toBe(0);
        expect(envFile()).toBe(BEFORE);
        const res = deployIdp('v1.1.0', 'b', IDP, { STUB_SERVICES: SPLIT_SERVICES, STUB_BAD_DIGEST: digest('b') });
        expect(res.status, res.out).toBe(1);
        expect(res.out).toContain('identity provider settings written to');
        expect(res.out).toContain('(the file as it was before the identity provider settings)');
        expect(res.out).toContain(`rolled back to ${releaseDir('v1.0.0', 'a')}, which serves again`);
        expect(envFile()).toBe(BEFORE);
        expect(state('current')).toBe(releaseDir('v1.0.0', 'a'));
        expect(existsSync(`${dir}/.deploy/env-backup`)).toBe(false);
        // The restore comes before the old release's services are recreated.
        expect(res.out.indexOf('restored')).toBeLessThan(res.out.indexOf(`rolling back to ${releaseDir('v1.0.0', 'a')}`));
      });

      it('when the smoke test fails', () => {
        writeFileSync(`${dir}/.env`, BEFORE);
        expect(deploy('v1.0.0', 'a').status).toBe(0);
        const res = deployIdp('v1.1.0', 'b', IDP, { STUB_NO_BUNDLE_DIGEST: digest('b') });
        expect(res.status, res.out).toBe(1);
        expect(res.out).toContain('smoke failed: /login loads the app shell and its script bundle');
        expect(envFile()).toBe(BEFORE);
      });

      it('on a first deploy that fails, where there is no release to go back to', () => {
        writeFileSync(`${dir}/.env`, BEFORE);
        const res = deployIdp('v1.0.0', 'a', IDP, { STUB_BAD_DIGEST: digest('a') });
        expect(res.status, res.out).toBe(1);
        expect(res.out).toContain('there is no earlier release to roll back to');
        expect(envFile()).toBe(BEFORE);
      });

      it('on a manual rollback from the release that wrote it, and not again on the next one', () => {
        writeFileSync(`${dir}/.env`, BEFORE);
        expect(deploy('v1.0.0', 'a').status).toBe(0);
        expect(deployIdp('v1.1.0', 'b').status).toBe(0);
        expect(envFile()).not.toBe(BEFORE);
        const back = run(['rollback']);
        expect(back.status, back.out).toBe(0);
        expect(back.out).toContain('(the file as it was before the identity provider settings)');
        expect(envFile()).toBe(BEFORE);
        expect(existsSync(`${dir}/.deploy/env-backup`)).toBe(false);
        // Someone edits the file; the rollback that returns to release b does not bring the old copy over that edit.
        writeFileSync(`${dir}/.env`, `${BEFORE}EDITED=1\n`);
        const forward = run(['rollback']);
        expect(forward.status, forward.out).toBe(0);
        expect(envFile()).toBe(`${BEFORE}EDITED=1\n`);
      });

      it('and a deploy without settings after one with them clears the record, so a rollback leaves the file alone', () => {
        writeFileSync(`${dir}/.env`, BEFORE);
        expect(deployIdp('v1.0.0', 'a').status).toBe(0);
        const written = envFile();
        expect(deploy('v1.1.0', 'b').status).toBe(0);
        expect(existsSync(`${dir}/.deploy/env-backup`)).toBe(false);
        expect(run(['rollback']).status).toBe(0);
        expect(envFile()).toBe(written);
      });

      it('stops before anything changes when the env file or its directory is not writable', () => {
        if (process.platform === 'win32' || process.getuid?.() === 0) return; // a read-only file is still writable to root
        writeFileSync(`${dir}/.env`, BEFORE);
        chmodSync(`${dir}/.env`, 0o444);
        try {
          const res = deployIdp('v1.0.0', 'a');
          expect(res.status, res.out).toBe(2);
          expect(res.out).toContain('writable by the deploy user');
          expect(res.out).toContain('nothing was changed');
          expect(calls()).toEqual([]);
          expect(copies()).toEqual([]);
        } finally {
          chmodSync(`${dir}/.env`, 0o600);
        }
        expect(envFile()).toBe(BEFORE);
      });

      it('when the compose files do not load with the new settings', () => {
        writeFileSync(`${dir}/.env`, BEFORE);
        expect(deploy('v1.0.0', 'a').status).toBe(0);
        const res = deployIdp('v1.1.0', 'b', IDP, { STUB_CONFIG_FAIL_IF_ENV_HAS: 'AUTH_SESSION_CHECK=jwt' });
        expect(res.status, res.out).toBe(1);
        expect(res.out).toContain('do not load with the identity provider settings; the env file was put back');
        expect(envFile()).toBe(BEFORE);
        expect(state('current')).toBe(releaseDir('v1.0.0', 'a'));
        expect(running()).toContain(image('a'));
      });

      it('but never over edits made since: a rotated password stays, and the message says so', () => {
        writeFileSync(`${dir}/.env`, BEFORE);
        expect(deploy('v1.0.0', 'a').status).toBe(0);
        expect(deployIdp('v1.1.0', 'b').status).toBe(0);
        const edited = `${envFile()}SMTP_PASSWORD=new\n`.replace('POSTGRES_PASSWORD=x', 'POSTGRES_PASSWORD=rotated');
        writeFileSync(`${dir}/.env`, edited);
        const back = run(['rollback']);
        expect(back.status, back.out).toBe(0);
        expect(back.out).toContain('was edited after release');
        expect(back.out).toContain('is left as it is');
        expect(envFile()).toBe(edited);
        expect(existsSync(`${dir}/.deploy/env-backup`)).toBe(false);
      });

      it('and goes back to the settings when the rollback itself fails', () => {
        writeFileSync(`${dir}/.env`, BEFORE);
        expect(deploy('v1.0.0', 'a').status).toBe(0);
        expect(deployIdp('v1.1.0', 'b').status).toBe(0);
        const written = envFile();
        const res = run(['rollback'], { STUB_BAD_DIGEST: digest('a') });
        expect(res.status, res.out).toBe(1);
        expect(res.out).toContain(`rolled back to ${releaseDir('v1.1.0', 'b')}, which serves again`);
        // Release b serves again with the settings it was deployed with, and a later rollback still knows how to take them out.
        expect(envFile()).toBe(written);
        expect(res.out).toContain('put the identity provider settings back');
        expect(state('env-backup')).toContain(releaseDir('v1.1.0', 'b'));
        expect(copies()).toHaveLength(1);
        const again = run(['rollback']);
        expect(again.status, again.out).toBe(0);
        expect(envFile()).toBe(BEFORE);
        // No copy of the file as it was is left once a rollback worked.
        expect(copies()).toHaveLength(1);
      });

      it('to the copy from before the first deploy of a release that is deployed again with other settings', () => {
        writeFileSync(`${dir}/.env`, BEFORE);
        expect(deploy('v1.0.0', 'a').status).toBe(0);
        expect(deployIdp('v1.1.0', 'b').status).toBe(0);
        const other = deployIdp('v1.1.0', 'b', { ...IDP, AUTH_ALLOWED_EMAILS: '@example.net' });
        expect(other.status, other.out).toBe(0);
        expect(envFile()).toContain('AUTH_ALLOWED_EMAILS=@example.net');
        expect(run(['rollback']).status).toBe(0);
        expect(envFile()).toBe(BEFORE);
      });

      it('without overwriting edits made between two deploys of the same release, and a rollback leaves such a file alone', () => {
        writeFileSync(`${dir}/.env`, BEFORE);
        expect(deploy('v1.0.0', 'a').status).toBe(0);
        expect(deployIdp('v1.1.0', 'b').status).toBe(0);
        // The database password is rotated by hand, then the same release goes out again with other settings.
        writeFileSync(`${dir}/.env`, envFile().replace('POSTGRES_PASSWORD=x', 'POSTGRES_PASSWORD=rotated'));
        const again = deployIdp('v1.1.0', 'b', { ...IDP, AUTH_ALLOWED_EMAILS: '@example.net' });
        expect(again.status, again.out).toBe(0);
        expect(again.out).toContain('was edited after release');
        expect(again.out).toContain('a rollback will leave it as it is');
        expect(existsSync(`${dir}/.deploy/env-backup`)).toBe(false);
        const after = envFile();
        expect(run(['rollback']).status).toBe(0);
        // Neither the old password comes back nor is a half of the settings taken out.
        expect(envFile()).toBe(after);
        expect(envFile()).toContain('POSTGRES_PASSWORD=rotated');
      });

      it('after the same release is deployed again with the same settings', () => {
        writeFileSync(`${dir}/.env`, BEFORE);
        expect(deploy('v1.0.0', 'a').status).toBe(0);
        expect(deployIdp('v1.1.0', 'b').status).toBe(0);
        const again = deployIdp('v1.1.0', 'b');
        expect(again.status, again.out).toBe(0);
        expect(again.out).toContain('already in');
        expect(state('env-backup')).toContain(releaseDir('v1.1.0', 'b'));
        expect(run(['rollback']).status).toBe(0);
        expect(envFile()).toBe(BEFORE);
      });
    });

    it('stops before anything changes when the provider does not answer as the settings say', () => {
      writeFileSync(`${dir}/.env`, BEFORE);
      const keys = deployIdp('v1.0.0', 'a', IDP, { STUB_JWKS_FAIL: '1' });
      expect(keys.status, keys.out).toBe(1);
      expect(keys.out).toContain('AUTH_JWKS_URL does not answer 200 with a JSON Web Key Set');
      expect(keys.out).not.toContain('answers with');
      for (const env of [{ STUB_JWKS_EMPTY: '1' }, { STUB_JWKS_OCT: '1' }]) {
        const poor = deployIdp('v1.0.0', 'a', IDP, env);
        expect(poor.status, poor.out).toBe(1);
        expect(poor.out).toContain('JSON Web Key Set that holds an EC or RSA key');
      }
      const page = deployIdp('v1.0.0', 'a', IDP, { STUB_IDP_HEALTH_HTML: '1' });
      expect(page.status, page.out).toBe(1);
      expect(page.out).toContain('does not answer 200 with the Auth service');
      const health = deployIdp('v1.0.0', 'a', IDP, { STUB_IDP_HEALTH_FAIL: '1' });
      expect(health.status, health.out).toBe(1);
      expect(health.out).toContain('PUBLIC_AUTH_URL/health does not answer');
      for (const res of [keys, health]) expect(res.out).toContain('nothing was changed');
      expect(calls()).toEqual([]);
      expect(envFile()).toBe(BEFORE);
      expect(copies()).toEqual([]);
      // The publishable key went in a header file, not on a command line.
      expect(readFileSync(`${log}.argv`, 'utf8')).not.toContain('sb_publishable_');
      expect(readFileSync(`${log}.argv`, 'utf8')).toContain('--header @');
    });

    it('accepts what the kernel accepts: spaces between addresses, a local part ending in a dash, an explicit :443, 40 characters of words', () => {
      writeFileSync(`${dir}/.env`, BEFORE);
      const values = {
        ...IDP,
        AUTH_ALLOWED_EMAILS: 'a-@example.com  b%c@example.org, @example.net',
        AUTH_JWKS_URL: 'https://idp.example.com:443/auth/v1/.well-known/jwks.json',
        AUTH_HOSTED_LOGIN_URL: 'https://login.example.com/authorize',
        AUTH_HOSTED_LOGIN_TOKEN_URL: 'https://login.example.com/token',
        AUTH_HOSTED_LOGIN_NAME: 'x'.repeat(40),
      };
      const res = deployIdp('v1.0.0', 'a', values);
      expect(res.status, res.out).toBe(0);
      expect(envFile()).toContain('AUTH_ALLOWED_EMAILS=a-@example.com,b%c@example.org,@example.net\n');
    });

    it('puts no setting on the command line of any process it runs', () => {
      const shims = ['cat', 'cmp', 'mktemp', 'rm', 'sed', 'grep', 'tr', 'head', 'tail', 'mv', 'cp', 'mkdir', 'date', 'wc', 'cut', 'sha256sum', 'cksum'];
      for (const name of shims) {
        const real = spawnSync('bash', ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim();
        if (real === '') continue;
        writeFileSync(`${root}/bin/${name}`, `#!/bin/sh\nprintf '%s %s\\n' "${name}" "$*" >>"$STUB_LOG.shim-argv"\nexec ${real} "$@"\n`);
        chmodSync(`${root}/bin/${name}`, 0o755);
      }
      writeFileSync(`${dir}/.env`, BEFORE);
      const res = deployIdp('v1.0.0', 'a');
      expect(res.status, res.out).toBe(0);
      const argv = readFileSync(`${log}.shim-argv`, 'utf8');
      // The shims did see the run: an empty log would prove nothing.
      expect(argv).toContain('mktemp ');
      expect(argv).toContain('cmp ');
      for (const secret of ['owner@example.org', '@example.com', 'sb_publishable_TESTKEY']) expect(argv.includes(secret), `${secret} is on a command line`).toBe(false);
    });

    it('stops, and puts the file back, when /api/config does not report the Auth URL it was given', () => {
      writeFileSync(`${dir}/.env`, BEFORE);
      expect(deploy('v1.0.0', 'a').status).toBe(0);
      const res = deployIdp('v1.1.0', 'b', IDP, { STUB_AUTH_URL: 'https://other.example.com/auth/v1' });
      expect(res.status, res.out).toBe(1);
      expect(res.out).toContain('smoke failed: /api/config names the configured Auth URL');
      expect(res.out).not.toContain('other.example.com');
      expect(envFile()).toBe(BEFORE);
    });

    it('probes the provider over https only, without following a redirect', () => {
      writeFileSync(`${dir}/.env`, BEFORE);
      const res = deployIdp('v1.0.0', 'a', IDP, { STUB_IDP_REDIRECT: '1' });
      expect(res.status, res.out).toBe(1);
      expect(res.out).toContain('PUBLIC_AUTH_URL/health does not answer 200');
      expect(res.out).toContain('nothing was changed');
      expect(envFile()).toBe(BEFORE);
      const argv = readFileSync(`${log}.argv`, 'utf8');
      expect(argv).toContain('--proto =https --proto-redir =https');
      expect(argv).not.toContain('--location');
      // Every request to the provider (by its parsed host, not a substring) carried the protocol limits and ignored ~/.curlrc.
      const toProvider = argv.split('\n').filter((l) => l.split(' ').some((a) => a.startsWith('https://') && new URL(a).hostname === 'idp.example.com'));
      expect(toProvider.length).toBeGreaterThan(0);
      expect(toProvider.every((l) => l.startsWith('-q ') && l.includes('--proto =https'))).toBe(true);
    });

    it('does not demand the Auth URL of a caller\'s shell from a rollback', () => {
      writeFileSync(`${dir}/.env`, BEFORE);
      expect(deploy('v1.0.0', 'a').status).toBe(0);
      expect(deploy('v1.1.0', 'b').status).toBe(0);
      const res = run(['rollback'], { SMOKE_EXPECT_AUTH_URL: 'https://idp.example.com/auth/v1' });
      expect(res.status, res.out).toBe(0);
      expect(res.out).not.toContain('names the configured Auth URL');
    });

    it('does not print the worker log when the env file lists who may sign in (it may be a public CI log), and does otherwise', () => {
      const down = { STUB_SERVICES: SPLIT_SERVICES, STUB_WORKER_DOWN_DIGEST: digest('a'), STUB_WORKER_LOG: 'worker: refused owner@gmail.com- in AUTH_ALLOWED_EMAILS' };
      writeFileSync(`${dir}/.env`, 'POSTGRES_PASSWORD=x\nLUDY_CONTEXT_TOKEN_KEY=k\nAUTH_ALLOWED_EMAILS=@example.com,owner@gmail.com-\n');
      const hidden = deploy('v1.0.0', 'a', down);
      expect(hidden.status, hidden.out).toBe(1);
      expect(hidden.out).toContain('the worker is not running');
      expect(hidden.out).toContain('the worker log is not shown here');
      expect(hidden.out).not.toContain('owner@gmail.com-');
      // An empty value, a commented-out line and another setting that starts with the name are not a list.
      for (const line of ['AUTH_ALLOWED_EMAILS=\n', '# AUTH_ALLOWED_EMAILS=@example.com\n', 'AUTH_ALLOWED_EMAILS_X=@example.com\n']) {
        writeFileSync(`${dir}/.env`, `POSTGRES_PASSWORD=x\nLUDY_CONTEXT_TOKEN_KEY=k\n${line}`);
        const shown = deploy('v1.0.0', 'a', down);
        expect(shown.out, line).toContain('worker: refused owner@gmail.com-');
      }
    });

    it('keeps the newest dated copies and the one a rollback needs, and removes the rest', () => {
      writeFileSync(`${dir}/.env`, BEFORE);
      expect(deploy('v1.0.0', 'a').status).toBe(0);
      expect(deployIdp('v1.1.0', 'b').status).toBe(0);
      const needed = readFileSync(`${dir}/.deploy/env-backup`, 'utf8').split(' ')[1] ?? '';
      expect(existsSync(needed)).toBe(true);
      // Older copies from earlier runs, and the same release deployed again with other settings: the copy before its first deploy stays the one needed.
      for (let n = 0; n < 7; n++) writeFileSync(`${dir}/.env.bak-2026010${n + 1}T000000Z-abcdef`, 'old\n', { mode: 0o600 });
      for (let n = 0; n < 3; n++) expect(deployIdp('v1.1.0', 'b', { ...IDP, AUTH_ALLOWED_EMAILS: `@example${n}.net` }).status).toBe(0);
      expect(readFileSync(`${dir}/.deploy/env-backup`, 'utf8').split(' ')[1]).toBe(needed);
      expect(existsSync(needed)).toBe(true);
      expect(copies().length).toBeLessThanOrEqual(6);
      // The seven made-up ones are the oldest, so the newest of them are the only ones to survive beside the real copies.
      expect(existsSync(`${dir}/.env.bak-20260101T000000Z-abcdef`)).toBe(false);
      // And the rollback still restores the file as it was before the first deploy of release b.
      expect(run(['rollback']).status).toBe(0);
      expect(envFile()).toBe(BEFORE);
    });

    it('never touches the env file when the migration fails', () => {
      writeFileSync(`${dir}/.env`, BEFORE);
      const res = deployIdp('v1.0.0', 'a', IDP, { STUB_MIGRATE_EXIT: '1' });
      expect(res.status, res.out).toBe(1);
      expect(res.out).toContain('migrations failed');
      expect(envFile()).toBe(BEFORE);
      expect(copies()).toEqual([]);
    });

    it('only removes the file the workflow uploaded, and refuses the env file and the compose file as settings', () => {
      writeFileSync(`${dir}/.env`, BEFORE);
      const args = (file: string) => ['deploy', '--release', 'v1.0.0', '--image', image('a'), '--extract-image', extract('a'), '--media-image', media('a'), '--compose', compose, '--auth-settings', file];
      const asEnv = run(args(`${dir}/.env`));
      expect(asEnv.status, asEnv.out).toBe(2);
      expect(asEnv.out).toContain('not the env file or the compose file');
      expect(envFile()).toBe(BEFORE);
      const asCompose = run(args(compose));
      expect(asCompose.status, asCompose.out).toBe(2);
      expect(existsSync(compose)).toBe(true);
      // A refused file elsewhere is read and left alone.
      writeFileSync(`${root}/elsewhere.env`, 'POSTGRES_PASSWORD=x\n');
      const elsewhere = run(args(`${root}/elsewhere.env`));
      expect(elsewhere.status, elsewhere.out).toBe(2);
      expect(existsSync(`${root}/elsewhere.env`)).toBe(true);
      expect(calls()).toEqual([]);
    });

    it('removes only a regular settings file of the incoming directory: not through .., not a link', () => {
      writeFileSync(`${dir}/.env`, BEFORE);
      writeFileSync(`${dir}/docker-compose.yml`, 'name: ludy\nservices: {}\n');
      mkdirSync(`${dir}/.deploy/incoming/run`, { recursive: true });
      const args = (file: string) => ['deploy', '--release', 'v1.0.0', '--image', image('a'), '--extract-image', extract('a'), '--media-image', media('a'), '--compose', compose, '--auth-settings', file];
      // The compose file reached with ..: read (and refused: not settings), never deleted.
      const through = run(args(`${dir}/.deploy/incoming/../../docker-compose.yml`));
      expect(through.status, through.out).toBe(2);
      expect(existsSync(`${dir}/docker-compose.yml`)).toBe(true);
      // A link named like the upload: the file it points to stays.
      writeFileSync(`${root}/target.env`, 'POSTGRES_PASSWORD=x\n');
      if (process.platform !== 'win32') {
        symlinkSync(`${root}/target.env`, settingsPath());
        const linked = run(args(settingsPath()));
        expect(linked.status, linked.out).toBe(2);
        expect(existsSync(`${root}/target.env`)).toBe(true);
      }
    });

    it('counts the characters of the button words, not the bytes, whatever the locale of the SSH session', () => {
      writeFileSync(`${dir}/.env`, BEFORE);
      const words = 'Đăng nhập bằng tài khoản công ty'; // 32 characters, 42 bytes
      const values = { ...IDP, AUTH_HOSTED_LOGIN_URL: 'https://login.example.com/authorize', AUTH_HOSTED_LOGIN_TOKEN_URL: 'https://login.example.com/token', AUTH_HOSTED_LOGIN_NAME: words };
      writeSettings(values);
      for (const locale of ['C', 'C.UTF-8']) {
        const res = run(['check-auth-settings', settingsPath()], { LC_ALL: locale });
        expect(res.status, `${locale}: ${res.out}`).toBe(0);
      }
      writeSettings({ ...values, AUTH_HOSTED_LOGIN_NAME: 'Đ'.repeat(41) });
      expect(run(['check-auth-settings', settingsPath()], { LC_ALL: 'C' }).status).toBe(2);
    });

    it('writes the rollback record with mode 600', () => {
      if (process.platform === 'win32') return;
      writeFileSync(`${dir}/.env`, BEFORE);
      expect(deployIdp('v1.0.0', 'a').status).toBe(0);
      expect(statSync(`${dir}/.deploy/env-backup`).mode & 0o777).toBe(0o600);
    });

    it('stops before anything changes when the directory of the env file is not writable', () => {
      if (process.platform === 'win32' || process.getuid?.() === 0) return;
      mkdirSync(`${root}/ro`);
      writeFileSync(`${root}/ro/.env`, BEFORE);
      chmodSync(`${root}/ro`, 0o555);
      try {
        writeSettings(IDP);
        const res = run(['deploy', '--release', 'v1.0.0', '--image', image('a'), '--extract-image', extract('a'), '--media-image', media('a'), '--compose', compose, '--auth-settings', settingsPath(), '--env-file', `${root}/ro/.env`]);
        expect(res.status, res.out).toBe(2);
        expect(res.out).toContain('writable by the deploy user');
        expect(calls()).toEqual([]);
      } finally {
        chmodSync(`${root}/ro`, 0o755);
      }
    });

    it('prints no value, passes none on a command line, and leaves a copy of the settings only in the env file and its dated copy', () => {
      writeFileSync(`${dir}/.env`, BEFORE);
      const res = deployIdp('v1.0.0', 'a', { ...IDP, AUTH_OAUTH_PROVIDERS: 'google', AUTH_HOSTED_LOGIN_URL: 'https://login.example.com/authorize', AUTH_HOSTED_LOGIN_TOKEN_URL: 'https://login.example.com/token', AUTH_HOSTED_LOGIN_NAME: 'Login with Example' });
      expect(res.status, res.out).toBe(0);
      const places: Record<string, string> = {
        'the deploy log': res.out,
        'the stub docker calls': readFileSync(log, 'utf8'),
        'the stub curl calls': readFileSync(`${log}.argv`, 'utf8'),
        'the compose files of each call': readFileSync(`${log}.files`, 'utf8'),
      };
      for (const f of everyFile(dir)) if (f !== `${dir}/.env` && !copies().some((c) => f === `${dir}/${c}`) && !f.endsWith('/.deploy/env-backup')) places[f] = readFileSync(f, 'utf8');
      for (const [place, text] of Object.entries(places)) {
        for (const secret of ['owner@example.org', '@example.com', 'sb_publishable_TESTKEY', 'Login with Example']) {
          expect(text.includes(secret), `${secret} is in ${place}`).toBe(false);
        }
      }
      // The list of names the log gives holds only names.
      expect(res.out).toContain('identity provider settings given: AUTH_ISSUER');
    });

    it('skips the proxy checks of the smoke test when the env file has no bundled proxy, however the line is written, and not otherwise', () => {
      const smoked = (line: string, extra: Record<string, string> = {}) => {
        writeFileSync(`${dir}/.env`, `POSTGRES_PASSWORD=x\nLUDY_CONTEXT_TOKEN_KEY=k\n${line}`);
        rmSync(log, { force: true });
        return deploy('v1.0.0', 'a', extra);
      };
      for (const line of ['AUTH_UPSTREAM_URL=\n', 'export AUTH_UPSTREAM_URL =\n', 'AUTH_UPSTREAM_URL=""\n', "AUTH_UPSTREAM_URL='' # none\n", 'AUTH_UPSTREAM_URL=http://auth:9999\nAUTH_UPSTREAM_URL=\n']) {
        const res = smoked(line);
        expect(res.status, `${line}: ${res.out}`).toBe(0);
        expect(res.out, line).toContain('smoke skipped: /auth/v1/health');
      }
      for (const line of ['', 'AUTH_UPSTREAM_URL=http://auth:9999\n', 'AUTH_UPSTREAM_URL=\nAUTH_UPSTREAM_URL=http://auth:9999\n', '# AUTH_UPSTREAM_URL=\n', 'AUTH_UPSTREAM_URL_X=\n']) {
        const res = smoked(line);
        expect(res.status, `${line}: ${res.out}`).toBe(0);
        expect(res.out, line).toContain('smoke ok: /auth/v1/health answers');
      }
      // The workflow's public smoke test has no env file: it reads the deployed /api/config. An authUrl that is not the API's own /auth/v1
      // means a remote provider, and the account step is skipped.
      const account = { SMOKE_EMAIL: 'smoke@example.test', SMOKE_PASSWORD: 'smoke-password-1', SMOKE_ORG: 'ludy-smoke' };
      const pub = run(['smoke', 'https://ludy.example.test'], { ...account, STUB_AUTH_URL: 'https://idp.example.com/auth/v1', STUB_NO_PROXY: '1' });
      // The kernel with no proxy still answers 200 to a GET with its page: not the proxy.
      const pubPage = run(['smoke', 'https://ludy.example.test'], { ...account, STUB_AUTH_URL: 'https://idp.example.com/auth/v1', STUB_NO_PROXY: 'html' });
      expect(pubPage.status, pubPage.out).toBe(0);
      expect(pubPage.out).toContain('smoke skipped: /auth/v1/health');
      // (Another host, but a proxy that answers here, is still the bundled Auth: that is checked below.)
      expect(pub.status, pub.out).toBe(0);
      expect(pub.out).toContain('smoke skipped: /auth/v1/health');
      expect(pub.out).toContain('smoke skipped: sign-in and upload');
      expect(readFileSync(`${log}.argv`, 'utf8')).not.toContain('/auth/v1/token');
      // The bundled proxy, announced at the address asked, is still checked, account step included.
      const bundled = run(['smoke', 'https://ludy.example.test'], account);
      expect(bundled.status, bundled.out).toBe(0);
      expect(bundled.out).toContain('smoke ok: /auth/v1/health answers');
      expect(bundled.out).toContain('signs in, uploads a synthetic e-invoice');
      // An address that only differs in case, scheme or a default port is the same bundled Auth: still checked, and a broken sign-in still fails.
      for (const authUrl of ['https://LUDY.example.test/auth/v1', 'https://ludy.example.test:443/auth/v1', 'http://ludy.example.test/auth/v1']) {
        const same = run(['smoke', 'https://ludy.example.test'], { ...account, STUB_AUTH_URL: authUrl, STUB_SIGNIN_FAIL: '1' });
        expect(same.status, `${authUrl}: ${same.out}`).toBe(1);
        expect(same.out).not.toContain('Supabase Auth is a remote provider');
        expect(same.out).toContain('smoke ok: /auth/v1/health answers');
      }
      // With the Auth URL the settings name, /api/config must report exactly that: the right one passes, anything else fails.
      const otherHostWithProxy = run(['smoke', 'https://ludy.example.test'], { ...account, STUB_AUTH_URL: 'https://idp.example.com/auth/v1', STUB_SIGNIN_FAIL: '1' });
      expect(otherHostWithProxy.status, otherHostWithProxy.out).toBe(1);
      expect(otherHostWithProxy.out).toContain('smoke ok: /auth/v1/health answers');
      const right = run(['smoke', 'https://ludy.example.test'], { STUB_AUTH_URL: 'https://idp.example.com/auth/v1', SMOKE_EXPECT_AUTH_URL: 'https://idp.example.com/auth/v1' });
      expect(right.status, right.out).toBe(0);
      expect(right.out).toContain('smoke ok: /api/config names the configured Auth URL');
      const stale = run(['smoke', 'https://ludy.example.test'], { SMOKE_EXPECT_AUTH_URL: 'https://idp.example.com/auth/v1' });
      expect(stale.status).toBe(1);
      expect(stale.out).toContain('smoke failed: /api/config names the configured Auth URL');
      expect(stale.out).not.toContain('idp.example.com');
    });
  });

  // #3531: opt-in module settings (--modules) and /api/config module verification.
  describe('module settings (#3531)', () => {
    const IDP: Record<string, string> = {
      AUTH_ISSUER: 'https://idp.example.com/auth/v1',
      AUTH_JWKS_URL: 'https://idp.example.com/auth/v1/.well-known/jwks.json',
      PUBLIC_AUTH_URL: 'https://idp.example.com/auth/v1',
      PUBLIC_AUTH_ANON_KEY: 'sb_publishable_TESTKEYabcdef0123456789',
      AUTH_ALLOWED_EMAILS: '@example.com,owner@example.org',
    };
    const MOD_BEFORE = [
      'POSTGRES_PASSWORD=x',
      'LUDY_CONTEXT_TOKEN_KEY=already-here',
      '# LUDY_MODULES=commented-old',
      'LUDY_MODULES_EXTRA=keep',
      'LUDY_MODULES=finance,crm,social',
      'OTHER=1',
      '',
    ].join('\n');
    const COMBINED_BEFORE = [
      'POSTGRES_PASSWORD=x',
      'LUDY_CONTEXT_TOKEN_KEY=already-here',
      'AUTH_JWT_SECRET=keep-this-secret',
      'AUTH_ISSUER=ludy-auth',
      'AUTH_SESSION_CHECK=db',
      'AUTH_UPSTREAM_URL=http://auth:9999',
      'AUTH_SIGNUP_POLICY=invite_only',
      'LUDY_MODULES=finance,crm,social',
      'PUBLIC_URL=https://api.example.com',
      '',
    ].join('\n');
    const envFile = () => readFileSync(`${dir}/.env`, 'utf8');
    const lines = (text: string) => text.split('\n').filter(Boolean);
    const copies = () => readdirSync(dir).filter((f) => f.startsWith('.env.bak-'));
    const settingsPath = () => `${dir}/.deploy/incoming/run/auth-settings.env`;
    const writeSettings = (values: Record<string, string>) => {
      mkdirSync(`${dir}/.deploy/incoming/run`, { recursive: true });
      writeFileSync(settingsPath(), Object.entries(values).map(([k, v]) => `${k}=${v}\n`).join(''));
    };
    const deployModules = (release: string, c: string, modules: string, env: Record<string, string> = {}) =>
      run(['deploy', '--release', release, '--image', image(c), '--extract-image', extract(c), '--media-image', media(c), '--compose', compose, '--modules', modules], env);
    const deployBoth = (release: string, c: string, values: Record<string, string>, modules: string, env: Record<string, string> = {}) => {
      writeSettings(values);
      return run(['deploy', '--release', release, '--image', image(c), '--extract-image', extract(c), '--media-image', media(c), '--compose', compose, '--auth-settings', settingsPath(), '--modules', modules], env);
    };

    it('check-modules accepts valid comma-separated module lists and rejects invalid, duplicate, whitespace, or shell inputs', () => {
      expect(run(['check-modules', AVAILABLE_MODULES.join(',')]).status).toBe(0);
      for (const valid of ['finance', 'kernel', 'finance,crm,social,sign', 'kernel,finance,social,ads,crm,notes,hr,meetings,projects,sign']) {
        const res = run(['check-modules', valid]);
        expect(res.status, `${valid}: ${res.out}`).toBe(0);
        expect(res.out).toContain(`LUDY_MODULES=${valid}`);
      }
      expect(run(['check-modules']).status).toBe(2);
      expect(run(['check-modules', 'finance', 'crm']).status).toBe(2);
      for (const bad of [
        '',
        ' ',
        'billing',
        'finance,unknown',
        'finance,finance',
        'finance,crm,finance',
        ',finance',
        'finance,',
        'finance,,crm',
        'finance, crm',
        ' finance',
        'Finance',
        '"finance"',
        "'finance'",
        'finance\ncrm',
        'finance\n',
        'finance\r',
        'finance;id',
        'finance$(id)',
        'finance`id`',
        'finance&crm',
        'finance|crm',
        'kernel,finance,social,ads,crm,notes,hr,meetings,projects,sign,extra',
      ]) {
        const res = run(['check-modules', bad]);
        expect(res.status, `${JSON.stringify(bad)}: ${res.out}`).toBe(2);
      }
    });

    it('deploy --modules refuses an invalid list before touching docker or .env', () => {
      writeFileSync(`${dir}/.env`, MOD_BEFORE);
      const res = deployModules('v1.0.0', 'a', 'finance,unknown');
      expect(res.status, res.out).toBe(2);
      expect(res.out).toContain('nothing was changed');
      expect(calls()).toEqual([]);
      expect(envFile()).toBe(MOD_BEFORE);
      expect(copies()).toEqual([]);
    });

    it('writes LUDY_MODULES, preserves lines/comments/CRLF/inode/mode, backs up once, verifies /api/config, and is idempotent', () => {
      writeFileSync(`${dir}/.env`, MOD_BEFORE);
      chmodSync(`${dir}/.env`, 0o600);
      const beforeStat = statSync(`${dir}/.env`);
      const res = deployModules('v1.0.0', 'a', 'finance,crm,social,sign');
      expect(res.status, res.out).toBe(0);
      expect(lines(envFile())).toEqual([
        'POSTGRES_PASSWORD=x',
        'LUDY_CONTEXT_TOKEN_KEY=already-here',
        '# LUDY_MODULES=commented-old',
        'LUDY_MODULES_EXTRA=keep',
        'LUDY_MODULES=finance,crm,social,sign',
        'OTHER=1',
      ]);
      const afterStat = statSync(`${dir}/.env`);
      expect(afterStat.ino).toBe(beforeStat.ino);
      if (process.platform !== 'win32') {
        expect(afterStat.mode & 0o777).toBe(0o600);
        expect(statSync(`${dir}/${copies()[0]}`).mode & 0o777).toBe(0o600);
      }
      expect(copies()).toHaveLength(1);
      expect(readFileSync(`${dir}/${copies()[0]}`, 'utf8')).toBe(MOD_BEFORE);
      expect(state('env-backup')).toMatch(new RegExp(`^${releaseDir('v1.0.0', 'a')} ${dir}/${copies()[0]} [0-9a-f]{64}$`));
      expect(res.out).toContain('module settings written to');
      expect(res.out).toContain('smoke ok: /api/config lists the expected modules');

      // Re-running with the same module list (even when LUDY_MODULES sits in the middle of .env) makes no backup and writes nothing.
      const done = envFile();
      const second = deployModules('v1.1.0', 'b', 'finance,crm,social,sign');
      expect(second.status, second.out).toBe(0);
      expect(second.out).toContain('already in');
      expect(envFile()).toBe(done);
      expect(copies()).toHaveLength(1);
      expect(existsSync(`${dir}/.deploy/env-backup`)).toBe(false);

      // Deduplicates multiple assignments, appends when missing, and preserves CRLF line endings.
      writeFileSync(`${dir}/.env`, 'POSTGRES_PASSWORD=x\r\nLUDY_CONTEXT_TOKEN_KEY=already-here\r\nLUDY_MODULES=old\r\nOTHER=1\r\nexport LUDY_MODULES = finance\r\n');
      const crlf = deployModules('v1.2.0', 'c', 'finance,sign');
      expect(crlf.status, crlf.out).toBe(0);
      expect(envFile()).toBe('POSTGRES_PASSWORD=x\r\nLUDY_CONTEXT_TOKEN_KEY=already-here\r\nOTHER=1\r\nLUDY_MODULES=finance,sign\r\n');
      expect(deployModules('v1.3.0', 'd', 'finance,sign').out).toContain('already in');

      writeFileSync(`${dir}/.env`, 'POSTGRES_PASSWORD=x\nLUDY_CONTEXT_TOKEN_KEY=already-here\n');
      const appended = deployModules('v1.4.0', 'e', 'finance,sign');
      expect(appended.status, appended.out).toBe(0);
      expect(envFile()).toBe('POSTGRES_PASSWORD=x\nLUDY_CONTEXT_TOKEN_KEY=already-here\nLUDY_MODULES=finance,sign\n');
    });

    it('smoke checks /api/config modules as {kernel} U <modules> regardless of JSON order and rejects mismatches', () => {
      for (const modulesJson of [
        '["kernel","finance","social","crm","sign"]',
        '["crm","finance","kernel","sign","social"]',
        '[ "sign" , "social" , "crm" , "finance" , "kernel" ]',
      ]) {
        const ok = run(['smoke', 'https://ludy.example.test'], { SMOKE_EXPECT_MODULES: 'finance,crm,social,sign', STUB_CONFIG_MODULES: modulesJson });
        expect(ok.status, `${modulesJson}: ${ok.out}`).toBe(0);
        expect(ok.out).toContain('smoke ok: /api/config lists the expected modules');
      }
      expect(run(['smoke', 'https://ludy.example.test'], { SMOKE_EXPECT_MODULES: 'kernel', STUB_CONFIG_MODULES: '["kernel"]' }).status).toBe(0);

      for (const badJson of ['[]', '["kernel","finance","crm","social"]', '["kernel","finance","crm","social","sign","ads"]', '["kernel","finance","finance"]']) {
        const bad = run(['smoke', 'https://ludy.example.test'], { SMOKE_EXPECT_MODULES: 'finance,crm,social,sign', STUB_CONFIG_MODULES: badJson });
        expect(bad.status, `${badJson}: ${bad.out}`).toBe(1);
        expect(bad.out).toContain('smoke failed: /api/config lists the expected modules');
      }
    });

    it('restores .env on compose failure or smoke module mismatch, and handles rollback cleanly', () => {
      writeFileSync(`${dir}/.env`, MOD_BEFORE);
      // Even on a first deploy with no previous release, a smoke module mismatch restores .env.
      const firstFail = deployModules('v1.0.0', 'a', 'finance,crm,social,sign', { STUB_CONFIG_MODULES: 'kernel,finance' });
      expect(firstFail.status, firstFail.out).toBe(1);
      expect(firstFail.out).toContain('there is no earlier release to roll back to');
      expect(envFile()).toBe(MOD_BEFORE);

      expect(deploy('v1.0.0', 'a').status).toBe(0);

      // Bad compose config after rewrite puts .env back immediately.
      const badCompose = deployModules('v1.1.0', 'b', 'finance,crm,social,sign', { STUB_CONFIG_FAIL_IF_ENV_HAS: 'LUDY_MODULES=finance,crm,social,sign' });
      expect(badCompose.status, badCompose.out).toBe(1);
      expect(badCompose.out).toContain('do not load with the module settings; the env file was put back');
      expect(envFile()).toBe(MOD_BEFORE);
      expect(state('current')).toBe(releaseDir('v1.0.0', 'a'));

      // Smoke module mismatch triggers recover: restores .env and clears SMOKE_EXPECT_MODULES for the previous release.
      const badSmoke = deployModules('v1.1.0', 'b', 'finance,crm,social,sign', { STUB_CONFIG_MODULES: 'kernel,finance,crm,social' });
      expect(badSmoke.status, badSmoke.out).toBe(1);
      expect(badSmoke.out).toContain('smoke failed: /api/config lists the expected modules');
      expect(badSmoke.out).toContain(`rolled back to ${releaseDir('v1.0.0', 'a')}, which serves again`);
      expect(envFile()).toBe(MOD_BEFORE);
      expect(state('current')).toBe(releaseDir('v1.0.0', 'a'));

      // Successful deploy followed by rollback (even with caller SMOKE_EXPECT_MODULES set) restores MOD_BEFORE when unmodified.
      expect(deployModules('v1.1.0', 'b', 'finance,crm,social,sign').status).toBe(0);
      const written = envFile();
      expect(written).toContain('LUDY_MODULES=finance,crm,social,sign');

      // Failed rollback puts module settings back so release b keeps running with its settings.
      const failedRollback = run(['rollback'], { STUB_BAD_DIGEST: digest('a') });
      expect(failedRollback.status, failedRollback.out).toBe(1);
      expect(envFile()).toBe(written);
      expect(state('env-backup')).toContain(releaseDir('v1.1.0', 'b'));

      const back = run(['rollback'], { SMOKE_EXPECT_MODULES: 'finance,crm,social,sign' });
      expect(back.status, back.out).toBe(0);
      expect(back.out).not.toContain('lists the expected modules');
      expect(envFile()).toBe(MOD_BEFORE);
      expect(existsSync(`${dir}/.deploy/env-backup`)).toBe(false);

      // Re-deploy and edit .env by hand: rollback leaves manual edits alone and names the backup.
      expect(deployModules('v1.2.0', 'c', 'finance,crm,social,sign').status).toBe(0);
      const edited = envFile().replace('POSTGRES_PASSWORD=x', 'POSTGRES_PASSWORD=rotated');
      writeFileSync(`${dir}/.env`, edited);
      const backEdited = run(['rollback']);
      expect(backEdited.status, backEdited.out).toBe(0);
      expect(backEdited.out).toContain('was edited after release');
      expect(backEdited.out).toContain('is left as it is');
      expect(envFile()).toBe(edited);
      expect(existsSync(`${dir}/.deploy/env-backup`)).toBe(false);

      // Rollback restores MOD_BEFORE cleanly when restore_env_of would reintroduce a conflicting COMPOSE_PROJECT_NAME (#3972 Round 13).
      writeFileSync(`${dir}/.env`, MOD_BEFORE);
      expect(deployModules('v1.3.0', 'd', 'finance,crm,social,sign').status).toBe(0);
      const beforeConflictEnv = envFile();
      const backupFields = state('env-backup').split(' ');
      const backupFilePath = backupFields[1] ?? '';
      expect(backupFilePath.length).toBeGreaterThan(0);
      writeFileSync(backupFilePath, `${MOD_BEFORE}COMPOSE_PROJECT_NAME=crove\n`, { mode: 0o600 });
      const backConflict = run(['rollback']);
      expect(backConflict.status, backConflict.out).toBe(2);
      expect(backConflict.out).toContain('sets COMPOSE_PROJECT_NAME=crove');
      expect(envFile()).toBe(beforeConflictEnv);
      expect(state('env-backup')).toContain(releaseDir('v1.3.0', 'd'));
    });

    it('prunes old env backups when --modules writes .env and stops before pulling if .env is read-only', () => {
      writeFileSync(`${dir}/.env`, MOD_BEFORE);
      for (let n = 0; n < 7; n++) writeFileSync(`${dir}/.env.bak-2026010${n + 1}T000000Z-abcdef`, 'old\n', { mode: 0o600 });
      expect(deployModules('v1.0.0', 'a', 'finance,crm,social,sign').status).toBe(0);
      expect(copies().length).toBeLessThanOrEqual(6);
      expect(existsSync(`${dir}/.env.bak-20260101T000000Z-abcdef`)).toBe(false);

      if (process.platform === 'win32' || process.getuid?.() === 0) return;
      chmodSync(`${dir}/.env`, 0o444);
      try {
        const ro = deployModules('v1.1.0', 'b', 'finance,sign');
        expect(ro.status, ro.out).toBe(2);
        expect(ro.out).toContain('writable by the deploy user');
        expect(ro.out).toContain('nothing was changed');
      } finally {
        chmodSync(`${dir}/.env`, 0o600);
      }
    });

    it('composes --auth-settings and --modules into one pre-deploy backup and restores both on failure or rollback', () => {
      writeFileSync(`${dir}/.env`, COMBINED_BEFORE);
      expect(deploy('v1.0.0', 'a').status).toBe(0);

      // Failure on module smoke mismatch restores the true pre-deploy .env (both old AUTH_* and old LUDY_MODULES).
      const modFail = deployBoth('v1.1.0', 'b', IDP, 'finance,crm,social,sign', { STUB_CONFIG_MODULES: 'kernel,finance,crm,social' });
      expect(modFail.status, modFail.out).toBe(1);
      expect(modFail.out).toContain('smoke failed: /api/config lists the expected modules');
      expect(envFile()).toBe(COMBINED_BEFORE);
      expect(copies()).toHaveLength(1);

      // Failure on Auth URL mismatch restores the true pre-deploy .env too.
      const authFail = deployBoth('v1.1.0', 'b', IDP, 'finance,crm,social,sign', { STUB_AUTH_URL: 'https://other.example.com/auth/v1' });
      expect(authFail.status, authFail.out).toBe(1);
      expect(authFail.out).toContain('smoke failed: /api/config names the configured Auth URL');
      expect(envFile()).toBe(COMBINED_BEFORE);

      // Successful combined deploy creates a single pre-deploy backup and updates both.
      for (const old of copies()) rmSync(`${dir}/${old}`);
      const ok = deployBoth('v1.1.0', 'b', IDP, 'finance,crm,social,sign');
      expect(ok.status, ok.out).toBe(0);
      expect(copies()).toHaveLength(1);
      expect(readFileSync(`${dir}/${copies()[0]}`, 'utf8')).toBe(COMBINED_BEFORE);
      expect(envFile()).toContain('LUDY_MODULES=finance,crm,social,sign');
      expect(envFile()).toContain('AUTH_SESSION_CHECK=jwt');
      expect(ok.out).toContain('smoke ok: /api/config names the configured Auth URL');
      expect(ok.out).toContain('smoke ok: /api/config lists the expected modules');
      expect(state('env-backup')).toMatch(new RegExp(`^${releaseDir('v1.1.0', 'b')} ${dir}/${copies()[0]} [0-9a-f]{64}$`));

      // Re-running with both matching makes no backup and writes nothing.
      const afterBoth = envFile();
      const noop = deployBoth('v1.1.0', 'b', IDP, 'finance,crm,social,sign');
      expect(noop.status, noop.out).toBe(0);
      expect(noop.out).toContain('identity provider settings already in');
      expect(noop.out).toContain('module settings already in');
      expect(copies()).toHaveLength(1);
      expect(envFile()).toBe(afterBoth);

      // Manual rollback restores COMBINED_BEFORE (both AUTH_* and LUDY_MODULES).
      const back = run(['rollback']);
      expect(back.status, back.out).toBe(0);
      expect(envFile()).toBe(COMBINED_BEFORE);

      // One unchanged + one changed on a new release still creates a backup and updates only what changed; rollback restores cleanly.
      const modOnlyChanged = deployBoth('v1.2.0', 'c', IDP, 'finance,crm,social,sign');
      expect(modOnlyChanged.status, modOnlyChanged.out).toBe(0);
      const afterC = envFile();
      // Redeploy same release c with same auth-settings (already matching) and new modules: keeps pre-c backup!
      const secondC = deployBoth('v1.2.0', 'c', IDP, 'finance,sign');
      expect(secondC.status, secondC.out).toBe(0);
      expect(envFile()).toContain('LUDY_MODULES=finance,sign');
      expect(envFile()).not.toBe(afterC);
      expect(run(['rollback']).status).toBe(0);
      expect(envFile()).toBe(COMBINED_BEFORE);

      // Fresh release where LUDY_MODULES already matches while auth-settings changes -> backs up, updates AUTH_*, rollback restores.
      const authOnlyChanged = deployBoth('v1.2.1', 'f', IDP, 'finance,crm,social');
      expect(authOnlyChanged.status, authOnlyChanged.out).toBe(0);
      expect(authOnlyChanged.out).toContain('identity provider settings written to');
      expect(envFile()).toContain('LUDY_MODULES=finance,crm,social');
      expect(envFile()).toContain('AUTH_SESSION_CHECK=jwt');
      expect(run(['rollback']).status).toBe(0);
      expect(envFile()).toBe(COMBINED_BEFORE);

      // Next fresh release where auth-settings already matches while LUDY_MODULES changes -> backs up, updates LUDY_MODULES, rollback restores.
      expect(deployBoth('v1.2.1', 'f', IDP, 'finance,crm,social').status).toBe(0);
      const afterAuthOnly = envFile();
      const freshModOnly = deployBoth('v1.2.2', '1', IDP, 'finance,sign');
      expect(freshModOnly.status, freshModOnly.out).toBe(0);
      expect(freshModOnly.out).toContain('module settings written to');
      expect(envFile()).toContain('LUDY_MODULES=finance,sign');
      expect(run(['rollback']).status).toBe(0);
      expect(envFile()).toBe(afterAuthOnly);
      // Reset .env to COMBINED_BEFORE before testing sequential --auth-settings then --modules on the same release.
      writeFileSync(`${dir}/.env`, COMBINED_BEFORE);

      // Redeploy same release e: first --auth-settings only, then --modules only -> keeps pre-e backup and restores both on rollback.
      expect(deploy('v1.3.0', 'd').status).toBe(0);
      writeSettings(IDP);
      expect(run(['deploy', '--release', 'v1.4.0', '--image', image('e'), '--extract-image', extract('e'), '--media-image', media('e'), '--compose', compose, '--auth-settings', settingsPath()]).status).toBe(0);
      expect(deployModules('v1.4.0', 'e', 'finance,crm,social,sign').status).toBe(0);
      expect(envFile()).toContain('LUDY_MODULES=finance,crm,social,sign');
      expect(envFile()).toContain('AUTH_SESSION_CHECK=jwt');
      expect(run(['rollback']).status).toBe(0);
      expect(envFile()).toBe(COMBINED_BEFORE);
    });
  });
});

describe('deploy shellcheck coverage (#3286)', () => {
  it('lists tools/deploy/deploy.sh and every stub in tools/test/deploy-stubs in ci.yml shellcheck', () => {
    const ci = readFileSync(join(repo, '.github/workflows/ci.yml'), 'utf8').replaceAll('\r\n', '\n');
    const match = /- name: Shell scripts \(shellcheck\)\n\s+run:\s*(.+)/.exec(ci);
    expect(match, 'Shell scripts (shellcheck) step must exist in .github/workflows/ci.yml').not.toBeNull();
    const args = (match?.[1] ?? '').trim().split(/\s+/);
    expect(args[0]).toBe('shellcheck');
    const stubs = readdirSync(join(import.meta.dirname, 'deploy-stubs'), { withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
      .map((entry) => `tools/test/deploy-stubs/${entry.name}`);
    expect(stubs.length).toBeGreaterThan(0);
    for (const file of ['tools/deploy/deploy.sh', ...stubs]) {
      expect(args, `${file} must be checked by shellcheck in ci.yml`).toContain(file);
    }
  });
});
