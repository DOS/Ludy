// SPDX-License-Identifier: AGPL-3.0-only
// A bank feed connection's sync (ADR-0039 point 2, #2044 part 2b), run by the worker as the system. The credential is
// opened here and nowhere else: the API only seals it (ADR-0025). A sync lists the accounts the connection reaches
// (finance.bank_feed.record_accounts), then pulls each mapped account from its cursor, a page at a time, each page
// stored and the cursor moved in one command (finance.bank_feed.record_pull). A retry or an overlapping pull stores
// nothing twice: every line carries the bank's reference, which keys it (ADR-0021 section 6). The provider is the
// deployment's adapter for the connection's provider; without one (the adapter switched off) the sync does nothing.
// kernel.channel.credential refuses once the member who connected the account may no longer use it, or the connection
// is no longer active: the sync then marks the connection expired, so the daily sweep skips it and an owner or admin
// connects it again, rather than failing every day.
// When a call or a page is refused, the sync first records why (finance.bank_feed.record_outcome, #4244): a closed kind and, for a page with a line it cannot read, that line's position, never a provider's text
// or a line; then it raises the same error as before, so the job retries as it did. A refusal of the credential, the clock or the saved connection concerns every account of the connection and is recorded on all
// of them; a refused page is recorded on its own account. Recording never replaces the error it reports: a failure of the record is swallowed.
import { TingeeError, type BankFeedProvider } from '@ludy/bank-feed';
import { BANK_FEED_MAX_ACCOUNTS, BANK_FEED_MAX_LINES, type BankFeedPullOutcome } from '@ludy/kernel-contract';
import { sql } from 'kysely';
import type { Db } from '@ludy/db';
import { DomainError, type CredentialBroker, type Runtime } from '@ludy/kernel-runtime';

const SYSTEM = { type: 'system' as const, component: 'finance.bank_feed' };

// What the runtime answers when a page's own lines cannot be stored: the shape check, or the stricter reading of the lines.
const REFUSED_PAGE: ReadonlySet<string> = new Set(['VALIDATION', 'BANK_FEED_INVALID']);

export interface BankFeedFailure {
  kind: Exclude<BankFeedPullOutcome, 'ok'>;
  // The refused line's position in the page, 0-based, only for `bad_page`.
  item?: number;
}

// What a failed call or page is, as a closed kind: the adapter's own typed error carries it; the runtime refusing a page's input is a page with a line that cannot be stored; anything else is an answer that
// was not understood. Only the kind and the position leave this function, never the error's message.
export function classifyBankFeedFailure(error: unknown): BankFeedFailure {
  if (error instanceof TingeeError) return error.kind === 'bad_page' && error.itemIndex !== null ? { kind: 'bad_page', item: error.itemIndex } : { kind: error.kind };
  if (error instanceof DomainError && REFUSED_PAGE.has(error.code)) return { kind: 'bad_page' };
  return { kind: 'upstream' };
}

// The kinds that say something about the whole connection (its credential, the server's clock, the saved connection), wherever they come up.
const CONNECTION_WIDE: ReadonlySet<BankFeedFailure['kind']> = new Set(['credentials', 'clock', 'config']);
// Pages one sync pulls per account at most; the next sync goes on from the cursor.
const MAX_PAGES = 12;

export interface BankFeedSyncJob {
  orgId: string;
  connectionId: string;
}

export interface BankFeedSyncDeps {
  runtime: Runtime;
  broker: CredentialBroker;
  providers: Readonly<Record<string, BankFeedProvider>>;
}

interface SealedChannelCredential {
  provider: string;
  externalAccountId: string;
  keyId: string;
  envelope: string;
}

// A page of the active bank feed connections of active orgs after a key (ludy_finance.bank_feeds_due, the worker
// login's alone), for the daily sweep.
export const BANK_FEEDS_DUE_PAGE = 1000;
export async function bankFeedsDue(workerDb: Db, after: { orgId: string; connectionId: string } | null): Promise<Array<{ orgId: string; connectionId: string; provider: string }>> {
  const { rows } = await sql<{ org_id: string; connection_id: string; provider: string }>`
    SELECT org_id, connection_id, provider FROM ludy_finance.bank_feeds_due(${after?.orgId ?? null}::uuid, ${after?.connectionId ?? null}::uuid, ${BANK_FEEDS_DUE_PAGE}::int)`.execute(workerDb);
  return rows.map((r) => ({ orgId: r.org_id, connectionId: r.connection_id, provider: r.provider }));
}

