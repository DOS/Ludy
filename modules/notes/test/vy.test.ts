// SPDX-License-Identifier: AGPL-3.0-only
// Contract and validation unit tests for Notes N8 member-scoped Vy schemas (#1677).
import { describe, expect, it } from 'vitest';
import {
  zNoteAcceptSummary,
  zNoteSuggestTodosInput,
  zNoteSummarizeInput,
  zTodoAcceptSuggestions,
  zTodoSummary,
} from '@crove/kernel-contract';

const NOTE_ID = '0198a0b4-3c5d-7e6f-8a9b-0c1d2e3f4a5b';
const RUN_ID = '0198a0b4-3c5d-7e6f-8a9b-0c1d2e3f4a5c';

describe('Notes N8 contracts (#1677)', () => {
  it('validates notes.summarize and notes.suggestTodos inputs strictly', () => {
    expect(zNoteSummarizeInput.parse({ noteId: NOTE_ID, language: 'vi' })).toEqual({
      noteId: NOTE_ID,
      language: 'vi',
    });
    expect(() => zNoteSummarizeInput.parse({ noteId: NOTE_ID, extra: true })).toThrow();

    const suggest = zNoteSuggestTodosInput.parse({ noteId: NOTE_ID });
    expect(suggest).toEqual({ noteId: NOTE_ID, timeZone: 'Asia/Ho_Chi_Minh' });
    expect(() => zNoteSuggestTodosInput.parse({ noteId: NOTE_ID, timeZone: 'Invalid/Zone' })).toThrow();
  });

  it('validates zNoteAcceptSummary bounds, modes, and strict keys', () => {
    const parsed = zNoteAcceptSummary.parse({
      noteId: NOTE_ID,
      revision: 2,
      mode: 'append',
      summary: '  Tom tat cuoc hop  ',
      bullets: ['Chot bao gia', 'Gui hop dong'],
      runId: RUN_ID,
    });
    expect(parsed.summary).toBe('Tom tat cuoc hop');
    expect(parsed.bullets).toEqual(['Chot bao gia', 'Gui hop dong']);

    expect(() =>
      zNoteAcceptSummary.parse({
        noteId: NOTE_ID,
        revision: 0,
        mode: 'replace',
        summary: 'OK',
      }),
    ).toThrow();
    expect(() =>
      zNoteAcceptSummary.parse({
        noteId: NOTE_ID,
        revision: 1,
        mode: 'merge',
        summary: 'OK',
      }),
    ).toThrow();
    expect(() =>
      zNoteAcceptSummary.parse({
        noteId: NOTE_ID,
        revision: 1,
        mode: 'replace',
        summary: '   ',
      }),
    ).toThrow();
    expect(() =>
      zNoteAcceptSummary.parse({
        noteId: NOTE_ID,
        revision: 1,
        mode: 'replace',
        summary: 'OK',
        bullets: Array.from({ length: 11 }, (_, i) => `Item ${i + 1}`),
      }),
    ).toThrow();
  });

  it('validates zTodoAcceptSuggestions item count, calendar dates, and dueTimeNeedsDay', () => {
    const parsed = zTodoAcceptSuggestions.parse({
      noteId: NOTE_ID,
      noteRevision: 3,
      runId: RUN_ID,
      items: [
        {
          title: 'Gui bao gia khach A',
          details: 'Kem ban PDF da ky',
          dueOn: '2026-11-20',
          dueTime: '09:30',
          timeZone: 'Asia/Ho_Chi_Minh',
          reminder: 'auto',
        },
        {
          title: 'Goi lai anh Minh',
        },
      ],
    });
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[1]).toEqual({
      title: 'Goi lai anh Minh',
      details: '',
      dueOn: null,
      dueTime: null,
      timeZone: 'Asia/Ho_Chi_Minh',
      reminder: 'auto',
    });

    // Empty batch and >10 items are rejected.
    expect(() => zTodoAcceptSuggestions.parse({ noteId: NOTE_ID, noteRevision: 1, items: [] })).toThrow();
    expect(() =>
      zTodoAcceptSuggestions.parse({
        noteId: NOTE_ID,
        noteRevision: 1,
        items: Array.from({ length: 11 }, (_, i) => ({ title: `Todo ${i + 1}` })),
      }),
    ).toThrow();

    // dueTime without dueOn is rejected by dueTimeNeedsDay refinement.
    expect(() =>
      zTodoAcceptSuggestions.parse({
        noteId: NOTE_ID,
        noteRevision: 1,
        items: [{ title: 'No day', dueOn: null, dueTime: '14:00' }],
      }),
    ).toThrow();

    // Bogus calendar dates (e.g. 2026-02-31) are rejected by zDay.
    expect(() =>
      zTodoAcceptSuggestions.parse({
        noteId: NOTE_ID,
        noteRevision: 1,
        items: [{ title: 'Bad calendar date', dueOn: '2026-02-31' }],
      }),
    ).toThrow();
  });

  it('requires sourceNoteId and tainted on TodoSummary', () => {
    const todo = zTodoSummary.parse({
      id: NOTE_ID,
      title: 'Kiem tra hop dong',
      status: 'open',
      priority: 4,
      tags: [],
      listId: null,
      sectionId: null,
      dueOn: null,
      dueAt: null,
      dueTime: null,
      timeZone: 'Asia/Ho_Chi_Minh',
      remindAt: null,
      group: 'none',
      overdue: false,
      steps: { done: 0, total: 0 },
      taskId: null,
      sourceNoteId: NOTE_ID,
      sourceNote: { id: NOTE_ID, title: 'Ghi chu hop', available: true },
      tainted: true,
      revision: 1,
      createdAt: '2026-11-16T00:00:00.000Z',
      updatedAt: '2026-11-16T00:00:00.000Z',
      doneAt: null,
      deletedAt: null,
    });
    expect(todo.sourceNoteId).toBe(NOTE_ID);
    expect(todo.tainted).toBe(true);
  });
});
