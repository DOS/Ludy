// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  computeProbationPct,
  contractFilename,
  contractTitle,
  defaultContractNumber,
  defaultEmployeeCode,
  isFlatTaxContract,
  maskIdentifier,
  renderLaborContractPdf,
  vnDate,
  vnMoney,
  type LaborContractDocument,
} from '../src/contract-pdf.ts';
import { contractFonts } from '../src/pdf/fonts.ts';

function extractRenderedTextFromPdf(bytes: Uint8Array): { pageCount: number; pages: string[]; rawLatin1: string } {
  const raw = Buffer.from(bytes).toString('latin1');
  const objects = new Map<number, { dict: string; stream: Buffer | null }>();
  for (const m of raw.matchAll(/(\d+) 0 obj\n([\s\S]*?)\nendobj\n/g)) {
    const id = Number(m[1]);
    const body = m[2] ?? '';
    const streamMatch = /^([\s\S]*?)\nstream\n([\s\S]*)\nendstream$/.exec(body);
    if (streamMatch) {
      const dict = streamMatch[1] ?? '';
      const packed = Buffer.from(streamMatch[2] ?? '', 'latin1');
      objects.set(id, { dict, stream: inflateSync(packed) });
    } else {
      objects.set(id, { dict: body, stream: null });
    }
  }

  // Build Font key (/F1, /F2, ...) -> ToUnicode glyph map.
  const pagesObj = objects.get(2)?.dict ?? '';
  const fontMaps = new Map<string, Map<number, string>>();
  for (const fm of pagesObj.matchAll(/\/(F\d+) (\d+) 0 R/g)) {
    const fontKey = fm[1] ?? '';
    const fontObjId = Number(fm[2]);
    const fontDict = objects.get(fontObjId)?.dict ?? '';
    const toUnicodeId = Number(/\/ToUnicode (\d+) 0 R/.exec(fontDict)?.[1] ?? 0);
    const cmapText = objects.get(toUnicodeId)?.stream?.toString('latin1') ?? '';
    const glyphToChar = new Map<number, string>();
    for (const row of cmapText.matchAll(/<([0-9a-fA-F]{4})> <([0-9a-fA-F]+)>/g)) {
      const glyph = Number.parseInt(row[1] ?? '0', 16);
      const hex = row[2] ?? '';
      const units: number[] = [];
      for (let i = 0; i < hex.length; i += 4) {
        units.push(Number.parseInt(hex.slice(i, i + 4), 16));
      }
      glyphToChar.set(glyph, String.fromCharCode(...units));
    }
    fontMaps.set(fontKey, glyphToChar);
  }

  const kidsMatch = /\/Kids \[([^\]]+)\]/.exec(pagesObj)?.[1] ?? '';
  const pageIds = [...kidsMatch.matchAll(/(\d+) 0 R/g)].map((m) => Number(m[1]));
  const pages: string[] = [];
  for (const pageId of pageIds) {
    const pageDict = objects.get(pageId)?.dict ?? '';
    const contentId = Number(/\/Contents (\d+) 0 R/.exec(pageDict)?.[1] ?? 0);
    const content = objects.get(contentId)?.stream?.toString('latin1') ?? '';
    const linesByY: Array<{ y: string; text: string }> = [];
    for (const tj of content.matchAll(/\/(F\d+) [\d.]+ Tf [\d.]+ ([\d.]+) Td <([0-9a-fA-F]+)> Tj/g)) {
      const fontKey = tj[1] ?? '';
      const y = tj[2] ?? '';
      const hex = tj[3] ?? '';
      const map = fontMaps.get(fontKey);
      let decoded = '';
      for (let i = 0; i < hex.length; i += 4) {
        const glyph = Number.parseInt(hex.slice(i, i + 4), 16);
        decoded += map?.get(glyph) ?? '?';
      }
      const prev = linesByY.at(-1);
      if (prev && prev.y === y) prev.text += decoded;
      else linesByY.push({ y, text: decoded });
    }
    pages.push(linesByY.map((l) => l.text).join(' '));
  }
  return { pageCount: pageIds.length, pages, rawLatin1: raw };
}

