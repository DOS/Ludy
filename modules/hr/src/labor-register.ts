// SPDX-License-Identifier: AGPL-3.0-only
// Labor management register (Sổ quản lý lao động, Labor Code 2019 Art. 12 & Decree 145/2020/ND-CP Art. 3)
// and semiannual labor usage report 01/PLI (Sở Nội vụ, plan section 5 row 17 and section 7; #2541 slice 2a / #3359).
//
// Pure document builders matching `./declarations.ts` and `./declaration-xlsx.ts`: typed columns (`text`, `money`,
// `count`), deterministic ordering, erased-staff masking (`[Đã xóa theo yêu cầu]`), `HR_DECLARATION_MAX_PEOPLE` cap
// enforcement, and a draft banner referencing plan row 17 while `!PLAN_ROWS_CONFIRMED.has(17)`.

import { HR_DECLARATION_MAX_PEOPLE, HR_ERASED_NAME } from '@crove/kernel-contract';
import { DomainError } from '@crove/kernel-runtime';
import { isLaborContractKind, isValidCalendarDate, money, type LaborContractKind } from '@crove/l10n-vn';
import {
  DECLARATION_NOT_SENT,
  DECLARATION_NOTICE,
  PLAN_ROWS_CONFIRMED,
  type DeclarationColumn,
  type DeclarationEmployer,
  type DeclarationSheet,
} from './declarations.ts';

// ---------------------------------------------------------------------------------------------------------------------
// Layouts, constants, and draft banner
// ---------------------------------------------------------------------------------------------------------------------

export const LABOR_REGISTER_KINDS = ['labor_register', '01pli'] as const;
export type LaborRegisterKind = (typeof LABOR_REGISTER_KINDS)[number];

export const LABOR_REGISTER_LAYOUTS: Readonly<Record<LaborRegisterKind, { form: string; version: string }>> = {
  labor_register: {
    form: 'Sổ quản lý lao động (Điều 12 BLLĐ 2019, Điều 3 NĐ 145/2020/NĐ-CP)',
    version: 'ludy-hr-labor-register/1',
  },
  '01pli': {
    form: 'Báo cáo tình hình sử dụng lao động Mẫu 01/PLI (NĐ 145/2020/NĐ-CP)',
    version: 'ludy-hr-01pli/1',
  },
};

export const LABOR_REGISTER_ERASED_PLACEHOLDER = `[${HR_ERASED_NAME}]` as const;

const PLAN_ROW_LABOR_CODE = 17;

