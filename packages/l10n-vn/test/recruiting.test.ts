// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests for pure recruiting pipeline checks, decimal-safe readiness evaluation, and interview slot ranking (#3413).
import { describe, expect, it } from 'vitest';
import {
  RECRUITING_STAGES,
  checkCandidateTransition,
  evaluateCandidateReadiness,
  isRecruitingStage,
  rankInterviewSlots,
} from '../src/index.ts';

describe('RECRUITING_STAGES & checkCandidateTransition', () => {
  it('defines the canonical six-stage recruiting pipeline', () => {
    expect(RECRUITING_STAGES).toEqual(['applied', 'screening', 'interview', 'offer', 'hired', 'rejected']);
    expect(isRecruitingStage('screening')).toBe(true);
    expect(isRecruitingStage('unknown')).toBe(false);
  });

  it('allows normal transitions between active stages and to rejected', () => {
    expect(checkCandidateTransition({ from: 'applied', to: 'screening' })).toEqual({
      allowed: true,
      warnings: [],
      errors: [],
      warningCodes: [],
      errorCodes: [],
    });
    expect(checkCandidateTransition({ from: 'applied', to: 'interview' }).allowed).toBe(true);
    expect(checkCandidateTransition({ from: 'interview', to: 'screening' }).allowed).toBe(true);
    expect(checkCandidateTransition({ from: 'offer', to: 'rejected' }).allowed).toBe(true);
    expect(checkCandidateTransition({ from: 'applied', to: 'rejected' }).allowed).toBe(true);
  });

  it('warns on missing interview when moving to offer, and clears warning when scheduled', () => {
    const withoutInterview = checkCandidateTransition({
      from: 'screening',
      to: 'offer',
      hasScheduledInterview: false,
    });
    expect(withoutInterview.allowed).toBe(true);
    expect(withoutInterview.errorCodes).toEqual([]);
    expect(withoutInterview.warningCodes).toEqual(['missing_interview_before_offer']);
    expect(withoutInterview.warnings[0]?.messageVi).toBeTruthy();

    const withInterview = checkCandidateTransition({
      from: 'interview',
      to: 'offer',
      hasScheduledInterview: true,
    });
    expect(withInterview.allowed).toBe(true);
    expect(withInterview.warningCodes).toEqual([]);
  });

  it('enforces offer stage, positive agreedWage, and valid startDate before hiring', () => {
    const directBlocked = checkCandidateTransition({
      from: 'interview',
      to: 'hired',
      agreedWage: '15000000',
      startDate: '2026-12-01',
    });
    expect(directBlocked.allowed).toBe(false);
    expect(directBlocked.errorCodes).toEqual(['invalid_stage_transition']);

    const missingTerms = checkCandidateTransition({
      from: 'offer',
      to: 'hired',
      agreedWage: '0',
      startDate: '2026-02-30',
    });
    expect(missingTerms.allowed).toBe(false);
    expect(missingTerms.errorCodes).toEqual(['missing_agreed_wage_for_hire', 'missing_start_date_for_hire']);

    const validHire = checkCandidateTransition({
      from: 'offer',
      to: 'hired',
      agreedWage: '15000000',
      startDate: '2026-12-01',
    });
    expect(validHire.allowed).toBe(true);
    expect(validHire.errorCodes).toEqual([]);

    const directOverride = checkCandidateTransition({
      from: 'screening',
      to: 'hired',
      allowDirectHire: true,
      hasScheduledInterview: false,
      agreedWage: '12000000',
      startDate: '2026-12-15',
    });
    expect(directOverride.allowed).toBe(true);
    expect(directOverride.warningCodes).toEqual(['direct_hire_without_offer', 'missing_interview_before_offer']);
  });

  it('treats hired as terminal, blocks hiring from rejected, and gates reopening rejected', () => {
    expect(checkCandidateTransition({ from: 'hired', to: 'rejected' }).errorCodes).toEqual(['invalid_stage_transition']);
    expect(checkCandidateTransition({ from: 'hired', to: 'offer' }).errorCodes).toEqual(['invalid_stage_transition']);
    expect(checkCandidateTransition({ from: 'applied', to: 'applied' }).errorCodes).toEqual(['invalid_stage_transition']);

    expect(
      checkCandidateTransition({
        from: 'rejected',
        to: 'hired',
        allowDirectHire: true,
        agreedWage: '15000000',
        startDate: '2026-12-01',
      }).errorCodes,
    ).toEqual(['invalid_stage_transition']);

    expect(checkCandidateTransition({ from: 'rejected', to: 'applied' }).errorCodes).toEqual(['invalid_stage_transition']);
    const reopened = checkCandidateTransition({ from: 'rejected', to: 'screening', allowReopen: true });
    expect(reopened.allowed).toBe(true);
    expect(reopened.warningCodes).toEqual(['reopened_from_rejected']);
    expect(checkCandidateTransition({ from: 'rejected', to: 'offer', allowReopen: true }).errorCodes).toEqual([
      'invalid_stage_transition',
    ]);
  });
});

