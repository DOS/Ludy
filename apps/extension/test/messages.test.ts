// SPDX-License-Identifier: AGPL-3.0-only
// Who may message the worker and the offscreen document, and what a start request must look like.
import { describe, expect, it } from 'vitest';
import { isOwnSender, parseCaptureStart, parseStartRequest } from '../src/messages.ts';

const request = { title: 'Họp', consentMethod: 'told_at_start', consentAgreed: true, keepVideo: false, streamId: 'abc' };
const command = { target: 'offscreen', type: 'capture-start', address: 'https://app.ludy.vn', token: 'crx_t', orgId: 'o1', uploads: 'direct', ...request };

describe('sender check', () => {
  it('accepts only this extension\'s own id', () => {
    expect(isOwnSender({ id: 'me' }, 'me')).toBe(true);
    expect(isOwnSender({ id: 'other' }, 'me')).toBe(false);
    expect(isOwnSender({}, 'me')).toBe(false);
    expect(isOwnSender(undefined, 'me')).toBe(false);
    expect(isOwnSender(null, 'me')).toBe(false);
    // No own id to compare with is a refusal, not a match of two undefined values.
    expect(isOwnSender({ id: undefined }, undefined)).toBe(false);
    expect(isOwnSender({ id: '' }, '')).toBe(false);
  });
});

describe('start request', () => {
  it('takes a well-formed one', () => {
    expect(parseStartRequest(request)).toEqual(request);
  });

  it.each([
    ['a string "false" as the consent', { ...request, consentAgreed: 'false' }],
    ['a truthy string as the consent', { ...request, consentAgreed: 'yes' }],
    ['a number as keepVideo', { ...request, keepVideo: 1 }],
    ['a string as keepVideo', { ...request, keepVideo: 'false' }],
    ['a missing keepVideo', { ...request, keepVideo: undefined }],
    ['an empty stream id', { ...request, streamId: '' }],
    ['a non-string title', { ...request, title: 5 }],
    ['not an object', 'start'],
    ['null', null],
  ])('refuses %s', (_name, raw) => {
    expect(parseStartRequest(raw)).toBeNull();
  });

  it('is what the offscreen document also checks, with its own fields and a known consent method', () => {
    expect(parseCaptureStart(command)).toEqual(command);
    expect(parseCaptureStart({ ...command, consentAgreed: 'true' })).toBeNull();
    expect(parseCaptureStart({ ...command, keepVideo: 'false' })).toBeNull();
    expect(parseCaptureStart({ ...command, uploads: 'ftp' })).toBeNull();
    expect(parseCaptureStart({ ...command, consentMethod: 'verbally' })).toBeNull();
    expect(parseCaptureStart({ ...command, token: undefined })).toBeNull();
    expect(parseCaptureStart({ ...command, target: 'worker' })).toBeNull();
  });
});
