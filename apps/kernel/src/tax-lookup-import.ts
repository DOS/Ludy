// SPDX-License-Identifier: AGPL-3.0-only
// Out-of-transaction batch tax-code lookup orchestrator for CRM contact import preview (#4990, TC3).
// Step 1 reads staged eligible rows and org cache in a short read tx; Step 2 calls provider.lookup()
// outside any PostgreSQL transaction (at most 50 rows/batch, cache first, TC1 rate limits);
// Step 3 persists 24h/1h cache entries (never household) and writes metadata-only audit counts.
import {
  IMPORT_TAX_LOOKUP_MAX_ROWS,
  type ImportTaxLookupItem,
  type ImportTaxLookupResult,
  type ImportTaxLookupStopReason,
} from '@ludy/kernel-contract';
import {
  TAX_LOOKUP_QUOTA_WARN_PERCENT,
  TAX_LOOKUP_TIMEOUT_MS,
  TaxLookupLimiter,
  TaxLookupUpstreamError,
  isHouseholdTaxLookupResult,
  offTaxLookupProvider,
  type PartyTaxLookupOptions,
  type TaxLookupResult,
} from '@ludy/kernel';
import { DomainError, type Runtime, type UserActor } from '@ludy/kernel-runtime';
import type { ImportTaxLookupCandidatesResult } from '@ludy/mod-crm';

const MAX_SUGGESTED_NAME_LENGTH = 300;
const MAX_SUGGESTED_ADDRESS_LENGTH = 500;
const MAX_STATUS_TEXT_LENGTH = 200;

function cleanSuggestion(raw: string | null | undefined, maxLen: number): string | null {
  if (typeof raw !== 'string') return null;
  let stripped = '';
  for (const ch of raw) {
    const cp = ch.codePointAt(0) ?? 0;
    stripped += cp < 0x20 || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f) ? ' ' : ch;
  }
  const cleaned = stripped.replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, maxLen).trim() || null;
}

export interface RunContactImportTaxLookupInput {
  runtime: Runtime;
  adapter: PartyTaxLookupOptions | undefined;
  defaultLimiter: TaxLookupLimiter;
  orgId: string;
  actor: UserActor;
  batchId: string;
}

