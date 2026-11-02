// SPDX-License-Identifier: AGPL-3.0-only
// Every title key finance.today returns (#2388) is a message of Home's `today.items` namespace in both languages: Home looks
// the key up there and falls back to a plain sentence for one it does not know, so a key missing from a catalog would show
// the fallback instead of the line. The keys are read from the query's source, the one place that names them.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { en } from '../../app/src/i18n/messages/en.ts';
import { vi } from '../../app/src/i18n/messages/vi.ts';

const source = readFileSync(fileURLToPath(new URL('../../../modules/finance/src/today.ts', import.meta.url)), 'utf8');
const keys = [...new Set([...source.matchAll(/'(finance[A-Z][A-Za-z]+)'/g)].map((m) => m[1] as string))];

describe('finance.today title keys', () => {
  it('finds the keys the query uses', () => {
    expect(keys.length).toBeGreaterThanOrEqual(11);
  });

  it.each([
    ['vi', vi],
    ['en', en],
  ] as const)('has every key in the %s catalog under today.items', (_locale, catalog) => {
    const items = (catalog as unknown as { today: { items: Record<string, unknown> } }).today.items;
    for (const key of keys) expect(typeof items[key], key).toBe('string');
  });
});
