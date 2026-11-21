// SPDX-License-Identifier: AGPL-3.0-only
// The pull of a marketplace connection's orders, the worker's half (#2519, ADR-0045 point 7, plan stock-and-marketplaces.md section 8.7), run as the system for one connection. The credential
// is opened here and nowhere else (the API only seals it, ADR-0025). The provider is asked for the orders since the connection's cursor; what it lists is written as a CSV in the layout of the
// platform's own order report and ingested with kernel.file.ingest (source `upload`, the connection's entity, content type text/csv), the SAME intake as a file a member drops in the Inbox.
// The normal extraction event then fires and readMarketplaceFile stages the file, so the parsing sandbox, the checks, the Inbox card and the 90-day retention apply unchanged.
//
// The poll NEVER confirms: a member confirms in the Inbox, and a profile that is not confirmed against a real seller's file writes no order and no stock by itself. It never calls a write
// endpoint of a platform: the port has none. The same page of orders gives the same bytes, so the intake's content hash recognises a repeat and stages nothing twice; the cursor moves only
// after the ingest succeeded. A failure records a state (unreachable, credentials, rate_limited, too_large), never the provider's own text. Nothing here logs or stores a credential or a
// provider's message: ids, counts and states.
import { EXTRACT_LIMITS } from '@crove/extract-contract';
import {
  MARKETPLACE_PLATFORM_LIMITS,
  MarketplaceProviderError,
  SANDBOX_MARKETPLACE_SECRET,
  marketplaceCsvRows,
  marketplaceOrdersCsv,
  ordersSpan,
  parseMarketplaceOrderPage,
  splitWritableOrders,
  type MarketplaceOrder,
  type MarketplacePollEnding,
  type MarketplacePollTarget,
  type MarketplaceProvider,
  type MarketplaceTestResult,
} from '@crove/mod-finance';
import { z } from 'zod';
import { zId } from '@crove/kernel-contract';
import { DomainError, fileKey, putFile, sha256Hex, type BlobStore, type CredentialBroker, type Runtime } from '@crove/kernel-runtime';

const SYSTEM = { type: 'system' as const, component: 'finance.marketplace' };

export interface MarketplacePollJob {
  orgId: string;
  // The marketplace connection's id (the finance module's row), not the channel connection's.
  connectionId: string;
  // What the job does: a poll (also when left out) or a connection test (#4238). Closed: see zMarketplaceJob.
  kind?: 'poll' | 'test' | undefined;
}

export interface MarketplacePollDeps {
  runtime: Runtime;
  broker: CredentialBroker;
  store: BlobStore;
  providers: Readonly<Record<string, MarketplaceProvider>>;
}

export type MarketplacePollOutcome =
  // The connection is left alone (gone, no longer active, its adapter off on this deployment): nothing was asked and nothing is recorded.
  | { state: 'skipped'; reason: string }
  | { state: MarketplacePollEnding; orders: number; staged: boolean };

interface SealedChannelCredential {
  provider: string;
  externalAccountId: string;
  keyId: string;
  envelope: string;
}

// The connection's id is in the name, so the Inbox files of one connection can be told from every other (the finance module counts what waits for a connection by it).
const csvFilename = (platform: string, connectionId: string, orders: readonly MarketplaceOrder[]): string => {
  const span = ordersSpan(orders);
  return `don-hang-${platform}-${connectionId}${span ? `-${span.from}-${span.to}` : ''}.csv`;
};

// The most pages one run reads: a shop with more waiting is caught up over the next runs (the sweep queues one every fifteen minutes), so no run holds the worker for long. Each page is ingested and
// its cursor recorded before the next is asked, so a run that stops anywhere loses nothing.
export const MARKETPLACE_MAX_PAGES_PER_RUN = 5;

// The job's payload (ids only), closed: a `kind` the worker does not know is refused, never guessed. A job queued before `kind` existed has none and is a poll.
export const MARKETPLACE_JOB_KINDS = ['poll', 'test'] as const;
export const zMarketplaceJob = z.strictObject({ orgId: zId, connectionId: zId, kind: z.enum(MARKETPLACE_JOB_KINDS).optional() });
export const marketplaceJobKind = (job: { kind?: (typeof MARKETPLACE_JOB_KINDS)[number] | undefined }): (typeof MARKETPLACE_JOB_KINDS)[number] => job.kind ?? 'poll';