describe('evaluateCandidateReadiness', () => {
  it('compares wages strictly with Decimal precision without float loss', () => {
    const slightlyAbove = evaluateCandidateReadiness({
      stage: 'screening',
      roleTitle: 'Kế toán tổng hợp',
      yearsExperience: 3,
      skillsMatchedCount: 4,
      skillsRequiredCount: 4,
      hasNotes: true,
      expectedWage: '15000000.0001',
      budgetMinWage: '12000000',
      budgetMaxWage: '15000000',
    });
    expect(slightlyAbove.wageComparison).toBe('above_budget');
    expect(slightlyAbove.wageVariance).toBe('0.0001');
    expect(slightlyAbove.flags).toEqual(['above_budget']);

    const slightlyBelow = evaluateCandidateReadiness({
      stage: 'screening',
      roleTitle: 'Kế toán tổng hợp',
      yearsExperience: 2,
      skillsMatchedCount: 3,
      skillsRequiredCount: 4,
      hasNotes: false,
      expectedWage: '11999999.9999',
      budgetMinWage: '12000000',
      budgetMaxWage: '15000000',
    });
    expect(slightlyBelow.wageComparison).toBe('below_budget');
    expect(slightlyBelow.wageVariance).toBe('0.0001');
    expect(slightlyBelow.flags).toEqual(['below_budget', 'skills_gap']);
    expect(slightlyBelow.missingSkillsCount).toBe(1);

    const exactBound = evaluateCandidateReadiness({
      stage: 'interview',
      hasScheduledInterview: true,
      skillsMatchedCount: 3,
      skillsRequiredCount: 3,
      hasNotes: true,
      expectedWage: '15000000.00',
      budgetMinWage: '12000000',
      budgetMaxWage: '15000000',
    });
    expect(exactBound.wageComparison).toBe('within_budget');
    expect(exactBound.wageVariance).toBe('0');
    expect(exactBound.flags).toEqual(['within_budget']);
  });

  it('flags missing expected wage, missing interview, missing offer terms, and emits 3..5 focus questions', () => {
    const offerIncomplete = evaluateCandidateReadiness({
      stage: 'offer',
      roleTitle: 'Backend Engineer',
      skillsMatchedCount: 2,
      skillsRequiredCount: 5,
      hasNotes: false,
      hasScheduledInterview: false,
      expectedWage: null,
      budgetMinWage: '20000000',
      budgetMaxWage: '30000000',
      agreedWage: null,
      startDate: null,
    });
    expect(offerIncomplete.flags).toEqual([
      'missing_expected_wage',
      'skills_gap',
      'missing_interview',
      'missing_offer_terms',
    ]);
    expect(offerIncomplete.focusQuestions.length).toBeGreaterThanOrEqual(3);
    expect(offerIncomplete.focusQuestions.length).toBeLessThanOrEqual(5);
    expect(offerIncomplete.focusQuestions.map((q) => q.code)).toContain('verify_skills_gap');
    expect(offerIncomplete.focusQuestions.map((q) => q.code)).toContain('confirm_expected_compensation');
    for (const q of offerIncomplete.focusQuestions) {
      expect(q.vi.length).toBeGreaterThan(10);
      expect(q.en.length).toBeGreaterThan(10);
    }

    const offerReady = evaluateCandidateReadiness({
      stage: 'offer',
      roleTitle: 'Backend Engineer',
      skillsMatchedCount: 5,
      skillsRequiredCount: 5,
      hasNotes: true,
      hasScheduledInterview: true,
      expectedWage: '25000000',
      budgetMinWage: '20000000',
      budgetMaxWage: '30000000',
      agreedWage: '25000000',
      startDate: '2026-12-01',
    });
    expect(offerReady.flags).toEqual(['within_budget']);
    expect(offerReady.focusQuestions.length).toBeGreaterThanOrEqual(3);
  });

  it('rejects inverted budget range or invalid money string', () => {
    expect(() =>
      evaluateCandidateReadiness({
        stage: 'applied',
        expectedWage: '10000000',
        budgetMinWage: '20000000',
        budgetMaxWage: '15000000',
      }),
    ).toThrow(/budgetMinWage/);

    expect(() =>
      evaluateCandidateReadiness({
        stage: 'applied',
        expectedWage: 'abc',
      }),
    ).toThrow(/not a decimal amount/);
  });
});

