// SPDX-License-Identifier: AGPL-3.0-only
// The biên bản page of a meeting (Meetings A4, #3162): the model is worked out in code from the meeting row and the PUBLISHED result only, and the sheet lays it out in the
// Vietnamese office form with a blank signature block. The facts (date, attendees, owners, due dates) never come from the model's words.
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { MEETING_SUMMARY_TEMPLATES, SUMMARY_TEMPLATE_SECTIONS, sectionsToText, type ActionItemView, type MeetingResults } from '@crove/kernel-contract';
import { en as enMessages } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import { catalog } from '../src/i18n/runtime.ts';
import { buildMinutes, dueText, vnMoment, type MinutesMeeting } from '../src/lib/minutes.ts';

// The page's own imports reach the API client; the sheet needs none of it.
vi.mock('../src/lib/api.ts', () => ({ orpc: {}, queryClient: {}, errorMessage: String }));
const { MinutesSheet } = await import('../src/routes/meeting-minutes.tsx');

const REC = 'u-rec';
const LAN = 'u-lan';
const NAMES: Record<string, string> = { [REC]: 'Anh Nam', [LAN]: 'Chị Lan' };
const nameOf = (id: string) => NAMES[id] ?? 'Thành viên đã rời';

const meeting: MinutesMeeting = {
  startedAt: '2026-11-14T07:00:00.000Z', // 14:00 in Vietnam
  createdAt: '2026-11-14T06:59:00.000Z',
  endedAt: '2026-11-14T08:30:00.000Z',
  recorderUserId: REC,
  readers: [LAN, REC],
  summaryTemplate: 'briefing',
};
const item = (over: Partial<ActionItemView>): ActionItemView => ({
  id: 'i1',
  stage: 'published',
  status: 'suggested',
  title: 'Gửi báo giá',
  who: 'Lan nói là Lan',
  whoUserId: LAN,
  when: 'thứ sáu',
  whenDate: '2026-11-20',
  transcriptSeconds: 10,
  flags: [],
  tainted: false,
  taskId: null,
  positions: [],
  clean: false,
  ...over,
});
const result = (stage: 'draft' | 'published', summary: string, decisions = ['Giữ giá cũ']) => ({ id: `r-${stage}`, feature: 'manual' as const, stage, summary, decisions, tainted: false });
const results = (over: Partial<MeetingResults>): MeetingResults => ({ meetingId: 'm1', isRecorder: false, draft: null, published: null, items: [], ...over });

describe('the facts of the page', () => {
  it('writes the day and the time in Vietnam time whatever the browser zone is, and a due date as dd/mm/yyyy', () => {
    expect(vnMoment('2026-11-14T07:00:00.000Z')).toEqual({ day: '14', month: '11', year: '2026', time: '14:00' });
    expect(vnMoment('2026-11-14T18:30:00.000Z')).toEqual({ day: '15', month: '11', year: '2026', time: '01:30' });
    expect(dueText('2026-11-20')).toBe('20/11/2026');
    expect(dueText(null)).toBeNull();
  });

  it('takes the date, the attendees, the owners and the due dates from the meeting and code: an unmatched owner is blank, never the words the model heard', () => {
    const published = result('published', sectionsToText('briefing', [{ key: 'progress', text: 'Đã gửi hợp đồng.' }]));
    const model = buildMinutes(meeting, results({ published, items: [item({}), item({ id: 'i2', title: 'Chốt giá', whoUserId: null, who: 'Ai đó', whenDate: null, when: 'sớm' })] }), nameOf);
    expect(model.from).toEqual({ day: '14', month: '11', year: '2026', time: '14:00' });
    expect(model.to?.time).toBe('15:30');
    expect(model.recorder).toBe('Anh Nam');
    // The recorder first, then the readers, each once.
    expect(model.attendees).toEqual(['Anh Nam', 'Chị Lan']);
    expect(model.actions).toEqual([
      { title: 'Gửi báo giá', owner: 'Chị Lan', due: '20/11/2026' },
      { title: 'Chốt giá', owner: null, due: null },
    ]);
    expect(model.sections).toEqual([{ key: 'progress', text: 'Đã gửi hợp đồng.' }]);
    expect(model.conclusions).toEqual(['Giữ giá cũ']);
    expect(model.published).toBe(true);
  });

  it('shows only what was published: a draft alone is "Bản nháp" with nothing in it, and a newer draft beside a published result is not shown', () => {
    const onlyDraft = buildMinutes(meeting, results({ isRecorder: true, draft: result('draft', sectionsToText('briefing', [{ key: 'plan', text: 'Bản nháp riêng' }])), items: [item({ stage: 'draft' })] }), nameOf);
    expect(onlyDraft.published).toBe(false);
    expect(onlyDraft.sections).toEqual([]);
    expect(onlyDraft.conclusions).toEqual([]);
    expect(onlyDraft.actions).toEqual([]);
    const both = buildMinutes(
      meeting,
      results({ isRecorder: true, published: result('published', sectionsToText('briefing', [{ key: 'plan', text: 'Đã chia sẻ' }])), draft: result('draft', sectionsToText('briefing', [{ key: 'plan', text: 'Chưa chia sẻ' }])), items: [item({ stage: 'draft', title: 'Việc nháp' })] }),
      nameOf,
    );
    expect(both.published).toBe(true);
    expect(both.newerDraft).toBe(true);
    expect(JSON.stringify(both)).not.toContain('Chưa chia sẻ');
    expect(both.actions).toEqual([]);
  });

  it('shows text that is not in the template\'s form whole, as it was shared, and the general summary as one block', () => {
    const old = buildMinutes({ ...meeting, summaryTemplate: 'customer' }, results({ published: result('published', sectionsToText('briefing', [{ key: 'plan', text: 'Kế hoạch cũ' }])) }), nameOf);
    expect(old.sections).toHaveLength(1);
    expect(old.sections[0]?.key).toBeNull();
    const general = buildMinutes({ ...meeting, summaryTemplate: 'general' }, results({ published: result('published', 'Họp báo giá.') }), nameOf);
    expect(general.sections).toEqual([{ key: null, text: 'Họp báo giá.' }]);
  });
});

