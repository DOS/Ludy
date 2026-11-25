// SPDX-License-Identifier: AGPL-3.0-only
// The Vercel side of a split deployment (#2261): the app's headers match what the kernel serves with the app, production
// builds only a release, and the workflow that moves the release branch runs on tags of main only.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { contentSecurityPolicy } from '../../apps/kernel/src/http.ts';
import { STATIC_CSP_DIRECTIVES, cspMeta, cspOriginsFromEnv, metaCsp } from '../../apps/app/vite-csp.ts';
import { RELEASE_BRANCH, decide } from '../vercel/ignore-build.mjs';

const root = (path: string) => new URL(`../../${path}`, import.meta.url);
const vercel = JSON.parse(readFileSync(root('apps/app/vercel.json'), 'utf8')) as {
  ignoreCommand: string;
  build?: unknown;
  rewrites: Array<{ source: string; destination: string }>;
  headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
};
const header = (name: string) => vercel.headers[0]?.headers.find((h) => h.key.toLowerCase() === name.toLowerCase())?.value;

describe('apps/app/vercel.json', () => {
  it('names no origin of any deployment: the API address comes from the build environment', () => {
    const text = readFileSync(root('apps/app/vercel.json'), 'utf8');
    expect(text).not.toMatch(/https?:\/\/(?!openapi\.vercel\.sh)/);
    expect(vercel.build).toBeUndefined();
  });

  it('sends the origin-free part of the policy as a header, and the browser headers the kernel sends with the app', () => {
    expect(header('content-security-policy')).toBe(STATIC_CSP_DIRECTIVES.join('; '));
    expect(header('referrer-policy')).toBe('no-referrer');
    expect(header('x-content-type-options')).toBe('nosniff');
    expect(header('x-frame-options')).toBe('DENY');
    expect(header('strict-transport-security')).toMatch(/max-age=\d+/);
  });

  it('serves index.html for every route but the static files', () => {
    const [rule] = vercel.rewrites;
    expect(vercel.rewrites).toHaveLength(1);
    expect(rule?.destination).toBe('/index.html');
    const re = new RegExp(`^${rule?.source}$`);
    for (const path of ['/', '/o/acme/inbox', '/-/review', '/login', '/channels/oauth/meta/callback']) expect(re.test(path), path).toBe(true);
    for (const path of ['/assets/index-abc.js', '/assets/sw.js', '/favicon.svg']) expect(re.test(path), path).toBe(false);
  });

  it('runs the ignore step that keeps Production off plain merges', () => {
    expect(vercel.ignoreCommand).toBe('node ../../tools/vercel/ignore-build.mjs');
  });
});

