// SPDX-License-Identifier: AGPL-3.0-only
// The five intents are written three times: the database's (packages/db, which check-unions compares with the CHECK constraint), the contract's
// (packages/kernel-contract, which the screens and the schemas use) and the AI reader's (packages/agent, the labels the model may answer). The sizes of
// what one suggestion reads are written twice, in the contract (what the query returns) and in the reader (what the prompt keeps). All must stay equal.
import { describe, expect, it } from 'vitest';
import { INTENTS, INTENT_BATCH_MAX, INTENT_MESSAGES_MAX, INTENT_MESSAGE_CHARS } from '@crove/agent';
import { CONVERSATION_INTENTS as DB_INTENTS } from '@crove/db';
import { CONVERSATION_INTENT_BATCH_MAX, CONVERSATION_INTENT_CHARS, CONVERSATION_INTENT_MESSAGES, CONVERSATION_INTENTS } from '@crove/kernel-contract';

describe('the conversation intent sets (CV3, #2306)', () => {
  it('has one list of intents in the database package, the contract and the AI reader', () => {
    expect([...CONVERSATION_INTENTS]).toEqual([...DB_INTENTS]);
    expect([...INTENTS]).toEqual([...CONVERSATION_INTENTS]);
  });

  it('has one size of what a suggestion reads in the contract and the AI reader', () => {
    expect(CONVERSATION_INTENT_BATCH_MAX).toBe(INTENT_BATCH_MAX);
    expect(CONVERSATION_INTENT_MESSAGES).toBe(INTENT_MESSAGES_MAX);
    expect(CONVERSATION_INTENT_CHARS).toBe(INTENT_MESSAGE_CHARS);
  });
});
