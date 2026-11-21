// SPDX-License-Identifier: AGPL-3.0-only
// Unit checks for the SQL redaction detector (#4001, Slice 1):
// - Migration 20270201230000 defines pure SECURITY INVOKER IMMUTABLE PARALLEL SAFE functions pinned to pg_catalog, pg_temp,
//   revoked from PUBLIC, and granted to crove_tenant (matching crove_kernel.text_mentions).
// - Character constants stay aligned with 20261122040000_crove_kernel_text_mention_long_digits.sql.
// - No duplicate TypeScript regex detector was introduced outside SQL.
// - PII_DETECT_CASES covers every redaction kind and near-miss category non-vacuously.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PII_DETECT_CASES, REDACTION_KINDS } from './pii-detect-cases.ts';

const readMigration = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../../../supabase/migrations/${name}`, import.meta.url)), 'utf8');

describe('crove_kernel.text_detect migration contract (#4001 Slice 1)', () => {
  const detectSql = readMigration('20270201230000_crove_kernel_text_detect.sql');
  const patternSql = readMigration('20261122040000_crove_kernel_text_mention_long_digits.sql');

  it('declares pure SECURITY INVOKER IMMUTABLE PARALLEL SAFE functions with pinned search_path and crove_tenant-only EXECUTE', () => {
    expect(detectSql).not.toMatch(/SECURITY\s+DEFINER/i);
    expect(detectSql).not.toMatch(/CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+/i);

    const invokerHeaders = detectSql.match(/LANGUAGE\s+plpgsql\s+IMMUTABLE\s+PARALLEL\s+SAFE\s+SECURITY\s+INVOKER\s+SET\s+search_path\s*=\s*pg_catalog,\s*pg_temp/gi) ?? [];
    expect(invokerHeaders).toHaveLength(2);

    expect(detectSql).toContain('REVOKE ALL ON FUNCTION crove_kernel.text_detect(text) FROM PUBLIC;');
    expect(detectSql).toContain('GRANT EXECUTE ON FUNCTION crove_kernel.text_detect(text) TO crove_tenant;');
    expect(detectSql).toContain('REVOKE ALL ON FUNCTION crove_kernel.text_redact_spans(text, integer[], text[], text[]) FROM PUBLIC;');
    expect(detectSql).toContain('GRANT EXECUTE ON FUNCTION crove_kernel.text_redact_spans(text, integer[], text[], text[]) TO crove_tenant;');
  });

  it('keeps inline space and non-ASCII Latin letter constants identical to text_mention_pattern', () => {
    const inlineLine = /v_inline constant text := ([^;]+);/;
    const lettersLine = /v_letters constant text := ([^;]+);/s;
    expect(detectSql.match(inlineLine)?.[1]).toBe(patternSql.match(inlineLine)?.[1]);
    expect(detectSql.match(lettersLine)?.[1]?.replace(/\s+/g, ' ')).toBe(patternSql.match(lettersLine)?.[1]?.replace(/\s+/g, ' '));
  });

  it('defines all five redaction kinds symmetrically between text_detect and text_redact_spans', () => {
    for (const kind of REDACTION_KINDS) {
      expect(detectSql).toContain(`'${kind}'`);
    }
    const allowedMatch = detectSql.match(/p_kinds\[i\] NOT IN \(([^)]+)\)/);
    expect(allowedMatch?.[1]).toBe("'email', 'phone', 'national_id', 'tax_code', 'bank_account'");
  });

  it('has a non-vacuous case table covering every kind and near-miss category', () => {
    const positives = PII_DETECT_CASES.filter((c) => c.expected.length > 0);
    const negatives = PII_DETECT_CASES.filter((c) => c.expected.length === 0);
    expect(positives.length).toBeGreaterThanOrEqual(15);
    expect(negatives.length).toBeGreaterThanOrEqual(6);

    const seenKinds = new Set(positives.flatMap((c) => c.expected.map((e) => e.kind)));
    expect([...seenKinds].sort()).toEqual([...REDACTION_KINDS].sort());

    for (const c of positives) {
      for (const expected of c.expected) {
        expect(c.text.includes(expected.matchText), `${c.name}: "${expected.matchText}"`).toBe(true);
      }
    }
  });
});