function sampleContract(over: Partial<LaborContractDocument['terms']> = {}): LaborContractDocument {
  return {
    employer: {
      name: 'Công ty TNHH Công nghệ Ánh Dương',
      taxCode: '0100000000',
      address: '12 Nguyễn Huệ, Phường Bến Nghé, Quận 1, TP. Hồ Chí Minh',
    },
    employee: {
      id: '01950000-0000-7000-8000-00000000a1b2',
      displayName: 'Nguyễn Thị Đặng Hằng',
      birthDate: '1996-08-24',
      address: '45 Lê Lợi, Quận Hải Châu, Đà Nẵng',
      identityMasked: '001090000000',
      jobTitle: 'Chuyên viên Kế toán tổng hợp',
      departmentName: 'Phòng Tài chính - Kế toán',
      workplace: '12 Nguyễn Huệ, Quận 1, TP. Hồ Chí Minh',
    },
    terms: {
      id: '01950000-0000-7000-8000-00000000c3d4',
      contractType: 'fixed_term',
      contractForm: 'written',
      termMonths: 12,
      effectiveFrom: '2026-02-01',
      contractEndOn: null,
      fixedTermSequence: 1,
      probationRoleTier: 'college_or_above',
      probationEndOn: '2026-04-01',
      probationWage: '15300000',
      baseWage: '18000000',
      allowances: [
        { name: 'Phụ cấp ăn trưa', amount: '730000' },
        { name: 'Phụ cấp xăng xe', amount: '500000' },
      ],
      region: 'I',
      payFunction: 'admin',
      employeeInsurable: true,
      taxResident: true,
      ...over,
    },
  };
}

