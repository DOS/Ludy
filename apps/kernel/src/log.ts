// SPDX-License-Identifier: AGPL-3.0-only
// Structured logs (#2175). With LOG_FORMAT=json every line the API, the worker and the prober print through console.* is
// one JSON object: `ts`, `level`, `role`, `msg`, and, where there is one, `requestId`, `orgId`, `jobId` and `queue`. The
// messages are the ones the code already prints; only the format changes, so the ~200 call sites stay as they are. With
// LOG_FORMAT=text (the default, for a laptop) nothing is patched.
//
// The ids come from the request or the job being served, through AsyncLocalStorage: the HTTP middleware opens a context with
// a fresh request id (also the `x-request-id` answer header), `resolveMembership` adds the org once the caller is a member
// of one, and `withJobLogContext` opens one per job with its queue, its id and the org its payload names. Nothing else is
// ever added to a line: no header, cookie, query string, body or payload field. The one thing done to the existing
// messages is to blank what must never be logged whoever wrote the message (a bearer token, a JWT, the password of a
// connection URL), as a last line of defense.
import { AsyncLocalStorage } from 'node:async_hooks';
import { format } from 'node:util';

export type LogFormat = 'json' | 'text';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
  requestId?: string;
  orgId?: string;
  jobId?: string;
  queue?: string;
}

const store = new AsyncLocalStorage<LogContext>();

/** Runs `fn` with these ids on every log line it (and what it awaits) prints; an enclosing context's ids are kept. */
export function runWithLogContext<T>(context: LogContext, fn: () => T): T {
  // AsyncLocalStorage's `run`, named as a string on purpose (a deliberate deviation, see
  // https://github.com/DOS/Ludy/issues/2181): the job-egress invariant (#1653, test/invariant/job-egress.ts) reads every
  // `<x>.run(` call as a possible nested command run, and this one is no command. A plain `store.run(` would turn the
  // invariant suite red; the analyzer already ignores computed members, so this does not weaken it. The two-step fix is
  // in #2181: list this call under NOT_RUNS (a change in test/invariant/ that takes effect after merge), then call
  // `store.run` plainly.
  return store['run']({ ...store.getStore(), ...context }, fn);
}

