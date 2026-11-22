// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { buildEngageInviteDraft, extractCvFieldsDeterministically } from '../src/recruiting-intake.ts';

describe('recruiting Stage 5D VN deterministic helpers (#4446)', () => {
  it('extracts name, email, VN phone (+84 -> 0), years of experience, and matched opening skills cleanly', () => {
    const rawCv = [
      'CURRICULUM VITAE',
      'Trần Thị Bảo Ngọc',
      'Email: BaoNgoc.HR@example.com | SĐT: +84 912 345 678',
      'Kinh nghiệm: 4 năm kinh nghiệm làm Kế toán tổng hợp tại doanh nghiệp SME',
      'Kỹ năng: Thành thạo MISA AMIS, Excel nâng cao, Thuế GTGT và BHXH.',
    ].join('\n');

    const extracted = extractCvFieldsDeterministically(rawCv, ['MISA AMIS', 'Thuế GTGT', 'Tiếng Anh']);
    expect(extracted.displayName).toBe('Trần Thị Bảo Ngọc');
    expect(extracted.email).toBe('baongoc.hr@example.com');
    expect(extracted.phone).toBe('0912345678');
    expect(extracted.yearsExperience).toBe(4);
    expect(extracted.matchedSkills).toEqual(expect.arrayContaining(['MISA AMIS', 'Thuế GTGT', 'Excel', 'BHXH']));
    expect(extracted.matchedSkills).not.toContain('Tiếng Anh');
    expect(extracted.notes).toContain('Kinh nghiệm: 4 năm');
    expect(extracted.textPreview).toContain('Trần Thị Bảo Ngọc');
  });

  it('infers years of experience from work date ranges and handles labeled name lines', () => {
    const rawCv = [
      'HỒ SƠ ỨNG VIÊN',
      'Họ và tên: Lê Hoàng Minh',
      'SĐT: 0912.345.678',
      '2021 - 2025: Chuyên viên kinh doanh B2B (Zalo OA, CSKH)',
    ].join('\n');

    const extracted = extractCvFieldsDeterministically(rawCv, ['Zalo OA']);
    expect(extracted.displayName).toBe('Lê Hoàng Minh');
    expect(extracted.email).toBeNull();
    expect(extracted.phone).toBe('0912345678');
    expect(extracted.yearsExperience).toBe(4);
    expect(extracted.matchedSkills).toEqual(expect.arrayContaining(['Zalo OA', 'CSKH']));
  });

  it('builds Vietnamese and English Engage interview invite drafts with GMT+7 calendar slots and fallback copy', () => {
    const slots = [
      { start: '2026-11-25T02:00:00.000Z', end: '2026-11-25T03:00:00.000Z' },
      { start: '2026-11-25T07:30:00.000Z', end: '2026-11-25T08:30:00.000Z' },
    ];

    const zaloVi = buildEngageInviteDraft({
      channel: 'zalo_oa',
      candidateLabel: 'Nguyễn Minh Thư',
      openingTitle: 'Kế toán tổng hợp',
      interviewerName: 'Chị Lan',
      slots,
      lang: 'vi',
    });
    expect(zaloVi).toContain('Nguyễn Minh Thư');
    expect(zaloVi).toContain('Kế toán tổng hợp');
    expect(zaloVi).toContain('Zalo OA');
    expect(zaloVi).toContain('Chị Lan');
    expect(zaloVi).toContain('09:00 - 10:00');
    expect(zaloVi).toContain('14:30 - 15:30');

    const fbNoSlotsEn = buildEngageInviteDraft({
      channel: 'facebook',
      candidateLabel: 'Alex Tran',
      openingTitle: 'Sales Lead',
      slots: [],
      lang: 'en',
    });
    expect(fbNoSlotsEn).toContain('Alex Tran');
    expect(fbNoSlotsEn).toContain('Sales Lead');
    expect(fbNoSlotsEn).toContain('Facebook Page');
    expect(fbNoSlotsEn).toContain('two or three times');
  });

  it('handles 200k-char adversarial inputs linearly without ReDoS (CWE-1333) and enforces 254-char email limits', () => {
    const inputs = ['a'.repeat(200_000), 'a.a.'.repeat(50_000), '@'.repeat(50_000), `${'a'.repeat(30)}@invalid.c `.repeat(4_000)];
    for (const input of inputs) {
      const extracted = extractCvFieldsDeterministically(input);
      expect(extracted.email).toBeNull();
    }

    const trailedEmail = extractCvFieldsDeterministically(`${'a'.repeat(50_000)}\nEmail: ung.vien+hr@example.com.`);
    expect(trailedEmail.email).toBe('ung.vien+hr@example.com');

    // Total length boundary: 254 accepted intact, 255 rejected and scanner continues to next valid address.
    const local64 = 'a'.repeat(64);
    const label61 = 'b'.repeat(61);
    const label60 = 'c'.repeat(60);
    const exact254Domain = `${label61}.${label61}.${label60}.com`; // 61+1+61+1+60+1+3 = 188 chars -> 64+1+188 = 253 chars
    const exact254DomainFull = `${label61}.${label61}.${label61}.com`; // 61+1+61+1+61+1+3 = 189 chars -> 64+1+189 = 254 chars
    const over255Domain = `${label61}.${label61}.${'d'.repeat(62)}.com`; // 190 chars -> 64+1+190 = 255 chars
    expect(`${local64}@${exact254Domain}`).toHaveLength(253);
    expect(`${local64}@${exact254DomainFull}`).toHaveLength(254);
    expect(`${local64}@${over255Domain}`).toHaveLength(255);

    expect(extractCvFieldsDeterministically(`${local64}@${exact254Domain}`).email).toBe(`${local64}@${exact254Domain}`);
    expect(extractCvFieldsDeterministically(`${local64}@${exact254DomainFull}`).email).toBe(`${local64}@${exact254DomainFull}`);
    expect(extractCvFieldsDeterministically(`${local64}@${over255Domain} ok@example.com`).email).toBe('ok@example.com');
  });

  it('merges overlapping employment year spans without counting multi-year gaps', () => {
    const gapped = extractCvFieldsDeterministically('Kinh nghiệm làm việc:\n2010 - 2012: Trợ lý\n2022 - 2024: Kế toán');
    expect(gapped.yearsExperience).toBe(4);

    const overlapping = extractCvFieldsDeterministically('2020 - 2023: Kế toán viên\n2022 - 2025: Kế toán tổng hợp');
    expect(overlapping.yearsExperience).toBe(5);
  });

  it('excludes education and non-employment sections when inferring experience from date ranges', () => {
    const enCv = extractCvFieldsDeterministically(
      ['Education', '2016 - 2020: University', 'Experience', '2022 - 2025: Engineer'].join('\n'),
    );
    expect(enCv.yearsExperience).toBe(3);

    const viCv = extractCvFieldsDeterministically(
      [
        'Nguyễn Thu Hà',
        'Học vấn',
        '2016 - 2020: Đại học Kinh tế TP.HCM',
        'Chứng chỉ',
        '2020 - 2021: Kế toán trưởng',
        'Kinh nghiệm làm việc',
        '2020 - 2022: Trợ lý kế toán',
        '2021 - 2025: Kế toán tổng hợp',
        'Kỹ năng',
        '2018 - 2025: Excel, MISA',
      ].join('\n'),
    );
    expect(viCv.yearsExperience).toBe(5);

    const eduOnly = extractCvFieldsDeterministically(['Học vấn', '2016 - 2020: Đại học Bách khoa'].join('\n'));
    expect(eduOnly.yearsExperience).toBeNull();

    const headerlessMixed = extractCvFieldsDeterministically(
      ['2016 - 2020: Cử nhân Đại học Kinh tế', '2021 - 2024: Chuyên viên nhân sự'].join('\n'),
    );
    expect(headerlessMixed.yearsExperience).toBe(3);

    const longEduLine = extractCvFieldsDeterministically([`Education: ${'a'.repeat(200)}`, '2018 - 2022'].join('\n'));
    expect(longEduLine.yearsExperience).toBeNull();

    const startMs = performance.now();
    const hostileColons = extractCvFieldsDeterministically(`${':'.repeat(200_000)}x`);
    const elapsedMs = performance.now() - startMs;
    expect(hostileColons.yearsExperience).toBeNull();
    expect(hostileColons.email).toBeNull();
    expect(elapsedMs).toBeLessThan(500);
  });
});
