// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { buildEngageInviteDraft, extractCvFieldsDeterministically } from '../src/recruiting-intake.ts';

describe('recruiting Stage 5D VN deterministic helpers (#4446)', () => {
  it('extracts name, email, VN phone (+84 -> 0), years of experience, and matched opening skills cleanly', () => {
    const rawCv = [
      'CURRICULUM VITAE',
      'Trần Thị Bảo Ngọc',
      'Email: BaoNgoc.HR@Example.VN | SĐT: +84 912 345 678',
      'Kinh nghiệm: 4 năm kinh nghiệm làm Kế toán tổng hợp tại doanh nghiệp SME',
      'Kỹ năng: Thành thạo MISA AMIS, Excel nâng cao, Thuế GTGT và BHXH.',
    ].join('\n');

    const extracted = extractCvFieldsDeterministically(rawCv, ['MISA AMIS', 'Thuế GTGT', 'Tiếng Anh']);
    expect(extracted.displayName).toBe('Trần Thị Bảo Ngọc');
    expect(extracted.email).toBe('baongoc.hr@example.vn');
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
      'SĐT: 0909.888.777',
      '2021 - 2025: Chuyên viên kinh doanh B2B (Zalo OA, CSKH)',
    ].join('\n');

    const extracted = extractCvFieldsDeterministically(rawCv, ['Zalo OA']);
    expect(extracted.displayName).toBe('Lê Hoàng Minh');
    expect(extracted.email).toBeNull();
    expect(extracted.phone).toBe('0909888777');
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
});
