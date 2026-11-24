// SPDX-License-Identifier: AGPL-3.0-only
// Client-side exact decimal money/hours helpers, datetime helpers, and CSV download for project time tracking (#2600).
import {
  PROJECT_TIME_DURATION_MAX,
  PROJECT_TIME_DURATION_MIN,
  type ProjectTimeEntry,
  type ProjectTimeLogInput,
  type ProjectTimeSummaryResult,
  type ProjectTimeUpdateInput,
} from '@ludy/kernel-contract';
import { brandFileName } from '../i18n/brand.ts';

const HOURLY_RATE_PATTERN = /^\d{1,16}(\.\d{1,2})?$/;

function divRoundHalfUp(n: bigint, d: bigint): bigint {
  return (n * 2n + d) / (2n * d);
}

function groupIntDigits(digits: string, sep: string): string {
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += sep;
    out += digits[i]!;
  }
  return out;
}

/** Validate non-negative hourly rate strings up to NUMERIC(18, 2). */
export function isValidHourlyRateInput(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed === '') return true;
  return HOURLY_RATE_PATTERN.test(trimmed);
}

function trimTrailingZeros(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 48) end--;
  return s.slice(0, end);
}

/** Format a decimal string cleanly using pure string grouping so large amounts never suffer JS Number precision loss. */
export function formatDecimalMoney(raw: string, locale: 'vi' | 'en', keepZeroDecimals = false): string {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(raw.trim());
  if (!m) return raw;
  const intPart = m[1]!;
  const fracPart = m[2] ?? '';
  const groupSep = locale === 'vi' ? '.' : ',';
  const decSep = locale === 'vi' ? ',' : '.';
  const grouped = groupIntDigits(intPart, groupSep);
  if (keepZeroDecimals && fracPart.length > 0) {
    return `${grouped}${decSep}${fracPart}`;
  }
  const trimmedFrac = trimTrailingZeros(fracPart);
  return trimmedFrac ? `${grouped}${decSep}${trimmedFrac}` : grouped;
}

/** Format decimal hours (2 decimal places -> e.g. '1,5' in Vietnamese, '1.5' in English). */
export function formatDecimalHours(raw: string, locale: 'vi' | 'en'): string {
  return formatDecimalMoney(raw, locale, false);
}

/** Convert integer minutes to formatted hours cleanly using exact BigInt half-up rounding. */
export function formatMinutesAsHours(minutes: number, locale: 'vi' | 'en'): string {
  const scaled = divRoundHalfUp(BigInt(Math.max(0, Math.round(minutes))) * 100n, 60n);
  const whole = scaled / 100n;
  const frac = (scaled % 100n).toString().padStart(2, '0');
  return formatDecimalHours(`${whole}.${frac}`, locale);
}

/** Compute exact BigInt preview for billable amount = ROUND_HALF_UP((durationMinutes * rate) / 60, 2). */
export function previewBillableAmount(
  durationMinutes: number | null,
  hourlyRateRaw: string | null | undefined,
  billable: boolean,
): string | null {
  if (!billable || durationMinutes === null || !Number.isInteger(durationMinutes) || durationMinutes <= 0) {
    return null;
  }
  const trimmed = (hourlyRateRaw ?? '').trim();
  if (!trimmed || !HOURLY_RATE_PATTERN.test(trimmed)) return null;
  const [intStr = '0', fracStr = ''] = trimmed.split('.');
  const rateCents = BigInt(intStr) * 100n + BigInt((fracStr + '00').slice(0, 2));
  const amountCents = divRoundHalfUp(BigInt(durationMinutes) * rateCents, 60n);
  const whole = amountCents / 100n;
  const frac = (amountCents % 100n).toString().padStart(2, '0');
  return `${whole}.${frac}`;
}

