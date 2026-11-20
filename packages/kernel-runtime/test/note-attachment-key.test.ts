// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { assertStorageKey, noteAttachmentKey } from '../src/storage.ts';

const ORG = '01a19b3a-2d5f-773b-a8ba-a1345bd79da7';

describe('noteAttachmentKey (#3561)', () => {
  it('formats notes/<orgId>/<attachmentId> and passes assertStorageKey', () => {
    const id = randomUUID();
    const key = noteAttachmentKey(ORG, id);
    expect(key).toBe(`notes/${ORG}/${id}`);
    expect(() => assertStorageKey(key)).not.toThrow();
  });

  it('refuses malformed, uppercase or traversal paths under notes/', () => {
    const id = randomUUID();
    for (const bad of [
      `notes/bad/${id}`,
      `notes/${ORG}/short`,
      `notes/${ORG}/${id.toUpperCase()}`,
      `notes/${ORG}/../${id}`,
      `notes/${ORG}/${id}/extra`,
      `note/${ORG}/${id}`,
    ]) {
      expect(() => assertStorageKey(bad), bad).toThrow('invalid storage key');
    }
  });
});
