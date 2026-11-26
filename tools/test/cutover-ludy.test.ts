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
    const deployWorkflow = readFileSync(resolve(repo, '.github/workflows/deploy.yml'), 'utf8');
    for (const wf of [workflow, deployWorkflow]) {
      expect(wf).toContain('dir="${DEPLOY_DIR:-/opt/ludy}"');
      expect(wf).not.toContain('dir="${DEPLOY_DIR:-/opt/crove}"');
      expect(wf).toContain('host_dir_state=');
      expect(wf).toContain('legacy_crove');
    }
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
      'eff_stanza="${WAL_STANZA:-}"',
      'if [ -z "$eff_stanza" ] && [ -n "${LUDY_ENV_FILE:-}" ] && [ -f "$LUDY_ENV_FILE" ]; then',
      "  eff_stanza=\"$(sed -n -E 's/\\r$//; s/^[[:space:]]*(export[[:space:]]+)?WAL_STANZA[[:space:]]*=[[:space:]]*//p' \"$LUDY_ENV_FILE\" | tail -n 1 | sed -E 's/[[:space:]]+#.*$//' | tr -d ' \\047\"')\"",
      'fi',
      'eff_stanza="${eff_stanza:-ludy}"',
      'if [ -n "${STUB_LOG_WAL_STANZA:-}" ]; then',
      '  printf "wal.sh %s WAL_STANZA=%s\\n" "$*" "$eff_stanza" >>"$STUB_LOG"',
      'else',
      '  printf "wal.sh %s\\n" "$*" >>"$STUB_LOG"',
      'fi',
      'if [ "${1:-}" = info ]; then printf "%b\\n" "${STUB_WAL_INFO:-stanza: ludy\\nstatus: ok\\nfull backup: 20261124-000000F}"; fi',
      'if [ "${1:-}" = check ] && [ -n "${STUB_FAIL_WAL_CHECK_STANZA:-}" ] && [ "$eff_stanza" = "$STUB_FAIL_WAL_CHECK_STANZA" ]; then',
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
    if [ -n "\${STUB_DOCKER_PS_FAIL:-}" ]; then
      echo 'Cannot connect to the Docker daemon' >&2
      exit 1
    fi
    if [[ " $* " == *" --filter ancestor=crove-db:local "* ]]; then
      exit 0
    fi
    ps_proj=''
    ps_svc=''
    ps_id=''
    while (($# > 0)); do
      case "$1" in
        --filter)
          case "\${2:-}" in
            label=com.docker.compose.project=*) ps_proj="\${2#label=com.docker.compose.project=}" ;;
            label=com.docker.compose.service=*) ps_svc="\${2#label=com.docker.compose.service=}" ;;
            id=*) ps_id="\${2#id=}" ;;
          esac
          shift 2
          ;;
        *) shift ;;
      esac
    done
    if [ -n "$ps_id" ]; then
      for item in \${STUB_PROJECT_CONTAINERS:-}; do
        if [ "\${item#*|}" = "$ps_id" ]; then printf '%s\\n' "$ps_id"; exit 0; fi
      done
      exit 0
    fi
    if [ -n "$ps_proj" ] && [ -z "$ps_svc" ]; then
      for item in \${STUB_PROJECT_CONTAINERS:-}; do
        if [ "\${item%%|*}" = "$ps_proj" ]; then printf '%s\\n' "\${item#*|}"; fi
      done
      exit 0
    fi
    if [ -n "$ps_proj" ] || [ -n "$ps_svc" ]; then
      if [ -n "\${STUB_SERVICE_CIDS:-}" ]; then
        for item in \${STUB_SERVICE_CIDS}; do
          key="\${item%%=*}"
          val="\${item#*=}"
          cid="\${val%%:*}"
          if [ "$val" != "$cid" ]; then oneoff="\${val#*:}"; else oneoff='False'; fi
          if [ "$key" = "\${ps_proj}:\${ps_svc}" ]; then
            printf '%s %s\\n' "$cid" "$oneoff"
          fi
        done
      else
        case " \${STUB_SERVICES:-db migrate auth auth-grants worker api caddy prober} " in
          *" $ps_svc "*)
            if [ "$ps_proj" = ludy ]; then
              printf 'stub-%s-cid False\\n' "$ps_svc"
            else
              printf 'stub-%s-%s-cid False\\n' "$ps_proj" "$ps_svc"
            fi
            ;;
        esac
      fi
      exit 0
    fi
    printf '%b' "\${STUB_PS_CONTAINERS:-}"
    exit 0
    ;;
  inspect)
    if [[ " $* " == *working_dir* ]]; then
      cid="\${@: -1}"
      for line in \${STUB_INSPECT_WORKDIRS:-}; do
        if [ "\${line%%|*}" = "$cid" ]; then
          printf '%s\\n' "\${line#*|}"
          exit 0
        fi
      done
      exit 0
    fi
    if [[ " $* " == *" {{.Config.Image}} "* ]]; then
      if [ -n "\${STUB_DB_IMAGE-crove-db:local}" ]; then printf '%s\\n' "\${STUB_DB_IMAGE-crove-db:local}"; fi
      exit 0
    fi
    if [[ " $* " == *"HostConfig.Mounts"* ]]; then
      cid="\${@: -1}"
      if [ -n "\${STUB_HOSTCONFIG_MOUNTS:-}" ]; then
        for line in \${STUB_HOSTCONFIG_MOUNTS}; do
          if [ "\${line%%|*}" = "$cid" ]; then
            printf '%s\\n' "\${line#*|}"
            exit 0
          fi
        done
      fi
      printf '[]\\n'
      exit 0
    fi
    if [[ " $* " == *"{{range .Mounts}}"* ]]; then
      cid="\${@: -1}"
      if [ -n "\${STUB_CONTAINER_MOUNTS:-}" ]; then
        matched=0
        for line in \${STUB_CONTAINER_MOUNTS}; do
          if [ "\${line%%|*}" = "$cid" ]; then
            printf '%s\\n' "\${line#*|}"
            matched=1
          fi
        done
        if [ "$matched" = 0 ] && [[ "$cid" =~ ^stub-([a-z0-9_-]+)-([a-z0-9_-]+)-cid$ ]]; then
          m_proj="\${BASH_REMATCH[1]}"
          m_svc="\${BASH_REMATCH[2]}"
          for line in \${STUB_CONTAINER_MOUNTS}; do
            if [ "\${line%%|*}" = "stub-\${m_svc}-cid" ]; then
              rest="\${line#*|}"
              rest="\${rest//|volume|ludy_/|volume|\${m_proj}_}"
              printf '%s\\n' "$rest"
            fi
          done
        fi
      else
        case "$cid" in
          stub-db-cid)
            printf '/var/lib/postgresql/data|volume|ludy_db-data|\\n'
            ;;
          stub-*-db-cid)
            m_proj="\${cid#stub-}"
            m_proj="\${m_proj%-db-cid}"
            printf '/var/lib/postgresql/data|volume|%s_db-data|\\n' "$m_proj"
            ;;
          stub-crove-cid | stub-ludy-cid | stub-api-cid | stub-worker-cid)
            printf '/data/files|volume|ludy_files|\\n/data/keys|volume|ludy_keys|\\n/data/archive|volume|ludy_archive|\\n'
            ;;
          stub-*-crove-cid | stub-*-ludy-cid | stub-*-api-cid | stub-*-worker-cid)
            m_proj="\${cid#stub-}"
            m_proj="\${m_proj%-*-cid}"
            printf '/data/files|volume|%s_files|\\n/data/keys|volume|%s_keys|\\n/data/archive|volume|%s_archive|\\n' "$m_proj" "$m_proj" "$m_proj"
            ;;
        esac
      fi
      exit 0
    fi
    printf '%b' "\${STUB_INSPECT_MOUNTS:-}"
    exit 0
    ;;
  image)
    if [ "\${1:-}" = inspect ]; then
      if [[ " $* " == *"--format"* ]] && [[ " $* " == *".Config.Env"* ]]; then
        [ -z "\${STUB_IMAGE_INSPECT_FAIL:-}" ] || exit 1
        printf '%b\\n' "\${STUB_IMAGE_PGDATA-PGDATA=/var/lib/postgresql/data}"
        exit 0
      fi
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
    mounts=(); ep=''; img=''; pg_sub=''
    while (($# > 0)); do
      case "$1" in
        -v) mounts+=("$2"); shift 2 ;;
        -e)
          case "$2" in
            PG_SUBDIR=*) pg_sub="\${2#PG_SUBDIR=}" ;;
          esac
          shift 2
          ;;
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
        printf 'probe PG_SUBDIR=%s\n' "$pg_sub" >>"$STUB_LOG"
        if [ -n "\${STUB_EXPECT_PG_SUBDIR:-}" ] && [ "$pg_sub" != "\${STUB_EXPECT_PG_SUBDIR}" ]; then
          exit 1
        fi
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
        elif [ -z "\${1:-}" ]; then
          if [ "$proj" = crove ] && [ -n "\${STUB_CONFIG_YAML_CROVE:-}" ]; then
            printf '%b' "$STUB_CONFIG_YAML_CROVE"
          elif [ "$proj" = ludy ] && [ -n "\${STUB_CONFIG_YAML_LUDY:-}" ]; then
            printf '%b' "$STUB_CONFIG_YAML_LUDY"
          elif [ -n "\${STUB_CONFIG_YAML:-}" ]; then
            printf '%b' "\${STUB_CONFIG_YAML//\\{proj\\}/$proj}"
          else
            printf 'name: %s\\nservices:\\n' "$proj"
            vol_defs=''
            for s in \${STUB_SERVICES:-db migrate auth auth-grants worker api caddy prober}; do
              printf '  %s:\\n' "$s"
              emitted_svc=0
              if [ -n "\${STUB_CONTAINER_MOUNTS:-}" ]; then
                for line in \${STUB_CONTAINER_MOUNTS}; do
                  if [ "\${line%%|*}" = "stub-\${s}-cid" ]; then
                    if [ "$emitted_svc" = 0 ]; then printf '    volumes:\\n'; emitted_svc=1; fi
                    rest="\${line#*|}"
                    IFS='|' read -r m_dst m_type m_name m_src _ <<<"$rest"
                    if [ "$m_type" = bind ]; then
                      printf '      - type: bind\\n        source: %s\\n        target: %s\\n' "$m_src" "$m_dst"
                    elif [ "$m_type" = volume ]; then
                      m_name="\${m_name/#ludy_/\${proj}_}"
                      printf '      - type: volume\\n        source: %s\\n        target: %s\\n' "$m_name" "$m_dst"
                      vol_defs="\${vol_defs}  \${m_name}:\\n    name: \${m_name}\\n"
                    fi
                  fi
                done
                if [ "$emitted_svc" = 1 ]; then continue; fi
              fi
              case "$s" in
                db)
                  printf '    volumes:\\n      - type: volume\\n        source: db-data\\n        target: /var/lib/postgresql/data\\n'
                  vol_defs="\${vol_defs}  db-data:\\n    name: \${proj}_db-data\\n"
                  ;;
                api | worker | crove | ludy)
                  printf '    volumes:\\n      - type: volume\\n        source: files\\n        target: /data/files\\n      - type: volume\\n        source: keys\\n        target: /data/keys\\n      - type: volume\\n        source: archive\\n        target: /data/archive\\n'
                  vol_defs="\${vol_defs}  files:\\n    name: \${proj}_files\\n  keys:\\n    name: \${proj}_keys\\n  archive:\\n    name: \${proj}_archive\\n"
                  ;;
              esac
            done
            if [ -n "$vol_defs" ]; then
              printf 'volumes:\\n%b' "$vol_defs"
            fi
          fi
        fi
        ;;
      ps)
        if [ "\${1:-}" = -q ] && [ "\${2:-}" = db ]; then
          if [ -n "\${STUB_DB_CID+x}" ]; then
            if [ -n "$STUB_DB_CID" ]; then printf '%s\\n' "$STUB_DB_CID"; fi
          elif [ "$proj" = ludy ]; then
            printf 'stub-db-cid\\n'
          else
            printf 'stub-%s-db-cid\\n' "$proj"
          fi
        elif [ "\${1:-}" = -q ] && [ -n "\${2:-}" ]; then
          svc="$2"
          case " \${STUB_SERVICES:-db migrate auth auth-grants worker api caddy prober} " in
            *" $svc "*)
              if [ "$proj" = ludy ]; then
                printf 'stub-%s-cid\\n' "$svc"
              else
                printf 'stub-%s-%s-cid\\n' "$proj" "$svc"
              fi
              ;;
          esac
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
          *printenv*PGDATA*)
            if [ -n "\${STUB_LIVE_PGDATA:-}" ]; then echo "\${STUB_LIVE_PGDATA}"; fi
            ;;
          *pg_dump*) printf 'PGDMP-STUB\\n' ;;
          *pg_restore*) cat >/dev/null ;;
          *)
            case "$last" in
              *pg_control_system*)
                if [ "$proj" = ludy ]; then
                  echo "\${STUB_POST_CLUSTER_ID:-\${STUB_PRE_CLUSTER_ID:-7400000000000000001}}"
                else
                  echo "\${STUB_PRE_CLUSTER_ID:-7400000000000000001}"
                fi
                ;;
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

  it('cutover-stack preserves non-empty CROVE_* values when an empty LUDY_* assignment exists (#3972)', { timeout: 15000 }, () => {
    const f = createCutoverFixture();
    writeFileSync(
      join(f.deployDir, '.env'),
      [
        'COMPOSE_FILE=docker-compose.yml:compose.pilot.yml:compose.host.yml',
        'CROVE_DOMAIN=api.example.com',
        'DATABASE_URL=postgres://crove_app:pw@db:5432/postgres',
        'LUDY_MODULES=',
        'CROVE_MODULES=kernel',
        'CROVE_APP_DB_PASSWORD=real-pw',
        'LUDY_APP_DB_PASSWORD="" # unset placeholder',
        "LUDY_CONTEXT_TOKEN_KEY='' # unset",
        'CROVE_CONTEXT_TOKEN_KEY=real-key',
        'LUDY_REPORTER_DB_PASSWORD=#abc',
        'CROVE_REPORTER_DB_PASSWORD=old-pw',
        'LUDY_DIR=/custom/ludy',
        'CROVE_DIR=/stale/crove',
        '',
      ].join('\n'),
    );
    const res = runWithStubs(f, ['cutover-stack', '--dir', f.deployDir, '--overlay-dir', f.overlayDir]);
    expect(res.status, res.stderr + res.stdout).toBe(0);
    const updatedEnv = readFileSync(join(f.deployDir, '.env'), 'utf8');
    expect(updatedEnv).toContain('LUDY_MODULES=kernel');
    expect(updatedEnv).not.toMatch(/^LUDY_MODULES=$/m);
    expect(updatedEnv).not.toContain('CROVE_MODULES=');
    expect(updatedEnv).toContain('LUDY_APP_DB_PASSWORD=real-pw');
    expect(updatedEnv).not.toContain('CROVE_APP_DB_PASSWORD=');
    expect(updatedEnv).toContain('LUDY_CONTEXT_TOKEN_KEY=real-key');
    expect(updatedEnv).not.toContain('CROVE_CONTEXT_TOKEN_KEY=');
    expect(updatedEnv).toContain('LUDY_REPORTER_DB_PASSWORD=#abc');
    expect(updatedEnv).not.toContain('CROVE_REPORTER_DB_PASSWORD=');
    expect(updatedEnv).toContain('LUDY_DIR=/custom/ludy');
    expect(updatedEnv).not.toContain('CROVE_DIR=');
    expect(readFileSync(join(f.deployDir, '.deploy', 'mounts'), 'utf8')).toContain('/var/lib/postgresql/data=volume:ludy_db-data');
  });

  it('cutover-stack captures live db WAL configuration over .env defaults and aborts before stopping if unreadable (#3972)', { timeout: 15000 }, () => {
    const f = createCutoverFixture();
    writeFileSync(join(f.deployDir, 'compose.wal.yml'), 'services:\n  db:\n    image: ${WAL_DB_IMAGE:-ludy-db:local}\n');
    const res = runWithStubs(f, ['cutover-stack', '--dir', f.deployDir, '--overlay-dir', f.overlayDir], {
      STUB_DB_IMAGE: 'custom-pg:17',
      STUB_PRE_WAL_STANZA: 'custom_stanza',
      STUB_PRE_WAL_REPO1_PATH: '/pilot/finance/wal/',
    });
    expect(res.status, res.stderr + res.stdout).toBe(0);
    const updatedEnv = readFileSync(join(f.deployDir, '.env'), 'utf8');
    expect(updatedEnv).toContain('WAL_DB_IMAGE=custom-pg:17');
    expect(updatedEnv).toContain('WAL_STANZA=custom_stanza');
    expect(updatedEnv).toContain('BACKUP_S3_PREFIX=pilot/finance');
    expect(readFileSync(join(f.deployDir, '.deploy', 'project'), 'utf8').trim()).toBe('ludy');

    const fBad = createCutoverFixture();
    writeFileSync(join(fBad.deployDir, 'compose.wal.yml'), 'services:\n  db:\n    image: ${WAL_DB_IMAGE:-ludy-db:local}\n');
    const failRes = runWithStubs(fBad, ['cutover-stack', '--dir', fBad.deployDir, '--overlay-dir', fBad.overlayDir], {
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
    expect(walStubLog).toContain('wal.sh check WAL_STANZA=ludy');
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

    // Custom PGDATA subdirectory in live db container is forwarded as PG_SUBDIR when probing volumes.
    writeFileSync(f.volsFile, ['crove_db-data', 'ludy_db-data', ''].join('\n'));
    writeFileSync(f.stubLog, '');
    const customPgdata = runWithStubs(f, ['prune-old-volumes', '--dir', f.deployDir, '--overlay-dir', f.overlayDir], {
      STUB_SERVICES: 'db migrate auth auth-grants ludy-extract ludy-media ludy',
      STUB_CLUSTER_IDS: 'crove_db-data=cluster-1 ludy_db-data=cluster-1',
      STUB_LIVE_PGDATA: '/var/lib/postgresql/data/pgdata',
      STUB_EXPECT_PG_SUBDIR: 'pgdata',
    });
    expect(customPgdata.status, customPgdata.stderr).toBe(0);
    expect(readFileSync(f.stubLog, 'utf8')).toContain('probe PG_SUBDIR=pgdata');
    expect(readFileSync(f.volsFile, 'utf8')).not.toContain('crove_');

    const cutoverScript = readFileSync(script, 'utf8');
    expect(cutoverScript).toContain('--exclude-table-data=ludy_kernel.context_key --exclude-table-data=crove_kernel.context_key');
  });

  it('evaluates interpolated LUDY_* / CROVE_* env expressions safely and persists real inspected mounts during cutover-stack (#3972 Round 10)', { timeout: 15000 }, () => {
    const work = mkdtempSync(join(tmpdir(), 'ludy-cutover-interp-'));
    tempDirs.push(work);

    // 1) Empty-expanding LUDY_MODULES=${OPTIONAL_MODULES:-} (unset) yields to CROVE_MODULES=finance.
    const emptyExprIn = join(work, '.env.empty-expr.in');
    const emptyExprOut = join(work, '.env.empty-expr.out');
    writeFileSync(emptyExprIn, 'CROVE_MODULES=finance\nLUDY_MODULES=${OPTIONAL_MODULES:-}\nCROVE_DOMAIN=app.example.com\n');
    const rEmpty = spawnSync('bash', [scriptPath, 'rewrite-env', emptyExprIn, emptyExprOut], { encoding: 'utf8' });
    expect(rEmpty.status, rEmpty.stderr).toBe(0);
    const outEmpty = readFileSync(emptyExprOut, 'utf8');
    expect(outEmpty).toContain('LUDY_MODULES=finance');
    expect(outEmpty).not.toContain('${OPTIONAL_MODULES:-}');
    expect(outEmpty).not.toContain('CROVE_MODULES=');

    // 2) Populated OPTIONAL_MODULES=crm above makes LUDY_MODULES=${OPTIONAL_MODULES:-} effective (`crm`), dropping CROVE_MODULES=finance.
    const setExprIn = join(work, '.env.set-expr.in');
    const setExprOut = join(work, '.env.set-expr.out');
    writeFileSync(setExprIn, 'OPTIONAL_MODULES=crm\nCROVE_MODULES=finance\nLUDY_MODULES=${OPTIONAL_MODULES:-}\n');
    const rSet = spawnSync('bash', [scriptPath, 'rewrite-env', setExprIn, setExprOut], { encoding: 'utf8' });
    expect(rSet.status, rSet.stderr).toBe(0);
    const outSet = readFileSync(setExprOut, 'utf8');
    expect(outSet).toContain('LUDY_MODULES=${OPTIONAL_MODULES:-}');
    expect(outSet).not.toContain('CROVE_MODULES=');

    // 3) Cross-reference `LUDY_APP_DB_PASSWORD=${CROVE_APP_DB_PASSWORD}` or `PUBLIC_URL=https://${CROVE_DOMAIN}` fails closed without leaking secrets.
    const refSecretIn = join(work, '.env.ref-secret.in');
    const refSecretOut = join(work, '.env.ref-secret.out');
    writeFileSync(refSecretIn, 'CROVE_APP_DB_PASSWORD=top-secret-pw\nLUDY_APP_DB_PASSWORD=${CROVE_APP_DB_PASSWORD}\n');
    const rRefSecret = spawnSync('bash', [scriptPath, 'rewrite-env', refSecretIn, refSecretOut], { encoding: 'utf8' });
    expect(rRefSecret.status).not.toBe(0);
    expect(rRefSecret.stderr).toContain('LUDY_APP_DB_PASSWORD');
    expect(`${rRefSecret.stdout}${rRefSecret.stderr}`).not.toContain('top-secret-pw');

    const refDomainIn = join(work, '.env.ref-domain.in');
    const refDomainOut = join(work, '.env.ref-domain.out');
    writeFileSync(refDomainIn, 'CROVE_DOMAIN=app.example.com\nPUBLIC_URL=https://${CROVE_DOMAIN}\n');
    const rRefDomain = spawnSync('bash', [scriptPath, 'rewrite-env', refDomainIn, refDomainOut], { encoding: 'utf8' });
    expect(rRefDomain.status).not.toBe(0);
    expect(rRefDomain.stderr).toContain('PUBLIC_URL');

    // 4) cutover-stack records actual inspected container bind/volume mounts + live PGDATA_SUB instead of guessing from volume names.
    const f = createCutoverFixture();
    writeFileSync(f.volsFile, ['crove_db-data', 'crove_files', ''].join('\n'));
    writeFileSync(f.populatedFile, ['crove_db-data', 'crove_files', ''].join('\n'));
    const cutBind = runWithStubs(f, ['cutover-stack', '--dir', f.deployDir, '--overlay-dir', f.overlayDir], {
      STUB_LIVE_PGDATA: '/var/lib/postgresql/data/pgdata',
      STUB_CONTAINER_MOUNTS: [
        'stub-db-cid|/var/lib/postgresql/data|volume|ludy_db-data|',
        'stub-api-cid|/data/files|bind||/srv/customer-files',
        'stub-api-cid|/data/keys|volume|custom_keys|',
        'stub-worker-cid|/data/archive|volume|ludy_archive|',
      ].join(' '),
    });
    expect(cutBind.status, cutBind.stderr).toBe(0);
    const mountsSaved = readFileSync(join(f.deployDir, '.deploy', 'mounts'), 'utf8');
    expect(mountsSaved).toContain('/var/lib/postgresql/data=volume:ludy_db-data');
    expect(mountsSaved).toContain('/data/files=bind:/srv/customer-files');
    expect(mountsSaved).not.toContain('/data/files=volume:ludy_files');
    expect(mountsSaved).toContain('/data/keys=volume:custom_keys');
    expect(mountsSaved).toContain('PGDATA_SUB=pgdata');

    // 5) Ephemeral caller OS env over empty .env fallback MUST fail closed so a subsequent clean `docker compose up` does not lose passwords; persisted .env indirection and `= #new` pass (#3972 Round 15).
    const osEnvIn = join(work, '.env.os-prec.in');
    const osEnvOut = join(work, '.env.os-prec.out');
    writeFileSync(
      osEnvIn,
      ['ALT=', 'CROVE_APP_DB_PASSWORD=old-pw', 'LUDY_APP_DB_PASSWORD=${ALT}', 'CROVE_WORKER_DB_PASSWORD=old-worker', 'LUDY_WORKER_DB_PASSWORD= #new-password', ''].join('\n'),
    );
    const rOsOnly = spawnSync('bash', [scriptPath, 'rewrite-env', osEnvIn, osEnvOut], { encoding: 'utf8', env: { ...process.env, ALT: 'live' } });
    expect(rOsOnly.status).not.toBe(0);
    expect(rOsOnly.stderr).toContain('LUDY_APP_DB_PASSWORD');
    expect(rOsOnly.stderr).toContain('active shell environment');
    expect(`${rOsOnly.stdout}${rOsOnly.stderr}`).not.toContain('old-pw');

    const persistedEnvIn = join(work, '.env.persisted.in');
    const persistedEnvOut = join(work, '.env.persisted.out');
    writeFileSync(
      persistedEnvIn,
      ['ALT=persisted-pw', 'CROVE_APP_DB_PASSWORD=old-pw', 'LUDY_APP_DB_PASSWORD=${ALT}', 'CROVE_WORKER_DB_PASSWORD=old-worker', 'LUDY_WORKER_DB_PASSWORD= #new-password', ''].join('\n'),
    );
    const rPersisted = spawnSync('bash', [scriptPath, 'rewrite-env', persistedEnvIn, persistedEnvOut], { encoding: 'utf8', env: { ...process.env, ALT: 'live' } });
    expect(rPersisted.status, rPersisted.stderr).toBe(0);
    const outPersisted = readFileSync(persistedEnvOut, 'utf8');
    expect(outPersisted).toContain('ALT=persisted-pw');
    expect(outPersisted).toContain('LUDY_APP_DB_PASSWORD=${ALT}');
    expect(outPersisted).not.toContain('CROVE_APP_DB_PASSWORD=');
    expect(outPersisted).toContain('LUDY_WORKER_DB_PASSWORD= #new-password');
    expect(outPersisted).not.toContain('CROVE_WORKER_DB_PASSWORD=');

    const rEmptyOverride = spawnSync('bash', [scriptPath, 'rewrite-env', persistedEnvIn, persistedEnvOut], { encoding: 'utf8', env: { ...process.env, ALT: '' } });
    expect(rEmptyOverride.status).not.toBe(0);
    expect(rEmptyOverride.stderr).toContain('LUDY_APP_DB_PASSWORD');

    // 6) cutover-stack on source checkout still named `crove` captures `stub-crove-cid` mounts into .deploy/mounts (#3972 Round 11).
    const fCroveSvc = createCutoverFixture();
    const resCroveSvc = runWithStubs(fCroveSvc, ['cutover-stack', '--dir', fCroveSvc.deployDir, '--overlay-dir', fCroveSvc.overlayDir], {
      STUB_SERVICES: 'db migrate auth auth-grants crove',
    });
    expect(resCroveSvc.status, resCroveSvc.stderr).toBe(0);
    const croveSvcMounts = readFileSync(join(fCroveSvc.deployDir, '.deploy', 'mounts'), 'utf8');
    expect(croveSvcMounts).toContain('/data/files=volume:ludy_files');
    expect(croveSvcMounts).toContain('/data/keys=volume:ludy_keys');
    expect(croveSvcMounts).toContain('/data/archive=volume:ludy_archive');

    // 7) Unclosed quote mid-file (followed by valid lines) and empty -> non-empty drift fail closed even under Bash `||` set -e suppression (#3972 Round 13).
    const unclosedIn = join(work, '.env.unclosed.in');
    const unclosedOut = join(work, '.env.unclosed.out');
    writeFileSync(unclosedIn, 'BAD="unclosed\nOK_AFTER=still-valid\n');
    const rUnclosed = spawnSync('bash', [scriptPath, 'rewrite-env', unclosedIn, unclosedOut], { encoding: 'utf8' });
    expect(rUnclosed.status).not.toBe(0);
    expect(rUnclosed.stderr).toContain('unclosed double quote');

    const emptyToNonEmptyIn = join(work, '.env.empty-to-nonempty.in');
    const emptyToNonEmptyOut = join(work, '.env.empty-to-nonempty.out');
    writeFileSync(emptyToNonEmptyIn, 'CROVE_DOMAIN=app.example.test\nLUDY_MODULES=${LUDY_DOMAIN:+social}\n');
    const rDrift = spawnSync('bash', [scriptPath, 'rewrite-env', emptyToNonEmptyIn, emptyToNonEmptyOut], { encoding: 'utf8' });
    expect(rDrift.status).not.toBe(0);
    expect(rDrift.stderr).toContain('LUDY_MODULES');

    // 8) Single-quoted escaped apostrophes match Compose dotenv semantics (#3972 Round 14).
    const sqOkIn = join(work, '.env.sq-ok.in');
    const sqOkOut = join(work, '.env.sq-ok.out');
    writeFileSync(sqOkIn, "LABEL='org\\'s key'\nESCAPED='a\\\\b'\nMIXED='a\\\\\\'b'\nTRAILING='end\\\\'\nCROVE_DOMAIN=app.example.test\n");
    const rSqOk = spawnSync('bash', [scriptPath, 'rewrite-env', sqOkIn, sqOkOut], { encoding: 'utf8' });
    expect(rSqOk.status, rSqOk.stderr).toBe(0);
    const outSq = readFileSync(sqOkOut, 'utf8');
    expect(outSq).toContain("LABEL='org\\'s key'");
    expect(outSq).toContain('LUDY_DOMAIN=app.example.test');

    const sqBadIn = join(work, '.env.sq-bad.in');
    const sqBadOut = join(work, '.env.sq-bad.out');
    writeFileSync(sqBadIn, "BROKEN='end\\'\n");
    const rSqBad = spawnSync('bash', [scriptPath, 'rewrite-env', sqBadIn, sqBadOut], { encoding: 'utf8' });
    expect(rSqBad.status).not.toBe(0);
    expect(rSqBad.stderr).toContain('unclosed single quote');

    // 9) cutover-stack honors full COMPOSE_FILE entries in order and resolves effective BACKUP_S3_PREFIX (#3972 Round 14).
    const fCustom = createCutoverFixture();
    writeFileSync(join(fCustom.deployDir, 'storage.yml'), 'services:\n  api:\n    volumes:\n      - /srv/files:/data/files\n');
    writeFileSync(
      join(fCustom.deployDir, '.env'),
      [
        'COMPOSE_FILE=docker-compose.yml:storage.yml:compose.host.yml',
        'CROVE_DOMAIN=api.example.com',
        'DATABASE_URL=postgres://crove_app:pw@db:5432/postgres',
        'BACKUP_S3_PREFIX=${SITE_PREFIX:-}',
        '',
      ].join('\n'),
    );
    const resCustom = runWithStubs(fCustom, ['cutover-stack', '--dir', fCustom.deployDir, '--overlay-dir', fCustom.overlayDir]);
    expect(resCustom.status, resCustom.stderr).toBe(0);
    const filesLog = readFileSync(`${fCustom.stubLog}.files`, 'utf8');
    expect(filesLog).toContain(`${fCustom.deployDir}/docker-compose.yml ${fCustom.deployDir}/storage.yml ${fCustom.deployDir}/compose.host.yml`);
    const customEnvOut = readFileSync(join(fCustom.deployDir, '.env'), 'utf8');
    expect(customEnvOut).toContain('BACKUP_S3_PREFIX=${SITE_PREFIX:-crove}');
    expect(customEnvOut).not.toContain('BACKUP_S3_PREFIX=crove');

    const fMissingCustom = createCutoverFixture();
    writeFileSync(
      join(fMissingCustom.deployDir, '.env'),
      'COMPOSE_FILE=docker-compose.yml:missing-storage.yml:compose.host.yml\nCROVE_DOMAIN=api.example.com\nDATABASE_URL=postgres://crove_app:pw@db:5432/postgres\n',
    );
    const resMissingCustom = runWithStubs(fMissingCustom, ['cutover-stack', '--dir', fMissingCustom.deployDir, '--overlay-dir', fMissingCustom.overlayDir]);
    expect(resMissingCustom.status).toBe(2);
    expect(resMissingCustom.stderr).toContain('missing-storage.yml');
    expect(readFileSync(fMissingCustom.stubLog, 'utf8')).not.toContain(' stop');

    // 10) cutover-stack refuses changing bind/non-prefixed/live storage mounts before stopping containers, and detects interpolated COMPOSE_FILE with COMPOSE_PATH_SEPARATOR (#3972 Round 15).
    const fBindShift = createCutoverFixture();
    const bindShiftRes = runWithStubs(fBindShift, ['cutover-stack', '--dir', fBindShift.deployDir, '--overlay-dir', fBindShift.overlayDir], {
      STUB_CONFIG_YAML: [
        'name: {proj}',
        'services:',
        '  db:',
        '    volumes:',
        '      - type: volume',
        '        source: db-data',
        '        target: /var/lib/postgresql/data',
        '  api:',
        '    volumes:',
        '      - type: bind',
        '        source: /srv/{proj}/files',
        '        target: /data/files',
        'volumes:',
        '  db-data:',
        '    name: {proj}_db-data',
        '',
      ].join('\n'),
    });
    expect(bindShiftRes.status).toBe(1);
    expect(bindShiftRes.stderr).toContain('cannot automatically migrate /data/files mount on service api');
    expect(bindShiftRes.stderr).toContain('bind:/srv/crove/files');
    expect(bindShiftRes.stderr).toContain('bind:/srv/ludy/files');
    expect(readFileSync(fBindShift.stubLog, 'utf8')).not.toContain(' stop');
    expect(readFileSync(fBindShift.stubLog, 'utf8')).not.toContain('pg_dump');

    const fNamedShift = createCutoverFixture();
    const namedShiftRes = runWithStubs(fNamedShift, ['cutover-stack', '--dir', fNamedShift.deployDir, '--overlay-dir', fNamedShift.overlayDir], {
      STUB_CONFIG_YAML: [
        'name: {proj}',
        'services:',
        '  db:',
        '    volumes:',
        '      - type: volume',
        '        source: db-data',
        '        target: /var/lib/postgresql/data',
        '  api:',
        '    volumes:',
        '      - type: volume',
        '        source: custom_files',
        '        target: /data/files',
        'volumes:',
        '  db-data:',
        '    name: {proj}_db-data',
        '  custom_files:',
        '    name: data_{proj}_files',
        '',
      ].join('\n'),
    });
    expect(namedShiftRes.status).toBe(1);
    expect(namedShiftRes.stderr).toContain('volume:data_crove_files');
    expect(namedShiftRes.stderr).toContain('volume:data_ludy_files');
    expect(readFileSync(fNamedShift.stubLog, 'utf8')).not.toContain(' stop');

    const fLiveMismatch = createCutoverFixture();
    const liveMismatchRes = runWithStubs(fLiveMismatch, ['cutover-stack', '--dir', fLiveMismatch.deployDir, '--overlay-dir', fLiveMismatch.overlayDir], {
      STUB_CONFIG_YAML: [
        'name: {proj}',
        'services:',
        '  db:',
        '    volumes:',
        '      - type: volume',
        '        source: db-data',
        '        target: /var/lib/postgresql/data',
        '  api:',
        '    volumes:',
        '      - type: volume',
        '        source: files',
        '        target: /data/files',
        'volumes:',
        '  db-data:',
        '    name: {proj}_db-data',
        '  files:',
        '    name: {proj}_files',
        '',
      ].join('\n'),
      STUB_CONTAINER_MOUNTS: 'stub-crove-db-cid|/var/lib/postgresql/data|volume|crove_db-data| stub-crove-api-cid|/data/files|bind||/srv/live-only-files',
    });
    expect(liveMismatchRes.status).toBe(1);
    expect(liveMismatchRes.stderr).toContain('bind:/srv/live-only-files');
    expect(liveMismatchRes.stderr).toContain('volume:ludy_files');
    expect(readFileSync(fLiveMismatch.stubLog, 'utf8')).not.toContain(' stop');

    const fSepWal = createCutoverFixture();
    mkdirSync(join(fSepWal.deployDir, 'tools/backup'), { recursive: true });
    writeFileSync(join(fSepWal.deployDir, 'tools/backup/compose.wal.yml'), 'services:\n  db:\n    image: ${WAL_DB_IMAGE:-ludy-db:local}\n');
    writeFileSync(
      join(fSepWal.deployDir, '.env'),
      [
        'WAL_OVERLAY=tools/backup/compose.wal.yml',
        'COMPOSE_PATH_SEPARATOR=;',
        'COMPOSE_FILE=docker-compose.yml;compose.pilot.yml;compose.host.yml;${WAL_OVERLAY}',
        'CROVE_DOMAIN=api.example.com',
        'DATABASE_URL=postgres://crove_app:pw@db:5432/postgres',
        '',
      ].join('\n'),
    );
    const resSepWal = runWithStubs(fSepWal, ['cutover-stack', '--dir', fSepWal.deployDir, '--overlay-dir', fSepWal.overlayDir]);
    expect(resSepWal.status, resSepWal.stderr).toBe(0);
    expect(readFileSync(`${fSepWal.stubLog}.files`, 'utf8')).toContain(`${fSepWal.deployDir}/tools/backup/compose.wal.yml`);
    const sepWalEnv = readFileSync(join(fSepWal.deployDir, '.env'), 'utf8');
    expect(sepWalEnv).toContain('WAL_DB_IMAGE=crove-db:local');
    expect(sepWalEnv).toContain('WAL_STANZA=crove');
    const pruneSepBlocked = runWithStubs(fSepWal, ['prune-old-volumes', '--dir', fSepWal.deployDir, '--overlay-dir', fSepWal.overlayDir]);
    expect(pruneSepBlocked.status).toBe(1);
    expect(pruneSepBlocked.stderr).toContain('WAL_STANZA must be ludy');

    // 11) Round 16 hardening regressions: PGDATA drift, cluster ID mismatch, caller CROVE_* env conflicts,
    // HostConfig.Mounts subpath on live container, WAL vs nightly S3 prefix conflict, and static vs dynamic BACKUP_S3_PREFIX (#3972 Round 16).
    const fPgdataShift = createCutoverFixture();
    const pgdataShiftRes = runWithStubs(fPgdataShift, ['cutover-stack', '--dir', fPgdataShift.deployDir, '--overlay-dir', fPgdataShift.overlayDir], {
      STUB_LIVE_PGDATA: '/var/lib/postgresql/data/crove',
      STUB_CONFIG_YAML: [
        'name: {proj}',
        'services:',
        '  db:',
        '    environment:',
        '      PGDATA: /var/lib/postgresql/data/{proj}',
        '    volumes:',
        '      - type: volume',
        '        source: db-data',
        '        target: /var/lib/postgresql/data',
        '  api:',
        '    volumes:',
        '      - type: volume',
        '        source: files',
        '        target: /data/files',
        'volumes:',
        '  db-data:',
        '    name: {proj}_db-data',
        '  files:',
        '    name: {proj}_files',
        '',
      ].join('\n'),
    });
    expect(pgdataShiftRes.status).toBe(1);
    expect(pgdataShiftRes.stderr).toContain('cannot switch db PGDATA');
    expect(pgdataShiftRes.stderr).toContain('/var/lib/postgresql/data/crove');
    expect(pgdataShiftRes.stderr).toContain('/var/lib/postgresql/data/ludy');
    expect(readFileSync(fPgdataShift.stubLog, 'utf8')).not.toContain(' stop');
    expect(readFileSync(fPgdataShift.stubLog, 'utf8')).not.toContain('pg_dump');

    const fClusterMismatch = createCutoverFixture();
    const clusterMismatchRes = runWithStubs(fClusterMismatch, ['cutover-stack', '--dir', fClusterMismatch.deployDir, '--overlay-dir', fClusterMismatch.overlayDir], {
      STUB_PRE_CLUSTER_ID: '7400000000000000111',
      STUB_POST_CLUSTER_ID: '7400000000000000222',
    });
    expect(clusterMismatchRes.status).toBe(1);
    expect(clusterMismatchRes.stderr).toContain('system_identifier');
    expect(clusterMismatchRes.stderr).toContain('does not match pre-cutover crove cluster');
    const clusterMismatchLog = readFileSync(fClusterMismatch.stubLog, 'utf8');
    expect(clusterMismatchLog).toContain('dc ludy stop db');
    expect(clusterMismatchLog).not.toContain('dc ludy run --rm --no-TTY --no-deps migrate');
    expect(clusterMismatchLog).not.toContain('dc ludy run --rm --no-TTY --no-deps auth-grants');
    expect(clusterMismatchLog).not.toContain('dc ludy up -d --no-build --no-deps --wait --wait-timeout 60 worker');
    expect(clusterMismatchLog).not.toContain('caddy');

    const conflictIn = join(work, '.env.shell-conflict.in');
    const conflictOut = join(work, '.env.shell-conflict.out');
    writeFileSync(conflictIn, 'CROVE_APP_DB_PASSWORD=file-secret\nCROVE_DOMAIN=app.example.com\n');
    const rShellConflict = spawnSync('bash', [scriptPath, 'rewrite-env', conflictIn, conflictOut], {
      encoding: 'utf8',
      env: { ...process.env, CROVE_APP_DB_PASSWORD: 'shell-secret' },
    });
    expect(rShellConflict.status).not.toBe(0);
    expect(rShellConflict.stderr).toContain('LUDY_APP_DB_PASSWORD');
    expect(rShellConflict.stderr).toContain('active shell environment');
    expect(`${rShellConflict.stdout}${rShellConflict.stderr}`).not.toContain('file-secret');
    expect(`${rShellConflict.stdout}${rShellConflict.stderr}`).not.toContain('shell-secret');

    const fLiveSubpath = createCutoverFixture();
    const liveSubpathRes = runWithStubs(fLiveSubpath, ['cutover-stack', '--dir', fLiveSubpath.deployDir, '--overlay-dir', fLiveSubpath.overlayDir], {
      STUB_HOSTCONFIG_MOUNTS:
        'stub-crove-api-cid|[{"Type":"volume","Source":"crove_files","Target":"/data/files","VolumeOptions":{"Subpath":"tenant1"}}]',
    });
    expect(liveSubpathRes.status).toBe(1);
    expect(liveSubpathRes.stderr).toContain('unsupported volume subpath crove_files:tenant1 at /data/files');
    expect(readFileSync(fLiveSubpath.stubLog, 'utf8')).not.toContain(' stop');

    const fS3Conflict = createCutoverFixture();
    writeFileSync(join(fS3Conflict.deployDir, 'compose.wal.yml'), 'services:\n  db:\n    image: ${WAL_DB_IMAGE:-ludy-db:local}\n');
    writeFileSync(
      join(fS3Conflict.deployDir, '.env'),
      [
        'COMPOSE_FILE=docker-compose.yml:compose.pilot.yml:compose.host.yml',
        'CROVE_DOMAIN=api.example.com',
        'DATABASE_URL=postgres://crove_app:pw@db:5432/postgres',
        'BACKUP_S3_PREFIX=nightly-new',
        '',
      ].join('\n'),
    );
    const s3ConflictRes = runWithStubs(fS3Conflict, ['cutover-stack', '--dir', fS3Conflict.deployDir, '--overlay-dir', fS3Conflict.overlayDir], {
      STUB_PRE_WAL_REPO1_PATH: '/crove/wal',
    });
    expect(s3ConflictRes.status).toBe(1);
    expect(s3ConflictRes.stderr).toContain('refusing cutover-stack');
    expect(s3ConflictRes.stderr).toContain("BACKUP_S3_PREFIX='nightly-new'");
    expect(s3ConflictRes.stderr).toContain('/crove/wal');
    expect(readFileSync(fS3Conflict.stubLog, 'utf8')).not.toContain(' stop');

    const fStaticEmptyS3 = createCutoverFixture();
    writeFileSync(
      join(fStaticEmptyS3.deployDir, '.env'),
      [
        'COMPOSE_FILE=docker-compose.yml:compose.pilot.yml:compose.host.yml',
        'CROVE_DOMAIN=api.example.com',
        'DATABASE_URL=postgres://crove_app:pw@db:5432/postgres',
        'BACKUP_S3_PREFIX="" # static empty',
        '',
      ].join('\n'),
    );
    const resStaticEmpty = runWithStubs(fStaticEmptyS3, ['cutover-stack', '--dir', fStaticEmptyS3.deployDir, '--overlay-dir', fStaticEmptyS3.overlayDir]);
    expect(resStaticEmpty.status, resStaticEmpty.stderr).toBe(0);
    expect(readFileSync(join(fStaticEmptyS3.deployDir, '.env'), 'utf8')).toContain('BACKUP_S3_PREFIX=crove # static empty');

    // 12) Round 17 hardening regressions (#3972 Round 17):
    // 12a) Caller shell BACKUP_S3_PREFIX / WAL_STANZA override is caught before stopping services in WAL mode.
    const fWalEnvOverride = createCutoverFixture();
    writeFileSync(join(fWalEnvOverride.deployDir, 'compose.wal.yml'), 'services:\n  db:\n    image: ${WAL_DB_IMAGE:-ludy-db:local}\n');
    const walEnvRes = runWithStubs(fWalEnvOverride, ['cutover-stack', '--dir', fWalEnvOverride.deployDir, '--overlay-dir', fWalEnvOverride.overlayDir], {
      BACKUP_S3_PREFIX: 'other',
      STUB_PRE_WAL_REPO1_PATH: '/crove/wal',
    });
    expect(walEnvRes.status).toBe(1);
    expect(walEnvRes.stderr).toContain("BACKUP_S3_PREFIX='other'");
    expect(readFileSync(fWalEnvOverride.stubLog, 'utf8')).not.toContain(' stop');

    const fWalEmptyExport = createCutoverFixture();
    writeFileSync(join(fWalEmptyExport.deployDir, 'compose.wal.yml'), 'services:\n  db:\n    image: ${WAL_DB_IMAGE:-ludy-db:local}\n');
    writeFileSync(
      join(fWalEmptyExport.deployDir, '.env'),
      'COMPOSE_FILE=docker-compose.yml:compose.pilot.yml:compose.host.yml\nCROVE_DOMAIN=api.example.com\nDATABASE_URL=postgres://crove_app:pw@db:5432/postgres\nBACKUP_S3_PREFIX=crove\n',
    );
    const walEmptyExportRes = runWithStubs(fWalEmptyExport, ['cutover-stack', '--dir', fWalEmptyExport.deployDir, '--overlay-dir', fWalEmptyExport.overlayDir], {
      BACKUP_S3_PREFIX: '',
      STUB_PRE_WAL_REPO1_PATH: '/crove/wal',
    });
    expect(walEmptyExportRes.status).toBe(1);
    expect(walEmptyExportRes.stderr).toContain('active shell environment overrides');
    expect(readFileSync(fWalEmptyExport.stubLog, 'utf8')).not.toContain(' stop');

    // 12b) Stopped worker container with stale /data/files bind mount and failed docker ps query fail closed before stop.
    const fStoppedWorker = createCutoverFixture();
    const stoppedWorkerRes = runWithStubs(fStoppedWorker, ['cutover-stack', '--dir', fStoppedWorker.deployDir, '--overlay-dir', fStoppedWorker.overlayDir], {
      STUB_SERVICE_CIDS: 'crove:db=stub-crove-db-cid crove:worker=stub-stopped-worker-cid crove:api=stub-crove-api-cid',
      STUB_CONTAINER_MOUNTS: 'stub-stopped-worker-cid|/data/files|bind||/srv/stopped-worker-files',
    });
    expect(stoppedWorkerRes.status).toBe(1);
    expect(stoppedWorkerRes.stderr).toContain('bind:/srv/stopped-worker-files');
    expect(readFileSync(fStoppedWorker.stubLog, 'utf8')).not.toContain(' stop');

    const fDockerPsFail = createCutoverFixture();
    const dockerPsFailRes = runWithStubs(fDockerPsFail, ['cutover-stack', '--dir', fDockerPsFail.deployDir, '--overlay-dir', fDockerPsFail.overlayDir], {
      STUB_DOCKER_PS_FAIL: '1',
    });
    expect(dockerPsFailRes.status).toBe(1);
    expect(dockerPsFailRes.stderr).toContain('cannot inspect existing db containers');
    expect(readFileSync(fDockerPsFail.stubLog, 'utf8')).not.toContain(' stop');

    // 12c) Valid multiline quoted OAUTH_JWKS in .env passes rewrite-env and cutover-stack intact.
    const fMultiline = createCutoverFixture();
    const multilineJwks = "OAUTH_JWKS='{\n  \"keys\": [\n    {\"kty\": \"RSA\", \"CROVE_DOMAIN\": \"ignored\"}\n  ]\n}' # jwks\n";
    writeFileSync(
      join(fMultiline.deployDir, '.env'),
      [
        'COMPOSE_FILE=docker-compose.yml:compose.pilot.yml:compose.host.yml',
        `${multilineJwks}CROVE_DOMAIN=api.example.com`,
        'DATABASE_URL=postgres://crove_app:pw@db:5432/postgres',
        '',
      ].join('\n'),
    );
    const resMultiline = runWithStubs(fMultiline, ['cutover-stack', '--dir', fMultiline.deployDir, '--overlay-dir', fMultiline.overlayDir]);
    expect(resMultiline.status, resMultiline.stderr).toBe(0);
    const multilineOut = readFileSync(join(fMultiline.deployDir, '.env'), 'utf8');
    expect(multilineOut).toContain(multilineJwks);
    expect(multilineOut).toContain('LUDY_DOMAIN=api.example.com');

    // 13) Round 18 regressions (#3972 Round 18):
    // 13a) Target PGDATA image default is inspected even when src and dst share db image name and omit PGDATA.
    const fPgdataDefaultDiff = createCutoverFixture();
    const resPgdataImgDefault = runWithStubs(
      fPgdataDefaultDiff,
      ['cutover-stack', '--dir', fPgdataDefaultDiff.deployDir, '--overlay-dir', fPgdataDefaultDiff.overlayDir],
      {
        STUB_LIVE_PGDATA: '/var/lib/postgresql/data/pgdata',
        STUB_IMAGE_PGDATA: 'PGDATA=/var/lib/postgresql/data',
        STUB_CONFIG_YAML: [
          'name: {proj}',
          'services:',
          '  db:',
          '    image: custom-pg:17',
          '    volumes:',
          '      - type: volume',
          '        source: db-data',
          '        target: /var/lib/postgresql/data',
          '  api:',
          '    volumes:',
          '      - type: volume',
          '        source: files',
          '        target: /data/files',
          'volumes:',
          '  db-data:',
          '    name: {proj}_db-data',
          '  files:',
          '    name: {proj}_files',
          '',
        ].join('\n'),
      },
    );
    expect(resPgdataImgDefault.status).toBe(1);
    expect(resPgdataImgDefault.stderr).toContain('cannot switch db PGDATA');
    expect(resPgdataImgDefault.stderr).toContain('/var/lib/postgresql/data/pgdata');
    expect(readFileSync(fPgdataDefaultDiff.stubLog, 'utf8')).not.toContain(' stop');

    // 13b) COMPOSE_FILE with ./compose.host.yml and ./compose.wal.yml substitutes staged overlays in pre-cutover config.
    const fDotSlash = createCutoverFixture();
    writeFileSync(join(fDotSlash.deployDir, 'compose.wal.yml'), 'services:\n  db:\n    image: ${WAL_DB_IMAGE:-ludy-db:local}\n');
    writeFileSync(
      join(fDotSlash.deployDir, '.env'),
      [
        'COMPOSE_FILE=docker-compose.yml:compose.pilot.yml:./compose.host.yml:./compose.wal.yml',
        'CROVE_DOMAIN=api.example.com',
        'DATABASE_URL=postgres://crove_app:pw@db:5432/postgres',
        '',
      ].join('\n'),
    );
    const resDotSlash = runWithStubs(fDotSlash, ['cutover-stack', '--dir', fDotSlash.deployDir, '--overlay-dir', fDotSlash.overlayDir]);
    expect(resDotSlash.status, resDotSlash.stderr).toBe(0);
    const dotSlashFirstLudy = readFileSync(`${fDotSlash.stubLog}.files`, 'utf8')
      .split('\n')
      .find((l) => l.startsWith('dc-files ludy ')) ?? '';
    expect(dotSlashFirstLudy).toContain('/caddy/compose.host.yml');
    expect(dotSlashFirstLudy).toContain('/backup/compose.wal.yml');

    // 13c) Retired internal MEDIA_URL=http://crove-media:8095 is rewritten to ludy-media while external/subdomain hosts stay intact,
    // and active shell/indirect crove-media URLs refuse cleanly before stopping containers.
    const mediaIn = join(work, '.env.media.in');
    const mediaOut = join(work, '.env.media.out');
    writeFileSync(
      mediaIn,
      [
        'CROVE_DOMAIN=api.example.com',
        'MEDIA_URL=http://crove-media:8095 # internal media',
        'EXTRACT_URL="http://crove-extract:8090"',
        '',
      ].join('\n'),
    );
    const mediaRw = spawnSync('bash', [scriptPath, 'rewrite-env', mediaIn, mediaOut], { encoding: 'utf8' });
    expect(mediaRw.status, mediaRw.stderr).toBe(0);
    const mediaOutText = readFileSync(mediaOut, 'utf8');
    expect(mediaOutText).toContain('MEDIA_URL=http://ludy-media:8095 # internal media');
    expect(mediaOutText).toContain('EXTRACT_URL="http://ludy-extract:8090"');

    const mediaExtIn = join(work, '.env.media-ext.in');
    const mediaExtOut = join(work, '.env.media-ext.out');
    writeFileSync(
      mediaExtIn,
      [
        'CROVE_DOMAIN=api.example.com',
        'MEDIA_URL=https://crove-media.example.com:8095/probe',
        '',
      ].join('\n'),
    );
    const mediaExtRw = spawnSync('bash', [scriptPath, 'rewrite-env', mediaExtIn, mediaExtOut], { encoding: 'utf8' });
    expect(mediaExtRw.status, mediaExtRw.stderr).toBe(0);
    expect(readFileSync(mediaExtOut, 'utf8')).toContain('MEDIA_URL=https://crove-media.example.com:8095/probe');

    const fMediaShell = createCutoverFixture();
    const mediaShellRes = runWithStubs(fMediaShell, ['cutover-stack', '--dir', fMediaShell.deployDir, '--overlay-dir', fMediaShell.overlayDir], {
      MEDIA_URL: 'http://crove-media:8095',
    });
    expect(mediaShellRes.status).toBe(1);
    expect(mediaShellRes.stderr).toContain('crove-media');
    expect(readFileSync(fMediaShell.stubLog, 'utf8')).not.toContain(' stop');

    // 14) Round 19 regressions (#3972 Round 19):
    // 14a) Foreign project ownership under target `ludy` (or source `crove`) blocks cutover-stack before stopping services.
    const fForeignLudy = createCutoverFixture();
    const foreignLudyRes = runWithStubs(fForeignLudy, ['cutover-stack', '--dir', fForeignLudy.deployDir, '--overlay-dir', fForeignLudy.overlayDir], {
      STUB_PROJECT_CONTAINERS: 'ludy|other-ludy-db',
      STUB_INSPECT_WORKDIRS: 'other-ludy-db|/opt/other-ludy',
    });
    expect(foreignLudyRes.status).toBe(1);
    expect(foreignLudyRes.stderr).toContain("Compose project 'ludy' is already owned by another installation at /opt/other-ludy");
    expect(readFileSync(fForeignLudy.stubLog, 'utf8')).not.toContain(' stop');

    const fForeignCrove = createCutoverFixture();
    const foreignCroveRes = runWithStubs(fForeignCrove, ['cutover-stack', '--dir', fForeignCrove.deployDir, '--overlay-dir', fForeignCrove.overlayDir], {
      STUB_PROJECT_CONTAINERS: 'crove|other-crove-db',
      STUB_INSPECT_WORKDIRS: 'other-crove-db|/opt/other-crove',
    });
    expect(foreignCroveRes.status).toBe(1);
    expect(foreignCroveRes.stderr).toContain("Compose project 'crove' is already owned by another installation at /opt/other-crove");
    expect(readFileSync(fForeignCrove.stubLog, 'utf8')).not.toContain(' stop');

    // 14b) Effective object storage (STORAGE=s3 + S3_BUCKET) changing from `crove-files` -> `ludy-files` blocks cutover-stack before stopping services;
    // project-independent S3_BUCKET passes cleanly.
    const s3Yaml = [
      'name: {proj}',
      'services:',
      '  db:',
      '    volumes:',
      '      - type: volume',
      '        source: db-data',
      '        target: /var/lib/postgresql/data',
      '  api:',
      '    environment:',
      '      STORAGE: s3',
      '      S3_ENDPOINT: https://s3.example.com',
      '      S3_BUCKET: {bucket}',
      '    volumes:',
      '      - type: volume',
      '        source: files',
      '        target: /data/files',
      '      - type: volume',
      '        source: keys',
      '        target: /data/keys',
      '      - type: volume',
      '        source: archive',
      '        target: /data/archive',
      '  worker:',
      '    environment:',
      '      STORAGE: s3',
      '      S3_ENDPOINT: https://s3.example.com',
      '      S3_BUCKET: {bucket}',
      '    volumes:',
      '      - type: volume',
      '        source: files',
      '        target: /data/files',
      '      - type: volume',
      '        source: keys',
      '        target: /data/keys',
      '      - type: volume',
      '        source: archive',
      '        target: /data/archive',
      'volumes:',
      '  db-data:',
      '    name: {proj}_db-data',
      '  files:',
      '    name: {proj}_files',
      '  keys:',
      '    name: {proj}_keys',
      '  archive:',
      '    name: {proj}_archive',
      '',
    ].join('\n');
    const fS3Drift = createCutoverFixture();
    const s3DriftRes = runWithStubs(fS3Drift, ['cutover-stack', '--dir', fS3Drift.deployDir, '--overlay-dir', fS3Drift.overlayDir], {
      STUB_CONFIG_YAML: s3Yaml.replaceAll('{bucket}', '{proj}-files'),
    });
    expect(s3DriftRes.status).toBe(1);
    expect(s3DriftRes.stderr).toContain('S3_BUCKET');
    expect(s3DriftRes.stderr).toContain('crove-files');
    expect(s3DriftRes.stderr).toContain('ludy-files');
    expect(readFileSync(fS3Drift.stubLog, 'utf8')).not.toContain(' stop');

    const fS3Static = createCutoverFixture();
    const s3StaticRes = runWithStubs(fS3Static, ['cutover-stack', '--dir', fS3Static.deployDir, '--overlay-dir', fS3Static.overlayDir], {
      STUB_CONFIG_YAML: s3Yaml.replaceAll('{bucket}', 'shared-files'),
    });
    expect(s3StaticRes.status, s3StaticRes.stderr).toBe(0);

    // 14c) Customized Caddyfile is refused before stopping services so host routing/access controls are never overwritten.
    const fCustomCaddy = createCutoverFixture();
    writeFileSync(
      join(fCustomCaddy.deployDir, 'Caddyfile'),
      '{ admin off }\n{$CROVE_DOMAIN} {\n  handle /admin* { respond 403 }\n  reverse_proxy 127.0.0.1:8080\n}\n',
    );
    const customCaddyRes = runWithStubs(fCustomCaddy, ['cutover-stack', '--dir', fCustomCaddy.deployDir, '--overlay-dir', fCustomCaddy.overlayDir]);
    expect(customCaddyRes.status).toBe(1);
    expect(customCaddyRes.stderr).toContain('refusing to overwrite customized');
    expect(readFileSync(fCustomCaddy.stubLog, 'utf8')).not.toContain(' stop');
  });
});