// The credential: the offline provider has none; a real one is opened here from the sealed copy, and refused once the member who connected it may no longer use it or the connection is no longer
// active (a `null` then, after the connection was marked expired when its owner left).
async function openSecret(deps: MarketplacePollDeps, provider: MarketplaceProvider, orgId: string, channelConnectionId: string, options: { actor: typeof SYSTEM; orgId: string }): Promise<string | null> {
  if (provider.hosts.length === 0) return SANDBOX_MARKETPLACE_SECRET;
  try {
    const sealed = await deps.runtime.query<SealedChannelCredential>('kernel.channel.credential', { connectionId: channelConnectionId }, options);
    return String(deps.broker.open({ keyId: sealed.keyId, envelope: Buffer.from(sealed.envelope, 'base64') }, { orgId, provider: sealed.provider, externalAccountId: sealed.externalAccountId }));
  } catch (error) {
    if (error instanceof DomainError && (error.code === 'CHANNEL_OWNER_LEFT' || error.code === 'CHANNEL_NOT_ACTIVE')) {
      if (error.code === 'CHANNEL_OWNER_LEFT') await deps.runtime.execute('kernel.channel.mark_expired', { connectionId: channelConnectionId, reason: 'owner_left' }, options);
      return null;
    }
    throw error;
  }
}

export type MarketplaceTestOutcome = { state: 'skipped'; reason: string } | { state: MarketplaceTestResult };

// The connection test, the worker's half (#4238): open the credential, ask the provider's one cheap read, record the state. It never moves the cursor and never ingests: the only thing it writes is the
// test state (finance.marketplace_connection.record_test). What was refused or unreachable is a state, never the provider's text.
export async function runMarketplaceTest(deps: MarketplacePollDeps, job: MarketplacePollJob): Promise<MarketplaceTestOutcome> {
  const options = { actor: SYSTEM, orgId: job.orgId };
  const target = await deps.runtime.query<MarketplacePollTarget>('finance.marketplace_connection.poll_target', { id: job.connectionId }, options);
  if (target.action === 'none') return { state: 'skipped', reason: target.reason };
  if (!Object.hasOwn(deps.providers, target.adapter)) return { state: 'skipped', reason: 'provider_off' };
  const provider = deps.providers[target.adapter] as MarketplaceProvider;
  const secret = await openSecret(deps, provider, job.orgId, target.channelConnectionId, options);
  let state: MarketplaceTestResult;
  if (secret === null) {
    state = 'wrong_credentials';
  } else {
    try {
      state = await provider.testConnection(secret);
    } catch {
      // The port's test answers a state and does not throw; anything that does is not kept (its text may carry a URL or a header).
      state = 'unreachable';
    }
  }
  await deps.runtime.execute('finance.marketplace_connection.record_test', { id: job.connectionId, state }, options);
  return { state };
}

// A connection whose last poll failed is not asked again at once (Lazada may disable an app for many failing calls, and a refused login does not mend itself): the sweep's poll is skipped until this
// long after the failed one. A refused login waits longest (it needs the seller to act); the rest wait an hour. A good poll clears it, and so does any change of the state.
export const MARKETPLACE_BACKOFF_MS: Readonly<Record<string, number>> = { credentials: 6 * 3_600_000, unreachable: 3_600_000, rate_limited: 3_600_000, too_large: 3_600_000, not_recognized: 3_600_000 };

