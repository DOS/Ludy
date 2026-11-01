// SPDX-License-Identifier: AGPL-3.0-only
// An ad account's sync (ADR-0040 point 4, ads plan docs/plan/ads.md section 5.2), run by the worker as the system. The
// credential is opened here and nowhere else: the API only seals it (ADR-0025). A sync asks the platform for the account's
// own details, plans the window to read (from the day after the last final one to today in the account's time zone),
// reads it a month at a time and records each month with one command (ads.sync.record), which stores the rows, moves the
// cursors and writes the run in one transaction, so a crash leaves the cursors where they were. A day already final is
// never read again, and a day still inside the platform's revision window is rewritten in place. The platform is the
// deployment's adapter for the connection's provider; without one (the sandbox switched off) the sync does nothing.
// kernel.channel.credential refuses once the member who connected the account may no longer use it, or the connection is
// no longer active: the sync then marks the connection expired, so the hourly sweep skips it and an owner or admin connects
// it again, rather than failing every hour. The platform's own answer to a refused token does the same.
import { AdPlatformError, type AdPlatform } from '@crove/ad-platform';
import { settleBefore, syncWindow, todayIn } from '@crove/mod-ads';
import { sql } from 'kysely';
import type { Db } from '@crove/db';
import { DomainError, type CredentialBroker, type Runtime } from '@crove/kernel-runtime';
import { ADS_SYNC_RUN_DAYS } from '@crove/kernel-contract';

const SYSTEM = { type: 'system' as const, component: 'ads' };
// Days one record command covers at most: a month or so of a large account stays well under its row limit.
const SLICE_DAYS = 31;

export interface AdsSyncJob {
  orgId: string;
  connectionId: string;
}

export interface AdsSyncDeps {
  runtime: Runtime;
  broker: CredentialBroker;
  platforms: Readonly<Record<string, AdPlatform>>;
  now?: () => Date;
}

interface SealedChannelCredential {
  provider: string;
  externalAccountId: string;
  keyId: string;
  envelope: string;
}

interface Target {
  adAccountId: string;
  provider: string;
  connectionStatus: string;
  connectionUpdatedAt: string;
  backfillFrom: string;
  settledThrough: string | null;
}

// A page of the active ad accounts of active orgs after a key (crove_ads.ads_due, the worker login's alone), for the
// hourly sweep.
export const ADS_DUE_PAGE = 1000;
export async function adsDue(workerDb: Db, after: { orgId: string; connectionId: string } | null): Promise<Array<{ orgId: string; connectionId: string; provider: string }>> {
  const { rows } = await sql<{ org_id: string; connection_id: string; provider: string }>`
    SELECT org_id, connection_id, provider FROM crove_ads.ads_due(${after?.orgId ?? null}::uuid, ${after?.connectionId ?? null}::uuid, ${ADS_DUE_PAGE}::int)`.execute(workerDb);
  return rows.map((r) => ({ orgId: r.org_id, connectionId: r.connection_id, provider: r.provider }));
}

// Removes the sync runs older than ADS_SYNC_RUN_DAYS, for every org (crove_ads.sync_runs_prune, the worker login's alone).
export async function pruneAdsRuns(workerDb: Db, now: Date): Promise<number> {
  const before = new Date(now.getTime() - ADS_SYNC_RUN_DAYS * 86_400_000);
  const { rows } = await sql<{ n: string }>`SELECT crove_ads.sync_runs_prune(${before}::timestamptz) AS n`.execute(workerDb);
  return Number(rows[0]?.n ?? 0);
}

const addDays = (day: string, days: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

export async function runAdsSync(deps: AdsSyncDeps, job: AdsSyncJob): Promise<{ rows: number; slices: number }> {
  const options = { actor: SYSTEM, orgId: job.orgId };
  const now = deps.now ?? (() => new Date());
  const none = { rows: 0, slices: 0 };
  const target = await deps.runtime.query<Target | null>('ads.sync.target', { connectionId: job.connectionId }, options);
  if (!target || target.connectionStatus !== 'active') return none;
  let sealed: SealedChannelCredential;
  try {
    sealed = await deps.runtime.query<SealedChannelCredential>('kernel.channel.credential', { connectionId: job.connectionId }, options);
  } catch (error) {
    if (error instanceof DomainError && (error.code === 'CHANNEL_OWNER_LEFT' || error.code === 'CHANNEL_NOT_ACTIVE')) {
      if (error.code === 'CHANNEL_OWNER_LEFT') {
        await deps.runtime.execute('kernel.channel.mark_expired', { connectionId: job.connectionId, reason: 'owner_left', ifVersion: target.connectionUpdatedAt }, options);
      }
      return none;
    }
    throw error;
  }
  if (!Object.hasOwn(deps.platforms, sealed.provider)) return none;
  const platform = deps.platforms[sealed.provider] as AdPlatform;
  const secret = deps.broker.open(
    { keyId: sealed.keyId, envelope: Buffer.from(sealed.envelope, 'base64') },
    { orgId: job.orgId, provider: sealed.provider, externalAccountId: sealed.externalAccountId },
  );
  let window: { from: string; to: string } | undefined;
  try {
    const account = (await platform.accounts(secret)).find((a) => a.externalAccountId === sealed.externalAccountId);
    if (!account) throw new AdPlatformError('permission', 'ACCOUNT_NOT_REACHED');
    const details = { currency: account.currency, timeZone: account.timeZone };
    const today = todayIn(account.timeZone, now());
    const planned = syncWindow({ today, backfillFrom: target.backfillFrom, settledThrough: target.settledThrough });
    const settle = settleBefore(today, platform.capabilities.revisionDays);
    let rows = 0;
    let slices = 0;
    for (let from = planned.from; from <= planned.to; from = addDays(from, SLICE_DAYS)) {
      const to = addDays(from, SLICE_DAYS - 1) < planned.to ? addDays(from, SLICE_DAYS - 1) : planned.to;
      window = { from, to };
      const read = await platform.readDaily(secret, sealed.externalAccountId, window);
      await deps.runtime.execute('ads.sync.record', { adAccountId: target.adAccountId, details, window, settleBefore: settle, rows: read }, options);
      rows += read.length;
      slices++;
    }
    return { rows, slices };
  } catch (error) {
    if (error instanceof AdPlatformError) {
      await deps.runtime.execute(
        'ads.sync.record_failure',
        { adAccountId: target.adAccountId, errorKind: error.kind, ...(error.code ? { errorCode: error.code } : {}), ...(error.retryAt ? { retryAt: error.retryAt.toISOString() } : {}), ...(window ? { window } : {}) },
        options,
      );
      // The platform refused the token: the connection is expired until an owner or admin connects it again.
      if (error.kind === 'token_expired') {
        await deps.runtime.execute('kernel.channel.mark_expired', { connectionId: job.connectionId, reason: 'token_expired', ifVersion: target.connectionUpdatedAt }, options);
        return none;
      }
      // A rate limit waits for its own time (the account's next_run_at); a refusal of a permission or a request is not
      // retried by the job. Only a passing failure is left to pg-boss's retry.
      if (error.kind !== 'transient') return none;
    } else if (!(error instanceof DomainError)) {
      await deps.runtime.execute('ads.sync.record_failure', { adAccountId: target.adAccountId, errorKind: 'unknown', errorCode: 'ADAPTER_ERROR', ...(window ? { window } : {}) }, options);
    }
    throw error;
  }
}
