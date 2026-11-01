// SPDX-License-Identifier: AGPL-3.0-only
// The Vercel side of a split deployment (#2261): the app's headers match what the kernel serves with the app, production
// builds only a release, and the workflow that moves the release branch runs on tags of main only.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
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
          directives(contentSecurityPolicy(`${API}/auth/v1`, storage ?? null, turnstile)),
        );
      }
    }
  });

  it('allows the origin of Supabase Auth when it is not the one of the API', () => {
    const policy = metaCsp({ apiOrigin: API, authOrigin: 'https://auth.example.com' });
    expect(policy).toContain("connect-src 'self' https://auth.example.com https://api.example.com");
    expect(together({ apiOrigin: API, authOrigin: 'https://auth.example.com' })).toEqual(directives(contentSecurityPolicy('https://auth.example.com/auth/v1', null, false).replace('https://auth.example.com', 'https://auth.example.com https://api.example.com')));
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
    const ci = workflow.indexOf('CI is green');
    const push = workflow.indexOf('git push --force origin "$SHA:refs/heads/release"');
    expect(ci).toBeGreaterThan(0);
    expect(push).toBeGreaterThan(ci);
  });

  it('gets write access for the one job that needs it, and pins the checkout action by commit', () => {
    expect(workflow.match(/contents: write/g)).toHaveLength(1);
    expect(workflow).toMatch(/uses: actions\/checkout@[0-9a-f]{40} # v/);
  });
});
