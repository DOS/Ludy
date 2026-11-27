// SPDX-License-Identifier: AGPL-3.0-only
// A marketplace order report as .xlsx or CSV (#2515, ADR-0045 points 5 and 7), read in the sandbox through the platform's profile (@ludy/l10n-vn, marketplace-orders.ts): the platform is
// told by the headers, the lines by the allow-list of columns. A file's other columns, the buyer's name, phone, email and address among them, are never looked at beyond finding the header
// row: the contract has no field for them, so they cannot leave this process.
//
// A file that is no order report of a platform the profiles know (another workbook, a bank statement, a platform whose headers fit two profiles equally) is an answer, not a failure:
// recognized is false and the worker goes on as it did before. Only a report past the line cap is flagged apart (tooMany).
import { EXTRACT_LIMITS, type ExtractedMarketplaceOrders } from '@ludy/extract-contract';
import { findOrderColumns, orderLines, type OrderRead, type StatementGrid } from '@ludy/l10n-vn';
import { readSheetGrid } from './bank-statement.ts';
import { readMarketplaceIncome } from './marketplace-income.ts';

const LOST_PARCEL_PREAMBLE = /^Ludy marketplace lost parcel ([1-9]\d*(?:,[1-9]\d*)*)$/;

// Reads the out-of-band preamble row emitted by marketplaceOrdersCsv (`Ludy marketplace lost parcel 1,3`) strictly above the header row.
function parseLostParcelRows(grid: StatementGrid, headerRow: number): Set<number> {
  const rows = new Set<number>();
  for (const [rowNo, cells] of grid) {
    if (rowNo >= headerRow) continue;
    const values = [...cells.values()].map((c) => (c.value ?? '').trim()).filter((v) => v !== '');
    if (values.length !== 1) continue;
    const match = LOST_PARCEL_PREAMBLE.exec(values[0]!);
    if (!match) continue;
    for (const part of match[1]!.split(',')) {
      const idx = Number.parseInt(part, 10);
      if (Number.isSafeInteger(idx) && idx > 0) rows.add(idx);
    }
  }
  return rows;
}

// No order report. The file is also asked whether it is an income report, so the worker needs no second call for the answer.
const none = (bytes: Uint8Array): ExtractedMarketplaceOrders => ({ ...NONE, incomeReport: readMarketplaceIncome(bytes).recognized });
const NONE: ExtractedMarketplaceOrders = { recognized: false, platform: null, profile: null, columns: [], tooMany: false, lines: [], skipped: [], skippedCount: 0, unknownStatuses: [] };

export function readMarketplaceOrders(bytes: Uint8Array): ExtractedMarketplaceOrders {
  const grid = readSheetGrid(bytes);
  if (!grid) return none(bytes);
  const mapping = findOrderColumns(grid);
  if (!mapping) return none(bytes);
  const read = orderLines(grid, mapping, EXTRACT_LIMITS.maxOrderLines);
  const head = { recognized: true, platform: mapping.profile.platform, profile: { version: mapping.profile.version, confirmed: mapping.profile.confirmed }, columns: mapping.headers.map((h) => ({ field: h.field, header: h.header.slice(0, 200) })) };
  if (read === null) return { ...head, tooMany: true, lines: [], skipped: [], skippedCount: 0, unknownStatuses: [] };
  // A header with nothing under it is no report of any orders.
  if (read.lines.length === 0 && read.skipped.length === 0) return none(bytes);
  return readToOrders(head, read, parseLostParcelRows(grid, mapping.headerRow));
}

// The answer for a file that was read (lines, or rows skipped): the list of skipped rows is capped, and a row that stops the file (anything but a row with no order number) must never be cut off behind a
// thousand totals rows: those come first, in row order. Shared with marketplace_columns, which reads the same file through a mapping the person confirmed (#4035).
export function readToOrders(head: Pick<ExtractedMarketplaceOrders, 'recognized' | 'platform' | 'profile' | 'columns'>, read: OrderRead, lostRows?: ReadonlySet<number>): ExtractedMarketplaceOrders {
  const skipped = [...read.skipped.filter((s) => s.reason !== 'no_order_no'), ...read.skipped.filter((s) => s.reason === 'no_order_no')];
  const lines = lostRows && lostRows.size > 0 ? read.lines.map((line) => (line.stage === 'shipped' && lostRows.has(line.rowNo - read.mapping.headerRow) ? { ...line, lostParcel: true } : line)) : read.lines;
  return {
    ...head,
    tooMany: false,
    lines,
    skipped: skipped.slice(0, EXTRACT_LIMITS.maxOrderSkipped),
    skippedCount: read.skipped.length,
    unknownStatuses: read.unknownStatuses,
  };
}
