// SPDX-License-Identifier: AGPL-3.0-only
// The default allow-list of extension ids (#3010): the Chrome Web Store build, and nothing else.
import { describe, expect, it } from 'vitest';
import { DEFAULT_EXTENSION_IDS, EXTENSION_ID_FORMAT, zExtensionId } from '../src/index.ts';

const STORE_ID = 'emfhpcbmdbbeomfkdadbellllngmlhmf';

describe('DEFAULT_EXTENSION_IDS', () => {
  it('holds exactly the Chrome Web Store id, which is a well-formed extension id', () => {
    expect(DEFAULT_EXTENSION_IDS).toEqual([STORE_ID]);
    expect(EXTENSION_ID_FORMAT.test(STORE_ID)).toBe(true);
    expect(zExtensionId.safeParse(STORE_ID).success).toBe(true);
  });

  it('does not list an id of an unpacked or look-alike extension', () => {
    expect(DEFAULT_EXTENSION_IDS.includes('a'.repeat(32))).toBe(false);
    expect(DEFAULT_EXTENSION_IDS.includes(STORE_ID.toUpperCase())).toBe(false);
    expect(DEFAULT_EXTENSION_IDS.includes(`${STORE_ID.slice(0, 31)}a`)).toBe(false);
  });

  it('is frozen, so no code can add an id at runtime', () => {
    expect(Object.isFrozen(DEFAULT_EXTENSION_IDS)).toBe(true);
  });
});
