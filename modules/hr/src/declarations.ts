// SPDX-License-Identifier: AGPL-3.0-only
// The payroll declarations as exports (issue #2533; payroll plan docs/plan/payroll.md §6.5, ADR-0046 point 7): the D02-LT of Decision 366 for a month, the quarterly figures of
// 05/KK-TNCN with their schedules, the annual data of 05/QTT-TNCN with its schedules for staff who authorized the payer, and the data of the withholding certificate 03/TNCN.
//
// Pure functions: stored facts in, a sheet description out. Nothing here reads the database, opens a sealed value, writes a file or sends anything: the person files and signs on the
// official channels. Every figure comes from the lines of approved, frozen runs, summed as decimals (decimal.js through the money helpers, never a JS number). Every document carries
// the words "bảng kê để khai báo", the name of its layout version, and, while the plan rows it rests on are not confirmed by the accountant (#2535), a draft banner naming them.
//
// The layout is described, not drawn: a document is sheets of typed columns and rows (text, money, count), so the xlsx file and the print view are two renderings of the same data and
// cannot disagree. Text is always text: a renderer must write every `text` cell as a string cell, never a formula (see the kernel's export route).
import { money, type DecimalValue as Decimal } from '@crove/l10n-vn';

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Names, layout versions and the draft banner
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** The words every export carries: a list to declare from, not a declaration. */
export const DECLARATION_NOTICE = 'Bảng kê để khai báo';
export const DECLARATION_NOT_SENT = 'Ludy không nộp và không ký tờ khai: bạn tự khai và ký trên kênh chính thức của cơ quan bảo hiểm xã hội hoặc cơ quan thuế.';

export const DECLARATION_KINDS = ['d02lt', 'kk', 'qtt', 'certificate'] as const;
export type DeclarationKind = (typeof DECLARATION_KINDS)[number];

/** The layout version of each document: bump the suffix when a column is added, moved or renamed, so a file says which layout it has. */
export const DECLARATION_LAYOUTS: Readonly<Record<DeclarationKind, { form: string; version: string }>> = {
  d02lt: { form: 'D02-LT (Quyết định 366/QĐ-BHXH)', version: 'ludy-hr-d02lt/1' },
  kk: { form: '05/KK-TNCN và bảng kê (Thông tư 89/2026/TT-BTC)', version: 'ludy-hr-05kk/1' },
  qtt: { form: '05/QTT-TNCN và bảng kê (Thông tư 89/2026/TT-BTC)', version: 'ludy-hr-05qtt/1' },
  certificate: { form: '03/TNCN chứng từ khấu trừ thuế (Thông tư 91/2026/TT-BTC)', version: 'ludy-hr-03tncn/1' },
};

/**
 * The plan rows a declaration rests on, still unconfirmed until the accountant flips them (#2535): 9 (the D02-LT), 14 (the quarterly and annual PIT
 * forms and their filing), 15 (the withholding certificate). The banner names them so a person never files a draft by mistake.
 */
export const UNCONFIRMED_PLAN_ROWS: Readonly<Record<DeclarationKind, readonly number[]>> = { d02lt: [9], kk: [14], qtt: [14], certificate: [15] };
export const PLAN_ROWS_CONFIRMED: ReadonlySet<number> = new Set<number>();

const draftBanner = (kind: DeclarationKind): string | null => {
  const rows = UNCONFIRMED_PLAN_ROWS[kind].filter((row) => !PLAN_ROWS_CONFIRMED.has(row));
  if (rows.length === 0) return null;
  return `BẢN NHÁP: dòng ${rows.join(', ')} của kế hoạch tiền lương (docs/plan/payroll.md, mục 5) chưa được kế toán xác nhận (#2535). Hãy đối chiếu với biểu mẫu chính thức trước khi khai.`;
};

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The document model
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------

