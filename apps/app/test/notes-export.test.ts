// SPDX-License-Identifier: AGPL-3.0-only
// A member's own notes and to-dos as Markdown (#1678): each note under its title with its facts and its body as
// written, each to-do as a checkbox line with its steps.
import { describe, expect, it } from 'vitest';
import type { NotesExport } from '@crove/kernel-contract';
import { notesMarkdown, type NotesExportWords } from '../src/lib/notes-export.ts';

const WORDS: NotesExportWords = {
  heading: 'Ghi chú và việc của tôi',
  exportedAt: 'Tải về lúc',
  notes: 'Ghi chú',
  todos: 'Việc',
  todoLists: 'Danh sách việc',
  private: 'Ghi chú riêng',
  shared: 'Ghi chú dùng chung',
  tags: 'Nhãn',
  priority: 'Mức ưu tiên',
  list: 'Danh sách',
  sections: 'Các mục',
  pinned: 'Đã ghim',
  archived: 'Lưu trữ lúc',
  trashed: 'Trong thùng rác từ',
  created: 'Tạo lúc',
  updated: 'Sửa lần cuối',
  links: 'Gắn với',
  status: { open: 'Chưa xong', done: 'Đã xong', handed_over: 'Đã giao', cancelled: 'Đã hủy' },
  due: 'Hạn',
  remind: 'Nhắc lúc',
  done: 'Xong lúc',
  truncated: 'Chỉ có phần mới nhất',
};

const DATA: NotesExport = {
  exportedAt: '2026-10-30T03:00:00.000Z',
  notes: [
    {
      id: 'n1',
      visibility: 'private',
      title: 'Khách A',
      body: 'Gọi lại **thứ Hai**\n',
      tags: ['khách', 'gấp'],
      pinned: true,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-02T00:00:00.000Z',
      archivedAt: null,
      deletedAt: null,
      links: [{ targetType: 'kernel.party', targetId: 'p1' }],
    },
    {
      id: 'n2',
      visibility: 'org',
      title: 'Trống',
      body: '',
      tags: [],
      pinned: false,
      createdAt: '2026-10-03T00:00:00.000Z',
      updatedAt: '2026-10-03T00:00:00.000Z',
      archivedAt: null,
      deletedAt: '2026-10-04T00:00:00.000Z',
      links: [],
    },
  ],
  todos: [
    {
      id: 't1',
      title: 'Nộp tờ khai',
      details: 'Trước ngày 20',
      checklist: [
        { text: 'Lấy số liệu', done: true },
        { text: 'Ký', done: false },
      ],
      status: 'done',
      priority: 4,
      tags: [],
      listId: null,
      sectionId: null,
      dueOn: '2026-10-20',
      dueAt: null,
      timeZone: 'Asia/Ho_Chi_Minh',
      remindAt: null,
      createdAt: '2026-10-05T00:00:00.000Z',
      updatedAt: '2026-10-06T00:00:00.000Z',
      doneAt: '2026-10-06T00:00:00.000Z',
      deletedAt: null,
      sourceNoteId: null,
      taskId: null,
      recurrence: null,
      seriesId: null,
      links: [{ targetType: 'kernel.task', targetId: 'task-1' }],
    },
  ],
  todoLists: [],
  truncated: false,
};

describe('notes download as Markdown (#1678)', () => {
  it('writes every note with its facts and body, and every to-do with its steps', () => {
    expect(notesMarkdown(DATA, WORDS)).toBe(
      [
        '# Ghi chú và việc của tôi',
        '',
        '- Tải về lúc: 2026-10-30T03:00:00.000Z',
        '',
        '## Ghi chú (2)',
        '',
        '### Khách A',
        '',
        '- Ghi chú riêng: n1',
        '- Nhãn: khách, gấp',
        '- Đã ghim',
        '- Tạo lúc: 2026-10-01T00:00:00.000Z',
        '- Sửa lần cuối: 2026-10-02T00:00:00.000Z',
        '- Gắn với: kernel.party p1',
        '',
        'Gọi lại **thứ Hai**',
        '',
        '### Trống',
        '',
        '- Ghi chú dùng chung: n2',
        '- Trong thùng rác từ: 2026-10-04T00:00:00.000Z',
        '- Tạo lúc: 2026-10-03T00:00:00.000Z',
        '- Sửa lần cuối: 2026-10-03T00:00:00.000Z',
        '',
        '## Việc (1)',
        '',
        '### [x] Nộp tờ khai',
        '',
        '- Đã xong: t1',
        '- Hạn: 2026-10-20',
        '- Xong lúc: 2026-10-06T00:00:00.000Z',
        '- Tạo lúc: 2026-10-05T00:00:00.000Z',
        '- Sửa lần cuối: 2026-10-06T00:00:00.000Z',
        '- Gắn với: kernel.task task-1',
        '',
        'Trước ngày 20',
        '',
        '- [x] Lấy số liệu',
        '- [ ] Ký',
        '',
      ].join('\n'),
    );
  });

  it('keeps a title and a step on one line', () => {
    const odd: NotesExport = {
      ...DATA,
      notes: [{ ...DATA.notes[0]!, title: 'Khách\n## Việc (0)' }],
      todos: [{ ...DATA.todos[0]!, checklist: [{ text: 'a\n- [x] b', done: false }] }],
    };
    const md = notesMarkdown(odd, WORDS);
    expect(md).toContain('### Khách ## Việc (0)\n');
    expect(md).toContain('- [ ] a - [x] b\n');
    expect(md.match(/^## /gm)).toHaveLength(2);
  });

  it('says when the list was cut', () => {
    expect(notesMarkdown({ ...DATA, notes: [], todos: [], truncated: true }, WORDS)).toContain('> Chỉ có phần mới nhất');
  });

  it('writes priority, list/section name, tags, and personal to-do lists when present', () => {
    const withLists: NotesExport = {
      exportedAt: '2026-10-30T03:00:00.000Z',
      notes: [],
      todos: [
        {
          ...DATA.todos[0]!,
          priority: 1,
          tags: ['thue', 'gap'],
          listId: 'list-1',
          sectionId: 'sec-1',
        },
      ],
      todoLists: [
        {
          id: 'list-1',
          name: 'Thuế\n## Fake heading',
          color: 'emerald',
          sections: [
            { id: 'sec-1', name: 'Đầu tháng' },
            { id: 'sec-2', name: 'Cuối tháng' },
          ],
          sortKey: 'a0',
          createdAt: '2026-10-05T00:00:00.000Z',
          updatedAt: '2026-10-06T00:00:00.000Z',
          deletedAt: null,
        },
      ],
      truncated: false,
    };
    const md = notesMarkdown(withLists, WORDS);
    expect(md).toContain('- Mức ưu tiên: P1\n');
    expect(md).toContain('- Danh sách: Thuế ## Fake heading / Đầu tháng\n');
    expect(md).toContain('- Nhãn: thue, gap\n');
    expect(md).toContain('## Danh sách việc (1)\n');
    expect(md).toContain('### Thuế ## Fake heading\n');
    expect(md).toContain('- Danh sách: list-1\n');
    expect(md).toContain('- Các mục: Đầu tháng, Cuối tháng\n');
  });
});