describe('rankInterviewSlots', () => {
  it('subtracts busy intervals with minGapMinutes and returns non-overlapping sorted slots', () => {
    const slots = rankInterviewSlots({
      workingWindows: [
        { startIso: '2026-11-17T01:00:00.000Z', endIso: '2026-11-17T05:00:00.000Z' }, // 08:00..12:00 +07:00
        { startIso: '2026-11-17T06:30:00.000Z', endIso: '2026-11-17T10:00:00.000Z' }, // 13:30..17:00 +07:00
      ],
      busyIntervals: [
        { startIso: '2026-11-17T02:00:00.000Z', endIso: '2026-11-17T02:45:00.000Z' }, // 09:00..09:45 +07:00
      ],
      durationMinutes: 60,
      minGapMinutes: 15,
      maxSlots: 6,
    });

    // 08:00..08:45 (45m) cannot fit 60m; next free starts at 02:45Z + 15m = 03:00Z
    expect(slots).toEqual([
      { startIso: '2026-11-17T03:00:00.000Z', endIso: '2026-11-17T04:00:00.000Z' },
      { startIso: '2026-11-17T06:30:00.000Z', endIso: '2026-11-17T07:30:00.000Z' },
      { startIso: '2026-11-17T07:45:00.000Z', endIso: '2026-11-17T08:45:00.000Z' },
      { startIso: '2026-11-17T09:00:00.000Z', endIso: '2026-11-17T10:00:00.000Z' },
    ]);
  });

  it('ranks preferred wall-clock window slots first without producing overlapping fallback slots', () => {
    const slots = rankInterviewSlots({
      workingWindows: [
        { startIso: '2026-11-17T01:00:00.000Z', endIso: '2026-11-17T10:00:00.000Z' }, // 08:00..17:00 +07:00
      ],
      busyIntervals: [
        { startIso: '2026-11-17T03:00:00.000Z', endIso: '2026-11-17T04:00:00.000Z' }, // 10:00..11:00 +07:00
      ],
      durationMinutes: 60,
      minGapMinutes: 15,
      maxSlots: 4,
      preferredWindow: {
        timeZone: 'Asia/Ho_Chi_Minh',
        startMinute: 14 * 60,
        endMinute: 17 * 60,
      },
    });

    expect(slots).toEqual([
      { startIso: '2026-11-17T07:00:00.000Z', endIso: '2026-11-17T08:00:00.000Z' },
      { startIso: '2026-11-17T08:15:00.000Z', endIso: '2026-11-17T09:15:00.000Z' },
      { startIso: '2026-11-17T01:00:00.000Z', endIso: '2026-11-17T02:00:00.000Z' },
      { startIso: '2026-11-17T04:15:00.000Z', endIso: '2026-11-17T05:15:00.000Z' },
    ]);
  });

  it('respects afterIso, stepMinutes grid alignment, and handles DST transitions accurately', () => {
    // 2026-03-08 in America/New_York springs forward at 02:00 EST -> 03:00 EDT (UTC-5 -> UTC-4).
    const dstSlots = rankInterviewSlots({
      workingWindows: [
        { startIso: '2026-03-08T06:00:00.000Z', endIso: '2026-03-08T16:00:00.000Z' },
      ],
      durationMinutes: 45,
      stepMinutes: 30,
      minGapMinutes: 15,
      afterIso: '2026-03-08T12:40:00.000Z',
      preferredWindow: {
        timeZone: 'America/New_York',
        startMinute: 10 * 60, // 10:00 EDT = 14:00Z (not 15:00Z)
        endMinute: 12 * 60,
      },
      maxSlots: 3,
    });

    expect(dstSlots).toEqual([
      { startIso: '2026-03-08T14:00:00.000Z', endIso: '2026-03-08T14:45:00.000Z' },
      { startIso: '2026-03-08T15:00:00.000Z', endIso: '2026-03-08T15:45:00.000Z' },
      { startIso: '2026-03-08T13:00:00.000Z', endIso: '2026-03-08T13:45:00.000Z' },
    ]);

    // 2026-11-01 in America/New_York falls back at 02:00 EDT -> 01:00 EST (UTC-4 -> UTC-5).
    const fallBackSlots = rankInterviewSlots({
      workingWindows: [
        { startIso: '2026-11-01T13:00:00.000Z', endIso: '2026-11-01T16:00:00.000Z' }, // 08:00..11:00 EST
      ],
      durationMinutes: 60,
      preferredWindow: {
        timeZone: 'America/New_York',
        startMinute: 9 * 60, // 09:00 EST = 14:00Z
        endMinute: 11 * 60,
      },
      maxSlots: 2,
    });
    expect(fallBackSlots).toEqual([
      { startIso: '2026-11-01T14:00:00.000Z', endIso: '2026-11-01T15:00:00.000Z' },
      { startIso: '2026-11-01T15:00:00.000Z', endIso: '2026-11-01T16:00:00.000Z' },
    ]);
  });

  it('skips malformed or inverted intervals cleanly and rejects invalid numeric options', () => {
    const slots = rankInterviewSlots({
      workingWindows: [
        { startIso: 'not-a-timestamp', endIso: '2026-11-17T03:00:00.000Z' },
        { startIso: '2026-02-30T01:00:00.000Z', endIso: '2026-02-30T03:00:00.000Z' },
        { startIso: '2026-11-17T05:00:00.000Z', endIso: '2026-11-17T04:00:00.000Z' },
        { startIso: '2026-11-17T02:00:00.000Z', endIso: '2026-11-17T03:00:00.000Z' },
      ],
      busyIntervals: [
        { startIso: '2026-11-17T04:00:00.000Z', endIso: '2026-11-17T01:00:00.000Z' }, // inverted, ignored
        { startIso: 'bad', endIso: 'bad' },
      ],
      durationMinutes: 60,
    });
    expect(slots).toEqual([{ startIso: '2026-11-17T02:00:00.000Z', endIso: '2026-11-17T03:00:00.000Z' }]);

    expect(() =>
      rankInterviewSlots({ workingWindows: [], durationMinutes: 10 }),
    ).toThrow(RangeError);
    expect(() =>
      rankInterviewSlots({ workingWindows: [], durationMinutes: 245 }),
    ).toThrow(RangeError);
    expect(() =>
      rankInterviewSlots({ workingWindows: [], durationMinutes: 30.5 }),
    ).toThrow(RangeError);
    expect(() =>
      rankInterviewSlots({ workingWindows: [], durationMinutes: 30, afterIso: 'not-iso' }),
    ).toThrow(RangeError);
  });
});
