// SPDX-License-Identifier: AGPL-3.0-only
// Shared case table for crove_kernel.text_detect and crove_kernel.text_redact_spans (#4001, Slice 1):
// covers real values across all five structured kinds and near-misses that must stay undetected.

export const REDACTION_KINDS = ['email', 'phone', 'national_id', 'tax_code', 'bank_account'] as const;
export type RedactionKind = (typeof REDACTION_KINDS)[number];

export interface ExpectedDetection {
  kind: RedactionKind;
  matchText: string;
}

export interface PiiDetectCase {
  name: string;
  text: string;
  expected: readonly ExpectedDetection[];
}

export const PII_DETECT_CASES: readonly PiiDetectCase[] = [
  // --- Emails ---
  {
    name: 'standard email in Vietnamese sentence',
    text: 'Đã gửi báo giá cho khach.hang@congty.example hôm nay.',
    expected: [{ kind: 'email', matchText: 'khach.hang@congty.example' }],
  },
  {
    name: 'uppercase email and punctuation wrapping',
    text: 'Liên hệ AB@X.EXAMPLE, hoặc <a.b+tag@sub.example.com>; (support@ludy.example).',
    expected: [
      { kind: 'email', matchText: 'AB@X.EXAMPLE' },
      { kind: 'email', matchText: 'a.b+tag@sub.example.com' },
      { kind: 'email', matchText: 'support@ludy.example' },
    ],
  },
  {
    name: 'non-ASCII Latin email and apostrophe in local part',
    text: "Gửi đặng@x.example và o'brien@example.com nhé.",
    expected: [
      { kind: 'email', matchText: 'đặng@x.example' },
      { kind: 'email', matchText: "o'brien@example.com" },
    ],
  },
  {
    name: 'email wrapped in single quotes, backticks, or curly quotes',
    text: "Mail là 'ab@x.example', `cd@y.example`, “ef@z.example”…",
    expected: [
      { kind: 'email', matchText: 'ab@x.example' },
      { kind: 'email', matchText: 'cd@y.example' },
      { kind: 'email', matchText: 'ef@z.example' },
    ],
  },
  {
    name: 'email with digit local part is detected as email, not digits',
    text: 'Tài khoản 0912345678@congty.example đã nhận.',
    expected: [{ kind: 'email', matchText: '0912345678@congty.example' }],
  },
  {
    name: 'email with punycode TLD',
    text: 'Liên hệ admin@xn--ng-jia.xn--p1ai để kiểm tra.',
    expected: [{ kind: 'email', matchText: 'admin@xn--ng-jia.xn--p1ai' }],
  },

  // --- Vietnamese & international phones ---
  {
    name: 'VN mobile with spaces, dots, dashes, brackets',
    text: 'Gọi 0912 345 678, 0912.345.678, 091-234-5678 hoặc (091) 234 5678.',
    expected: [
      { kind: 'phone', matchText: '0912 345 678' },
      { kind: 'phone', matchText: '0912.345.678' },
      { kind: 'phone', matchText: '091-234-5678' },
      { kind: 'phone', matchText: '(091) 234 5678' },
    ],
  },
  {
    name: 'VN mobile prefixes 03, 05, 07, 08, 09',
    text: '0321234567, 0561234567, 0791234567, 0881234567, 0901234567',
    expected: [
      { kind: 'phone', matchText: '0321234567' },
      { kind: 'phone', matchText: '0561234567' },
      { kind: 'phone', matchText: '0791234567' },
      { kind: 'phone', matchText: '0881234567' },
      { kind: 'phone', matchText: '0901234567' },
    ],
  },
  {
    name: 'VN mobile with +84, +84 (0), 84, and 0084',
    text: 'Zalo +84 912 345 678, +84 (0) 912 345 678, (+84) 912 345 678, 84912345678, 0084 912 345 678.',
    expected: [
      { kind: 'phone', matchText: '+84 912 345 678' },
      { kind: 'phone', matchText: '+84 (0) 912 345 678' },
      { kind: 'phone', matchText: '(+84) 912 345 678' },
      { kind: 'phone', matchText: '84912345678' },
      { kind: 'phone', matchText: '0084 912 345 678' },
    ],
  },
  {
    name: 'VN mobile and landline with trunk-zero, dot-grouped, and round-zero variants',
    text: '0084 (0) 912 345 678, (+84) (0) 912 345 678, +84 0912 345 678, +84 (028) 3829 1234, +84 (091) 234 5678, +84.912.345.678, +84 911 100 000, SĐT 84.912.345.678, SĐT 842838000000.',
    expected: [
      { kind: 'phone', matchText: '0084 (0) 912 345 678' },
      { kind: 'phone', matchText: '(+84) (0) 912 345 678' },
      { kind: 'phone', matchText: '+84 0912 345 678' },
      { kind: 'phone', matchText: '+84 (028) 3829 1234' },
      { kind: 'phone', matchText: '+84 (091) 234 5678' },
      { kind: 'phone', matchText: '+84.912.345.678' },
      { kind: 'phone', matchText: '+84 911 100 000' },
      { kind: 'phone', matchText: '84.912.345.678' },
      { kind: 'phone', matchText: '842838000000' },
    ],
  },
  {
    name: 'VN landline with 024, (028), +84 28, and 8424',
    text: '(028) 3829.1234, 024 3826 0000, +84 28 3829 1234, 842438260000, (0251) 382 1234.',
    expected: [
      { kind: 'phone', matchText: '(028) 3829.1234' },
      { kind: 'phone', matchText: '024 3826 0000' },
      { kind: 'phone', matchText: '+84 28 3829 1234' },
      { kind: 'phone', matchText: '842438260000' },
      { kind: 'phone', matchText: '(0251) 382 1234' },
    ],
  },
  {
    name: 'international phone numbers (+1, +44, +65, 001, NANP)',
    text: 'Call +1 (415) 555-0100, +44 20 7946 0958, +65 9123 4567, 001 415 555 0100, or (415) 555-0199.',
    expected: [
      { kind: 'phone', matchText: '+1 (415) 555-0100' },
      { kind: 'phone', matchText: '+44 20 7946 0958' },
      { kind: 'phone', matchText: '+65 9123 4567' },
      { kind: 'phone', matchText: '001 415 555 0100' },
      { kind: 'phone', matchText: '(415) 555-0199' },
    ],
  },
  {
    name: 'phone with no-break spaces and numbered list lines',
    text: '1. 0912\u00a0345\u202f678\n2. 0987654321',
    expected: [
      { kind: 'phone', matchText: '0912\u00a0345\u202f678' },
      { kind: 'phone', matchText: '0987654321' },
    ],
  },
  {
    name: 'phone wrapped in outer parentheses preserves outer parentheses',
    text: 'Số anh ấy (0912 345 678) đang bận.',
    expected: [{ kind: 'phone', matchText: '0912 345 678' }],
  },
  {
    name: 'phone followed by Vietnamese word starting with d with stroke (để/đi)',
    text: 'Gọi 0912 345 678 để xác nhận.',
    expected: [{ kind: 'phone', matchText: '0912 345 678' }],
  },

  // --- Tax codes (MST) & National IDs (CCCD/CMND) ---
  {
    name: '10-digit enterprise MST and 13-digit branch MST',
    text: 'MST 0101234564 được cấp, chi nhánh 0101234567-001 và MST 3601234565.',
    expected: [
      { kind: 'tax_code', matchText: '0101234564' },
      { kind: 'tax_code', matchText: '0101234567-001' },
      { kind: 'tax_code', matchText: '3601234565' },
    ],
  },
  {
    name: '10-digit MST with checksum valid without explicit label',
    text: 'Xuất hóa đơn cho 0101245486 nhé.',
    expected: [{ kind: 'tax_code', matchText: '0101245486' }],
  },
  {
    name: '12-digit national ID (CCCD) in plain and grouped spellings',
    text: 'CCCD số 079091001234, Hà Nội 001090001234, tách nhóm 079 091 001 234 và CCCD 000 091 777 665.',
    expected: [
      { kind: 'national_id', matchText: '079091001234' },
      { kind: 'national_id', matchText: '001090001234' },
      { kind: 'national_id', matchText: '079 091 001 234' },
      { kind: 'national_id', matchText: '000 091 777 665' },
    ],
  },
  {
    name: '9-digit legacy CMND with one-word or two-word label',
    text: 'CMND cũ 240912345 cấp tại Đồng Nai, CMND cũ số 412345678.',
    expected: [
      { kind: 'national_id', matchText: '240912345' },
      { kind: 'national_id', matchText: '412345678' },
    ],
  },
  {
    name: 'explicitly hinted dot-grouped and 840-prefixed bank accounts',
    text: 'STK 123.456.789, STK 840912345678.',
    expected: [
      { kind: 'bank_account', matchText: '123.456.789' },
      { kind: 'bank_account', matchText: '840912345678' },
    ],
  },

  // --- Bank accounts & card numbers ---
  {
    name: 'long bank accounts (13 to 20 digits) and card numbers (15 to 19 digits)',
    text: 'STK 0011001234567, Techcombank 19034567890123, thẻ 4532 1234 5678 9012, Amex 3782 822463 10005, ảo 97042292123456789012.',
    expected: [
      { kind: 'bank_account', matchText: '0011001234567' },
      { kind: 'bank_account', matchText: '19034567890123' },
      { kind: 'bank_account', matchText: '4532 1234 5678 9012' },
      { kind: 'bank_account', matchText: '3782 822463 10005' },
      { kind: 'bank_account', matchText: '97042292123456789012' },
    ],
  },
  {
    name: '8-digit and 10-digit and 12-digit bank accounts with bank context',
    text: 'STK ACB 12345678, Tài khoản VND: 108001234567, STK 0912 3456 78 90.',
    expected: [
      { kind: 'bank_account', matchText: '12345678' },
      { kind: 'bank_account', matchText: '108001234567' },
      { kind: 'bank_account', matchText: '0912 3456 78 90' },
    ],
  },
  {
    name: '11-digit number does not extract a 10-digit phone inside it',
    text: 'Mã 09123456789 và 10912345678.',
    expected: [
      { kind: 'bank_account', matchText: '09123456789' },
      { kind: 'bank_account', matchText: '10912345678' },
    ],
  },

  // --- Mixed spans and Unicode code-point offset alignment ---
  {
    name: 'mixed kinds with emojis and Vietnamese diacritics before matches',
    text: '📞 0912 345 678 😀 mail đặng@x.example, CCCD 079091001234, STK 19034567890123.',
    expected: [
      { kind: 'phone', matchText: '0912 345 678' },
      { kind: 'email', matchText: 'đặng@x.example' },
      { kind: 'national_id', matchText: '079091001234' },
      { kind: 'bank_account', matchText: '19034567890123' },
    ],
  },

  // --- Near-misses: MUST return empty ---
  {
    name: 'near-miss: prices with dot thousands, comma thousands, positive deltas, and currency units',
    text: 'Tổng 100.000.000, +100.000.000, hợp đồng 1.250.000.000 đ, +100.000.000 đ, tạm ứng 50,000 VND, 50000000 VND, +50000000 VND, 100000000, +100000000, 15000000đ, $123456789, VND 123456789, USD +12345678, 100 000 000.',
    expected: [],
  },
  {
    name: 'near-miss: years, year ranges, and short counts',
    text: 'Năm 2026, giai đoạn 2025-2026, có 3 nhóm, 12 người, 500 sản phẩm, phòng 1234567, mã 0123456.',
    expected: [],
  },
  {
    name: 'near-miss: dates in slash, dash, dot, space, and compact formats',
    text: 'Ngày 21/11/2026, hạn 21-11-2026, 2026-11-21, 21.11.2026, 20261121, 11-21-2026, lúc 01 02 2025 12.',
    expected: [],
  },
  {
    name: 'near-miss: percentages, ISO and space-separated timestamps, and decimals',
    text: 'Tăng 15%, thuế 12.5%, 12345678%, 100000000 %, lúc 09:30:00, 2026-11-21T13:21:57Z, 2026-11-21 13:21:57, 2026-11-21 10:00:00, 11-21-2026 13:21:57, 09-12-2025 13:00, 20261121132157, pi 3.14159265, +3.14159265, 1234567.89.',
    expected: [],
  },
  {
    name: 'near-miss: meeting numbers, Zoom links, UUIDs, IPv4, negative and overlong plus numbers',
    text: 'Cuộc họp số 42, meeting #123, Zoom ID 842 1234 5678, id cuộc họp 912 3456 7890, https://zoom.us/j/84212345678, 550e8400-e29b-41d4-a716-446655440000, IP 192.168.1.100, 255.255.255.0, lỗ -123456789, mã +1234567890123456.',
    expected: [],
  },
  {
    name: 'near-miss: unlabelled 8-digit numbers, 21+ digit runs, and non-ASCII digits',
    text: 'Mã đơn 12345678, hotline 1900 1234, chuỗi dài 123456789012345678901, số Ả Rập ٠٩١٢٣٤٥٦٧٨ và ０９１２３４５６７８.',
    expected: [],
  },
  {
    name: 'near-miss: invalid email lookalikes and identifier tokens',
    text: 'họp @ 9.30, a@b, @.@., ab@x.example.123, cab..ab@x.example, id0912345678, 0912345678px, 1234567890@localhost.',
    expected: [],
  },
  {
    name: 'near-miss: plain Vietnamese prose with no numbers or emails',
    text: 'Chúng ta thống nhất gửi biên bản họp cho các thành viên vào sáng mai.',
    expected: [],
  },
];
