// SPDX-License-Identifier: AGPL-3.0-only
// Unit checks for #4001 Slice 2 redaction contracts, marks, surface coverage, and runtime command definitions.
import { describe, expect, it } from 'vitest';
import {
  REDACTION_CANDIDATES_MAX,
  REDACTION_KINDS,
  REDACTION_MARK_BY_KIND,
  REDACTION_SELECTIONS_MAX,
  REDACTION_SURFACES,
  zRedactionCandidate,
  zRedactionSelection,
  zTranscriptRedact,
  zTranscriptRedactCandidates,
  zTranscriptRedacted,
} from '@ludy/kernel-contract';
import { kernelCommands } from '@ludy/kernel';
import { itemFlags, meetingsCommands, meetingsQueries } from '../src/index.ts';

const UUID_A = '01950000-0000-7000-8000-000000000001';
const UUID_B = '01950000-0000-7000-8000-000000000002';

describe('meetings redaction contracts and definitions (#4001 Slice 2)', () => {
  it('provides typed non-value marks carrying no digits or flagged contact patterns', () => {
    expect(Object.keys(REDACTION_MARK_BY_KIND).sort()).toEqual([...REDACTION_KINDS].sort());
    for (const kind of REDACTION_KINDS) {
      const mark = REDACTION_MARK_BY_KIND[kind];
      expect(mark.startsWith('[đã ẩn: '), mark).toBe(true);
      expect(mark.endsWith(']'), mark).toBe(true);
      expect(/\d/.test(mark), mark).toBe(false);
      expect(mark.includes('@'), mark).toBe(false);
      expect(itemFlags(mark), mark).toEqual([]);
    }
  });

  it('covers all draft publish surfaces and enforces decisionIndex rules cleanly', () => {
    expect(REDACTION_SURFACES).toEqual([
      'transcript_segment.text',
      'transcript_segment.speaker_label',
      'meeting_result.summary',
      'meeting_result.decision',
      'action_item.title',
      'action_item.who_drafted',
      'action_item.when_drafted',
      'meeting_chapter.title',
      'meeting.title',
    ]);

    expect(
      zRedactionSelection.safeParse({
        surface: 'meeting_result.decision',
        targetId: UUID_A,
        decisionIndex: 0,
        kind: 'phone',
        startPos: 1,
        version: '2026-11-22T00:00:00.000000Z',
      }).success,
    ).toBe(true);

    expect(
      zRedactionSelection.safeParse({
        surface: 'meeting_result.decision',
        targetId: UUID_A,
        decisionIndex: null,
        kind: 'phone',
        startPos: 1,
        version: '2026-11-22T00:00:00.000000Z',
      }).success,
    ).toBe(false);

    expect(
      zRedactionSelection.safeParse({
        surface: 'transcript_segment.text',
        targetId: UUID_A,
        decisionIndex: 0,
        kind: 'email',
        startPos: 1,
        version: '2026-11-22T00:00:00.000000Z',
      }).success,
    ).toBe(false);
  });

  it('requires explicit confirmation and non-empty bounded item selection', () => {
    const validItem = {
      surface: 'transcript_segment.text' as const,
      targetId: UUID_B,
      decisionIndex: null,
      kind: 'phone' as const,
      startPos: 5,
      version: '2026-11-22T00:00:00.000000Z',
    };

    expect(zTranscriptRedact.safeParse({ meetingId: UUID_A, confirmed: true, items: [validItem] }).success).toBe(true);
    expect(zTranscriptRedact.safeParse({ meetingId: UUID_A, confirmed: false, items: [validItem] }).success).toBe(false);
    expect(zTranscriptRedact.safeParse({ meetingId: UUID_A, items: [validItem] }).success).toBe(false);
    expect(zTranscriptRedact.safeParse({ meetingId: UUID_A, confirmed: true, items: [] }).success).toBe(false);
    expect(
      zTranscriptRedact.safeParse({
        meetingId: UUID_A,
        confirmed: true,
        items: Array.from({ length: REDACTION_SELECTIONS_MAX + 1 }, () => validItem),
      }).success,
    ).toBe(false);

    expect(
      zTranscriptRedactCandidates.safeParse({
        meetingId: UUID_A,
        titleEditable: true,
        candidates: [],
        truncated: false,
      }).success,
    ).toBe(true);
    expect(REDACTION_CANDIDATES_MAX).toBe(2000);

    expect(
      zTranscriptRedacted.safeParse({
        meetingId: UUID_A,
        redactedCount: 1,
        countsByKind: { email: 0, phone: 1, national_id: 0, tax_code: 0, bank_account: 0 },
        droppedVyResults: 1,
        cancelledVyRuns: 0,
        droppedTranslations: 1,
      }).success,
    ).toBe(true);
  });

  it('registers redact_candidates, redact, and kernel.member_vy.subject_results.drop with strict user-only risk bounds', () => {
    const candidatesQuery = meetingsQueries.find((q) => q.name === 'meetings.transcript.redact_candidates');
    expect(candidatesQuery).toBeDefined();
    expect(candidatesQuery?.sensitive).toBe(true);
    expect(candidatesQuery?.access).toEqual(['owner', 'admin', 'member']);
    expect('memberVy' in (candidatesQuery ?? {})).toBe(false);

    const redactCmd = meetingsCommands.find((c) => c.name === 'meetings.transcript.redact');
    expect(redactCmd).toBeDefined();
    expect(redactCmd?.risk).toBe('R1');
    expect(redactCmd?.sideEffect).toBe('internal');
    expect(redactCmd?.access).toEqual(['owner', 'admin', 'member']);
    expect('agent' in (redactCmd ?? {})).toBe(false);

    expect(
      zRedactionCandidate.safeParse({
        surface: 'transcript_segment.text',
        targetId: UUID_A,
        decisionIndex: null,
        kind: 'phone',
        startPos: 1_000_000,
        endPos: 1_000_010,
        matchText: '0912345678',
        mark: REDACTION_MARK_BY_KIND.phone,
        version: '2026-11-22T00:00:00.000000Z',
        startSeconds: 0,
      }).success,
    ).toBe(true);
    expect(
      zRedactionCandidate.safeParse({
        surface: 'transcript_segment.text',
        targetId: UUID_A,
        decisionIndex: null,
        kind: 'phone',
        startPos: 1_000_001,
        endPos: 1_000_011,
        matchText: '0912345678',
        mark: REDACTION_MARK_BY_KIND.phone,
        version: '2026-11-22T00:00:00.000000Z',
        startSeconds: 0,
      }).success,
    ).toBe(false);
    expect(
      zRedactionSelection.safeParse({
        surface: 'transcript_segment.text',
        targetId: UUID_A,
        decisionIndex: null,
        kind: 'phone',
        startPos: 1_000_001,
        version: '2026-11-22T00:00:00.000000Z',
      }).success,
    ).toBe(false);

    const dropCmd = kernelCommands.find((c) => c.name === 'kernel.member_vy.subject_results.drop');
    expect(dropCmd).toBeDefined();
    expect(dropCmd?.risk).toBe('R1');
    expect(dropCmd?.sideEffect).toBe('internal');
    expect(dropCmd?.access).toEqual(['owner', 'admin', 'member', 'viewer']);
    expect('memberVy' in (dropCmd ?? {})).toBe(false);
    expect(dropCmd?.input.safeParse({ subjectType: 'meeting', subjectId: UUID_A }).success).toBe(true);
    expect(dropCmd?.input.safeParse({ subjectType: 'meetings.meeting_1-a', subjectId: UUID_A }).success).toBe(true);
    expect(dropCmd?.input.safeParse({ subjectType: 'Meeting', subjectId: UUID_A }).success).toBe(false);
    expect(dropCmd?.input.safeParse({ subjectType: 'meeting free text', subjectId: UUID_A }).success).toBe(false);
    expect(dropCmd?.input.safeParse({ subjectType: '.meeting', subjectId: UUID_A }).success).toBe(false);
    expect(dropCmd?.input.safeParse({ subjectType: 'a'.repeat(101), subjectId: UUID_A }).success).toBe(false);
  });
});