export async function runContactImportTaxLookup({
  runtime,
  adapter,
  defaultLimiter,
  orgId,
  actor,
  batchId,
}: RunContactImportTaxLookupInput): Promise<ImportTaxLookupResult> {
  const provider = adapter?.provider ?? offTaxLookupProvider;
  const limiter = adapter?.limiter ?? defaultLimiter;

  // 1. Short read tx (closes before any outbound HTTP): checks ownership, toggles, valid 10/13-digit codes, and cache.
  const prepared = await runtime.query<ImportTaxLookupCandidatesResult>(
    'crm.import.tax_lookup_candidates',
    { batchId, deploymentEnabled: provider.id !== 'off' },
    { actor, orgId },
  );

  if (prepared.expired) {
    return {
      expired: true,
      items: [],
      lookedUpRows: 0,
      providerCalls: 0,
      stopReason: null,
    };
  }

  if (prepared.candidates.length === 0) {
    return {
      expired: false,
      items: [],
      lookedUpRows: 0,
      providerCalls: 0,
      stopReason: null,
    };
  }

  // Cache first, capped at IMPORT_TAX_LOOKUP_MAX_ROWS (50) rows per batch.
  const cachedCandidates = prepared.candidates.filter((c) => c.cachedResult !== null);
  const uncachedCandidates = prepared.candidates.filter((c) => c.cachedResult === null);
  const selectedCached = cachedCandidates.slice(0, IMPORT_TAX_LOOKUP_MAX_ROWS);
  const remainingSlots = IMPORT_TAX_LOOKUP_MAX_ROWS - selectedCached.length;
  const selectedUncached = uncachedCandidates.slice(0, remainingSlots);
  const selectedRowNos = new Set<number>([
    ...selectedCached.map((c) => c.rowNo),
    ...selectedUncached.map((c) => c.rowNo),
  ]);

  const uniqueUncachedCodes: string[] = [];
  const seenUncached = new Set<string>();
  for (const c of selectedUncached) {
    if (!seenUncached.has(c.taxCode)) {
      seenUncached.add(c.taxCode);
      uniqueUncachedCodes.push(c.taxCode);
    }
  }

  const fetchedByCode = new Map<string, TaxLookupResult & { household: boolean }>();
  const missesForWrite: Array<{
    taxCode: string;
    found: boolean;
    name: string | null;
    address: string | null;
    statusText: string | null;
    source: string | null;
    household: boolean;
  }> = [];

  let providerCalls = 0;
  let stopReason: ImportTaxLookupStopReason | null = null;
  let retryAfterSeconds: number | undefined;
  let quotaWarning = false;

  // 2. Out-of-transaction external lookups following TC1 backoff and rate limits.
  for (const code of uniqueUncachedCodes) {
    const backoff = limiter.isBackedOff();
    if (backoff.backedOff) {
      stopReason = 'unavailable';
      retryAfterSeconds = backoff.retryAfterSeconds;
      break;
    }

    const acquired = limiter.tryAcquire(orgId, actor.userId);
    if (!acquired.ok) {
      stopReason = acquired.scope === 'backoff' ? 'unavailable' : 'rate_limit';
      retryAfterSeconds = acquired.retryAfterSeconds;
      break;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TAX_LOOKUP_TIMEOUT_MS);
    let answer: TaxLookupResult;
    try {
      answer = await provider.lookup(code, controller.signal);
    } catch (error) {
      if (error instanceof DomainError && (error.code === 'TAX_LOOKUP_DISABLED' || error.code === 'TAX_LOOKUP_ORG_DISABLED')) {
        throw error;
      }
      if (error instanceof TaxLookupUpstreamError && error.kind === 'rate_limited') {
        limiter.triggerBackoff(error.retryAfterSeconds !== undefined ? error.retryAfterSeconds * 1000 : undefined);
        retryAfterSeconds = error.retryAfterSeconds ?? Math.ceil(limiter.backoffMs / 1000);
      }
      stopReason = 'unavailable';
      break;
    } finally {
      clearTimeout(timer);
    }

    providerCalls += 1;
    const household = isHouseholdTaxLookupResult(answer);
    const orgPercent = Math.round((acquired.orgDailyCount / acquired.orgDailyLimit) * 100);
    const effectivePercent = Math.max(orgPercent, answer.quotaUsedPercent ?? 0);
    if (effectivePercent >= TAX_LOOKUP_QUOTA_WARN_PERCENT) {
      quotaWarning = true;
      if (limiter.shouldEmitQuotaWarning(orgId)) {
        adapter?.onQuotaWarning?.({ orgId, provider: provider.id, usedPercent: effectivePercent });
      }
    }

    fetchedByCode.set(code, { ...answer, household });
    missesForWrite.push({
      taxCode: code,
      found: answer.found,
      name: answer.name,
      address: answer.address,
      statusText: answer.statusText,
      source: answer.source,
      household,
    });
  }

  if (stopReason === null && prepared.candidates.length > selectedRowNos.size) {
    stopReason = 'batch_limit';
  }

  const uniqueCachedCodes = [...new Set(selectedCached.map((c) => c.taxCode))];

  // 3. Short write + metadata-only audit tx after external lookups complete.
  if (uniqueCachedCodes.length > 0 || missesForWrite.length > 0) {
    await runtime.execute(
      'kernel.party.tax_lookup_batch',
      {
        provider: provider.id,
        hits: uniqueCachedCodes,
        misses: missesForWrite,
        ...(quotaWarning ? { quotaWarning: true } : {}),
      },
      { actor, orgId },
    );
  }

  const items: ImportTaxLookupItem[] = prepared.candidates.map((c) => {
    if (!selectedRowNos.has(c.rowNo)) {
      return {
        rowNo: c.rowNo,
        taxCode: c.taxCode,
        status: 'not_looked_up',
        suggestedName: null,
        suggestedAddress: null,
        statusText: null,
        cached: false,
        household: false,
      };
    }

    const cachedEntry = c.cachedResult;
    const fetchedEntry = fetchedByCode.get(c.taxCode);
    const entry = cachedEntry ?? fetchedEntry;
    if (!entry) {
      return {
        rowNo: c.rowNo,
        taxCode: c.taxCode,
        status: 'not_looked_up',
        suggestedName: null,
        suggestedAddress: null,
        statusText: null,
        cached: false,
        household: false,
      };
    }

    const cached = cachedEntry !== null;
    const household = cachedEntry !== null ? false : Boolean(fetchedEntry?.household);

    if (!entry.found) {
      return {
        rowNo: c.rowNo,
        taxCode: c.taxCode,
        status: 'not_found',
        suggestedName: null,
        suggestedAddress: null,
        statusText: null,
        cached,
        household,
      };
    }

    const suggestedName = c.needsName ? cleanSuggestion(entry.name, MAX_SUGGESTED_NAME_LENGTH) : null;
    const suggestedAddress = c.needsAddress ? cleanSuggestion(entry.address, MAX_SUGGESTED_ADDRESS_LENGTH) : null;
    const statusText = cleanSuggestion(entry.statusText, MAX_STATUS_TEXT_LENGTH);

    if (!suggestedName && !suggestedAddress) {
      return {
        rowNo: c.rowNo,
        taxCode: c.taxCode,
        status: 'no_fill',
        suggestedName: null,
        suggestedAddress: null,
        statusText,
        cached,
        household,
      };
    }

    return {
      rowNo: c.rowNo,
      taxCode: c.taxCode,
      status: 'suggested',
      suggestedName,
      suggestedAddress,
      statusText,
      cached,
      household,
    };
  });

  const lookedUpRows = items.filter((item) => item.status !== 'not_looked_up').length;

  return {
    expired: false,
    items,
    lookedUpRows,
    providerCalls,
    stopReason,
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    ...(quotaWarning ? { quotaWarning: true } : {}),
  };
}