function sheet(model: ReturnType<typeof buildMinutes>, place = '') {
  return renderToStaticMarkup(
    <IntlProvider locale="vi" messages={catalog('vi')}>
      <MinutesSheet model={model} company="Công ty TNHH Ánh Dương" title="Họp giao ban tuần" place={place} template="briefing" />
    </IntlProvider>,
  );
}

describe('the sheet', () => {
  const published = result('published', sectionsToText('briefing', [{ key: 'progress', text: 'Đã gửi hợp đồng.' }, { key: 'plan', text: 'Gửi báo giá thứ sáu.' }]));
  const model = buildMinutes(meeting, results({ published, items: [item({})] }), nameOf);

  it('lays out the office form: company, BIÊN BẢN CUỘC HỌP, time, place, attendees, content, conclusions, action table and a blank signature block', () => {
    const html = sheet(model);
    const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
    expect(text).toContain('Công ty TNHH Ánh Dương');
    expect(text).toContain('BIÊN BẢN CUỘC HỌP');
    expect(text).toContain('V/v: Họp giao ban tuần');
    expect(text).toContain('Từ 14:00 đến 15:30, ngày 14 tháng 11 năm 2026');
    expect(text).toContain('Anh Nam (Người ghi biên bản)');
    expect(text).toContain('Chị Lan');
    expect(text).toContain('I. NỘI DUNG CUỘC HỌP');
    expect(text).toContain('1. Kết quả công việc kỳ trước');
    expect(text).toContain('Đã gửi hợp đồng.');
    expect(text).toContain('2. Kế hoạch kỳ tới');
    expect(text).toContain('II. KẾT LUẬN');
    expect(text).toContain('III. CÔNG VIỆC CẦN THỰC HIỆN');
    expect(text).toContain('Gửi báo giá Chị Lan 20/11/2026');
    expect(html).toContain('data-testid="minutes-signatures"');
    expect(text).toContain('NGƯỜI GHI BIÊN BẢN');
    expect(text).toContain('CHỦ TRÌ CUỘC HỌP');
    // Ludy signs nothing: the block has no name and no signature in it.
    const block = /data-testid="minutes-signatures"[\s\S]*<\/footer>/.exec(html)?.[0].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
    expect(block).not.toContain('Nam');
    expect(block).not.toContain('Lan');
    expect(html).not.toContain('data-testid="minutes-draft"');
  });

  it('prints a dotted line for a place nobody typed and for an owner or date code did not find, and the typed place when there is one', () => {
    const blank = buildMinutes(meeting, results({ published, items: [item({ whoUserId: null, whenDate: null })] }), nameOf);
    const html = sheet(blank);
    expect(/data-testid="minutes-place">([^<]*)</.exec(html)?.[1]).toContain('……');
    const row = /data-testid="minutes-action"[\s\S]*?<\/tr>/.exec(html)?.[0].replace(/<[^>]*>/g, ' ');
    expect(row).toContain('……');
    expect(row).not.toContain('Lan nói là Lan');
    expect(/data-testid="minutes-place">([^<]*)</.exec(sheet(model, '  Phòng họp tầng 3 '))?.[1]).toBe('Phòng họp tầng 3');
  });

  it('says Bản nháp and shows no content when nothing was shared', () => {
    const draft = buildMinutes(meeting, results({ isRecorder: true, draft: result('draft', 'Chưa chia sẻ') }), nameOf);
    const html = sheet(draft);
    expect(html).toContain('data-testid="minutes-draft"');
    expect(html).toContain(viMessages.meetings.minutes.draft);
    expect(html).toContain('data-testid="minutes-nothing"');
    expect(html).not.toContain('Chưa chia sẻ');
    expect(html).not.toContain('NỘI DUNG CUỘC HỌP');
    // The header facts and the blank signature block stay.
    expect(html).toContain('data-testid="minutes-signatures"');
  });
});

describe('the screen words of the templates', () => {
  it('name every template and every section in Vietnamese and English, and the Vietnamese section names are the headings the contract writes', () => {
    for (const code of MEETING_SUMMARY_TEMPLATES) {
      expect(viMessages.meetings.templates.names[code]).toBeTruthy();
      expect(enMessages.meetings.templates.names[code]).toBeTruthy();
      if (code === 'general') continue;
      for (const def of SUMMARY_TEMPLATE_SECTIONS[code]) {
        const vi = (viMessages.meetings.templates.sections as Record<string, Record<string, string>>)[code]?.[def.key];
        const en = (enMessages.meetings.templates.sections as Record<string, Record<string, string>>)[code]?.[def.key];
        expect(vi).toBe(def.title);
        expect(en).toBeTruthy();
      }
    }
  });
});
