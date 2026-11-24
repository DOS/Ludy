// SPDX-License-Identifier: AGPL-3.0-only
// Regression checks for .github/workflows/protected.yml (#4660): preserves the required check name, fail-closed
// aggregation across 4 shards, base-branch suite/integrity guards (#1644, #1647, #1786, #498), pinned SHAs, and
// script-injection hygiene.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const workflow = readFileSync(`${ROOT}.github/workflows/protected.yml`, 'utf8').replaceAll('\r\n', '\n');

function jobBlock(id: string): string {
  const marker = `\n  ${id}:\n`;
  const start = workflow.indexOf(marker);
  expect(start, `job ${id} must exist`).toBeGreaterThan(-1);
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[A-Za-z][\w-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

describe('.github/workflows/protected.yml sharding and security guards (#4660)', () => {
  it('defines detect (without postgres), 4 parallel invariant-shard runners, and fail-closed invariant aggregator', () => {
    const detect = jobBlock('detect');
    expect(detect).toContain('name: Detect protected paths (from base)');
    expect(detect).toContain('timeout-minutes: 5');
    expect(detect).not.toMatch(/^\s+services:/m);
    expect(detect).not.toMatch(/^\s+image:\s*postgres/m);
    expect(detect).toContain('outputs:\n      protected: ${{ steps.detect.outputs.protected }}');
    expect(detect).toContain('git show "$BASE_SHA:tools/ci/protected-paths.mjs"');
    expect(detect).toContain('No committed node_modules');

    const shard = jobBlock('invariant-shard');
    expect(shard).toContain('name: Invariant suite (from base, shard ${{ matrix.shard }} of 4)');
    expect(shard).toContain('needs: [detect]');
    expect(shard).toContain("if: needs.detect.outputs.protected == 'true'");
    expect(shard).toContain('timeout-minutes: 30');
    expect(shard).toContain('fail-fast: false');
    expect(shard).toContain('shard: [1, 2, 3, 4]');
    expect(shard).not.toContain('steps.detect.outputs.protected');
    expect(shard).toContain('image: postgres:17@sha256:2d2b8998d31037bf721cfdf764d76ba74171b4fab3431b7f72c27c56ddbdf9e3');
    expect(shard).toContain('Take the invariant suite from the base branch');
    expect(shard).toContain('The base suite is still on disk after the install');
    expect(shard).toContain('Keep the database log short');
    expect(shard).toContain('SHARD: ${{ matrix.shard }}');
    expect(shard).toContain('--config vitest.invariant.config.ts --shard="${SHARD}/4"');
    expect(shard).toContain('Fail if any invariant test was skipped');
    expect(shard).toContain('r.numPassedTests === 0 || skipped > 0 || r.numPassedTests !== r.numTotalTests');
    expect(shard).toContain("if: ${{ !cancelled() && steps.take.outcome == 'success' }}");
    expect(shard).toContain('The base suite is still on disk after the run');
    expect(shard).toContain('Report the failed tests');
    expect(shard).toContain('git show "$BASE_SHA:tools/ci/invariant-summary.mjs"');

    const gate = jobBlock('invariant');
    expect(gate).toContain('name: Invariant suite (from base)');
    expect(gate).toContain('needs: [detect, invariant-shard]');
    expect(gate).toContain('if: always()');
    expect(gate).toContain('timeout-minutes: 5');
    expect(gate).toContain('DETECT: ${{ needs.detect.result }}');
    expect(gate).toContain('PROTECTED: ${{ needs.detect.outputs.protected }}');
    expect(gate).toContain('SHARDS: ${{ needs.invariant-shard.result }}');
    expect(gate).toMatch(
      /test "\$DETECT" = "success"[\s\S]*if \[ "\$PROTECTED" = "false" \]; then[\s\S]*test "\$SHARDS" = "skipped" \|\| test "\$SHARDS" = "success"[\s\S]*elif \[ "\$PROTECTED" = "true" \]; then[\s\S]*test "\$SHARDS" = "success"[\s\S]*else[\s\S]*exit 1[\s\S]*fi/,
    );
  });

  it('pins every action to a 40-hex commit SHA, keeps read-only permissions at top level, and never interpolates ${{ }} inside run:', () => {
    expect(workflow).toMatch(/\npermissions:\n {2}contents: read\n/);
    const uses = [...workflow.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)].map((m) => m[1]);
    expect(uses.length).toBeGreaterThanOrEqual(4);
    for (const ref of uses) {
      expect(ref, `action ref must be pinned to 40-char SHA: ${ref}`).toMatch(/@[0-9a-f]{40}$/);
    }

    // Verify no ${{ ... }} expression sits inside any run: script block (including folded/multiline).
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
});