export async function runMarketplacePoll(deps: MarketplacePollDeps, job: MarketplacePollJob, maxPages: number = MARKETPLACE_MAX_PAGES_PER_RUN, now: () => Date = () => new Date()): Promise<MarketplacePollOutcome> {
  const options = { actor: SYSTEM, orgId: job.orgId };
  const target = await deps.runtime.query<MarketplacePollTarget>('finance.marketplace_connection.poll_target', { id: job.connectionId }, options);
  if (target.action === 'none') return { state: 'skipped', reason: target.reason };
  // The adapter switched off on this deployment: nothing is sent and the connection's record is left as it was.
  if (!Object.hasOwn(deps.providers, target.adapter)) return { state: 'skipped', reason: 'provider_off' };
  const provider = deps.providers[target.adapter] as MarketplaceProvider;
  // Backing off after a failed poll: only a provider that reaches a host (the offline one cannot fail this way).
  const wait = target.lastPollState === null ? undefined : MARKETPLACE_BACKOFF_MS[target.lastPollState];
  if (provider.hosts.length > 0 && wait !== undefined && target.lastPolledAt !== null && now().getTime() - Date.parse(target.lastPolledAt) < wait) return { state: 'skipped', reason: 'backoff' };
  // What the row holds now (the cursor and the last state): a poll that changes nothing it holds writes nothing (the 15-minute sweep would otherwise add an audit row for every connection every time),
  // and after a page the next one starts from the cursor the page recorded.
  const held = { cursor: target.cursor, state: target.lastPollState };
  const record = async (fields: { state: MarketplacePollEnding; cursor?: string }) => {
    // A failure of a provider that reaches a host is always written (its time starts the back-off, one row an hour at most); anything else that changes nothing the row holds is not.
    const unchanged = fields.state === held.state && (fields.cursor === undefined || fields.cursor === held.cursor);
    if (unchanged && !(provider.hosts.length > 0 && fields.state !== 'ok')) return;
    await deps.runtime.execute('finance.marketplace_connection.record_poll', { id: job.connectionId, ...fields }, options);
    held.state = fields.state;
    if (fields.cursor !== undefined) held.cursor = fields.cursor;
  };

  const secret = await openSecret(deps, provider, job.orgId, target.channelConnectionId, options);
  if (secret === null) {
    await record({ state: 'credentials' });
    return { state: 'credentials', orders: 0, staged: false };
  }

  // At most `maxPages` pages: a page the provider says has more behind it (and that was ingested and recorded) is followed by the next; anything else ends the run with that page's outcome.
  let orders = 0;
  let staged = false;
  let last: MarketplacePageResult = { outcome: { state: 'ok', orders: 0, staged: false }, more: false };
  for (let pages = 0; pages < Math.max(1, maxPages); pages++) {
    last = await pollPage({ deps, job, target, provider, secret, record, held, options });
    orders += last.outcome.orders;
    staged = staged || last.outcome.staged;
    if (!last.more) break;
  }
  return { state: last.outcome.state, orders, staged };
}

interface MarketplacePageResult {
  outcome: { state: MarketplacePollEnding; orders: number; staged: boolean };
  // The page was ingested and recorded and the provider says more waits behind it.
  more: boolean;
}

interface PageContext {
  deps: MarketplacePollDeps;
  job: MarketplacePollJob;
  target: Extract<MarketplacePollTarget, { action: 'poll' }>;
  provider: MarketplaceProvider;
  secret: string;
  record: (fields: { state: MarketplacePollEnding; cursor?: string }) => Promise<void>;
  held: { cursor: string | null; state: string | null };
  options: { actor: typeof SYSTEM; orgId: string };
}