describe('HR labor contract PDF renderer (#3548)', () => {
  it('verifies committed Be Vietnam Pro WOFF hashes and OFL license in modules/hr/assets', () => {
    const directory = new URL('../assets/fonts/be-vietnam-pro/', import.meta.url);
    const source = readFileSync(new URL('SOURCE.md', directory), 'utf8');
    expect(source).not.toContain('\u2014');
    const listed = [...source.matchAll(/\| `([^`]+\.woff)` \| `([0-9a-f]{64})` \|/g)];
    expect(listed).toHaveLength(6);
    for (const [, file, sha] of listed) {
      const actual = createHash('sha256').update(readFileSync(new URL(file as string, directory))).digest('hex');
      expect(actual, file).toBe(sha);
    }
    expect(readFileSync(new URL('OFL.txt', directory), 'utf8')).toContain('SIL OPEN FONT LICENSE Version 1.1');

    const fonts = contractFonts();
    const vietnamese = 'AĂÂBCDĐEÊGHIKLMNOÔƠPQRSTUƯVXYaăâbcdđeêghiklmnoôơpqrstuưvxyÀÁẢÃẠẰẮẲẴẶẦẤẨẪẬÈÉẺẼẸỀẾỂỄỆÌÍỈĨỊÒÓỎÕỌỒỐỔỖỘỜỚỞỠỢÙÚỦŨỤỪỨỬỮỰỲÝỶỸỴ0123456789.,;:-/()%';
    for (const weight of ['regular', 'bold'] as const) {
      for (const ch of vietnamese) {
        const runs = fonts.shape(ch, weight);
        expect(runs.flatMap((r) => r.codePoints), `${weight}:${ch}`).toEqual([ch.codePointAt(0)]);
      }
    }
  });

  it('writes a deterministic PDF 1.7 with valid xref, stream lengths, SFNT checksums, and zero active PDF dictionaries', () => {
    const first = renderLaborContractPdf(sampleContract());
    const second = renderLaborContractPdf(sampleContract());
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
    expect(first.byteLength).toBeGreaterThan(8_000);

    const text = Buffer.from(first).toString('latin1');
    expect(text.startsWith('%PDF-1.7\n')).toBe(true);
    expect(text.endsWith('%%EOF\n')).toBe(true);
    expect(text).not.toMatch(/\/JS\b|\/JavaScript\b|\/OpenAction\b|\/Launch\b|\/AA\b|\/EmbeddedFiles\b|\/Encrypt\b|CreationDate|ModDate/);

    const startxref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(text)?.[1]);
    expect(text.slice(startxref, startxref + 5)).toBe('xref\n');
    const table = /^xref\n0 (\d+)\n((?:\d{10} \d{5} [nf] \n)+)trailer/.exec(text.slice(startxref));
    const count = Number(table?.[1]);
    const entries = (table?.[2] ?? '').match(/[\s\S]{20}/g) ?? [];
    expect(entries).toHaveLength(count);
    expect(entries[0]).toBe('0000000000 65535 f \n');
    entries.slice(1).forEach((entry, index) => {
      const offset = Number(entry.slice(0, 10));
      expect(text.slice(offset, offset + `${index + 1} 0 obj\n`.length)).toBe(`${index + 1} 0 obj\n`);
    });
    for (const m of text.matchAll(/\/Length (\d+) >>\nstream\n/g)) {
      const start = (m.index as number) + m[0].length;
      expect(text.slice(start + Number(m[1]), start + Number(m[1]) + '\nendstream'.length)).toBe('\nendstream');
    }
  });

  it('renders Vietnamese Labor Code 2019 Art. 21 sections, probation pct, masked ID, allowances, and signature blocks with zero em dashes', () => {
    const doc = sampleContract();
    const bytes = renderLaborContractPdf(doc);
    const { pageCount, pages } = extractRenderedTextFromPdf(bytes);
    expect(pageCount).toBeGreaterThanOrEqual(1);
    const fullText = pages.join(' ').replace(/\s+/g, ' ');

    expect(fullText).not.toContain('\u2014');
    expect(fullText).not.toContain('?');
    // Masked identifier only, never raw 12-digit ID
    expect(fullText).not.toContain('001090000000');
    expect(fullText).toContain('********0000');

    for (const phrase of [
      'CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM',
      'Độc lập - Tự do - Hạnh phúc',
      'HỢP ĐỒNG LAO ĐỘNG',
      'Số: HDLD-20260201-00C3D4',
      'Công ty TNHH Công nghệ Ánh Dương',
      '0100000000',
      'Nguyễn Thị Đặng Hằng',
      'NV-0000A1B2',
      '24/08/1996',
      'Chuyên viên Kế toán tổng hợp',
      'Phòng Tài chính - Kế toán',
      'Hợp đồng lao động xác định thời hạn (ký lần thứ 1)',
      '12 tháng',
      '01/02/2026',
      '31/01/2027',
      '01/04/2026',
      '15.300.000 VND/tháng (85% mức lương cơ bản',
      '18.000.000 VND/tháng',
      'Vùng I',
      'Quản lý doanh nghiệp',
      'Phụ cấp ăn trưa: 730.000 VND/tháng',
      'Phụ cấp xăng xe: 500.000 VND/tháng',
      'Bảo hiểm bắt buộc (BHXH, BHYT, BHTN)',
      'biểu thuế lũy tiến từng phần',
      'ĐẠI DIỆN NGƯỜI SỬ DỤNG LAO ĐỘNG (BÊN A)',
      'NGƯỜI LAO ĐỘNG (BÊN B)',
      'Trang 1/',
    ]) {
      expect(fullText, phrase).toContain(phrase);
    }
  });

  it('supports indefinite, fixed_term renewal, seasonal, and under_one_month/none variants plus flat tax and non-insurable clauses', () => {
    const indefiniteText = extractRenderedTextFromPdf(
      renderLaborContractPdf(
        sampleContract({
          contractNumber: 'HD-2026/99 — Thử', // em dash sanitized to hyphen
          contractType: 'indefinite',
          termMonths: null,
          fixedTermSequence: null,
          probationRoleTier: null,
          probationEndOn: null,
          probationWage: null,
          region: 'III',
          payFunction: 'production',
        }),
      ),
    ).pages.join(' ');
    expect(indefiniteText).not.toContain('\u2014');
    expect(indefiniteText).toContain('HD-2026/99 - Thử');
    expect(indefiniteText).toContain('Hợp đồng lao động không xác định thời hạn');
    expect(indefiniteText).toContain('Không áp dụng thử việc');
    expect(indefiniteText).toContain('Vùng III');
    expect(indefiniteText).toContain('Sản xuất trực tiếp');

    const seasonalText = extractRenderedTextFromPdf(
      renderLaborContractPdf(
        sampleContract({
          contractType: 'seasonal',
          termMonths: 2,
          contractEndOn: '2026-03-31',
          fixedTermSequence: null,
          probationRoleTier: null,
          probationEndOn: null,
          probationWage: null,
          region: 'II',
          payFunction: 'sales',
          employeeInsurable: false,
        }),
      ),
    ).pages.join(' ');
    expect(seasonalText).toContain('Hợp đồng lao động theo mùa vụ / công việc nhất định');
    expect(seasonalText).toContain('Vùng II');
    expect(seasonalText).toContain('Bán hàng');
    expect(seasonalText).toContain('khấu trừ thuế TNCN theo tỷ lệ toàn phần (10%');

    const nonResidentText = extractRenderedTextFromPdf(
      renderLaborContractPdf(
        sampleContract({
          taxResident: false,
        }),
      ),
    ).pages.join(' ');
    expect(nonResidentText).toContain('biểu thuế toàn phần đối với cá nhân không cư trú');

    const shortDoc = sampleContract({
      contractType: 'none',
      contractForm: 'electronic',
      termMonths: null,
      contractEndOn: '2026-02-20',
      fixedTermSequence: null,
      probationRoleTier: null,
      probationEndOn: null,
      probationWage: null,
      region: 'IV',
      payFunction: 'construction',
    });
    const longCompany = 'Công ty Cổ phần Đầu tư Thương mại và Dịch vụ Ánh Dương Việt Nam';
    const longEmployee = 'Nguyễn Hoàng Phương Trang Anh Thư';
    const shortWithTags = extractRenderedTextFromPdf(
      renderLaborContractPdf({
        ...shortDoc,
        employer: { ...shortDoc.employer, name: longCompany },
        employee: { ...shortDoc.employee, displayName: longEmployee },
        includeSignTags: true,
      }),
    ).pages.join(' ');
    expect(shortWithTags).toContain('Hợp đồng lao động có thời hạn dưới 01 tháng');
    expect(shortWithTags).toContain('Thông điệp dữ liệu điện tử');
    expect(shortWithTags).toContain('Vùng IV');
    expect(shortWithTags).toContain('Xây dựng cơ bản');
    expect(shortWithTags).toContain('khấu trừ thuế TNCN theo tỷ lệ toàn phần (10%');
    expect(shortWithTags).toContain('{{signature, r1}}');
    expect(shortWithTags).toContain('{{date, r1}}');
    expect(shortWithTags).toContain('{{signature, r2}}');
    expect(shortWithTags).toContain('{{date, r2}}');
    // Both Điều 1 and the wrapped two-column signature block must preserve the full company & employee names without truncation.
    expect(shortWithTags.split('Ánh Dương Việt Nam').length - 1).toBeGreaterThanOrEqual(2);
    expect(shortWithTags.split('Phương Trang Anh Thư').length - 1).toBeGreaterThanOrEqual(2);
  });

  it('formats decimal money without float drift, computes flat-tax PIT eligibility, and generates clean filenames/titles/masks', () => {
    expect(
      isFlatTaxContract({ contractType: 'indefinite', termMonths: null, effectiveFrom: '2026-01-01', contractEndOn: null }),
    ).toBe(false);
    expect(
      isFlatTaxContract({ contractType: 'fixed_term', termMonths: 12, effectiveFrom: '2026-01-01', contractEndOn: '2026-12-31' }),
    ).toBe(false);
    expect(
      isFlatTaxContract({ contractType: 'fixed_term', termMonths: 3, effectiveFrom: '2026-03-01', contractEndOn: '2026-05-31' }),
    ).toBe(false);
    expect(
      isFlatTaxContract({ contractType: 'fixed_term', termMonths: 2, effectiveFrom: '2026-03-01', contractEndOn: '2026-04-30' }),
    ).toBe(true);
    expect(
      isFlatTaxContract({ contractType: 'fixed_term', termMonths: null, effectiveFrom: '2026-03-01', contractEndOn: '2026-05-30' }),
    ).toBe(true);
    expect(
      isFlatTaxContract({ contractType: 'fixed_term', termMonths: null, effectiveFrom: '2026-03-01', contractEndOn: '2026-05-31' }),
    ).toBe(false);
    expect(
      isFlatTaxContract({ contractType: 'none', termMonths: null, effectiveFrom: '2026-03-01', contractEndOn: '2026-03-20' }),
    ).toBe(true);
    expect(vnMoney('15000000')).toBe('15.000.000');
    expect(vnMoney('15000000.00')).toBe('15.000.000');
    expect(vnMoney('9999999999999999.25')).toBe('9.999.999.999.999.999,25');
    expect(vnMoney('0.10')).toBe('0,1');
    expect(computeProbationPct('15300000', '18000000')).toBe('85');
    expect(computeProbationPct('15500000', '18000000')).toBe('86,11');
    expect(vnDate('2026-11-17')).toBe('17/11/2026');
    expect(maskIdentifier('001090000000')).toBe('********0000');
    expect(maskIdentifier('1234')).toBe('****');
    expect(maskIdentifier(null)).toBeNull();
    expect(defaultContractNumber('2026-02-01', '01950000-0000-7000-8000-00000000c3d4')).toBe('HDLD-20260201-00C3D4');
    expect(defaultEmployeeCode('01950000-0000-7000-8000-00000000a1b2')).toBe('NV-0000A1B2');
    expect(contractTitle('Đặng Thị Hằng — CN1', '2026-02-01')).toBe('Hợp đồng lao động - Đặng Thị Hằng - CN1 (2026-02-01)');
    expect(contractFilename('Đặng Thị Hằng', '2026-02-01')).toBe('hop-dong-lao-dong-dang-thi-hang-2026-02-01.pdf');
  });
});
