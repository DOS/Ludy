// SPDX-License-Identifier: AGPL-3.0-only
// A marketplace order report as .xlsx or CSV (#2515, ADR-0045 points 5 and 7), read in the sandbox through the platform's profile (@crove/l10n-vn, marketplace-orders.ts): the platform is
// told by the headers, the lines by the allow-list of columns. A file's other columns, the buyer's name, phone, email and address among them, are never looked at beyond finding the header
// row: the contract has no field for them, so they cannot leave this process.
//
// A file that is no order report of a platform the profiles know (another workbook, a bank statement, a platform whose headers fit two profiles equally) is an answer, not a failure:
// recognized is false and the worker goes on as it did before. Only a report past the line cap is flagged apart (tooMany).
import { EXTRACT_LIMITS, type ExtractedMarketplaceOrders } from '@crove/extract-contract';
import { findOrderColumns, orderLines } from '@crove/l10n-vn';
import { readSheetGrid } from './bank-statement.ts';

const NONE: ExtractedMarketplaceOrders = { recognized: false, platform: null, profile: null, columns: [], tooMany: false, lines: [], skipped: [], skippedCount: 0, unknownStatuses: [] };

export function readMarketplaceOrders(bytes: Uint8Array): ExtractedMarketplaceOrders {
  const grid = readSheetGrid(bytes);
  if (!grid) return NONE;
  const mapping = findOrderColumns(grid);
  if (!mapping) return NONE;
  const read = orderLines(grid, mapping, EXTRACT_LIMITS.maxOrderLines);
  const head = { recognized: true, platform: mapping.profile.platform, profile: { version: mapping.profile.version, confirmed: mapping.profile.confirmed }, columns: mapping.headers.map((h) => ({ field: h.field, header: h.header.slice(0, 200) })) };
  if (read === null) return { ...head, tooMany: true, lines: [], skipped: [], skippedCount: 0, unknownStatuses: [] };
  // A header with nothing under it is no report of any orders.
  if (read.lines.length === 0 && read.skipped.length === 0) return NONE;
  return {
    ...head,
    tooMany: false,
    lines: read.lines,
    skipped: read.skipped.slice(0, EXTRACT_LIMITS.maxOrderSkipped),
    skippedCount: read.skipped.length,
    unknownStatuses: read.unknownStatuses,
  };
}
