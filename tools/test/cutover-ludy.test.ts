// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repo = resolve(import.meta.dirname, '../..');
const scriptPath = resolve(repo, 'tools/deploy/cutover-ludy.sh');
const workflowPath = resolve(repo, '.github/workflows/pilot-ludy-cutover.yml');
const hasBash = spawnSync('bash', ['-c', 'exit 0']).status === 0;

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe.skipIf(!hasBash)('cutover-ludy.sh', () => {
  it('parses cleanly and rejects invalid subcommands or unsafe paths before touching docker', () => {
    expect(spawnSync('bash', ['-n', scriptPath]).status).toBe(0);

    const run = (...args: string[]) => spawnSync('bash', [scriptPath, ...args], { encoding: 'utf8' });
    const badCmd = run('nuke-everything');
    expect(badCmd.status).toBe(2);
    expect(badCmd.stderr).toContain('usage:');

    const traversal = run('inspect', '--dir', '/opt/crove/../etc');
    expect(traversal.status).toBe(2);
    expect(traversal.stderr).toContain('--dir');

    const missingVal = run('inspect', '--dir');
    expect(missingVal.status).toBe(2);
    expect(missingVal.stderr).toContain('requires a value');

    const badUrl = run('inspect', '--dir', '/tmp', '--smoke-url', 'https://bad host/path');
    expect(badUrl.status).toBe(2);
    expect(badUrl.stderr).toContain('--smoke-url');
  });

  it('rewrites legacy CROVE_* keys, keeps existing LUDY_* precedence, updates DB URL roles, and sets COMPOSE_PROJECT_NAME=ludy', () => {
    const work = mkdtempSync(join(tmpdir(), 'ludy-cutover-env-'));
    tempDirs.push(work);
    const src = join(work, '.env.in');
    const dst = join(work, '.env.out');

    writeFileSync(
      src,
      [
        '# Pilot config',
        'PUBLIC_URL=https://app.example.com',
        'CROVE_DOMAIN=old.example.com',
        'CROVE_DOMAIN=app.example.com',
        'CROVE_MODULES=finance',
        'LUDY_MODULES=finance,crm,social',
        'export CROVE_APP_DB_PASSWORD=super-secret-app-pw',
        'CROVE_WORKER_DB_PASSWORD=super-secret-worker-pw # keep comment',
        'CROVE_CONTEXT_TOKEN_KEY="secret-ctx-key"',
        'CROVE_SMOKE_URL=http://127.0.0.1:8080',
        'CROVE_IMAGE=ghcr.io/dos/ludy@sha256:0000000000000000000000000000000000000000000000000000000000000000',
        'DATABASE_URL=postgres://crove_app:super-secret-app-pw@db:5432/postgres',
        'WORKER_DATABASE_URL="postgresql://crove_worker:super-secret-worker-pw@db:5432/postgres"',
        'COMPOSE_PROJECT_NAME=crove',
        'OTHER_SETTING=keep-me',
        '',
      ].join('\n'),
    );

    const res = spawnSync('bash', [scriptPath, 'rewrite-env', src, dst], { encoding: 'utf8' });
    expect(res.status).toBe(0);
    // Secret values must never appear on stdout/stderr.
    expect(res.stdout + res.stderr).not.toContain('super-secret');
    expect(res.stdout + res.stderr).not.toContain('secret-ctx-key');

    const out = readFileSync(dst, 'utf8');
    expect(out).toBe(
      [
        '# Pilot config',
        'PUBLIC_URL=https://app.example.com',
        'LUDY_DOMAIN=app.example.com',
        'LUDY_MODULES=finance,crm,social',
        'export LUDY_APP_DB_PASSWORD=super-secret-app-pw',
        'LUDY_WORKER_DB_PASSWORD=super-secret-worker-pw # keep comment',
        'LUDY_CONTEXT_TOKEN_KEY="secret-ctx-key"',
        'LUDY_SMOKE_URL=http://127.0.0.1:8080',
        'LUDY_IMAGE=ghcr.io/dos/ludy@sha256:0000000000000000000000000000000000000000000000000000000000000000',
        'DATABASE_URL=postgres://ludy_app:super-secret-app-pw@db:5432/postgres',
        'WORKER_DATABASE_URL="postgresql://ludy_worker:super-secret-worker-pw@db:5432/postgres"',
        'COMPOSE_PROJECT_NAME=ludy',
        'OTHER_SETTING=keep-me',
        '',
      ].join('\n'),
    );
  });

  it('preserves CRLF line endings and appends COMPOSE_PROJECT_NAME=ludy when missing', () => {
    const work = mkdtempSync(join(tmpdir(), 'ludy-cutover-crlf-'));
    tempDirs.push(work);
    const src = join(work, '.env.in');
    const dst = join(work, '.env.out');

    writeFileSync(src, 'CROVE_DOMAIN=app.example.com\r\nBACKUP_DIR=/var/backups/crove\r\n');
    const res = spawnSync('bash', [scriptPath, 'rewrite-env', src, dst], { encoding: 'utf8' });
    expect(res.status).toBe(0);
    expect(readFileSync(dst, 'utf8')).toBe('LUDY_DOMAIN=app.example.com\r\nBACKUP_DIR=/var/backups/crove\r\nCOMPOSE_PROJECT_NAME=ludy\r\n');
  });
});

