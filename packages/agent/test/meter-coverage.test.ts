// SPDX-License-Identifier: AGPL-3.0-only
// The AI budget meter has one door (#2382): fails when a model call bypasses it. Every call to the AI SDK's model
// functions in packages/agent/src sits inside `metered('<feature>', () => generateText(...))`, every feature named there is
// in AI_FEATURES, every feature of the registry has a caller (a registry entry nobody calls is a stale budget line), and
// nothing outside this package's own source and the tests builds a model client or reaches for the unmetered meter.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AI_FEATURES, AI_FEATURE_KEYS } from '../src/index.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SRC = join(ROOT, 'packages/agent/src');
const SKIPPED = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', '.next', '.turbo', '.vite']);

function sources(dir: string, skipTests = false): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIPPED.has(name) || (skipTests && (name === 'test' || name === 'fixtures'))) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path, skipTests));
    else if (/\.(ts|tsx|mjs|js)$/.test(name)) out.push(path);
  }
  return out;
}

// The AI SDK functions that reach a model; a call to any of them is a model call.
// transcribeAudio is the adapter's own HTTP call to the transcription endpoint (transcribe.ts): it is a model call too. A
// definition (`function transcribeAudio(`) is not a call.
const CALL = '(?:generateText|generateObject|streamText|streamObject|embed|embedMany|generateImage|generateSpeech|transcribe|transcribeAudio)';
const MODEL_CALL = new RegExp(`(?<!function )\\b${CALL}\\s*\\(`, 'g');
const METERED_CALL = new RegExp(`\\bmetered\\(\\s*'([a-z][a-z0-9_.]*)',\\s*\\(\\)\\s*=>\\s*${CALL}\\(`, 'g');
const squash = (text: string) => text.replace(/\s+/g, ' ');

describe('every model call goes through the AI budget meter (#2382)', () => {
  const files = sources(SRC).filter((f) => !f.endsWith('meter.ts'));

  it('finds the model calls it guards (the scan is not vacuous)', () => {
    const calls = files.reduce((n, f) => n + [...squash(readFileSync(f, 'utf8')).matchAll(MODEL_CALL)].length, 0);
    expect(calls).toBeGreaterThanOrEqual(8);
  });

  it('wraps every model call in metered() with a feature of the registry', () => {
    const bare: string[] = [];
    const used = new Set<string>();
    for (const file of files) {
      const text = squash(readFileSync(file, 'utf8'));
      const all = [...text.matchAll(MODEL_CALL)].length;
      const wrapped = [...text.matchAll(METERED_CALL)];
      for (const m of wrapped) used.add(m[1] as string);
      if (wrapped.length !== all) bare.push(`${relative(ROOT, file)}: ${all - wrapped.length} of ${all} model call(s) outside metered()`);
    }
    expect(bare, 'a model call made without the meter').toEqual([]);
    expect([...used].filter((f) => !(f in AI_FEATURES)), 'a feature that is not in AI_FEATURES').toEqual([]);
    expect(AI_FEATURE_KEYS.filter((f) => !used.has(f)), 'a feature in AI_FEATURES that no call uses').toEqual([]);
  });

  it('does not let product code build a model client or use the unmetered meter', () => {
    const offenders: string[] = [];
    for (const top of ['apps', 'modules', 'packages']) {
      for (const file of sources(join(ROOT, top), true)) {
        const rel = relative(ROOT, file).replaceAll('\\', '/');
        // The agent package owns the door; tests (skipped in the walk) measure the model itself or fake it.
        if (rel.startsWith('packages/agent/src/')) continue;
        const text = readFileSync(file, 'utf8');
        if (/\bUNMETERED\b/.test(text)) offenders.push(`${rel}: UNMETERED outside a test`);
        if (/\bchatModel\s*\(/.test(text)) offenders.push(`${rel}: builds a model client outside packages/agent`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