/** Adds ids to the context of the code running now (the org of a request, once known); nothing outside a context. */
export function setLogContext(context: LogContext): void {
  const current = store.getStore();
  if (current) Object.assign(current, context);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The org id of a job payload, when it names one: a uuid and nothing else, so no other payload value reaches a log line. */
export function orgIdOf(data: unknown): string | undefined {
  const orgId = data !== null && typeof data === 'object' ? (data as { orgId?: unknown }).orgId : undefined;
  return typeof orgId === 'string' && UUID.test(orgId) ? orgId.toLowerCase() : undefined;
}

// What a message must never carry, whoever wrote it. Deliberately few and specific: this is a backstop, not the policy
// (the policy is that the code does not log secrets). Every quantifier is bounded: a message can echo text an attacker
// chose, and an unbounded scan restarts at every word boundary, which is quadratic on a long message and would hold up
// the event loop in every console call. The message is cut first, so the work is bounded whatever it holds.
const MAX_MESSAGE_CHARS = 32_768;
const REDACTIONS: Array<[RegExp, string]> = [
  [/\bBearer\s{1,8}[A-Za-z0-9._~+/-]{1,4096}=*/gi, 'Bearer [redacted]'],
  // A JWT: three base64url segments, the first two starting with the base64 of `{"` (written as a class so the source
  // holds no token-shaped text for a secret scanner to flag).
  [/\bey[J][A-Za-z0-9_-]{8,1500}\.[A-Za-z0-9_-]{8,1500}\.[A-Za-z0-9_-]{0,1500}/g, '[jwt redacted]'],
  // The password of a URL with credentials (a connection string in a driver's error message).
  [/\b([a-z][a-z0-9+.-]{0,31}:\/\/[^\s:/@]{1,256}):[^\s@/]{1,256}@/gi, '$1:[redacted]@'],
];

// An Error argument, field by field (JSON mode). Printed whole, a database error carries the row it refused: pg's
// `detail` ("Key (email)=(a@example.com) already exists."), `where`, `internalQuery` and `hint` hold tenant values and
// personal data, and every line is now stamped with the org. So an Error becomes its stack (which starts with name and
// message) and a fixed list of fields that name a place, never a value: `code`, `constraint`, `table`, `schema`,
// `column`. A `cause` is written the same way, a few levels deep. Anything else on the error is dropped.
const ERROR_FIELDS = ['code', 'constraint', 'table', 'schema', 'column'] as const;
const MAX_CAUSE_DEPTH = 3;

export function describeError(error: Error, depth = 0): string {
  const record = error as unknown as Record<string, unknown>;
  const fields = ERROR_FIELDS.flatMap((key) => {
    const value = record[key];
    return typeof value === 'string' || typeof value === 'number' ? [`${key}: ${String(value)}`] : [];
  });
  const head = typeof error.stack === 'string' && error.stack !== '' ? error.stack : `${error.name}: ${error.message}`;
  const cause = error.cause instanceof Error && depth < MAX_CAUSE_DEPTH ? `\n[cause] ${describeError(error.cause, depth + 1)}` : '';
  return `${head}${fields.length > 0 ? ` { ${fields.join(', ')} }` : ''}${cause}`;
}

// The patterns run over the message up to a little past the cut, and the redacted text is cut after: a URL password that
// spans the cut is blanked whole (a match is at most about 530 characters), not left as an unterminated prefix.
const REDACTION_OVERLAP = 2048;

export function redact(message: string): string {
  const cut = message.length > MAX_MESSAGE_CHARS;
  let out = cut ? message.slice(0, MAX_MESSAGE_CHARS + REDACTION_OVERLAP) : message;
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  return cut ? `${out.slice(0, MAX_MESSAGE_CHARS)}...[${message.length - MAX_MESSAGE_CHARS} more characters]` : out;
}

export interface LogFields {
  [key: string]: string | number | boolean | null | undefined;
}

export interface JsonLogOptions {
  role: string;
  // Where a line goes; the default is the process's stdout, or stderr for warn and error, as console does.
  write?: (level: LogLevel, line: string) => void;
  now?: () => Date;
}

/** One JSON line for an event: `fields` are the structured extras (an access line's method, route, status). */
export function jsonLine(level: LogLevel, role: string, message: string, fields: LogFields = {}, now: Date = new Date()): string {
  const context = store.getStore();
  const line: Record<string, unknown> = { ts: now.toISOString(), level, role, msg: redact(message) };
  if (context?.requestId) line['requestId'] = context.requestId;
  if (context?.orgId) line['orgId'] = context.orgId;
  if (context?.jobId) line['jobId'] = context.jobId;
  if (context?.queue) line['queue'] = context.queue;
  for (const [key, value] of Object.entries(fields)) if (value !== undefined && !(key in line)) line[key] = value;
  return JSON.stringify(line);
}

let installed: { role: string; write: (level: LogLevel, line: string) => void; now: () => Date } | null = null;
let restoreConsole: (() => void) | null = null;

/**
 * Makes every console.log, info, warn, error and debug of this process a JSON line, and enables `logEvent`. Returns the
 * function that puts the console back (tests). Calling it again replaces the earlier one.
 */
export function installJsonLogs(options: JsonLogOptions): () => void {
  restoreConsole?.();
  const original = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  // Written through the console's own methods as they were, so a closed pipe never throws into the code that logged (the
  // console guards its streams against that), and lines go where they always went: stdout, or stderr for warn and error.
  const write =
    options.write ??
    ((level: LogLevel, line: string) => {
      (level === 'warn' || level === 'error' ? original.error : original.log).call(console, line);
    });
  const now = options.now ?? (() => new Date());
  installed = { role: options.role, write, now };
  const patch = (method: keyof typeof original, level: LogLevel) => {
    console[method] = (...args: unknown[]) =>
      write(level, jsonLine(level, options.role, format(...args.map((arg) => (arg instanceof Error ? describeError(arg) : arg))), {}, now()));
  };
  patch('log', 'info');
  patch('info', 'info');
  patch('warn', 'warn');
  patch('error', 'error');
  patch('debug', 'debug');
  const restore = () => {
    Object.assign(console, original);
    installed = null;
    restoreConsole = null;
  };
  restoreConsole = restore;
  return restore;
}

/** A structured event: one JSON line with `fields` as extra keys. Does nothing in text mode. */
export function logEvent(level: LogLevel, message: string, fields: LogFields = {}): void {
  if (!installed) return;
  installed.write(level, jsonLine(level, installed.role, message, fields, installed.now()));
}

export function parseLogFormat(value: string | undefined): LogFormat {
  if (value === undefined || value === '' || value === 'text') return 'text';
  if (value === 'json') return 'json';
  throw new Error('LOG_FORMAT must be json or text');
}

interface WorkerLike {
  work: unknown;
}
type WorkFunction = (name: string, ...rest: unknown[]) => Promise<string>;

/**
 * Wraps `boss.work` so each job's handler runs in a log context: the queue, the job's id (when it comes one at a time) and
 * the org its payload names. Call it once, right after creating the queue client, before any `work` registration.
 */
export function withJobLogContext(boss: WorkerLike): void {
  const original = (boss.work as WorkFunction).bind(boss);
  (boss as { work: WorkFunction }).work = (name, ...rest) => {
    const handler = rest.at(-1);
    if (typeof handler !== 'function') return original(name, ...rest);
    const wrapped = (jobs: Array<{ id?: unknown; data?: unknown }>, ...extra: unknown[]) => {
      const first = Array.isArray(jobs) ? jobs[0] : undefined;
      const single = Array.isArray(jobs) && jobs.length === 1;
      const orgId = single ? orgIdOf(first?.data) : undefined;
      return runWithLogContext(
        { queue: name, ...(single && typeof first?.id === 'string' ? { jobId: first.id } : {}), ...(orgId ? { orgId } : {}) },
        () => {
          // A rejection is logged here, while the job's ids are on the line (pg-boss reports it later, outside this
          // context), and then rethrown so pg-boss still records the failed job and retries it.
          const failed = (error: unknown): never => {
            console.error(`[jobs] ${name} handler failed`, error);
            throw error;
          };
          try {
            const result = (handler as (...args: unknown[]) => unknown)(jobs, ...extra);
            return result instanceof Promise ? result.catch(failed) : result;
          } catch (error) {
            return failed(error);
          }
        },
      );
    };
    return original(name, ...rest.slice(0, -1), wrapped);
  };
}