describe('pilot-ludy-cutover workflow and pinned copy image', () => {
  it('shares the pinned postgres:17 digest with docker-compose.yml and enforces safe dispatch guards', () => {
    const compose = readFileSync(resolve(repo, 'docker-compose.yml'), 'utf8');
    const script = readFileSync(scriptPath, 'utf8');
    const workflow = readFileSync(workflowPath, 'utf8');

    const composeDigest = /postgres:17@(sha256:[0-9a-f]{64})/.exec(compose)?.[1];
    const scriptDigest = /postgres:17@(sha256:[0-9a-f]{64})/.exec(script)?.[1];
    expect(composeDigest).toBeDefined();
    expect(scriptDigest).toBe(composeDigest);

    // Must share deploy-pilot concurrency lock, require pilot environment, main branch, and explicit confirm phrases.
    expect(workflow).toContain('group: deploy-pilot');
    expect(workflow).toContain('environment: pilot');
    expect(workflow).toContain('refs/heads/main');
    expect(workflow).toContain('cutover-pilot-to-ludy');
    expect(workflow).toContain('switch-wal-to-ludy');
    expect(workflow).toContain('prune-crove-volumes');
    expect(workflow).toMatch(/inspect \| cutover-stack \| switch-wal \| prune-old-volumes[\s\S]*--overlay-dir '\$REMOTE'/);
    expect(workflow).toContain('timeout-minutes: 60');
    expect(workflow).toContain('lock active: preserving remote staging');
    expect(workflow).toContain('SMOKE_EXPECT_MODULES=');
    // Avoid stdout-polluting command substitution on wait_local_ready, enforce pipefail during volume copies,
    // replace overlay files atomically, guard LUDY_VOLUMES_COMMITTED on rollback, and stage overlays locally.
    expect(script).toContain('READY_URL=');
    expect(script).not.toMatch(/\$\(wait_local_ready\b/);
    expect(script).toContain('LUDY_VOLUMES_COMMITTED=1');
    expect(script).toContain('stage_overlays');
    expect(script).toContain('set -euo pipefail');
    expect(script).toContain('--entrypoint bash "$VOLUME_COPY_IMAGE"');
    expect(script).toContain('copy_into_deploy_dir');
    expect(script).not.toMatch(/^\s*(?:\w+\s+)*cp(?:\s+-\w+)?\s+[^#\n]+\s"\$DEPLOY_DIR\/(?:Caddyfile|compose\.)/m);
    // CodeQL Actions safety: never interpolate inputs directly inside run scripts.
    for (const runBlock of workflow.matchAll(/run:\s*\|\n([\s\S]*?)(?=\n\s*(?:- |env:|if:|name:|uses:|with:|$))/g)) {
      expect(runBlock[1]).not.toMatch(/\$\{\{\s*inputs\./);
    }
  });
});

interface StubFixture {
  work: string;
  deployDir: string;
  overlayDir: string;
  binDir: string;
  stubLog: string;
  volsFile: string;
  populatedFile: string;
}

function createCutoverFixture(): StubFixture {
  const work = mkdtempSync(join(tmpdir(), 'ludy-cutover-e2e-'));
  tempDirs.push(work);
  const deployDir = join(work, 'deploy');
  const overlayDir = join(work, 'overlay');
  const binDir = join(work, 'bin');
  const stubLog = join(work, 'stub.log');
  const volsFile = join(work, 'volumes.txt');
  const populatedFile = join(work, 'populated.txt');

  mkdirSync(deployDir, { recursive: true });
  mkdirSync(join(overlayDir, 'caddy'), { recursive: true });
  mkdirSync(join(overlayDir, 'backup'), { recursive: true });
  mkdirSync(join(overlayDir, 'wal'), { recursive: true });
  mkdirSync(binDir, { recursive: true });

  writeFileSync(join(deployDir, 'docker-compose.yml'), 'name: crove\nservices:\n  db:\n    image: postgres:17\n');
  writeFileSync(join(deployDir, 'compose.pilot.yml'), 'services:\n  api:\n    command: ["api"]\n  worker:\n    command: ["worker"]\n');
  writeFileSync(join(deployDir, 'compose.host.yml'), 'services:\n  caddy:\n    image: caddy:latest\n  mailpit:\n    ports: !reset []\n');
  writeFileSync(join(deployDir, 'Caddyfile'), '{ admin off }\n{$CROVE_DOMAIN} { reverse_proxy 127.0.0.1:8080 }\n');
  writeFileSync(join(deployDir, '.env'), ['COMPOSE_FILE=docker-compose.yml:compose.pilot.yml:compose.host.yml', 'CROVE_DOMAIN=api.example.com', 'DATABASE_URL=postgres://crove_app:pw@db:5432/postgres', ''].join('\n'));

  writeFileSync(
    join(overlayDir, 'deploy.sh'),
    ['#!/usr/bin/env bash', 'set -euo pipefail', 'printf "overlay-deploy %s\\n" "$*" >>"$STUB_LOG"', 'exit "${STUB_SMOKE_EXIT:-0}"', ''].join('\n'),
  );
  writeFileSync(join(overlayDir, 'caddy', 'Caddyfile'), '{ admin off }\n{$LUDY_DOMAIN} { reverse_proxy 127.0.0.1:8080 }\n');
  writeFileSync(join(overlayDir, 'caddy', 'compose.host.yml'), 'services:\n  caddy:\n    image: caddy:latest\n  mailpit:\n    ports: !reset []\n');
  writeFileSync(join(overlayDir, 'backup', 'compose.wal.yml'), 'services:\n  db:\n    environment:\n      PGBACKREST_STANZA: ${WAL_STANZA:-crove}\n');
  writeFileSync(
    join(overlayDir, 'backup', 'wal.sh'),
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if [ -n "${STUB_LOG_WAL_STANZA:-}" ]; then',
      '  printf "wal.sh %s WAL_STANZA=%s\\n" "$*" "${WAL_STANZA:-}" >>"$STUB_LOG"',
      'else',
      '  printf "wal.sh %s\\n" "$*" >>"$STUB_LOG"',
      'fi',
      'if [ "${1:-}" = info ]; then printf "%b\\n" "${STUB_WAL_INFO:-stanza: ludy\\nstatus: ok\\nfull backup: 20261124-000000F}"; fi',
      'if [ "${1:-}" = check ] && [ -n "${STUB_FAIL_WAL_CHECK_STANZA:-}" ] && [ "${WAL_STANZA:-}" = "$STUB_FAIL_WAL_CHECK_STANZA" ]; then',
      '  exit 1',
      'fi',
      'exit 0',
      '',
    ].join('\n'),
  );
  writeFileSync(join(overlayDir, 'wal', 'Dockerfile'), 'FROM postgres:17\n');

  const dockerStub = `#!/usr/bin/env bash
set -euo pipefail
cmd="\${1:-}"
shift || true
case "$cmd" in
  pull)
    printf 'docker pull %s\\n' "\${*: -1}" >>"$STUB_LOG"
    exit 0
    ;;
  ps)
    if [[ " $* " == *" --filter ancestor=crove-db:local "* ]]; then
      exit 0
    fi
    printf '%b' "\${STUB_PS_CONTAINERS:-}"
    exit 0
    ;;
  inspect)
    if [[ " $* " == *" {{.Config.Image}} "* ]]; then
      if [ -n "\${STUB_DB_IMAGE-crove-db:local}" ]; then printf '%s\\n' "\${STUB_DB_IMAGE-crove-db:local}"; fi
      exit 0
    fi
    printf '%b' "\${STUB_INSPECT_MOUNTS:-}"
    exit 0
    ;;
  image)
    if [ "\${1:-}" = inspect ]; then
      [ -n "\${STUB_HAS_CROVE_DB_IMAGE:-}" ] && exit 0 || exit 1
    fi
    printf 'docker image %s\\n' "$*" >>"$STUB_LOG"
    exit 0
    ;;
  volume)
    sub="\${1:-}"; shift || true
    case "$sub" in
      ls) cat "$STUB_VOLS_FILE" ;;
      inspect) grep -qx "\${1:-}" "$STUB_VOLS_FILE" ;;
      create)
        dst="\${*: -1}"
        printf 'docker volume create %s\\n' "$dst" >>"$STUB_LOG"
        printf '%s\\n' "$dst" >>"$STUB_VOLS_FILE"
        ;;
      rm)
        printf 'docker volume rm %s\\n' "$*" >>"$STUB_LOG"
        for v in "$@"; do
          grep -vx "$v" "$STUB_VOLS_FILE" >"$STUB_VOLS_FILE.tmp" || true
          mv "$STUB_VOLS_FILE.tmp" "$STUB_VOLS_FILE"
        done
        ;;
    esac
    exit 0
    ;;
  run)
    mounts=(); ep=''; img=''
    while (($# > 0)); do
      case "$1" in
        -v) mounts+=("$2"); shift 2 ;;
        --entrypoint) ep="$2"; shift 2 ;;
        --network | --user) shift 2 ;;
        --rm) shift ;;
        *)
          if [ -z "$img" ]; then img="$1"; shift; else break; fi
          ;;
      esac
    done
    if [ "$ep" = sh ]; then
      if [[ " $* " == *"pg_controldata"* ]]; then
        src_vol="\${mounts[0]%%:*}"
        dst_vol="\${mounts[1]%%:*}"
        if [ -n "\${STUB_CLUSTER_IDS:-}" ]; then
          src_id=''; dst_id=''
          for pair in \${STUB_CLUSTER_IDS}; do
            if [ "\${pair%%=*}" = "$src_vol" ]; then src_id="\${pair#*=}"; fi
            if [ "\${pair%%=*}" = "$dst_vol" ]; then dst_id="\${pair#*=}"; fi
          done
          [ -n "$src_id" ] && [ "$src_id" = "$dst_id" ] && exit 0 || exit 1
        fi
        grep -qx "$src_vol" "$STUB_POPULATED_FILE" 2>/dev/null && grep -qx "$dst_vol" "$STUB_POPULATED_FILE" 2>/dev/null && exit 0 || exit 1
      fi
      target="\${mounts[0]%%:*}"
      if grep -qx "$target" "$STUB_POPULATED_FILE" 2>/dev/null; then
        echo '/dst/PG_VERSION'
      fi
      exit 0
    fi
    if [ "$ep" = bash ]; then
      # Trailing args after -c script are: _ <src> <dst>
      src="\${@: -2:1}"
      dst="\${*: -1}"
      printf 'docker copy %s -> %s\\n' "$src" "$dst" >>"$STUB_LOG"
      if [ -n "\${STUB_FAIL_COPY_VOL:-}" ] && [ "$src" = "$STUB_FAIL_COPY_VOL" ]; then
        echo "stub copy failed for $src" >&2
        exit 1
      fi
      if grep -qx "$src" "$STUB_POPULATED_FILE" 2>/dev/null; then
        printf '%s\\n' "$dst" >>"$STUB_POPULATED_FILE"
      fi
      printf 'verified %s -> %s (10 entries)\\n' "$src" "$dst"
      exit 0
    fi
    exit 0
    ;;
  compose)
    if [ "\${1:-}" = version ]; then echo '2.30.0'; exit 0; fi
    proj=''
    cfiles=()
    while (($# > 0)); do
      case "$1" in
        --project-name) proj="$2"; shift 2 ;;
        --project-directory | --env-file) shift 2 ;;
        -f) cfiles+=("$2"); shift 2 ;;
        *) break ;;
      esac
    done
    sub="\${1:-}"; shift || true
    printf 'dc %s %s %s\\n' "$proj" "$sub" "$*" >>"$STUB_LOG"
    printf 'dc-files %s %s\\n' "$proj" "\${cfiles[*]}" >>"$STUB_LOG.files"
    case "$sub" in
      config)
        if [ "\${1:-}" = --services ]; then
          for s in \${STUB_SERVICES:-db migrate auth auth-grants worker api caddy prober}; do echo "$s"; done
        fi
        ;;
      ps)
        if [ "\${1:-}" = -q ] && [ "\${2:-}" = db ]; then
          if [ -n "\${STUB_DB_CID-stub-db-cid}" ]; then printf '%s\\n' "\${STUB_DB_CID-stub-db-cid}"; fi
        elif [ "$proj" = crove ] || [ "$proj" = ludy ]; then
          for s in db worker api; do echo "$s"; done
        fi
        ;;
      port) echo '127.0.0.1:18080' ;;
      exec)
        last="\${*: -1}"
        case "$*" in
          *pg_isready*) exit 0 ;;
          *printenv*PGBACKREST_STANZA*)
            if [ -n "\${STUB_PRE_WAL_STANZA-crove}" ]; then echo "\${STUB_PRE_WAL_STANZA-crove}"; fi
            ;;
          *printenv*PGBACKREST_REPO1_PATH*)
            if [ -n "\${STUB_PRE_WAL_REPO1_PATH-/crove/wal}" ]; then echo "\${STUB_PRE_WAL_REPO1_PATH-/crove/wal}"; fi
            ;;
          *pg_dump*) printf 'PGDMP-STUB\\n' ;;
          *pg_restore*) cat >/dev/null ;;
          *)
            case "$last" in
              *pg_namespace*)
                for s in ludy_ads ludy_crm ludy_finance ludy_hr ludy_jobs ludy_kernel ludy_meetings ludy_meta ludy_notes ludy_projects ludy_sign ludy_social; do
                  echo "$s"
                done
                ;;
              *schema_migrations*) echo 1 ;;
              *pg_stat_activity*) echo 0 ;;
              *pg_class*) echo 1 ;;
            esac
            ;;
        esac
        ;;
    esac
    exit 0
    ;;
esac
`;

  const curlStub = `#!/usr/bin/env bash
set -euo pipefail
url="\${*: -1}"
printf 'curl %s\\n' "$url" >>"$STUB_LOG"
if [ -n "\${STUB_READYZ_FAIL:-}" ]; then
  echo '{"ready":false}'
  exit 22
fi
echo '{"ready":true}'
`;

  writeFileSync(join(binDir, 'docker'), dockerStub);
  chmodSync(join(binDir, 'docker'), 0o755);
  writeFileSync(join(binDir, 'curl'), curlStub);
  chmodSync(join(binDir, 'curl'), 0o755);
  writeFileSync(volsFile, ['crove_db-data', 'crove_files'].join('\n') + '\n');
  writeFileSync(populatedFile, ['crove_db-data', 'crove_files'].join('\n') + '\n');
  writeFileSync(stubLog, '');

  return { work, deployDir, overlayDir, binDir, stubLog, volsFile, populatedFile };
}

function runWithStubs(f: StubFixture, args: string[], extraEnv: Record<string, string> = {}) {
  return spawnSync('bash', [scriptPath, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${f.binDir}${delimiter}${process.env['PATH'] ?? ''}`,
      LUDY_READY_TIMEOUT: '5',
      LUDY_WAIT_TIMEOUT: '5',
      LUDY_WORKER_SETTLE: '0',
      STUB_LOG: f.stubLog,
      STUB_VOLS_FILE: f.volsFile,
      STUB_POPULATED_FILE: f.populatedFile,
      ...extraEnv,
    },
  });
}

describe.skipIf(!hasBash)('cutover-ludy.sh lifecycle & safety gates', () => {
  it('pre-commit failure (during volume copy) removes partial ludy_* volumes, restores .env, and restarts crove', { timeout: 15000 }, () => {
    const f = createCutoverFixture();
    const res = runWithStubs(
      f,
      ['cutover-stack', '--dir', f.deployDir, '--overlay-dir', f.overlayDir],
      { STUB_FAIL_COPY_VOL: 'crove_files' },
    );
    expect(res.status).not.toBe(0);

    const logText = readFileSync(f.stubLog, 'utf8');
    // Partial ludy_* volume created before failure is deleted on rollback, and original crove stack comes back up.
    expect(logText).toContain('docker volume create ludy_db-data');
    expect(logText).toContain('docker volume rm ludy_db-data');
    expect(logText).toContain('dc crove up -d --no-build --no-deps --wait --wait-timeout 5 db');
    expect(logText).toContain('dc crove restart caddy');
    // Original .env must be restored.
    expect(readFileSync(join(f.deployDir, '.env'), 'utf8')).toContain('CROVE_DOMAIN=api.example.com');
  });

  it('post-commit failure (B1: smoke fails after ludy starts) preserves ludy_* volumes, never restarts crove, and leaves caddy down', { timeout: 15000 }, () => {
    const f = createCutoverFixture();
    const res = runWithStubs(
      f,
      ['cutover-stack', '--dir', f.deployDir, '--overlay-dir', f.overlayDir],
      { STUB_SMOKE_EXIT: '1' },
    );
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('preserving ludy_* volumes');

    const logText = readFileSync(f.stubLog, 'utf8');
    // Commit point reached: ludy started, smoke failed, rollback MUST NOT delete ludy_* volumes or restart crove.
    expect(logText).toContain('dc ludy up -d --no-build --no-deps --wait --wait-timeout 5 api');
    expect(logText).not.toContain('docker volume rm');
    expect(logText).not.toContain('dc crove up');
    // Caddy must stay offline because verification never completed.
    expect(logText).not.toContain('caddy');
  });

  it('success path starts caddy ONLY after loopback smoke passes and leaves both volume sets intact until prune', { timeout: 15000 }, () => {
    const f = createCutoverFixture();
    const res = runWithStubs(f, ['cutover-stack', '--dir', f.deployDir, '--overlay-dir', f.overlayDir]);
    expect(res.status, res.stderr).toBe(0);

    const logLines = readFileSync(f.stubLog, 'utf8').split('\n').filter(Boolean);
    const smokeIdx = logLines.findIndex((l) => l.startsWith('overlay-deploy smoke '));
    const caddyIdx = logLines.findIndex((l) => l.includes('dc ludy up ') && l.endsWith(' caddy'));
    expect(smokeIdx).toBeGreaterThan(-1);
    expect(caddyIdx).toBeGreaterThan(smokeIdx);
    expect(readFileSync(join(f.deployDir, '.env'), 'utf8')).toContain('COMPOSE_PROJECT_NAME=ludy');
    expect(readFileSync(f.volsFile, 'utf8')).toContain('ludy_db-data');
    expect(readFileSync(f.volsFile, 'utf8')).toContain('crove_db-data');
  });

  it('prune-old-volumes (L1 + L2) enforces matching ludy_* + WAL stanza ludy backup gates and removes temporary db.dump files', { timeout: 15000 }, () => {
    const f = createCutoverFixture();
    // Run cutover first so COMPOSE_PROJECT_NAME=ludy and cutover-backup-*/db.dump exist.
    expect(runWithStubs(f, ['cutover-stack', '--dir', f.deployDir, '--overlay-dir', f.overlayDir]).status).toBe(0);

    // Case 1: orphan crove_orphan volume with no matching ludy_orphan must refuse before deleting anything.
    writeFileSync(f.volsFile, readFileSync(f.volsFile, 'utf8') + 'crove_orphan\n');
    const missingTarget = runWithStubs(f, ['prune-old-volumes', '--dir', f.deployDir, '--overlay-dir', f.overlayDir]);
    expect(missingTarget.status).toBe(1);
    expect(missingTarget.stderr).toContain('matching replacement volume ludy_orphan does not exist');

    // Remove the orphan entry and enable WAL without WAL_STANZA=ludy -> must refuse.
    writeFileSync(f.volsFile, ['crove_db-data', 'crove_files', 'ludy_db-data', 'ludy_files', ''].join('\n'));
    writeFileSync(join(f.deployDir, 'compose.wal.yml'), 'services: {}\n');
    const missingStanza = runWithStubs(f, ['prune-old-volumes', '--dir', f.deployDir, '--overlay-dir', f.overlayDir]);
    expect(missingStanza.status).toBe(1);
    expect(missingStanza.stderr).toContain('WAL_STANZA must be ludy');

    // Set WAL_STANZA=ludy but wal.sh info has no backup -> must refuse.
    writeFileSync(join(f.deployDir, '.env'), readFileSync(join(f.deployDir, '.env'), 'utf8') + 'WAL_STANZA=ludy\n');
    const noBackup = runWithStubs(
      f,
      ['prune-old-volumes', '--dir', f.deployDir, '--overlay-dir', f.overlayDir],
      { STUB_WAL_INFO: 'stanza: ludy\nstatus: ok\n' },
    );
    expect(noBackup.status).toBe(1);
    expect(noBackup.stderr).toContain('no verified backup exists on stanza ludy');

    // Healthy stanza: ludy + ok + full backup -> removes crove_* volumes and temporary db.dump files cleanly.
    const backupDirs = readdirSync(join(f.deployDir, '.deploy')).filter((n) => n.startsWith('cutover-backup-'));
    expect(backupDirs.length).toBeGreaterThan(0);
    const dumpPath = join(f.deployDir, '.deploy', backupDirs[0] as string, 'db.dump');
    expect(existsSync(dumpPath)).toBe(true);

    const pruned = runWithStubs(f, ['prune-old-volumes', '--dir', f.deployDir, '--overlay-dir', f.overlayDir]);
    expect(pruned.status).toBe(0);
    expect(readFileSync(f.volsFile, 'utf8')).not.toContain('crove_');
    expect(readFileSync(f.volsFile, 'utf8')).toContain('ludy_db-data');
    expect(existsSync(dumpPath)).toBe(false);
  });

  it('prune-old-volumes blocks mounted crove_* or uncopied data, while allowing legitimately empty S3 volumes', { timeout: 15000 }, () => {
    const f = createCutoverFixture();
    writeFileSync(
      join(f.deployDir, '.env'),
      ['COMPOSE_PROJECT_NAME=ludy', 'COMPOSE_FILE=docker-compose.yml:compose.pilot.yml', 'LUDY_DOMAIN=api.example.com', ''].join('\n'),
    );
    writeFileSync(f.volsFile, ['crove_db-data', 'crove_files', 'crove_archive', 'ludy_db-data', 'ludy_files', 'ludy_archive', ''].join('\n'));
    writeFileSync(f.populatedFile, ['crove_db-data', 'ludy_db-data', 'crove_archive', ''].join('\n'));

    // Container still mounting crove_* must block prune.
    const mountedRef = runWithStubs(
      f,
      ['prune-old-volumes', '--dir', f.deployDir, '--overlay-dir', f.overlayDir],
      { STUB_PS_CONTAINERS: 'abc123\n', STUB_INSPECT_MOUNTS: 'crove_files\n' },
    );
    expect(mountedRef.status).toBe(1);
    expect(mountedRef.stderr).toContain('container(s) still reference crove_* volume(s): crove_files');

    // Non-empty source crove_archive with empty replacement ludy_archive must block prune.
    const emptyReplacement = runWithStubs(f, ['prune-old-volumes', '--dir', f.deployDir, '--overlay-dir', f.overlayDir]);
    expect(emptyReplacement.status).toBe(1);
    expect(emptyReplacement.stderr).toContain('source volume was non-empty but replacement volume ludy_archive (archive) is empty');

    // Populating ludy_archive allows prune to succeed even though crove_files and ludy_files are both empty (S3 pilot).
    writeFileSync(f.populatedFile, readFileSync(f.populatedFile, 'utf8') + 'ludy_archive\n');
    const pruned = runWithStubs(f, ['prune-old-volumes', '--dir', f.deployDir, '--overlay-dir', f.overlayDir]);
    expect(pruned.status).toBe(0);
    expect(readFileSync(f.volsFile, 'utf8')).not.toContain('crove_');
    expect(readFileSync(f.volsFile, 'utf8')).toContain('ludy_files');
  });

  it('cutover-stack preserves pre-switch WAL settings until switch-wal runs when compose.wal.yml is present (#3972)', { timeout: 15000 }, () => {
    const f = createCutoverFixture();
    writeFileSync(join(f.deployDir, 'compose.wal.yml'), 'services:\n  db:\n    image: ${WAL_DB_IMAGE:-ludy-db:local}\n');
    const res = runWithStubs(f, ['cutover-stack', '--dir', f.deployDir, '--overlay-dir', f.overlayDir]);
    expect(res.status, res.stderr).toBe(0);
    const updatedEnv = readFileSync(join(f.deployDir, '.env'), 'utf8');
    expect(updatedEnv).toContain('WAL_DB_IMAGE=crove-db:local');
    expect(updatedEnv).toContain('WAL_STANZA=crove');
    expect(updatedEnv).toContain('BACKUP_S3_PREFIX=crove');
  });

  it('cutover-stack captures live db WAL configuration over .env defaults and aborts before stopping if unreadable (#3972)', { timeout: 15000 }, () => {
    const f = createCutoverFixture();
    writeFileSync(join(f.deployDir, 'compose.wal.yml'), 'services:\n  db:\n    image: ${WAL_DB_IMAGE:-ludy-db:local}\n');
    const res = runCutover(['cutover-stack', '--dir', f.deployDir, '--overlay-dir', f.overlayDir], {
      STUB_DB_IMAGE: 'custom-pg:17',
      STUB_PRE_WAL_STANZA: 'custom_stanza',
      STUB_PRE_WAL_REPO1_PATH: '/custom-prefix/wal/',
    });
    expect(res.status, res.stderr + res.stdout).toBe(0);
    const updatedEnv = readFileSync(join(f.deployDir, '.env'), 'utf8');
    expect(updatedEnv).toContain('WAL_DB_IMAGE=custom-pg:17');
    expect(updatedEnv).toContain('WAL_STANZA=custom_stanza');
    expect(updatedEnv).toContain('BACKUP_S3_PREFIX=custom-prefix');

    const fBad = createCutoverFixture();
    writeFileSync(join(fBad.deployDir, 'compose.wal.yml'), 'services:\n  db:\n    image: ${WAL_DB_IMAGE:-ludy-db:local}\n');
    const failRes = runCutover(['cutover-stack', '--dir', fBad.deployDir, '--overlay-dir', fBad.overlayDir], {
      STUB_PRE_WAL_STANZA: '',
    });
    expect(failRes.status).toBe(1);
    expect(failRes.stderr).toContain('cannot inspect active WAL configuration on running db container');
    expect(readFileSync(fBad.stubLog, 'utf8')).not.toContain('dc crove stop');
  });

  it('cutover-stack preserves BACKUP_S3_PREFIX even without S3 keys in .env, resolves checkout WAL paths, and prune-old-volumes verifies cluster ID (#3972)', { timeout: 15000 }, () => {
    // Minimal non-WAL .env with no BACKUP_S3_ENDPOINT/BUCKET in .env (e.g. systemd/cron S3 env) still pins BACKUP_S3_PREFIX=crove.
    const f = createCutoverFixture();
    const res = runWithStubs(f, ['cutover-stack', '--dir', f.deployDir, '--overlay-dir', f.overlayDir]);
    expect(res.status, res.stderr).toBe(0);
    const updatedEnv = readFileSync(join(f.deployDir, '.env'), 'utf8');
    expect(updatedEnv).toContain('BACKUP_S3_PREFIX=crove');
    expect(updatedEnv).not.toContain('WAL_DB_IMAGE=');
    expect(updatedEnv).not.toContain('WAL_STANZA=');

    const fExplicit = createCutoverFixture();
    writeFileSync(
      join(fExplicit.deployDir, '.env'),
      readFileSync(join(fExplicit.deployDir, '.env'), 'utf8') + 'BACKUP_S3_PREFIX=custom\n',
    );
    const resExplicit = runWithStubs(fExplicit, ['cutover-stack', '--dir', fExplicit.deployDir, '--overlay-dir', fExplicit.overlayDir]);
    expect(resExplicit.status, resExplicit.stderr).toBe(0);
    const updatedExplicit = readFileSync(join(fExplicit.deployDir, '.env'), 'utf8');
    expect(updatedExplicit).toContain('BACKUP_S3_PREFIX=custom');
    expect(updatedExplicit).not.toContain('BACKUP_S3_PREFIX=crove');

    // COMPOSE_FILE referencing tools/backup/compose.wal.yml directly resolves WAL overlay and pins WAL_* + BACKUP_S3_PREFIX.
    const fCheckoutWal = createCutoverFixture();
    mkdirSync(join(fCheckoutWal.deployDir, 'tools/backup'), { recursive: true });
    writeFileSync(join(fCheckoutWal.deployDir, 'tools/backup/compose.wal.yml'), 'services:\n  db:\n    image: ${WAL_DB_IMAGE:-ludy-db:local}\n');
    writeFileSync(
      join(fCheckoutWal.deployDir, '.env'),
      readFileSync(join(fCheckoutWal.deployDir, '.env'), 'utf8').replace(
        'COMPOSE_FILE=docker-compose.yml:compose.pilot.yml:compose.host.yml',
        'COMPOSE_FILE=docker-compose.yml:compose.pilot.yml:compose.host.yml:tools/backup/compose.wal.yml',
      ),
    );
    const resWal = runWithStubs(fCheckoutWal, ['cutover-stack', '--dir', fCheckoutWal.deployDir, '--overlay-dir', fCheckoutWal.overlayDir]);
    expect(resWal.status, resWal.stderr).toBe(0);
    expect(readFileSync(`${fCheckoutWal.stubLog}.files`, 'utf8')).toContain(`${fCheckoutWal.deployDir}/tools/backup/compose.wal.yml`);
    const walEnv = readFileSync(join(fCheckoutWal.deployDir, '.env'), 'utf8');
    expect(walEnv).toContain('WAL_DB_IMAGE=crove-db:local');
    expect(walEnv).toContain('WAL_STANZA=crove');
    expect(walEnv).toContain('BACKUP_S3_PREFIX=crove');

    // Missing compose.wal.yml referenced in COMPOSE_FILE fails before stopping containers.
    const fMissingWal = createCutoverFixture();
    writeFileSync(
      join(fMissingWal.deployDir, '.env'),
      readFileSync(join(fMissingWal.deployDir, '.env'), 'utf8').replace(
        'COMPOSE_FILE=docker-compose.yml:compose.pilot.yml:compose.host.yml',
        'COMPOSE_FILE=docker-compose.yml:tools/backup/compose.wal.yml',
      ),
    );
    const resMissingWal = runWithStubs(fMissingWal, ['cutover-stack', '--dir', fMissingWal.deployDir, '--overlay-dir', fMissingWal.overlayDir]);
    expect(resMissingWal.status).toBe(2);
    expect(resMissingWal.stderr).toContain('COMPOSE_FILE references compose.wal.yml');

    // COMPOSE_FILE referencing tools/deploy/compose.pilot.yml resolves pilot overlay without root compose.pilot.yml.
    const fCheckoutPilot = createCutoverFixture();
    rmSync(join(fCheckoutPilot.deployDir, 'compose.pilot.yml'));
    mkdirSync(join(fCheckoutPilot.deployDir, 'tools/deploy'), { recursive: true });
    writeFileSync(join(fCheckoutPilot.deployDir, 'tools/deploy/compose.pilot.yml'), 'services:\n  api:\n    command: ["api"]\n');
    writeFileSync(
      join(fCheckoutPilot.deployDir, '.env'),
      readFileSync(join(fCheckoutPilot.deployDir, '.env'), 'utf8').replace(
        'COMPOSE_FILE=docker-compose.yml:compose.pilot.yml:compose.host.yml',
        'COMPOSE_FILE=docker-compose.yml:tools/deploy/compose.pilot.yml:compose.host.yml',
      ),
    );
    const resPilot = runWithStubs(fCheckoutPilot, ['cutover-stack', '--dir', fCheckoutPilot.deployDir, '--overlay-dir', fCheckoutPilot.overlayDir]);
    expect(resPilot.status, resPilot.stderr).toBe(0);
    expect(readFileSync(`${fCheckoutPilot.stubLog}.files`, 'utf8')).toContain(`${fCheckoutPilot.deployDir}/tools/deploy/compose.pilot.yml`);

    // Missing compose.pilot.yml referenced in COMPOSE_FILE fails closed before touching containers.
    const fMissingPilot = createCutoverFixture();
    rmSync(join(fMissingPilot.deployDir, 'compose.pilot.yml'));
    const resMissingPilot = runWithStubs(fMissingPilot, ['cutover-stack', '--dir', fMissingPilot.deployDir, '--overlay-dir', fMissingPilot.overlayDir]);
    expect(resMissingPilot.status).toBe(2);
    expect(resMissingPilot.stderr).toContain('COMPOSE_FILE lists compose.pilot.yml');

    // switch-wal rollback on a legacy stack without WAL_STANZA in .env restores pre-switch stanza and verifies wal.sh check.
    const fWalRollback = createCutoverFixture();
    writeFileSync(
      join(fWalRollback.deployDir, '.env'),
      readFileSync(join(fWalRollback.deployDir, '.env'), 'utf8').replace('COMPOSE_FILE=', 'COMPOSE_FILE=compose.wal.yml:'),
    );
    writeFileSync(join(fWalRollback.deployDir, 'compose.wal.yml'), 'services:\n  db:\n    environment:\n      PGBACKREST_STANZA: ${WAL_STANZA:-crove}\n');
    const resWalRollback = runWithStubs(
      fWalRollback,
      ['switch-wal', '--dir', fWalRollback.deployDir, '--overlay-dir', fWalRollback.overlayDir],
      {
        STUB_LOG_WAL_STANZA: '1',
        STUB_PRE_WAL_STANZA: 'crove',
        STUB_FAIL_WAL_CHECK_STANZA: 'ludy',
      },
    );
    expect(resWalRollback.status).not.toBe(0);
    const walStubLog = readFileSync(fWalRollback.stubLog, 'utf8');
    expect(walStubLog).toContain('wal.sh setup WAL_STANZA=crove');
    expect(walStubLog).toContain('wal.sh check WAL_STANZA=crove');
  });

  it('prune-old-volumes detects ludy service on Stage 7 non-pilot stacks and refuses mismatched DB cluster IDs (#3972)', { timeout: 15000 }, () => {
    const f = createCutoverFixture();
    writeFileSync(
      join(f.deployDir, '.env'),
      ['COMPOSE_PROJECT_NAME=ludy', 'COMPOSE_FILE=docker-compose.yml', 'LUDY_DOMAIN=api.example.com', ''].join('\n'),
    );
    writeFileSync(f.volsFile, ['crove_db-data', 'ludy_db-data', ''].join('\n'));
    writeFileSync(f.populatedFile, ['crove_db-data', 'ludy_db-data', ''].join('\n'));

    // Both volumes non-empty but mismatched PostgreSQL system_identifier -> must refuse before removing crove_db-data.
    const mismatched = runWithStubs(
      f,
      ['prune-old-volumes', '--dir', f.deployDir, '--overlay-dir', f.overlayDir],
      {
        STUB_SERVICES: 'db migrate auth auth-grants ludy-extract ludy-media ludy',
        STUB_CLUSTER_IDS: 'crove_db-data=cluster-old ludy_db-data=cluster-fresh',
      },
    );
    expect(mismatched.status).toBe(1);
    expect(mismatched.stderr).toContain('does not match crove_db-data PostgreSQL cluster system identifier');
    expect(readFileSync(f.volsFile, 'utf8')).toContain('crove_db-data');

    const res = runWithStubs(f, ['prune-old-volumes', '--dir', f.deployDir, '--overlay-dir', f.overlayDir], {
      STUB_SERVICES: 'db migrate auth auth-grants ludy-extract ludy-media ludy',
      STUB_CLUSTER_IDS: 'crove_db-data=cluster-1 ludy_db-data=cluster-1',
    });
    expect(res.status, res.stderr).toBe(0);
    expect(readFileSync(f.stubLog, 'utf8')).toContain('dc ludy port ludy 8080');
    expect(readFileSync(f.volsFile, 'utf8')).not.toContain('crove_');
  });
});
