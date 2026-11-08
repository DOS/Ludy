// SPDX-License-Identifier: AGPL-3.0-only
// The blob key of a customer's image of a conversation message (CV5c, #2357): under the org's id and a random id of its own, never a content
// address, and a key every store accepts to write and delete.
import { describe, expect, it } from 'vitest';
import { assertStorageKey, conversationKey, newConversationBlobId } from '../src/storage.ts';

const ORG = '01a19b3a-2d5f-773b-a8ba-a1345bd79da7';

describe('conversationKey', () => {
  it('is conversation/<org id>/<64 hex>, accepted by the store, and different every time', () => {
    const a = newConversationBlobId();
    const b = newConversationBlobId();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
    expect(conversationKey(ORG, a)).toBe(`conversation/${ORG}/${a}`);
    expect(() => assertStorageKey(conversationKey(ORG, a))).not.toThrow();
  });

  it('refuses a key that is not that shape, so nothing else can be written or deleted under the prefix', () => {
    for (const key of ['conversation/x/' + 'a'.repeat(64), `conversation/${ORG}/short`, `conversation/${ORG}/${'A'.repeat(64)}`, `conversation/${ORG}/../${'a'.repeat(64)}`, `conversation/${ORG}/${'a'.repeat(64)}/x`, `conversations/${ORG}/${'a'.repeat(64)}`]) {
      expect(() => assertStorageKey(key), key).toThrow('invalid storage key');
    }
  });
});