export function toLocalDateTimeInput(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function localDateTimeInputToIso(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

export function currentLocalDateTimeInput(): string {
  return toLocalDateTimeInput(new Date().toISOString());
}

export function saveTimeCsvFile(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = brandFileName(filename);
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/**
 * Keeps a stable idempotency key across failed submit retries and clears it when
 * the draft changes or completes so the next distinct request gets a fresh key.
 */
export interface TimeEntryIdempotencyTracker {
  current(): string;
  rotate(): void;
}

export function createTimeEntryIdempotencyTracker(createKey: () => string = () => crypto.randomUUID()): TimeEntryIdempotencyTracker {
  let activeKey: string | null = null;
  return {
    current(): string {
      if (activeKey === null) {
        activeKey = createKey();
      }
      return activeKey;
    },
    rotate(): void {
      activeKey = null;
    },
  };
}

export type TimeEntryTimingMode = 'duration' | 'endedAt';

export interface TimeEntryFormDraft {
  taskId: string;
  startedAt: string;
  endedAt: string;
  durationMinutes: string;
  timingMode: TimeEntryTimingMode;
  billable: boolean;
  hourlyRate: string;
  note: string;
}

export type TimeEntryValidationErrorKey =
  | 'invalidStartRequired'
  | 'invalidRateError'
  | 'invalidRangeError'
  | 'invalidDurationError';

export type TimeEntrySubmitPayloadResult =
  | { ok: false; errorKey: TimeEntryValidationErrorKey }
  | { ok: true; mode: 'create'; payload: Omit<ProjectTimeLogInput, 'projectId'> }
  | { ok: true; mode: 'update'; payload: Omit<ProjectTimeUpdateInput, 'projectId' | 'entryId'> };

function parseValidDurationMinutes(rawDuration: string): number | null {
  const trimmed = rawDuration.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < PROJECT_TIME_DURATION_MIN || parsed > PROJECT_TIME_DURATION_MAX) {
    return null;
  }
  return parsed;
}

function validateEndAfterStart(
  rawEndedLocal: string,
  startedIso: string,
): { ok: true; endedIso: string } | { ok: false; errorKey: 'invalidDurationError' | 'invalidRangeError' } {
  if (rawEndedLocal.trim() === '') {
    return { ok: false, errorKey: 'invalidDurationError' };
  }
  const endedIso = localDateTimeInputToIso(rawEndedLocal);
  if (!endedIso || Date.parse(endedIso) < Date.parse(startedIso)) {
    return { ok: false, errorKey: 'invalidRangeError' };
  }
  const spanMinutes = Math.round((Date.parse(endedIso) - Date.parse(startedIso)) / 60_000);
  if (spanMinutes > PROJECT_TIME_DURATION_MAX) {
    return { ok: false, errorKey: 'invalidDurationError' };
  }
  return { ok: true, endedIso };
}

/**
 * Validates and builds the create/update time-entry payload strictly according to
 * the active input mode and changed fields, so ambiguous DST transitions,
 * note-only edits, and unchanged endedAt fields never trigger false validation
 * failures or overwrite stored timestamps with minute-truncated round-trips (#4462).
 */
export function buildTimeEntrySubmitPayload(
  form: TimeEntryFormDraft,
  editingEntry: ProjectTimeEntry | null,
  fixedTaskId?: string,
): TimeEntrySubmitPayloadResult {
  const rateValue = form.hourlyRate.trim() === '' ? null : form.hourlyRate.trim();
  const noteValue = form.note.trim() === '' ? null : form.note.trim();
  const chosenTaskId = fixedTaskId ?? (form.taskId === '' ? null : form.taskId);

  if (editingEntry) {
    const startUnchanged = form.startedAt === toLocalDateTimeInput(editingEntry.startedAt);
    let startedIso: string | undefined;
    if (!startUnchanged) {
      const parsedStart = localDateTimeInputToIso(form.startedAt);
      if (!parsedStart) {
        return { ok: false, errorKey: 'invalidStartRequired' };
      }
      startedIso = parsedStart;
    }

    if (!isValidHourlyRateInput(form.hourlyRate)) {
      return { ok: false, errorKey: 'invalidRateError' };
    }

    if (editingEntry.running) {
      return {
        ok: true,
        mode: 'update',
        payload: {
          taskId: chosenTaskId,
          ...(startedIso !== undefined ? { startedAt: startedIso } : {}),
          billable: form.billable,
          hourlyRate: rateValue,
          note: noteValue,
        },
      };
    }

    const originalEndedLocal = editingEntry.endedAt ? toLocalDateTimeInput(editingEntry.endedAt) : '';
    const originalDuration = editingEntry.durationMinutes === null ? '' : String(editingEntry.durationMinutes);
    const endUnchanged = form.endedAt === originalEndedLocal;
    const durationUnchanged = form.durationMinutes.trim() === originalDuration;

    if (form.timingMode === 'duration') {
      if (startUnchanged && durationUnchanged) {
        return {
          ok: true,
          mode: 'update',
          payload: {
            taskId: chosenTaskId,
            billable: form.billable,
            hourlyRate: rateValue,
            note: noteValue,
          },
        };
      }
      const durationVal = parseValidDurationMinutes(form.durationMinutes);
      if (durationVal === null) {
        return { ok: false, errorKey: 'invalidDurationError' };
      }
      return {
        ok: true,
        mode: 'update',
        payload: {
          taskId: chosenTaskId,
          ...(startedIso !== undefined ? { startedAt: startedIso } : {}),
          ...(durationUnchanged ? {} : { durationMinutes: durationVal }),
          billable: form.billable,
          hourlyRate: rateValue,
          note: noteValue,
        },
      };
    }

    if (startUnchanged && endUnchanged) {
      return {
        ok: true,
        mode: 'update',
        payload: {
          taskId: chosenTaskId,
          billable: form.billable,
          hourlyRate: rateValue,
          note: noteValue,
        },
      };
    }

    if (endUnchanged) {
      // Only startedAt changed while endedAt stayed identical to the original local string:
      // preserve editingEntry.endedAt directly (never rebuild from minute-truncated local text
      // across DST folds) and validate startedAt <= stored endedAt so server never shifts endedAt.
      if (editingEntry.endedAt) {
        if (Date.parse(editingEntry.endedAt) < Date.parse(startedIso!)) {
          return { ok: false, errorKey: 'invalidRangeError' };
        }
        const spanMinutes = Math.round((Date.parse(editingEntry.endedAt) - Date.parse(startedIso!)) / 60_000);
        if (spanMinutes > PROJECT_TIME_DURATION_MAX) {
          return { ok: false, errorKey: 'invalidDurationError' };
        }
      }
      return {
        ok: true,
        mode: 'update',
        payload: {
          taskId: chosenTaskId,
          ...(startedIso !== undefined ? { startedAt: startedIso } : {}),
          ...(editingEntry.endedAt ? { endedAt: editingEntry.endedAt } : {}),
          billable: form.billable,
          hourlyRate: rateValue,
          note: noteValue,
        },
      };
    }

    const effectiveStartIso = startedIso ?? editingEntry.startedAt;
    const endCheck = validateEndAfterStart(form.endedAt, effectiveStartIso);
    if (!endCheck.ok) {
      return endCheck;
    }

    return {
      ok: true,
      mode: 'update',
      payload: {
        taskId: chosenTaskId,
        ...(startedIso !== undefined ? { startedAt: startedIso } : {}),
        endedAt: endCheck.endedIso,
        billable: form.billable,
        hourlyRate: rateValue,
        note: noteValue,
      },
    };
  }

  const startedIso = localDateTimeInputToIso(form.startedAt);
  if (!startedIso) {
    return { ok: false, errorKey: 'invalidStartRequired' };
  }

  if (!isValidHourlyRateInput(form.hourlyRate)) {
    return { ok: false, errorKey: 'invalidRateError' };
  }

  if (form.timingMode === 'duration') {
    const durationVal = parseValidDurationMinutes(form.durationMinutes);
    if (durationVal === null) {
      return { ok: false, errorKey: 'invalidDurationError' };
    }
    return {
      ok: true,
      mode: 'create',
      payload: {
        taskId: chosenTaskId,
        startedAt: startedIso,
        durationMinutes: durationVal,
        billable: form.billable,
        hourlyRate: rateValue,
        note: noteValue,
      },
    };
  }

  const endCheck = validateEndAfterStart(form.endedAt, startedIso);
  if (!endCheck.ok) {
    return endCheck;
  }

  return {
    ok: true,
    mode: 'create',
    payload: {
      taskId: chosenTaskId,
      startedAt: startedIso,
      endedAt: endCheck.endedIso,
      billable: form.billable,
      hourlyRate: rateValue,
      note: noteValue,
    },
  };
}

export interface ProjectTimeFilterState {
  from: string;
  to: string;
  taskId: string;
  userId: string;
  billableOnly: boolean;
}

export const EMPTY_PROJECT_TIME_FILTER: ProjectTimeFilterState = {
  from: '',
  to: '',
  taskId: '',
  userId: '',
  billableOnly: false,
};

export interface TimeFormSession {
  id: number;
  editingEntry: ProjectTimeEntry | null;
}

/** Closes the form only if the active draft session matches the session that submitted. */
export function closeMatchingTimeFormSession(
  current: TimeFormSession | null,
  submittedSessionId: number,
): TimeFormSession | null {
  return current?.id === submittedSessionId ? null : current;
}

export interface TimeEntriesPaginationState {
  filterKey: string;
  epoch: number;
  activeRequestId: number;
  extraEntries: readonly ProjectTimeEntry[];
  loadingMore: boolean;
  loadMoreError: unknown;
}

export function createTimeEntriesPaginationState(filterKey = ''): TimeEntriesPaginationState {
  return {
    filterKey,
    epoch: 0,
    activeRequestId: 0,
    extraEntries: [],
    loadingMore: false,
    loadMoreError: null,
  };
}

export function resetTimeEntriesPagination(
  state: TimeEntriesPaginationState,
  nextFilterKey: string = state.filterKey,
): TimeEntriesPaginationState {
  return {
    filterKey: nextFilterKey,
    epoch: state.epoch + 1,
    activeRequestId: 0,
    extraEntries: [],
    loadingMore: false,
    loadMoreError: null,
  };
}

export function beginTimeEntriesLoadMore(
  state: TimeEntriesPaginationState,
  requestId: number,
): TimeEntriesPaginationState {
  return {
    ...state,
    activeRequestId: requestId,
    loadingMore: true,
    loadMoreError: null,
  };
}

export function resolveTimeEntriesLoadMoreSuccess(
  state: TimeEntriesPaginationState,
  requestEpoch: number,
  requestId: number,
  nextEntries: readonly ProjectTimeEntry[],
): TimeEntriesPaginationState {
  if (requestEpoch !== state.epoch || requestId !== state.activeRequestId) {
    return state;
  }
  const seen = new Set(state.extraEntries.map((e) => e.id));
  const uniqueNext = nextEntries.filter((e) => !seen.has(e.id));
  return {
    ...state,
    extraEntries: [...state.extraEntries, ...uniqueNext],
    loadingMore: false,
    loadMoreError: null,
  };
}

export function resolveTimeEntriesLoadMoreError(
  state: TimeEntriesPaginationState,
  requestEpoch: number,
  requestId: number,
  error: unknown,
): TimeEntriesPaginationState {
  if (requestEpoch !== state.epoch || requestId !== state.activeRequestId) {
    return state;
  }
  return {
    ...state,
    loadingMore: false,
    loadMoreError: error,
  };
}

export function timeSummaryPageSignature(
  summary: Pick<ProjectTimeSummaryResult, 'entries' | 'totalEntries'> | undefined,
): string | null {
  if (!summary) return null;
  const rows = summary.entries.map((entry) => `${entry.id}:${entry.updatedAt}`).join('|');
  return `${summary.totalEntries}:${rows}`;
}

export function mergeTimeSummaryEntries(
  pageOneEntries: readonly ProjectTimeEntry[],
  extraEntries: readonly ProjectTimeEntry[],
): ProjectTimeEntry[] {
  const seen = new Set(pageOneEntries.map((entry) => entry.id));
  const merged = [...pageOneEntries];
  for (const entry of extraEntries) {
    if (!seen.has(entry.id)) {
      seen.add(entry.id);
      merged.push(entry);
    }
  }
  return merged;
}

export interface PendingTimerSwitch {
  projectId: string;
  taskId: string | null;
  taskTitle: string | null;
}

/** Captures the initially requested timer target so later filter/task changes cannot redirect confirmation. */
export function createPendingTimerSwitch(
  projectId: string,
  taskId: string | null,
  taskTitle: string | null,
): PendingTimerSwitch {
  return { projectId, taskId, taskTitle };
}

export function buildStopAndSwitchTimerInput(
  pending: PendingTimerSwitch,
  idempotencyKey: string,
): { projectId: string; taskId: string | null; stopExisting: true; idempotencyKey: string } {
  return {
    projectId: pending.projectId,
    taskId: pending.taskId,
    stopExisting: true,
    idempotencyKey,
  };
}
