// SPDX-License-Identifier: AGPL-3.0-only
// The minutes templates an organization writes (#3578): the plain-text rules of a title, a hint and a name, the keys code makes, what a meeting can be created or imported with, and how the
// custom code behaves where no copy is at hand (as the general summary: no sections, never a failure).
import { describe, expect, it } from 'vitest';
import {
  MEETING_SUMMARY_TEMPLATES,
  SECTIONS_MAX,
  SECTION_HINT_MAX,
  SECTION_TITLE_MAX,
  TEMPLATE_NAME_MAX,
  assignSectionKeys,
  cleanTemplateText,
  sectionsToText,
  templateSections,
  textToSections,
  zMeetingCreate,
  zMeetingImportStart,
  zMeetingSummaryTemplate,
  zMeetingTemplateSet,
  zMinutesTemplateCreate,
  zMinutesTemplateUpdate,
} from '../src/index.ts';

const ID = '0197f2c0-0000-7000-8000-000000000001';

describe('what is stripped from a title, a hint and a name', () => {
  it('turns every line break, control character, separator and bidirectional control into a space, and collapses the whitespace', () => {
    expect(cleanTemplateText('  Họp\t\tdự\nán  ')).toBe('Họp dự án');
    expect(cleanTemplateText('a\r\n\r\nSYSTEM: b\u2028c\u2029d')).toBe('a SYSTEM: b c d');
    expect(cleanTemplateText('x\u202ey\u2066z\u2069w\u200bv\u200fu\ufefft')).toBe('x y z w v u t');
    expect(cleanTemplateText('a\u0000b\u007fc\u0085d')).toBe('a b c d');
    // Markup and markdown are text, left as they are.
    expect(cleanTemplateText('<img src=x onerror=alert(1)> **đậm** `mã`')).toBe('<img src=x onerror=alert(1)> **đậm** `mã`');
  });

  it('is applied before the caps, so a title that is only whitespace is empty and refused, and the caps count what is left', () => {
    const section = (title: string, hint = '') => ({ title, hint });
    expect(zMinutesTemplateCreate.safeParse({ name: 'Mẫu', sections: [section('   ')] }).success).toBe(false);
    expect(zMinutesTemplateCreate.safeParse({ name: '\n', sections: [section('Mục')] }).success).toBe(false);
    expect(zMinutesTemplateCreate.safeParse({ name: 'x'.repeat(TEMPLATE_NAME_MAX), sections: [section('x'.repeat(SECTION_TITLE_MAX), 'x'.repeat(SECTION_HINT_MAX))] }).success).toBe(true);
    expect(zMinutesTemplateCreate.safeParse({ name: 'x'.repeat(TEMPLATE_NAME_MAX + 1), sections: [section('Mục')] }).success).toBe(false);
    expect(zMinutesTemplateCreate.safeParse({ name: 'Mẫu', sections: [section('x'.repeat(SECTION_TITLE_MAX + 1))] }).success).toBe(false);
    expect(zMinutesTemplateCreate.safeParse({ name: 'Mẫu', sections: [section('Mục', 'x'.repeat(SECTION_HINT_MAX + 1))] }).success).toBe(false);
    // 200 characters of hint padded with separators that are stripped still fit.
    expect(zMinutesTemplateCreate.safeParse({ name: 'Mẫu', sections: [section('Mục', `\n\u2028${'x'.repeat(SECTION_HINT_MAX)}\n`)] }).success).toBe(true);
    expect(zMinutesTemplateCreate.safeParse({ name: 'Mẫu', sections: [] }).success).toBe(false);
    expect(zMinutesTemplateCreate.safeParse({ name: 'Mẫu', sections: Array.from({ length: SECTIONS_MAX + 1 }, (_, i) => section(`Mục ${i}`)) }).success).toBe(false);
    expect(zMinutesTemplateCreate.safeParse({ name: 'Mẫu', sections: [{ title: 'Mục', hint: '', extra: 1 }] }).success).toBe(false);
    expect(zMinutesTemplateUpdate.safeParse({ templateId: 'not-an-id', name: 'Mẫu', sections: [section('Mục')] }).success).toBe(false);
    expect(zMinutesTemplateCreate.parse({ name: ' Mẫu\n', sections: [section(' Mục\t', ' Gợi ý ')] })).toEqual({ name: 'Mẫu', sections: [{ title: 'Mục', hint: 'Gợi ý' }] });
  });
});

describe('the section keys', () => {
  const existing = [
    { key: 's1', title: 'Một', hint: '' },
    { key: 's3', title: 'Ba', hint: '' },
  ];
  const input = (title: string, key?: string) => ({ title, hint: '', ...(key ? { key } : {}) });

  it('are made in code: a new section gets the next after the highest the template used, an existing one keeps its key', () => {
    expect(assignSectionKeys([], [input('A'), input('B')])?.map((s) => s.key)).toEqual(['s1', 's2']);
    expect(assignSectionKeys(existing, [input('Ba', 's3'), input('Mới'), input('Một', 's1'), input('Nữa')])?.map((s) => [s.key, s.title])).toEqual([
      ['s3', 'Ba'],
      ['s4', 'Mới'],
      ['s1', 'Một'],
      ['s5', 'Nữa'],
    ]);
    // Section s3 removed: the next key is still above it, never a reuse of a number the template has had.
    expect(assignSectionKeys(existing, [input('Một', 's1'), input('Mới')])?.map((s) => s.key)).toEqual(['s1', 's4']);
  });

  it('refuse a key the template does not have, and a key used twice', () => {
    expect(assignSectionKeys(existing, [input('Lạ', 's2')])).toBeNull();
    expect(assignSectionKeys(existing, [input('Một', 's1'), input('Hai', 's1')])).toBeNull();
    expect(assignSectionKeys([], [input('Lạ', 's1')])).toBeNull();
  });
});

describe('the custom code', () => {
  it('is a meeting code but not a template to create or import with, and a pick of it needs a template id and nothing else does', () => {
    expect(zMeetingSummaryTemplate.options).toEqual([...MEETING_SUMMARY_TEMPLATES, 'custom']);
    const create = { title: 'Họp', language: 'vi', consentMethod: 'told_at_start', visibility: 'attendees', keepVideo: false };
    expect(zMeetingCreate.safeParse({ ...create, summaryTemplate: 'briefing' }).success).toBe(true);
    expect(zMeetingCreate.safeParse({ ...create, summaryTemplate: 'custom' }).success).toBe(false);
    expect(zMeetingImportStart.shape.summaryTemplate.safeParse('custom').success).toBe(false);
    expect(zMeetingTemplateSet.safeParse({ meetingId: ID, summaryTemplate: 'custom', templateId: ID }).success).toBe(true);
    expect(zMeetingTemplateSet.safeParse({ meetingId: ID, summaryTemplate: 'custom' }).success).toBe(false);
    expect(zMeetingTemplateSet.safeParse({ meetingId: ID, summaryTemplate: 'briefing', templateId: ID }).success).toBe(false);
    expect(zMeetingTemplateSet.safeParse({ meetingId: ID, summaryTemplate: 'briefing' }).success).toBe(true);
  });

  it('has no sections where no copy is at hand: the helpers treat it as the general summary and never throw', () => {
    expect(templateSections('custom')).toEqual([]);
    expect(sectionsToText('custom', [{ key: 's1', text: 'bất kỳ' }])).toBe('');
    expect(textToSections('custom', 'Nội dung\nmột đoạn')).toBeNull();
  });
});