export async function runBankFeedSync(deps: BankFeedSyncDeps, job: BankFeedSyncJob): Promise<{ accounts: number; pages: number; stored: number }> {
  const options = { actor: SYSTEM, orgId: job.orgId };
  // The connection's version, so marking it expired leaves alone one connected again meanwhile.
  const seen = await deps.runtime.query<{ updatedAt: string } | null>('finance.bank_feed.connection', { connectionId: job.connectionId }, options);
  if (!seen) return { accounts: 0, pages: 0, stored: 0 };
  let sealed: SealedChannelCredential;
  try {
    sealed = await deps.runtime.query<SealedChannelCredential>('kernel.channel.credential', { connectionId: job.connectionId }, options);
  } catch (error) {
    if (error instanceof DomainError && (error.code === 'CHANNEL_OWNER_LEFT' || error.code === 'CHANNEL_NOT_ACTIVE')) {
      if (error.code === 'CHANNEL_OWNER_LEFT') {
        await deps.runtime.execute('kernel.channel.mark_expired', { connectionId: job.connectionId, reason: 'owner_left', ifVersion: seen.updatedAt }, options);
      }
      return { accounts: 0, pages: 0, stored: 0 };
    }
    throw error;
  }
  if (!Object.hasOwn(deps.providers, sealed.provider)) return { accounts: 0, pages: 0, stored: 0 };
  const provider = deps.providers[sealed.provider] as BankFeedProvider;
  // Records why a call stopped; a failure here never replaces the error being reported.
  const report = async (failure: BankFeedFailure, account?: { feedAccountId: string; fromCursor: string | null }): Promise<void> => {
    try {
      await deps.runtime.execute(
        'finance.bank_feed.record_outcome',
        { connectionId: job.connectionId, ...account, kind: failure.kind, ...(failure.item === undefined ? {} : { item: failure.item }) },
        options,
      );
    } catch {
      // The reason is a courtesy to the screen; the job's own error is what matters.
    }
  };
  let secret: string;
  try {
    secret = deps.broker.open(
      { keyId: sealed.keyId, envelope: Buffer.from(sealed.envelope, 'base64') },
      { orgId: job.orgId, provider: sealed.provider, externalAccountId: sealed.externalAccountId },
    );
  } catch (error) {
    // A stored credential this server cannot open (a retired key, a damaged envelope): the connection cannot be read.
    await report({ kind: 'config' });
    throw error;
  }
  let accounts: Awaited<ReturnType<BankFeedProvider['accounts']>>;
  try {
    accounts = (await provider.accounts(secret)).slice(0, BANK_FEED_MAX_ACCOUNTS);
  } catch (error) {
    // Before any pull: whatever it is concerns every mapped account of the connection.
    await report(classifyBankFeedFailure(error));
    throw error;
  }
  await deps.runtime.execute('finance.bank_feed.record_accounts', { connectionId: job.connectionId, accounts }, options);
  const due = await deps.runtime.query<Array<{ feedAccountId: string; externalAccountId: string; cursor: string | null }>>(
    'finance.bank_feed.pull_due',
    { connectionId: job.connectionId },
    options,
  );
  let pages = 0;
  let stored = 0;
  for (const account of due) {
    let cursor = account.cursor;
    for (let page = 0; page < MAX_PAGES; page++) {
      const here = { feedAccountId: account.feedAccountId, fromCursor: cursor };
      // A refused page is its account's; a refused credential, clock or saved connection is the connection's.
      const refuse = async (error: unknown): Promise<never> => {
        const failure = classifyBankFeedFailure(error);
        await report(failure, CONNECTION_WIDE.has(failure.kind) ? undefined : here);
        throw error;
      };
      let pulled: Awaited<ReturnType<BankFeedProvider['pull']>>;
      try {
        pulled = await provider.pull(secret, account.externalAccountId, cursor);
      } catch (error) {
        return refuse(error);
      }
      // The count is checked before the page goes to the command, so this reason does not depend on an error's text.
      if (pulled.transactions.length > BANK_FEED_MAX_LINES) {
        await report({ kind: 'too_many_lines' }, here);
        throw new Error('bank feed: the page carries more lines than one pull may store');
      }
      let result: { counts?: { new: number; ambiguous: number } };
      try {
        result = await deps.runtime.execute<{ counts?: { new: number; ambiguous: number } }>(
          'finance.bank_feed.record_pull',
          { feedAccountId: account.feedAccountId, fromCursor: cursor, lines: pulled.transactions, cursor: pulled.cursor },
          options,
        );
      } catch (error) {
        // Only the runtime refusing the page's own lines is a refused page. A moved cursor (another sync was first), a closed
        // connection or a fault of ours (a lost database connection, a deadlock) says nothing about the bank: rethrown unrecorded.
        if (error instanceof DomainError && REFUSED_PAGE.has(error.code)) return refuse(error);
        throw error;
      }
      pages++;
      stored += (result.counts?.new ?? 0) + (result.counts?.ambiguous ?? 0);
      cursor = pulled.cursor;
      if (!pulled.more) break;
    }
  }
  return { accounts: accounts.length, pages, stored };
}
