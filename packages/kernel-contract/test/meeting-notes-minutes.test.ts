// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  NOTES_MINUTES_DECISIONS_MAX,
  NOTES_MINUTES_ESTIMATE,
  NOTES_MINUTES_ITEMS_MAX,
  NOTES_MINUTES_LINES_MAX,
  NOTES_MINUTES_SUMMARY_MAX,
  contract,
  zNotesMinutesAnswer,
  zNotesMinutesFacts,
  zNotesMinutesStarted,
  zNotesMinutesStatus,
} from '../src/index.ts';

const MEETING_ID = '11111111-1111-4111-8111-111111111111';
const RUN_ID = '22222222-2222-4222-8222-222222222222';

describe('meeting notes minutes contract (#5129)', () => {
  it('exposes the meetings.notesMinutes status and write procedures', () => {
    expect(contract.meetings.notesMinutes.status).toBeDefined();
    expect(contract.meetings.notesMinutes.write).toBeDefined();
    expect(NOTES_MINUTES_SUMMARY_MAX).toBe(1200);
    expect(NOTES_MINUTES_DECISIONS_MAX).toBe(20);
    expect(NOTES_MINUTES_ITEMS_MAX).toBe(20);
    expect(NOTES_MINUTES_LINES_MAX).toBe(6000);
    expect(NOTES_MINUTES_ESTIMATE).toEqual({ inputTokens: 1800, outputTokens: 600 });
  });

  it('validates status with every reason code and strict extra-key rejection', () => {
    for (const reason of [null, 'not_recorder', 'has_transcript', 'no_notes', 'redacted', 'off', 'forbidden', 'paused', 'budget'] as const) {
      expect(
        zNotesMinutesStatus.parse({
          meetingId: MEETING_ID,
          available: reason === null,
          reason,
          estimate: reason === null ? { inputTokens: 1800, outputTokens: 600, cost: '0.000630' } : null,
        }),
      ).toMatchObject({ reason, available: reason === null });
    }
    expect(() =>
      zNotesMinutesStatus.parse({
        meetingId: MEETING_ID,
        available: true,
        reason: null,
        estimate: { inputTokens: 1800, outputTokens: 600, cost: null },
        extra: 'rejected',
      }),
    ).toThrow();
  });

  it('validates drafted, none, and failed answer states and enforces 1-based noteLine citations', () => {
    const drafted = zNotesMinutesAnswer.parse({
      state: 'drafted',
      errorCode: null,
      summary: 'Chot ke hoach ban hang quy 4.',
      decisions: [{ text: 'Tang ngan sach 10%.', noteLine: 2 }],
      items: [{ title: 'Gui bao gia', who: 'Lan', when: 'thu Sau', noteLine: 3 }],
      dropped: 1,
    });
    expect(drafted.decisions[0]?.noteLine).toBe(2);
    expect(drafted.items[0]?.noteLine).toBe(3);

    expect(
      zNotesMinutesAnswer.parse({
        state: 'failed',
        errorCode: 'NOTES_MINUTES_FAILED',
        summary: '',
        decisions: [],
        items: [],
        dropped: 0,
      }).state,
    ).toBe('failed');

    expect(() =>
      zNotesMinutesAnswer.parse({
        state: 'drafted',
        errorCode: null,
        summary: 'Tom tat.',
        decisions: [{ text: 'Quyet dinh', noteLine: 0 }],
        items: [],
        dropped: 0,
      }),
    ).toThrow();
  });

  it('validates facts and started payloads strictly', () => {
    const facts = zNotesMinutesFacts.parse({
      meetingId: MEETING_ID,
      language: 'vi',
      noteLines: ['Hop chot gia Q4', 'Lan gui bao gia truoc thu Sau'],
      attendees: ['Lan', 'Minh'],
      glossary: ['Ludy'],
    });
    expect(facts.noteLines).toHaveLength(2);
    expect(() => zNotesMinutesFacts.parse({ ...facts, noteLines: [] })).toThrow();
    expect(zNotesMinutesStarted.parse({ meetingId: MEETING_ID, runId: RUN_ID })).toEqual({ meetingId: MEETING_ID, runId: RUN_ID });
  });
});