export type ColumnKind = 'text' | 'money' | 'count';
export interface DeclarationColumn {
  key: string;
  header: string;
  kind: ColumnKind;
}
export interface DeclarationSheet {
  /** The sheet's name in the workbook (at most 31 characters, no `[]:*?/\`). */
  name: string;
  title: string;
  columns: DeclarationColumn[];
  /** One value per column key: a text, or a decimal string for `money`, or an integer string for `count`. */
  rows: Record<string, string>[];
  /** A totals row under the data, keyed like a row; absent when the sheet has none. */
  totals?: Record<string, string>;
}
export interface DeclarationDocument {
  kind: DeclarationKind;
  notice: typeof DECLARATION_NOTICE;
  notSent: typeof DECLARATION_NOT_SENT;
  layout: { form: string; version: string };
  /** Null once the rows it rests on are confirmed. */
  draft: string | null;
  title: string;
  /** What the document is of: the period and the employer (name, tax code), as label and value pairs. */
  header: { label: string; value: string }[];
  sheets: DeclarationSheet[];
  /** What the person must still do or know, one sentence each. */
  notes: string[];
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The facts a builder takes
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------

export const INSURANCE_FUND_KEYS = ['retirement_death', 'sickness_maternity', 'work_accident', 'health', 'unemployment'] as const;
export type InsuranceFundKey = (typeof INSURANCE_FUND_KEYS)[number];
export type WithholdingMode = 'progressive' | 'flat' | 'commitment' | 'below_threshold';

/** The employer the declarations are of: a legal entity's name, tax code and address. */
export interface DeclarationEmployer {
  name: string;
  taxCode: string | null;
  address: string | null;
}

/** A person as the declarations need them, with every identifier already in the clear (the caller opened the sealed ones, audited before the read). */
export interface DeclarationPerson {
  employeeId: string;
  name: string;
  birthDate: string | null;
  taxCode: string | null;
  insuranceNumber: string | null;
  identityNumber: string | null;
  /** The first day of the first employment terms. */
  startedOn: string;
  /** The last day of work, or null while employed. */
  endedOn: string | null;
  /** The tax years the person authorized the payer to finalize (08/UQ-QTT-TNCN). */
  finalizationAuthorizedYears: readonly number[];
}

/** The part of a line's stored breakdown the declarations read. */
export interface DeclarationBreakdown {
  insurance: { suspended: 'not_insured' | 'unpaid_leave' | null; funds: { fund: InsuranceFundKey; wage: string; employee: string; employer: string }[] };
  tax: {
    mode: WithholdingMode;
    exemptMealCash: string;
    exemptOvertime: string;
    exemptNightWork: string;
    personalDeduction: string;
    dependentDeduction: string;
    pensionDeduction: string;
    assessableIncome: string;
  };
}

/** A calculated line of an approved run. `month` is the run's pay month (YYYY-MM). An adjustment line carries signed figures and may have no breakdown. */
export interface DeclarationLine {
  month: string;
  employeeId: string;
  kind: 'pay' | 'adjustment';
  gross: string;
  employeeInsurance: string;
  employerInsurance: string;
  unionFee: string;
  taxableIncome: string;
  pit: string;
  breakdown: DeclarationBreakdown | null;
}

const text = (value: string | null | undefined): string => value ?? '';
const fixed = (value: Decimal): string => value.toDecimalPlaces(2).toFixed(2);
const zero = (): Decimal => money(0);
const byName = <T extends { name: string; employeeId: string }>(a: T, b: T): number => a.name.localeCompare(b.name, 'vi') || a.employeeId.localeCompare(b.employeeId);
const monthOf = (day: string): string => day.slice(0, 7);

const exemptOf = (b: DeclarationBreakdown | null): Decimal => (b === null ? zero() : money(b.tax.exemptMealCash).plus(b.tax.exemptOvertime).plus(b.tax.exemptNightWork));
const deductionsOf = (b: DeclarationBreakdown | null): Decimal => (b === null ? zero() : money(b.tax.personalDeduction).plus(b.tax.dependentDeduction).plus(b.tax.pensionDeduction));
const fundWage = (b: DeclarationBreakdown | null, fund: InsuranceFundKey): Decimal => money(b?.insurance.funds.find((f) => f.fund === fund)?.wage);

function header(employer: DeclarationEmployer, rows: { label: string; value: string }[]): { label: string; value: string }[] {
  return [{ label: 'Đơn vị', value: employer.name }, { label: 'Mã số thuế', value: text(employer.taxCode) }, { label: 'Địa chỉ', value: text(employer.address) }, ...rows];
}

function documentOf(kind: DeclarationKind, title: string, head: { label: string; value: string }[], sheets: DeclarationSheet[], notes: string[]): DeclarationDocument {
  return { kind, notice: DECLARATION_NOTICE, notSent: DECLARATION_NOT_SENT, layout: DECLARATION_LAYOUTS[kind], draft: draftBanner(kind), title, header: head, sheets, notes };
}

const identityColumns: DeclarationColumn[] = [
  { key: 'seq', header: 'STT', kind: 'count' },
  { key: 'name', header: 'Họ và tên', kind: 'text' },
  { key: 'birthDate', header: 'Ngày sinh', kind: 'text' },
  { key: 'identityNumber', header: 'Số định danh cá nhân', kind: 'text' },
  { key: 'taxCode', header: 'Mã số thuế', kind: 'text' },
];

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// D02-LT: the month's new hires, changes and ends, with the contribution wage per fund
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------

export type D02Movement = 'increase' | 'adjust' | 'decrease';
const MOVEMENT_LABEL: Record<D02Movement, string> = { increase: 'Tăng lao động', adjust: 'Điều chỉnh mức đóng', decrease: 'Giảm lao động' };
const MOVEMENT_ORDER: Record<D02Movement, number> = { increase: 0, adjust: 1, decrease: 2 };

const FUND_COLUMNS: DeclarationColumn[] = [
  { key: 'wageRetirement', header: 'Mức đóng quỹ hưu trí và tử tuất', kind: 'money' },
  { key: 'wageSickness', header: 'Mức đóng quỹ ốm đau và thai sản', kind: 'money' },
  { key: 'wageAccident', header: 'Mức đóng quỹ tai nạn lao động, bệnh nghề nghiệp', kind: 'money' },
  { key: 'wageHealth', header: 'Mức đóng bảo hiểm y tế', kind: 'money' },
  { key: 'wageUnemployment', header: 'Mức đóng bảo hiểm thất nghiệp', kind: 'money' },
];

export interface D02LtInput {
  /** YYYY-MM. */
  month: string;
  employer: DeclarationEmployer;
  persons: readonly DeclarationPerson[];
  /** The pay lines of the month's approved run. */
  lines: readonly DeclarationLine[];
  /** The pay lines of the previous month's approved run; null when there is none, so a change of wage cannot be told and none is listed. */
  previousLines: readonly DeclarationLine[] | null;
}

const insuredWage = (line: DeclarationLine | undefined): Decimal | null => {
  if (!line?.breakdown || line.breakdown.insurance.suspended !== null) return null;
  const wage = INSURANCE_FUND_KEYS.reduce((acc, fund) => acc.plus(fundWage(line.breakdown, fund)), zero());
  return wage.isZero() ? null : wage;
};
const sameWages = (a: DeclarationLine, b: DeclarationLine): boolean => INSURANCE_FUND_KEYS.every((fund) => fundWage(a.breakdown, fund).eq(fundWage(b.breakdown, fund)));

/**
 * Who is listed, by the rules of the plan (row 9): a person whose first terms start in the month and who is insured is an increase, effective on the start day; a person whose last
 * day of work falls in the month is a decrease, effective on that day, with the wage they were insured on; an insured person with a different contribution wage in any fund than the month
 * before, or newly insured, is an adjustment effective on the first of the month. A person not insured that month is not listed. Persons who left in an earlier month are not in the run.
 */
export function buildD02Lt(input: D02LtInput): DeclarationDocument {
  const lineOf = (lines: readonly DeclarationLine[] | null, id: string) => lines?.find((l) => l.employeeId === id && l.kind === 'pay');
  const rows: (Record<string, string> & { _order: string; _name: string; _id: string })[] = [];
  let skipped = 0;
  for (const person of input.persons) {
    const line = lineOf(input.lines, person.employeeId);
    if (!line) continue;
    const wage = insuredWage(line);
    const previous = lineOf(input.previousLines, person.employeeId);
    const startsHere = monthOf(person.startedOn) === input.month;
    const endsHere = person.endedOn !== null && monthOf(person.endedOn) === input.month;
    let movement: D02Movement | null = null;
    let effective = `${input.month}-01`;
    if (startsHere && wage !== null) {
      movement = 'increase';
      effective = person.startedOn;
    } else if (endsHere && wage !== null) {
      movement = 'decrease';
      effective = person.endedOn as string;
    } else if (!startsHere && !endsHere && wage !== null && input.previousLines !== null && (previous === undefined || insuredWage(previous) === null || !sameWages(previous, line))) {
      movement = 'adjust';
    }
    if (movement === null) {
      skipped += wage === null ? 1 : 0;
      continue;
    }
    rows.push({
      _order: String(MOVEMENT_ORDER[movement]),
      _name: person.name,
      _id: person.employeeId,
      seq: '',
      movement: MOVEMENT_LABEL[movement],
      name: person.name,
      birthDate: text(person.birthDate),
      identityNumber: text(person.identityNumber),
      insuranceNumber: text(person.insuranceNumber),
      effectiveOn: effective,
      wageRetirement: fixed(fundWage(line.breakdown, 'retirement_death')),
      wageSickness: fixed(fundWage(line.breakdown, 'sickness_maternity')),
      wageAccident: fixed(fundWage(line.breakdown, 'work_accident')),
      wageHealth: fixed(fundWage(line.breakdown, 'health')),
      wageUnemployment: fixed(fundWage(line.breakdown, 'unemployment')),
      note: person.birthDate && person.insuranceNumber ? '' : 'Thiếu ngày sinh hoặc số sổ BHXH: bổ sung trước khi khai',
    });
  }
  rows.sort((a, b) => Number(a._order) - Number(b._order) || byName({ name: a._name, employeeId: a._id }, { name: b._name, employeeId: b._id }));
  const numbered = rows.map(({ _order, _name, _id, ...rest }, index) => ({ ...rest, seq: String(index + 1) }));
  const sheet: DeclarationSheet = {
    name: 'D02-LT',
    title: `D02-LT tháng ${input.month}`,
    columns: [
      { key: 'seq', header: 'STT', kind: 'count' },
      { key: 'movement', header: 'Loại biến động', kind: 'text' },
      { key: 'name', header: 'Họ và tên', kind: 'text' },
      { key: 'birthDate', header: 'Ngày sinh', kind: 'text' },
      { key: 'identityNumber', header: 'Số định danh cá nhân', kind: 'text' },
      { key: 'insuranceNumber', header: 'Số sổ BHXH', kind: 'text' },
      { key: 'effectiveOn', header: 'Có hiệu lực từ', kind: 'text' },
      ...FUND_COLUMNS,
      { key: 'note', header: 'Ghi chú', kind: 'text' },
    ],
    rows: numbered,
  };
  const notes = [
    'Chức danh, nơi làm việc, loại hợp đồng và nơi đăng ký khám chữa bệnh ban đầu chưa được lưu trong Ludy: nhập tay khi khai.',
    'Mức đóng là tiền lương làm căn cứ đóng từng quỹ của tháng, đã áp mức sàn và mức trần theo quy định.',
  ];
  if (input.previousLines === null) notes.push('Chưa có bảng lương đã duyệt của tháng trước nên không liệt kê được những người đổi mức đóng.');
  if (skipped > 0) notes.push(`${skipped} người không đóng bảo hiểm trong tháng nên không có trong danh sách.`);
  return documentOf('d02lt', `${DECLARATION_NOTICE} D02-LT tháng ${input.month}`, header(input.employer, [{ label: 'Tháng', value: input.month }]), [sheet], notes);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// 05/KK-TNCN: a quarter
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------

export const quarterMonths = (quarter: string): string[] => {
  const match = /^(\d{4})-Q([1-4])$/.exec(quarter);
  if (!match) throw new Error(`not a quarter: ${quarter}`);
  const year = match[1] as string;
  const first = (Number(match[2]) - 1) * 3 + 1;
  return [0, 1, 2].map((i) => `${year}-${String(first + i).padStart(2, '0')}`);
};

interface PersonTotals {
  person: DeclarationPerson;
  months: Set<string>;
  gross: Decimal;
  exempt: Decimal;
  insurance: Decimal;
  deductions: Decimal;
  assessable: Decimal;
  taxable: Decimal;
  pit: Decimal;
}
const newTotals = (person: DeclarationPerson): PersonTotals => ({ person, months: new Set(), gross: zero(), exempt: zero(), insurance: zero(), deductions: zero(), assessable: zero(), taxable: zero(), pit: zero() });
function add(t: PersonTotals, line: DeclarationLine): void {
  t.months.add(line.month);
  t.gross = t.gross.plus(line.gross);
  t.exempt = t.exempt.plus(exemptOf(line.breakdown));
  t.insurance = t.insurance.plus(line.employeeInsurance);
  t.deductions = t.deductions.plus(deductionsOf(line.breakdown));
  t.assessable = t.assessable.plus(line.breakdown?.tax.assessableIncome ?? 0);
  t.taxable = t.taxable.plus(line.taxableIncome);
  t.pit = t.pit.plus(line.pit);
}

const scheduleColumns: DeclarationColumn[] = [
  ...identityColumns,
  { key: 'months', header: 'Tháng có chi trả', kind: 'text' },
  { key: 'gross', header: 'Tổng thu nhập chi trả', kind: 'money' },
  { key: 'exempt', header: 'Thu nhập được miễn', kind: 'money' },
  { key: 'insurance', header: 'Bảo hiểm bắt buộc đã trừ', kind: 'money' },
  { key: 'deductions', header: 'Giảm trừ gia cảnh và hưu trí tự nguyện', kind: 'money' },
  { key: 'assessable', header: 'Thu nhập tính thuế', kind: 'money' },
  { key: 'pit', header: 'Thuế đã khấu trừ', kind: 'money' },
  { key: 'note', header: 'Ghi chú', kind: 'text' },
];

function scheduleRow(t: PersonTotals, seq: number, note: string): Record<string, string> {
  return {
    seq: String(seq),
    name: t.person.name,
    birthDate: text(t.person.birthDate),
    identityNumber: text(t.person.identityNumber),
    taxCode: text(t.person.taxCode),
    months: [...t.months].sort().join(', '),
    gross: fixed(t.gross),
    exempt: fixed(t.exempt),
    insurance: fixed(t.insurance),
    deductions: fixed(t.deductions),
    assessable: fixed(t.assessable),
    pit: fixed(t.pit),
    note,
  };
}

function scheduleTotals(list: PersonTotals[]): Record<string, string> {
  const total = (pick: (t: PersonTotals) => Decimal) => fixed(list.reduce((acc, t) => acc.plus(pick(t)), zero()));
  return { name: 'Cộng', gross: total((t) => t.gross), exempt: total((t) => t.exempt), insurance: total((t) => t.insurance), deductions: total((t) => t.deductions), assessable: total((t) => t.assessable), pit: total((t) => t.pit) };
}

const sortTotals = (list: PersonTotals[]): PersonTotals[] => [...list].sort((a, b) => byName({ name: a.person.name, employeeId: a.person.employeeId }, { name: b.person.name, employeeId: b.person.employeeId }));

export interface QuarterlyInput {
  /** `YYYY-Qn`. */
  quarter: string;
  employer: DeclarationEmployer;
  persons: readonly DeclarationPerson[];
  /** The lines (pay and adjustment) of the approved runs of the quarter's months; a line of another month is ignored. */
  lines: readonly DeclarationLine[];
  /** The months of the quarter that have an approved run; the document says which are missing. */
  approvedMonths: readonly string[];
}

/**
 * The figures of 05/KK-TNCN and its schedules. A person is on the schedule of progressive-rate individuals when a month of the quarter was withheld by the monthly brackets, on the schedule
 * of the 10% individuals when it was withheld at the flat rate; a person paid with no withholding (a commitment, below the threshold) is counted in the headcount only. A person who left
 * mid-quarter stays on the schedule for the months they were paid and the note says the day they left.
 */
export function buildQuarterly(input: QuarterlyInput): DeclarationDocument {
  const months = new Set(quarterMonths(input.quarter));
  const people = new Map(input.persons.map((p) => [p.employeeId, p]));
  const progressive = new Map<string, PersonTotals>();
  const flat = new Map<string, PersonTotals>();
  const headcount = new Set<string>();
  let adjustmentTax = zero();
  const grand = { gross: zero(), exempt: zero(), insurance: zero(), taxable: zero(), pit: zero(), withheldBase: zero() };
  for (const line of input.lines) {
    if (!months.has(line.month)) continue;
    const person = people.get(line.employeeId);
    if (!person) throw new Error(`a payroll line names an employee that is not in the list: ${line.employeeId}`);
    headcount.add(line.employeeId);
    grand.gross = grand.gross.plus(line.gross);
    grand.exempt = grand.exempt.plus(exemptOf(line.breakdown));
    grand.insurance = grand.insurance.plus(line.employeeInsurance);
    grand.taxable = grand.taxable.plus(line.taxableIncome);
    grand.pit = grand.pit.plus(line.pit);
    if (money(line.pit).gt(0)) grand.withheldBase = grand.withheldBase.plus(line.taxableIncome);
    if (line.kind === 'adjustment') adjustmentTax = adjustmentTax.plus(line.pit);
    const mode = line.breakdown?.tax.mode;
    const target = mode === 'flat' ? flat : mode === 'progressive' ? progressive : null;
    if (target) {
      const t = target.get(line.employeeId) ?? newTotals(person);
      add(t, line);
      target.set(line.employeeId, t);
    }
  }
  const noteOf = (t: PersonTotals): string => (t.person.endedOn && t.months.size > 0 && monthOf(t.person.endedOn) <= [...months].sort().at(-1)! && months.has(monthOf(t.person.endedOn)) ? `Nghỉ việc ngày ${t.person.endedOn}` : t.person.taxCode ? '' : 'Thiếu mã số thuế');
  const progressiveList = sortTotals([...progressive.values()]);
  const flatList = sortTotals([...flat.values()]);
  const summary: DeclarationSheet = {
    name: '05-KK-TNCN',
    title: `Chỉ tiêu 05/KK-TNCN quý ${input.quarter}`,
    columns: [
      { key: 'item', header: 'Chỉ tiêu', kind: 'text' },
      { key: 'value', header: 'Giá trị', kind: 'text' },
    ],
    rows: [
      { item: 'Tổng số người lao động được chi trả thu nhập', value: String(headcount.size) },
      { item: 'Trong đó: khấu trừ theo biểu lũy tiến', value: String(progressiveList.length) },
      { item: 'Trong đó: khấu trừ 10%', value: String(flatList.length) },
      { item: 'Tổng thu nhập chi trả', value: fixed(grand.gross) },
      { item: 'Tổng thu nhập được miễn', value: fixed(grand.exempt) },
      { item: 'Bảo hiểm bắt buộc đã trừ', value: fixed(grand.insurance) },
      { item: 'Tổng thu nhập chịu thuế', value: fixed(grand.taxable) },
      { item: 'Trong đó: thu nhập chịu thuế phải khấu trừ', value: fixed(grand.withheldBase) },
      { item: 'Tổng số thuế đã khấu trừ', value: fixed(grand.pit) },
      { item: 'Trong đó: từ dòng điều chỉnh của kỳ lương', value: fixed(adjustmentTax) },
    ],
  };
  const schedule = (name: string, title: string, list: PersonTotals[]): DeclarationSheet => ({
    name,
    title,
    columns: scheduleColumns,
    rows: list.map((t, index) => scheduleRow(t, index + 1, noteOf(t))),
    totals: scheduleTotals(list),
  });
  const missing = [...months].filter((m) => !input.approvedMonths.includes(m)).sort();
  const notes = [
    'Số liệu lấy từ các bảng lương đã duyệt; một tháng chưa duyệt không có trong bảng kê.',
    'Tên và mã của các bảng kê trong Thông tư 89 chưa thống nhất giữa các nguồn (05-1/BK-QTT-TNCN hay 05-1/PBT-KK-TNCN): đối chiếu với biểu mẫu chính thức.',
    'Quý không có khoản khấu trừ nào thì không phải nộp tờ khai, trừ quý cuối năm.',
  ];
  if (missing.length > 0) notes.unshift(`Chưa có bảng lương đã duyệt của tháng ${missing.join(', ')}: số liệu của quý chưa đủ.`);
  return documentOf(
    'kk',
    `${DECLARATION_NOTICE} 05/KK-TNCN quý ${input.quarter}`,
    header(input.employer, [{ label: 'Quý', value: input.quarter }, { label: 'Tháng chưa có bảng lương đã duyệt', value: missing.join(', ') || 'không có' }]),
    [
      summary,
      schedule('Lũy tiến', 'Bảng kê cá nhân khấu trừ theo biểu lũy tiến', progressiveList),
      schedule('Khấu trừ 10%', 'Bảng kê cá nhân khấu trừ 10%', flatList),
    ],
    notes,
  );
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// 05/QTT-TNCN: a year, for staff who authorized the payer
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------

export type AnnualExclusion = 'not_authorized' | 'left_before_year_end' | 'not_progressive' | 'not_paid';
const EXCLUSION_LABEL: Record<AnnualExclusion, string> = {
  not_authorized: 'Không ủy quyền quyết toán: tự quyết toán',
  left_before_year_end: 'Không còn làm việc đến cuối năm: tự quyết toán',
  not_progressive: 'Hợp đồng dưới 3 tháng hoặc không có hợp đồng: không thuộc diện ủy quyền',
  not_paid: 'Không được chi trả trong năm',
};

export interface AnnualInput {
  year: number;
  employer: DeclarationEmployer;
  persons: readonly DeclarationPerson[];
  lines: readonly DeclarationLine[];
  /** The months of the year with an approved run. */
  approvedMonths: readonly string[];
}

/** Why a person is not in the annual schedule, or null when they are: they authorized this year, were paid, were withheld by the monthly brackets, and still worked at year end. */
export function annualExclusion(person: DeclarationPerson, year: number, lines: readonly DeclarationLine[]): AnnualExclusion | null {
  const mine = lines.filter((l) => l.employeeId === person.employeeId && l.month.startsWith(`${year}-`));
  if (mine.length === 0) return 'not_paid';
  if (!person.finalizationAuthorizedYears.includes(year)) return 'not_authorized';
  if (person.endedOn !== null && person.endedOn < `${year}-12-31`) return 'left_before_year_end';
  if (mine.some((l) => l.kind === 'pay' && l.breakdown?.tax.mode !== 'progressive')) return 'not_progressive';
  return null;
}

/**
 * The data of 05/QTT-TNCN and its schedules. Only staff who authorized the payer for this year, were paid in it, were withheld by the monthly brackets in every paid month and still worked
 * at year end are scheduled; everyone else is listed with the reason, so a person is never silently missing. The tax payable under the finalization is not computed here: the annual
 * brackets and the deadlines of tax year 2026 are not confirmed (plan row 14), so the cell is left for the person.
 */
export function buildAnnual(input: AnnualInput): DeclarationDocument {
  const prefix = `${input.year}-`;
  const scheduled: PersonTotals[] = [];
  const excluded: { person: DeclarationPerson; reason: AnnualExclusion }[] = [];
  for (const person of input.persons) {
    const reason = annualExclusion(person, input.year, input.lines);
    if (reason !== null) {
      if (reason !== 'not_paid') excluded.push({ person, reason });
      continue;
    }
    const t = newTotals(person);
    for (const line of input.lines) if (line.employeeId === person.employeeId && line.month.startsWith(prefix)) add(t, line);
    scheduled.push(t);
  }
  const sorted = sortTotals(scheduled);
  const schedule: DeclarationSheet = {
    name: 'Quyết toán',
    title: `Bảng kê cá nhân ủy quyền quyết toán năm ${input.year}`,
    columns: scheduleColumns.map((c) => (c.key === 'months' ? { ...c, header: 'Số tháng có chi trả' } : c)),
    rows: sorted.map((t, index) => ({ ...scheduleRow(t, index + 1, t.person.taxCode ? '' : 'Thiếu mã số thuế'), months: String(t.months.size) })),
    totals: scheduleTotals(sorted),
  };
  const summary: DeclarationSheet = {
    name: '05-QTT-TNCN',
    title: `Chỉ tiêu 05/QTT-TNCN năm ${input.year}`,
    columns: [
      { key: 'item', header: 'Chỉ tiêu', kind: 'text' },
      { key: 'value', header: 'Giá trị', kind: 'text' },
    ],
    rows: [
      { item: 'Số cá nhân ủy quyền quyết toán', value: String(sorted.length) },
      { item: 'Tổng thu nhập chi trả', value: schedule.totals?.gross ?? '0.00' },
      { item: 'Tổng thu nhập được miễn', value: schedule.totals?.exempt ?? '0.00' },
      { item: 'Tổng thu nhập tính thuế', value: schedule.totals?.assessable ?? '0.00' },
      { item: 'Tổng số thuế đã khấu trừ trong năm', value: schedule.totals?.pit ?? '0.00' },
      { item: 'Thuế phải nộp theo quyết toán', value: '' },
    ],
  };
  const notExcluded: DeclarationSheet = {
    name: 'Không ủy quyền',
    title: 'Người lao động không có trong bảng kê quyết toán và lý do',
    columns: [
      { key: 'seq', header: 'STT', kind: 'count' },
      { key: 'name', header: 'Họ và tên', kind: 'text' },
      { key: 'taxCode', header: 'Mã số thuế', kind: 'text' },
      { key: 'reason', header: 'Lý do', kind: 'text' },
    ],
    rows: [...excluded].sort((a, b) => byName({ name: a.person.name, employeeId: a.person.employeeId }, { name: b.person.name, employeeId: b.person.employeeId })).map((e, i) => ({ seq: String(i + 1), name: e.person.name, taxCode: text(e.person.taxCode), reason: EXCLUSION_LABEL[e.reason] })),
  };
  const monthsDone = input.approvedMonths.filter((m) => m.startsWith(prefix)).sort();
  const missing = Array.from({ length: 12 }, (_, i) => `${prefix}${String(i + 1).padStart(2, '0')}`).filter((m) => !monthsDone.includes(m));
  const notes = [
    'Chỉ gồm người lao động đã ủy quyền cho đơn vị quyết toán (mẫu 08/UQ-QTT-TNCN), chỉ ký hợp đồng với một nơi, còn làm việc đến cuối năm.',
    'Thuế phải nộp hoặc được hoàn theo quyết toán chưa tính ở đây: biểu thuế năm và hạn quyết toán năm tính thuế 2026 chưa được kế toán xác nhận (dòng 14).',
  ];
  if (missing.length > 0) notes.unshift(`Chưa có bảng lương đã duyệt của tháng ${missing.join(', ')}: số liệu của năm chưa đủ.`);
  return documentOf('qtt', `${DECLARATION_NOTICE} 05/QTT-TNCN năm ${input.year}`, header(input.employer, [{ label: 'Năm tính thuế', value: String(input.year) }]), [summary, schedule, notExcluded], notes);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// 03/TNCN: the data of a withholding certificate per person
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface CertificateInput {
  year: number;
  employer: DeclarationEmployer;
  persons: readonly DeclarationPerson[];
  lines: readonly DeclarationLine[];
}

/**
 * The data of the certificates to issue (plan row 15): one for the whole year per person withheld by the monthly brackets (a contract of 3 months or more), one per withholding for a person
 * withheld at the flat rate; none for a person who authorized the payer to finalize, who is listed with that reason; a person with no tax withheld has nothing to certify.
 */
export function buildCertificates(input: CertificateInput): DeclarationDocument {
  const prefix = `${input.year}-`;
  const rows: Record<string, string>[] = [];
  const authorized: DeclarationPerson[] = [];
  const mk = (p: DeclarationPerson, period: string, lines: DeclarationLine[], note: string): Record<string, string> => {
    const t = newTotals(p);
    for (const l of lines) add(t, l);
    return {
      seq: '',
      name: p.name,
      taxCode: text(p.taxCode),
      identityNumber: text(p.identityNumber),
      address: '',
      period,
      gross: fixed(t.gross),
      exempt: fixed(t.exempt),
      insurance: fixed(t.insurance),
      deductions: fixed(t.deductions),
      assessable: fixed(t.assessable),
      pit: fixed(t.pit),
      note,
    };
  };
  for (const person of [...input.persons].sort((a, b) => byName({ name: a.name, employeeId: a.employeeId }, { name: b.name, employeeId: b.employeeId }))) {
    const mine = input.lines.filter((l) => l.employeeId === person.employeeId && l.month.startsWith(prefix) && money(l.pit).gt(0));
    if (mine.length === 0) continue;
    const progressiveLines = mine.filter((l) => l.breakdown?.tax.mode !== 'flat');
    const flatLines = mine.filter((l) => l.breakdown?.tax.mode === 'flat');
    if (person.finalizationAuthorizedYears.includes(input.year) && progressiveLines.length > 0) {
      authorized.push(person);
    } else if (progressiveLines.length > 0) {
      const months = progressiveLines.map((l) => l.month).sort();
      rows.push(mk(person, `${months[0]} đến ${months.at(-1)}`, progressiveLines, person.taxCode ? '' : 'Thiếu mã số thuế'));
    }
    for (const line of flatLines.sort((a, b) => a.month.localeCompare(b.month))) rows.push(mk(person, line.month, [line], 'Khấu trừ 10% theo từng lần chi trả'));
  }
  rows.forEach((row, index) => {
    row.seq = String(index + 1);
  });
  const certificates: DeclarationSheet = {
    name: '03-TNCN',
    title: `Dữ liệu chứng từ khấu trừ thuế thu nhập cá nhân năm ${input.year}`,
    columns: [
      { key: 'seq', header: 'STT', kind: 'count' },
      { key: 'name', header: 'Họ và tên người nộp thuế', kind: 'text' },
      { key: 'taxCode', header: 'Mã số thuế', kind: 'text' },
      { key: 'identityNumber', header: 'Số định danh cá nhân', kind: 'text' },
      { key: 'address', header: 'Địa chỉ', kind: 'text' },
      { key: 'period', header: 'Thời điểm trả thu nhập', kind: 'text' },
      { key: 'gross', header: 'Tổng thu nhập chịu thuế đã trả', kind: 'money' },
      { key: 'exempt', header: 'Thu nhập được miễn', kind: 'money' },
      { key: 'insurance', header: 'Bảo hiểm bắt buộc đã trừ', kind: 'money' },
      { key: 'deductions', header: 'Giảm trừ gia cảnh và hưu trí tự nguyện', kind: 'money' },
      { key: 'assessable', header: 'Thu nhập tính thuế', kind: 'money' },
      { key: 'pit', header: 'Số thuế đã khấu trừ', kind: 'money' },
      { key: 'note', header: 'Ghi chú', kind: 'text' },
    ],
    rows,
  };
  const skipped: DeclarationSheet = {
    name: 'Không cấp chứng từ',
    title: 'Người lao động không cấp chứng từ vì đã ủy quyền quyết toán',
    columns: [
      { key: 'seq', header: 'STT', kind: 'count' },
      { key: 'name', header: 'Họ và tên', kind: 'text' },
      { key: 'taxCode', header: 'Mã số thuế', kind: 'text' },
    ],
    rows: authorized.map((p, i) => ({ seq: String(i + 1), name: p.name, taxCode: text(p.taxCode) })),
  };
  const notes = [
    'Chứng từ khấu trừ là chứng từ điện tử ký bằng chữ ký số của đơn vị (mẫu 03/TNCN): Ludy chỉ cung cấp số liệu, không giữ chữ ký số và không phát hành chứng từ.',
    'Địa chỉ của người nộp thuế nhập tay khi lập chứng từ.',
  ];
  return documentOf('certificate', `${DECLARATION_NOTICE} dữ liệu chứng từ 03/TNCN năm ${input.year}`, header(input.employer, [{ label: 'Năm', value: String(input.year) }]), [certificates, skipped], notes);
}
