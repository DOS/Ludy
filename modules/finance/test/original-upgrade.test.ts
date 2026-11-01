// SPDX-License-Identifier: AGPL-3.0-only
// What extraction tells the kernel about an original (XML) whose invoice has a PDF or photo reading still pending (#2269):
// it is not flagged as a duplicate of that proposal, and its duplicate guard says it may take the proposal's place. Any
// other duplicate (a posted document, a reading that is not weaker) is flagged as before, and a PDF never upgrades.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ExtractClient } from '@crove/extract-contract';
import { sha256Hex, type BlobStore, type Runtime } from '@crove/kernel-runtime';
import type { ParsedInvoice } from '@crove/l10n-vn';
import { extractAndPropose } from '../src/extract.ts';

const ORG = '00000000-0000-4000-8000-000000000001';
const FILE = '00000000-0000-4000-8000-000000000002';
const OTHER = '00000000-0000-4000-8000-000000000003';
const BYTES = new TextEncoder().encode('<HDon/>');
const SHA256 = sha256Hex(BYTES);
const parsed = JSON.parse(readFileSync(new URL('../../../packages/l10n-vn/test/fixtures/einvoice-basic.parsed.json', import.meta.url), 'utf8')) as ParsedInvoice;

interface Draft {
  proposal: { duplicateOf: string | null; payload: { checks: Array<{ code: string }> }; duplicateGuard: { upgrades?: boolean; check: { code: string } } };
}

// Reads `file` as `kind` and returns the proposal draft sent to kernel.extraction.record, with the lookup answering `lookup`.
async function draft(kind: 'xml' | 'pdf', lookup: Record<string, unknown>): Promise<Draft['proposal']> {
  const seen: { input: Draft | undefined } = { input: undefined };
  const runtime = {
    query: async (name: string) =>
      name === 'finance.extraction.file'
        ? {
            id: FILE,
            filename: kind === 'xml' ? 'hd.xml' : 'hd.pdf',
            content_type: kind === 'xml' ? 'application/xml' : 'application/pdf',
            storage_key: `org/${ORG}/${SHA256}`,
            generation: `content:${SHA256}`,
            sha256: SHA256,
            hasExtraction: false,
            due: true,
          }
        : { vendorDefault: null, duplicateDocumentId: null, duplicateProposalId: null, ...lookup },
    execute: async (_name: string, input: unknown) => {
      seen.input = input as Draft;
      return { proposalId: null };
    },
  } as unknown as Runtime;
  const store = { get: async () => BYTES } as unknown as BlobStore;
  const extract: ExtractClient = {
    extract: async (k) => (k === 'pdf_text' ? ({ ok: true, kind: 'pdf_text', text: 'x'.repeat(100), pages: 1 } as never) : ({ ok: true, kind: 'einvoice_xml', invoice: parsed } as never)),
  };
  const ai = { fromText: async () => ({ ...structuredClone(parsed), source: 'ai' as const }), fromImage: async () => null };
  await extractAndPropose({ runtime, store, extractor: ai as never, extract, today: () => '2026-10-13' }, ORG, FILE);
  if (!seen.input) throw new Error('nothing was recorded');
  return seen.input.proposal;
}

describe('an original after a pending PDF reading (#2269)', () => {
  it('is not flagged as the duplicate of a pending proposal read from a PDF, and its guard may upgrade it', async () => {
    const proposal = await draft('xml', { duplicateProposalId: OTHER, duplicateProposalUpgradable: true });
    expect(proposal.duplicateOf).toBeNull();
    expect(proposal.payload.checks.map((c) => c.code)).not.toContain('duplicate.found');
    expect(proposal.duplicateGuard.upgrades).toBe(true);
  });

  it('is flagged as before when the duplicate cannot be revised (a posted one, another reading)', async () => {
    for (const lookup of [
      { duplicateProposalId: OTHER, duplicateProposalUpgradable: false },
      { duplicateProposalId: OTHER },
      { duplicateDocumentId: OTHER, duplicateProposalId: OTHER, duplicateProposalUpgradable: true },
    ]) {
      const proposal = await draft('xml', lookup);
      expect(proposal.duplicateOf, JSON.stringify(lookup)).toBe(lookup.duplicateProposalId);
      expect(proposal.payload.checks.map((c) => c.code), JSON.stringify(lookup)).toContain('duplicate.found');
    }
  });

  it('never lets a PDF reading upgrade anything: it is flagged as a duplicate and its guard does not ask to upgrade', async () => {
    const proposal = await draft('pdf', { duplicateProposalId: OTHER, duplicateProposalUpgradable: true });
    expect(proposal.duplicateOf).toBe(OTHER);
    expect(proposal.payload.checks.map((c) => c.code)).toContain('duplicate.found');
    expect(proposal.duplicateGuard.upgrades).toBeUndefined();
  });
});