function laborRegisterDraftBanner(): string | null {
  if (PLAN_ROWS_CONFIRMED.has(PLAN_ROW_LABOR_CODE)) return null;
  return `BẢN NHÁP: dòng ${PLAN_ROW_LABOR_CODE} của kế hoạch tiền lương (docs/plan/payroll.md, mục 5) chưa được kế toán xác nhận (#2535). Hãy đối chiếu với biểu mẫu chính thức trước khi khai.`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Input and document types
// ---------------------------------------------------------------------------------------------------------------------

export type LaborRegisterContractKind = LaborContractKind | 'none';
export type LaborRegisterGender = 'male' | 'female' | 'other';
export type LaborRegisterWorkerGroup = 'manager' | 'high_technical' | 'mid_technical' | 'other';

export interface LaborRegisterPerson {
  employeeId: string;
  name: string;
  erased?: boolean;
  gender?: LaborRegisterGender | null;
  birthDate?: string | null;
  nationality?: string | null;
  address?: string | null;
  identityNumber?: string | null;
  taxCode?: string | null;
  insuranceNumber?: string | null;
  qualification?: string | null;
  position?: string | null;
  workerGroup?: LaborRegisterWorkerGroup | null;
  contractKind: LaborRegisterContractKind;
  contractStartDate: string;
  contractEndDate?: string | null;
  startedOn: string;
  endedOn?: string | null;
  baseWage?: string | null;
  allowance?: string | null;
  otherAmounts?: string | null;
  insured?: boolean;
  insuranceStartMonth?: string | null;
  insuranceEndMonth?: string | null;
  note?: string | null;
}

export interface LaborRegisterInput {
  employer: DeclarationEmployer;
  persons: readonly LaborRegisterPerson[];
  /** Optional ISO calendar date (YYYY-MM-DD) recorded in the document header. */
  asOf?: string;
}

export interface Report01PliInput {
  /** Semiannual period `YYYY-H1` or `YYYY-H2`. */
  period: string;
  employer: DeclarationEmployer;
  persons: readonly LaborRegisterPerson[];
}

export interface LaborRegisterDocument {
  kind: LaborRegisterKind;
  notice: typeof DECLARATION_NOTICE;
  notSent: typeof DECLARATION_NOT_SENT;
  layout: { form: string; version: string };
  draft: string | null;
  title: string;
  header: { label: string; value: string }[];
  sheets: DeclarationSheet[];
  notes: string[];
}

// ---------------------------------------------------------------------------------------------------------------------
// Labels and deterministic helpers
// ---------------------------------------------------------------------------------------------------------------------

const CONTRACT_LABEL: Readonly<Record<LaborRegisterContractKind, string>> = {
  indefinite: 'Không xác định thời hạn',
  fixed_term: 'Xác định thời hạn',
  under_one_month: 'Dưới 1 tháng',
  none: 'Không ký HĐLĐ',
};

const GENDER_LABEL: Readonly<Record<LaborRegisterGender, string>> = {
  male: 'Nam',
  female: 'Nữ',
  other: 'Khác',
};

const WORKER_GROUP_LABEL: Readonly<Record<LaborRegisterWorkerGroup, string>> = {
  manager: 'Nhà quản lý',
  high_technical: 'Chuyên môn kỹ thuật bậc cao',
  mid_technical: 'Chuyên môn kỹ thuật bậc trung',
  other: 'Khác',
};

const textOf = (value: string | null | undefined): string => value ?? '';

function formatMoneyCell(label: string, raw: string | null | undefined, employeeId: string): string {
  if (raw === undefined || raw === null || raw === '') return '';
  let parsed: ReturnType<typeof money>;
  try {
    if (raw.trim() === '') return '';
    parsed = money(raw);
  } catch {
    throw new DomainError('HR_INVALID_AMOUNT', 422, `Số tiền ${label} không hợp lệ cho nhân viên ${employeeId}`);
  }
  if (parsed.isNegative()) {
    throw new DomainError('HR_INVALID_AMOUNT', 422, `Số tiền ${label} không được âm cho nhân viên ${employeeId}`);
  }
  return parsed.toDecimalPlaces(2).toFixed(2);
}

function assertDate(label: string, value: string | null | undefined, required: boolean, employeeId: string): void {
  if (value === undefined || value === null || value === '') {
    if (required) throw new DomainError('HR_INVALID_DATE', 422, `Thiếu hoặc sai định dạng ${label} cho nhân viên ${employeeId}`);
    return;
  }
  if (!isValidCalendarDate(value)) {
    throw new DomainError('HR_INVALID_DATE', 422, `Ngày ${label} (${value}) không hợp lệ cho nhân viên ${employeeId}`);
  }
}

function validatePersons(persons: readonly LaborRegisterPerson[]): void {
  if (persons.length > HR_DECLARATION_MAX_PEOPLE) {
    throw new DomainError('EXPORT_TOO_LARGE', 422, `Có hơn ${HR_DECLARATION_MAX_PEOPLE} người trong bảng kê này; không xuất được một lần`);
  }
  const seen = new Set<string>();
  for (const p of persons) {
    if (seen.has(p.employeeId)) {
      throw new DomainError('HR_DUPLICATE_EMPLOYEE', 422, `Danh sách có nhân viên trùng mã: ${p.employeeId}`);
    }
    seen.add(p.employeeId);
    if (!isLaborContractKind(p.contractKind) && p.contractKind !== 'none') {
      throw new DomainError('HR_INVALID_CONTRACT_KIND', 422, `Loại hợp đồng không hợp lệ (${String(p.contractKind)}) cho nhân viên ${p.employeeId}`);
    }
    assertDate('startedOn', p.startedOn, true, p.employeeId);
    assertDate('contractStartDate', p.contractStartDate, true, p.employeeId);
    assertDate('endedOn', p.endedOn, false, p.employeeId);
    assertDate('contractEndDate', p.contractEndDate, false, p.employeeId);
    if (!p.erased) {
      assertDate('birthDate', p.birthDate, false, p.employeeId);
    }
    if (p.endedOn && p.endedOn < p.startedOn) {
      throw new DomainError('HR_END_BEFORE_START', 422, `Ngày nghỉ việc trước ngày bắt đầu của nhân viên ${p.employeeId}`);
    }
    if (p.contractEndDate && p.contractEndDate < p.contractStartDate) {
      throw new DomainError('HR_END_BEFORE_START', 422, `Ngày kết thúc hợp đồng trước ngày bắt đầu của nhân viên ${p.employeeId}`);
    }
  }
}

function employerHeader(employer: DeclarationEmployer, extra: { label: string; value: string }[]): { label: string; value: string }[] {
  return [
    { label: 'Đơn vị', value: employer.name },
    { label: 'Mã số thuế', value: textOf(employer.taxCode) },
    { label: 'Địa chỉ', value: textOf(employer.address) },
    ...extra,
  ];
}

function effectiveDisplayName(person: LaborRegisterPerson): string {
  return person.erased ? LABOR_REGISTER_ERASED_PLACEHOLDER : person.name;
}

/** Sorts deterministically using the masked name so erased staff never leak alphabetical position. */
function sortPersons(persons: readonly LaborRegisterPerson[]): LaborRegisterPerson[] {
  return [...persons].sort((a, b) => effectiveDisplayName(a).localeCompare(effectiveDisplayName(b), 'vi') || a.employeeId.localeCompare(b.employeeId));
}

// ---------------------------------------------------------------------------------------------------------------------
// Sổ quản lý lao động (Labor Code 2019 Art. 12 & Decree 145/2020/ND-CP Art. 3)
// ---------------------------------------------------------------------------------------------------------------------

const LABOR_REGISTER_COLUMNS: DeclarationColumn[] = [
  { key: 'seq', header: 'STT', kind: 'count' },
  { key: 'name', header: 'Họ và tên', kind: 'text' },
  { key: 'gender', header: 'Giới tính', kind: 'text' },
  { key: 'birthDate', header: 'Ngày sinh', kind: 'text' },
  { key: 'nationality', header: 'Quốc tịch', kind: 'text' },
  { key: 'address', header: 'Địa chỉ', kind: 'text' },
  { key: 'identityNumber', header: 'Số định danh cá nhân', kind: 'text' },
  { key: 'taxCode', header: 'Mã số thuế', kind: 'text' },
  { key: 'insuranceNumber', header: 'Số sổ BHXH', kind: 'text' },
  { key: 'qualification', header: 'Trình độ chuyên môn', kind: 'text' },
  { key: 'position', header: 'Vị trí việc làm', kind: 'text' },
  { key: 'contractType', header: 'Loại hợp đồng lao động', kind: 'text' },
  { key: 'contractStartDate', header: 'Ngày bắt đầu HĐLĐ', kind: 'text' },
  { key: 'contractEndDate', header: 'Ngày kết thúc HĐLĐ', kind: 'text' },
  { key: 'baseWage', header: 'Mức lương hợp đồng', kind: 'money' },
  { key: 'insured', header: 'Tham gia BHXH bắt buộc', kind: 'text' },
  { key: 'endedOn', header: 'Ngày nghỉ việc', kind: 'text' },
  { key: 'note', header: 'Ghi chú', kind: 'text' },
];

/** Builds the Labor Management Register (`Sổ quản lý lao động`, layout `ludy-hr-labor-register/1`). */
export function buildLaborRegister(input: LaborRegisterInput): LaborRegisterDocument {
  if (input.asOf !== undefined && !isValidCalendarDate(input.asOf)) {
    throw new DomainError('HR_INVALID_DATE', 422, `Ngày chốt sổ không hợp lệ: ${input.asOf}`);
  }
  validatePersons(input.persons);

  const sorted = sortPersons(input.persons);
  let erasedCount = 0;

  const rows: Record<string, string>[] = sorted.map((p, index) => {
    const erased = p.erased === true;
    if (erased) erasedCount += 1;

    return {
      seq: String(index + 1),
      name: effectiveDisplayName(p),
      gender: erased ? '' : p.gender ? GENDER_LABEL[p.gender] : '',
      birthDate: erased ? '' : textOf(p.birthDate),
      nationality: erased ? '' : p.nationality === undefined || p.nationality === null ? 'Việt Nam' : p.nationality,
      address: erased ? '' : textOf(p.address),
      identityNumber: erased ? '' : textOf(p.identityNumber),
      taxCode: erased ? '' : textOf(p.taxCode),
      insuranceNumber: erased ? '' : textOf(p.insuranceNumber),
      qualification: erased ? '' : textOf(p.qualification),
      position: erased ? '' : textOf(p.position),
      contractType: CONTRACT_LABEL[p.contractKind],
      contractStartDate: p.contractStartDate,
      contractEndDate: textOf(p.contractEndDate),
      baseWage: formatMoneyCell('lương hợp đồng', p.baseWage, p.employeeId),
      insured: p.insured === undefined ? '' : p.insured ? 'Có' : 'Không',
      endedOn: textOf(p.endedOn),
      note: erased ? '' : textOf(p.note),
    };
  });

  const sheet: DeclarationSheet = {
    name: 'Sổ quản lý lao động',
    title: input.asOf ? `Sổ quản lý lao động tính đến ngày ${input.asOf}` : 'Sổ quản lý lao động',
    columns: LABOR_REGISTER_COLUMNS,
    rows,
  };

  const notes = [
    'Sổ quản lý lao động do người sử dụng lao động lập và lưu giữ tại đơn vị theo Điều 12 Bộ luật Lao động 2019 và Điều 3 Nghị định 145/2020/NĐ-CP.',
    'Ludy không nộp hay ký trực tiếp báo cáo thay đơn vị; người dùng rà soát số liệu trước khi lưu trữ hoặc xuất trình khi cơ quan chức năng yêu cầu.',
  ];
  if (erasedCount > 0) {
    notes.push(`${erasedCount} hồ sơ đã xóa theo yêu cầu được che bằng nhãn ${LABOR_REGISTER_ERASED_PLACEHOLDER} và để trống toàn bộ thông tin định danh cá nhân.`);
  }
  if (input.employer.taxCode === null) {
    notes.push('Đơn vị chưa có mã số thuế trong hồ sơ pháp nhân.');
  }

  const headExtra = input.asOf ? [{ label: 'Ngày lập sổ', value: input.asOf }] : [];
  return {
    kind: 'labor_register',
    notice: DECLARATION_NOTICE,
    notSent: DECLARATION_NOT_SENT,
    layout: LABOR_REGISTER_LAYOUTS.labor_register,
    draft: laborRegisterDraftBanner(),
    title: `${DECLARATION_NOTICE} Sổ quản lý lao động`,
    header: employerHeader(input.employer, headExtra),
    sheets: [sheet],
    notes,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Semiannual labor usage report 01/PLI (Decree 145/2020/ND-CP Art. 4 & Form 01/PLI, to Sở Nội vụ)
// ---------------------------------------------------------------------------------------------------------------------

const SEMIANNUAL_RE = /^(\d{4})-H([12])$/;

export function parseSemiannualPeriod(period: string): { year: number; half: 1 | 2; startDate: string; endDate: string } {
  const match = SEMIANNUAL_RE.exec(period);
  if (!match) {
    throw new DomainError('HR_INVALID_PERIOD', 422, `Kỳ báo cáo 01/PLI phải có dạng YYYY-H1 hoặc YYYY-H2 (nhận: ${period})`);
  }
  const year = Number(match[1]);
  const half = Number(match[2]) as 1 | 2;
  if (year < 2000 || year > 2100) {
    throw new DomainError('HR_INVALID_PERIOD', 422, `Năm kỳ báo cáo 01/PLI không hợp lệ: ${period}`);
  }
  return half === 1
    ? { year, half, startDate: `${match[1]}-01-01`, endDate: `${match[1]}-06-30` }
    : { year, half, startDate: `${match[1]}-07-01`, endDate: `${match[1]}-12-31` };
}

const REPORT_01PLI_DETAIL_COLUMNS: DeclarationColumn[] = [
  { key: 'seq', header: 'STT', kind: 'count' },
  { key: 'name', header: 'Họ và tên', kind: 'text' },
  { key: 'insuranceNumber', header: 'Mã số BHXH', kind: 'text' },
  { key: 'birthDate', header: 'Ngày tháng năm sinh', kind: 'text' },
  { key: 'gender', header: 'Giới tính', kind: 'text' },
  { key: 'identityNumber', header: 'Số định danh cá nhân / Hộ chiếu', kind: 'text' },
  { key: 'position', header: 'Chức vụ / Vị trí việc làm', kind: 'text' },
  { key: 'workerGroup', header: 'Loại vị trí công việc', kind: 'text' },
  { key: 'baseWage', header: 'Mức lương', kind: 'money' },
  { key: 'allowance', header: 'Phụ cấp lương', kind: 'money' },
  { key: 'otherAmounts', header: 'Các khoản bổ sung khác', kind: 'money' },
  { key: 'contractStartDate', header: 'Ngày bắt đầu hiệu lực HĐLĐ', kind: 'text' },
  { key: 'contractType', header: 'Loại hợp đồng lao động', kind: 'text' },
  { key: 'contractEndDate', header: 'Ngày kết thúc HĐLĐ xác định thời hạn', kind: 'text' },
  { key: 'insuranceStartMonth', header: 'Thời điểm bắt đầu đóng BHXH', kind: 'text' },
  { key: 'insuranceEndMonth', header: 'Thời điểm kết thúc đóng BHXH', kind: 'text' },
  { key: 'endedOn', header: 'Ngày nghỉ việc / giảm lao động', kind: 'text' },
  { key: 'note', header: 'Ghi chú', kind: 'text' },
];

/** Builds the semiannual 01/PLI labor usage report (`ludy-hr-01pli/1`) for submission to `Sở Nội vụ`. */
export function build01PliReport(input: Report01PliInput): LaborRegisterDocument {
  const window = parseSemiannualPeriod(input.period);
  validatePersons(input.persons);

  const inPeriod = sortPersons(
    input.persons.filter((p) => p.startedOn <= window.endDate && (p.endedOn === undefined || p.endedOn === null || p.endedOn >= window.startDate)),
  );

  let atStartCount = 0;
  let hiredCount = 0;
  let endedCount = 0;
  let atEndCount = 0;
  let indefiniteCount = 0;
  let fixedTermCount = 0;
  let underOneMonthCount = 0;
  let femaleCount = 0;
  let insuredCount = 0;
  let erasedCount = 0;
  let missingInsuranceNoCount = 0;

  const detailRows: Record<string, string>[] = inPeriod.map((p, index) => {
    const erased = p.erased === true;
    if (erased) erasedCount += 1;
    else if (!p.insuranceNumber && p.insured !== false) missingInsuranceNoCount += 1;

    const startedBefore = p.startedOn < window.startDate;
    const hiredHere = p.startedOn >= window.startDate && p.startedOn <= window.endDate;
    const endedHere = p.endedOn !== undefined && p.endedOn !== null && p.endedOn >= window.startDate && p.endedOn <= window.endDate;
    const activeAtEnd = p.endedOn === undefined || p.endedOn === null || p.endedOn > window.endDate;

    if (startedBefore) atStartCount += 1;
    if (hiredHere) hiredCount += 1;
    if (endedHere) endedCount += 1;
    if (activeAtEnd) {
      atEndCount += 1;
      if (p.contractKind === 'indefinite') indefiniteCount += 1;
      else if (p.contractKind === 'fixed_term') fixedTermCount += 1;
      else underOneMonthCount += 1;
      if (!erased && p.gender === 'female') femaleCount += 1;
      if (p.insured === true) insuredCount += 1;
    }

    return {
      seq: String(index + 1),
      name: effectiveDisplayName(p),
      insuranceNumber: erased ? '' : textOf(p.insuranceNumber),
      birthDate: erased ? '' : textOf(p.birthDate),
      gender: erased ? '' : p.gender ? GENDER_LABEL[p.gender] : '',
      identityNumber: erased ? '' : textOf(p.identityNumber),
      position: erased ? '' : textOf(p.position),
      workerGroup: erased ? '' : p.workerGroup ? WORKER_GROUP_LABEL[p.workerGroup] : '',
      baseWage: formatMoneyCell('mức lương', p.baseWage, p.employeeId),
      allowance: formatMoneyCell('phụ cấp lương', p.allowance, p.employeeId),
      otherAmounts: formatMoneyCell('khoản bổ sung khác', p.otherAmounts, p.employeeId),
      contractStartDate: p.contractStartDate,
      contractType: CONTRACT_LABEL[p.contractKind],
      contractEndDate: textOf(p.contractEndDate),
      insuranceStartMonth: textOf(p.insuranceStartMonth),
      insuranceEndMonth: textOf(p.insuranceEndMonth),
      endedOn: textOf(p.endedOn),
      note: erased ? '' : textOf(p.note),
    };
  });

  const summarySheet: DeclarationSheet = {
    name: 'Tổng hợp 01-PLI',
    title: `Tổng hợp tình hình sử dụng lao động kỳ ${input.period} (Mẫu 01/PLI)`,
    columns: [
      { key: 'item', header: 'Chỉ tiêu', kind: 'text' },
      { key: 'value', header: 'Số lượng', kind: 'count' },
    ],
    rows: [
      { item: 'Tổng số lao động sử dụng trong kỳ', value: String(inPeriod.length) },
      { item: 'Số lao động đầu kỳ', value: String(atStartCount) },
      { item: 'Số lao động tăng mới trong kỳ', value: String(hiredCount) },
      { item: 'Số lao động giảm trong kỳ', value: String(endedCount) },
      { item: 'Số lao động cuối kỳ', value: String(atEndCount) },
      { item: 'Cuối kỳ: Hợp đồng không xác định thời hạn', value: String(indefiniteCount) },
      { item: 'Cuối kỳ: Hợp đồng xác định thời hạn', value: String(fixedTermCount) },
      { item: 'Cuối kỳ: Hợp đồng dưới 1 tháng hoặc không ký HĐLĐ', value: String(underOneMonthCount) },
      { item: 'Cuối kỳ: Lao động nữ (không gồm hồ sơ đã xóa)', value: String(femaleCount) },
      { item: 'Cuối kỳ: Tham gia BHXH bắt buộc', value: String(insuredCount) },
    ],
  };

  const detailSheet: DeclarationSheet = {
    name: 'Chi tiết 01-PLI',
    title: `Danh sách chi tiết lao động kỳ ${input.period} (Mẫu 01/PLI)`,
    columns: REPORT_01PLI_DETAIL_COLUMNS,
    rows: detailRows,
  };

  const notes = [
    'Báo cáo tình hình sử dụng lao động Mẫu 01/PLI được lập định kỳ 6 tháng (kỳ 6 tháng đầu năm trước ngày 05/06 và kỳ cả năm trước ngày 05/12) gửi Sở Nội vụ.',
    'Ludy chỉ tạo bảng kê để đối chiếu; đơn vị tự kiểm tra, ký và nộp trên Cổng Dịch vụ công Quốc gia hoặc kênh chính thức của Sở Nội vụ.',
  ];
  if (erasedCount > 0) {
    notes.push(`${erasedCount} hồ sơ đã xóa theo yêu cầu được che bằng nhãn ${LABOR_REGISTER_ERASED_PLACEHOLDER} và để trống thông tin định danh cá nhân; số lượng tổng hợp vẫn phản ánh lịch sử sử dụng lao động trong kỳ.`);
  }
  if (missingInsuranceNoCount > 0) {
    notes.push(`${missingInsuranceNoCount} người lao động chưa có mã số BHXH trong danh sách chi tiết: bổ sung trước khi nộp báo cáo.`);
  }
  if (input.employer.taxCode === null) {
    notes.push('Đơn vị chưa có mã số thuế trong hồ sơ pháp nhân.');
  }

  return {
    kind: '01pli',
    notice: DECLARATION_NOTICE,
    notSent: DECLARATION_NOT_SENT,
    layout: LABOR_REGISTER_LAYOUTS['01pli'],
    draft: laborRegisterDraftBanner(),
    title: `${DECLARATION_NOTICE} 01/PLI kỳ ${input.period}`,
    header: employerHeader(input.employer, [
      { label: 'Cơ quan nhận', value: 'Sở Nội vụ' },
      { label: 'Kỳ báo cáo', value: `${input.period} (${window.startDate} đến ${window.endDate})` },
    ]),
    sheets: [summarySheet, detailSheet],
    notes,
  };
}
