// SPDX-License-Identifier: AGPL-3.0-only
// Every AI feature the server meters has a plain name on the usage page in both languages (#3017): a feature added to packages/agent meter.ts without one would show its raw key.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n/messages/en.ts';
import { vi } from '../src/i18n/messages/vi.ts';

const meter = readFileSync(fileURLToPath(new URL('../../../packages/agent/src/meter.ts', import.meta.url)), 'utf8');
const block = meter.slice(meter.indexOf('AI_FEATURES'), meter.indexOf('} as const', meter.indexOf('AI_FEATURES')));
const keys = [...block.matchAll(/^\s*'([a-z_]+\.[a-z_]+)':/gm)].map((m) => (m[1] as string).replace('.', '_'));
const screen = readFileSync(fileURLToPath(new URL('../src/routes/agents.tsx', import.meta.url)), 'utf8');

describe('AI feature labels', () => {
  it('finds the features of the meter', () => {
    expect(keys.length).toBeGreaterThan(20);
    expect(keys).toContain('meetings_followup_words');
  });
  it.each(keys)('names %s in both languages and lists it on the usage page', (key) => {
    expect((en.aiMeter.features as Record<string, string>)[key]?.length ?? 0).toBeGreaterThan(0);
    expect((vi.aiMeter.features as Record<string, string>)[key]?.length ?? 0).toBeGreaterThan(0);
    expect(screen).toContain(`'${key}'`);
  });
});
