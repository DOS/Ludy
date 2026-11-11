// SPDX-License-Identifier: AGPL-3.0-only
// The extension release workflow (#3009): the tag rule, and what the workflow file may and may not do. It builds, checks and zips the package and attaches it to a GitHub
// release; it never touches the Chrome Web Store and uses no secret; only the job that publishes holds the write permission, and it runs no repository code.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { versionOfTag } from '../extension-version.mjs';

const workflow = readFileSync(new URL('../../.github/workflows/extension-release.yml', import.meta.url), 'utf8');
const jobs = (): Record<string, string> => {
  const body = workflow.slice(workflow.indexOf('\njobs:\n'));
  const parts = body.split(/\n  (?=[a-z][a-z-]*:\n)/).slice(1);
  return Object.fromEntries(parts.map((part) => [part.slice(0, part.indexOf(':')), part]));
};

describe('versionOfTag', () => {
  it.each([
    ['ext-v1', '1'],
    ['ext-v1.2', '1.2'],
    ['ext-v1.2.3', '1.2.3'],
    ['ext-v0.1.1', '0.1.1'],
    ['ext-v1.2.3.4', '1.2.3.4'],
    ['ext-v65535.0.0', '65535.0.0'],
  ])('%s gives %s', (tag, version) => {
    expect(versionOfTag(tag)).toEqual({ ok: true, version });
  });

  it.each(['v1.2.3', 'extension-v1.2.3', 'ext-1.2.3', 'ext-v', 'ext-v1.', 'ext-v1..2', 'ext-v1.2.3.4.5', 'ext-v01.2', 'ext-v1.02', 'ext-v1.2.3-rc1', 'ext-v1.2.3 ', 'ext-v-1', 'ext-v1.a', 'ext-v1.2.3\n$(id)', ''])(
    'refuses %j',
    (tag) => {
      expect(versionOfTag(tag).ok).toBe(false);
    },
  );

  it('refuses a part a manifest cannot hold', () => {
    expect(versionOfTag('ext-v65536.0.0').ok).toBe(false);
    expect(versionOfTag('ext-v1.99999').ok).toBe(false);
  });
});

describe('the extension release workflow', () => {
  it('runs on ext-v* tags and by hand, and on nothing else', () => {
    const on = workflow.slice(workflow.indexOf('\non:\n'), workflow.indexOf('\npermissions:\n'));
    expect(on).toContain("tags: ['ext-v*']");
    expect(on).toContain('workflow_dispatch:');
    expect(on).not.toMatch(/pull_request|branches:|schedule:|workflow_run|workflow_call|repository_dispatch|issue_comment|release:/);
  });

  it('uses no secret and no store: nothing is uploaded to the Chrome Web Store from CI', () => {
    expect(workflow).not.toMatch(/secrets\./);
    expect(workflow).not.toMatch(/chrome-webstore|webstore|chromewebstore|googleapis|oauth2|refresh_token|client_secret|developer\.chrome|chrome-extension-upload/i);
    expect(workflow).not.toMatch(/pull_request_target/);
  });

  it('holds contents: write in the release job only, and that job checks out and installs nothing', () => {
    const all = jobs();
    expect(Object.keys(all).sort()).toEqual(['build', 'release']);
    expect(workflow.slice(0, workflow.indexOf('\njobs:\n'))).toMatch(/\npermissions:\n  contents: read\n/);
    // The permissions are exact: the build job reads, the release job writes contents and reads actions, nothing else (no id-token, packages or pull-requests).
    expect(all.build).toMatch(/\n    permissions:\n      contents: read\n      checks: read\n/);
    expect(all.release).toMatch(/\n    permissions:\n      contents: write\n      actions: read\n/);
    // Only a push of a tag publishes: a dispatch from any ref, a tag included, never reaches the write token.
    expect(all.release).toContain("if: github.event_name == 'push' && github.ref_type == 'tag'");
    expect(all.release).not.toMatch(/actions\/checkout|actions\/download-artifact|uses: \.|docker:|pnpm|npm |setup-node|node |git |gh repo|curl|wget|bash |sh -c|apps\/extension/);
    expect(all.release).toContain('--verify-tag');
    expect(all.release).toContain('--latest=false');
    expect(all.release).toContain('sha256sum --check');
  });

  it('pins every action by commit and keeps no credential in the checkout', () => {
    const uses = [...workflow.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)].map((m) => m[1] as string);
    expect(uses.length).toBeGreaterThan(0);
    for (const use of uses) expect(use, use).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
    expect(workflow).toMatch(/persist-credentials: false/);
  });

  it('builds as the CI job does and checks the permission list before it zips', () => {
    const build = jobs().build as string;
    expect(build).toContain('pnpm install --frozen-lockfile --filter "@crove/extension..."');
    expect(build.indexOf('scripts/build.mjs --version')).toBeGreaterThan(0);
    expect(build.indexOf('check:manifest')).toBeGreaterThan(build.indexOf('scripts/build.mjs --version'));
    expect(build.indexOf('zip -X')).toBeGreaterThan(build.indexOf('check:manifest'));
    expect(build).toContain('tools/extension-version.mjs');
    expect(build).toContain('git merge-base --is-ancestor');
    // The tag and the package agree, and the CI gate is the required aggregate check.
    expect(build).toContain('apps/extension/package.json');
    expect(build).toContain('JOB: Lint, typecheck, test');
  });

  it('keeps the input and the tag out of the shell text: they reach the script through the environment', () => {
    // No expression in any `run:` text, nor in a `shell:` or `working-directory:` line (they reach the shell as text); `env:` is where they belong.
    const runs = [...workflow.matchAll(/run:[ \t]*\|?\n?([\s\S]*?)(?=\n      - |\n  [a-z]|$)/g)].map((m) => m[1] as string);
    expect(runs.length).toBeGreaterThanOrEqual(9);
    for (const run of runs) expect(run, run.slice(0, 60)).not.toMatch(/\$\{\{/);
    expect(workflow).not.toMatch(/(?:shell|working-directory):.*\$\{\{/);
  });
});
