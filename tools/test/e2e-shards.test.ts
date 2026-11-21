// SPDX-License-Identifier: AGPL-3.0-only
// The split of the Playwright suite into CI shards (#2788): every spec file runs in exactly one shard (a file in none would be a
// test CI never runs), the shards are about equally long by measured time, and a new spec with no measured time still lands in
// a shard. The required check "Playwright on docker compose" is the gate job of e2e.yml and must keep its name.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assignShards } from '../ci/db-shards.mjs';
import { loadTimes, plan, specFiles } from '../ci/e2e-shards.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const COUNT = 4;

describe('Playwright shards', () => {
  const all: string[] = specFiles(ROOT);
  const shards = plan(COUNT, ROOT) as { files: string[]; seconds: number }[];

  it('finds the spec files of e2e/tests', () => {
    expect(all.length).toBeGreaterThan(50);
    expect(all.every((f) => /^tests\/[\w.-]+\.spec\.ts$/.test(f))).toBe(true);
  });

  it('runs every spec file in exactly one shard, in alphabetical order inside it', () => {
    const seen = new Map<string, number>();
    for (const f of shards.flatMap((s) => s.files)) seen.set(f, (seen.get(f) ?? 0) + 1);
    expect([...seen.entries()].filter(([, n]) => n !== 1)).toEqual([]);
    expect([...seen.keys()].sort()).toEqual(all);
    for (const s of shards) expect(s.files).toEqual([...s.files].sort());
  });

  it('keeps the shards within 10% of each other by planned time', () => {
    const seconds = shards.map((s) => s.seconds);
    expect(shards.every((s) => s.files.length > 0)).toBe(true);
    expect(Math.max(...seconds) / Math.min(...seconds)).toBeLessThan(1.1);
  });

  it('puts a spec with no measured time in a shard, as a median file', () => {
    const files = [...all, 'tests/brand-new.spec.ts'];
    const placed = assignShards(files, loadTimes(ROOT), COUNT) as { files: string[] }[];
    expect(placed.flatMap((s) => s.files)).toContain('tests/brand-new.spec.ts');
    expect(placed.flatMap((s) => s.files)).toHaveLength(files.length);
  });

  it('keeps the required check name on the gate job and four shard jobs', () => {
    const workflow = readFileSync(`${ROOT}.github/workflows/e2e.yml`, 'utf8');
    expect(workflow).toContain('name: Playwright on docker compose');
    // The gate waits for the four shards and for the AI stack (#3805): the specs that need a fake model run in their own job, and a red one fails the required check.
    expect(workflow).toContain('needs: [shard, ai]');
    expect(workflow).toContain('test "$SHARDS" = success && test "$AI" = success');
    expect(workflow).toContain("shard: ['1', '2', '3', '4']");
    expect(workflow).toContain('e2e-shards.mjs "$SHARD" 4');
  });

  it('runs the specs of tests-ai only in the AI job, on a stack with the fake model, and never in a shard', () => {
    const workflow = readFileSync(`${ROOT}.github/workflows/e2e.yml`, 'utf8');
    expect(workflow).toContain('pnpm --filter @crove/e2e stack:up:ai');
    expect(workflow).toContain('pnpm --filter @crove/e2e test:ai');
    // The shards' files come from e2e/tests (the default Playwright project's testDir), and the AI specs sit in another directory with a config of their own, so no shard can list them:
    // pinned by the two directories, not by a negative on a list that could never hold them.
    expect(readFileSync(`${ROOT}e2e/playwright.config.ts`, 'utf8')).toContain("testDir: './tests'");
    expect(readFileSync(`${ROOT}e2e/playwright.ai.config.ts`, 'utf8')).toContain("testDir: './tests-ai'");
    const aiSpecs = readdirSync(`${ROOT}e2e/tests-ai`).filter((f) => f.endsWith('.spec.ts'));
    expect(aiSpecs.length).toBeGreaterThan(0);
    expect(all.filter((f) => aiSpecs.includes(f.replace(/^tests\//, '')))).toEqual([]);
  });

  it('keeps every AI-off default off: only the AI override, and only the AI job, turn the fake model on', () => {
    const ai = readFileSync(`${ROOT}e2e/compose.ai.yml`, 'utf8');
    expect(ai).toContain('MEETINGS_SUMMARY: \'on\'');
    expect(ai).toContain('AI_BASE_URL: http://fake-model:');
    expect(ai).toContain('AI_MODEL: fake-summary');
    // The model settings and the summary switch appear in no default: not the e2e stack, not the shard jobs, and the product's own compose leaves the model empty and the summary off.
    const defaults = readFileSync(`${ROOT}e2e/compose.e2e.yml`, 'utf8');
    for (const setting of ['AI_BASE_URL', 'AI_MODEL', 'AI_API_KEY', 'MEETINGS_SUMMARY']) expect(defaults, `compose.e2e.yml ${setting}`).not.toContain(setting);
    const workflow = readFileSync(`${ROOT}.github/workflows/e2e.yml`, 'utf8');
    const job = (name: string): string => {
      const start = workflow.indexOf(`\n  ${name}:\n`);
      expect(start, `job ${name}`).toBeGreaterThan(-1);
      const rest = workflow.slice(start + 1);
      const next = rest.slice(1).search(/\n {2}[A-Za-z][\w-]*:\n/);
      // Comment lines are not settings (the comment above the next job names them).
      return (next === -1 ? rest : rest.slice(0, next + 1)).split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');
    };
    for (const setting of ['AI_BASE_URL', 'AI_MODEL', 'AI_API_KEY', 'MEETINGS_SUMMARY']) expect(job('shard'), `the shard job ${setting}`).not.toContain(setting);
    const product = readFileSync(`${ROOT}docker-compose.yml`, 'utf8');
    expect(product).toContain('AI_BASE_URL: ${AI_BASE_URL:-}');
    expect(product).toContain('AI_MODEL: ${AI_MODEL:-}');
    expect(product).toContain('MEETINGS_SUMMARY: ${MEETINGS_SUMMARY:-off}');
  });

  it('isolates the fake model: its network is internal, it joins no other, and it publishes no port', () => {
    const ai = readFileSync(`${ROOT}e2e/compose.ai.yml`, 'utf8');
    // "Reaches no other host" is enforced by the network, not only by the fake's code.
    expect(ai).toMatch(/\nnetworks:\n {2}model:\n {4}internal: true\n/);
    const start = ai.indexOf('\n  fake-model:\n');
    expect(start).toBeGreaterThan(-1);
    const block = ai.slice(start, ai.indexOf('\nnetworks:\n'));
    expect(block).not.toMatch(/^\s+ports:/m);
    expect(block).not.toMatch(/^\s+network_mode:/m);
    const joined = /\n {4}networks:\n((?: {6}- .+\n?)+)/.exec(block)?.[1]?.trim().split('\n').map((l) => l.trim());
    expect(joined).toEqual(['- model']);
  });
});
