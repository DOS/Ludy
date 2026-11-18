// SPDX-License-Identifier: AGPL-3.0-only
// The check before a MISA SME voucher export (#3848): what MISA's import will refuse or cut, found over the very rows a file is built from, with the same template that builds it, so the check
// and the file cannot drift. Pure: no database, no clock. A finding names a row (Crove's voucher number and the line) and a column, never a name, an invoice number, an amount or a bank detail.
// It only warns: the export never waits for it. The kinds and what each means are in packages/kernel-contract misa-check.ts.
import { MISA_CHECK_EXAMPLES, type MisaCheck, type MisaCheckFormat, type MisaCheckKind, type MisaFindingGroup } from '@crove/kernel-contract';
import type { MisaTemplate, MisaValue } from './misa.ts';

// MISA allows 25 characters for an invoice number, and Crove never cuts it (a cut number could make two invoices look the same), so a longer one is flagged here instead.
export const MISA_INVOICE_NUMBER_LIMIT = 25;

// The columns that hold a MISA catalog code of a party or an item. Crove cannot know the firm's codes, so the service, sales and cash templates leave them blank; the goods template takes them from Settings.
const CODE_COLUMN = /^Mã (?:nhà cung cấp|khách hàng|đối tượng|NCC|hàng|dịch vụ)(?:\s|$)/u;
// The columns that hold an account of the chart (not a bank account number: "TK ngân hàng").
const ACCOUNT_COLUMN = /^TK(?!\s*ngân hàng)/u;
const VAT_RATE_COLUMN = '% thuế GTGT';
const VAT_AMOUNT_COLUMN = 'Tiền thuế GTGT';
const INVOICE_NUMBER_COLUMN = 'Số hóa đơn';
// "% thuế GTGT" takes these (S9 in docs/integrations/misa-sme-import.md): the numbers as numbers, the others as text.
const VAT_NUMBERS: ReadonlySet<string> = new Set(['0', '5', '8', '10']);
const VAT_TEXTS: ReadonlySet<string> = new Set(['KCT', 'KKKNT', 'KHAC']);

export interface MisaRowId {
  voucherNo: string;
  lineNo: number | null;
}

export interface MisaCheckInput<Row> {
  format: MisaCheckFormat;
  template: MisaTemplate<Row>;
  rows: readonly Row[];
  /** The codes of the org's chart (finance.accounts.list). */
  chart: ReadonlySet<string>;
  rowId: (row: Row) => MisaRowId;
}

const isBlank = (value: MisaValue): boolean => value.kind === 'blank' || (value.kind === 'text' && value.value.trim() === '');
const isZero = (value: MisaValue): boolean => value.kind === 'blank' || (value.kind === 'decimal' && /^-?0+(?:\.0+)?$/.test(value.value));

/** The findings of one file, grouped by kind and column with a count and the first examples. */
export function checkMisaRows<Row>(input: MisaCheckInput<Row>): MisaCheck {
  const { template, rows, chart } = input;
  const groups = new Map<string, { group: MisaFindingGroup; seen: Set<string> }>();
  let findings = 0;
  const add = (kind: MisaCheckKind, column: string, limit: number | null, id: MisaRowId) => {
    const key = `${kind}\n${column}`;
    let entry = groups.get(key);
    if (!entry) {
      entry = { group: { kind, column, limit, count: 0, examples: [] }, seen: new Set() };
      groups.set(key, entry);
    }
    entry.group.count += 1;
    findings += 1;
    const example = `${id.voucherNo}\n${id.lineNo ?? ''}`;
    if (entry.group.examples.length < MISA_CHECK_EXAMPLES && !entry.seen.has(example)) {
      entry.seen.add(example);
      entry.group.examples.push({ voucherNo: id.voucherNo, lineNo: id.lineNo });
    }
  };
  const vatAmountIndex = template.columns.findIndex((c) => c.header === VAT_AMOUNT_COLUMN);
  for (const row of rows) {
    const id = input.rowId(row);
    const values = template.columns.map((column) => column.cell(row));
    const hasVat = vatAmountIndex >= 0 && !isZero(values[vatAmountIndex] as MisaValue);
    template.columns.forEach((column, i) => {
      const value = values[i] as MisaValue;
      const header = column.header;
      if (CODE_COLUMN.test(header)) {
        if (isBlank(value)) add('MISSING_CODE', header, null, id);
      } else if (header.includes('(*)') && isBlank(value)) {
        add('MISSING_REQUIRED', header, null, id);
      }
      if (ACCOUNT_COLUMN.test(header) && value.kind === 'text' && value.value.trim() !== '' && !chart.has(value.value.trim())) {
        add('ACCOUNT_NOT_IN_CHART', header, null, id);
      }
      if (header === VAT_RATE_COLUMN) {
        const good = value.kind === 'decimal' ? VAT_NUMBERS.has(value.value) : value.kind === 'text' ? VAT_TEXTS.has(value.value) : false;
        if (!good && (hasVat || !isBlank(value))) add('VAT_CODE', header, null, id);
      }
      if (value.kind === 'text') {
        const length = Array.from(value.value).length;
        if (column.maxLength !== undefined && length > column.maxLength) add('TOO_LONG', header, column.maxLength, id);
        else if (header === INVOICE_NUMBER_COLUMN && length > MISA_INVOICE_NUMBER_LIMIT) add('TOO_LONG', header, MISA_INVOICE_NUMBER_LIMIT, id);
      }
    });
  }
  return { format: input.format, rows: rows.length, findings, groups: [...groups.values()].map((e) => e.group) };
}
