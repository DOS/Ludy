// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
    expect(workflow).toMatch(/inspect \| cutover-stack \| switch-wal[\s\S]*--overlay-dir '\$REMOTE'/);
    expect(workflow).toContain('SMOKE_EXPECT_MODULES=');
    // Avoid stdout-polluting command substitution on wait_local_ready and enforce pipefail during volume copies.
    expect(script).toContain('READY_URL=');
    expect(script).not.toMatch(/\$\(wait_local_ready\b/);
    expect(script).toContain('set -euo pipefail');
    expect(script).toContain('--entrypoint bash "$VOLUME_COPY_IMAGE"');
    // CodeQL Actions safety: never interpolate inputs directly inside run scripts.
    for (const runBlock of workflow.matchAll(/run:\s*\|\n([\s\S]*?)(?=\n\s*(?:- |env:|if:|name:|uses:|with:|$))/g)) {
      expect(runBlock[1]).not.toMatch(/\$\{\{\s*inputs\./);
    }
  });
});
