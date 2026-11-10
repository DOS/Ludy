// SPDX-License-Identifier: AGPL-3.0-only
// The codes a background run of a member's Vy closes under (#2822 part 3b): the kernel's list, the database's list and what the transcribe worker emits are one
// list, so a real failure is never refused by the definer and left running. No database: the migration is read as text.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MEMBER_VY_RUN_ERROR_CODES } from '@crove/kernel';
import { AiBudgetExhaustedError, TranscriptionError } from '@crove/agent';
import { DomainError } from '@crove/kernel-runtime';
import { failureCode } from '../src/meetings-transcribe.ts';

const MIGRATION = fileURLToPath(new URL('../../../supabase/migrations/20261213010000_crove_kernel_member_vy_run_finish_derive.sql', import.meta.url));
const KINDS = ['auth', 'rate_limit', 'unavailable', 'invalid_request', 'invalid_response', 'timeout', 'network'] as const;

function databaseList(): string[] {
  const sql = readFileSync(MIGRATION, 'utf8');
  const body = /member_vy_run_error_code_ok\(p_code text\)[\s\S]*?ARRAY\[([^\]]*)\]/.exec(sql)?.[1] ?? '';
  return [...body.matchAll(/'([A-Z0-9_]+)'/g)].map((m) => m[1] as string);
}

describe('the codes a member Vy run closes under', () => {
  it('the database list is exactly the kernel list', () => {
    expect([...databaseList()].sort()).toEqual([...MEMBER_VY_RUN_ERROR_CODES].sort());
    expect(new Set(MEMBER_VY_RUN_ERROR_CODES).size).toBe(MEMBER_VY_RUN_ERROR_CODES.length);
  });

  it('every code failureCode emits is on the list, for each error it knows and for ones it does not', () => {
    const errors: unknown[] = [
      new AiBudgetExhaustedError('org', null),
      ...KINDS.map((kind) => new TranscriptionError(kind)),
      ...['KILL_SWITCH_ON', 'BUDGET_EXHAUSTED', 'TRANSCRIPT_EMPTY', 'TRANSCRIPT_TOO_LONG', 'AUDIO_NOT_FOUND', 'MEDIA_KEY_UNAVAILABLE', 'MEDIA_KEY_SHREDDED', 'MEETING_NOT_FOUND', 'MEETING_NO_AUDIO', 'FORBIDDEN', 'MEMBER_NOT_ACTIVE', 'VY_NOT_ALLOWED', 'AGENT_RUN_NOT_LIVE', 'TRANSCRIPT_RESULT_INVALID'].map(
        (code) => new DomainError(code, 422, 'x'),
      ),
      new DomainError('SOMETHING_NOBODY_LISTED', 422, 'x'),
      new Error('Gọi anh Nam 0909123456'),
      'a string',
      null,
    ];
    for (const error of errors) expect(MEMBER_VY_RUN_ERROR_CODES as readonly string[], String(error)).toContain(failureCode(error));
  });

  it('the words a person can act on pass through, the stops are mapped, and what has no word is TRANSCRIBE_FAILED', () => {
    expect(failureCode(new DomainError('TRANSCRIPT_EMPTY', 422, 'x'))).toBe('TRANSCRIPT_EMPTY');
    expect(failureCode(new DomainError('TRANSCRIPT_TOO_LONG', 422, 'x'))).toBe('TRANSCRIPT_TOO_LONG');
    expect(failureCode(new DomainError('MEDIA_KEY_SHREDDED', 422, 'x'))).toBe('MEDIA_KEY_SHREDDED');
    expect(failureCode(new DomainError('KILL_SWITCH_ON', 422, 'x'))).toBe('AI_STOPPED');
    expect(failureCode(new DomainError('BUDGET_EXHAUSTED', 422, 'x'))).toBe('AI_BUDGET_EXHAUSTED');
    expect(failureCode(new TranscriptionError('rate_limit'))).toBe('TRANSCRIBE_RATE_LIMIT');
    expect(failureCode(new DomainError('SOMETHING_NOBODY_LISTED', 422, 'x'))).toBe('TRANSCRIBE_FAILED');
    expect(failureCode(new Error('free text'))).toBe('TRANSCRIBE_FAILED');
  });
});
