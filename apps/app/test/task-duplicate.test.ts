// SPDX-License-Identifier: AGPL-3.0-only
// The duplicate check of the new-task panel (#3606): a title is looked up once it is a little longer, and the open task with the same
// title is the one shown, whatever the case, spacing or Unicode form of a Vietnamese letter. A finished task is not a duplicate.
import { describe, expect, it } from 'vitest';
import { duplicateTaskSearch, findDuplicateTask, normalizeTaskTitle, TASK_SEARCH_MAX, type DuplicateTaskHit } from '../src/lib/task-duplicate.ts';

const hit = (id: string, title: string, status: DuplicateTaskHit['status'] = 'todo'): DuplicateTaskHit => ({ id, title, status });

describe('duplicateTaskSearch', () => {
  it('looks nothing up for a title that is too short or too long', () => {
    expect(duplicateTaskSearch('')).toBeNull();
    expect(duplicateTaskSearch('  ab ')).toBeNull();
    expect(duplicateTaskSearch('x'.repeat(TASK_SEARCH_MAX + 1))).toBeNull();
  });
  it('searches the trimmed title', () => {
    expect(duplicateTaskSearch('  Gọi khách  ')).toEqual({ v: 1, all: [{ field: 'search', op: 'contains', value: 'Gọi khách' }] });
  });
});

describe('findDuplicateTask', () => {
  it('matches the whole title without regard to case or spacing', () => {
    const hits = [hit('a', 'Gọi lại khách Hòa'), hit('b', 'Gọi lại khách')];
    expect(findDuplicateTask('gọi lại  KHÁCH hòa ', hits)?.id).toBe('a');
    expect(findDuplicateTask('Gọi lại khách', hits)?.id).toBe('b');
  });
  it('treats a decomposed accent as the composed one', () => {
    expect(findDuplicateTask('Go\u0323i lại khách', [hit('a', 'Gọi lại khách')])?.id).toBe('a');
    expect(normalizeTaskTitle('Hòa'.normalize('NFD'))).toBe(normalizeTaskTitle('Hòa'));
  });
  it('does not call a part of a title the same task', () => {
    expect(findDuplicateTask('Gọi lại', [hit('a', 'Gọi lại khách Hòa')])).toBeNull();
  });
  it('ignores a finished or cancelled task, and an empty title', () => {
    expect(findDuplicateTask('Gọi lại khách', [hit('a', 'Gọi lại khách', 'done'), hit('b', 'Gọi lại khách', 'cancelled')])).toBeNull();
    expect(findDuplicateTask('   ', [hit('a', '')])).toBeNull();
  });
});
