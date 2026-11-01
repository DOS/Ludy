// SPDX-License-Identifier: AGPL-3.0-only
// The Vercel side of a split deployment (#2261): the app's headers match what the kernel serves with the app, production
// builds only a release, and the workflow that moves the release branch runs on tags of main only.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy } from '../src/http.ts';
// @ts-expect-error a plain ES module with no type declarations
import { RELEASE_BRANCH, decide } from '../../../tools/vercel/ignore-build.mjs';

const root = (path: string) => new URL(`../../../${path}`, import.meta.url);
const vercel = JSON.parse(readFileSync(root('apps/app/vercel.json'), 'utf8')) as {
  ignoreCommand: string;
  build: { env: Record<string, string> };
  rewrites: Array<{ source: string; destination: string }>;
  headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
};
const header = (name: string) => vercel.headers[0]?.headers.find((h) => h.key.toLowerCase() === name.toLowerCase())?.value;

describe('apps/app/vercel.json', () => {
  const api = vercel.build.env['VITE_API_URL'] ?? '';

  it('builds the app against the API origin it allows in its CSP, as the kernel would for the same deployment', () => {
    expect(api).toMatch(/^https:\/\/[a-z0-9.-]+$/);
    // The auth proxy lives on the API, booking pages use Turnstile, and transfers go through the API (no bucket origin).
    expect(header('content-security-policy')).toBe(contentSecurityPolicy(`${api}/auth/v1`, null, true));
  });

  it('sends the browser security headers the kernel sends with the app', () => {
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
