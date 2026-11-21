// SPDX-License-Identifier: AGPL-3.0-only
//
// The record that follows a call at a platform or a provider (ADR-0053). The worker ends a job quietly when its app is off (MODULE_OFF at the job's first
// gated call: nothing was done yet). A record refused after the call is the other case: the ads went live, or the invoice was issued, and nothing in Ludy
// says so. That must fail loudly, so the refusal is rethrown as an error the quiet rule does not match; the retries of such a job are loud too (log.ts loudOnRetryQueues), so it ends in the dead letter queue.
import { moduleOffOf } from '@ludy/kernel-runtime';

export class AppOffAfterCallError extends Error {
  readonly module: string;

  constructor(module: string, what: string, cause: unknown) {
    super(`${what}: ${module} went off after the call was made, so its outcome could not be recorded`, { cause });
    this.name = 'AppOffAfterCallError';
    this.module = module;
  }
}

/** Runs a record command that follows a platform call; a MODULE_OFF refusal becomes an AppOffAfterCallError (never quiet, never matched as MODULE_OFF). */
export async function recordAfterCall<T>(what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const module = moduleOffOf(error);
    if (module !== null) throw new AppOffAfterCallError(module, what, error);
    throw error;
  }
}
