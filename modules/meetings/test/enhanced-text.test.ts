// SPDX-License-Identifier: AGPL-3.0-only
// The text an expansion of the recorder's notes becomes in the draft (Meetings A5, #3163): one line per line, own and added, under the template's headings, with the recorder's own lines as
// they wrote them. One documented exception, pinned here: a line of theirs that equals a heading of the template is marked with a leading "· " so it stays text and is not read back as a heading.
import { describe, expect, it } from 'vitest';
import { enhancedText } from '../src/summary.ts';

const own = (text: string) => ({ own: true, text, seconds: null });
const added = (text: string, seconds: number) => ({ own: false, text, seconds });

describe('enhancedText', () => {
  it('writes the general summary as its lines, one to a line, the recorder\'s own exactly as typed', () => {
    const text = enhancedText('general', { sections: [{ key: null, lines: [own('  báo giá khách A  '.trim()), added('Khách hẹn gặp lúc 9 giờ.', 5), own('Nam gửi trước thứ sáu')] }] });
    expect(text).toBe('báo giá khách A\nKhách hẹn gặp lúc 9 giờ.\nNam gửi trước thứ sáu');
  });

  it('writes a template\'s sections under its headings in its order, and leaves out a key the template does not have', () => {
    const text = enhancedText('briefing', {
      sections: [
        { key: 'plan', lines: [own('gửi báo giá'), added('Họp lại thứ hai.', 60)] },
        { key: 'progress', lines: [own('đã ký hợp đồng')] },
        { key: 'secret', lines: [own('không có trong mẫu')] },
      ],
    });
    expect(text).toBe('Kết quả công việc kỳ trước\nđã ký hợp đồng\n\nKế hoạch kỳ tới\ngửi báo giá\nHọp lại thứ hai.');
  });

  it('marks a line of the recorder\'s own that equals a heading of the template, the one exception to "exactly as typed", so it is not read back as a heading', () => {
    const text = enhancedText('supplier', { sections: [{ key: 'issues', lines: [own('Vấn đề, khiếu nại'), own('giao trễ')] }] });
    expect(text).toBe('Vấn đề, khiếu nại\n· Vấn đề, khiếu nại\ngiao trễ');
  });
});
