// Errors the SPA reads from the kernel. The RPC path throws oRPC errors that carry `code` and `status`; the plain
// fetch paths (upload, download, export) throw ApiError with the same fields, so the same checks recognise both
// (issue #180): MFA_REQUIRED opens the MFA challenge instead of a sign-out, a dead session signs the user out.
//
// No error holds translated text (issue #215): an error keeps the kernel's code, details and message, or a message
// key, and describeError() words it in the active locale when it is rendered, so a language switch rewords errors
// already on screen.
import type { Locale } from '../i18n/locale.ts';
import type { Translate } from '../i18n/runtime.ts';
import { KERNEL_LOCALE, kernelErrorMessage } from './kernel-errors.ts';

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  // The kernel's own message (written in Vietnamese), or null when the answer had none.
  readonly serverMessage: string | null;
  // The refusals of the supplier bank file name the payment they are about (never a holder, a number or an amount), and the time of an earlier file.
  readonly paymentId: string | null;
  readonly exportedAt: string | null;

  constructor(code: string, status: number, serverMessage: string | null, paymentId: string | null = null, exportedAt: string | null = null) {
    super(serverMessage ?? `HTTP ${status}`);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.serverMessage = serverMessage;
    this.paymentId = paymentId;
    this.exportedAt = exportedAt;
  }
}

// An error the SPA raises itself (a file over the size limit, a storage upload that failed). It keeps how to word
// the message, not the words.
export class ClientError extends Error {
  readonly describe: (t: Translate) => string;

  constructor(key: string, describe: (t: Translate) => string) {
    super(key);
    this.name = 'ClientError';
    this.describe = describe;
  }
}

// The kernel answers non-RPC errors as JSON `{ code, message }`. A body that is not JSON, or lacks a field, still
// gives an ApiError with the HTTP status, so the checks below never depend on the body.
export async function apiErrorFromResponse(response: Response): Promise<ApiError> {
  const body = (await response.json().catch(() => null)) as { code?: unknown; message?: unknown; paymentId?: unknown; exportedAt?: unknown } | null;
  const code = typeof body?.code === 'string' && body.code ? body.code : `HTTP_${response.status}`;
  const message = typeof body?.message === 'string' && body.message ? body.message : null;
  return new ApiError(code, response.status, message, typeof body?.paymentId === 'string' ? body.paymentId : null, typeof body?.exportedAt === 'string' ? body.exportedAt : null);
}

function serverMessageOf(error: unknown): string | null {
  if (error instanceof ApiError) return error.serverMessage;
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' && message ? message : null;
}

// Any error in words for the user, in `locale`:
// - an error of the SPA's own: its message;
// - a kernel error with a code the SPA knows (kernel-errors.ts): the kernel's message when the locale is the kernel's
//   language (Vietnamese; it is the most specific, for example which role a FORBIDDEN was about), otherwise the
//   SPA's message for the code and its details;
// - any other error: the kernel's (Vietnamese) message, `Error <status>` for an answer without one, or a generic
//   message.
export function describeError(error: unknown, t: Translate, locale: Locale): string {
  if (error instanceof ClientError) return error.describe(t);
  const e = (error ?? {}) as { code?: unknown; data?: unknown };
  const server = serverMessageOf(error);
  const code = typeof e.code === 'string' ? e.code : null;
  if (code) {
    const known = kernelErrorMessage(code, e.data, t, { server: locale === KERNEL_LOCALE ? server : null });
    if (known) return known;
  }
  if (server) return server;
  const http = code ? /^HTTP_(\d{3})$/.exec(code) : null;
  if (http?.[1]) return t('common.httpError', { status: http[1] });
  return t('common.error');
}

// The session is valid but has not passed the user's second factor yet (issue #126): the kernel refuses every
// call until it has. Not a sign-out: the SPA opens the MFA challenge (/mfa, issue #32).
export function isMfaRequired(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'MFA_REQUIRED';
}

// The server answered and refused (a 4xx with its code, from the RPC path or a fetch path): nothing it was asked to do was done. A lost response, a timeout or a 5xx says nothing about whether it was done.
export function isServerRefusal(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' && status >= 400 && status < 500;
}

// The org's owner revoked this session for that org only (issue #247): leave the org, keep the session.
export function isOrgAccessRevoked(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'SESSION_REVOKED_IN_ORG';
}

// R3 work (approve, membership changes) needs a second factor verified in the last 5 minutes (policy P11).
export function isStepUpRequired(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'STEP_UP_REQUIRED';
}

// Per-org disabled module refusal (ADR-0053): MODULE_OFF 404 carrying optional `data.module`.
export function isModuleOff(error: unknown, module?: string): boolean {
  const e = error as { code?: string; data?: { module?: unknown } } | null;
  if (e?.code !== 'MODULE_OFF') return false;
  return module === undefined || e.data?.module === module;
}

export function isUnauthenticated(error: unknown): boolean {
  const e = error as { status?: number; code?: string } | null;
  if (isMfaRequired(error) || isOrgAccessRevoked(error)) return false;
  return e?.status === 401 || e?.code === 'UNAUTHORIZED' || e?.code === 'UNAUTHENTICATED';
}

// The kernel completes a few staged uploads at a time and answers 503 UPLOAD_BUSY past that (issue #223), leaving the
// upload's grant unused for its 5 minutes. Retries fn after each delay while it is refused that way; any other error,
// or the last refusal, is thrown.
export const UPLOAD_BUSY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];

export async function retryWhileBusy<T>(
  fn: () => Promise<T>,
  delaysMs: readonly number[] = UPLOAD_BUSY_DELAYS_MS,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const delay = delaysMs[attempt];
      if ((error as { code?: string } | null)?.code !== 'UPLOAD_BUSY' || delay === undefined) throw error;
      await sleep(delay);
    }
  }
}
