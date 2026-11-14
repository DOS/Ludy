// SPDX-License-Identifier: AGPL-3.0-only
// The two sides of the transcript translation that cannot import each other (meetings integrations E2, #3185): the module (which picks the next batch and prices the button) and the agent
// package (which cuts a run's lines into chunks and hashes them) hold the same rules, and this test ties them: the constants of the contract, the hash of a line and the weight of a line.
import { describe, expect, it } from 'vitest';
import { TRANSCRIPT_CHUNK_BYTES, lineHash as agentLineHash, lineWeight, planTranscriptChunks } from '@crove/agent/member-vy';
import { TRANSCRIPT_TRANSLATE_CHUNK_BYTES } from '@crove/kernel-contract';
import { lineHash as moduleLineHash } from '@crove/mod-meetings';

describe('the module and the agent package agree on a transcript chunk', () => {
  it('has one chunk size and one hash of a line', () => {
    expect(TRANSCRIPT_TRANSLATE_CHUNK_BYTES).toBe(TRANSCRIPT_CHUNK_BYTES);
    for (const text of ['Giá 1.250.000 đồng', 'English line', '', 'Dòng có dấu: ắ ằ ẳ ẵ ặ và emoji 🙂']) expect(moduleLineHash(text)).toBe(agentLineHash(text));
  });

  it('weighs a line as the module does (the figure the status prices is the figure the run cuts by)', () => {
    // The module's own weight is private; the batch it picks is whole chunks of the same rule, which the database test of the run pins (every chunk one call, exactly). Here the rule's
    // constants: a line is its JSON string in UTF-8 bytes plus 14 for the numbering around it.
    expect(lineWeight('abc')).toBe(new TextEncoder().encode('"abc"').length + 14);
    expect(planTranscriptChunks([{ text: 'a' }]).length).toBe(1);
  });
});
