// SPDX-License-Identifier: AGPL-3.0-only
// Unit checks for bilingual .docx and follow-up contracts and helpers (#5225).
import { describe, expect, it } from 'vitest';
import {
  zFollowupDraft,
  zFollowupDraftAsk,
  zFollowupNoteAsk,
  zFollowupNoteStart,
  zFollowupSend,
  zFollowupWordingAsk,
  zMinutesDocxInput,
  zMinutesVersionSegments,
} from '@ludy/kernel-contract';
import { followupFixedWords } from '../src/followup.ts';

const MEETING_ID = '0198a0b4-3c5d-7e6f-8a9b-0c1d2e3f4a5b';

describe('bilingual docx and follow-up schemas (#5225)', () => {
  it('accepts optional vi/en language on zMinutesDocxInput and rejects unsupported tags', () => {
    expect(zMinutesDocxInput.parse({ meetingId: MEETING_ID })).toEqual({ meetingId: MEETING_ID, place: '' });
    expect(zMinutesDocxInput.parse({ meetingId: MEETING_ID, place: 'Room 1', language: 'en' })).toEqual({
      meetingId: MEETING_ID,
      place: 'Room 1',
      language: 'en',
    });
    expect(zMinutesDocxInput.safeParse({ meetingId: MEETING_ID, language: 'zh' }).success).toBe(false);
    expect(zMinutesDocxInput.safeParse({ meetingId: MEETING_ID, language: 'fr' }).success).toBe(false);
    expect(zMinutesVersionSegments.parse([{ key: 'summary', text: 'Agreed.' }])).toEqual([{ key: 'summary', text: 'Agreed.' }]);
    expect(zMinutesVersionSegments.safeParse([]).success).toBe(false);
  });

  it('accepts optional versionLanguage on follow-up asks and availableVersions on draft', () => {
    expect(zFollowupDraftAsk.parse({ meetingId: MEETING_ID, versionLanguage: 'en' })).toEqual({
      meetingId: MEETING_ID,
      versionLanguage: 'en',
    });
    expect(zFollowupWordingAsk.parse({ meetingId: MEETING_ID, stage: 'published', versionLanguage: 'vi', hint: 'brief' })).toEqual({
      meetingId: MEETING_ID,
      stage: 'published',
      versionLanguage: 'vi',
      hint: 'brief',
    });
    expect(zFollowupNoteStart.parse({ meetingId: MEETING_ID, versionLanguage: 'en' })).toEqual({
      meetingId: MEETING_ID,
      versionLanguage: 'en',
    });
    expect(zFollowupNoteAsk.parse({ meetingId: MEETING_ID, versionLanguage: 'en' })).toEqual({
      meetingId: MEETING_ID,
      versionLanguage: 'en',
    });
    expect(zFollowupDraftAsk.safeParse({ meetingId: MEETING_ID, versionLanguage: 'ja' }).success).toBe(false);

    const parsedDraft = zFollowupDraft.parse({
      meetingId: MEETING_ID,
      lang: 'en',
      org: 'Acme',
      stage: 'published',
      hasPublished: true,
      hasDraft: false,
      availableVersions: ['en'],
      factsKey: 'abc',
      facts: { summary: 'Agreed.', decisions: [], items: [] },
      words: followupFixedWords('en', '2026-11-24'),
      recipients: [],
      sendsLeft: 3,
    });
    expect(parsedDraft.availableVersions).toEqual(['en']);

    const parsedSend = zFollowupSend.parse({
      meetingId: MEETING_ID,
      versionLanguage: 'en',
      factsKey: 'abc',
      subject: 'Meeting summary',
      greeting: 'Hello,',
      lead: 'Thank you.',
      closing: 'Best regards.',
      recipients: ['a@example.com'],
      confirmedOutsiders: [],
      confirmRepeat: false,
      fromVy: false,
      reviewed: false,
    });
    expect(parsedSend.versionLanguage).toBe('en');
  });

  it('builds localized fixed words for Vietnamese and English', () => {
    expect(followupFixedWords('vi', '2026-11-24')).toMatchObject({
      subject: 'Tóm tắt cuộc họp 24/11/2026',
      greeting: 'Xin chào,',
    });
    expect(followupFixedWords('en', '2026-11-24')).toEqual({
      subject: 'Meeting summary, 2026-11-24',
      greeting: 'Hello,',
      lead: 'Thank you for your time in the meeting. Below are the summary, the decisions and the action items from it.',
      closing: 'If anything looks wrong, please let me know. Thank you.',
    });
  });
});
