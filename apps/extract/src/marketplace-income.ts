// SPDX-License-Identifier: AGPL-3.0-only
// A marketplace income report as .xlsx or CSV (#2516, ADR-0045 points 5 and 7), read in the sandbox through the platform's profile (@crove/l10n-vn, marketplace-income.ts): the platform is told
// by the headers, the lines by the allow-list of columns. A file's other columns, the buyer's name, phone, email and address among them, are never looked at beyond finding the header row: the
// contract has no field for them, so they cannot leave this process.
//
// The per-order table of such a report is on a later sheet behind a summary (Shopee's workbook has five), so the first few sheets are tried in turn and the first that is an income table of a
// platform the profiles know is read. A file that is none (another workbook, an order report, a platform whose headers fit two profiles equally) is an answer, not a failure: recognized is false
// and the worker goes on as it did before. Only a report past the line cap is flagged apart (tooMany).
import { EXTRACT_LIMITS, type ExtractedMarketplaceIncome } from '@crove/extract-contract';
import { findIncomeColumns, incomeLines } from '@crove/l10n-vn';
import { readSheetGrids } from './bank-statement.ts';

const NONE: ExtractedMarketplaceIncome = { recognized: false, platform: null, profile: null, sheet: null, columns: [], tooMany: false, lines: [], statedNet: null, skipped: [], skippedCount: 0 };

export function readMarketplaceIncome(bytes: Uint8Array): ExtractedMarketplaceIncome {
  for (const { name, grid } of readSheetGrids(bytes, EXTRACT_LIMITS.maxIncomeSheets)) {
    const mapping = findIncomeColumns(grid);
    if (!mapping) continue;
    const read = incomeLines(grid, mapping, EXTRACT_LIMITS.maxIncomeLines);
    const head = {
      recognized: true,
      platform: mapping.profile.platform,
      profile: { version: mapping.profile.version, confirmed: mapping.profile.confirmed },
      sheet: name === null ? null : name.slice(0, 200),
      columns: mapping.headers.map((h) => ({ field: h.field, header: h.header.slice(0, 200) })),
    };
    if (read === null) return { ...head, tooMany: true, lines: [], statedNet: null, skipped: [], skippedCount: 0 };
    // A header with nothing under it is no report of any income.
    if (read.lines.length === 0 && read.skipped.length === 0) continue;
    // The list is capped, and a row that stops the file (anything but a row with no order number) must never be cut off behind a thousand totals rows: those come first, in row order.
    const skipped = [...read.skipped.filter((s) => s.reason !== 'no_order_no'), ...read.skipped.filter((s) => s.reason === 'no_order_no')];
    return { ...head, tooMany: false, lines: read.lines, statedNet: read.statedNet, skipped: skipped.slice(0, EXTRACT_LIMITS.maxOrderSkipped), skippedCount: read.skipped.length };
  }
  return NONE;
}