describe('the build-time policy (apps/app/vite-csp.ts)', () => {
  // The header and the meta tag are both applied by the browser: together they must say what the kernel's one policy says.
  const directives = (policy: string) => policy.split('; ').sort();
  const together = (origins: Parameters<typeof metaCsp>[0]) => directives([...STATIC_CSP_DIRECTIVES, metaCsp(origins)].join('; '));
  const API = 'https://api.example.com';

  it('equals the policy of the kernel for the same origins, with and without Turnstile and a bucket', () => {
    for (const turnstile of [false, true]) {
      for (const storage of [undefined, 'https://files.example.com']) {
        expect(together({ apiOrigin: API, storageOrigin: storage, turnstile }), `${turnstile} ${storage}`).toEqual(
          directives(contentSecurityPolicy(`${API}/auth/v1`, storage ?? null, turnstile, API)),
        );
      }
    }
  });

  // #2704: the hosted login's token endpoint is called by the browser, so its origin is in connect-src of both policies.
  it('allows the origin of the hosted login token endpoint in the kernel and in the build-time policy alike', () => {
    const hosted = 'https://login.example.com';
    expect(together({ apiOrigin: API, hostedLoginOrigin: hosted })).toEqual(directives(contentSecurityPolicy(`${API}/auth/v1`, null, false, API, hosted)));
    expect(together({ apiOrigin: API, storageOrigin: 'https://files.example.com', hostedLoginOrigin: hosted })).toEqual(
      directives(contentSecurityPolicy(`${API}/auth/v1`, 'https://files.example.com', false, API, hosted)),
    );
    expect(contentSecurityPolicy('/auth/v1', null, false, null, hosted)).toContain(`connect-src 'self' http://localhost ${hosted}`);
    expect(cspOriginsFromEnv({ VITE_API_URL: API, VITE_HOSTED_LOGIN_ORIGIN: hosted })?.hostedLoginOrigin).toBe(hosted);
    expect(() => cspOriginsFromEnv({ VITE_API_URL: API, VITE_HOSTED_LOGIN_ORIGIN: 'http://login.example.com' })).toThrow(/must be https/);
  });

  it('lets the app play media from a blob and from the API origin, which default-src would refuse', () => {
    expect(metaCsp({ apiOrigin: API })).toContain(`media-src 'self' blob: ${API}`);
    expect(contentSecurityPolicy('/auth/v1', null)).toContain("media-src 'self' blob:");
    expect(contentSecurityPolicy('/auth/v1', null)).not.toContain('https://');
  });

  it('allows the origin of Supabase Auth when it is not the one of the API', () => {
    const policy = metaCsp({ apiOrigin: API, authOrigin: 'https://auth.example.com' });
    expect(policy).toContain("connect-src 'self' https://auth.example.com https://api.example.com");
    expect(together({ apiOrigin: API, authOrigin: 'https://auth.example.com' })).toEqual(directives(contentSecurityPolicy('https://auth.example.com/auth/v1', null, false, API).replace('https://auth.example.com', 'https://auth.example.com https://api.example.com')));
  });

  it('reads the origins from the build environment, and injects nothing without VITE_API_URL', () => {
    expect(cspOriginsFromEnv({})).toBeNull();
    expect(cspOriginsFromEnv({ VITE_API_URL: ' ' })).toBeNull();
    expect(cspOriginsFromEnv({ VITE_API_URL: `${API}/`, VITE_STORAGE_ORIGIN: 'https://files.example.com/bucket', VITE_TURNSTILE: 'true' })).toEqual({
      apiOrigin: API,
      authOrigin: undefined,
      storageOrigin: 'https://files.example.com',
      turnstile: true,
    });
    const plugin = cspMeta({});
    expect((plugin.transformIndexHtml as () => unknown)()).toBeUndefined();
    const tags = (cspMeta({ VITE_API_URL: API }).transformIndexHtml as () => Array<{ tag: string; attrs: Record<string, string>; injectTo: string }>)();
    expect(tags).toEqual([{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: metaCsp({ apiOrigin: API }) }, injectTo: 'head-prepend' }]);
  });

  it('refuses a build address that is not a URL, or plain http beyond localhost', () => {
    expect(() => cspOriginsFromEnv({ VITE_API_URL: 'api.example.com' })).toThrow(/VITE_API_URL is not a URL/);
    expect(() => cspOriginsFromEnv({ VITE_API_URL: 'http://api.example.com' })).toThrow(/must be https/);
    expect(() => cspOriginsFromEnv({ VITE_API_URL: API, VITE_STORAGE_ORIGIN: 'http://files.example.com' })).toThrow(/VITE_STORAGE_ORIGIN must be https/);
    expect(cspOriginsFromEnv({ VITE_API_URL: 'http://localhost:8080' })?.apiOrigin).toBe('http://localhost:8080');
  });
});

describe('the ignored build step', () => {
  it('builds Production only from the release branch', () => {
    expect(decide({ VERCEL_ENV: 'production', VERCEL_GIT_COMMIT_REF: RELEASE_BRANCH }).build).toBe(true);
    for (const ref of ['main', 'dev', 'claude/some-task', '', undefined]) {
      expect(decide({ VERCEL_ENV: 'production', VERCEL_GIT_COMMIT_REF: ref }).build, String(ref)).toBe(false);
    }
  });

  it('builds previews and does not guess when the environment is unknown', () => {
    expect(decide({ VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'claude/some-task' }).build).toBe(true);
    expect(decide({}).build).toBe(true);
  });
});

