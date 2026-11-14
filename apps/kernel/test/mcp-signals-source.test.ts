// SPDX-License-Identifier: AGPL-3.0-only
// The signals reads and the pull tool never read the audit tables (ADR-0051, #2975, step S4): the sealed MCP context can compute input hashes under the consenting user's key, so a tool that could read audit rows
// could use that to confirm a guess at what another command's input was. This holds the sources of the tool, the three rules and the six line reads to it.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const FORBIDDEN = /audit_event|idempotency_key|security_event|refusal_tally|mcp_call_audit/;
const files = [
  'packages/kernel/src/mcp-signals.ts',
  'packages/kernel/src/signals.ts',
  ...readdirSync(`${root}modules/crm/src`).filter((f) => f.startsWith('signals-')).map((f) => `modules/crm/src/${f}`),
  ...readdirSync(`${root}modules/finance/src`).filter((f) => f.startsWith('signals-')).map((f) => `modules/finance/src/${f}`),
];

describe('the signals reads and the pull tool', () => {
  it('names the tool, the rules and every signals read file, so none escapes this check', () => {
    expect(files).toEqual(expect.arrayContaining(['packages/kernel/src/mcp-signals.ts', 'modules/crm/src/signals-won-deals.ts', 'modules/crm/src/signals-open-deals.ts', 'modules/finance/src/signals-sales.ts', 'modules/finance/src/signals-overdue-receivables.ts']));
  });

  it('read no audit table, no idempotency key, no security event and no refusal tally', () => {
    for (const file of files) {
      // Comments may say what is never read; the code may not name it.
      const code = readFileSync(`${root}${file}`, 'utf8').split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');
      expect(code.match(FORBIDDEN)?.[0], file).toBeUndefined();
    }
  });
});
