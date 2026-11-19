// SPDX-License-Identifier: AGPL-3.0-only
// A request that got no answer shows the catalog's network message, never the browser's "Failed to fetch" (#3593, AU-2).
import { AuthApiError, AuthRetryableFetchError } from '@supabase/auth-js';
import { describe, expect, it } from 'vitest';
import { translatorFor } from '../src/i18n/runtime.ts';
import { describeError } from '../src/lib/errors.ts';
import { isNetworkFailure } from '../src/lib/network-error.ts';
import { screenFailure, screenFailureText, thrownFailure } from '../src/lib/screen-failure.ts';

const vi = translatorFor('vi');
const en = translatorFor('en');

describe('isNetworkFailure', () => {
  it.each(['Failed to fetch', 'Load failed', 'NetworkError when attempting to fetch resource.', 'fetch failed'])('a TypeError "%s"', (message) => {
    expect(isNetworkFailure(new TypeError(message))).toBe(true);
  });

  it('the error auth-js returns when its request got no answer', () => {
    expect(isNetworkFailure(new AuthRetryableFetchError('Failed to fetch', 0))).toBe(true);
  });

  it('not a gateway that answered, a refusal, or any other error', () => {
    expect(isNetworkFailure(new AuthRetryableFetchError('Bad Gateway', 502))).toBe(false);
    expect(isNetworkFailure(new AuthApiError('Invalid login credentials', 400, 'invalid_credentials'))).toBe(false);
    expect(isNetworkFailure(new Error('Failed to fetch'))).toBe(false);
    expect(isNetworkFailure(new TypeError('x is not a function'))).toBe(false);
    expect(isNetworkFailure(null)).toBe(false);
    expect(isNetworkFailure('Failed to fetch')).toBe(false);
  });
});

describe('the network failure in words', () => {
  it('maps a thrown TypeError: Failed to fetch to the catalog string, in both languages', () => {
    const thrown = new TypeError('Failed to fetch');
    expect(describeError(thrown, vi, 'vi')).toBe('Không kết nối được máy chủ. Thử lại sau ít phút.');
    expect(describeError(thrown, en, 'en')).toBe('Could not reach the server. Try again in a few minutes.');
    expect(describeError(thrown, vi, 'vi')).toBe(vi('common.networkError'));
  });

  it('words the failure of a sign-in call at render, so a language switch rewords it', () => {
    const failure = screenFailure(new AuthRetryableFetchError('Failed to fetch', 0));
    expect(failure).toEqual({ network: true });
    expect(screenFailureText(failure, vi)).toBe('Không kết nối được máy chủ. Thử lại sau ít phút.');
    expect(screenFailureText(failure, en)).toBe('Could not reach the server. Try again in a few minutes.');
  });

  it('keeps the wording of what Supabase Auth did answer', () => {
    expect(screenFailureText(screenFailure(new AuthApiError('Invalid login credentials', 400, 'invalid_credentials')), vi)).toBe('Email hoặc mật khẩu không đúng');
    expect(screenFailureText(screenFailure({ message: 'A server message' }), en)).toBe('A server message');
  });

  it('shows a call that threw as the network message or a generic one, never its text', () => {
    expect(screenFailureText(thrownFailure(new TypeError('Failed to fetch')), en)).toBe(en('common.networkError'));
    const secret = new Error('GET https://internal.example/auth?token=abc123 failed');
    const shown = screenFailureText(thrownFailure(secret), en);
    expect(shown).toBe(en('auth.errors.unexpected_failure'));
    expect(shown).not.toContain('abc123');
  });
});
