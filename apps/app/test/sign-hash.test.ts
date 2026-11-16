// SPDX-License-Identifier: AGPL-3.0-only
// Tests for URL fragment token parsing/scrubbing and offline Web Crypto SHA-256 hashing (#3325).
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SIGN_PAGE_PATH,
  SIGN_TOKEN_PATTERN,
  buildSigningUrl,
  forgetSignToken,
  hashFileSha256,
  pendingSignToken,
  readSignTokenFromHash,
  rememberSignToken,
  scrubSignTokenHash,
  sha256Hex,
} from '../src/lib/sign-hash.ts';

const VALID_TOKEN = 'crove_sign_test_token_aaaaaaaaaaaaaaaaaaaaa';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('sign token URL fragment security', () => {
  it('accepts strictly 43-char base64url tokens from #fragment and ignores malformed tokens', () => {
    expect(VALID_TOKEN).toHaveLength(43);
    expect(SIGN_TOKEN_PATTERN.test(VALID_TOKEN)).toBe(true);
    expect(readSignTokenFromHash(`#${VALID_TOKEN}`)).toBe(VALID_TOKEN);
    expect(readSignTokenFromHash(`  #${VALID_TOKEN}  `)).toBe(VALID_TOKEN);
    expect(readSignTokenFromHash('')).toBeNull();
    expect(readSignTokenFromHash('#too-short')).toBeNull();
    expect(readSignTokenFromHash(`#token=${VALID_TOKEN}`)).toBeNull();
    expect(readSignTokenFromHash(`#${VALID_TOKEN}/extra`)).toBeNull();
  });

  it('builds /-/sign#<token> URLs without ever putting the credential in query params', () => {
    const built = buildSigningUrl(VALID_TOKEN, 'https://app.example.com');
    const url = new URL(built);
    expect(url.pathname).toBe(SIGN_PAGE_PATH);
    expect(url.search).toBe('');
    expect(url.hash).toBe(`#${VALID_TOKEN}`);
  });

  it('scrubs window.location.hash immediately via history.replaceState', () => {
    const replaceState = vi.fn();
    vi.stubGlobal('window', {
      location: {
        pathname: '/-/sign',
        search: '',
        hash: `#${VALID_TOKEN}`,
      },
      history: { replaceState },
    });

    const token = readSignTokenFromHash();
    expect(token).toBe(VALID_TOKEN);
    scrubSignTokenHash();
    expect(replaceState).toHaveBeenCalledWith(null, '', '/-/sign');
  });

  it('does nothing on scrub when location hash is already empty', () => {
    const replaceState = vi.fn();
    vi.stubGlobal('window', {
      location: { pathname: '/-/sign', search: '', hash: '' },
      history: { replaceState },
    });

    scrubSignTokenHash();
    expect(replaceState).not.toHaveBeenCalled();
  });

  it('preserves existing history state when scrubbing location hash', () => {
    const replaceState = vi.fn();
    const stateObj = { idx: 2 };
    vi.stubGlobal('window', {
      location: { pathname: '/-/sign', search: '', hash: `#${VALID_TOKEN}` },
      history: { state: stateObj, replaceState },
    });

    scrubSignTokenHash();
    expect(replaceState).toHaveBeenCalledWith(stateObj, '', '/-/sign');
  });

  it('persists a scrubbed token in sessionStorage with a 15-minute TTL', () => {
    const store = new Map<string, string>();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-16T08:00:00.000Z'));
    vi.stubGlobal('window', {
      sessionStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
          store.set(key, value);
        },
        removeItem: (key: string) => {
          store.delete(key);
        },
      },
    });

    rememberSignToken('invalid');
    expect(pendingSignToken()).toBeNull();

    rememberSignToken(VALID_TOKEN);
    expect(pendingSignToken()).toBe(VALID_TOKEN);

    vi.advanceTimersByTime(16 * 60 * 1000);
    expect(pendingSignToken()).toBeNull();

    rememberSignToken(VALID_TOKEN);
    forgetSignToken();
    expect(pendingSignToken()).toBeNull();
    vi.useRealTimers();
  });
});

describe('offline Web Crypto SHA-256 verification', () => {
  it('computes identical SHA-256 digests to Node crypto without uploading bytes', async () => {
    const bytes = new TextEncoder().encode('%PDF-1.7 sealed sample document');
    const expected = createHash('sha256').update(bytes).digest('hex');

    await expect(sha256Hex(bytes)).resolves.toBe(expected);
    await expect(sha256Hex(bytes.buffer)).resolves.toBe(expected);

    const file = new File([bytes], 'hop-dong-da-ky.pdf', { type: 'application/pdf' });
    await expect(hashFileSha256(file)).resolves.toBe(expected);
  });
});
