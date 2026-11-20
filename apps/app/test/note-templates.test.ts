// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { NOTE_BODY_MAX, NOTE_TEMPLATE_NAME_MAX, NOTE_TITLE_MAX, type NotesExport } from '@crove/kernel-contract';
import { computeLineDiff, computeNoteVersionDiff, starterNoteTemplates } from '../src/lib/note-templates.ts';
import { notesMarkdown, type NotesExportWords } from '../src/lib/notes-export.ts';

const EXPORT_WORDS: NotesExportWords = {
  heading: 'Ghi chú và việc của tôi',
  exportedAt: 'Tải về lúc',
  notes: 'Ghi chú',
  todos: 'Việc',
  todoLists: 'Danh sách việc',
  templates: 'Mẫu ghi chú',
  templateTitle: 'Tiêu đề mặc định',
  private: 'Riêng tư',
  shared: 'Dùng chung',
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
  truncated: 'Đã cắt bớt',
};

describe('starterNoteTemplates (#3562)', () => {
  it('provides the four built-in starter templates in Vietnamese and English within contract limits', () => {
    const vi = starterNoteTemplates('vi');
    const en = starterNoteTemplates('en');
    expect(vi.map((t) => t.id)).toEqual(['meeting-notes', 'client-note', 'process-sop', 'weekly-work-log']);
    expect(en.map((t) => t.id)).toEqual(['meeting-notes', 'client-note', 'process-sop', 'weekly-work-log']);
    expect(vi[0]?.name).toBe('Biên bản họp');
    expect(en[0]?.name).toBe('Meeting notes');

    for (const list of [vi, en]) {
      for (const item of list) {
        expect(item.name.trim().length).toBeGreaterThan(0);
        expect(item.name.length).toBeLessThanOrEqual(NOTE_TEMPLATE_NAME_MAX);
        expect(item.title.length).toBeLessThanOrEqual(NOTE_TITLE_MAX);
        expect(item.body.length).toBeGreaterThan(10);
        expect(item.body.length).toBeLessThanOrEqual(NOTE_BODY_MAX);
        expect(item.tags.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('computeNoteVersionDiff (#3562)', () => {
  it('computes unified line additions, removals, and unchanged context lines', () => {
    const diff = computeNoteVersionDiff(
      {
        title: 'Biên bản tuần 1',
        body: 'Dòng giữ nguyên\nDòng cũ sẽ bỏ\nKết thúc',
        tags: ['hop'],
      },
      {
        title: 'Biên bản tuần 2',
        body: 'Dòng giữ nguyên\nDòng mới thêm vào\nKết thúc',
        tags: ['hop', 'quan-trong'],
      },
    );

    expect(diff.titleChanged).toBe(true);
    expect(diff.tagsChanged).toBe(true);
    expect(diff.bodyChanged).toBe(true);
    expect(diff.removedLines).toBe(1);
    expect(diff.addedLines).toBe(1);
    expect(diff.lines).toEqual([
      { kind: 'same', text: 'Dòng giữ nguyên' },
      { kind: 'removed', text: 'Dòng cũ sẽ bỏ' },
      { kind: 'added', text: 'Dòng mới thêm vào' },
      { kind: 'same', text: 'Kết thúc' },
    ]);
  });

  it('normalizes CRLF line endings and reports zero changes when identical', () => {
    const diff = computeNoteVersionDiff(
      { title: 'Giữ nguyên', body: 'A\r\nB', tags: ['a'] },
      { title: 'Giữ nguyên', body: 'A\nB', tags: ['a'] },
    );
    expect(diff.titleChanged).toBe(false);
    expect(diff.tagsChanged).toBe(false);
    expect(diff.bodyChanged).toBe(true);
    expect(diff.addedLines).toBe(0);
    expect(diff.removedLines).toBe(0);
    expect(diff.lines).toEqual([
      { kind: 'same', text: 'A' },
      { kind: 'same', text: 'B' },
    ]);
  });

  it('bounds runtime linearly on notes larger than 400 changed lines', () => {
    const older = Array.from({ length: 450 }, (_, i) => `old-${i}`).join('\n');
    const newer = Array.from({ length: 450 }, (_, i) => `new-${i}`).join('\n');
    const lines = computeLineDiff(older, newer);
    expect(lines.filter((l) => l.kind === 'removed')).toHaveLength(450);
    expect(lines.filter((l) => l.kind === 'added')).toHaveLength(450);
  });
});

describe('notesMarkdown with templates (#3562)', () => {
  it('renders custom templates section when templates are present in personal export', () => {
    const exported: NotesExport = {
      exportedAt: '2026-11-19T00:00:00.000Z',
      notes: [],
      todos: [],
      todoLists: [],
      templates: [
        {
          id: 'tpl-1',
          visibility: 'private',
          name: 'Mẫu họp sáng',
          title: 'Họp đầu ngày',
          body: '## Việc hôm nay\n- [ ] Kiểm tra đơn hàng',
          tags: ['sang'],
          createdAt: '2026-11-18T01:00:00.000Z',
          updatedAt: '2026-11-18T02:00:00.000Z',
        },
      ],
      truncated: false,
    };
    const md = notesMarkdown(exported, EXPORT_WORDS);
    expect(md).toContain('## Mẫu ghi chú (1)');
    expect(md).toContain('### Mẫu họp sáng');
    expect(md).toContain('- Riêng tư: tpl-1');
    expect(md).toContain('- Tiêu đề mặc định: Họp đầu ngày');
    expect(md).toContain('## Việc hôm nay');
  });
});
