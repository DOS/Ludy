// SPDX-License-Identifier: AGPL-3.0-only
// The minutes templates of a meeting (Meetings A4, #3162): five in code, sections written as headings and read back by them.
import { describe, expect, it } from 'vitest';
import {
  MEETING_SUMMARY_TEMPLATES,
  SECTION_TEXT_MAX,
  SUMMARY_TEMPLATE_SECTIONS,
  sectionsToText,
  templateSections,
  textToSections,
  zMeetingResultSave,
  zSummaryResult,
} from '../src/index.ts';

const ID = '0197f2c0-0000-7000-8000-000000000001';

describe('the templates', () => {
  it('are the five of the plan, the general one without sections, each key and heading unique inside its template', () => {
    expect([...MEETING_SUMMARY_TEMPLATES]).toEqual(['general', 'briefing', 'customer', 'supplier', 'one_on_one']);
    expect(templateSections('general')).toEqual([]);
    for (const code of MEETING_SUMMARY_TEMPLATES) {
      const defs = SUMMARY_TEMPLATE_SECTIONS[code];
      expect(new Set(defs.map((d) => d.key)).size).toBe(defs.length);
      expect(new Set(defs.map((d) => d.title)).size).toBe(defs.length);
      for (const d of defs) expect(d.key).toMatch(/^[a-z][a-z0-9_]{0,31}$/);
      // The sections of a template fit one summary text (8000 characters) whatever the recorder types.
      expect(defs.length * (SECTION_TEXT_MAX + 80)).toBeLessThan(8000);
    }
  });
});

describe('sectionsToText and textToSections', () => {
  const entries = [
    { key: 'plan', text: 'Gửi báo giá trước thứ sáu.\n\nHọp lại thứ hai.' },
    { key: 'progress', text: 'Đã gửi hợp đồng.' },
  ];
  it('writes the filled sections in the template order, under their headings, and reads them back', () => {
    const text = sectionsToText('briefing', entries);
    expect(text).toBe('Kết quả công việc kỳ trước\nĐã gửi hợp đồng.\n\nKế hoạch kỳ tới\nGửi báo giá trước thứ sáu.\n\nHọp lại thứ hai.');
    expect(textToSections('briefing', text)).toEqual([
      { key: 'progress', text: 'Đã gửi hợp đồng.' },
      { key: 'issues', text: '' },
      { key: 'plan', text: 'Gửi báo giá trước thứ sáu.\n\nHọp lại thứ hai.' },
      { key: 'requests', text: '' },
    ]);
  });

  it('leaves out an unknown key and an empty section, and keeps the first of a repeated key', () => {
    expect(sectionsToText('briefing', [{ key: 'nope', text: 'x' }, { key: 'plan', text: '  ' }, { key: 'issues', text: 'a' }, { key: 'issues', text: 'b' }])).toBe('Vướng mắc, tồn tại\na');
    expect(sectionsToText('general', [{ key: 'plan', text: 'x' }])).toBe('');
  });

  it('keeps a line that equals a heading as text, so the sections read back as they were written', () => {
    const tricky = [
      { key: 'progress', text: 'Đã xong.\n\nKế hoạch kỳ tới\nkhông phải mục mới' },
      { key: 'plan', text: 'Thật sự là kế hoạch.' },
    ];
    const text = sectionsToText('briefing', tricky);
    expect(textToSections('briefing', text)).toEqual([
      { key: 'progress', text: 'Đã xong.\n\nKế hoạch kỳ tới\nkhông phải mục mới' },
      { key: 'issues', text: '' },
      { key: 'plan', text: 'Thật sự là kế hoạch.' },
      { key: 'requests', text: '' },
    ]);
  });

  it('reads null for a text that is not in the template\'s form (typed under another template, or free text), and for the general template', () => {
    const other = sectionsToText('customer', [{ key: 'needs', text: 'Cần báo giá.' }]);
    expect(textToSections('briefing', other)).toBeNull();
    expect(textToSections('briefing', 'Một đoạn văn thường.')).toBeNull();
    expect(textToSections('general', 'Một đoạn văn thường.')).toBeNull();
    expect(textToSections('briefing', 'Lời mở đầu\nKế hoạch kỳ tới\nx')).toBeNull();
  });

  it('stays fast on a long run of whitespace inside a line (no backtracking pattern runs on the text)', () => {
    const hostile = `${'\t'.repeat(50_000)}x`;
    const started = performance.now();
    const text = sectionsToText('briefing', [{ key: 'progress', text: `${hostile}\n${hostile}   ` }]);
    textToSections('briefing', text);
    expect(performance.now() - started).toBeLessThan(500);
    // The trailing spaces of a line are dropped, its leading whitespace is kept, as before.
    expect(sectionsToText('briefing', [{ key: 'progress', text: 'a  \n  b\t' }])).toBe('Kết quả công việc kỳ trước\na\n  b');
  });

  it('round-trips every section of every template', () => {
    for (const code of MEETING_SUMMARY_TEMPLATES) {
      const all = templateSections(code).map((d, i) => ({ key: d.key, text: `Nội dung ${i + 1}` }));
      if (all.length === 0) continue;
      expect(textToSections(code, sectionsToText(code, all))).toEqual(all);
    }
  });
});

describe('the contract of a result', () => {
  it('saves a summary, or sections, and refuses neither', () => {
    expect(zMeetingResultSave.safeParse({ meetingId: ID, summary: 'Họp báo giá.', decisions: [] }).success).toBe(true);
    expect(zMeetingResultSave.safeParse({ meetingId: ID, sections: [{ key: 'plan', text: 'Gửi báo giá.' }], decisions: [] }).success).toBe(true);
    expect(zMeetingResultSave.safeParse({ meetingId: ID, summary: '  ', sections: [{ key: 'plan', text: ' ' }], decisions: [] }).success).toBe(false);
    expect(zMeetingResultSave.safeParse({ meetingId: ID, sections: [{ key: 'Plan!', text: 'x' }], decisions: [] }).success).toBe(false);
    expect(zMeetingResultSave.safeParse({ meetingId: ID, sections: [{ key: 'plan', text: 'x'.repeat(SECTION_TEXT_MAX + 1) }], decisions: [] }).success).toBe(false);
  });

  it('reads a run result stored before templates as the general summary', () => {
    const old = zSummaryResult.parse({ summary: 'Họp báo giá.', decisions: [], items: [], dropped: 0 });
    expect(old.template).toBe('general');
    expect(old.sections).toEqual([]);
  });
});