async function pollPage(ctx: PageContext): Promise<MarketplacePageResult> {
  const { deps, job, target, provider, secret, record, held, options } = ctx;
  const stop = (state: MarketplacePollEnding, orders = 0): MarketplacePageResult => ({ outcome: { state, orders, staged: false }, more: false });
  let given;
  try {
    given = await provider.listOrders(secret, target.platform, held.cursor);
  } catch (error) {
    // The cursor stays where it was: the next poll asks for the same orders again.
    // Anything that is not the port's own error is made one of its kind here: its message (which a client library may fill with a URL or a header) is neither kept nor logged, and pg-boss
    // never stores it in the job's output.
    const state: MarketplacePollEnding = error instanceof MarketplaceProviderError ? error.kind : 'unreachable';
    await record({ state });
    console.warn(`[marketplace] ${job.connectionId.slice(0, 8)}: ${state}`);
    return stop(state);
  }

  // The page is checked before anything of it is used (#2840 point 2): decimal strings, real days, known stages, bounded lengths and no field the port does not name. A page that fails is the
  // state `not_recognized`, the cursor stays and nothing is written; its content is never kept or logged, so a provider's text cannot reach pg-boss's error or the log.
  const page = parseMarketplaceOrderPage(given);
  if (page === null) {
    await record({ state: 'not_recognized' });
    console.warn(`[marketplace] ${job.connectionId.slice(0, 8)}: not_recognized`);
    return stop('not_recognized');
  }
  // A page past what the intake accepts is recorded as such and never ingested; the cursor stays, so an owner sees it rather than a silent gap. The limit is on ORDERS, counted by order number: a
  // platform that keeps the state of each item (Lazada) answers an order whose items are in different states as one port order for each state.
  const limit = MARKETPLACE_PLATFORM_LIMITS[target.platform];
  if (new Set(page.orders.map((order) => order.orderNo)).size > limit.pageSize) {
    await record({ state: 'too_large' });
    return stop('too_large', page.orders.length);
  }
  // Nothing new: the poll is recorded with the cursor the provider gave back (and not at all when that changes nothing).
  if (page.orders.length === 0) {
    await record({ state: 'ok', ...(page.nextCursor && page.nextCursor !== held.cursor ? { cursor: page.nextCursor } : {}) });
    return stop('ok');
  }

  // An order the platform's layout cannot carry (a fractional quantity on a platform that writes a row for each unit) is left out and named as a state, never half written.
  const { writable, refused } = splitWritableOrders(target.platform, page.orders);
  const cursor = page.nextCursor && page.nextCursor !== held.cursor ? { cursor: page.nextCursor } : {};
  if (writable.length === 0) {
    await record({ state: 'not_recognized', ...cursor });
    return stop('not_recognized');
  }
  // The rows are counted BEFORE any is built (#2840 point 1): a few lines with huge quantities on a platform that writes a row for each unit are refused here, never materialised.
  if (marketplaceCsvRows(target.platform, writable) > EXTRACT_LIMITS.maxOrderLines) {
    await record({ state: 'too_large' });
    return stop('too_large', page.orders.length);
  }
  let csv: string;
  try {
    csv = marketplaceOrdersCsv(target.platform, writable, job.connectionId);
  } catch {
    // The writer refused a page it cannot carry; its message is not kept, and the cursor stays.
    await record({ state: 'not_recognized' });
    return stop('not_recognized');
  }
  const bytes = new TextEncoder().encode(csv);
  // The rows were counted exactly above (the connection row and the head row are not order lines), so only the size is checked here.
  if (bytes.byteLength > EXTRACT_LIMITS.maxOrderReportBytes) {
    await record({ state: 'too_large' });
    return stop('too_large', page.orders.length);
  }
  const sha256 = sha256Hex(bytes);
  const storageKey = fileKey(job.orgId, sha256);
  const generation = await putFile(deps.store, storageKey, bytes, 'text/csv', sha256);
  // The same intake as an upload (source `upload`: the file-source CHECK has no source of its own for a platform's pull, and a new one would need a migration of the hot file table). The
  // content hash dedupes a page read twice, and the extraction job that the event queues stages it for a member. A throw here leaves the cursor where it was, so the retry reads the page again.
  const filed = await deps.runtime.execute<{ fileId: string; duplicate: boolean }>(
    'kernel.file.ingest',
    { filename: csvFilename(target.platform, job.connectionId, writable), contentType: 'text/csv', sizeBytes: bytes.byteLength, sha256, storageKey, generation, source: 'upload', legalEntityId: target.legalEntityId },
    options,
  );
  // Only now does the cursor move. A page that was already ingested hands nothing new to the Inbox.
  const state: MarketplacePollEnding = refused > 0 ? 'not_recognized' : 'ok';
  await record({ state, ...cursor });
  // The next page is read only when this one was whole (`ok`), moved the cursor and the provider says more waits: a page read twice (the same bytes) or a cursor that did not move would loop on the
  // same window, so the run ends there.
  const more = state === 'ok' && page.more === true && cursor.cursor !== undefined && !filed.duplicate;
  return { outcome: { state, orders: filed.duplicate ? 0 : writable.length, staged: !filed.duplicate }, more };
}
