// SPDX-License-Identifier: AGPL-3.0-only
// The recording notice the popup shows is the version the server stores (Meetings A1, #3159): one text file, one version,
// and the server refuses a version it does not know.
import { describe, expect, it } from 'vitest';
import { CONSENT_NOTICE_VERSION, KNOWN_CONSENT_NOTICE_VERSIONS, RECORDING_STOP_REASONS as CONTRACT_REASONS, zMeetingCreate } from '@crove/kernel-contract';
import { RECORDING_NOTICE, RECORDING_STOP_REASONS, noticeToCopy } from '@crove/meeting-recorder';
import { consentBlocker } from '../src/consent.ts';
import { ENGLISH, VIETNAMESE } from '../src/strings.ts';

const base = { title: 'Họp', consentMethod: 'in_call_chat' } as const;

describe('recording notice in the popup', () => {
  it('the text copied carries the version the server stores', () => {
    expect(RECORDING_NOTICE.version).toBe(CONSENT_NOTICE_VERSION);
    expect(KNOWN_CONSENT_NOTICE_VERSIONS).toContain(noticeToCopy('vi').version);
    expect(noticeToCopy('en').version).toBe(CONSENT_NOTICE_VERSION);
  });

  it('the server accepts the shipped version and the new method, and refuses an unknown version', () => {
    expect(zMeetingCreate.safeParse({ ...base, consentNoticeVersion: RECORDING_NOTICE.version }).success).toBe(true);
    expect(zMeetingCreate.safeParse(base).success).toBe(true);
    expect(zMeetingCreate.safeParse({ ...base, consentNoticeVersion: '1999-01-v9' }).success).toBe(false);
  });

  it('pasting the notice in the call chat is a method, but the confirmation is still needed', () => {
    expect(consentBlocker({ title: 'Họp', consentMethod: 'in_call_chat', consentAgreed: true })).toBeNull();
    expect(consentBlocker({ title: 'Họp', consentMethod: 'in_call_chat', consentAgreed: false })).toBe('consentAgreed');
  });

  it('the stop reason codes of the recorder are the ones the server accepts, and each has words in both languages', () => {
    expect([...RECORDING_STOP_REASONS]).toEqual([...CONTRACT_REASONS]);
    for (const strings of [ENGLISH, VIETNAMESE]) expect(Object.keys(strings.lostReasons).sort()).toEqual([...CONTRACT_REASONS].sort());
  });

  it('both languages of the popup label the draft status and the copy button', () => {
    for (const strings of [ENGLISH, VIETNAMESE]) {
      expect(strings.noticeDraft).toContain('#2585');
      expect(strings.noticeCopy.length).toBeGreaterThan(0);
      expect(strings.consentMethods.in_call_chat.length).toBeGreaterThan(0);
    }
  });
});
