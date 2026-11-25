// SPDX-License-Identifier: AGPL-3.0-only
// The three transcript filters (#4954): a table of lines per filter, the hits and the near-misses ("không" as a plain negation is not a question, "giới hạn" is not a deadline).
import { describe, expect, it } from 'vitest';
import { filterCounts, hasDate, hasFigure, lineMatches, looksLikeQuestion } from '../src/lib/transcript-filters.ts';

const table = (fn: (text: string) => boolean, hits: string[], misses: string[]) => {
  for (const line of hits) it(`finds: ${line}`, () => expect(fn(line)).toBe(true));
  for (const line of misses) it(`skips: ${line}`, () => expect(fn(line)).toBe(false));
};

describe('looksLikeQuestion', () => {
  table(
    looksLikeQuestion,
    [
      'Anh gửi báo giá lúc nào vậy?',
      'Bên anh còn hàng không?',
      'Gói này giá bao nhiêu',
      'Chị đã chuyển khoản chưa',
      'Khi nào thì bên em giao được',
      'Văn phòng của anh ở đâu',
      'Ai sẽ phụ trách phần thiết kế',
      'Mình làm như thế nào bây giờ',
      'Em hỏi tại sao lại chậm vậy',
      'Đúng không anh',
      'Vâng ạ. Anh có nhận thẻ không?',
      'Hợp đồng này có được gia hạn không?"',
      'What is the price for ten seats',
      'Can you send the contract today',
      'Is it possible to move the call',
      'Okay. When does the trial end?',
    ],
    [
      'Tôi không biết chuyện đó',
      'Bên em không giao hàng vào chủ nhật',
      'Không ai nhận cuộc gọi hôm đó',
      'Ai cũng biết giá đã tăng',
      'Bao nhiêu cũng được, miễn là đúng hạn',
      'Dù thế nào em cũng sẽ gửi',
      'Anh ấy ở đâu cũng làm việc được',
      'Em sẽ gửi báo giá trong ngày mai.',
      'Cảm ơn anh, hẹn gặp lại',
      'We will send the contract tomorrow',
      'The price is fine',
      'Giá 3.5 triệu, không giảm',
    ],
  );

  it('reads a question mark in a later sentence', () => {
    expect(looksLikeQuestion('Em đã nhận được. Anh gửi lại được không?')).toBe(true);
  });
  it('does not split on a decimal point', () => {
    expect(looksLikeQuestion('Mức 3.5 là đủ')).toBe(false);
  });
});

describe('hasFigure', () => {
  table(
    hasFigure,
    [
      'Giá là 2.500.000đ một tháng',
      'Em báo 500k một bộ',
      'Giảm 15% cho khách cũ',
      'Chiết khấu mười phần trăm',
      'Khoảng 3 triệu rưỡi',
      'Tầm hai triệu',
      'Cọc 1,2 tỷ',
      'Báo 50 usd một seat',
      'It costs $1,200 a year',
      'Cần 50 người cho đợt đầu',
      'Hợp đồng 12 tháng',
      'Tổng là 12500000',
      'Giá 2tr5',
      'Doanh thu 1.250',
    ],
    [
      'Cảm ơn anh nhiều',
      'Hẹn anh ngày 15/12',
      'Gặp nhau lúc 9:30',
      'Họp lúc 9h30 nhé',
      'Năm 2026 mình mở thêm chi nhánh',
      'Làm bước 1 trước',
      'Em có hai việc cần hỏi',
      'Hẹn 15 tháng 12',
      'Hỗ trợ 24/7',
      'Tôi sống ở tầng 5',
    ],
  );
});

describe('hasDate', () => {
  table(
    hasDate,
    [
      'Em gửi vào thứ Sáu nhé',
      'Hẹn anh ngày mai',
      'Chiều mai em gọi lại',
      'Hạn chót là cuối tháng',
      'Giao trước ngày 15',
      'Chốt ngày 15/12',
      'Hợp đồng ký ngày 15-12-2026',
      'Hẹn mùng 5 tháng sau',
      'Tuần sau mình họp',
      'Họp vào thứ 3',
      'Chủ nhật này anh rảnh không',
      'Họp quý 3 nhé',
      'We ship next week',
      'The deadline is Friday',
      'Send it by December 15',
      'Hôm qua em đã gửi',
    ],
    [
      'Giới hạn là năm người',
      'Vô hạn thời gian dùng thử',
      'Cảm ơn anh',
      'Hỗ trợ 24/7',
      'Giá 3.5 triệu',
      'The meeting is due to the weather',
      'Mình ngày nào cũng làm',
      'Anh Mai nói là được',
    ],
  );
});

describe('filterCounts and lineMatches', () => {
  const lines = [{ text: 'Giá bao nhiêu?' }, { text: 'Báo giá 2tr5, gửi thứ Sáu' }, { text: 'Cảm ơn anh' }];
  it('counts each filter over the lines', () => {
    expect(filterCounts(lines)).toEqual({ question: 1, figure: 1, date: 1 });
  });
  it('matches one filter on one line', () => {
    expect(lineMatches('question', 'Giá bao nhiêu?')).toBe(true);
    expect(lineMatches('figure', 'Giá bao nhiêu?')).toBe(false);
    expect(lineMatches('date', 'Báo giá 2tr5, gửi thứ Sáu')).toBe(true);
  });
});
