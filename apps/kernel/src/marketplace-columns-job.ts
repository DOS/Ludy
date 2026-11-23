// SPDX-License-Identifier: AGPL-3.0-only
// The check of a column mapping on an unrecognised marketplace order report, the worker's half (#4036, slice 1c of #3850), run as the system for one file when a member asked
// (finance.marketplace.columns_check). The API cannot reach the extract sandbox, so the worker reads the file from the blob store, sends it to the sandbox's `marketplace_columns` kind with the platform and the
// mapping the member picked (if any), and records what came back: the masked sheet (shapes, never a value) and the check's verdict, a refusal code or a preview of at most 20 parsed lines for the screen.
// The file's bytes live in this function's variables and nowhere else. The job carries ids only; the log carries the file's first eight characters, a state and a code, never a header, a sample or a line; a
// failure is recorded as a fixed code of ours, never the sandbox's text.
import { EXTRACT_LIMITS, encodeMarketplaceColumnsInput, type ExtractClient } from '@ludy/extract-contract';
import { MARKETPLACE_COLUMN_PREVIEW_LINES, type MarketplaceColumnsRecord } from '@ludy/kernel-contract';
import type { MarketplaceColumnsTarget } from '@ludy/mod-finance';
import { BlobTooLargeError, readVerified, type BlobStore, type Runtime } from '@ludy/kernel-runtime';

const SYSTEM = { type: 'system' as const, component: 'finance.marketplace_columns' };

export interface MarketplaceColumnsJob {
  orgId: string;
  fileId: string;
}

export interface MarketplaceColumnsDeps {
  runtime: Runtime;
  store: BlobStore;
  extract: ExtractClient;
}

type Failure = 'not_a_sheet' | 'too_large' | 'unavailable' | 'unreadable';
export type MarketplaceColumnsOutcome =
  // The file is left alone (gone, original deleted, or no check is waiting): nothing was asked and nothing is recorded.
  | { state: 'skipped'; reason: string }
  // `superseded`: the record was dropped because the request was filed again while this run read the file; the job runs again.
  | { state: 'done'; superseded?: true }
  | { state: 'failed'; failure: Failure; superseded?: true };

export async function runMarketplaceColumns(deps: MarketplaceColumnsDeps, job: MarketplaceColumnsJob): Promise<MarketplaceColumnsOutcome> {
  const options = { actor: SYSTEM, orgId: job.orgId };
  const target = await deps.runtime.query<MarketplaceColumnsTarget>('finance.marketplace.columns_target', { fileId: job.fileId }, options);
  if (target.action === 'none') return { state: 'skipped', reason: target.reason };
  const record = async (result: MarketplaceColumnsRecord['result']) => {
    const written = await deps.runtime.execute<{ recorded?: boolean }>('finance.marketplace.columns_record', { fileId: job.fileId, requestedAt: target.requestedAt, result }, options);
    return written?.recorded === false;
  };
  const fail = async (failure: Failure, code: string): Promise<MarketplaceColumnsOutcome> => {
    console.warn(`[marketplace-columns] ${job.fileId.slice(0, 8)}: failed (${failure}, ${code})`);
    const superseded = await record({ state: 'failed', failure });
    return { state: 'failed', failure, ...(superseded ? { superseded: true as const } : {}) };
  };
  if (target.sizeBytes > EXTRACT_LIMITS.maxOrderReportBytes) return fail('too_large', 'size');
  let bytes: Uint8Array;
  try {
    // Read with the report cap: the store refuses a larger object before it is held whole.
    bytes = await readVerified(deps.store, { key: target.storageKey, generation: target.generation, sha256: target.sha256 }, EXTRACT_LIMITS.maxOrderReportBytes);
  } catch (error: unknown) {
    if (error instanceof BlobTooLargeError) return fail('too_large', 'size');
    return fail('unreadable', error instanceof Error ? error.name : typeof error);
  }
  let answer: Awaited<ReturnType<ExtractClient['extract']>>;
  try {
    answer = await deps.extract.extract('marketplace_columns', encodeMarketplaceColumnsInput({ fileBase64: Buffer.from(bytes).toString('base64'), ...(target.mapping ? { mapping: target.mapping } : {}) }));
  } catch (error: unknown) {
    // The sandbox could not be reached or did not answer in time: nothing was read, and the member asks again. Never the sandbox's text.
    return fail('unavailable', error instanceof Error ? error.name : typeof error);
  }
  if (!answer.ok) {
    // An answer of the service that names a limit or a file it could not read is about the input: asking again gives the same one. A busy or failed call is not.
    if (answer.code === 'too_large') return fail('too_large', answer.code);
    if (answer.code === 'invalid' || answer.code === 'timeout' || answer.code === 'memory') return fail('unreadable', answer.code);
    return fail('unavailable', answer.code);
  }
  const { sheet, check } = answer.columns;
  if (sheet === null && check === null) return fail('not_a_sheet', 'no_sheet');
  let result: MarketplaceColumnsRecord['result'];
  if (check === null) {
    result = { state: 'done', sheet, refusal: null, preview: null };
  } else if (!check.ok) {
    result = { state: 'done', sheet, refusal: check.reason, preview: null };
  } else {
    const { orders } = check;
    // Only what the confirm screen shows, and no more lines than it shows.
    const lines = orders.lines.slice(0, MARKETPLACE_COLUMN_PREVIEW_LINES).map((l) => ({
      rowNo: l.rowNo,
      orderNo: l.orderNo,
      lineKey: l.lineKey,
      sku: l.sku,
      itemName: l.itemName,
      quantity: l.quantity,
      amount: l.amount,
      status: l.statusLabel,
    }));
    result = { state: 'done', sheet, refusal: null, preview: { lines, total: orders.lines.length, skipped: orders.skippedCount } };
  }
  const superseded = await record(result);
  console.log(`[marketplace-columns] ${job.fileId.slice(0, 8)}: done`);
  return { state: 'done', ...(superseded ? { superseded: true as const } : {}) };
}