describe('.github/workflows/release-branch.yml', () => {
  const workflow = readFileSync(root('.github/workflows/release-branch.yml'), 'utf8').replaceAll('\r\n', '\n');
  const hasBash = spawnSync('bash', ['-c', 'exit 0']).status === 0;
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  function stepBlock(name: string): string {
    const marker = `\n      - name: ${name}\n`;
    const start = workflow.indexOf(marker);
    expect(start, `step ${name} must exist`).toBeGreaterThan(-1);
    const rest = workflow.slice(start + 1);
    const next = rest.slice(1).search(/\n {6}- (?:name|uses): /);
    return next === -1 ? rest : rest.slice(0, next + 1);
  }

  function extractStepRun(name: string): string {
    const block = stepBlock(name);
    const runMarker = '\n        run: |\n';
    const start = block.indexOf(runMarker);
    expect(start, `step ${name} must have run: |`).toBeGreaterThan(-1);
    const lines = block.slice(start + runMarker.length).split('\n');
    const out: string[] = [];
    for (const line of lines) {
      if (line.trim() === '') {
        out.push('');
        continue;
      }
      if (!line.startsWith('          ')) break;
      out.push(line.slice(10));
    }
    return `${out.join('\n')}\n`;
  }

  it('runs by hand only (never on a tag push, so the app cannot go live before its API), from main, for a v* tag', () => {
    expect(workflow).toMatch(/\non:\n {2}workflow_dispatch:\n/);
    expect(workflow).not.toMatch(/\n {2}push:/);
    expect(workflow).toContain("if: github.ref == 'refs/heads/main'");
    expect(workflow).toContain('environment: release');
    expect(workflow).toContain('^v[A-Za-z0-9._-]{1,63}$');
  });

  it('moves the release branch only to a commit of main whose CI is green', () => {
    expect(workflow).toContain('merge-base --is-ancestor "$sha" origin/main');
    expect(workflow).toContain('DEPLOY_REQUIRED_CHECKS');
    expect(workflow).toContain('required check not green');
    const ci = workflow.indexOf('CI is green on the release commit');
    const authCheck = workflow.indexOf('Check release push credentials');
    const mint = workflow.indexOf('Mint release-branch GitHub App token');
    const push = workflow.indexOf('push --force origin "$SHA:refs/heads/release"');
    expect(ci).toBeGreaterThan(0);
    expect(authCheck).toBeGreaterThan(ci);
    expect(mint).toBeGreaterThan(authCheck);
    expect(push).toBeGreaterThan(mint);
  });

  it('gets write access for the one job that needs it, keeps checkout credential-free, and pins all actions by commit SHA', () => {
    expect(workflow).toMatch(/\npermissions:\n {2}contents: read\n/);
    expect(workflow.match(/^ +contents: write$/gm)).toHaveLength(1);
    expect(workflow).toMatch(/^ +checks: read$/m);
    expect(workflow).not.toMatch(/^ +workflows: write$/m);

    expect(workflow).toMatch(/uses: actions\/checkout@[0-9a-f]{40} # v/);
    expect(workflow).toMatch(/uses: actions\/checkout@[0-9a-f]{40} # v[^\n]*\n {8}with:\n {10}persist-credentials: false\n {10}fetch-depth: 0\n/);

    const uses = [...workflow.matchAll(/uses:\s*([^\s]+)/g)].map((m) => m[1]);
    expect(uses.length).toBeGreaterThanOrEqual(2);
    for (const ref of uses) {
      expect(ref).toMatch(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/);
    }

    const lines = workflow.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = /^(\s*)(?:-\s*)?run:\s*(.*)$/.exec(lines[i] ?? '');
      if (!m) continue;
      const baseIndent = m[1]?.length ?? 0;
      const inline = m[2]?.trim() ?? '';
      if (inline && inline !== '|' && inline !== '|-' && inline !== '>' && inline !== '>-') {
        expect(inline, `line ${i + 1} inline run must not contain \${{ }}`).not.toContain('${{');
        continue;
      }
      for (let j = i + 1; j < lines.length; j++) {
        const line = lines[j] ?? '';
        if (line.trim() === '') continue;
        const indent = /^\s*/.exec(line)?.[0]?.length ?? 0;
        if (indent <= baseIndent) break;
        expect(line, `line ${j + 1} inside run: must not contain \${{ }}`).not.toContain('${{');
      }
    }
  });

  it('mints a scoped single-repo GitHub App token only after CI passes and revokes it after the job', () => {
    const mint = stepBlock('Mint release-branch GitHub App token');
    expect(mint).toContain('id: app-token');
    expect(mint).toContain("if: steps.push-auth.outputs.use_app == 'true'");
    expect(mint).toContain('uses: actions/create-github-app-token@f418cff399f7aef4c2f0ad47e25ca7a6abbdd6fc # v3.4.0');
    expect(mint).toContain('client-id: ${{ vars.RELEASE_BRANCH_APP_CLIENT_ID }}');
    expect(mint).toContain('private-key: ${{ secrets.RELEASE_BRANCH_APP_PRIVATE_KEY }}');
    expect(mint).toContain('owner: ${{ github.repository_owner }}');
    expect(mint).toContain('repositories: ${{ github.event.repository.name }}');
    expect(mint).toContain('permission-contents: write');
    expect(mint).toContain('permission-workflows: write');
    expect(mint).toContain('skip-token-revoke: false');
  });

  it('passes git tokens via ephemeral GIT_CONFIG_COUNT extraheader env vars, never CLI args or URLs, with fail-closed push auth', () => {
    const fetchRun = extractStepRun('The tag is a release on main');
    const pushStep = stepBlock('Point release at the tagged commit');
    const pushRun = extractStepRun('Point release at the tagged commit');

    expect(pushStep).toContain('USE_APP: ${{ steps.push-auth.outputs.use_app }}');
    expect(pushStep).toContain('APP_TOKEN: ${{ steps.app-token.outputs.token }}');
    expect(pushStep).toContain("FALLBACK_TOKEN: ${{ steps.push-auth.outputs.use_app != 'true' && github.token || '' }}");
    expect(pushStep).not.toContain('steps.app-token.outputs.token || github.token');
    expect(workflow).toContain('::add-mask::');
    expect(workflow).toContain('mktemp');
    expect(workflow).toContain('^[0-9a-f]{40}$');
    expect(pushRun).toContain('mktemp "$RUNNER_TEMP/release-push.XXXXXX"');
    expect(pushRun).toContain('^[0-9a-f]{40}$');

    for (const script of [fetchRun, pushRun]) {
      expect(script).toContain('::add-mask::');
      expect(script).toContain('GIT_TERMINAL_PROMPT=0');
      expect(script).toContain('GIT_CONFIG_COUNT=2');
      expect(script).toContain('GIT_CONFIG_KEY_0="http.${GITHUB_SERVER_URL}/.extraheader"');
      expect(script).toContain('GIT_CONFIG_VALUE_0=""');
      expect(script).toContain('GIT_CONFIG_KEY_1="http.${GITHUB_SERVER_URL}/.extraheader"');
      expect(script).toContain('GIT_CONFIG_VALUE_1="AUTHORIZATION: basic ${basic_auth}"');
      expect(script).not.toContain('x-access-token:${');
      expect(script).not.toContain('x-access-token:"$');
      expect(script).not.toMatch(/git\b[^\n]*(?:\$GH_TOKEN|\$PUSH_TOKEN)/);
      expect(script).not.toContain('.git/config');
    }
  });

  describe.skipIf(!hasBash)('embedded workflow bash steps', () => {
    it('passes bash syntax check for all run blocks', () => {
      for (const step of ['The tag is a release on main', 'CI is green on the release commit', 'Check release push credentials', 'Point release at the tagged commit']) {
        const res = spawnSync('bash', ['-n', '-c', extractStepRun(step)], { encoding: 'utf8' });
        expect(res.status, `${step}: ${res.stderr}`).toBe(0);
      }
    });

    it('validates RELEASE_BRANCH_APP_* completeness and CLIENT_ID shape before minting', () => {
      const script = extractStepRun('Check release push credentials');
      const runCredCheck = (CLIENT_ID: string, HAS_PRIVATE_KEY: string) => {
        const dir = mkdtempSync(join(tmpdir(), 'ludy-release-auth-'));
        tempDirs.push(dir);
        const outFile = join(dir, 'github_output');
        writeFileSync(outFile, '');
        const res = spawnSync('bash', ['-c', script], {
          encoding: 'utf8',
          env: {
            ...process.env,
            CLIENT_ID,
            HAS_PRIVATE_KEY,
            GITHUB_OUTPUT: outFile,
          },
        });
        return { ...res, output: readFileSync(outFile, 'utf8') };
      };

      const both = runCredCheck('Iv23li_test-App.01', 'true');
      expect(both.status).toBe(0);
      expect(both.output.trim()).toBe('use_app=true');

      const neither = runCredCheck('', 'false');
      expect(neither.status).toBe(0);
      expect(neither.output.trim()).toBe('use_app=false');

      const onlyClientId = runCredCheck('Iv23li_test-App.01', 'false');
      expect(onlyClientId.status).toBe(1);
      expect(onlyClientId.stdout).toContain('RELEASE_BRANCH_APP_CLIENT_ID and RELEASE_BRANCH_APP_PRIVATE_KEY must both be set');
      expect(onlyClientId.output).toBe('');

      const onlyKey = runCredCheck('', 'true');
      expect(onlyKey.status).toBe(1);
      expect(onlyKey.stdout).toContain('RELEASE_BRANCH_APP_CLIENT_ID and RELEASE_BRANCH_APP_PRIVATE_KEY must both be set');
      expect(onlyKey.output).toBe('');

      const badClientId = runCredCheck('bad client id', 'true');
      expect(badClientId.status).toBe(1);
      expect(badClientId.stdout).toContain('::error::RELEASE_BRANCH_APP_CLIENT_ID');
      expect(badClientId.output).toBe('');
    });

    it('authenticates git fetch via ephemeral extraheader when validating a tag on main', () => {
      const script = extractStepRun('The tag is a release on main');
      const dir = mkdtempSync(join(tmpdir(), 'ludy-release-fetch-'));
      tempDirs.push(dir);
      const binDir = join(dir, 'bin');
      const outFile = join(dir, 'github_output');
      const gitLog = join(dir, 'git.log');
      mkdirSync(binDir, { recursive: true });
      writeFileSync(outFile, '');
      writeFileSync(gitLog, '');
      const stubPath = join(binDir, 'git');
      writeFileSync(
        stubPath,
        [
          '#!/usr/bin/env bash',
          'set -euo pipefail',
          `echo "ARGS:$* COUNT:\${GIT_CONFIG_COUNT:-} PROMPT:\${GIT_TERMINAL_PROMPT:-} K0:\${GIT_CONFIG_KEY_0:-} V0:\${GIT_CONFIG_VALUE_0-<unset>} K1:\${GIT_CONFIG_KEY_1:-} V1:\${GIT_CONFIG_VALUE_1:-}" >> "${gitLog}"`,
          'case "${1:-}" in',
          '  fetch) exit 0 ;;',
          '  rev-parse) echo "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; exit 0 ;;',
          '  merge-base) exit 0 ;;',
          '  *) exit 1 ;;',
          'esac',
          '',
        ].join('\n'),
      );
      chmodSync(stubPath, 0o755);

      const token = 'ghs_fetch_token_secret';
      const res = spawnSync('bash', ['-c', script], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
          GITHUB_ACTIONS: 'true',
          GITHUB_OUTPUT: outFile,
          GITHUB_SERVER_URL: 'https://github.com',
          GH_TOKEN: token,
          TAG: 'v0.3.12',
        },
      });
      expect(res.status).toBe(0);
      expect(readFileSync(outFile, 'utf8').trim()).toBe('sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      const expectedBasic = Buffer.from(`x-access-token:${token}`).toString('base64');
      expect(res.stdout).toContain(`::add-mask::${expectedBasic}`);
      const lines = readFileSync(gitLog, 'utf8').trim().split('\n');
      expect(lines[0]).toContain('ARGS:fetch --no-tags origin main refs/tags/v0.3.12:refs/tags/v0.3.12');
      expect(lines[0]).toContain(`COUNT:2 PROMPT:0 K0:http.https://github.com/.extraheader V0: K1:http.https://github.com/.extraheader V1:AUTHORIZATION: basic ${expectedBasic}`);
      expect(lines[0]).not.toContain(token);
    });

    it('fails closed on invalid auth state or SHA, detects backticked or plain workflows permission errors, and masks base64 auth', () => {
      const script = extractStepRun('Point release at the tagged commit');
      type PushStubMode = 'ok' | 'workflows-denied-plain' | 'workflows-denied-backticked' | 'other-denied';
      const setupGitStub = (mode: PushStubMode) => {
        const dir = mkdtempSync(join(tmpdir(), 'ludy-release-push-'));
        tempDirs.push(dir);
        const binDir = join(dir, 'bin');
        const runnerTemp = join(dir, 'runner-temp');
        const summary = join(dir, 'summary.md');
        const gitLog = join(dir, 'git.log');
        mkdirSync(binDir, { recursive: true });
        mkdirSync(runnerTemp, { recursive: true });
        writeFileSync(summary, '');
        writeFileSync(gitLog, '');
        const stubPath = join(binDir, 'git');
        const pushBody =
          mode === 'workflows-denied-plain'
            ? '  echo "! [remote rejected] 2222222 -> release (refusing to allow a GitHub App to create or update workflow .github/workflows/ci.yml without workflows permission)" >&2\n  exit 1'
            : mode === 'workflows-denied-backticked'
              ? "  echo '! [remote rejected] 2222222 -> release (refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml` without `workflows` permission)' >&2\n  exit 1"
              : mode === 'other-denied'
                ? '  echo "! [remote rejected] 2222222 -> release (protected branch hook declined)" >&2\n  exit 1'
                : '  echo "To https://github.com/DOS/Ludy.git" >&2\n  exit 0';
        writeFileSync(
          stubPath,
          [
            '#!/usr/bin/env bash',
            'set -euo pipefail',
            `echo "ARGS:$* COUNT:\${GIT_CONFIG_COUNT:-} PROMPT:\${GIT_TERMINAL_PROMPT:-} K0:\${GIT_CONFIG_KEY_0:-} V0:\${GIT_CONFIG_VALUE_0-<unset>} K1:\${GIT_CONFIG_KEY_1:-} V1:\${GIT_CONFIG_VALUE_1:-}" >> "${gitLog}"`,
            'if [ "${1:-}" = ls-remote ]; then',
            '  echo "1111111111111111111111111111111111111111\trefs/heads/release"',
            '  exit 0',
            'fi',
            'if [ "${1:-}" = push ]; then',
            pushBody,
            'fi',
            'exit 1',
            '',
          ].join('\n'),
        );
        chmodSync(stubPath, 0o755);
        return { dir, binDir, runnerTemp, summary, gitLog };
      };

      const runPush = (
        mode: PushStubMode,
        overrides: Partial<Record<'TAG' | 'SHA' | 'USE_APP' | 'APP_TOKEN' | 'FALLBACK_TOKEN' | 'GITHUB_ACTIONS', string>>,
      ) => {
        const ctx = setupGitStub(mode);
        const res = spawnSync('bash', ['-c', script], {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${ctx.binDir}${delimiter}${process.env.PATH ?? ''}`,
            RUNNER_TEMP: ctx.runnerTemp,
            GITHUB_STEP_SUMMARY: ctx.summary,
            GITHUB_SERVER_URL: 'https://github.com',
            GITHUB_ACTIONS: overrides.GITHUB_ACTIONS ?? 'true',
            TAG: overrides.TAG ?? 'v0.3.11',
            SHA: overrides.SHA ?? '2222222222222222222222222222222222222222',
            USE_APP: overrides.USE_APP ?? 'false',
            APP_TOKEN: overrides.APP_TOKEN ?? '',
            FALLBACK_TOKEN: overrides.FALLBACK_TOKEN ?? '',
          },
        });
        return {
          ...res,
          summary: readFileSync(ctx.summary, 'utf8'),
          gitLog: readFileSync(ctx.gitLog, 'utf8'),
          tempLeftovers: readdirSync(ctx.runnerTemp),
        };
      };

      // Blocking #1: USE_APP=true with empty APP_TOKEN must refuse to fall back to FALLBACK_TOKEN and never call git.
      const emptyAppToken = runPush('ok', {
        USE_APP: 'true',
        APP_TOKEN: '',
        FALLBACK_TOKEN: 'ghs_should_never_be_used',
      });
      expect(emptyAppToken.status).toBe(1);
      expect(emptyAppToken.stdout).toContain('refusing to fall back to GITHUB_TOKEN');
      expect(emptyAppToken.gitLog).toBe('');
      expect(emptyAppToken.tempLeftovers).toEqual([]);

      // Unexpected or empty USE_APP must fail closed before calling git.
      for (const badState of ['', 'maybe']) {
        const badStateRes = runPush('ok', {
          USE_APP: badState,
          APP_TOKEN: 'ghs_unused',
          FALLBACK_TOKEN: 'ghs_unused',
        });
        expect(badStateRes.status).toBe(1);
        expect(badStateRes.stdout).toContain('unexpected push-auth state');
        expect(badStateRes.gitLog).toBe('');
        expect(badStateRes.tempLeftovers).toEqual([]);
      }

      // Invalid $SHA must fail closed before calling git.
      for (const badSha of ['', 'not-a-sha', '2222222', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA']) {
        const badShaRes = runPush('ok', {
          SHA: badSha,
          USE_APP: 'false',
          FALLBACK_TOKEN: 'ghs_test_default_token',
        });
        expect(badShaRes.status).toBe(1);
        expect(badShaRes.stdout).toContain('unexpected release commit SHA');
        expect(badShaRes.gitLog).toBe('');
        expect(badShaRes.tempLeftovers).toEqual([]);
      }

      // Blocking #2: both plain and backticked GitHub rejections emit setup error guidance in github-token mode.
      for (const deniedMode of ['workflows-denied-plain', 'workflows-denied-backticked'] as const) {
        const deniedRes = runPush(deniedMode, {
          USE_APP: 'false',
          FALLBACK_TOKEN: 'ghs_test_default_token',
        });
        expect(deniedRes.status).toBe(1);
        expect(deniedRes.stderr).toContain('permission');
        expect(deniedRes.stdout).toContain('::error::');
        expect(deniedRes.stdout).toContain('RELEASE_BRANCH_APP_CLIENT_ID');
        expect(deniedRes.stdout).toContain('RELEASE_BRANCH_APP_PRIVATE_KEY');
        expect(deniedRes.stdout).toContain('docs/runbooks/split-app-api.md');
        expect(deniedRes.tempLeftovers).toEqual([]);
      }

      // Non-workflows rejection must not emit app setup hint.
      const otherRes = runPush('other-denied', {
        USE_APP: 'false',
        FALLBACK_TOKEN: 'ghs_test_default_token',
      });
      expect(otherRes.status).toBe(1);
      expect(otherRes.stderr).toContain('protected branch hook declined');
      expect(otherRes.stdout).not.toContain('RELEASE_BRANCH_APP_CLIENT_ID');
      expect(otherRes.tempLeftovers).toEqual([]);

      // Fallback success when USE_APP=false.
      const fallbackRes = runPush('ok', {
        USE_APP: 'false',
        FALLBACK_TOKEN: 'ghs_test_default_token',
      });
      expect(fallbackRes.status).toBe(0);
      expect(fallbackRes.summary.trim()).toBe(
        'release: 1111111111111111111111111111111111111111 -> 2222222222222222222222222222222222222222 (v0.3.11) via github-token',
      );
      expect(fallbackRes.tempLeftovers).toEqual([]);

      // GitHub App success with GITHUB_ACTIONS=true verifies ::add-mask:: without polluting $before in summary.
      const token = 'ghs_test_app_token_secret';
      const appRes = runPush('ok', {
        TAG: 'v0.3.12',
        USE_APP: 'true',
        APP_TOKEN: token,
        FALLBACK_TOKEN: '',
        GITHUB_ACTIONS: 'true',
      });
      expect(appRes.status).toBe(0);
      expect(appRes.stderr).toContain('To https://github.com/DOS/Ludy.git');
      expect(appRes.tempLeftovers).toEqual([]);
      const expectedBasic = Buffer.from(`x-access-token:${token}`).toString('base64');
      expect(appRes.stdout).toContain(`::add-mask::${expectedBasic}`);
      expect(appRes.summary.trim()).toBe(
        'release: 1111111111111111111111111111111111111111 -> 2222222222222222222222222222222222222222 (v0.3.12) via github-app',
      );
      const invocations = appRes.gitLog.trim().split('\n');
      expect(invocations).toHaveLength(2);
      for (const line of invocations) {
        expect(line).toContain('COUNT:2 PROMPT:0 K0:http.https://github.com/.extraheader V0: K1:http.https://github.com/.extraheader');
        expect(line).toContain(`V1:AUTHORIZATION: basic ${expectedBasic}`);
        expect(line).not.toContain(token);
      }
      expect(invocations[0]).toContain('ARGS:ls-remote origin refs/heads/release');
      expect(invocations[1]).toContain('ARGS:push --force origin 2222222222222222222222222222222222222222:refs/heads/release');
    });
  });
});

describe('.github/workflows/deploy.yml release sync (#3580)', () => {
  const workflow = readFileSync(root('.github/workflows/deploy.yml'), 'utf8').replaceAll('\r\n', '\n');

  it('syncs the release branch only after a successful pilot v* tag deploy', () => {
    expect(workflow).toContain('\n  release-branch:\n');
    const block = workflow.slice(workflow.indexOf('\n  release-branch:\n'));
    expect(block).toContain('needs: [target, deploy]');
    expect(block).toContain("github.ref_type == 'tag'");
    expect(block).toContain("needs.target.outputs.action == 'deploy'");
    expect(block).toContain("needs.target.outputs.environment == 'pilot'");
    expect(block).toContain("needs.deploy.outputs.deployed == 'true'");
    expect(block).toContain('actions/workflows/release-branch.yml/dispatches');
    expect(block).toContain('X-GitHub-Api-Version: 2026-03-10');
    expect(block).not.toContain('return_run_details');
    expect(block).toContain('select(.id > $before)');
    expect(block).toContain('ref: "main"');
    expect(block).toContain('repos/$REPO/git/ref/heads/release');
    expect(block).toContain('bash tools/deploy/deploy.sh check-app-build "$APP_URL" "$SHA" "$PUBLIC_URL"');
  });

  it('keeps minimal permissions and pinned action SHAs across deploy.yml', () => {
    const block = workflow.slice(workflow.indexOf('\n  release-branch:\n'));
    expect(block).toContain('actions: write');
    expect(block).toContain('contents: read');
    expect(block).not.toContain('contents: write');
    expect(block).not.toContain('packages: write');
    const uses = [...workflow.matchAll(/uses:\s*([^\s]+)/g)].map((m) => m[1]);
    expect(uses.length).toBeGreaterThanOrEqual(4);
    for (const ref of uses) {
      expect(ref).toMatch(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/);
    }
  });
});
