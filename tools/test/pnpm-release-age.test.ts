// SPDX-License-Identifier: AGPL-3.0-only
// Release-age policy check for pnpm-workspace.yaml (audit SEC-03, issue #3976).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MIN_RELEASE_AGE_MINUTES = 1440;

function splitYamlComment(line: string): { code: string; comment: string } {
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote === "'") {
      if (ch === "'" && line[i + 1] === "'") i++;
      else if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === '\\') i++;
      else if (ch === '"') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === '#' && (i === 0 || /\s/.test(line[i - 1] ?? ''))) {
      return {
        code: line.slice(0, i).trimEnd(),
        comment: line.slice(i + 1).trim(),
      };
    }
  }
  return { code: line.trimEnd(), comment: '' };
}

/**
 * Validate pnpm-workspace.yaml release-age settings and exclusion-list hygiene.
 * @returns List of human-readable policy violations (empty when compliant).
 */
function checkWorkspaceReleaseAgePolicy(yamlText: string): string[] {
  const violations: string[] = [];
  const lines = yamlText.split(/\r?\n/);
  const seenPolicyKeys = new Set<string>();

  let minimumReleaseAge: string | undefined;
  let minimumReleaseAgeStrict: string | undefined;
  let minimumReleaseAgeExcludePrune: string | undefined;

  let inExcludeBlock = false;
  let excludeReason: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    const { code, comment } = splitYamlComment(raw);
    const trimmed = code.trim();

    if (inExcludeBlock) {
      if (trimmed === '') {
        excludeReason = comment || undefined;
        continue;
      }
      // Sequence items in YAML are valid at column 0 or indented; check list item before column-0 key exit.
      if (/^[ \t]*-(?:\s|$)/.test(code)) {
        const entry = trimmed.slice(1).trim();
        const reason = comment || excludeReason;
        if (!entry) {
          violations.push(`line ${i + 1}: minimumReleaseAgeExclude entry must be a non-empty package specifier`);
        } else if (!reason) {
          violations.push(`line ${i + 1}: minimumReleaseAgeExclude entry ${entry} has no written reason comment`);
        }
        excludeReason = undefined;
        continue;
      }
      if (/^\S/.test(code)) {
        inExcludeBlock = false;
        excludeReason = undefined;
      } else {
        violations.push(`line ${i + 1}: unexpected non-list content inside minimumReleaseAgeExclude: ${trimmed}`);
        excludeReason = undefined;
        continue;
      }
    }

    if (trimmed === '') continue;
    const topKeyMatch = /^(['"]?)([A-Za-z0-9_]+)\1\s*:\s*(.*)$/.exec(code);
    if (!topKeyMatch) continue;
    const [, , key = '', rest = ''] = topKeyMatch;
    const value = rest.trim();

    if (
      key === 'minimumReleaseAge' ||
      key === 'minimumReleaseAgeStrict' ||
      key === 'minimumReleaseAgeExcludePrune' ||
      key === 'minimumReleaseAgeExclude'
    ) {
      if (seenPolicyKeys.has(key)) {
        violations.push(`line ${i + 1}: duplicate ${key} key`);
        continue;
      }
      seenPolicyKeys.add(key);
    }

    if (key === 'minimumReleaseAge') {
      minimumReleaseAge = value;
    } else if (key === 'minimumReleaseAgeStrict') {
      minimumReleaseAgeStrict = value;
    } else if (key === 'minimumReleaseAgeExcludePrune') {
      minimumReleaseAgeExcludePrune = value;
    } else if (key === 'minimumReleaseAgeExclude') {
      if (value === '' || /^\[\s*\]$/.test(value)) {
        inExcludeBlock = value === '';
        excludeReason = undefined;
      } else {
        violations.push(`line ${i + 1}: minimumReleaseAgeExclude must be empty or use block list items with per-entry reason comments`);
      }
    }
  }

  if (minimumReleaseAge === undefined) {
    violations.push(`minimumReleaseAge must be set explicitly (>= ${MIN_RELEASE_AGE_MINUTES}) so pnpm defaults minimumReleaseAgeStrict to true`);
  } else if (!/^\d+$/.test(minimumReleaseAge) || Number(minimumReleaseAge) < MIN_RELEASE_AGE_MINUTES) {
    violations.push(`minimumReleaseAge must be an integer >= ${MIN_RELEASE_AGE_MINUTES} (got ${minimumReleaseAge})`);
  }

  if (minimumReleaseAgeStrict !== undefined && minimumReleaseAgeStrict !== 'true') {
    violations.push(`minimumReleaseAgeStrict must not be ${minimumReleaseAgeStrict}; keep it omitted or true`);
  }

  if (minimumReleaseAgeExcludePrune !== 'true') {
    violations.push('minimumReleaseAgeExcludePrune must be set to true');
  }

  return violations;
}

describe('pnpm-workspace.yaml release age policy (SEC-03, #3976)', () => {
  it('enforces explicit minimumReleaseAge >= 1440, pruning, and documented exclusions on the repo manifest', () => {
    const workspaceYaml = readFileSync(join(ROOT, 'pnpm-workspace.yaml'), 'utf8');
    expect(checkWorkspaceReleaseAgePolicy(workspaceYaml)).toEqual([]);
  });

  it('rejects omitting minimumReleaseAge (built-in 1440 default is non-strict in pnpm >= 12.3.0)', () => {
    const violations = checkWorkspaceReleaseAgePolicy([
      'packages:',
      "  - 'apps/*'",
      'minimumReleaseAgeExcludePrune: true',
    ].join('\n'));
    expect(violations).toEqual([
      'minimumReleaseAge must be set explicitly (>= 1440) so pnpm defaults minimumReleaseAgeStrict to true',
    ]);
  });

  it('rejects lowering minimumReleaseAge below 1440 or disabling strict mode', () => {
    const violations = checkWorkspaceReleaseAgePolicy([
      'minimumReleaseAge: 60',
      'minimumReleaseAgeStrict: false',
      'minimumReleaseAgeExcludePrune: false',
    ].join('\n'));
    expect(violations).toEqual([
      'minimumReleaseAge must be an integer >= 1440 (got 60)',
      'minimumReleaseAgeStrict must not be false; keep it omitted or true',
      'minimumReleaseAgeExcludePrune must be set to true',
    ]);
  });

  it('requires a written reason comment for every minimumReleaseAgeExclude entry, including column-0 items and after blank lines', () => {
    const violations = checkWorkspaceReleaseAgePolicy([
      '# Section header comment must not excuse entries',
      'minimumReleaseAge: 1440',
      'minimumReleaseAgeExcludePrune: true',
      'minimumReleaseAgeExclude:',
      '  # CVE-2026-0001 security patch < 24h old',
      "  - 'pkg-a@1.2.3'",
      "  - 'pkg-b@4.5.6'",
      '  # comment separated by a blank line must not count',
      '',
      "- 'pkg-c@7.8.9'",
      "  - 'pkg-d@1.0.0' # urgent fix",
    ].join('\n'));
    expect(violations).toEqual([
      "line 7: minimumReleaseAgeExclude entry 'pkg-b@4.5.6' has no written reason comment",
      "line 10: minimumReleaseAgeExclude entry 'pkg-c@7.8.9' has no written reason comment",
    ]);
  });

  it('rejects flow syntax, indented non-list content, quoted bypass keys, and duplicate policy keys', () => {
    expect(
      checkWorkspaceReleaseAgePolicy([
        'minimumReleaseAge: 1440',
        'minimumReleaseAgeExcludePrune: true',
        'minimumReleaseAgeExclude: [pkg-a@1.0.0]',
      ].join('\n')),
    ).toHaveLength(1);

    expect(
      checkWorkspaceReleaseAgePolicy([
        'minimumReleaseAge: 1440',
        'minimumReleaseAgeExcludePrune: true',
        'minimumReleaseAgeExclude:',
        '  [pkg-a@1.0.0]',
      ].join('\n')),
    ).toEqual([
      'line 4: unexpected non-list content inside minimumReleaseAgeExclude: [pkg-a@1.0.0]',
    ]);

    expect(
      checkWorkspaceReleaseAgePolicy([
        "'minimumReleaseAge': 0",
        '"minimumReleaseAgeStrict": false',
        'minimumReleaseAgeExcludePrune: true',
      ].join('\n')),
    ).toEqual([
      'minimumReleaseAge must be an integer >= 1440 (got 0)',
      'minimumReleaseAgeStrict must not be false; keep it omitted or true',
    ]);

    expect(
      checkWorkspaceReleaseAgePolicy([
        'minimumReleaseAge: 1440',
        'minimumReleaseAge: 0',
        'minimumReleaseAgeExcludePrune: true',
      ].join('\n')),
    ).toEqual([
      'line 2: duplicate minimumReleaseAge key',
    ]);

    expect(
      checkWorkspaceReleaseAgePolicy([
        'minimumReleaseAge: 1440',
        'minimumReleaseAgeExcludePrune: true',
        'minimumReleaseAgeExclude: [ ]',
      ].join('\n')),
    ).toEqual([]);
  });
});
